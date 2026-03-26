use anchor_lang::prelude::*;
use light_sdk::{
    account::LightAccount,
    cpi::{
        v2::{CpiAccounts as LightCpiAccounts, LightSystemProgramCpi},
        InvokeLightSystemProgram, LightCpiInstruction,
    },
    instruction::{PackedAddressTreeInfo, ValidityProof},
};

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Archive settlement to a compressed account (rent-free via Light Protocol).
pub fn handler_archive_settlement_compressed<'info>(
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
        crate::constants::LIGHT_CPI_SIGNER,
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
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
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
pub fn handler_init_agent_reputation<'info>(
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
        crate::constants::LIGHT_CPI_SIGNER,
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
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
        .invoke(light_cpi_accounts)
        .map_err(|_| TaskForestError::WrongStatus)?;

    msg!("Agent reputation initialized for {}", agent_key);
    Ok(())
}

pub fn handler_init_poster_reputation<'info>(
    ctx: Context<'_, '_, '_, 'info, PosterReputationAccounts<'info>>,
    proof: ValidityProof,
    address_tree_info: PackedAddressTreeInfo,
    output_state_tree_index: u8,
    tasks_posted: u32,
    tasks_settled_pass: u32,
    tasks_settled_fail: u32,
    disputes_initiated: u32,
    disputes_won: u32,
    total_spent: u64,
    avg_settle_secs: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    let light_cpi_accounts = LightCpiAccounts::new(
        ctx.accounts.signer.as_ref(),
        ctx.remaining_accounts,
        crate::constants::LIGHT_CPI_SIGNER,
    );

    let poster_key = ctx.accounts.signer.key();
    let (address, address_seed) = light_sdk::address::v1::derive_address(
        &[b"poster_reputation", poster_key.as_ref()],
        &address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
        &crate::ID,
    );

    let mut reputation = LightAccount::<PosterReputation>::new_init(
        &crate::ID,
        Some(address),
        output_state_tree_index,
    );
    reputation.poster = poster_key;
    reputation.tasks_posted = tasks_posted;
    reputation.tasks_settled_pass = tasks_settled_pass;
    reputation.tasks_settled_fail = tasks_settled_fail;
    reputation.disputes_initiated = disputes_initiated;
    reputation.disputes_won = disputes_won;
    reputation.total_spent = total_spent;
    reputation.avg_settle_secs = avg_settle_secs;
    reputation.last_active = clock.unix_timestamp;

    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(reputation)
        .map_err(|_| TaskForestError::WrongStatus)?
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
        .invoke(light_cpi_accounts)
        .map_err(|_| TaskForestError::WrongStatus)?;

    msg!("Poster reputation initialized for {}", poster_key);
    Ok(())
}

/// Register a TTD to the compressed registry (rent-free).
pub fn handler_register_ttd_compressed<'info>(
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
        crate::constants::LIGHT_CPI_SIGNER,
    );

    let creator_key = ctx.accounts.signer.key();
    let (address, address_seed) = light_sdk::address::v1::derive_address(
        &[b"compressed_ttd", creator_key.as_ref(), &ttd_hash],
        &address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
        &crate::ID,
    );

    let mut ttd =
        LightAccount::<CompressedTtd>::new_init(&crate::ID, Some(address), output_state_tree_index);
    ttd.creator = creator_key;
    ttd.ttd_hash = ttd_hash;
    ttd.ttd_uri_hash = ttd_uri_hash;
    ttd.version = version;
    ttd.created_at = clock.unix_timestamp;

    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(ttd)
        .map_err(|_| TaskForestError::WrongStatus)?
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
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
pub fn handler_compress_finished_job<'info>(
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
        crate::constants::LIGHT_CPI_SIGNER,
    );

    let job_key = ctx.accounts.job.key();
    let (address, address_seed) = light_sdk::address::v1::derive_address(
        &[b"compressed_job", job_key.as_ref()],
        &address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
        &crate::ID,
    );

    let mut compressed =
        LightAccount::<CompressedJob>::new_init(&crate::ID, Some(address), output_state_tree_index);
    compressed.poster = job.poster;
    compressed.job_id = job.job_id;
    compressed.reward_lamports = job.reward_lamports;
    compressed.deadline = job.deadline;
    compressed.spec_hash = job.spec_hash;
    compressed.ttd_hash = job.ttd_hash;
    compressed.assignment_mode = job.assignment_mode;
    compressed.parent_job = job.parent_job;
    compressed.verification_level = job.verification_level;
    compressed.verification_mode = job.verification_mode;
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
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
        .invoke(light_cpi_accounts)
        .map_err(|_| TaskForestError::WrongStatus)?;

    // Close the Job PDA - transfer all lamports back to poster (rent reclaim)
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

#[derive(Accounts)]
pub struct PosterReputationAccounts<'info> {
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
    /// The poster who created the job - receives rent refund.
    #[account(mut)]
    pub poster: Signer<'info>,
    /// The finished Job PDA to compress and close.
    #[account(mut, has_one = poster)]
    pub job: Account<'info, Job>,
}
