pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use instructions::*;
use light_sdk::instruction::{PackedAddressTreeInfo, ValidityProof};

declare_id!("DFpay111111111111111111111111111111111111111");

#[ephemeral]
#[program]
pub mod taskforest_payments {
    use super::*;

    pub fn create_escrow_wrapper(
        ctx: Context<CreateEscrowWrapper>,
        escrow_id: u64,
        deposit_lamports: u64,
        mpp_session_id: [u8; 32],
    ) -> Result<()> {
        payment::handler_create_escrow_wrapper(ctx, escrow_id, deposit_lamports, mpp_session_id)
    }

    pub fn delegate_to_per(ctx: Context<DelegateToPer>) -> Result<()> {
        payment::handler_delegate_to_per(ctx)
    }

    pub fn verify_tee_attestation(
        ctx: Context<VerifyTeeAttestation>,
        escrow_id: u64,
        attestation_report: Vec<u8>,
        tee_pubkey: [u8; 32],
    ) -> Result<()> {
        payment::handler_verify_tee_attestation(ctx, escrow_id, attestation_report, tee_pubkey)
    }

    pub fn record_settlement(
        ctx: Context<RecordSettlement>,
        escrow_id: u64,
        total_paid: u64,
    ) -> Result<()> {
        payment::handler_record_settlement(ctx, escrow_id, total_paid)
    }

    pub fn compress_settlement<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressSettlementAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        total_paid: u64,
    ) -> Result<()> {
        compressed::handler_compress_settlement(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
            total_paid,
        )
    }
}
