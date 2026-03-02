use std::collections::HashMap;

pub type JobId = u64;
pub type ActorId = String;

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub verdict: Verdict,
    pub settled_at_epoch_secs: u64,
    pub reason_code: String,
    pub worker_payout_usdc: u64,
    pub poster_refund_usdc: u64,
    pub stake_returned_usdc: u64,
    pub stake_slashed_usdc: u64,
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
}

#[derive(Debug, Default)]
pub struct TaskForestProtocol {
    jobs: HashMap<JobId, Job>,
}

impl TaskForestProtocol {
    pub fn new() -> Self {
        Self {
            jobs: HashMap::new(),
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
        let job = self
            .jobs
            .get_mut(&params.job_id)
            .ok_or(ProtocolError::JobNotFound)?;

        if job.status != JobStatus::Open {
            return Err(ProtocolError::AlreadyClaimed);
        }
        if params.stake_usdc == 0 {
            return Err(ProtocolError::InvalidAmount);
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
        if job.proof.is_some() {
            return Err(ProtocolError::AlreadySubmitted);
        }

        job.proof = Some(ProofSubmission {
            proof_hash: params.proof_hash,
            submitted_at_epoch_secs: params.now_epoch_secs,
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
        if params.verdict != Verdict::NeedsJudge && job.status != JobStatus::Submitted {
            return Err(ProtocolError::WrongStatus);
        }
        if params.verdict != Verdict::NeedsJudge && job.proof.is_none() {
            return Err(ProtocolError::MissingProof);
        }

        let stake = job.claim.as_ref().map(|c| c.stake_usdc).unwrap_or(0);
        let reward = job.reward_usdc;

        let settlement = match params.verdict {
            Verdict::Pass => Settlement {
                verdict: Verdict::Pass,
                settled_at_epoch_secs: params.now_epoch_secs,
                reason_code: params.reason_code,
                worker_payout_usdc: reward,
                poster_refund_usdc: 0,
                stake_returned_usdc: stake,
                stake_slashed_usdc: 0,
            },
            Verdict::Fail => Settlement {
                verdict: Verdict::Fail,
                settled_at_epoch_secs: params.now_epoch_secs,
                reason_code: params.reason_code,
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

    pub fn get_job(&self, job_id: JobId) -> Option<&Job> {
        self.jobs.get(&job_id)
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
    pub proof_hash: String,
    pub now_epoch_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleJobParams {
    pub job_id: JobId,
    pub verdict: Verdict,
    pub reason_code: String,
    pub now_epoch_secs: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

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
                proof_hash: "proof-hash-123".to_string(),
                now_epoch_secs: 1_200,
            })
            .expect("proof submit should succeed");

        let settlement = protocol
            .settle_job(SettleJobParams {
                job_id: 1,
                verdict: Verdict::Pass,
                reason_code: "CHECKS_PASS_ALL".to_string(),
                now_epoch_secs: 1_300,
            })
            .expect("settle pass should succeed");

        assert_eq!(settlement.worker_payout_usdc, 1_000);
        assert_eq!(settlement.stake_returned_usdc, 200);
        assert_eq!(settlement.poster_refund_usdc, 0);

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
                proof_hash: "bad-proof".to_string(),
                now_epoch_secs: 1_500,
            })
            .expect("proof submit should succeed");

        let settlement = protocol
            .settle_job(SettleJobParams {
                job_id: 2,
                verdict: Verdict::Fail,
                reason_code: "CI_REQUIRED_FAILED".to_string(),
                now_epoch_secs: 1_600,
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
        });

        assert_eq!(result, Err(ProtocolError::WrongStatus));
    }
}
