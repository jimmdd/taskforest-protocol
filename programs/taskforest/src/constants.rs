use anchor_lang::prelude::*;
use light_sdk::{cpi::CpiSigner, derive_light_cpi_signer};

/// CPI signer for Light System Program compressed account operations.
pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");

// --- TEE Validators (PER bidding) ---
pub const DEVNET_TEE_VALIDATOR: Pubkey = pubkey!("FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA");
pub const MAINNET_TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
pub const LOCALNET_TEE_VALIDATOR: Pubkey = pubkey!("7XRXX7C2vtLJE6A8tTtcR4QEH9FtsC4K3CXL8jCTAK7n");

pub const JOB_SEED: &[u8] = b"job";
pub const BID_SEED: &[u8] = b"bid";
pub const ARCHIVE_SEED: &[u8] = b"archive";
pub const TTD_SEED: &[u8] = b"ttd";
pub const VAULT_SEED: &[u8] = b"vault";
pub const DISPUTE_SEED: &[u8] = b"dispute";
pub const VOTE_SEED: &[u8] = b"vote";
pub const PANEL_SIZE: u8 = 5;
pub const PANEL_QUORUM: u8 = 3;

// --- Status byte constants ---
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_BIDDING: u8 = 1;
pub const STATUS_CLAIMED: u8 = 2; // winner selected, needs lock_stake
pub const STATUS_STAKED: u8 = 6; // stake locked, ready for proof
pub const STATUS_VERIFIED: u8 = 7;
pub const STATUS_SUBMITTED: u8 = 3; // proof submitted, awaiting settlement
pub const STATUS_DONE: u8 = 4; // settled PASS
pub const STATUS_FAILED: u8 = 5; // settled FAIL or expired

// --- Privacy levels ---
pub const PRIVACY_PUBLIC: u8 = 0;
pub const PRIVACY_ENCRYPTED: u8 = 1;
pub const PRIVACY_PER: u8 = 2;

// --- Verification modes ---
pub const VERIFICATION_POSTER_REVIEW: u8 = 0;
pub const VERIFICATION_TEST_SUITE: u8 = 1;
pub const VERIFICATION_JUDGE: u8 = 2;

/// Review period: poster has 1 hour after proof submission to settle.
/// If they don't, worker can call claim_timeout to auto-win.
pub const REVIEW_PERIOD_SECS: i64 = 3600;
pub const DISPUTE_WINDOW_SECS: i64 = 86400;
