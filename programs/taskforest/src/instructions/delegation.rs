use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Delegate job PDA to an Ephemeral Rollup for real-time bidding.
pub fn handler_delegate_job(ctx: Context<DelegateJob>) -> Result<()> {
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

#[delegate]
#[derive(Accounts)]
pub struct DelegateJob<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The job PDA to delegate
    #[account(mut, del, seeds = [JOB_SEED, payer.key().as_ref(), &job.job_id.to_le_bytes()], bump = job.bump)]
    pub job: Account<'info, Job>,
}
