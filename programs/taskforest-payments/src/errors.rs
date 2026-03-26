use anchor_lang::prelude::*;

#[error_code]
pub enum TaskforestPaymentsError {
    #[msg("Only authorized party can perform this action")]
    Unauthorized,
    #[msg("Escrow is not in active state")]
    EscrowNotActive,
    #[msg("Invalid TEE attestation report")]
    InvalidAttestation,
    #[msg("TEE attestation signature missing or invalid")]
    InvalidAttestationSignature,
    #[msg("TEE attestation report exceeds maximum size")]
    AttestationTooLarge,
    #[msg("TEE attestation has expired or is not yet valid")]
    AttestationExpired,
    #[msg("TEE attestation report does not match escrow state")]
    AttestationMismatch,
    #[msg("Validator is not in the allowlist")]
    InvalidValidator,
    #[msg("Settlement exceeds deposited amount")]
    SettlementExceedsDeposit,
    #[msg("ZK compression failed")]
    CompressionFailed,
}
