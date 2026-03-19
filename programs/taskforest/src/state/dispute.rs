use anchor_lang::prelude::*;

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

#[account]
#[derive(Default)]
pub struct VerifierVote {
    pub dispute: Pubkey,
    pub verifier: Pubkey,
    pub verdict: u8,
    pub voted_at: i64,
    pub bump: u8,
}

impl VerifierVote {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 1;
}
