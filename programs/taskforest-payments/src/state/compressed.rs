use anchor_lang::prelude::*;
use borsh::{BorshDeserialize, BorshSerialize};
use light_sdk::LightDiscriminator;

#[derive(Clone, Debug, Default, BorshSerialize, BorshDeserialize, LightDiscriminator)]
pub struct CompressedSettlement {
    pub escrow_id: u64,
    pub job_pubkey: Pubkey,
    pub poster: Pubkey,
    pub agent: Pubkey,
    pub total_deposited: u64,
    pub total_paid: u64,
    pub settled_at: i64,
    pub mpp_session_id: [u8; 32],
}
