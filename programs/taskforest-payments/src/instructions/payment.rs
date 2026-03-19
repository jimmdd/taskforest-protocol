use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::TaskforestPaymentsError;
use crate::state::payment::*;

pub fn handler_create_escrow_wrapper(
    ctx: Context<CreateEscrowWrapper>,
    escrow_id: u64,
    deposit_lamports: u64,
    mpp_session_id: [u8; 32],
) -> Result<()> {
    let job = &ctx.accounts.job;
    let escrow = &mut ctx.accounts.escrow;
    let clock = Clock::get()?;

    escrow.escrow_id = escrow_id;
    escrow.job_pubkey = job.key();
    escrow.poster = ctx.accounts.poster.key();
    escrow.agent = job.claimer;
    escrow.deposited = deposit_lamports;
    escrow.status = EscrowStatus::Active;
    escrow.tee_pubkey = [0u8; 32];
    escrow.tee_verified = false;
    escrow.mpp_session_id = mpp_session_id;
    escrow.created_at = clock.unix_timestamp;

    let ix = anchor_lang::solana_program::system_instruction::transfer(
        &ctx.accounts.poster.key(),
        &escrow.key(),
        deposit_lamports,
    );
    anchor_lang::solana_program::program::invoke(
        &ix,
        &[
            ctx.accounts.poster.to_account_info(),
            escrow.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    msg!(
        "Escrow wrapper {} created for job {}, MPP session linked",
        escrow_id,
        job.key()
    );
    Ok(())
}

pub fn handler_delegate_to_per(ctx: Context<DelegateToPer>) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref().map(|v| v.key());
    ctx.accounts.delegate_pda(
        &ctx.accounts.payer,
        &[ESCROW_SEED],
        DelegateConfig {
            validator,
            ..Default::default()
        },
    )?;
    msg!("Escrow delegated to PER TEE validator");
    Ok(())
}

pub fn handler_verify_tee_attestation(
    ctx: Context<VerifyTeeAttestation>,
    _escrow_id: u64,
    attestation_report: Vec<u8>,
    tee_pubkey: [u8; 32],
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    require!(
        escrow.status == EscrowStatus::Active,
        TaskforestPaymentsError::EscrowNotActive
    );
    require!(
        !attestation_report.is_empty(),
        TaskforestPaymentsError::InvalidAttestation
    );
    require!(
        attestation_report.len() <= 4096,
        TaskforestPaymentsError::AttestationTooLarge
    );

    escrow.tee_pubkey = tee_pubkey;
    escrow.tee_verified = true;
    escrow.status = EscrowStatus::Delegated;

    msg!(
        "TEE verified for escrow {} — pubkey: {:?}",
        escrow.escrow_id,
        &tee_pubkey[..8]
    );
    Ok(())
}

pub fn handler_record_settlement(
    ctx: Context<RecordSettlement>,
    escrow_id: u64,
    total_paid: u64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let record = &mut ctx.accounts.settlement_record;
    let clock = Clock::get()?;

    record.escrow_id = escrow_id;
    record.job_pubkey = escrow.job_pubkey;
    record.poster = escrow.poster;
    record.agent = escrow.agent;
    record.total_deposited = escrow.deposited;
    record.total_paid = total_paid;
    record.settled_at = clock.unix_timestamp;
    record.settlement_hash = compute_settlement_hash(escrow, total_paid, clock.unix_timestamp);

    escrow.status = EscrowStatus::Settled;

    let refundable = escrow.deposited.saturating_sub(total_paid);
    if refundable > 0 {
        let rent = Rent::get()?;
        let min_balance = rent.minimum_balance(EscrowWrapper::SIZE);
        let available = escrow
            .to_account_info()
            .lamports()
            .saturating_sub(min_balance);
        let refund = refundable.min(available);
        if refund > 0 {
            **escrow.to_account_info().try_borrow_mut_lamports()? -= refund;
            **ctx
                .accounts
                .poster
                .to_account_info()
                .try_borrow_mut_lamports()? += refund;
        }
    }

    msg!(
        "Settlement recorded for escrow {} — paid: {}, refunded: {}",
        escrow_id,
        total_paid,
        refundable
    );
    Ok(())
}

fn compute_settlement_hash(escrow: &EscrowWrapper, total_paid: u64, settled_at: i64) -> [u8; 32] {
    let mut data = Vec::with_capacity(176);
    data.extend_from_slice(&escrow.escrow_id.to_le_bytes());
    data.extend_from_slice(&escrow.job_pubkey.to_bytes());
    data.extend_from_slice(&escrow.poster.to_bytes());
    data.extend_from_slice(&escrow.agent.to_bytes());
    data.extend_from_slice(&escrow.deposited.to_le_bytes());
    data.extend_from_slice(&total_paid.to_le_bytes());
    data.extend_from_slice(&escrow.mpp_session_id);
    data.extend_from_slice(&settled_at.to_le_bytes());
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

// ── Contexts ──────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct CreateEscrowWrapper<'info> {
    pub job: Account<'info, taskforest::state::job::Job>,
    #[account(
        init,
        payer = poster,
        space = EscrowWrapper::SIZE,
        seeds = [ESCROW_SEED, &escrow_id.to_le_bytes()],
        bump
    )]
    pub escrow: Account<'info, EscrowWrapper>,
    #[account(mut, constraint = poster.key() == job.poster @ TaskforestPaymentsError::Unauthorized)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateToPer<'info> {
    /// CHECK: Escrow PDA delegated via #[delegate] macro
    #[account(mut, del)]
    pub pda: AccountInfo<'info>,
    pub payer: Signer<'info>,
    /// CHECK: MagicBlock TEE validator
    pub validator: Option<AccountInfo<'info>>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct VerifyTeeAttestation<'info> {
    #[account(mut, seeds = [ESCROW_SEED, &escrow_id.to_le_bytes()], bump)]
    pub escrow: Account<'info, EscrowWrapper>,
    #[account(mut)]
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct RecordSettlement<'info> {
    #[account(mut, seeds = [ESCROW_SEED, &escrow_id.to_le_bytes()], bump)]
    pub escrow: Account<'info, EscrowWrapper>,
    #[account(
        init,
        payer = payer,
        space = SettlementRecord::SIZE,
        seeds = [SETTLEMENT_SEED, &escrow_id.to_le_bytes()],
        bump
    )]
    pub settlement_record: Account<'info, SettlementRecord>,
    /// CHECK: Poster wallet for refund
    #[account(mut, constraint = poster.key() == escrow.poster)]
    pub poster: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
