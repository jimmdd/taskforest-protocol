use anchor_lang::prelude::*;
use light_sdk::{cpi::CpiSigner, derive_light_cpi_signer};

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const PERMISSION_PROGRAM_ID: Pubkey = pubkey!("ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1");

pub const LIGHT_CPI_SIGNER: CpiSigner =
    derive_light_cpi_signer!("DFpay111111111111111111111111111111111111111");
