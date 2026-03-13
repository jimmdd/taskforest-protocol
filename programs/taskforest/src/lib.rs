use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

// ZK Compression (Light Protocol v2)
use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk::address::v1::derive_address;
use light_sdk::{
    account::LightAccount,
    cpi::{
        v2::{CpiAccounts as LightCpiAccounts, LightSystemProgramCpi},
        CpiSigner, InvokeLightSystemProgram, LightCpiInstruction,
    },
    derive_light_cpi_signer,
    instruction::{PackedAddressTreeInfo, ValidityProof},
    LightDiscriminator,
};

declare_id!("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");

/// CPI signer for Light System Program compressed account operations.
pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");

pub const JOB_SEED: &[u8] = b"job";
pub const BID_SEED: &[u8] = b"bid";
pub const ARCHIVE_SEED: &[u8] = b"archive";
pub const TTD_SEED: &[u8] = b"ttd";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DISPUTE_SEED: &[u8] = b"dispute";

// --- Status byte constants ---
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_BIDDING: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2; // winner selected, needs lock_stake
pub const STATUS_STAKED: u8 = 6; // stake locked, ready for proof
pub const STATUS_VERIFIED: u8 = 7;
pub const STATUS_SUBMITTED: u8 = 3; // proof submitted, awaiting settlement
pub const STATUS_DONE: u8 = 4; // settled PASS
pub const STATUS_FAILED: u8 = 5; // settled FAIL or expired

// --- Privacy levels ---
pub const PRIVACY_PUBLIC: u8 = 0;
pub const PRIVACY_ENCRYPTED: u8 = 1;
pub const PRIVACY_PER: u8 = 2;

/// Review period: poster has 1 hour after proof submission to settle.
/// If they don't, worker can call claim_timeout to auto-win.
pub const REVIEW_PERIOD_SECS: i64 = 3600;
pub const DISPUTE_WINDOW_SECS: i64 = 86400;

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
    #[msg("Job is not in auto-match mode")]
    NotAutoMatch,
    #[msg("Insufficient escrow for sub-job")]
    InsufficientEscrowForSubJob,
    #[msg("Sub-job reward exceeds remaining escrow")]
    SubJobExceedsEscrow,
    #[msg("Dispute window has not ended")]
    DisputeWindowActive,
    #[msg("Dispute window has ended")]
    DisputeWindowExpired,
    #[msg("Dispute stake too low")]
    DisputeStakeTooLow,
    #[msg("Invalid dispute status")]
    InvalidDisputeStatus,
}

// --- Account structs ---

#[account]
#[derive(Default)]
pub struct Job {
    pub poster: Pubkey,                  // 32
    pub job_id: u64,                     // 8
    pub reward_lamports: u64,            // 8
    pub deadline: i64,                   // 8
    pub proof_spec_hash: [u8; 32],       // 32
    pub ttd_hash: [u8; 32],              // 32
    pub privacy_level: u8,               // 1  — 0=public, 1=encrypted, 2=per
    pub encryption_pubkey: [u8; 32],     // 32 — poster's X25519 pubkey for encrypted jobs
    pub encrypted_input_hash: [u8; 32],  // 32 — hash of encrypted input (IPFS CID)
    pub encrypted_output_hash: [u8; 32], // 32 — hash of encrypted output
    pub status: u8,                      // 1
    pub claimer: Pubkey,                 // 32
    pub claimer_stake: u64,              // 8
    pub best_bid_stake: u64,             // 8
    pub best_bidder: Pubkey,             // 32
    pub bid_count: u32,                  // 4
    pub proof_hash: [u8; 32],            // 32
    pub submitted_at: i64,               // 8
    pub assignment_mode: u8,             // 1 — 0=auction, 1=auto-match
    pub parent_job: Pubkey,              // 32 — Pubkey::default() if root job
    pub sub_job_count: u16,              // 2
    pub verification_level: u8,          // 1 — 0-4
    pub receipt_root: [u8; 32],          // 32 — Merkle root of execution DAG
    pub receipt_uri: [u8; 32],           // 32 — hash of URI where full DAG stored
    pub attestation_hash: [u8; 32],      // 32 — TEE attestation hash
    pub dispute_window_end: i64,         // 8 — when dispute window closes (0 = no window)
    pub bump: u8,                        // 1
}

impl Job {
    // Updated size with privacy fields: +1 (privacy_level) +32 (encryption_pubkey) +32 (encrypted_input_hash) +32 (encrypted_output_hash)
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + 8
        + 32
        + 32
        + 1
        + 32
        + 32
        + 32
        + 1
        + 32
        + 8
        + 8
        + 32
        + 4
        + 32
        + 8
        + 1
        + 32
        + 2
        + 1
        + 32
        + 32
        + 32
        + 8
        + 1;
}

/// Credential Vault — encrypted credentials accessible only inside PER.
#[account]
pub struct CredentialVault {
    pub poster: Pubkey,                // 32 — who created this vault
    pub job: Pubkey,                   // 32 — associated job
    pub encrypted_cred_hash: [u8; 32], // 32 — hash of encrypted credential (stored off-chain)
    pub is_active: bool,               // 1  — cleared after job settles
    pub bump: u8,                      // 1
}

impl CredentialVault {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 1 + 1;
}

/// Task Type Definition — registered on-chain schema for typed agent tasks.
#[account]
pub struct TaskTypeDefinition {
    pub creator: Pubkey,    // 32 — who registered this TTD
    pub ttd_hash: [u8; 32], // 32 — SHA-256 of the full TTD JSON
    pub ttd_uri: String,    // 4 + len — where to fetch it (IPFS/R2/Arweave)
    pub version: u16,       // 2  — version number
    pub created_at: i64,    // 8
    pub bump: u8,           // 1
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
    pub job: Pubkey,           // 32 — the job PDA key
    pub poster: Pubkey,        // 32
    pub claimer: Pubkey,       // 32
    pub reward_lamports: u64,  // 8
    pub claimer_stake: u64,    // 8
    pub verdict: u8,           // 1 (0=fail, 1=pass)
    pub proof_hash: [u8; 32],  // 32
    pub reason_code: [u8; 32], // 32
    pub settled_at: i64,       // 8
    pub bump: u8,              // 1
}

impl SettlementArchive {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1 + 32 + 32 + 8 + 1;
}

#[account]
#[derive(Default)]
pub struct DisputeRecord {
    pub job: Pubkey,                       // 32
    pub challenger: Pubkey,                // 32
    pub challenger_stake: u64,             // 8
    pub disputed_thread: u32,              // 4
    pub challenger_receipt_hash: [u8; 32], // 32
    pub original_receipt_hash: [u8; 32],   // 32
    pub status: u8,                        // 1 — 0=open, 1=agent_wins, 2=challenger_wins
    pub evidence_uri: [u8; 32],            // 32
    pub opened_at: i64,                    // 8
    pub resolved_at: i64,                  // 8
    pub bump: u8,                          // 1
}

impl DisputeRecord {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 4 + 32 + 32 + 1 + 32 + 8 + 8 + 1;
}

// --- Compressed Account Structs (ZK Compression via Light Protocol) ---

/// Compressed Settlement Archive — rent-free, stored as Merkle leaf.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedArchive {
    pub job: Pubkey,           // 32
    pub poster: Pubkey,        // 32
    pub claimer: Pubkey,       // 32
    pub reward_lamports: u64,  // 8
    pub claimer_stake: u64,    // 8
    pub verdict: u8,           // 1 (0=fail, 1=pass)
    pub proof_hash: [u8; 32],  // 32
    pub reason_code: [u8; 32], // 32
    pub settled_at: i64,       // 8
}

/// Compressed Agent Reputation — rent-free on-chain track record.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct AgentReputation {
    pub agent: Pubkey,        // 32
    pub tasks_completed: u32, // 4
    pub tasks_failed: u32,    // 4
    pub total_earned: u64,    // 8
    pub total_staked: u64,    // 8
    pub last_active: i64,     // 8
}

/// Compressed TTD Registry entry — rent-free schema registration.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedTtd {
    pub creator: Pubkey,        // 32
    pub ttd_hash: [u8; 32],     // 32
    pub ttd_uri_hash: [u8; 32], // 32 — hash of URI (URI stored off-chain)
    pub version: u16,           // 2
    pub created_at: i64,        // 8
}

/// Compressed Job — finished job data stored rent-free after settlement.
/// The original Job PDA is closed and rent reclaimed by the poster.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedJob {
    pub poster: Pubkey,             // 32
    pub job_id: u64,                // 8
    pub reward_lamports: u64,       // 8
    pub deadline: i64,              // 8
    pub ttd_hash: [u8; 32],         // 32
    pub assignment_mode: u8,        // 1
    pub parent_job: Pubkey,         // 32
    pub verification_level: u8,     // 1
    pub receipt_root: [u8; 32],     // 32
    pub attestation_hash: [u8; 32], // 32
    pub privacy_level: u8,          // 1
    pub status: u8,                 // 1
    pub claimer: Pubkey,            // 32
    pub claimer_stake: u64,         // 8
    pub proof_hash: [u8; 32],       // 32
    pub submitted_at: i64,          // 8
    pub compressed_at: i64,         // 8 — when this was compressed
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
    /// privacy_level: 0=public, 1=encrypted, 2=per
    /// encryption_pubkey: poster's X25519 pubkey (all zeros for public jobs)
    pub fn initialize_job(
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

    pub fn auto_assign_job(ctx: Context<AutoAssignJob>, assigned_agent: Pubkey) -> Result<()> {
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

    pub fn create_sub_job(
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

    pub fn submit_verified_proof(
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

    pub fn auto_settle(ctx: Context<AutoSettle>) -> Result<()> {
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
        require!(
            stake_lamports >= min_stake,
            TaskForestError::InsufficientStake
        );

        let clock = Clock::get()?;
        require!(
            clock.unix_timestamp <= job.deadline,
            TaskForestError::DeadlinePassed
        );

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
    pub fn submit_proof(ctx: Context<SubmitProof>, proof_hash: [u8; 32]) -> Result<()> {
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

    /// Settle the job with a pass/fail verdict. Only poster can settle.
    /// Real SOL transfers based on verdict.
    pub fn settle_job(ctx: Context<SettleJob>, verdict: u8, _reason_code: [u8; 32]) -> Result<()> {
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

    /// Expire an unclaimed job past its deadline — refunds poster's escrowed SOL.
    /// Works for STATUS_OPEN and STATUS_BIDDING (no winner was selected).
    pub fn expire_unclaimed(ctx: Context<ExpireUnclaimed>) -> Result<()> {
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
    pub fn extend_deadline(ctx: Context<ExtendDeadline>, new_deadline: i64) -> Result<()> {
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

    /// Store an encrypted credential hash in the vault (actual credential off-chain).
    /// Vault PDA is delegated to PER alongside job for access during execution.
    pub fn store_credential(
        ctx: Context<StoreCredential>,
        encrypted_cred_hash: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.poster = ctx.accounts.poster.key();
        vault.job = ctx.accounts.job.key();
        vault.encrypted_cred_hash = encrypted_cred_hash;
        vault.is_active = true;
        vault.bump = ctx.bumps.vault;

        msg!(
            "Credential stored for job: hash={:?}",
            &encrypted_cred_hash[..4]
        );
        Ok(())
    }

    /// Clear credential vault after job settles.
    pub fn clear_credential(ctx: Context<ClearCredential>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            ctx.accounts.poster.key() == vault.poster,
            TaskForestError::Unauthorized
        );
        vault.is_active = false;
        vault.encrypted_cred_hash = [0u8; 32];
        msg!("Credential vault cleared");
        Ok(())
    }

    /// Submit encrypted proof — stores encrypted output hash on-chain.
    /// Actual encrypted output stored off-chain (IPFS).
    pub fn submit_encrypted_proof(
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

    // ===== ZK COMPRESSED INSTRUCTIONS =====

    /// Archive settlement to a compressed account (rent-free via Light Protocol).
    pub fn archive_settlement_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedArchiveAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        reason_code: [u8; 32],
    ) -> Result<()> {
        let job = &ctx.accounts.job;
        require!(
            job.status == STATUS_DONE || job.status == STATUS_FAILED,
            TaskForestError::WrongStatus
        );

        let verdict = if job.status == STATUS_DONE { 1u8 } else { 0u8 };
        let clock = Clock::get()?;

        let light_cpi_accounts = LightCpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let job_key = ctx.accounts.job.key();
        let (address, address_seed) = light_sdk::address::v1::derive_address(
            &[b"compressed_archive", job_key.as_ref()],
            &address_tree_info
                .get_tree_pubkey(&light_cpi_accounts)
                .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
            &crate::ID,
        );

        let mut archive = LightAccount::<CompressedArchive>::new_init(
            &crate::ID,
            Some(address),
            output_state_tree_index,
        );
        archive.job = job_key;
        archive.poster = job.poster;
        archive.claimer = job.claimer;
        archive.reward_lamports = job.reward_lamports;
        archive.claimer_stake = job.claimer_stake;
        archive.verdict = verdict;
        archive.proof_hash = job.proof_hash;
        archive.reason_code = reason_code;
        archive.settled_at = clock.unix_timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(archive)
            .map_err(|_| TaskForestError::WrongStatus)?
            .with_new_addresses(&[address_tree_info.into_new_address_params_assigned_packed(
                address_seed,
                Some(output_state_tree_index),
            )])
            .invoke(light_cpi_accounts)
            .map_err(|_| TaskForestError::WrongStatus)?;

        msg!(
            "Compressed archive created for job={} verdict={}",
            job_key,
            verdict
        );
        Ok(())
    }

    /// Update agent reputation with compressed account (rent-free).
    /// Creates new reputation on first call, updates existing on subsequent calls.
    pub fn init_agent_reputation<'info>(
        ctx: Context<'_, '_, '_, 'info, AgentReputationAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        tasks_completed: u32,
        tasks_failed: u32,
        total_earned: u64,
        total_staked: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;

        let light_cpi_accounts = LightCpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let agent_key = ctx.accounts.signer.key();
        let (address, address_seed) = light_sdk::address::v1::derive_address(
            &[b"agent_reputation", agent_key.as_ref()],
            &address_tree_info
                .get_tree_pubkey(&light_cpi_accounts)
                .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
            &crate::ID,
        );

        let mut reputation = LightAccount::<AgentReputation>::new_init(
            &crate::ID,
            Some(address),
            output_state_tree_index,
        );
        reputation.agent = agent_key;
        reputation.tasks_completed = tasks_completed;
        reputation.tasks_failed = tasks_failed;
        reputation.total_earned = total_earned;
        reputation.total_staked = total_staked;
        reputation.last_active = clock.unix_timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(reputation)
            .map_err(|_| TaskForestError::WrongStatus)?
            .with_new_addresses(&[address_tree_info.into_new_address_params_assigned_packed(
                address_seed,
                Some(output_state_tree_index),
            )])
            .invoke(light_cpi_accounts)
            .map_err(|_| TaskForestError::WrongStatus)?;

        msg!("Agent reputation initialized for {}", agent_key);
        Ok(())
    }

    /// Register a TTD to the compressed registry (rent-free).
    pub fn register_ttd_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedTtdAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        ttd_hash: [u8; 32],
        ttd_uri_hash: [u8; 32],
        version: u16,
    ) -> Result<()> {
        let clock = Clock::get()?;

        let light_cpi_accounts = LightCpiAccounts::new(
            ctx.accounts.signer.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let creator_key = ctx.accounts.signer.key();
        let (address, address_seed) = light_sdk::address::v1::derive_address(
            &[b"compressed_ttd", creator_key.as_ref(), &ttd_hash],
            &address_tree_info
                .get_tree_pubkey(&light_cpi_accounts)
                .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
            &crate::ID,
        );

        let mut ttd = LightAccount::<CompressedTtd>::new_init(
            &crate::ID,
            Some(address),
            output_state_tree_index,
        );
        ttd.creator = creator_key;
        ttd.ttd_hash = ttd_hash;
        ttd.ttd_uri_hash = ttd_uri_hash;
        ttd.version = version;
        ttd.created_at = clock.unix_timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(ttd)
            .map_err(|_| TaskForestError::WrongStatus)?
            .with_new_addresses(&[address_tree_info.into_new_address_params_assigned_packed(
                address_seed,
                Some(output_state_tree_index),
            )])
            .invoke(light_cpi_accounts)
            .map_err(|_| TaskForestError::WrongStatus)?;

        msg!(
            "Compressed TTD registered: hash={:?} v={}",
            &ttd_hash[..4],
            version
        );
        Ok(())
    }

    /// Compress finished job data into a Merkle leaf and close the PDA to reclaim rent.
    /// Only callable after settlement (status = DONE or FAILED).
    pub fn compress_finished_job<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedJobAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
    ) -> Result<()> {
        let job = &ctx.accounts.job;
        require!(
            job.status == STATUS_DONE || job.status == STATUS_FAILED,
            TaskForestError::WrongStatus
        );

        let clock = Clock::get()?;

        let light_cpi_accounts = LightCpiAccounts::new(
            ctx.accounts.poster.as_ref(),
            ctx.remaining_accounts,
            crate::LIGHT_CPI_SIGNER,
        );

        let job_key = ctx.accounts.job.key();
        let (address, address_seed) = light_sdk::address::v1::derive_address(
            &[b"compressed_job", job_key.as_ref()],
            &address_tree_info
                .get_tree_pubkey(&light_cpi_accounts)
                .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
            &crate::ID,
        );

        let mut compressed = LightAccount::<CompressedJob>::new_init(
            &crate::ID,
            Some(address),
            output_state_tree_index,
        );
        compressed.poster = job.poster;
        compressed.job_id = job.job_id;
        compressed.reward_lamports = job.reward_lamports;
        compressed.deadline = job.deadline;
        compressed.ttd_hash = job.ttd_hash;
        compressed.assignment_mode = job.assignment_mode;
        compressed.parent_job = job.parent_job;
        compressed.verification_level = job.verification_level;
        compressed.receipt_root = job.receipt_root;
        compressed.attestation_hash = job.attestation_hash;
        compressed.privacy_level = job.privacy_level;
        compressed.status = job.status;
        compressed.claimer = job.claimer;
        compressed.claimer_stake = job.claimer_stake;
        compressed.proof_hash = job.proof_hash;
        compressed.submitted_at = job.submitted_at;
        compressed.compressed_at = clock.unix_timestamp;

        LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
            .with_light_account(compressed)
            .map_err(|_| TaskForestError::WrongStatus)?
            .with_new_addresses(&[address_tree_info.into_new_address_params_assigned_packed(
                address_seed,
                Some(output_state_tree_index),
            )])
            .invoke(light_cpi_accounts)
            .map_err(|_| TaskForestError::WrongStatus)?;

        // Close the Job PDA — transfer all lamports back to poster (rent reclaim)
        let job_account_info = ctx.accounts.job.to_account_info();
        let poster_account_info = ctx.accounts.poster.to_account_info();
        let job_lamports = job_account_info.lamports();

        **job_account_info.try_borrow_mut_lamports()? = 0;
        **poster_account_info.try_borrow_mut_lamports()? = poster_account_info
            .lamports()
            .checked_add(job_lamports)
            .ok_or(TaskForestError::WrongStatus)?;

        // Zero out the data to mark as closed
        job_account_info.data.borrow_mut().fill(0);

        msg!(
            "Job compressed & PDA closed: job={} reclaimed={} lamports",
            job_key,
            job_lamports
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

#[derive(Accounts)]
pub struct SubmitVerifiedProof<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    pub submitter: Signer<'info>,
}

#[derive(Accounts)]
pub struct AutoSettle<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub claimer: Signer<'info>,
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

/// Expire an unclaimed job past deadline — poster reclaims SOL.
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

/// Store encrypted credential in vault PDA.
#[derive(Accounts)]
pub struct StoreCredential<'info> {
    #[account(
        init,
        payer = poster,
        space = CredentialVault::SIZE,
        seeds = [VAULT_SEED, poster.key().as_ref(), job.key().as_ref()],
        bump
    )]
    pub vault: Account<'info, CredentialVault>,
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub poster: Signer<'info>,
    pub system_program: Program<'info, System>,
}

/// Clear credential vault after settlement.
#[derive(Accounts)]
pub struct ClearCredential<'info> {
    #[account(mut)]
    pub vault: Account<'info, CredentialVault>,
    pub poster: Signer<'info>,
}

// --- Compressed Account Contexts (ZK Compression) ---

/// Context for creating compressed settlement archive.
#[derive(Accounts)]
pub struct CompressedArchiveAccounts<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    /// The settled job to archive
    pub job: Account<'info, Job>,
}

/// Context for initializing/updating agent reputation.
#[derive(Accounts)]
pub struct AgentReputationAccounts<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
}

/// Context for registering compressed TTD.
#[derive(Accounts)]
pub struct CompressedTtdAccounts<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
}

/// Context for compressing finished job data and closing the PDA.
#[derive(Accounts)]
pub struct CompressedJobAccounts<'info> {
    /// The poster who created the job — receives rent refund.
    #[account(mut)]
    pub poster: Signer<'info>,
    /// The finished Job PDA to compress and close.
    #[account(mut, has_one = poster)]
    pub job: Account<'info, Job>,
}
