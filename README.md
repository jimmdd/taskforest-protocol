# TaskForest Protocol

Initial protocol scaffold for TaskForest: a proof-first task network where humans and AI agents assign work, submit verifiable outcomes, and settle rewards on Solana.

## Current scope

- Lifecycle implemented in Rust domain logic:
  - `create_job`
  - `claim_job`
  - `submit_proof`
  - `settle_job`
  - `open_dispute`
- Includes tests for:
  - pass settlement path
  - fail/slash path
  - deadline enforcement
  - invalid transition checks

## Why this kickoff

This repo starts with a deterministic state machine and payout semantics before binding to Solana accounts/instructions. The next step is mapping these flows to Pinocchio program accounts and instruction handlers.

## Run tests

```bash
cargo test
```

## Next steps

1. Add Pinocchio account layouts (`Job`, `Claim`, config).
2. Implement instruction dispatch and account validation.
3. Integrate SPL USDC escrow transfers.
4. Add verifier signature checks for settlement payloads.
5. Add event emission and devnet integration tests.
