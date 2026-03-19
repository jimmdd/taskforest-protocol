use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Worker submits proof of task completion.
pub fn handler_submit_proof(ctx: Context<SubmitProof>, proof_hash: [u8; 32]) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_STAKED || job.status == STATUS_CLAIMED,
        TaskForestError::WrongStatus
    );
    require!(
        job.claimer == ctx.accounts.submitter.key(),
        TaskForestError::InvalidClaimer
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= job.deadline,
        TaskForestError::DeadlinePassed
    );

    job.proof_hash = proof_hash;
    job.submitted_at = clock.unix_timestamp;
    job.status = STATUS_SUBMITTED;

    msg!(
        "Proof submitted for job by {}",
        ctx.accounts.submitter.key()
    );
    Ok(())
}

pub fn handler_submit_verified_proof(
    ctx: Context<SubmitVerifiedProof>,
    proof_hash: [u8; 32],
    receipt_root: [u8; 32],
    receipt_uri: [u8; 32],
    attestation_hash: [u8; 32],
) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_STAKED || job.status == STATUS_CLAIMED,
        TaskForestError::WrongStatus
    );
    require!(
        job.claimer == ctx.accounts.submitter.key(),
        TaskForestError::InvalidClaimer
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= job.deadline,
        TaskForestError::DeadlinePassed
    );

    job.proof_hash = proof_hash;
    job.receipt_root = receipt_root;
    job.receipt_uri = receipt_uri;
    job.attestation_hash = attestation_hash;
    job.submitted_at = clock.unix_timestamp;
    job.dispute_window_end = if job.verification_level >= 1 {
        clock.unix_timestamp + DISPUTE_WINDOW_SECS
    } else {
        0
    };
    job.status = STATUS_SUBMITTED;

    msg!(
        "Verified proof submitted for job by {}",
        ctx.accounts.submitter.key()
    );
    Ok(())
}

/// Submit encrypted proof - stores encrypted output hash on-chain.
/// Actual encrypted output stored off-chain (IPFS).
pub fn handler_submit_encrypted_proof(
    ctx: Context<SubmitProof>,
    proof_hash: [u8; 32],
    encrypted_output_hash: [u8; 32],
) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_CLAIMED || job.status == STATUS_STAKED,
        TaskForestError::WrongStatus
    );
    require!(
        job.claimer == ctx.accounts.submitter.key(),
        TaskForestError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp <= job.deadline,
        TaskForestError::DeadlineNotPassed
    );

    job.proof_hash = proof_hash;
    job.encrypted_output_hash = encrypted_output_hash;
    job.submitted_at = clock.unix_timestamp;
    job.status = STATUS_SUBMITTED;

    msg!(
        "Encrypted proof submitted: hash={:?} output={:?}",
        &proof_hash[..4],
        &encrypted_output_hash[..4]
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub submitter: Signer<'info>,
}

#[derive(Accounts)]
pub struct SubmitVerifiedProof<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub submitter: Signer<'info>,
}
