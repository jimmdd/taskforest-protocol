# TaskForest Protocol

Initial protocol scaffold for TaskForest: a proof-first task network where humans and AI agents assign work, submit verifiable outcomes, and settle rewards on Solana.

## What is implemented now

- Core protocol state machine in pure Rust domain logic.
- Instruction layer with deterministic decoding and dispatch.
- Processor layer to route instructions into state transitions.
- Unit and integration tests covering happy paths and failure paths.

## Construction details

### Module layout

- `src/lib.rs`
  - canonical domain state (`Job`, `Claim`, `Settlement`)
  - state transitions and guards (`create_job`, `claim_job`, `submit_proof`, `settle_job`, `open_dispute`, `cancel_job`, `expire_claim`)
  - protocol errors and parameter structs
- `src/instruction.rs`
  - `TaskForestInstruction` enum
  - `unpack()` decoder for transport payloads
- `src/processor.rs`
  - `process_instruction()` dispatcher
  - normalized output for settlement
- `src/state.rs`
  - snapshot model for external read models/serialization boundaries
- `src/error.rs`
  - shared `ProgramResult` alias for future on-chain wiring

### State model and invariants

- Job lifecycle:
  - `Open -> Claimed -> Submitted -> Done|Failed`
  - optional `Submitted|Failed -> Disputed -> Done|Failed`
  - cancellation path: `Open -> Cancelled`
- Safety invariants:
  - reward and stake must be non-zero where required
  - only open jobs are claimable
  - proof submitter must match recorded claimer
  - settlement requires valid status + proof where applicable
  - timeout expiration can force fail settlement with reason `DEADLINE_EXPIRED`

## Extension-ready design (Arcium + MagicBlock)

This scaffold is intentionally not fixed to a single verification/execution path.

- `VerificationBackend` enum supports:
  - `Native`
  - `Arcium`
  - `MagicBlock`
  - `Hybrid`
  - `Custom(String)` for forward-compatible providers
- Settlement records backend metadata:
  - `verification_backend`
  - `verification_ref` (attestation/proof/receipt URI)
- Proof submissions accept extensible evidence vectors:
  - `evidence_refs: Vec<String>`
- Protocol capabilities are runtime-configurable:
  - `allow_confidential_verification`
  - `allow_realtime_execution`
  - `extension_flags: HashMap<String, String>`

This means Arcium confidential attestations and MagicBlock real-time session receipts can be added without changing the core job lifecycle model.

### Instruction payload format (current scaffold)

Current decoder uses simple pipe-delimited payloads for rapid iteration:

```text
create_job|<job_id>|<poster>|<reward>|<deadline>|<proof_spec_hash>
claim_job|<job_id>|<claimer>|<stake>|<now>
submit_proof|<job_id>|<submitter>|<proof_hash>|<now>
settle_job|<job_id>|<pass|fail|needs_judge>|<reason_code>|<now>
open_dispute|<job_id>
cancel_job|<job_id>|<poster>
expire_claim|<job_id>|<now>

# optional backend metadata on settle
settle_job|<job_id>|<pass|fail|needs_judge>|<reason_code>|<now>|<backend>|<verification_ref>

# optional evidence refs on submit_proof
submit_proof|<job_id>|<submitter>|<proof_hash>|<now>|<evidence_ref_1>|<evidence_ref_2>|...
```

This will be replaced by compact binary instruction encoding in the on-chain Pinocchio layer.

## Why this kickoff

This repo starts with a deterministic state machine and payout semantics before binding to Solana accounts/instructions. The next step is mapping these flows to Pinocchio program accounts and instruction handlers.

## TDD approach used

- Add failing tests first for each new transition/guard.
- Implement the minimum transition logic to satisfy tests.
- Refactor only after all tests are green.
- Keep domain logic deterministic and side-effect free before adding Solana account IO.

## Run tests

```bash
cargo test
```

Run integration tests only:

```bash
cargo test --test protocol_integration
```

Compile checks:

```bash
cargo check
```

## Feature-gated Pinocchio entrypoint scaffold

This repo now includes a `bpf-entrypoint` feature that compiles a minimal Pinocchio program entrypoint in:

- `src/bpf_entrypoint.rs`

What it does now:
- Declares a program id.
- Exposes `process_instruction` via `pinocchio::entrypoint!`.
- Validates/decodes TaskForest instruction payloads.

Build check with the feature enabled:

```bash
cargo check --features bpf-entrypoint
```

This keeps the domain state machine and tests independent while we progressively map account parsing and state persistence for real on-chain execution.

## Next steps

1. Add Pinocchio account layouts (`Job`, `Claim`, config`) and account parsers.
2. Introduce binary instruction encoding/decoding for on-chain execution.
3. Integrate SPL USDC escrow transfers and authority checks.
4. Add verifier signature checks for settlement payloads.
5. Emit program events for indexers and statement generation.
6. Add devnet end-to-end tests for create/claim/proof/settle/dispute flows.
