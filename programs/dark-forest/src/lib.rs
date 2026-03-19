use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

declare_id!("DFpay111111111111111111111111111111111111111");

const CHANNEL_SEED: &[u8] = b"channel";
const VOUCHER_SEED: &[u8] = b"voucher";
const PERMISSION_PROGRAM_ID: Pubkey = pubkey!("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

#[ephemeral]
#[program]
pub mod dark_forest {
    use super::*;

    // ── Channel Lifecycle ─────────────────────────────────────────

    pub fn create_channel(
        ctx: Context<CreateChannel>,
        channel_id: u64,
        agent: Pubkey,
        deposit_lamports: u64,
        expires_in_seconds: i64,
    ) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        let clock = Clock::get()?;

        channel.channel_id = channel_id;
        channel.poster = ctx.accounts.poster.key();
        channel.agent = agent;
        channel.deposited = deposit_lamports;
        channel.claimed = 0;
        channel.voucher_count = 0;
        channel.last_voucher_amount = 0;
        channel.status = ChannelStatus::Open;
        channel.created_at = clock.unix_timestamp;
        channel.expires_at = clock.unix_timestamp + expires_in_seconds;

        // Transfer SOL from poster to channel PDA
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.poster.key(),
            &channel.key(),
            deposit_lamports,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.poster.to_account_info(),
                channel.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        msg!(
            "Channel {} created: {} -> {}, deposit: {} lamports",
            channel_id,
            channel.poster,
            agent,
            deposit_lamports
        );

        Ok(())
    }

    pub fn fund_channel(ctx: Context<FundChannel>, amount: u64) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        require!(
            channel.status == ChannelStatus::Open,
            DarkForestError::ChannelNotOpen
        );
        require!(
            channel.poster == ctx.accounts.poster.key(),
            DarkForestError::Unauthorized
        );

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.poster.key(),
            &channel.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.poster.to_account_info(),
                channel.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        channel.deposited = channel
            .deposited
            .checked_add(amount)
            .ok_or(DarkForestError::Overflow)?;

        msg!(
            "Channel {} funded: +{} lamports (total: {})",
            channel.channel_id,
            amount,
            channel.deposited
        );
        Ok(())
    }

    // ── Voucher-Based Payments (inside PER) ───────────────────────

    pub fn send_voucher(
        ctx: Context<SendVoucher>,
        _channel_id: u64,
        cumulative_amount: u64,
    ) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        let voucher = &mut ctx.accounts.voucher;

        require!(
            channel.status == ChannelStatus::Open,
            DarkForestError::ChannelNotOpen
        );
        require!(
            channel.poster == ctx.accounts.poster.key(),
            DarkForestError::Unauthorized
        );
        require!(
            cumulative_amount > channel.last_voucher_amount,
            DarkForestError::VoucherNotMonotonic
        );
        require!(
            cumulative_amount <= channel.deposited,
            DarkForestError::InsufficientDeposit
        );

        channel.voucher_count += 1;
        channel.last_voucher_amount = cumulative_amount;

        voucher.channel_id = channel.channel_id;
        voucher.sequence = channel.voucher_count;
        voucher.cumulative_amount = cumulative_amount;
        voucher.poster = channel.poster;
        voucher.agent = channel.agent;
        voucher.timestamp = Clock::get()?.unix_timestamp;

        msg!(
            "Voucher #{} for channel {}: cumulative {} lamports",
            voucher.sequence,
            channel.channel_id,
            cumulative_amount
        );

        Ok(())
    }

    pub fn claim(ctx: Context<Claim>, _channel_id: u64) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        require!(
            channel.agent == ctx.accounts.agent.key(),
            DarkForestError::Unauthorized
        );
        require!(
            channel.last_voucher_amount > channel.claimed,
            DarkForestError::NothingToClaim
        );

        let claimable = channel.last_voucher_amount - channel.claimed;
        channel.claimed = channel.last_voucher_amount;

        **channel.to_account_info().try_borrow_mut_lamports()? -= claimable;
        **ctx
            .accounts
            .agent
            .to_account_info()
            .try_borrow_mut_lamports()? += claimable;

        msg!(
            "Agent {} claimed {} lamports from channel {} (total claimed: {})",
            ctx.accounts.agent.key(),
            claimable,
            channel.channel_id,
            channel.claimed
        );

        Ok(())
    }

    pub fn close_channel(ctx: Context<CloseChannel>, _channel_id: u64) -> Result<()> {
        let channel = &mut ctx.accounts.channel;
        require!(
            channel.poster == ctx.accounts.poster.key(),
            DarkForestError::Unauthorized
        );
        require!(
            channel.status == ChannelStatus::Open,
            DarkForestError::ChannelNotOpen
        );

        // Agent gets any unclaimed voucher amount
        let unclaimed = channel.last_voucher_amount - channel.claimed;
        if unclaimed > 0 {
            **channel.to_account_info().try_borrow_mut_lamports()? -= unclaimed;
            **ctx
                .accounts
                .agent
                .to_account_info()
                .try_borrow_mut_lamports()? += unclaimed;
            channel.claimed = channel.last_voucher_amount;
        }

        // Remaining balance returns to poster
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(8 + PaymentChannel::LEN);
        let channel_lamports = channel.to_account_info().lamports();
        let refundable = channel_lamports.saturating_sub(min_balance);

        if refundable > 0 {
            **channel.to_account_info().try_borrow_mut_lamports()? -= refundable;
            **ctx
                .accounts
                .poster
                .to_account_info()
                .try_borrow_mut_lamports()? += refundable;
        }

        channel.status = ChannelStatus::Closed;
        msg!(
            "Channel {} closed. Agent received: {}, poster refunded: {}",
            channel.channel_id,
            unclaimed,
            refundable
        );

        Ok(())
    }

    // ── PER Delegation ────────────────────────────────────────────

    pub fn delegate_channel(
        ctx: Context<DelegateChannel>,
        _account_type: DelegateAccountType,
    ) -> Result<()> {
        let validator = ctx.accounts.validator.as_ref().map(|v| v.key());

        let seed_data = derive_delegate_seeds(&_account_type);
        let seeds_refs: Vec<&[u8]> = seed_data.iter().map(|s| s.as_slice()).collect();

        ctx.accounts.delegate_pda(
            &ctx.accounts.payer,
            &seeds_refs,
            DelegateConfig {
                validator,
                ..Default::default()
            },
        )?;

        msg!("Account delegated to PER TEE validator");
        Ok(())
    }

    // ── Settlement (commit from PER to mainnet) ───────────────────

    pub fn settle_and_undelegate(ctx: Context<SettleChannel>) -> Result<()> {
        let channel = &ctx.accounts.channel;

        channel.exit(&crate::ID)?;

        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.channel.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!("Channel {} settled to mainnet", channel.channel_id);
        Ok(())
    }

    pub fn commit_channel(ctx: Context<SettleChannel>) -> Result<()> {
        commit_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.channel.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        msg!(
            "Channel {} state committed to mainnet",
            ctx.accounts.channel.channel_id
        );
        Ok(())
    }
}

// ── Account Structures ────────────────────────────────────────────

#[account]
pub struct PaymentChannel {
    pub channel_id: u64,
    pub poster: Pubkey,
    pub agent: Pubkey,
    pub deposited: u64,
    pub claimed: u64,
    pub voucher_count: u64,
    pub last_voucher_amount: u64,
    pub status: ChannelStatus,
    pub created_at: i64,
    pub expires_at: i64,
}

impl PaymentChannel {
    pub const LEN: usize = 8      // channel_id
        + 32                       // poster
        + 32                       // agent
        + 8                        // deposited
        + 8                        // claimed
        + 8                        // voucher_count
        + 8                        // last_voucher_amount
        + 1                        // status
        + 8                        // created_at
        + 8; // expires_at
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum ChannelStatus {
    Open,
    Settling,
    Closed,
}

impl Default for ChannelStatus {
    fn default() -> Self {
        ChannelStatus::Open
    }
}

#[account]
pub struct Voucher {
    pub channel_id: u64,
    pub sequence: u64,
    pub cumulative_amount: u64,
    pub poster: Pubkey,
    pub agent: Pubkey,
    pub timestamp: i64,
}

impl Voucher {
    pub const LEN: usize = 8 + 8 + 8 + 32 + 32 + 8;
}

// ── Instruction Contexts ──────────────────────────────────────────

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct CreateChannel<'info> {
    #[account(
        init,
        payer = poster,
        space = 8 + PaymentChannel::LEN,
        seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundChannel<'info> {
    #[account(mut, has_one = poster)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct SendVoucher<'info> {
    #[account(
        mut,
        seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub channel: Account<'info, PaymentChannel>,
    #[account(
        init_if_needed,
        payer = poster,
        space = 8 + Voucher::LEN,
        seeds = [VOUCHER_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub voucher: Account<'info, Voucher>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct Claim<'info> {
    #[account(
        mut,
        seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct CloseChannel<'info> {
    #[account(
        mut,
        seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()],
        bump,
        has_one = poster,
    )]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub poster: Signer<'info>,
    /// CHECK: Agent wallet to receive unclaimed funds
    #[account(mut, constraint = agent.key() == channel.agent)]
    pub agent: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateChannel<'info> {
    /// CHECK: The PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: ER validator
    pub validator: Option<AccountInfo<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct SettleChannel<'info> {
    #[account(mut, seeds = [CHANNEL_SEED, &channel.channel_id.to_le_bytes()], bump)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

// ── Helpers ───────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum DelegateAccountType {
    Channel { channel_id: u64 },
    Voucher { channel_id: u64 },
}

fn derive_delegate_seeds(account_type: &DelegateAccountType) -> Vec<Vec<u8>> {
    match account_type {
        DelegateAccountType::Channel { channel_id } => {
            vec![CHANNEL_SEED.to_vec(), channel_id.to_le_bytes().to_vec()]
        }
        DelegateAccountType::Voucher { channel_id } => {
            vec![VOUCHER_SEED.to_vec(), channel_id.to_le_bytes().to_vec()]
        }
    }
}

// ── Errors ────────────────────────────────────────────────────────

#[error_code]
pub enum DarkForestError {
    #[msg("Channel is not open")]
    ChannelNotOpen,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Voucher cumulative amount must be monotonically increasing")]
    VoucherNotMonotonic,
    #[msg("Cumulative voucher amount exceeds deposit")]
    InsufficientDeposit,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Channel has expired")]
    Expired,
}
