use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk::LightDiscriminator;

/// Compressed Settlement Archive — rent-free, stored as Merkle leaf.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedArchive {
    pub job: Pubkey,           // 32
    pub poster: Pubkey,        // 32
    pub claimer: Pubkey,       // 32
    pub reward_lamports: u64,  // 8
    pub claimer_stake: u64,    // 8
    pub verdict: u8,           // 1 (0=fail, 1=pass)
    pub proof_hash: [u8; 32],  // 32
    pub reason_code: [u8; 32], // 32
    pub settled_at: i64,       // 8
}

/// Compressed Agent Reputation — rent-free on-chain track record.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct AgentReputation {
    pub agent: Pubkey,        // 32
    pub tasks_completed: u32, // 4
    pub tasks_failed: u32,    // 4
    pub total_earned: u64,    // 8
    pub total_staked: u64,    // 8
    pub last_active: i64,     // 8
}

/// Compressed TTD Registry entry — rent-free schema registration.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedTtd {
    pub creator: Pubkey,        // 32
    pub ttd_hash: [u8; 32],     // 32
    pub ttd_uri_hash: [u8; 32], // 32 — hash of URI (URI stored off-chain)
    pub version: u16,           // 2
    pub created_at: i64,        // 8
}

/// Compressed Job — finished job data stored rent-free after settlement.
/// The original Job PDA is closed and rent reclaimed by the poster.
#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedJob {
    pub poster: Pubkey,             // 32
    pub job_id: u64,                // 8
    pub reward_lamports: u64,       // 8
    pub deadline: i64,              // 8
    pub spec_hash: [u8; 32],        // 32
    pub ttd_hash: [u8; 32],         // 32
    pub assignment_mode: u8,        // 1
    pub parent_job: Pubkey,         // 32
    pub verification_level: u8,     // 1
    pub verification_mode: u8,      // 1
    pub receipt_root: [u8; 32],     // 32
    pub attestation_hash: [u8; 32], // 32
    pub privacy_level: u8,          // 1
    pub status: u8,                 // 1
    pub claimer: Pubkey,            // 32
    pub claimer_stake: u64,         // 8
    pub proof_hash: [u8; 32],       // 32
    pub submitted_at: i64,          // 8
    pub compressed_at: i64,         // 8 — when this was compressed
}

#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct PosterReputation {
    pub poster: Pubkey,          // 32
    pub tasks_posted: u32,       // 4
    pub tasks_settled_pass: u32, // 4
    pub tasks_settled_fail: u32, // 4
    pub disputes_initiated: u32, // 4
    pub disputes_won: u32,       // 4
    pub total_spent: u64,        // 8
    pub avg_settle_secs: u64,    // 8
    pub last_active: i64,        // 8
}
