use crate::{
    ActorId, CancelJobParams, ClaimJobParams, CreateJobParams, ExpireClaimParams, JobId,
    SettleJobParams, SubmitProofParams, Verdict, VerificationBackend,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskForestInstruction {
    CreateJob(CreateJobParams),
    ClaimJob(ClaimJobParams),
    SubmitProof(SubmitProofParams),
    SettleJob(SettleJobParams),
    OpenDispute(JobId),
    CancelJob(CancelJobParams),
    ExpireClaim(ExpireClaimParams),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstructionDecodeError {
    EmptyData,
    InvalidFormat,
    InvalidDiscriminator,
    InvalidNumber,
    InvalidVerdict,
}

impl TaskForestInstruction {
    pub fn unpack(input: &[u8]) -> Result<Self, InstructionDecodeError> {
        if input.is_empty() {
            return Err(InstructionDecodeError::EmptyData);
        }
        let text =
            core::str::from_utf8(input).map_err(|_| InstructionDecodeError::InvalidFormat)?;
        let parts: Vec<&str> = text.split('|').collect();
        if parts.is_empty() {
            return Err(InstructionDecodeError::InvalidFormat);
        }

        match parts[0] {
            "create_job" => {
                if parts.len() != 6 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::CreateJob(CreateJobParams {
                    job_id: parse_u64(parts[1])?,
                    poster: parse_actor(parts[2]),
                    reward_usdc: parse_u64(parts[3])?,
                    deadline_epoch_secs: parse_u64(parts[4])?,
                    proof_spec_hash: parts[5].to_string(),
                }))
            }
            "claim_job" => {
                if parts.len() != 5 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::ClaimJob(ClaimJobParams {
                    job_id: parse_u64(parts[1])?,
                    claimer: parse_actor(parts[2]),
                    stake_usdc: parse_u64(parts[3])?,
                    now_epoch_secs: parse_u64(parts[4])?,
                }))
            }
            "submit_proof" => {
                if parts.len() < 5 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::SubmitProof(SubmitProofParams {
                    job_id: parse_u64(parts[1])?,
                    submitter: parse_actor(parts[2]),
                    proof_hash: parts[3].to_string(),
                    now_epoch_secs: parse_u64(parts[4])?,
                    evidence_refs: parts[5..].iter().map(|v| (*v).to_string()).collect(),
                }))
            }
            "settle_job" => {
                if parts.len() != 5 && parts.len() != 6 && parts.len() != 7 && parts.len() != 8 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                let backend = if parts.len() >= 6 {
                    parse_backend(parts[5])
                } else {
                    VerificationBackend::Native
                };
                let mut verification_ref = None;
                let mut verifier_approvals = 1u8;
                if parts.len() == 7 {
                    if let Ok(parsed) = parts[6].parse::<u8>() {
                        verifier_approvals = parsed;
                    } else {
                        verification_ref = Some(parts[6].to_string());
                    }
                } else if parts.len() == 8 {
                    verification_ref = Some(parts[6].to_string());
                    verifier_approvals = parts[7]
                        .parse::<u8>()
                        .map_err(|_| InstructionDecodeError::InvalidNumber)?;
                }
                Ok(Self::SettleJob(SettleJobParams {
                    job_id: parse_u64(parts[1])?,
                    verdict: parse_verdict(parts[2])?,
                    reason_code: parts[3].to_string(),
                    now_epoch_secs: parse_u64(parts[4])?,
                    verification_backend: backend,
                    verification_ref,
                    verifier_approvals,
                }))
            }
            "open_dispute" => {
                if parts.len() != 2 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::OpenDispute(parse_u64(parts[1])?))
            }
            "cancel_job" => {
                if parts.len() != 3 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::CancelJob(CancelJobParams {
                    job_id: parse_u64(parts[1])?,
                    poster: parse_actor(parts[2]),
                }))
            }
            "expire_claim" => {
                if parts.len() != 3 {
                    return Err(InstructionDecodeError::InvalidFormat);
                }
                Ok(Self::ExpireClaim(ExpireClaimParams {
                    job_id: parse_u64(parts[1])?,
                    now_epoch_secs: parse_u64(parts[2])?,
                }))
            }
            _ => Err(InstructionDecodeError::InvalidDiscriminator),
        }
    }
}

fn parse_u64(value: &str) -> Result<u64, InstructionDecodeError> {
    value
        .parse::<u64>()
        .map_err(|_| InstructionDecodeError::InvalidNumber)
}

fn parse_actor(value: &str) -> ActorId {
    value.to_string()
}

fn parse_verdict(value: &str) -> Result<Verdict, InstructionDecodeError> {
    match value {
        "pass" => Ok(Verdict::Pass),
        "fail" => Ok(Verdict::Fail),
        "needs_judge" => Ok(Verdict::NeedsJudge),
        _ => Err(InstructionDecodeError::InvalidVerdict),
    }
}

fn parse_backend(value: &str) -> VerificationBackend {
    match value {
        "native" => VerificationBackend::Native,
        "arcium" => VerificationBackend::Arcium,
        "magicblock" => VerificationBackend::MagicBlock,
        "hybrid" => VerificationBackend::Hybrid,
        other => VerificationBackend::Custom(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_cancel_and_expire_claim() {
        let cancel = TaskForestInstruction::unpack(b"cancel_job|42|poster-x")
            .expect("cancel_job should unpack");
        match cancel {
            TaskForestInstruction::CancelJob(params) => {
                assert_eq!(params.job_id, 42);
                assert_eq!(params.poster, "poster-x");
            }
            _ => panic!("expected cancel_job instruction"),
        }

        let expire = TaskForestInstruction::unpack(b"expire_claim|42|12345")
            .expect("expire_claim should unpack");
        match expire {
            TaskForestInstruction::ExpireClaim(params) => {
                assert_eq!(params.job_id, 42);
                assert_eq!(params.now_epoch_secs, 12345);
            }
            _ => panic!("expected expire_claim instruction"),
        }
    }

    #[test]
    fn reject_invalid_submit_proof_shape() {
        let result = TaskForestInstruction::unpack(b"submit_proof|1|proof-hash-only|2000");
        assert_eq!(result, Err(InstructionDecodeError::InvalidFormat));
    }

    #[test]
    fn settle_instruction_supports_backend_and_ref() {
        let instruction = TaskForestInstruction::unpack(
            b"settle_job|77|pass|CHECKS_PASS_ALL|1000|arcium|arcium://proof/77",
        )
        .expect("settle should unpack");

        match instruction {
            TaskForestInstruction::SettleJob(params) => {
                assert_eq!(params.job_id, 77);
                assert_eq!(params.verification_backend, VerificationBackend::Arcium);
                assert_eq!(
                    params.verification_ref,
                    Some("arcium://proof/77".to_string())
                );
                assert_eq!(params.verifier_approvals, 1);
            }
            _ => panic!("expected settle instruction"),
        }
    }

    #[test]
    fn settle_instruction_supports_ref_and_approvals() {
        let instruction = TaskForestInstruction::unpack(
            b"settle_job|88|pass|CHECKS_PASS_ALL|1000|magicblock|mb://proof/88|3",
        )
        .expect("settle should unpack");

        match instruction {
            TaskForestInstruction::SettleJob(params) => {
                assert_eq!(params.verification_backend, VerificationBackend::MagicBlock);
                assert_eq!(params.verification_ref, Some("mb://proof/88".to_string()));
                assert_eq!(params.verifier_approvals, 3);
            }
            _ => panic!("expected settle instruction"),
        }
    }
}
