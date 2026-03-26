use anchor_lang::prelude::*;
use light_sdk::{
    account::LightAccount,
    cpi::{
        v2::{CpiAccounts as LightCpiAccounts, LightSystemProgramCpi},
        InvokeLightSystemProgram, LightCpiInstruction,
    },
    instruction::{PackedAddressTreeInfo, ValidityProof},
};

use crate::constants::*;
use crate::errors::TaskforestPaymentsError;
use crate::state::compressed::CompressedSettlement;
use crate::state::payment::EscrowWrapper;

pub fn handler_compress_settlement<'info>(
    ctx: Context<'_, '_, '_, 'info, CompressSettlementAccounts<'info>>,
    proof: ValidityProof,
    address_tree_info: PackedAddressTreeInfo,
    output_state_tree_index: u8,
    total_paid: u64,
) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let clock = Clock::get()?;
    msg!(
        "compress_settlement remaining_accounts={} root_index={} address_tree_index={} address_queue_index={} output_state_tree_index={}",
        ctx.remaining_accounts.len(),
        address_tree_info.root_index,
        address_tree_info.address_merkle_tree_pubkey_index,
        address_tree_info.address_queue_pubkey_index,
        output_state_tree_index,
    );

    let light_cpi_accounts = LightCpiAccounts::new(
        ctx.accounts.signer.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );

    let escrow_key = escrow.key();
    let (_address, address_seed) = light_sdk::address::v1::derive_address(
        &[b"compressed_settlement", escrow_key.as_ref()],
        &address_tree_info
            .get_tree_pubkey(&light_cpi_accounts)
            .map_err(|_| ErrorCode::AccountNotEnoughKeys)?,
        &crate::ID,
    );

    let mut compressed = LightAccount::<CompressedSettlement>::new_init(
        &crate::ID,
        Some(_address),
        output_state_tree_index,
    );
    compressed.escrow_id = escrow.escrow_id;
    compressed.job_pubkey = escrow.job_pubkey;
    compressed.poster = escrow.poster;
    compressed.agent = escrow.agent;
    compressed.total_deposited = escrow.deposited;
    compressed.total_paid = total_paid;
    compressed.settled_at = clock.unix_timestamp;
    compressed.mpp_session_id = escrow.mpp_session_id;

    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(compressed)
        .map_err(|_| TaskforestPaymentsError::CompressionFailed)?
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(0))])
        .invoke(light_cpi_accounts)
        .map_err(|_| TaskforestPaymentsError::CompressionFailed)?;

    msg!("Settlement compressed for escrow {}", escrow.escrow_id);
    Ok(())
}

#[derive(Accounts)]
pub struct CompressSettlementAccounts<'info> {
    pub escrow: Account<'info, EscrowWrapper>,
    #[account(mut)]
    pub signer: Signer<'info>,
}
