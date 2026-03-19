use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

pub fn handler_auto_settle(ctx: Context<AutoSettle>) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(job.status == STATUS_SUBMITTED, TaskForestError::WrongStatus);
    require!(
        job.dispute_window_end > 0,
        TaskForestError::DisputeWindowExpired
    );
    require!(
        job.claimer == ctx.accounts.claimer.key(),
        TaskForestError::InvalidClaimer
    );

    let now = Clock::get()?.unix_timestamp;
    require!(
        now > job.dispute_window_end,
        TaskForestError::DisputeWindowActive
    );

    let payout = job.reward_lamports + job.claimer_stake;
    let job_info = job.to_account_info();
    let job_lamports = job_info.lamports();
    let rent = Rent::get()?.minimum_balance(Job::SIZE);
    let available = job_lamports.saturating_sub(rent);
    let transfer_amount = payout.min(available);

    if transfer_amount > 0 {
        **job_info.try_borrow_mut_lamports()? -= transfer_amount;
        **ctx.accounts.claimer.try_borrow_mut_lamports()? += transfer_amount;
    }

    job.status = STATUS_DONE;
    msg!(
        "Auto-settled: worker={} payout={} after dispute window",
        job.claimer,
        transfer_amount
    );
    Ok(())
}

/// Settle the job with a pass/fail verdict. Only poster can settle.
/// Real SOL transfers based on verdict.
pub fn handler_settle_job(
    ctx: Context<SettleJob>,
    verdict: u8,
    _reason_code: [u8; 32],
) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(job.status == STATUS_SUBMITTED, TaskForestError::WrongStatus);
    require!(job.proof_hash != [0u8; 32], TaskForestError::MissingProof);
    require!(verdict <= 1, TaskForestError::InvalidVerdict);
    // Only poster can settle
    require!(
        job.poster == ctx.accounts.settler.key(),
        TaskForestError::Unauthorized
    );

    let job_info = job.to_account_info();

    if verdict == 1 {
        // PASS: worker gets reward + stake back
        let payout = job.reward_lamports + job.claimer_stake;
        let job_lamports = job_info.lamports();
        let rent = Rent::get()?.minimum_balance(Job::SIZE);
        let available = job_lamports.saturating_sub(rent);
        let transfer_amount = payout.min(available);

        if transfer_amount > 0 {
            **job_info.try_borrow_mut_lamports()? -= transfer_amount;
            **ctx.accounts.claimer_account.try_borrow_mut_lamports()? += transfer_amount;
        }

        job.status = STATUS_DONE;
        msg!(
            "Job PASSED: worker={} payout={} (reward={} + stake={})",
            job.claimer,
            transfer_amount,
            job.reward_lamports,
            job.claimer_stake
        );
    } else {
        // FAIL: poster gets reward refund, stake is burned (stays in PDA)
        let refund = job.reward_lamports;
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
            "Job FAILED: poster_refund={} stake_burned={}",
            transfer_amount,
            job.claimer_stake
        );
    }

    Ok(())
}

/// Worker auto-claims if poster doesn't settle within review period.
/// This protects workers from posters who refuse to pay.
pub fn handler_claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(job.status == STATUS_SUBMITTED, TaskForestError::WrongStatus);
    require!(
        job.claimer == ctx.accounts.claimer.key(),
        TaskForestError::InvalidClaimer
    );

    let clock = Clock::get()?;
    let review_deadline = job.submitted_at + REVIEW_PERIOD_SECS;
    require!(
        clock.unix_timestamp > review_deadline,
        TaskForestError::ReviewPeriodActive
    );

    // Worker gets reward + stake back (same as PASS)
    let payout = job.reward_lamports + job.claimer_stake;
    let job_info = job.to_account_info();
    let job_lamports = job_info.lamports();
    let rent = Rent::get()?.minimum_balance(Job::SIZE);
    let available = job_lamports.saturating_sub(rent);
    let transfer_amount = payout.min(available);

    if transfer_amount > 0 {
        **job_info.try_borrow_mut_lamports()? -= transfer_amount;
        **ctx.accounts.claimer.try_borrow_mut_lamports()? += transfer_amount;
    }

    job.status = STATUS_DONE;
    msg!(
        "Timeout claim: worker={} payout={} (poster failed to settle within {}s)",
        job.claimer,
        transfer_amount,
        REVIEW_PERIOD_SECS
    );
    Ok(())
}

/// Archive a settled job's outcome to a separate PDA.
pub fn handler_archive_settlement(
    ctx: Context<ArchiveSettlement>,
    reason_code: [u8; 32],
) -> Result<()> {
    let job = &ctx.accounts.job;
    require!(
        job.status == STATUS_DONE || job.status == STATUS_FAILED,
        TaskForestError::WrongStatus
    );

    let verdict = if job.status == STATUS_DONE { 1u8 } else { 0u8 };
    let clock = Clock::get()?;

    let archive = &mut ctx.accounts.archive;
    archive.job = ctx.accounts.job.key();
    archive.poster = job.poster;
    archive.claimer = job.claimer;
    archive.reward_lamports = job.reward_lamports;
    archive.claimer_stake = job.claimer_stake;
    archive.verdict = verdict;
    archive.proof_hash = job.proof_hash;
    archive.reason_code = reason_code;
    archive.settled_at = clock.unix_timestamp;
    archive.bump = ctx.bumps.archive;

    msg!(
        "Settlement archived: job={} verdict={} reward={}",
        archive.job,
        verdict,
        archive.reward_lamports
    );
    Ok(())
}

#[derive(Accounts)]
pub struct AutoSettle<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub claimer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Settlement with real SOL transfers.
#[derive(Accounts)]
pub struct SettleJob<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub settler: Signer<'info>,
    /// CHECK: Receives reward refund on FAIL. Validated in instruction.
    #[account(mut)]
    pub poster_account: UncheckedAccount<'info>,
    /// CHECK: Receives payout on PASS. Validated in instruction.
    #[account(mut)]
    pub claimer_account: UncheckedAccount<'info>,
}

/// Worker auto-claims if poster doesn't settle within review period.
#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub claimer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ArchiveSettlement<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The settled job to archive
    pub job: Account<'info, Job>,
    /// The archive PDA - seeded by ["archive", job.key()]
    #[account(
        init,
        payer = payer,
        space = SettlementArchive::SIZE,
        seeds = [ARCHIVE_SEED, job.key().as_ref()],
        bump
    )]
    pub archive: Account<'info, SettlementArchive>,
    pub system_program: Program<'info, System>,
}
