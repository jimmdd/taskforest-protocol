use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

// --- Attestation report format (TFBA = TaskForest Bid Attestation) ---
const ATTESTATION_MAGIC: &[u8; 4] = b"TFBA";
const ATTESTATION_VERSION: u8 = 1;
// Layout: magic(4) + version(4) + job_id(8) + poster(32) + validator(32) + tee_pubkey(32) + issued_at(8) + expires_at(8) = 128
const ATTESTATION_REPORT_LEN: usize = 128;

const ED25519_HEADER_LEN: usize = 16;
const ED25519_SIGNATURE_LEN: usize = 64;
const ED25519_PUBKEY_LEN: usize = 32;
const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

struct ParsedBidAttestationReport {
    job_id: u64,
    poster: Pubkey,
    validator: Pubkey,
    tee_pubkey: [u8; 32],
    issued_at: i64,
    expires_at: i64,
}

fn is_allowed_validator(key: &Pubkey) -> bool {
    key == &DEVNET_TEE_VALIDATOR || key == &MAINNET_TEE_VALIDATOR || key == &LOCALNET_TEE_VALIDATOR
}

fn read_u16(data: &[u8], start: usize) -> Result<u16> {
    let bytes = data
        .get(start..start + 2)
        .ok_or(TaskForestError::InvalidAttestationSignature)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn read_u64(data: &[u8], start: usize) -> Result<u64> {
    let bytes = data
        .get(start..start + 8)
        .ok_or(TaskForestError::InvalidAttestation)?;
    let mut out = [0u8; 8];
    out.copy_from_slice(bytes);
    Ok(u64::from_le_bytes(out))
}

fn read_i64(data: &[u8], start: usize) -> Result<i64> {
    let bytes = data
        .get(start..start + 8)
        .ok_or(TaskForestError::InvalidAttestation)?;
    let mut out = [0u8; 8];
    out.copy_from_slice(bytes);
    Ok(i64::from_le_bytes(out))
}

fn read_pubkey(data: &[u8], start: usize) -> Result<Pubkey> {
    let bytes = data
        .get(start..start + 32)
        .ok_or(TaskForestError::InvalidAttestation)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(Pubkey::new_from_array(out))
}

fn read_bytes32(data: &[u8], start: usize) -> Result<[u8; 32]> {
    let bytes = data
        .get(start..start + 32)
        .ok_or(TaskForestError::InvalidAttestation)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(bytes);
    Ok(out)
}

fn parse_bid_attestation_report(report: &[u8]) -> Result<ParsedBidAttestationReport> {
    require!(
        report.len() == ATTESTATION_REPORT_LEN,
        TaskForestError::InvalidAttestation
    );
    require!(
        report.get(0..4) == Some(ATTESTATION_MAGIC),
        TaskForestError::InvalidAttestation
    );
    require!(
        report.get(4).copied() == Some(ATTESTATION_VERSION),
        TaskForestError::InvalidAttestation
    );

    Ok(ParsedBidAttestationReport {
        job_id: read_u64(report, 8)?,
        poster: read_pubkey(report, 16)?,
        validator: read_pubkey(report, 48)?,
        tee_pubkey: read_bytes32(report, 80)?,
        issued_at: read_i64(report, 112)?,
        expires_at: read_i64(report, 120)?,
    })
}

fn verify_attestation_signature(
    instructions_sysvar: &AccountInfo<'_>,
    validator: &Pubkey,
    report: &[u8],
) -> Result<()> {
    let current_index = load_current_index_checked(instructions_sysvar)
        .map_err(|_| error!(TaskForestError::InvalidAttestationSignature))?;
    require!(current_index > 0, TaskForestError::InvalidAttestationSignature);

    let ix = load_instruction_at_checked((current_index - 1) as usize, instructions_sysvar)
        .map_err(|_| error!(TaskForestError::InvalidAttestationSignature))?;
    require!(
        ix.program_id == ED25519_PROGRAM_ID,
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        ix.data.len() >= ED25519_HEADER_LEN + ED25519_PUBKEY_LEN + ED25519_SIGNATURE_LEN,
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        ix.data[0] == 1,
        TaskForestError::InvalidAttestationSignature
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
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        public_key_offset + ED25519_PUBKEY_LEN <= ix.data.len(),
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        signature_offset + ED25519_SIGNATURE_LEN <= ix.data.len(),
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        message_data_offset + message_data_size <= ix.data.len(),
        TaskForestError::InvalidAttestationSignature
    );

    let mut signer_bytes = [0u8; 32];
    signer_bytes.copy_from_slice(&ix.data[public_key_offset..public_key_offset + ED25519_PUBKEY_LEN]);
    require!(
        Pubkey::new_from_array(signer_bytes) == *validator,
        TaskForestError::InvalidAttestationSignature
    );
    require!(
        &ix.data[message_data_offset..message_data_offset + message_data_size] == report,
        TaskForestError::InvalidAttestationSignature
    );
    Ok(())
}

/// Verify that bidding happened inside a TEE-attested PER enclave.
/// Called by the TEE validator after delegation to prove enclave authenticity.
pub fn handler_verify_bid_attestation(
    ctx: Context<VerifyBidAttestation>,
    attestation_report: Vec<u8>,
    tee_pubkey: [u8; 32],
) -> Result<()> {
    let job = &mut ctx.accounts.job;
    let report = parse_bid_attestation_report(&attestation_report)?;

    // Validate report matches on-chain job state
    require!(
        report.job_id == job.job_id,
        TaskForestError::AttestationMismatch
    );
    require!(
        report.poster == job.poster,
        TaskForestError::AttestationMismatch
    );
    require!(
        report.tee_pubkey == tee_pubkey,
        TaskForestError::AttestationMismatch
    );

    // Validate report is not empty and within size bounds
    require!(
        !attestation_report.is_empty(),
        TaskForestError::InvalidAttestation
    );

    // Validate validator is in allowlist
    require!(
        is_allowed_validator(&ctx.accounts.validator.key()),
        TaskForestError::InvalidValidator
    );
    require!(
        report.validator == ctx.accounts.validator.key(),
        TaskForestError::AttestationMismatch
    );

    // Verify Ed25519 signature in preceding instruction
    verify_attestation_signature(
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &ctx.accounts.validator.key(),
        &attestation_report,
    )?;

    // Validate time window
    let clock = Clock::get()?;
    require!(
        report.issued_at <= clock.unix_timestamp && clock.unix_timestamp <= report.expires_at,
        TaskForestError::AttestationExpired
    );

    // Job must be in bidding-eligible state
    require!(
        job.status == STATUS_OPEN || job.status == STATUS_BIDDING,
        TaskForestError::WrongStatus
    );

    // Mark TEE as verified
    job.tee_pubkey = tee_pubkey;
    job.tee_verified = true;

    msg!(
        "PER TEE verified for job {} — pubkey: {:?}",
        job.job_id,
        &tee_pubkey[..8]
    );
    Ok(())
}

// ── Context ──────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct VerifyBidAttestation<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account()]
    pub validator: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Solana instructions sysvar for ed25519 signature verification
    #[account(address = anchor_lang::solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: UncheckedAccount<'info>,
}
