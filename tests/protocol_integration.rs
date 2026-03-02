use taskforest_protocol::instruction::TaskForestInstruction;
use taskforest_protocol::processor::{process_instruction, ProcessorOutput};
use taskforest_protocol::{
    CancelJobParams, ClaimJobParams, CreateJobParams, ExpireClaimParams, JobStatus, ProtocolError,
    SubmitProofParams, TaskForestProtocol, VerificationBackend,
};

fn seed_job(protocol: &mut TaskForestProtocol, id: u64) {
    protocol
        .create_job(CreateJobParams {
            job_id: id,
            poster: "poster-int".to_string(),
            reward_usdc: 5_000,
            deadline_epoch_secs: 10_000,
            proof_spec_hash: format!("spec-{id}"),
        })
        .expect("job seeding should succeed");
}

#[test]
fn integration_full_flow_via_instruction_dispatch() {
    let mut protocol = TaskForestProtocol::new();

    process_instruction(
        &mut protocol,
        TaskForestInstruction::unpack(b"create_job|100|poster-int|5000|10000|spec-100")
            .expect("create unpack"),
    )
    .expect("create should process");

    process_instruction(
        &mut protocol,
        TaskForestInstruction::unpack(b"claim_job|100|worker-int|700|9000").expect("claim unpack"),
    )
    .expect("claim should process");

    process_instruction(
        &mut protocol,
        TaskForestInstruction::unpack(
            b"submit_proof|100|worker-int|proof-int|9500|ci://100|artifact://100",
        )
        .expect("submit unpack"),
    )
    .expect("submit should process");

    let output = process_instruction(
        &mut protocol,
        TaskForestInstruction::unpack(b"settle_job|100|pass|CHECKS_PASS_ALL|9600")
            .expect("settle unpack"),
    )
    .expect("settle should process");

    match output {
        ProcessorOutput::Settled(settlement) => {
            assert_eq!(settlement.worker_payout_usdc, 5_000);
            assert_eq!(settlement.stake_returned_usdc, 700);
            assert_eq!(settlement.verification_backend, VerificationBackend::Native);
        }
        ProcessorOutput::None => panic!("expected settlement output"),
    }

    let job = protocol.get_job(100).expect("job should exist");
    assert_eq!(job.status, JobStatus::Done);
}

#[test]
fn integration_cancel_requires_poster_auth() {
    let mut protocol = TaskForestProtocol::new();
    seed_job(&mut protocol, 101);

    let unauthorized = process_instruction(
        &mut protocol,
        TaskForestInstruction::CancelJob(CancelJobParams {
            job_id: 101,
            poster: "not-poster".to_string(),
        }),
    );

    assert_eq!(unauthorized, Err(ProtocolError::Unauthorized));

    process_instruction(
        &mut protocol,
        TaskForestInstruction::CancelJob(CancelJobParams {
            job_id: 101,
            poster: "poster-int".to_string(),
        }),
    )
    .expect("authorized cancel should pass");

    let job = protocol.get_job(101).expect("job should exist");
    assert_eq!(job.status, JobStatus::Cancelled);
}

#[test]
fn integration_expire_claim_transitions_and_sets_settlement() {
    let mut protocol = TaskForestProtocol::new();
    seed_job(&mut protocol, 102);

    process_instruction(
        &mut protocol,
        TaskForestInstruction::ClaimJob(ClaimJobParams {
            job_id: 102,
            claimer: "worker-timeout".to_string(),
            stake_usdc: 300,
            now_epoch_secs: 8_000,
        }),
    )
    .expect("claim should pass");

    process_instruction(
        &mut protocol,
        TaskForestInstruction::ExpireClaim(ExpireClaimParams {
            job_id: 102,
            now_epoch_secs: 10_001,
        }),
    )
    .expect("expire claim should pass");

    let job = protocol.get_job(102).expect("job should exist");
    assert_eq!(job.status, JobStatus::Failed);
    let settlement = job
        .settlement
        .as_ref()
        .expect("expiration should create settlement");
    assert_eq!(settlement.reason_code, "DEADLINE_EXPIRED");
    assert_eq!(settlement.poster_refund_usdc, 5_000);
    assert_eq!(settlement.stake_slashed_usdc, 300);
}

#[test]
fn integration_submitter_must_match_claimer() {
    let mut protocol = TaskForestProtocol::new();
    seed_job(&mut protocol, 103);

    process_instruction(
        &mut protocol,
        TaskForestInstruction::ClaimJob(ClaimJobParams {
            job_id: 103,
            claimer: "worker-right".to_string(),
            stake_usdc: 120,
            now_epoch_secs: 8_500,
        }),
    )
    .expect("claim should pass");

    let result = process_instruction(
        &mut protocol,
        TaskForestInstruction::SubmitProof(SubmitProofParams {
            job_id: 103,
            submitter: "worker-wrong".to_string(),
            proof_hash: "proof-103".to_string(),
            now_epoch_secs: 8_700,
            evidence_refs: vec![],
        }),
    );

    assert_eq!(result, Err(ProtocolError::InvalidClaimant));
}
