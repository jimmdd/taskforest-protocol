use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::*;
use crate::state::*;

/// Store an encrypted credential hash in the vault (actual credential off-chain).
/// Vault PDA is delegated to PER alongside job for access during execution.
pub fn handler_store_credential(
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
pub fn handler_clear_credential(ctx: Context<ClearCredential>) -> Result<()> {
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
