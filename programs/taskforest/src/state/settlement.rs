use anchor_lang::prelude::*;

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
