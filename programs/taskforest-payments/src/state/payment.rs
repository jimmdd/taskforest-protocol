use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Active,
    Delegated,
    Settled,
}

impl Default for EscrowStatus {
    fn default() -> Self {
        EscrowStatus::Active
    }
}

#[account]
pub struct EscrowWrapper {
    pub escrow_id: u64,
    pub job_pubkey: Pubkey,
    pub poster: Pubkey,
    pub agent: Pubkey,
    pub validator: Pubkey,
    pub deposited: u64,
    pub status: EscrowStatus,
    pub tee_pubkey: [u8; 32],
    pub tee_verified: bool,
    pub mpp_session_id: [u8; 32],
    pub created_at: i64,
}

impl EscrowWrapper {
    pub const SIZE: usize = 8
        + 8       // escrow_id
        + 32      // job_pubkey
        + 32      // poster
        + 32      // agent
        + 32      // validator
        + 8       // deposited
        + 1       // status
        + 32      // tee_pubkey
        + 1       // tee_verified
        + 32      // mpp_session_id
        + 8; // created_at
}

#[account]
pub struct SettlementRecord {
    pub escrow_id: u64,
    pub job_pubkey: Pubkey,
    pub poster: Pubkey,
    pub agent: Pubkey,
    pub total_deposited: u64,
    pub total_paid: u64,
    pub settled_at: i64,
    pub settlement_hash: [u8; 32],
}

impl SettlementRecord {
    pub const SIZE: usize = 8 + 8 + 32 + 32 + 32 + 8 + 8 + 8 + 32;
}
