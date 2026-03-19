use anchor_lang::prelude::*;
use anchor_lang::system_program;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::ephem::commit_and_undelegate_accounts;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Place a bid on a job (called inside ER - gasless, sub-50ms).
/// No actual SOL movement here - just records the bid amount.
pub fn handler_place_bid(ctx: Context<PlaceBid>, stake_lamports: u64) -> Result<()> {
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
pub fn handler_close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
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
pub fn handler_lock_stake(ctx: Context<LockStake>) -> Result<()> {
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
