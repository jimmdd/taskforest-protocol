use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::{commit, delegate};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{commit_accounts, commit_and_undelegate_accounts};

use crate::constants::*;
use crate::errors::TaskForestError;
use crate::state::job::Job;
use crate::state::payment::*;

pub fn handler_create_payment_channel(
    ctx: Context<CreatePaymentChannel>,
    channel_id: u64,
    deposit_lamports: u64,
    expires_in_seconds: i64,
) -> Result<()> {
    let job = &ctx.accounts.job;
    let channel = &mut ctx.accounts.channel;
    let clock = Clock::get()?;

    channel.channel_id = channel_id;
    channel.job_pubkey = job.key();
    channel.poster = ctx.accounts.poster.key();
    channel.agent = job.claimer;
    channel.deposited = deposit_lamports;
    channel.claimed = 0;
    channel.voucher_count = 0;
    channel.last_voucher_amount = 0;
    channel.status = ChannelStatus::Open;
    channel.created_at = clock.unix_timestamp;
    channel.expires_at = clock.unix_timestamp + expires_in_seconds;

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
        "Payment channel {} created for job {}",
        channel_id,
        job.key()
    );
    Ok(())
}

pub fn handler_fund_payment_channel(ctx: Context<FundPaymentChannel>, amount: u64) -> Result<()> {
    let channel = &mut ctx.accounts.channel;
    require!(
        channel.status == ChannelStatus::Open,
        TaskForestError::ChannelNotOpen
    );
    require!(
        channel.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
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
        .ok_or(TaskForestError::ChannelOverflow)?;
    msg!(
        "Channel {} funded: +{} lamports",
        channel.channel_id,
        amount
    );
    Ok(())
}

pub fn handler_send_voucher(
    ctx: Context<SendVoucher>,
    _channel_id: u64,
    cumulative_amount: u64,
) -> Result<()> {
    let channel = &mut ctx.accounts.channel;
    let voucher = &mut ctx.accounts.voucher;

    require!(
        channel.status == ChannelStatus::Open,
        TaskForestError::ChannelNotOpen
    );
    require!(
        channel.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
    );
    require!(
        cumulative_amount > channel.last_voucher_amount,
        TaskForestError::VoucherNotMonotonic
    );
    require!(
        cumulative_amount <= channel.deposited,
        TaskForestError::InsufficientChannelDeposit
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
        "Voucher #{} for channel {}: {} lamports cumulative",
        voucher.sequence,
        channel.channel_id,
        cumulative_amount
    );
    Ok(())
}

pub fn handler_claim_voucher(ctx: Context<ClaimVoucher>, _channel_id: u64) -> Result<()> {
    let channel = &mut ctx.accounts.channel;
    require!(
        channel.agent == ctx.accounts.agent.key(),
        TaskForestError::Unauthorized
    );
    require!(
        channel.last_voucher_amount > channel.claimed,
        TaskForestError::NothingToClaim
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
        "Agent claimed {} lamports from channel {}",
        claimable,
        channel.channel_id
    );
    Ok(())
}

pub fn handler_close_payment_channel(
    ctx: Context<ClosePaymentChannel>,
    _channel_id: u64,
) -> Result<()> {
    let channel = &mut ctx.accounts.channel;
    require!(
        channel.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
    );
    require!(
        channel.status == ChannelStatus::Open,
        TaskForestError::ChannelNotOpen
    );

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

    let rent = Rent::get()?;
    let min_balance = rent.minimum_balance(PaymentChannel::SIZE);
    let refundable = channel
        .to_account_info()
        .lamports()
        .saturating_sub(min_balance);
    if refundable > 0 {
        **channel.to_account_info().try_borrow_mut_lamports()? -= refundable;
        **ctx
            .accounts
            .poster
            .to_account_info()
            .try_borrow_mut_lamports()? += refundable;
    }

    channel.status = ChannelStatus::Closed;
    msg!("Channel {} closed", channel.channel_id);
    Ok(())
}

pub fn handler_delegate_payment_channel(ctx: Context<DelegatePaymentChannel>) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
    ctx.accounts.delegate_pda(
        &ctx.accounts.payer,
        &[CHANNEL_SEED],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    msg!("Payment channel delegated to PER TEE validator");
    Ok(())
}

pub fn handler_settle_payment_channel(ctx: Context<SettlePaymentChannel>) -> Result<()> {
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

pub fn handler_commit_payment_channel(ctx: Context<SettlePaymentChannel>) -> Result<()> {
    commit_accounts(
        &ctx.accounts.payer,
        vec![&ctx.accounts.channel.to_account_info()],
        &ctx.accounts.magic_context,
        &ctx.accounts.magic_program,
    )?;
    msg!("Channel {} committed", ctx.accounts.channel.channel_id);
    Ok(())
}

pub fn handler_record_channel_settlement(
    ctx: Context<RecordChannelSettlement>,
    channel_id: u64,
) -> Result<()> {
    let channel = &ctx.accounts.channel;
    let record = &mut ctx.accounts.settlement_record;

    record.channel_id = channel_id;
    record.job_pubkey = channel.job_pubkey;
    record.poster = channel.poster;
    record.agent = channel.agent;
    record.total_deposited = channel.deposited;
    record.total_claimed = channel.claimed;
    record.voucher_count = channel.voucher_count;
    record.settled_at = Clock::get()?.unix_timestamp;
    record.settlement_hash = compute_settlement_hash(channel);

    msg!("Settlement recorded for channel {}", channel_id);
    Ok(())
}

fn compute_settlement_hash(channel: &PaymentChannel) -> [u8; 32] {
    let mut data = Vec::with_capacity(152);
    data.extend_from_slice(&channel.channel_id.to_le_bytes());
    data.extend_from_slice(&channel.job_pubkey.to_bytes());
    data.extend_from_slice(&channel.poster.to_bytes());
    data.extend_from_slice(&channel.agent.to_bytes());
    data.extend_from_slice(&channel.deposited.to_le_bytes());
    data.extend_from_slice(&channel.claimed.to_le_bytes());
    data.extend_from_slice(&channel.voucher_count.to_le_bytes());
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut result = [0u8; 32];
    for chunk_start in (0..data.len()).step_by(8) {
        let mut hasher = DefaultHasher::new();
        data[chunk_start..].hash(&mut hasher);
        let h = hasher.finish().to_le_bytes();
        let offset = (chunk_start / 8) % 4;
        for i in 0..8 {
            result[offset * 8 + i] ^= h[i];
        }
    }
    result
}

// ── Instruction Contexts ──────────────────────────────────────────

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct CreatePaymentChannel<'info> {
    pub job: Account<'info, Job>,
    #[account(
        init,
        payer = poster,
        space = PaymentChannel::SIZE,
        seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut, constraint = poster.key() == job.poster @ TaskForestError::Unauthorized)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPaymentChannel<'info> {
    #[account(mut, has_one = poster)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct SendVoucher<'info> {
    #[account(mut, seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()], bump)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(
        init_if_needed,
        payer = poster,
        space = PaymentVoucher::SIZE,
        seeds = [VOUCHER_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub voucher: Account<'info, PaymentVoucher>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct ClaimVoucher<'info> {
    #[account(mut, seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()], bump)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct ClosePaymentChannel<'info> {
    #[account(mut, seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()], bump, has_one = poster)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub poster: Signer<'info>,
    /// CHECK: Agent wallet for unclaimed funds
    #[account(mut, constraint = agent.key() == channel.agent)]
    pub agent: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePaymentChannel<'info> {
    /// CHECK: The PDA to delegate
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: ER validator
    pub validator: Option<AccountInfo<'info>>,
}

#[commit]
#[derive(Accounts)]
pub struct SettlePaymentChannel<'info> {
    #[account(mut, seeds = [CHANNEL_SEED, &channel.channel_id.to_le_bytes()], bump)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(channel_id: u64)]
pub struct RecordChannelSettlement<'info> {
    #[account(seeds = [CHANNEL_SEED, &channel_id.to_le_bytes()], bump)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(
        init,
        payer = payer,
        space = SettlementRecord::SIZE,
        seeds = [SETTLEMENT_SEED, &channel_id.to_le_bytes()],
        bump
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
