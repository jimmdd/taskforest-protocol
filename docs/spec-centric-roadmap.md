# TaskForest Spec-Centric Roadmap

**Date**: 2026-03-23  
**Status**: Draft  
**Companion**: `docs/spec-centric-taskforest.md`

This document translates the spec-centric protocol model into an implementation roadmap.

The goal is not to rewrite everything at once. The goal is to move from the current mixed model toward:

- `TTD` as reusable task family
- `Spec` as approved execution contract
- `Job` as funded settlement object

---

## 1. Current State

Today the codebase is split across two mental models:

- protocol/docs still expose a strong TTD-centered story
- `taskforest-app` has already introduced a spec draft / approve / commit flow

Current strengths:

- jobs, escrow, settlement, disputes, proofs exist on-chain
- spec drafts and approval exist off-chain
- verification modes already exist in the app layer
- encrypted split-spec handling has started

Current gaps:

- the core protocol does not yet consistently treat `spec_hash` as first-class
- TTD and spec responsibilities are not cleanly separated in docs or UX
- verification and dispute logic are not yet fully spec-bound on-chain
- routing uses spec hints lightly, not deeply

---

## 2. Target End State

### 2.1 Protocol

Every settled job should be unambiguously tied to:

- `ttd_hash`
- `spec_hash`
- verification mode
- proof / receipt commitments
- dispute window

### 2.2 App Layer

Every posted task should flow through:

1. draft spec
2. approve spec
3. commit spec hash
4. create job
5. execute
6. verify
7. settle or dispute

### 2.3 Market Layer

Routing, reputation, and dispute review should reason about:

- TTD family
- spec properties
- verification mode
- privacy class

---

## 3. Workstreams

There are four main workstreams:

- protocol
- SDK
- app / worker
- migration and adoption

---

## 4. Protocol Roadmap

### Phase P1: Make `spec_hash` First-Class

Goal:

Bind jobs and settlement to the committed spec.

Changes:

- add `spec_hash` to the `Job` state
- require `spec_hash` when initializing a job
- keep `ttd_hash` as a separate field
- persist verification mode in a protocol-facing form

Questions:

- should `spec_hash` be mandatory for all jobs, or only new jobs?
- should verification mode live directly on `Job` or be derived from a compact spec summary commitment?

Recommended answer:

- make `spec_hash` mandatory for new jobs
- keep verification mode directly on `Job` for settlement simplicity

### Phase P2: Add Compact Spec Commitments

Goal:

Carry only settlement-critical spec metadata on-chain.

Potential additions:

- `privacy_mode`
- `verification_mode`
- `criteria_count`
- optional `public_spec_hash`
- optional `private_spec_hash`

Keep the full spec off-chain.

### Phase P3: Make Disputes Spec-Bound

Goal:

Disputes should explicitly challenge the committed contract, not just vague job outcomes.

Changes:

- include `spec_hash` in dispute records or derive it from the job
- standardize dispute reason classes:
  - spec mismatch
  - execution mismatch
  - verification mismatch
- ensure disputes reference the challenged thread / artifact commitment

### Phase P4: Contextual Reputation Hooks

Goal:

Prepare protocol-compatible reputation dimensions without overloading the chain.

Approach:

- keep most reputation computation off-chain initially
- emit or persist enough context to support:
  - TTD-family performance
  - verification-mode performance
  - poster / executor / verifier role slices

### Phase P5: Compressed Archival for Spec-Bound Outcomes

Goal:

Compressed archives should preserve the important contract boundary.

Add or confirm archival support for:

- `spec_hash`
- verification mode
- final verdict
- proof / receipt commitments

---

## 5. SDK Roadmap

### Phase S1: SDK Object Model Cleanup

The SDK should expose the three-object model directly.

Primary types:

- `TaskTypeDefinition`
- `TaskSpec`
- `TaskJob`

Primary flows:

- `createSpecDraft`
- `approveSpec`
- `createJobFromSpec`
- `submitProof`
- `openDispute`
- `settleJob`

### Phase S2: Spec-Aware Builders

Add SDK helpers for:

- canonical spec hashing
- public/private spec partitioning
- compact on-chain summary extraction
- verification mode validation

The SDK should be the canonical source for spec hashing rules.

### Phase S3: Receipt and Verification Helpers

The SDK should provide:

- receipt DAG helpers
- challenge thread helpers
- spot-check selection helpers
- verifier result packaging helpers

### Phase S4: Migration-Friendly APIs

Support both:

- template-assisted job creation from TTD defaults
- fully custom spec-first job creation

This lets apps migrate without a hard cutover.

---

## 6. App / Worker Roadmap

### Phase A1: Unify UX Around Spec-First Posting

Current issue:

The app still exposes a TTD-template-heavy posting flow while the worker is already spec-aware.

Goal:

Make the product language consistent:

- pick a template or TTD family
- generate or edit a spec
- approve spec
- create funded job from approved spec

TTDs should become helpers, not the thing being posted directly.

### Phase A2: Standardize Split-Spec Storage

The worker already supports encrypted drafts. Formalize the shape.

Store:

- public spec blob
- private encrypted blob
- combined commitment

Ensure task creation and retrieval APIs expose:

- `spec_hash`
- `public_spec_hash`
- privacy mode
- verification mode

### Phase A3: Deepen Routing Inputs

Routing should move beyond tags-only matching.

Expand router inputs to include:

- verification mode fitness
- criteria count / complexity
- tool requirements
- privacy compatibility
- benchmark capability vs spec difficulty

This remains off-chain and policy-driven.

### Phase A4: Verification Pipelines by Mode

Implement explicit off-chain pipelines for:

- `poster_review`
- `deterministic_test`
- `judge`
- `tee_attested`
- `hybrid`

Each pipeline should output:

- result
- evidence blob(s)
- criteria results summary
- commitment hashes for settlement/dispute

### Phase A5: Spec-Bound Dispute Review

Dispute interfaces should display:

- approved spec
- challenged criterion or thread
- original output commitment
- challenger evidence
- applicable verification mode

This reduces ambiguity and makes panel resolution more consistent.

---

## 7. Migration Plan

### Step 1

Adopt the vocabulary everywhere:

- template / TTD family
- approved spec
- funded job

This is low risk and should happen first.

### Step 2

Introduce `spec_hash` into protocol and SDK surfaces without removing `ttd_hash`.

This keeps backward compatibility while moving the center of gravity.

### Step 3

Update app posting flow so all new jobs are spec-backed, even if created from TTD templates.

### Step 4

Shift routing and reputation models to read spec-derived signals first, TTD-derived signals second.

### Step 5

Deprecate any product language that implies TTD alone is the contract.

---

## 8. Sequencing Recommendation

The most practical order is:

1. docs and vocabulary alignment
2. protocol `spec_hash` support
3. SDK hashing/builders
4. app posting flow unification
5. verification pipeline standardization
6. dispute and reputation refinement

This sequence minimizes churn and preserves compatibility.

---

## 9. Near-Term Milestones

### Milestone 1: Spec-Bound Jobs

Definition:

- new jobs include `spec_hash`
- SDK can hash and validate specs
- app creates jobs only from approved specs

### Milestone 2: Verification Mode Discipline

Definition:

- every job declares an explicit verification mode
- worker produces structured verification outputs
- disputes reference verification artifacts cleanly

### Milestone 3: Split-Spec Privacy

Definition:

- public routing surface is standardized
- private encrypted section is standardized
- commitments are stable and reproducible

### Milestone 4: Contextual Reputation

Definition:

- routing and profile views show role-specific and mode-specific reputation

---

## 10. Open Design Questions

These are the key decisions still worth discussing before implementation:

- Should `public_spec_hash` and `private_spec_hash` both be on-chain, or only a combined `spec_hash`?
- Should verification mode be immutable after job creation?
- Which verification artifacts should be mandatory for disputes?
- How much of evaluator output should be committed for replayability?
- What is the minimum compact spec summary the chain needs for safe settlement?

---

## 11. Recommended Next Implementation Step

The next concrete engineering step should be:

**Add `spec_hash` to the on-chain job model and thread it through SDK + app job creation.**

Why this first:

- it locks in the right contract boundary
- it does not require solving every verification detail immediately
- it creates a stable foundation for disputes, privacy, and reputation

Once that exists, the rest of the system can evolve around a clean anchor.
