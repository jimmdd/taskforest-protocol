use anchor_lang::prelude::*;
use light_sdk::{cpi::CpiSigner, derive_light_cpi_signer};

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const PERMISSION_PROGRAM_ID: Pubkey = pubkey!("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");
pub const DEVNET_TEE_VALIDATOR: Pubkey = pubkey!("FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA");
pub const MAINNET_TEE_VALIDATOR: Pubkey = pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
pub const LOCALNET_TEE_VALIDATOR: Pubkey = pubkey!("7XRXX7C2vtLJE6A8tTtcR4QEH9FtsC4K3CXL8jCTAK7n");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs");
