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
use crate::state::payment::PaymentChannel;

pub fn handler_compress_settlement<'info>(
    ctx: Context<'_, '_, '_, 'info, CompressSettlementAccounts<'info>>,
    proof: ValidityProof,
    address_tree_info: PackedAddressTreeInfo,
    output_state_tree_index: u8,
) -> Result<()> {
    let channel = &ctx.accounts.channel;
    let clock = Clock::get()?;

    let light_cpi_accounts = LightCpiAccounts::new(
        ctx.accounts.signer.as_ref(),
        ctx.remaining_accounts,
        LIGHT_CPI_SIGNER,
    );

    let channel_key = channel.key();
    let (_address, address_seed) = light_sdk::address::v1::derive_address(
        &[b"compressed_settlement", channel_key.as_ref()],
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
    compressed.channel_id = channel.channel_id;
    compressed.job_pubkey = channel.job_pubkey;
    compressed.poster = channel.poster;
    compressed.agent = channel.agent;
    compressed.total_deposited = channel.deposited;
    compressed.total_claimed = channel.claimed;
    compressed.voucher_count = channel.voucher_count;
    compressed.settled_at = clock.unix_timestamp;
    compressed.settlement_hash = compute_hash(channel);

    LightSystemProgramCpi::new_cpi(LIGHT_CPI_SIGNER, proof)
        .with_light_account(compressed)
        .map_err(|_| TaskforestPaymentsError::CompressionFailed)?
        .with_new_addresses(&[address_tree_info
            .into_new_address_params_assigned_packed(address_seed, Some(output_state_tree_index))])
        .invoke(light_cpi_accounts)
        .map_err(|_| TaskforestPaymentsError::CompressionFailed)?;

    msg!("Settlement compressed for channel {}", channel.channel_id);
    Ok(())
}

fn compute_hash(channel: &PaymentChannel) -> [u8; 32] {
    let mut data = Vec::with_capacity(152);
    data.extend_from_slice(&channel.channel_id.to_le_bytes());
    data.extend_from_slice(&channel.job_pubkey.to_bytes());
    data.extend_from_slice(&channel.poster.to_bytes());
    data.extend_from_slice(&channel.agent.to_bytes());
    data.extend_from_slice(&channel.deposited.to_le_bytes());
    data.extend_from_slice(&channel.claimed.to_le_bytes());
    data.extend_from_slice(&channel.voucher_count.to_le_bytes());
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut result = [0u8; 32];
    for chunk_start in (0..data.len()).step_by(8) {
        let mut hasher = DefaultHasher::new();
        data[chunk_start..].hash(&mut hasher);
        let h = hasher.finish().to_le_bytes();
        let offset = (chunk_start / 8) % 4;
        for i in 0..8 {
            result[offset * 8 + i] ^= h[i];
        }
    }
    result
}

#[derive(Accounts)]
pub struct CompressSettlementAccounts<'info> {
    #[account(mut)]
    pub channel: Account<'info, PaymentChannel>,
    #[account(mut)]
    pub signer: Signer<'info>,
}
