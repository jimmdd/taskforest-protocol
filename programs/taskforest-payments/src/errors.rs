use anchor_lang::prelude::*;

#[error_code]
pub enum TaskforestPaymentsError {
    #[msg("Only authorized party can perform this action")]
    Unauthorized,
    #[msg("Escrow is not in active state")]
    EscrowNotActive,
    #[msg("Invalid TEE attestation report")]
    InvalidAttestation,
    #[msg("TEE attestation report exceeds maximum size")]
    AttestationTooLarge,
    #[msg("ZK compression failed")]
    CompressionFailed,
}
