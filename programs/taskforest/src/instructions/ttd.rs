use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Register a Task Type Definition on-chain.
/// Anyone can register - open registry. TTD JSON stored off-chain at ttd_uri.
pub fn handler_register_ttd(
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
