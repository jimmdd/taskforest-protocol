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

    pub fn create_payment_channel(
        ctx: Context<CreatePaymentChannel>,
        channel_id: u64,
        deposit_lamports: u64,
        expires_in_seconds: i64,
    ) -> Result<()> {
        payment::handler_create_payment_channel(
            ctx,
            channel_id,
            deposit_lamports,
            expires_in_seconds,
        )
    }

    pub fn fund_payment_channel(ctx: Context<FundPaymentChannel>, amount: u64) -> Result<()> {
        payment::handler_fund_payment_channel(ctx, amount)
    }

    pub fn send_voucher(
        ctx: Context<SendVoucher>,
        channel_id: u64,
        cumulative_amount: u64,
    ) -> Result<()> {
        payment::handler_send_voucher(ctx, channel_id, cumulative_amount)
    }

    pub fn claim_voucher(ctx: Context<ClaimVoucher>, channel_id: u64) -> Result<()> {
        payment::handler_claim_voucher(ctx, channel_id)
    }

    pub fn close_payment_channel(ctx: Context<ClosePaymentChannel>, channel_id: u64) -> Result<()> {
        payment::handler_close_payment_channel(ctx, channel_id)
    }

    pub fn delegate_payment_channel(ctx: Context<DelegatePaymentChannel>) -> Result<()> {
        payment::handler_delegate_payment_channel(ctx)
    }

    pub fn settle_payment_channel(ctx: Context<SettlePaymentChannel>) -> Result<()> {
        payment::handler_settle_payment_channel(ctx)
    }

    pub fn commit_payment_channel(ctx: Context<SettlePaymentChannel>) -> Result<()> {
        payment::handler_commit_payment_channel(ctx)
    }

    pub fn record_channel_settlement(
        ctx: Context<RecordChannelSettlement>,
        channel_id: u64,
    ) -> Result<()> {
        payment::handler_record_channel_settlement(ctx, channel_id)
    }

    pub fn create_channel_permission(
        ctx: Context<CreateChannelPermission>,
        channel_id: u64,
    ) -> Result<()> {
        payment::handler_create_channel_permission(ctx, channel_id)
    }

    pub fn add_dispute_panel_access(
        ctx: Context<UpdateChannelPermission>,
        channel_id: u64,
        panel_member: Pubkey,
    ) -> Result<()> {
        payment::handler_add_dispute_panel_access(ctx, channel_id, panel_member)
    }

    pub fn settle_and_record(ctx: Context<SettleAndRecord>, channel_id: u64) -> Result<()> {
        payment::handler_settle_and_record(ctx, channel_id)
    }

    pub fn verify_tee_attestation(
        ctx: Context<VerifyTeeAttestation>,
        channel_id: u64,
        attestation_report: Vec<u8>,
        tee_pubkey: [u8; 32],
    ) -> Result<()> {
        payment::handler_verify_tee_attestation(ctx, channel_id, attestation_report, tee_pubkey)
    }

    pub fn compress_settlement<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressSettlementAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
    ) -> Result<()> {
        compressed::handler_compress_settlement(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
        )
    }
}
