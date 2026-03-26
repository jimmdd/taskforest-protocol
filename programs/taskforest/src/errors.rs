use anchor_lang::prelude::*;

#[error_code]
pub enum TaskForestError {
    #[msg("Reward must be greater than zero")]
    InvalidReward,
    #[msg("Deadline must be in the future")]
    InvalidDeadline,
    #[msg("Job is not in the expected status")]
    WrongStatus,
    #[msg("Only the poster can perform this action")]
    Unauthorized,
    #[msg("Bid stake must be greater than zero")]
    InvalidStake,
    #[msg("Bid stake is below minimum (10% of reward)")]
    InsufficientStake,
    #[msg("Only the claimer can submit proof")]
    InvalidClaimer,
    #[msg("Deadline has passed")]
    DeadlinePassed,
    #[msg("Deadline has not yet passed")]
    DeadlineNotPassed,
    #[msg("Invalid verdict value")]
    InvalidVerdict,
    #[msg("Proof must be submitted before settlement")]
    MissingProof,
    #[msg("Review period has not expired")]
    ReviewPeriodActive,
    #[msg("Insufficient escrow balance")]
    InsufficientEscrow,
    #[msg("TTD URI exceeds maximum length")]
    UriTooLong,
    #[msg("Job is not in auto-match mode")]
    NotAutoMatch,
    #[msg("Insufficient escrow for sub-job")]
    InsufficientEscrowForSubJob,
    #[msg("Sub-job reward exceeds remaining escrow")]
    SubJobExceedsEscrow,
    #[msg("Dispute window has not ended")]
    DisputeWindowActive,
    #[msg("Dispute window has ended")]
    DisputeWindowExpired,
    #[msg("Dispute stake too low")]
    DisputeStakeTooLow,
    #[msg("Invalid dispute status")]
    InvalidDisputeStatus,
    #[msg("Panel vote already cast")]
    AlreadyVoted,
    #[msg("Panel quorum not reached")]
    QuorumNotReached,
    #[msg("Not a designated panel verifier")]
    NotPanelVerifier,
    #[msg("Invalid verification mode")]
    InvalidVerificationMode,
}
