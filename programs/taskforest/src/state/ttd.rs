use anchor_lang::prelude::*;

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
