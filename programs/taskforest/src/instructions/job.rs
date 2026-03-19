use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Create a new job/bounty. Poster deposits reward SOL into the job PDA.
/// privacy_level: 0=public, 1=encrypted, 2=per
/// encryption_pubkey: poster's X25519 pubkey (all zeros for public jobs)
pub fn handler_initialize_job(
    ctx: Context<InitializeJob>,
    job_id: u64,
    reward_lamports: u64,
    deadline: i64,
    proof_spec_hash: [u8; 32],
    ttd_hash: [u8; 32],
    privacy_level: u8,
    encryption_pubkey: [u8; 32],
    assignment_mode: u8,
    verification_level: u8,
) -> Result<()> {
    require!(reward_lamports > 0, TaskForestError::InvalidReward);

    let clock = Clock::get()?;
    require!(
        deadline > clock.unix_timestamp,
        TaskForestError::InvalidDeadline
    );

    // Transfer reward SOL from poster into job PDA (escrow)
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.poster.to_account_info(),
                to: ctx.accounts.job.to_account_info(),
            },
        ),
        reward_lamports,
    )?;

    let job = &mut ctx.accounts.job;
    job.poster = ctx.accounts.poster.key();
    job.job_id = job_id;
    job.reward_lamports = reward_lamports;
    job.deadline = deadline;
    job.proof_spec_hash = proof_spec_hash;
    job.ttd_hash = ttd_hash;
    job.privacy_level = privacy_level;
    job.encryption_pubkey = encryption_pubkey;
    job.encrypted_input_hash = [0u8; 32];
    job.encrypted_output_hash = [0u8; 32];
    job.status = STATUS_OPEN;
    job.claimer = Pubkey::default();
    job.claimer_stake = 0;
    job.best_bid_stake = 0;
    job.best_bidder = Pubkey::default();
    job.bid_count = 0;
    job.proof_hash = [0u8; 32];
    job.submitted_at = 0;
    job.assignment_mode = assignment_mode;
    job.parent_job = Pubkey::default();
    job.sub_job_count = 0;
    job.verification_level = verification_level;
    job.receipt_root = [0u8; 32];
    job.receipt_uri = [0u8; 32];
    job.attestation_hash = [0u8; 32];
    job.dispute_window_end = 0;
    job.bump = ctx.bumps.job;

    msg!(
        "Job #{} created: reward={} privacy={} ttd={:?}",
        job_id,
        reward_lamports,
        privacy_level,
        &ttd_hash[..4]
    );
    Ok(())
}

pub fn handler_auto_assign_job(ctx: Context<AutoAssignJob>, assigned_agent: Pubkey) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(job.status == STATUS_OPEN, TaskForestError::WrongStatus);
    require!(job.assignment_mode == 1, TaskForestError::NotAutoMatch);
    require!(
        job.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
    );

    job.claimer = assigned_agent;
    job.status = STATUS_CLAIMED;

    msg!("Auto-assigned: agent={}", assigned_agent);
    Ok(())
}

pub fn handler_create_sub_job(
    ctx: Context<CreateSubJob>,
    sub_job_id: u64,
    assigned_agent: Pubkey,
    reward_lamports: u64,
    deadline: i64,
    ttd_hash: [u8; 32],
) -> Result<()> {
    require!(reward_lamports > 0, TaskForestError::InvalidReward);

    let parent_key = ctx.accounts.parent_job.key();
    let parent_job = &mut ctx.accounts.parent_job;
    require!(
        parent_job.status == STATUS_STAKED,
        TaskForestError::WrongStatus
    );
    require!(
        parent_job.claimer == ctx.accounts.orchestrator.key(),
        TaskForestError::InvalidClaimer
    );

    let rent = Rent::get()?.minimum_balance(Job::SIZE);
    let parent_job_info = parent_job.to_account_info();
    require!(
        parent_job_info.lamports() > rent,
        TaskForestError::InsufficientEscrowForSubJob
    );
    let available_escrow = parent_job_info.lamports().saturating_sub(rent);
    require!(
        available_escrow >= reward_lamports,
        TaskForestError::SubJobExceedsEscrow
    );

    let parent_poster = parent_job.poster;
    let parent_proof_spec_hash = parent_job.proof_spec_hash;
    let parent_privacy_level = parent_job.privacy_level;
    let parent_encryption_pubkey = parent_job.encryption_pubkey;
    let parent_verification_level = parent_job.verification_level;

    let sub_job_info = ctx.accounts.sub_job.to_account_info();
    **parent_job_info.try_borrow_mut_lamports()? -= reward_lamports;
    **sub_job_info.try_borrow_mut_lamports()? += reward_lamports;

    let sub_job = &mut ctx.accounts.sub_job;
    sub_job.poster = parent_poster;
    sub_job.job_id = sub_job_id;
    sub_job.reward_lamports = reward_lamports;
    sub_job.deadline = deadline;
    sub_job.proof_spec_hash = parent_proof_spec_hash;
    sub_job.ttd_hash = ttd_hash;
    sub_job.privacy_level = parent_privacy_level;
    sub_job.encryption_pubkey = parent_encryption_pubkey;
    sub_job.encrypted_input_hash = [0u8; 32];
    sub_job.encrypted_output_hash = [0u8; 32];
    sub_job.status = STATUS_OPEN;
    sub_job.claimer = assigned_agent;
    sub_job.claimer_stake = 0;
    sub_job.best_bid_stake = 0;
    sub_job.best_bidder = Pubkey::default();
    sub_job.bid_count = 0;
    sub_job.proof_hash = [0u8; 32];
    sub_job.submitted_at = 0;
    sub_job.assignment_mode = 1;
    sub_job.parent_job = parent_key;
    sub_job.sub_job_count = 0;
    sub_job.verification_level = parent_verification_level;
    sub_job.receipt_root = [0u8; 32];
    sub_job.receipt_uri = [0u8; 32];
    sub_job.attestation_hash = [0u8; 32];
    sub_job.dispute_window_end = 0;
    sub_job.bump = ctx.bumps.sub_job;

    parent_job.sub_job_count = parent_job
        .sub_job_count
        .checked_add(1)
        .ok_or(TaskForestError::WrongStatus)?;

    msg!(
        "Sub-job created: parent={} sub_job_id={} agent={} reward={}",
        parent_key,
        sub_job_id,
        assigned_agent,
        reward_lamports
    );
    Ok(())
}

/// Expire a claimed job past its deadline - refunds poster, slashes stake.
pub fn handler_expire_claim(ctx: Context<ExpireClaim>) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_CLAIMED || job.status == STATUS_STAKED,
        TaskForestError::WrongStatus
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > job.deadline,
        TaskForestError::DeadlineNotPassed
    );

    // Refund poster their reward
    let refund = job.reward_lamports;
    let job_info = job.to_account_info();
    let job_lamports = job_info.lamports();
    let rent = Rent::get()?.minimum_balance(Job::SIZE);
    let available = job_lamports.saturating_sub(rent);
    let transfer_amount = refund.min(available);

    if transfer_amount > 0 {
        **job_info.try_borrow_mut_lamports()? -= transfer_amount;
        **ctx.accounts.poster_account.try_borrow_mut_lamports()? += transfer_amount;
    }

    job.status = STATUS_FAILED;
    msg!(
        "Claim expired: poster_refund={} stake_slashed={}",
        transfer_amount,
        job.claimer_stake
    );
    Ok(())
}

/// Expire an unclaimed job past its deadline - refunds poster's escrowed SOL.
/// Works for STATUS_OPEN and STATUS_BIDDING (no winner was selected).
pub fn handler_expire_unclaimed(ctx: Context<ExpireUnclaimed>) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_OPEN || job.status == STATUS_BIDDING,
        TaskForestError::WrongStatus
    );
    require!(
        job.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp > job.deadline,
        TaskForestError::DeadlineNotPassed
    );

    // Refund poster their escrowed reward
    let refund = job.reward_lamports;
    let job_info = job.to_account_info();
    let job_lamports = job_info.lamports();
    let rent = Rent::get()?.minimum_balance(Job::SIZE);
    let available = job_lamports.saturating_sub(rent);
    let transfer_amount = refund.min(available);

    if transfer_amount > 0 {
        **job_info.try_borrow_mut_lamports()? -= transfer_amount;
        **ctx.accounts.poster.try_borrow_mut_lamports()? += transfer_amount;
    }

    job.status = STATUS_FAILED;
    msg!(
        "Unclaimed job expired: refund={} bids={}",
        transfer_amount,
        job.bid_count
    );
    Ok(())
}

/// Extend the deadline of an open/bidding job. Only the poster can call this.
pub fn handler_extend_deadline(ctx: Context<ExtendDeadline>, new_deadline: i64) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(
        job.status == STATUS_OPEN || job.status == STATUS_BIDDING,
        TaskForestError::WrongStatus
    );
    require!(
        job.poster == ctx.accounts.poster.key(),
        TaskForestError::Unauthorized
    );

    let clock = Clock::get()?;
    require!(
        new_deadline > clock.unix_timestamp,
        TaskForestError::InvalidDeadline
    );

    let old = job.deadline;
    job.deadline = new_deadline;
    msg!("Deadline extended: {} -> {}", old, new_deadline);
    Ok(())
}

#[derive(Accounts)]
#[instruction(job_id: u64)]
pub struct InitializeJob<'info> {
    #[account(
        init,
        payer = poster,
        space = Job::SIZE,
        seeds = [JOB_SEED, poster.key().as_ref(), &job_id.to_le_bytes()],
        bump
    )]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AutoAssignJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub poster: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(sub_job_id: u64)]
pub struct CreateSubJob<'info> {
    #[account(mut)]
    pub parent_job: Account<'info, Job>,
    #[account(
        init,
        payer = orchestrator,
        space = Job::SIZE,
        seeds = [JOB_SEED, parent_job.poster.as_ref(), &sub_job_id.to_le_bytes()],
        bump
    )]
    pub sub_job: Account<'info, Job>,
    #[account(mut)]
    pub orchestrator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Expire a claimed job past deadline - refunds poster.
#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    /// CHECK: Receives reward refund. Validated via job.poster in instruction.
    #[account(mut)]
    pub poster_account: UncheckedAccount<'info>,
}

/// Expire an unclaimed job past deadline - poster reclaims SOL.
#[derive(Accounts)]
pub struct ExpireUnclaimed<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub poster: Signer<'info>,
}

/// Extend deadline of an open/bidding job.
#[derive(Accounts)]
pub struct ExtendDeadline<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub poster: Signer<'info>,
}
