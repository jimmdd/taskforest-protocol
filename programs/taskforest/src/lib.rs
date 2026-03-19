pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;
use instructions::*;
use light_sdk::instruction::{PackedAddressTreeInfo, ValidityProof};

declare_id!("Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s");

#[ephemeral]
#[program]
pub mod taskforest {
    use super::*;

    pub fn register_ttd(
        ctx: Context<RegisterTtd>,
        ttd_hash: [u8; 32],
        ttd_uri: String,
        version: u16,
    ) -> Result<()> {
        ttd::handler_register_ttd(ctx, ttd_hash, ttd_uri, version)
    }

    pub fn initialize_job(
        ctx: Context<InitializeJob>,
        job_id: u64,
        reward_lamports: u64,
        deadline: i64,
        proof_spec_hash: [u8; 32],
        ttd_hash: [u8; 32],
        privacy_level: u8,
        encryption_pubkey: [u8; 32],
        assignment_mode: u8,
        verification_level: u8,
    ) -> Result<()> {
        job::handler_initialize_job(
            ctx,
            job_id,
            reward_lamports,
            deadline,
            proof_spec_hash,
            ttd_hash,
            privacy_level,
            encryption_pubkey,
            assignment_mode,
            verification_level,
        )
    }

    pub fn auto_assign_job(ctx: Context<AutoAssignJob>, assigned_agent: Pubkey) -> Result<()> {
        job::handler_auto_assign_job(ctx, assigned_agent)
    }

    pub fn create_sub_job(
        ctx: Context<CreateSubJob>,
        sub_job_id: u64,
        assigned_agent: Pubkey,
        reward_lamports: u64,
        deadline: i64,
        ttd_hash: [u8; 32],
    ) -> Result<()> {
        job::handler_create_sub_job(
            ctx,
            sub_job_id,
            assigned_agent,
            reward_lamports,
            deadline,
            ttd_hash,
        )
    }

    pub fn submit_verified_proof(
        ctx: Context<SubmitVerifiedProof>,
        proof_hash: [u8; 32],
        receipt_root: [u8; 32],
        receipt_uri: [u8; 32],
        attestation_hash: [u8; 32],
    ) -> Result<()> {
        proof::handler_submit_verified_proof(
            ctx,
            proof_hash,
            receipt_root,
            receipt_uri,
            attestation_hash,
        )
    }

    pub fn auto_settle(ctx: Context<AutoSettle>) -> Result<()> {
        settlement::handler_auto_settle(ctx)
    }

    pub fn open_dispute(
        ctx: Context<OpenDispute>,
        disputed_thread: u32,
        challenger_receipt_hash: [u8; 32],
        evidence_uri: [u8; 32],
    ) -> Result<()> {
        dispute::handler_open_dispute(ctx, disputed_thread, challenger_receipt_hash, evidence_uri)
    }

    pub fn resolve_dispute(ctx: Context<ResolveDispute>, verdict: u8) -> Result<()> {
        dispute::handler_resolve_dispute(ctx, verdict)
    }

    pub fn cast_vote(ctx: Context<CastVote>, verdict: u8) -> Result<()> {
        dispute::handler_cast_vote(ctx, verdict)
    }

    pub fn tally_panel(ctx: Context<TallyPanel>) -> Result<()> {
        dispute::handler_tally_panel(ctx)
    }

    pub fn delegate_job(ctx: Context<DelegateJob>) -> Result<()> {
        delegation::handler_delegate_job(ctx)
    }

    pub fn place_bid(ctx: Context<PlaceBid>, stake_lamports: u64) -> Result<()> {
        bidding::handler_place_bid(ctx, stake_lamports)
    }

    pub fn close_bidding(ctx: Context<CloseBidding>) -> Result<()> {
        bidding::handler_close_bidding(ctx)
    }

    pub fn lock_stake(ctx: Context<LockStake>) -> Result<()> {
        bidding::handler_lock_stake(ctx)
    }

    pub fn submit_proof(ctx: Context<SubmitProof>, proof_hash: [u8; 32]) -> Result<()> {
        proof::handler_submit_proof(ctx, proof_hash)
    }

    pub fn settle_job(ctx: Context<SettleJob>, verdict: u8, reason_code: [u8; 32]) -> Result<()> {
        settlement::handler_settle_job(ctx, verdict, reason_code)
    }

    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        settlement::handler_claim_timeout(ctx)
    }

    pub fn archive_settlement(
        ctx: Context<ArchiveSettlement>,
        reason_code: [u8; 32],
    ) -> Result<()> {
        settlement::handler_archive_settlement(ctx, reason_code)
    }

    pub fn expire_claim(ctx: Context<ExpireClaim>) -> Result<()> {
        job::handler_expire_claim(ctx)
    }

    pub fn expire_unclaimed(ctx: Context<ExpireUnclaimed>) -> Result<()> {
        job::handler_expire_unclaimed(ctx)
    }

    pub fn extend_deadline(ctx: Context<ExtendDeadline>, new_deadline: i64) -> Result<()> {
        job::handler_extend_deadline(ctx, new_deadline)
    }

    pub fn store_credential(
        ctx: Context<StoreCredential>,
        encrypted_cred_hash: [u8; 32],
    ) -> Result<()> {
        credential::handler_store_credential(ctx, encrypted_cred_hash)
    }

    pub fn clear_credential(ctx: Context<ClearCredential>) -> Result<()> {
        credential::handler_clear_credential(ctx)
    }

    pub fn submit_encrypted_proof(
        ctx: Context<SubmitProof>,
        proof_hash: [u8; 32],
        encrypted_output_hash: [u8; 32],
    ) -> Result<()> {
        proof::handler_submit_encrypted_proof(ctx, proof_hash, encrypted_output_hash)
    }

    pub fn archive_settlement_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedArchiveAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        reason_code: [u8; 32],
    ) -> Result<()> {
        compressed::handler_archive_settlement_compressed(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
            reason_code,
        )
    }

    pub fn init_agent_reputation<'info>(
        ctx: Context<'_, '_, '_, 'info, AgentReputationAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        tasks_completed: u32,
        tasks_failed: u32,
        total_earned: u64,
        total_staked: u64,
    ) -> Result<()> {
        compressed::handler_init_agent_reputation(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
            tasks_completed,
            tasks_failed,
            total_earned,
            total_staked,
        )
    }

    pub fn init_poster_reputation<'info>(
        ctx: Context<'_, '_, '_, 'info, PosterReputationAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        tasks_posted: u32,
        tasks_settled_pass: u32,
        tasks_settled_fail: u32,
        disputes_initiated: u32,
        disputes_won: u32,
        total_spent: u64,
        avg_settle_secs: u64,
    ) -> Result<()> {
        compressed::handler_init_poster_reputation(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
            tasks_posted,
            tasks_settled_pass,
            tasks_settled_fail,
            disputes_initiated,
            disputes_won,
            total_spent,
            avg_settle_secs,
        )
    }

    pub fn register_ttd_compressed<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedTtdAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
        ttd_hash: [u8; 32],
        ttd_uri_hash: [u8; 32],
        version: u16,
    ) -> Result<()> {
        compressed::handler_register_ttd_compressed(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
            ttd_hash,
            ttd_uri_hash,
            version,
        )
    }

    pub fn compress_finished_job<'info>(
        ctx: Context<'_, '_, '_, 'info, CompressedJobAccounts<'info>>,
        proof: ValidityProof,
        address_tree_info: PackedAddressTreeInfo,
        output_state_tree_index: u8,
    ) -> Result<()> {
        compressed::handler_compress_finished_job(
            ctx,
            proof,
            address_tree_info,
            output_state_tree_index,
        )
    }

    // ── Dark Forest Payment Channels ──────────────────────────────

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
}
