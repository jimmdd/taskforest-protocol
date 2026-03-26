use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::TaskforestPaymentsError;
use crate::state::payment::*;

fn is_allowed_validator(key: &Pubkey) -> bool {
    key == &DEVNET_TEE_VALIDATOR || key == &MAINNET_TEE_VALIDATOR || key == &LOCALNET_TEE_VALIDATOR
}

const ATTESTATION_MAGIC: &[u8; 4] = b"TFAT";
const ATTESTATION_VERSION: u8 = 1;
const ATTESTATION_REPORT_LEN: usize = 160;
const ATTESTATION_HEADER_LEN: usize = 8;
const ED25519_HEADER_LEN: usize = 16;
const ED25519_SIGNATURE_LEN: usize = 64;
const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

struct ParsedAttestationReport {
    escrow_id: u64,
    job_pubkey: Pubkey,
    validator: Pubkey,
    tee_pubkey: [u8; 32],
    mpp_session_id: [u8; 32],
    issued_at: i64,
    expires_at: i64,
}

fn read_u16(data: &[u8], start: usize) -> Result<u16> {
    let bytes = data
        .get(start..start + 2)
        .ok_or(TaskforestPaymentsError::InvalidAttestationSignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u64(data: &[u8], start: usize) -> Result<u64> {
    let bytes = data
        .get(start..start + 8)
        .ok_or(TaskforestPaymentsError::InvalidAttestation)?;
    let mut out = [0u8; 8];
    out.copy_from_slice(bytes);
    Ok(u64::from_le_bytes(out))
}

fn read_i64(data: &[u8], start: usize) -> Result<i64> {
    let bytes = data
        .get(start..start + 8)
        .ok_or(TaskforestPaymentsError::InvalidAttestation)?;
    let mut out = [0u8; 8];
    out.copy_from_slice(bytes);
    Ok(i64::from_le_bytes(out))
}

fn read_pubkey(data: &[u8], start: usize) -> Result<Pubkey> {
    let bytes = data
        .get(start..start + 32)
        .ok_or(TaskforestPaymentsError::InvalidAttestation)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(Pubkey::new_from_array(out))
}

fn read_bytes32(data: &[u8], start: usize) -> Result<[u8; 32]> {
    let bytes = data
        .get(start..start + 32)
        .ok_or(TaskforestPaymentsError::InvalidAttestation)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn parse_attestation_report(report: &[u8]) -> Result<ParsedAttestationReport> {
    require!(
        report.len() == ATTESTATION_REPORT_LEN,
        TaskforestPaymentsError::InvalidAttestation
    );
    require!(
        report.get(0..4) == Some(ATTESTATION_MAGIC),
        TaskforestPaymentsError::InvalidAttestation
    );
    require!(
        report.get(4).copied() == Some(ATTESTATION_VERSION),
        TaskforestPaymentsError::InvalidAttestation
    );

    Ok(ParsedAttestationReport {
        escrow_id: read_u64(report, 8)?,
        job_pubkey: read_pubkey(report, 16)?,
        validator: read_pubkey(report, 48)?,
        tee_pubkey: read_bytes32(report, 80)?,
        mpp_session_id: read_bytes32(report, 112)?,
        issued_at: read_i64(report, 144)?,
        expires_at: read_i64(report, 152)?,
    })
}

fn verify_attestation_signature(
    instructions_sysvar: &AccountInfo<'_>,
    validator: &Pubkey,
    report: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(TaskforestPaymentsError::InvalidAttestationSignature))?;
    require!(current_index > 0, TaskforestPaymentsError::InvalidAttestationSignature);

    let ix = load_instruction_at_checked((current_index - 1) as usize, instructions_sysvar)
        .map_err(|_| error!(TaskforestPaymentsError::InvalidAttestationSignature))?;
    require!(
        ix.program_id == ED25519_PROGRAM_ID,
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        ix.data.len() >= ED25519_HEADER_LEN + ED25519_PUBKEY_LEN + ED25519_SIGNATURE_LEN,
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        ix.data[0] == 1,
        TaskforestPaymentsError::InvalidAttestationSignature
    );

    let signature_offset = read_u16(&ix.data, 2)? as usize;
    let signature_instruction_index = read_u16(&ix.data, 4)?;
    let public_key_offset = read_u16(&ix.data, 6)? as usize;
    let public_key_instruction_index = read_u16(&ix.data, 8)?;
    let message_data_offset = read_u16(&ix.data, 10)? as usize;
    let message_data_size = read_u16(&ix.data, 12)? as usize;
    let message_instruction_index = read_u16(&ix.data, 14)?;

    require!(
        signature_instruction_index == u16::MAX
            && public_key_instruction_index == u16::MAX
            && message_instruction_index == u16::MAX,
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        public_key_offset + ED25519_PUBKEY_LEN <= ix.data.len(),
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        signature_offset + ED25519_SIGNATURE_LEN <= ix.data.len(),
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        message_data_offset + message_data_size <= ix.data.len(),
        TaskforestPaymentsError::InvalidAttestationSignature
    );

    let mut signer_bytes = [0u8; 32];
    signer_bytes.copy_from_slice(&ix.data[public_key_offset..public_key_offset + ED25519_PUBKEY_LEN]);
    require!(
        Pubkey::new_from_array(signer_bytes) == *validator,
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    require!(
        &ix.data[message_data_offset..message_data_offset + message_data_size] == report,
        TaskforestPaymentsError::InvalidAttestationSignature
    );
    Ok(())
}

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
    escrow.validator = Pubkey::default();
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

pub fn handler_delegate_to_per(ctx: Context<DelegateToPer>, escrow_id: u64) -> Result<()> {
    let validator = ctx.remaining_accounts.first().map(|v| v.key());
    ctx.accounts.delegate_pda(
        &ctx.accounts.payer,
        &[ESCROW_SEED, &escrow_id.to_le_bytes()],
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
    escrow_id: u64,
    attestation_report: Vec<u8>,
    tee_pubkey: [u8; 32],
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let report = parse_attestation_report(&attestation_report)?;
    require!(
        escrow.escrow_id == escrow_id,
        TaskforestPaymentsError::InvalidAttestation
    );
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
    require!(
        is_allowed_validator(&ctx.accounts.validator.key()),
        TaskforestPaymentsError::InvalidValidator
    );
    verify_attestation_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.validator.key(),
        &attestation_report,
    )?;
    require!(
        report.validator == ctx.accounts.validator.key(),
        TaskforestPaymentsError::AttestationMismatch
    );
    require!(
        report.escrow_id == escrow.escrow_id,
        TaskforestPaymentsError::AttestationMismatch
    );
    require!(
        report.job_pubkey == escrow.job_pubkey,
        TaskforestPaymentsError::AttestationMismatch
    );
    require!(
        report.mpp_session_id == escrow.mpp_session_id,
        TaskforestPaymentsError::AttestationMismatch
    );
    require!(
        report.tee_pubkey == tee_pubkey,
        TaskforestPaymentsError::AttestationMismatch
    );
    let clock = Clock::get()?;
    require!(
        report.issued_at <= clock.unix_timestamp && clock.unix_timestamp <= report.expires_at,
        TaskforestPaymentsError::AttestationExpired
    );

    escrow.tee_pubkey = tee_pubkey;
    escrow.validator = ctx.accounts.validator.key();
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
    require!(
        total_paid <= escrow.deposited,
        TaskforestPaymentsError::SettlementExceedsDeposit
    );

    record.escrow_id = escrow_id;
    record.job_pubkey = escrow.job_pubkey;
    record.poster = escrow.poster;
    record.agent = escrow.agent;
    record.total_deposited = escrow.deposited;
    record.total_paid = total_paid;
    record.settled_at = clock.unix_timestamp;
    record.settlement_hash = compute_settlement_hash(escrow, total_paid, clock.unix_timestamp);

    escrow.status = EscrowStatus::Settled;

    if total_paid > 0 {
        **escrow.to_account_info().try_borrow_mut_lamports()? -= total_paid;
        **ctx
            .accounts
            .agent
            .to_account_info()
            .try_borrow_mut_lamports()? += total_paid;
    }

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
    data.extend_from_slice(&escrow.validator.to_bytes());
    data.extend_from_slice(&escrow.deposited.to_le_bytes());
    data.extend_from_slice(&total_paid.to_le_bytes());
    data.extend_from_slice(&escrow.mpp_session_id);
    data.extend_from_slice(&settled_at.to_le_bytes());
    *blake3::hash(&data).as_bytes()
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
#[instruction(escrow_id: u64)]
pub struct DelegateToPer<'info> {
    #[account(
        mut,
        del,
        seeds = [ESCROW_SEED, &escrow_id.to_le_bytes()],
        bump,
        constraint = pda.poster == payer.key() @ TaskforestPaymentsError::Unauthorized,
        constraint = pda.status == EscrowStatus::Active @ TaskforestPaymentsError::EscrowNotActive,
    )]
    pub pda: Account<'info, EscrowWrapper>,
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(escrow_id: u64)]
pub struct VerifyTeeAttestation<'info> {
    #[account(mut, seeds = [ESCROW_SEED, &escrow_id.to_le_bytes()], bump)]
    pub escrow: Account<'info, EscrowWrapper>,
    #[account()]
    pub validator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Solana instructions sysvar for ed25519 signature verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
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
    /// CHECK: Agent wallet for payout
    #[account(mut, constraint = agent.key() == escrow.agent @ TaskforestPaymentsError::Unauthorized)]
    pub agent: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}
