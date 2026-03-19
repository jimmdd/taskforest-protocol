use anchor_lang::prelude::*;

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
