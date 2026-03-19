use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Job {
    pub poster: Pubkey,                  // 32
    pub job_id: u64,                     // 8
    pub reward_lamports: u64,            // 8
    pub deadline: i64,                   // 8
    pub proof_spec_hash: [u8; 32],       // 32
    pub ttd_hash: [u8; 32],              // 32
    pub privacy_level: u8,               // 1  — 0=public, 1=encrypted, 2=per
    pub encryption_pubkey: [u8; 32],     // 32 — poster's X25519 pubkey for encrypted jobs
    pub encrypted_input_hash: [u8; 32],  // 32 — hash of encrypted input (IPFS CID)
    pub encrypted_output_hash: [u8; 32], // 32 — hash of encrypted output
    pub status: u8,                      // 1
    pub claimer: Pubkey,                 // 32
    pub claimer_stake: u64,              // 8
    pub best_bid_stake: u64,             // 8
    pub best_bidder: Pubkey,             // 32
    pub bid_count: u32,                  // 4
    pub proof_hash: [u8; 32],            // 32
    pub submitted_at: i64,               // 8
    pub assignment_mode: u8,             // 1 — 0=auction, 1=auto-match
    pub parent_job: Pubkey,              // 32 — Pubkey::default() if root job
    pub sub_job_count: u16,              // 2
    pub verification_level: u8,          // 1 — 0-4
    pub receipt_root: [u8; 32],          // 32 — Merkle root of execution DAG
    pub receipt_uri: [u8; 32],           // 32 — hash of URI where full DAG stored
    pub attestation_hash: [u8; 32],      // 32 — TEE attestation hash
    pub dispute_window_end: i64,         // 8 — when dispute window closes (0 = no window)
    pub bump: u8,                        // 1
}

impl Job {
    pub const SIZE: usize = 8
        + 32
        + 8
        + 8
        + 8
        + 32
        + 32
        + 1
        + 32
        + 32
        + 32
        + 1
        + 32
        + 8
        + 8
        + 32
        + 4
        + 32
        + 8
        + 1
        + 32
        + 2
        + 1
        + 32
        + 32
        + 32
        + 8
        + 1;
}
