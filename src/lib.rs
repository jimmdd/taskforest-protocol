use std::collections::HashMap;

#[cfg(feature = "bpf-entrypoint")]
pub mod bpf_entrypoint;
pub mod error;
pub mod instruction;
pub mod processor;
pub mod state;

pub type JobId = u64;
pub type ActorId = String;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationBackend {
    Native,
    Arcium,
    MagicBlock,
    Hybrid,
    Custom(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Open,
    Claimed,
    Submitted,
    Done,
    Failed,
    Disputed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    NeedsJudge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureReason {
    ChecksFailed,
    DeadlineExpired,
    Slashed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: JobId,
    pub poster: ActorId,
    pub reward_usdc: u64,
    pub deadline_epoch_secs: u64,
    pub proof_spec_hash: String,
    pub status: JobStatus,
    pub claim: Option<Claim>,
    pub proof: Option<ProofSubmission>,
    pub settlement: Option<Settlement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub claimer: ActorId,
    pub stake_usdc: u64,
    pub claimed_at_epoch_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProofSubmission {
    pub proof_hash: String,
    pub submitted_at_epoch_secs: u64,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub verdict: Verdict,
    pub settled_at_epoch_secs: u64,
    pub reason_code: String,
    pub verification_backend: VerificationBackend,
    pub verification_ref: Option<String>,
    pub worker_payout_usdc: u64,
    pub poster_refund_usdc: u64,
    pub stake_returned_usdc: u64,
    pub stake_slashed_usdc: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolCapabilities {
    pub allow_confidential_verification: bool,
    pub allow_realtime_execution: bool,
    pub extension_flags: HashMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolPolicy {
    pub min_stake_bps: u16,
    pub max_active_claims_per_claimer: u16,
    pub max_active_exposure_per_claimer: u64,
    pub min_evidence_refs: usize,
    pub require_verification_ref_on_pass: bool,
    pub high_value_threshold_usdc: u64,
    pub required_verifier_approvals: u8,
    pub required_verifier_approvals_high_value: u8,
    pub min_pass_settlement_delay_secs: u64,
}

impl Default for ProtocolPolicy {
    fn default() -> Self {
        Self {
            min_stake_bps: 1000,
            max_active_claims_per_claimer: 5,
            max_active_exposure_per_claimer: 50_000,
            min_evidence_refs: 1,
            require_verification_ref_on_pass: true,
            high_value_threshold_usdc: 10_000,
            required_verifier_approvals: 1,
            required_verifier_approvals_high_value: 2,
            min_pass_settlement_delay_secs: 60,
        }
    }
}

impl Default for ProtocolCapabilities {
    fn default() -> Self {
        Self {
            allow_confidential_verification: false,
            allow_realtime_execution: false,
            extension_flags: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    JobAlreadyExists,
    JobNotFound,
    InvalidTransition,
    NotClaimed,
    AlreadyClaimed,
    AlreadySubmitted,
    AlreadySettled,
    DeadlinePassed,
    InvalidAmount,
    MissingProof,
    WrongStatus,
    Unauthorized,
    InvalidClaimant,
    InsufficientStake,
    TooManyActiveClaims,
    ExposureLimitExceeded,
    InsufficientEvidence,
    MissingVerificationRef,
    InsufficientVerifierApprovals,
    ChallengeWindowNotElapsed,
}

#[derive(Debug, Default)]
pub struct TaskForestProtocol {
    jobs: HashMap<JobId, Job>,
    capabilities: ProtocolCapabilities,
    policy: ProtocolPolicy,
}

impl TaskForestProtocol {
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
            capabilities: ProtocolCapabilities::default(),
            policy: ProtocolPolicy::default(),
        }
    }

    pub fn create_job(&mut self, params: CreateJobParams) -> Result<(), ProtocolError> {
        if self.jobs.contains_key(&params.job_id) {
            return Err(ProtocolError::JobAlreadyExists);
        }
        if params.reward_usdc == 0 {
            return Err(ProtocolError::InvalidAmount);
        }
        let job = Job {
            id: params.job_id,
            poster: params.poster,
            reward_usdc: params.reward_usdc,
            deadline_epoch_secs: params.deadline_epoch_secs,
            proof_spec_hash: params.proof_spec_hash,
            status: JobStatus::Open,
            claim: None,
            proof: None,
            settlement: None,
        };
        self.jobs.insert(params.job_id, job);
        Ok(())
    }

    pub fn claim_job(&mut self, params: ClaimJobParams) -> Result<(), ProtocolError> {
        let active_claims = self.active_claim_count(&params.claimer);
        if active_claims >= self.policy.max_active_claims_per_claimer as usize {
            return Err(ProtocolError::TooManyActiveClaims);
        }

        let target_reward = self
            .jobs
            .get(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?
            .reward_usdc;

        if params.stake_usdc == 0 {
            return Err(ProtocolError::InvalidAmount);
        }
        let min_stake =
            ((target_reward as u128 * self.policy.min_stake_bps as u128) / 10_000) as u64;
        if params.stake_usdc < min_stake {
            return Err(ProtocolError::InsufficientStake);
        }

        let active_exposure = self.active_exposure(&params.claimer);
        if active_exposure.saturating_add(target_reward)
            > self.policy.max_active_exposure_per_claimer
        {
            return Err(ProtocolError::ExposureLimitExceeded);
        }

        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.status != JobStatus::Open {
            return Err(ProtocolError::AlreadyClaimed);
        }
        if params.now_epoch_secs > job.deadline_epoch_secs {
            return Err(ProtocolError::DeadlinePassed);
        }

        job.claim = Some(Claim {
            claimer: params.claimer,
            stake_usdc: params.stake_usdc,
            claimed_at_epoch_secs: params.now_epoch_secs,
        });
        job.status = JobStatus::Claimed;
        Ok(())
    }

    pub fn submit_proof(&mut self, params: SubmitProofParams) -> Result<(), ProtocolError> {
        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.status != JobStatus::Claimed {
            return Err(ProtocolError::NotClaimed);
        }
        if params.now_epoch_secs > job.deadline_epoch_secs {
            return Err(ProtocolError::DeadlinePassed);
        }
        if job.claim.as_ref().map(|c| c.claimer.as_str()) != Some(params.submitter.as_str()) {
            return Err(ProtocolError::InvalidClaimant);
        }
        if params.evidence_refs.len() < self.policy.min_evidence_refs {
            return Err(ProtocolError::InsufficientEvidence);
        }
        if job.proof.is_some() {
            return Err(ProtocolError::AlreadySubmitted);
        }

        job.proof = Some(ProofSubmission {
            proof_hash: params.proof_hash,
            submitted_at_epoch_secs: params.now_epoch_secs,
            evidence_refs: params.evidence_refs,
        });
        job.status = JobStatus::Submitted;
        Ok(())
    }

    pub fn settle_job(&mut self, params: SettleJobParams) -> Result<Settlement, ProtocolError> {
        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.settlement.is_some() {
            return Err(ProtocolError::AlreadySettled);
        }
        if params.verdict != Verdict::NeedsJudge
            && job.status != JobStatus::Submitted
            && job.status != JobStatus::Disputed
        {
            return Err(ProtocolError::WrongStatus);
        }
        if params.verdict != Verdict::NeedsJudge && job.proof.is_none() {
            return Err(ProtocolError::MissingProof);
        }

        let reward = job.reward_usdc;
        let stake = job.claim.as_ref().map(|c| c.stake_usdc).unwrap_or(0);

        if params.verdict == Verdict::Pass {
            let submitted_at = job
                .proof
                .as_ref()
                .map(|p| p.submitted_at_epoch_secs)
                .ok_or(ProtocolError::MissingProof)?;

            if params.now_epoch_secs
                < submitted_at.saturating_add(self.policy.min_pass_settlement_delay_secs)
            {
                return Err(ProtocolError::ChallengeWindowNotElapsed);
            }

            if self.policy.require_verification_ref_on_pass && params.verification_ref.is_none() {
                return Err(ProtocolError::MissingVerificationRef);
            }

            let required_approvals = if reward >= self.policy.high_value_threshold_usdc {
                self.policy.required_verifier_approvals_high_value
            } else {
                self.policy.required_verifier_approvals
            };
            if params.verifier_approvals < required_approvals {
                return Err(ProtocolError::InsufficientVerifierApprovals);
            }
        }

        let settlement = match params.verdict {
            Verdict::Pass => Settlement {
                verdict: Verdict::Pass,
                settled_at_epoch_secs: params.now_epoch_secs,
                reason_code: params.reason_code,
                verification_backend: params.verification_backend.clone(),
                verification_ref: params.verification_ref.clone(),
                worker_payout_usdc: reward,
                poster_refund_usdc: 0,
                stake_returned_usdc: stake,
                stake_slashed_usdc: 0,
            },
            Verdict::Fail => Settlement {
                verdict: Verdict::Fail,
                settled_at_epoch_secs: params.now_epoch_secs,
                reason_code: params.reason_code,
                verification_backend: params.verification_backend.clone(),
                verification_ref: params.verification_ref.clone(),
                worker_payout_usdc: 0,
                poster_refund_usdc: reward,
                stake_returned_usdc: 0,
                stake_slashed_usdc: stake,
            },
            Verdict::NeedsJudge => {
                job.status = JobStatus::Disputed;
                return Err(ProtocolError::InvalidTransition);
            }
        };

        job.status = if params.verdict == Verdict::Pass {
            JobStatus::Done
        } else {
            JobStatus::Failed
        };
        job.settlement = Some(settlement.clone());

        Ok(settlement)
    }

    pub fn open_dispute(&mut self, job_id: JobId) -> Result<(), ProtocolError> {
        let job = self
            .jobs
            .get_mut(&job_id)
            .ok_or(ProtocolError::JobNotFound)?;
        match job.status {
            JobStatus::Submitted | JobStatus::Failed => {
                job.status = JobStatus::Disputed;
                Ok(())
            }
            _ => Err(ProtocolError::InvalidTransition),
        }
    }

    pub fn cancel_job(&mut self, params: CancelJobParams) -> Result<(), ProtocolError> {
        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.poster != params.poster {
            return Err(ProtocolError::Unauthorized);
        }
        if job.status != JobStatus::Open {
            return Err(ProtocolError::InvalidTransition);
        }

        job.status = JobStatus::Cancelled;
        Ok(())
    }

    pub fn expire_claim(&mut self, params: ExpireClaimParams) -> Result<(), ProtocolError> {
        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.status != JobStatus::Claimed {
            return Err(ProtocolError::WrongStatus);
        }
        if params.now_epoch_secs <= job.deadline_epoch_secs {
            return Err(ProtocolError::InvalidTransition);
        }

        let stake = job.claim.as_ref().map(|c| c.stake_usdc).unwrap_or(0);

        job.status = JobStatus::Failed;
        job.settlement = Some(Settlement {
            verdict: Verdict::Fail,
            settled_at_epoch_secs: params.now_epoch_secs,
            reason_code: "DEADLINE_EXPIRED".to_string(),
            verification_backend: VerificationBackend::Native,
            verification_ref: None,
            worker_payout_usdc: 0,
            poster_refund_usdc: job.reward_usdc,
            stake_returned_usdc: 0,
            stake_slashed_usdc: stake,
        });

        Ok(())
    }

    pub fn get_job(&self, job_id: JobId) -> Option<&Job> {
        self.jobs.get(&job_id)
    }

    pub fn job_count(&self) -> usize {
        self.jobs.len()
    }

    pub fn enable_extension(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.capabilities
            .extension_flags
            .insert(key.into(), value.into());
    }

    pub fn set_confidential_verification(&mut self, enabled: bool) {
        self.capabilities.allow_confidential_verification = enabled;
    }

    pub fn set_realtime_execution(&mut self, enabled: bool) {
        self.capabilities.allow_realtime_execution = enabled;
    }

    pub fn capabilities(&self) -> &ProtocolCapabilities {
        &self.capabilities
    }

    pub fn policy(&self) -> &ProtocolPolicy {
        &self.policy
    }

    pub fn policy_mut(&mut self) -> &mut ProtocolPolicy {
        &mut self.policy
    }

    fn active_claim_count(&self, claimer: &str) -> usize {
        self.jobs
            .values()
            .filter(|job| {
                matches!(
                    job.status,
                    JobStatus::Claimed | JobStatus::Submitted | JobStatus::Disputed
                ) && job
                    .claim
                    .as_ref()
                    .map(|c| c.claimer.as_str() == claimer)
                    .unwrap_or(false)
            })
            .count()
    }

    fn active_exposure(&self, claimer: &str) -> u64 {
        self.jobs
            .values()
            .filter(|job| {
                matches!(
                    job.status,
                    JobStatus::Claimed | JobStatus::Submitted | JobStatus::Disputed
                ) && job
                    .claim
                    .as_ref()
                    .map(|c| c.claimer.as_str() == claimer)
                    .unwrap_or(false)
            })
            .map(|job| job.reward_usdc)
            .sum()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateJobParams {
    pub job_id: JobId,
    pub poster: ActorId,
    pub reward_usdc: u64,
    pub deadline_epoch_secs: u64,
    pub proof_spec_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimJobParams {
    pub job_id: JobId,
    pub claimer: ActorId,
    pub stake_usdc: u64,
    pub now_epoch_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmitProofParams {
    pub job_id: JobId,
    pub submitter: ActorId,
    pub proof_hash: String,
    pub now_epoch_secs: u64,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleJobParams {
    pub job_id: JobId,
    pub verdict: Verdict,
    pub reason_code: String,
    pub now_epoch_secs: u64,
    pub verification_backend: VerificationBackend,
    pub verification_ref: Option<String>,
    pub verifier_approvals: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelJobParams {
    pub job_id: JobId,
    pub poster: ActorId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpireClaimParams {
    pub job_id: JobId,
    pub now_epoch_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruction::TaskForestInstruction;
    use crate::processor::{process_instruction, ProcessorOutput};

    fn create_default_job(protocol: &mut TaskForestProtocol, job_id: u64) {
        protocol
            .create_job(CreateJobParams {
                job_id,
                poster: "poster-1".to_string(),
                reward_usdc: 1_000,
                deadline_epoch_secs: 2_000,
                proof_spec_hash: "proof-spec-hash".to_string(),
            })
            .expect("create job should succeed");
    }

    #[test]
    fn happy_path_claim_submit_settle_pass() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 1);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 1,
                claimer: "worker-a".to_string(),
                stake_usdc: 200,
                now_epoch_secs: 1_000,
            })
            .expect("claim should succeed");

        protocol
            .submit_proof(SubmitProofParams {
                job_id: 1,
                submitter: "worker-a".to_string(),
                proof_hash: "proof-hash-123".to_string(),
                now_epoch_secs: 1_200,
                evidence_refs: vec!["ci://run/1".to_string()],
            })
            .expect("proof submit should succeed");

        let settlement = protocol
            .settle_job(SettleJobParams {
                job_id: 1,
                verdict: Verdict::Pass,
                reason_code: "CHECKS_PASS_ALL".to_string(),
                now_epoch_secs: 1_300,
                verification_backend: VerificationBackend::Native,
                verification_ref: Some("verifier://native/1".to_string()),
                verifier_approvals: 1,
            })
            .expect("settle pass should succeed");

        assert_eq!(settlement.worker_payout_usdc, 1_000);
        assert_eq!(settlement.stake_returned_usdc, 200);
        assert_eq!(settlement.poster_refund_usdc, 0);
        assert_eq!(settlement.verification_backend, VerificationBackend::Native);

        let job = protocol.get_job(1).expect("job should exist");
        assert_eq!(job.status, JobStatus::Done);
    }

    #[test]
    fn fail_path_refunds_poster_and_slashes_stake() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 2);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 2,
                claimer: "worker-b".to_string(),
                stake_usdc: 300,
                now_epoch_secs: 1_000,
            })
            .expect("claim should succeed");

        protocol
            .submit_proof(SubmitProofParams {
                job_id: 2,
                submitter: "worker-b".to_string(),
                proof_hash: "bad-proof".to_string(),
                now_epoch_secs: 1_500,
                evidence_refs: vec!["ci://run/2".to_string()],
            })
            .expect("proof submit should succeed");

        let settlement = protocol
            .settle_job(SettleJobParams {
                job_id: 2,
                verdict: Verdict::Fail,
                reason_code: "CI_REQUIRED_FAILED".to_string(),
                now_epoch_secs: 1_600,
                verification_backend: VerificationBackend::Native,
                verification_ref: Some("verifier://native/2".to_string()),
                verifier_approvals: 1,
            })
            .expect("settle fail should succeed");

        assert_eq!(settlement.poster_refund_usdc, 1_000);
        assert_eq!(settlement.stake_slashed_usdc, 300);
        assert_eq!(settlement.worker_payout_usdc, 0);

        let job = protocol.get_job(2).expect("job should exist");
        assert_eq!(job.status, JobStatus::Failed);
    }

    #[test]
    fn cannot_claim_after_deadline() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 3);

        let result = protocol.claim_job(ClaimJobParams {
            job_id: 3,
            claimer: "worker-c".to_string(),
            stake_usdc: 100,
            now_epoch_secs: 2_100,
        });

        assert_eq!(result, Err(ProtocolError::DeadlinePassed));
    }

    #[test]
    fn cannot_settle_without_proof_submission() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 4);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 4,
                claimer: "worker-d".to_string(),
                stake_usdc: 100,
                now_epoch_secs: 1_000,
            })
            .expect("claim should succeed");

        let result = protocol.settle_job(SettleJobParams {
            job_id: 4,
            verdict: Verdict::Pass,
            reason_code: "CHECKS_PASS_ALL".to_string(),
            now_epoch_secs: 1_100,
            verification_backend: VerificationBackend::Native,
            verification_ref: None,
            verifier_approvals: 1,
        });

        assert_eq!(result, Err(ProtocolError::WrongStatus));
    }

    #[test]
    fn disputed_job_can_be_settled_by_verdict() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 5);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 5,
                claimer: "worker-e".to_string(),
                stake_usdc: 150,
                now_epoch_secs: 1_000,
            })
            .expect("claim should succeed");

        protocol
            .submit_proof(SubmitProofParams {
                job_id: 5,
                submitter: "worker-e".to_string(),
                proof_hash: "proof-hash-5".to_string(),
                now_epoch_secs: 1_200,
                evidence_refs: vec!["ci://run/5".to_string()],
            })
            .expect("proof submit should succeed");

        protocol.open_dispute(5).expect("dispute should open");

        let settlement = protocol
            .settle_job(SettleJobParams {
                job_id: 5,
                verdict: Verdict::Fail,
                reason_code: "DISPUTE_POSTER_UPHELD".to_string(),
                now_epoch_secs: 1_300,
                verification_backend: VerificationBackend::Arcium,
                verification_ref: Some("arcium://proof/5".to_string()),
                verifier_approvals: 1,
            })
            .expect("disputed settlement should succeed");

        assert_eq!(settlement.poster_refund_usdc, 1_000);
        assert_eq!(settlement.stake_slashed_usdc, 150);
        let job = protocol.get_job(5).expect("job should exist");
        assert_eq!(job.status, JobStatus::Failed);
    }

    #[test]
    fn instruction_unpack_and_process_flow() {
        let mut protocol = TaskForestProtocol::new();

        let create = TaskForestInstruction::unpack(b"create_job|9|poster-z|1000|2000|proof-spec-9")
            .expect("create instruction should unpack");
        let out = process_instruction(&mut protocol, create).expect("create should process");
        assert_eq!(out, ProcessorOutput::None);

        let claim = TaskForestInstruction::unpack(b"claim_job|9|worker-z|111|1200")
            .expect("claim instruction should unpack");
        process_instruction(&mut protocol, claim).expect("claim should process");

        let submit = TaskForestInstruction::unpack(
            b"submit_proof|9|worker-z|proof-9|1300|ci://9|artifact://9",
        )
        .expect("submit instruction should unpack");
        process_instruction(&mut protocol, submit).expect("submit should process");

        let settle = TaskForestInstruction::unpack(
            b"settle_job|9|pass|CHECKS_PASS_ALL|1400|magicblock|mb://receipt/9",
        )
        .expect("settle instruction should unpack");
        let result = process_instruction(&mut protocol, settle).expect("settle should process");

        match result {
            ProcessorOutput::Settled(s) => {
                assert_eq!(s.worker_payout_usdc, 1000);
                assert_eq!(s.stake_returned_usdc, 111);
                assert_eq!(s.verification_backend, VerificationBackend::MagicBlock);
            }
            ProcessorOutput::None => panic!("expected settlement output"),
        }
    }

    #[test]
    fn only_claimer_can_submit_proof() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 6);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 6,
                claimer: "worker-f".to_string(),
                stake_usdc: 100,
                now_epoch_secs: 1_000,
            })
            .expect("claim should succeed");

        let result = protocol.submit_proof(SubmitProofParams {
            job_id: 6,
            submitter: "imposter".to_string(),
            proof_hash: "proof-hash-6".to_string(),
            now_epoch_secs: 1_100,
            evidence_refs: vec![],
        });

        assert_eq!(result, Err(ProtocolError::InvalidClaimant));
    }

    #[test]
    fn poster_can_cancel_open_job() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 7);

        protocol
            .cancel_job(CancelJobParams {
                job_id: 7,
                poster: "poster-1".to_string(),
            })
            .expect("cancel should succeed");

        let job = protocol.get_job(7).expect("job should exist");
        assert_eq!(job.status, JobStatus::Cancelled);
    }

    #[test]
    fn expire_claim_creates_fail_settlement() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 8);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 8,
                claimer: "worker-g".to_string(),
                stake_usdc: 250,
                now_epoch_secs: 1_500,
            })
            .expect("claim should succeed");

        protocol
            .expire_claim(ExpireClaimParams {
                job_id: 8,
                now_epoch_secs: 2_100,
            })
            .expect("expiration should succeed");

        let job = protocol.get_job(8).expect("job should exist");
        assert_eq!(job.status, JobStatus::Failed);
        let settlement = job.settlement.clone().expect("settlement should exist");
        assert_eq!(settlement.reason_code, "DEADLINE_EXPIRED");
        assert_eq!(settlement.poster_refund_usdc, 1_000);
        assert_eq!(settlement.stake_slashed_usdc, 250);
    }

    #[test]
    fn protocol_capabilities_support_extension_flags() {
        let mut protocol = TaskForestProtocol::new();
        protocol.set_confidential_verification(true);
        protocol.set_realtime_execution(true);
        protocol.enable_extension("arcium.mode", "proof-batching");
        protocol.enable_extension("magicblock.session", "enabled");

        let caps = protocol.capabilities();
        assert!(caps.allow_confidential_verification);
        assert!(caps.allow_realtime_execution);
        assert_eq!(
            caps.extension_flags.get("arcium.mode"),
            Some(&"proof-batching".to_string())
        );
    }

    #[test]
    fn insufficient_stake_is_rejected() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 10);

        let result = protocol.claim_job(ClaimJobParams {
            job_id: 10,
            claimer: "worker-low-stake".to_string(),
            stake_usdc: 99,
            now_epoch_secs: 1_000,
        });

        assert_eq!(result, Err(ProtocolError::InsufficientStake));
    }

    #[test]
    fn insufficient_evidence_is_rejected() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 11);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 11,
                claimer: "worker-evidence".to_string(),
                stake_usdc: 100,
                now_epoch_secs: 1_000,
            })
            .expect("claim should pass");

        let result = protocol.submit_proof(SubmitProofParams {
            job_id: 11,
            submitter: "worker-evidence".to_string(),
            proof_hash: "proof-11".to_string(),
            now_epoch_secs: 1_100,
            evidence_refs: vec![],
        });

        assert_eq!(result, Err(ProtocolError::InsufficientEvidence));
    }

    #[test]
    fn pass_settlement_requires_verification_ref_and_delay() {
        let mut protocol = TaskForestProtocol::new();
        create_default_job(&mut protocol, 12);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 12,
                claimer: "worker-verify".to_string(),
                stake_usdc: 100,
                now_epoch_secs: 1_000,
            })
            .expect("claim should pass");

        protocol
            .submit_proof(SubmitProofParams {
                job_id: 12,
                submitter: "worker-verify".to_string(),
                proof_hash: "proof-12".to_string(),
                now_epoch_secs: 1_100,
                evidence_refs: vec!["ci://12".to_string()],
            })
            .expect("proof submit should pass");

        let early = protocol.settle_job(SettleJobParams {
            job_id: 12,
            verdict: Verdict::Pass,
            reason_code: "CHECKS_PASS_ALL".to_string(),
            now_epoch_secs: 1_150,
            verification_backend: VerificationBackend::Native,
            verification_ref: Some("verifier://12".to_string()),
            verifier_approvals: 1,
        });
        assert_eq!(early, Err(ProtocolError::ChallengeWindowNotElapsed));

        let missing_ref = protocol.settle_job(SettleJobParams {
            job_id: 12,
            verdict: Verdict::Pass,
            reason_code: "CHECKS_PASS_ALL".to_string(),
            now_epoch_secs: 1_200,
            verification_backend: VerificationBackend::Native,
            verification_ref: None,
            verifier_approvals: 1,
        });
        assert_eq!(missing_ref, Err(ProtocolError::MissingVerificationRef));
    }

    #[test]
    fn high_value_job_requires_multiple_verifier_approvals() {
        let mut protocol = TaskForestProtocol::new();
        protocol
            .create_job(CreateJobParams {
                job_id: 13,
                poster: "poster-high".to_string(),
                reward_usdc: 20_000,
                deadline_epoch_secs: 5_000,
                proof_spec_hash: "high-value-proof-spec".to_string(),
            })
            .expect("create should pass");

        protocol
            .claim_job(ClaimJobParams {
                job_id: 13,
                claimer: "worker-high".to_string(),
                stake_usdc: 2_000,
                now_epoch_secs: 1_000,
            })
            .expect("claim should pass");

        protocol
            .submit_proof(SubmitProofParams {
                job_id: 13,
                submitter: "worker-high".to_string(),
                proof_hash: "proof-13".to_string(),
                now_epoch_secs: 1_100,
                evidence_refs: vec!["ci://13".to_string()],
            })
            .expect("proof should pass");

        let result = protocol.settle_job(SettleJobParams {
            job_id: 13,
            verdict: Verdict::Pass,
            reason_code: "CHECKS_PASS_ALL".to_string(),
            now_epoch_secs: 1_200,
            verification_backend: VerificationBackend::Native,
            verification_ref: Some("verifier://13".to_string()),
            verifier_approvals: 1,
        });

        assert_eq!(result, Err(ProtocolError::InsufficientVerifierApprovals));
    }

    #[test]
    fn claim_caps_block_hoarding_behavior() {
        let mut protocol = TaskForestProtocol::new();
        protocol.policy_mut().max_active_claims_per_claimer = 1;

        create_default_job(&mut protocol, 14);
        create_default_job(&mut protocol, 15);

        protocol
            .claim_job(ClaimJobParams {
                job_id: 14,
                claimer: "worker-cap".to_string(),
                stake_usdc: 100,
                now_epoch_secs: 1_000,
            })
            .expect("first claim should pass");

        let second = protocol.claim_job(ClaimJobParams {
            job_id: 15,
            claimer: "worker-cap".to_string(),
            stake_usdc: 100,
            now_epoch_secs: 1_000,
        });

        assert_eq!(second, Err(ProtocolError::TooManyActiveClaims));
    }
}
