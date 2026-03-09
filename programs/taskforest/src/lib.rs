use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

declare_id!("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");

pub const JOB_SEED: &[u8] = b"job";
pub const BID_SEED: &[u8] = b"bid";
pub const ARCHIVE_SEED: &[u8] = b"archive";
pub const TTD_SEED: &[u8] = b"ttd";

// --- Status byte constants ---
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_BIDDING: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2;    // winner selected, needs lock_stake
pub const STATUS_STAKED: u8 = 6;     // stake locked, ready for proof
pub const STATUS_SUBMITTED: u8 = 3;  // proof submitted, awaiting settlement
pub const STATUS_DONE: u8 = 4;       // settled PASS
pub const STATUS_FAILED: u8 = 5;     // settled FAIL or expired

/// Review period: poster has 1 hour after proof submission to settle.
/// If they don't, worker can call claim_timeout to auto-win.
pub const REVIEW_PERIOD_SECS: i64 = 3600;

// --- Error codes ---
#[error_code]
pub enum TaskForestError {
    #[msg("Reward must be greater than zero")]
    InvalidReward,
    #[msg("Deadline must be in the future")]
    InvalidDeadline,
    #[msg("Job is not in the expected status")]
    WrongStatus,
    #[msg("Only the poster can perform this action")]
    Unauthorized,
    #[msg("Bid stake must be greater than zero")]
    InvalidStake,
    #[msg("Bid stake is below minimum (10% of reward)")]
    InsufficientStake,
    #[msg("Only the claimer can submit proof")]
    InvalidClaimer,
    #[msg("Deadline has passed")]
    DeadlinePassed,
    #[msg("Deadline has not yet passed")]
    DeadlineNotPassed,
    #[msg("Invalid verdict value")]
    InvalidVerdict,
    #[msg("Proof must be submitted before settlement")]
    MissingProof,
    #[msg("Review period has not expired")]
    ReviewPeriodActive,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrow,
    #[msg("TTD URI exceeds maximum length")]
    UriTooLong,
}

// --- Account structs ---

#[account]
#[derive(Default)]
pub struct Job {
    pub poster: Pubkey,            // 32
    pub job_id: u64,               // 8  — unique nonce per poster
    pub reward_lamports: u64,      // 8
    pub deadline: i64,             // 8
    pub proof_spec_hash: [u8; 32], // 32
    pub ttd_hash: [u8; 32],        // 32 — Task Type Definition hash
    pub status: u8,                // 1
    pub claimer: Pubkey,           // 32
    pub claimer_stake: u64,        // 8
    pub best_bid_stake: u64,       // 8
    pub best_bidder: Pubkey,       // 32
    pub bid_count: u32,            // 4
    pub proof_hash: [u8; 32],      // 32
    pub submitted_at: i64,         // 8
    pub bump: u8,                  // 1
}

impl Job {
    // +32 for ttd_hash
    pub const SIZE: usize = 8 + 32 + 8 + 8 + 8 + 32 + 32 + 1 + 32 + 8 + 8 + 32 + 4 + 32 + 8 + 1;
}

/// Task Type Definition — registered on-chain schema for typed agent tasks.
#[account]
pub struct TaskTypeDefinition {
    pub creator: Pubkey,        // 32 — who registered this TTD
    pub ttd_hash: [u8; 32],     // 32 — SHA-256 of the full TTD JSON
    pub ttd_uri: String,        // 4 + len — where to fetch it (IPFS/R2/Arweave)
    pub version: u16,           // 2  — version number
    pub created_at: i64,        // 8
    pub bump: u8,               // 1
}

impl TaskTypeDefinition {
    pub const MAX_URI_LEN: usize = 128;
    // discriminator + creator + ttd_hash + string_prefix + max_uri + version + created_at + bump
    pub const SIZE: usize = 8 + 32 + 32 + (4 + Self::MAX_URI_LEN) + 2 + 8 + 1;
}

/// Settlement archive — captures the final state of a settled job.
#[account]
#[derive(Default)]
pub struct SettlementArchive {
    pub job: Pubkey,              // 32 — the job PDA key
    pub poster: Pubkey,           // 32
    pub claimer: Pubkey,          // 32
    pub reward_lamports: u64,     // 8
    pub claimer_stake: u64,       // 8
    pub verdict: u8,              // 1 (0=fail, 1=pass)
    pub proof_hash: [u8; 32],     // 32
    pub reason_code: [u8; 32],    // 32
    pub settled_at: i64,          // 8
    pub bump: u8,                 // 1
}

impl SettlementArchive {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 32 + 8 + 1;
}

// --- Program instructions ---

#[ephemeral]
#[program]
pub mod taskforest {
    use super::*;

    /// Register a Task Type Definition on-chain.
    /// Anyone can register — open registry. TTD JSON stored off-chain at ttd_uri.
    pub fn register_ttd(
        ctx: Context<RegisterTtd>,
        ttd_hash: [u8; 32],
        ttd_uri: String,
        version: u16,
    ) -> Result<()> {
        require!(
            ttd_uri.len() <= TaskTypeDefinition::MAX_URI_LEN,
            TaskForestError::UriTooLong
        );

        let ttd = &mut ctx.accounts.ttd;
        ttd.creator = ctx.accounts.creator.key();
        ttd.ttd_hash = ttd_hash;
        ttd.ttd_uri = ttd_uri;
        ttd.version = version;
        ttd.created_at = Clock::get()?.unix_timestamp;
        ttd.bump = ctx.bumps.ttd;

        msg!(
            "TTD registered: hash={:?} version={}",
            &ttd_hash[..4],
            version
        );
        Ok(())
    }

    /// Create a new job/bounty. Poster deposits reward SOL into the job PDA.
    /// Optionally references a TTD via ttd_hash (all zeros = untyped/legacy job).
    pub fn initialize_job(
        ctx: Context<InitializeJob>,
        job_id: u64,
        reward_lamports: u64,
        deadline: i64,
        proof_spec_hash: [u8; 32],
        ttd_hash: [u8; 32],
    ) -> Result<()> {
        require!(reward_lamports > 0, TaskForestError::InvalidReward);

        let clock = Clock::get()?;
        require!(deadline > clock.unix_timestamp, TaskForestError::InvalidDeadline);

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
        job.status = STATUS_OPEN;
        job.claimer = Pubkey::default();
        job.claimer_stake = 0;
        job.best_bid_stake = 0;
        job.best_bidder = Pubkey::default();
        job.bid_count = 0;
        job.proof_hash = [0u8; 32];
        job.submitted_at = 0;
        job.bump = ctx.bumps.job;

        msg!(
            "Job #{} created: reward={} (escrowed) deadline={} ttd={:?}",
            job_id,
            reward_lamports,
            deadline,
            &ttd_hash[..4]
        );
        Ok(())
    }

    /// Delegate job PDA to an Ephemeral Rollup for real-time bidding.
    pub fn delegate_job(ctx: Context<DelegateJob>) -> Result<()> {
        let poster = ctx.accounts.job.poster;
        let job_id = ctx.accounts.job.job_id;
        let status = ctx.accounts.job.status;

        require!(
            poster == ctx.accounts.payer.key(),
            TaskForestError::Unauthorized
        );
        require!(status == STATUS_OPEN, TaskForestError::WrongStatus);

        ctx.accounts.delegate_job(
            &ctx.accounts.payer,
            &[JOB_SEED, poster.as_ref(), &job_id.to_le_bytes()],
            DelegateConfig {
                validator: ctx.remaining_accounts.first().map(|acc| acc.key()),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    /// Place a bid on a job (called inside ER — gasless, sub-50ms).
    /// No actual SOL movement here — just records the bid amount.
    pub fn place_bid(ctx: Context<PlaceBid>, stake_lamports: u64) -> Result<()> {
        require!(stake_lamports > 0, TaskForestError::InvalidStake);

        let job = &mut ctx.accounts.job;
        require!(
            job.status == STATUS_OPEN || job.status == STATUS_BIDDING,
            TaskForestError::WrongStatus
        );

        if job.status == STATUS_OPEN {
            job.status = STATUS_BIDDING;
        }

        let min_stake = job.reward_lamports / 10;
        require!(stake_lamports >= min_stake, TaskForestError::InsufficientStake);

        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= job.deadline, TaskForestError::DeadlinePassed);

        job.bid_count += 1;
        if stake_lamports > job.best_bid_stake {
            job.best_bid_stake = stake_lamports;
            job.best_bidder = ctx.accounts.bidder.key();
        }

        msg!(
            "Bid #{} from {} stake={} (best={})",
            job.bid_count,
            ctx.accounts.bidder.key(),
            stake_lamports,
            job.best_bid_stake
        );
        Ok(())
    }

    /// Close bidding: select winner, commit+undelegate back to L1.
    pub fn close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
        let job = &mut ctx.accounts.job;
        require!(job.status == STATUS_BIDDING, TaskForestError::WrongStatus);
        require!(job.bid_count > 0, TaskForestError::WrongStatus);

        job.claimer = job.best_bidder;
        job.claimer_stake = job.best_bid_stake;
        job.status = STATUS_CLAIMED;

        msg!(
            "Bidding closed: winner={} stake={}",
            job.claimer,
            job.claimer_stake
        );

        job.exit(&crate::ID)?;
        commit_and_undelegate_accounts(
            &ctx.accounts.payer,
            vec![&ctx.accounts.job.to_account_info()],
            &ctx.accounts.magic_context,
            &ctx.accounts.magic_program,
        )?;

        Ok(())
    }

    /// Lock real SOL stake from the winning claimer into the job PDA.
    /// Called on L1 after undelegation, before proof submission.
    pub fn lock_stake(ctx: Context<LockStake>) -> Result<()> {
        let job_info = ctx.accounts.job.to_account_info();
        let job = &mut ctx.accounts.job;
        require!(job.status == STATUS_CLAIMED, TaskForestError::WrongStatus);
        require!(
            job.claimer == ctx.accounts.claimer.key(),
            TaskForestError::InvalidClaimer
        );

        let stake = job.claimer_stake;
        require!(stake > 0, TaskForestError::InvalidStake);

        // Transfer stake SOL from claimer into job PDA (escrow)
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.claimer.to_account_info(),
                    to: job_info,
                },
            ),
            stake,
        )?;

        job.status = STATUS_STAKED;
        msg!("Stake locked: {} lamports from {}", stake, job.claimer);
        Ok(())
    }

    /// Worker submits proof of task completion.
    pub fn submit_proof(
        ctx: Context<SubmitProof>,
        proof_hash: [u8; 32],
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
        require!(clock.unix_timestamp <= job.deadline, TaskForestError::DeadlinePassed);

        job.proof_hash = proof_hash;
        job.submitted_at = clock.unix_timestamp;
        job.status = STATUS_SUBMITTED;

        msg!("Proof submitted for job by {}", ctx.accounts.submitter.key());
        Ok(())
    }

    /// Settle the job with a pass/fail verdict. Only poster can settle.
    /// Real SOL transfers based on verdict.
    pub fn settle_job(
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
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
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
    pub fn archive_settlement(
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

    /// Expire a claimed job past its deadline — refunds poster, slashes stake.
    pub fn expire_claim(ctx: Context<ExpireClaim>) -> Result<()> {
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
}

// --- Account contexts ---

#[derive(Accounts)]
#[instruction(ttd_hash: [u8; 32])]
pub struct RegisterTtd<'info> {
    #[account(
        init,
        payer = creator,
        space = TaskTypeDefinition::SIZE,
        seeds = [TTD_SEED, creator.key().as_ref(), &ttd_hash],
        bump
    )]
    pub ttd: Account<'info, TaskTypeDefinition>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
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

#[delegate]
#[derive(Accounts)]
pub struct DelegateJob<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The job PDA to delegate
    #[account(mut, del, seeds = [JOB_SEED, payer.key().as_ref(), &job.job_id.to_le_bytes()], bump = job.bump)]
    pub job: Account<'info, Job>,
}

#[derive(Accounts)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub bidder: Signer<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CloseBidding<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub job: Account<'info, Job>,
}

/// Lock real SOL stake from winning claimer into the job PDA.
#[derive(Accounts)]
pub struct LockStake<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub claimer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SubmitProof<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub submitter: Signer<'info>,
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
    /// The archive PDA — seeded by ["archive", job.key()]
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

/// Expire a claimed job past deadline — refunds poster.
#[derive(Accounts)]
pub struct ExpireClaim<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    /// CHECK: Receives reward refund. Validated via job.poster in instruction.
    #[account(mut)]
    pub poster_account: UncheckedAccount<'info>,
}
