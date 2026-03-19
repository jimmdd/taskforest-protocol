use anchor_lang::prelude::*;

#[error_code]
pub enum TaskforestPaymentsError {
    #[msg("Only authorized party can perform this action")]
    Unauthorized,
    #[msg("Payment channel is not open")]
    ChannelNotOpen,
    #[msg("Voucher cumulative amount must be monotonically increasing")]
    VoucherNotMonotonic,
    #[msg("Cumulative voucher amount exceeds channel deposit")]
    InsufficientChannelDeposit,
    #[msg("Nothing to claim from channel")]
    NothingToClaim,
    #[msg("Payment channel arithmetic overflow")]
    ChannelOverflow,
    #[msg("Invalid TEE attestation report")]
    InvalidAttestation,
    #[msg("TEE attestation report exceeds maximum size")]
    AttestationTooLarge,
    #[msg("ZK compression failed")]
    CompressionFailed,
}
