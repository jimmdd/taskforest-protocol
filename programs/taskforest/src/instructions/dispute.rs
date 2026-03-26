use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

pub fn handler_open_dispute(
    ctx: Context<OpenDispute>,
    disputed_thread: u32,
    challenger_receipt_hash: [u8; 32],
    evidence_uri: [u8; 32],
) -> Result<()> {
    let job = &mut ctx.accounts.job;
    require!(job.status == STATUS_SUBMITTED, TaskForestError::WrongStatus);
    require!(
        job.dispute_window_end > 0,
        TaskForestError::DisputeWindowExpired
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < job.dispute_window_end,
        TaskForestError::DisputeWindowExpired
    );
    require!(
        ctx.accounts.challenger.key() != job.claimer,
        TaskForestError::InvalidClaimer
    );

    let stake_lamports = job.reward_lamports / 10;
    require!(
        stake_lamports >= job.reward_lamports / 10,
        TaskForestError::DisputeStakeTooLow
    );

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.challenger.to_account_info(),
                to: ctx.accounts.dispute.to_account_info(),
            },
        ),
        stake_lamports,
    )?;

    let dispute = &mut ctx.accounts.dispute;
    dispute.job = job.key();
    dispute.spec_hash = job.spec_hash;
    dispute.challenger = ctx.accounts.challenger.key();
    dispute.challenger_stake = stake_lamports;
    dispute.disputed_thread = disputed_thread;
    dispute.challenger_receipt_hash = challenger_receipt_hash;
    dispute.original_receipt_hash = job.receipt_root;
    dispute.status = 0;
    dispute.evidence_uri = evidence_uri;
    dispute.opened_at = clock.unix_timestamp;
    dispute.resolved_at = 0;
    dispute.bump = ctx.bumps.dispute;

    msg!(
        "Dispute opened: job={} thread={} challenger={}",
        job.key(),
        disputed_thread,
        ctx.accounts.challenger.key()
    );
    Ok(())
}

pub fn handler_resolve_dispute(ctx: Context<ResolveDispute>, verdict: u8) -> Result<()> {
    let job = &mut ctx.accounts.job;
    let dispute = &mut ctx.accounts.dispute;

    require!(dispute.status == 0, TaskForestError::InvalidDisputeStatus);
    require!(
        verdict == 1 || verdict == 2,
        TaskForestError::InvalidVerdict
    );
    require!(
        job.poster == ctx.accounts.resolver.key(),
        TaskForestError::Unauthorized
    );
    require!(dispute.job == job.key(), TaskForestError::Unauthorized);
    require!(
        dispute.challenger == ctx.accounts.challenger_account.key(),
        TaskForestError::Unauthorized
    );

    let dispute_info = dispute.to_account_info();
    let job_info = job.to_account_info();

    if verdict == 1 {
        let dispute_lamports = dispute_info.lamports();
        let dispute_rent = Rent::get()?.minimum_balance(DisputeRecord::SIZE);
        let dispute_available = dispute_lamports.saturating_sub(dispute_rent);
        let transfer_amount = dispute.challenger_stake.min(dispute_available);

        if transfer_amount > 0 {
            **dispute_info.try_borrow_mut_lamports()? -= transfer_amount;
            **job_info.try_borrow_mut_lamports()? += transfer_amount;
        }

        dispute.status = 1;
    } else {
        let dispute_lamports = dispute_info.lamports();
        let dispute_rent = Rent::get()?.minimum_balance(DisputeRecord::SIZE);
        let dispute_available = dispute_lamports.saturating_sub(dispute_rent);
        let refund_amount = dispute.challenger_stake.min(dispute_available);

        if refund_amount > 0 {
            **dispute_info.try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.challenger_account.try_borrow_mut_lamports()? += refund_amount;
        }

        let job_lamports = job_info.lamports();
        let job_rent = Rent::get()?.minimum_balance(Job::SIZE);
        let job_available = job_lamports.saturating_sub(job_rent);
        let penalty_amount = job.claimer_stake.min(job_available);

        if penalty_amount > 0 {
            **job_info.try_borrow_mut_lamports()? -= penalty_amount;
            **ctx.accounts.challenger_account.try_borrow_mut_lamports()? += penalty_amount;
        }

        job.status = STATUS_FAILED;
        dispute.status = 2;
    }

    dispute.resolved_at = Clock::get()?.unix_timestamp;
    msg!("Dispute resolved: verdict={} job={}", verdict, job.key());
    Ok(())
}

pub fn handler_cast_vote(ctx: Context<CastVote>, verdict: u8) -> Result<()> {
    let dispute = &ctx.accounts.dispute;
    require!(dispute.status == 0, TaskForestError::InvalidDisputeStatus);
    require!(
        verdict == 1 || verdict == 2,
        TaskForestError::InvalidVerdict
    );

    let vote = &mut ctx.accounts.vote;
    vote.dispute = dispute.key();
    vote.verifier = ctx.accounts.verifier.key();
    vote.verdict = verdict;
    vote.voted_at = Clock::get()?.unix_timestamp;
    vote.bump = ctx.bumps.vote;

    msg!(
        "Vote cast: verifier={} verdict={} dispute={}",
        vote.verifier,
        vote.verdict,
        vote.dispute
    );
    Ok(())
}

pub fn handler_tally_panel(ctx: Context<TallyPanel>) -> Result<()> {
    let job = &mut ctx.accounts.job;
    let dispute = &mut ctx.accounts.dispute;

    require!(dispute.status == 0, TaskForestError::InvalidDisputeStatus);
    require!(dispute.job == job.key(), TaskForestError::Unauthorized);
    require!(
        dispute.challenger == ctx.accounts.challenger_account.key(),
        TaskForestError::Unauthorized
    );

    let mut agent_wins_count: u8 = 0;
    let mut challenger_wins_count: u8 = 0;

    for account_info in ctx.remaining_accounts.iter() {
        let data = account_info.try_borrow_data()?;
        let mut data_slice: &[u8] = &data;
        if let Ok(vote) = VerifierVote::try_deserialize(&mut data_slice) {
            if vote.dispute == dispute.key() {
                if vote.verdict == 1 {
                    agent_wins_count = agent_wins_count.saturating_add(1);
                } else if vote.verdict == 2 {
                    challenger_wins_count = challenger_wins_count.saturating_add(1);
                }
            }
        }
    }

    let total_votes = agent_wins_count.saturating_add(challenger_wins_count);
    require!(
        total_votes >= PANEL_QUORUM,
        TaskForestError::QuorumNotReached
    );

    let dispute_info = dispute.to_account_info();
    let job_info = job.to_account_info();

    let verdict = if agent_wins_count > challenger_wins_count {
        let dispute_lamports = dispute_info.lamports();
        let dispute_rent = Rent::get()?.minimum_balance(DisputeRecord::SIZE);
        let dispute_available = dispute_lamports.saturating_sub(dispute_rent);
        let transfer_amount = dispute.challenger_stake.min(dispute_available);

        if transfer_amount > 0 {
            **dispute_info.try_borrow_mut_lamports()? -= transfer_amount;
            **job_info.try_borrow_mut_lamports()? += transfer_amount;
        }

        dispute.status = 1;
        1u8
    } else {
        let dispute_lamports = dispute_info.lamports();
        let dispute_rent = Rent::get()?.minimum_balance(DisputeRecord::SIZE);
        let dispute_available = dispute_lamports.saturating_sub(dispute_rent);
        let refund_amount = dispute.challenger_stake.min(dispute_available);

        if refund_amount > 0 {
            **dispute_info.try_borrow_mut_lamports()? -= refund_amount;
            **ctx.accounts.challenger_account.try_borrow_mut_lamports()? += refund_amount;
        }

        let job_lamports = job_info.lamports();
        let job_rent = Rent::get()?.minimum_balance(Job::SIZE);
        let job_available = job_lamports.saturating_sub(job_rent);
        let penalty_amount = job.claimer_stake.min(job_available);

        if penalty_amount > 0 {
            **job_info.try_borrow_mut_lamports()? -= penalty_amount;
            **ctx.accounts.challenger_account.try_borrow_mut_lamports()? += penalty_amount;
        }

        job.status = STATUS_FAILED;
        dispute.status = 2;
        2u8
    };

    dispute.resolved_at = Clock::get()?.unix_timestamp;
    msg!(
        "Panel tally: agent_votes={} challenger_votes={} verdict={}",
        agent_wins_count,
        challenger_wins_count,
        verdict
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(disputed_thread: u32)]
pub struct OpenDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(
        init,
        payer = challenger,
        space = DisputeRecord::SIZE,
        seeds = [DISPUTE_SEED, job.key().as_ref(), &disputed_thread.to_le_bytes()],
        bump
    )]
    pub dispute: Account<'info, DisputeRecord>,
    #[account(mut)]
    pub challenger: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub dispute: Account<'info, DisputeRecord>,
    pub resolver: Signer<'info>,
    /// CHECK: Receives stake refund on challenger_wins. Validated via dispute.challenger.
    #[account(mut)]
    pub challenger_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CastVote<'info> {
    pub dispute: Account<'info, DisputeRecord>,
    #[account(
        init,
        payer = verifier,
        space = VerifierVote::SIZE,
        seeds = [VOTE_SEED, dispute.key().as_ref(), verifier.key().as_ref()],
        bump
    )]
    pub vote: Account<'info, VerifierVote>,
    #[account(mut)]
    pub verifier: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TallyPanel<'info> {
    #[account(mut)]
    pub job: Account<'info, Job>,
    #[account(mut)]
    pub dispute: Account<'info, DisputeRecord>,
    pub resolver: Signer<'info>,
    /// CHECK: Receives stake on challenger_wins. Validated via dispute.challenger.
    #[account(mut)]
    pub challenger_account: UncheckedAccount<'info>,
}
