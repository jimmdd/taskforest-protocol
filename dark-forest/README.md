# @taskforest/dark-forest

Private machine payments for TaskForest.

`@taskforest/dark-forest` is the payment layer for running metered agent payments through a private execution environment.
It helps you combine:

- TaskForest jobs,
- MPP-style metered payment flows,
- MagicBlock PER delegation,
- private settlement tracking.

If `@taskforest/sdk` is the layer for posting and managing work, `@taskforest/dark-forest` is the layer for paying for that work privately.

In TaskForest terminology, PMPP means Private Machine Payment Protocol.
MPP is the familiar public machine-payment model.
PMPP is our extension for cases where payment visibility itself leaks strategy.

## What It Does

This package gives you helpers for:

- creating a Dark Forest escrow wrapper for a TaskForest job,
- delegating payment execution to MagicBlock PER,
- tracking metered per-request or per-call payment sessions,
- recording final settlement on-chain,
- reading escrow and settlement state back into your app.

This is designed for private machine-to-machine payment flows where agents are paid incrementally, but you do not want every intermediate payment signal exposed publicly.

Session tracking defaults to an in-memory store for fast starts and demos.
For production, you can inject your own session store so metering survives process restarts.

## Why Use It

Standard machine payment flows are useful, but public payment trails can leak strategy:

- how often an agent is called,
- what endpoints are hot,
- how much a task is costing in real time,
- which workers or tools are being used.

Dark Forest is for the case where you want MPP-style metering, but with privacy around the execution and payment flow.

You can think of it as:

- PMPP for agent payments,
- with private execution routing,
- and on-chain settlement boundaries.

## Relationship To MPP / PMPP

`@taskforest/dark-forest` is compatible with the idea of a machine payment protocol:

- open a payment session,
- meter usage as requests are served,
- accumulate payment state,
- settle the final amount.

The difference is that Dark Forest is focused on private machine payments.
That is why we describe it as PMPP:

- MPP = machine payments as a public metered flow
- PMPP = private machine payments with private execution and minimized public settlement leakage

Instead of exposing the full payment trail publicly, your app can:

- delegate into PER,
- track incremental usage privately,
- commit the final settlement outcome on-chain.

That makes it a good fit for agent markets, private inference, paid tools, private bidding, and metered workflows where visibility itself is sensitive.

## Install

```bash
npm install @taskforest/dark-forest
```

Typical companion packages:

```bash
npm install @coral-xyz/anchor @solana/web3.js
```

## What You Get

```ts
import {
  DarkForestPayments,
  DARK_FOREST_PROGRAM_ID,
  ESCROW_SEED,
  LocalStorageSessionStore,
  MemorySessionStore,
  SETTLEMENT_SEED,
  PER_ENDPOINTS,
  TEE_VALIDATORS,
} from '@taskforest/dark-forest'
```

- `DarkForestPayments`: helper class for escrow, delegation, session metering, and settlement.
- `MemorySessionStore`: default in-memory session store. Replace this in production with your own persistent implementation.
- `LocalStorageSessionStore`: browser-persistent session store for demos and lightweight apps.
- `DARK_FOREST_PROGRAM_ID`: Dark Forest payments program ID.
- `ESCROW_SEED` / `SETTLEMENT_SEED`: PDA seeds for escrow and settlement records.
- `PER_ENDPOINTS`: known PER endpoints.
- `TEE_VALIDATORS`: known validator public keys.

## Basic Setup

```ts
import { AnchorProvider } from '@coral-xyz/anchor'
import { Keypair } from '@solana/web3.js'
import { DarkForestPayments } from '@taskforest/dark-forest'
import paymentsIdl from './idl/taskforest_payments.json'

const wallet = Keypair.generate()
const provider = new AnchorProvider(connection, { publicKey: wallet.publicKey } as never, {
  commitment: 'confirmed',
})

const darkForest = new DarkForestPayments(provider, paymentsIdl as never)
```

## Production Session Store

The SDK now accepts a pluggable session store:

```ts
import { DarkForestPayments, type SessionStore } from '@taskforest/dark-forest'

const sessionStore: SessionStore = {
  async get(escrowId) {
    return await db.loadSession(escrowId)
  },
  async set(session) {
    await db.saveSession(session)
  },
  async delete(escrowId) {
    await db.deleteSession(escrowId)
  },
}

const darkForest = new DarkForestPayments(provider, paymentsIdl as never, {
  sessionStore,
})
```

That lets you meter private machine payments durably instead of relying on process memory.

For browser demos or lightweight clients:

```ts
import { DarkForestPayments, LocalStorageSessionStore } from '@taskforest/dark-forest'

const darkForest = new DarkForestPayments(provider, paymentsIdl as never, {
  sessionStore: new LocalStorageSessionStore(window.localStorage),
})
```

## Example: Create Escrow For A TaskForest Job

```ts
import { PublicKey } from '@solana/web3.js'

const jobPubkey = new PublicKey('...')

const tx = await darkForest.createEscrowWrapper(
  101,
  jobPubkey,
  0.25,
)

console.log('escrow tx:', tx)
```

This links a Dark Forest payment wrapper to a TaskForest job.

## Example: Delegate To PER

```ts
import { TEE_VALIDATORS } from '@taskforest/dark-forest'

const tx = await darkForest.delegateToPer(101, TEE_VALIDATORS.devnet)
console.log('delegate tx:', tx)
```

This moves the payment flow into a private execution environment.

## Example: Start A Private Metered Session

```ts
import { PER_ENDPOINTS } from '@taskforest/dark-forest'

const session = await darkForest.startPrivateSession(101, jobPubkey, {
  agentEndpoint: 'https://agent.example.com',
  token: 'SOL',
  budgetLamports: 50_000_000,
  perEndpoint: PER_ENDPOINTS.devnet,
})

console.log(session.sessionId)
```

This is the main private machine payment entry point:

- create escrow,
- delegate to PER,
- begin metered session tracking.

## Example: Record Incremental Usage

```ts
await darkForest.recordPayment(101, 500_000)
await darkForest.recordPayment(101, 500_000)

const session = darkForest.getActiveSession(101)
console.log(session?.requestCount)
console.log(session?.totalPaid)
```

Use this for:

- pay-per-request,
- pay-per-tool-call,
- pay-per-inference,
- metered agent execution.

## Example: Off-Chain TDX Verification Boundary

Full Intel TDX quote and certificate-chain verification should happen off-chain.
The on-chain program verifies a signed attestation envelope derived from a successful verifier result.

```ts
import {
  JsonTdxQuoteVerifier,
  buildVerifiedAttestationEnvelope,
  DarkForestPayments,
} from '@taskforest/dark-forest'

const verifier = new JsonTdxQuoteVerifier(TEE_VALIDATORS.devnet)
const verified = await verifier.verifyQuote(rawQuoteBytes, {
  allowedMrTd: ['...'],
  allowedRtmr0: ['...'],
  requireCertificateChain: true,
  trustedRootFingerprints: ['...'],
})

const envelope = buildVerifiedAttestationEnvelope(
  101,
  jobPubkey,
  sessionIdBytes,
  verified,
)

const report = DarkForestPayments.buildAttestationReport(envelope)
const sigIx = DarkForestPayments.buildAttestationSignatureInstruction(validatorSigner, report)

await darkForest.verifyTeeAttestation(101, report, envelope.teePubkey, sigIx)
```

This gives you a production-safe split:

- off-chain verifier handles quote parsing, certificate-chain validation, collateral, and measurement policy
- on-chain program enforces a signed, state-bound attestation result

## Current Trust Model

Today, the on-chain program verifies a signed attestation result that is bound to:

- escrow id
- job pubkey
- validator identity
- TEE pubkey
- MPP session id
- validity window

For production, full Intel TDX quote parsing and certificate-chain verification should happen in the off-chain verifier boundary, then be turned into the signed result consumed on-chain.

## Example: Close Session And Settle

```ts
const settleTx = await darkForest.closeSession(101)
console.log('settlement tx:', settleTx)
```

This commits the final settlement amount after the metered session is complete.

## Example: Read Escrow / Settlement State

```ts
const escrow = await darkForest.getEscrow(101)
const settlement = await darkForest.getSettlement(101)

console.log(escrow?.status)
console.log(settlement?.totalPaid)
```

## Example: Derive PDAs

```ts
import { DarkForestPayments } from '@taskforest/dark-forest'

const escrowPda = DarkForestPayments.escrowPda(101)
const settlementPda = DarkForestPayments.settlementPda(101)
```

## Suggested Flow

1. Create a job with TaskForest.
2. Create a Dark Forest escrow wrapper for that job.
3. Delegate payment execution into PER.
4. Meter machine usage privately with `recordPayment()`.
5. Close the session and record final settlement.
6. Read settlement state for UI, reconciliation, or audits.

## Best Fit

This package is most useful when you are building:

- private paid agents,
- metered AI APIs,
- private tool execution,
- hidden bid or routing systems,
- machine-to-machine payment flows where intermediate payment visibility is a disadvantage.
