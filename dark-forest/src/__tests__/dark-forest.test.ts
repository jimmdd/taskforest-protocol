import assert from 'node:assert/strict'
import test from 'node:test'
import { Connection } from '@solana/web3.js'

import {
  DARK_FOREST_PROGRAM_ID,
  DarkForestPayments,
  JsonTdxQuoteVerifier,
  ESCROW_SEED,
  LocalStorageSessionStore,
  MemorySessionStore,
  PER_ENDPOINTS,
  SETTLEMENT_SEED,
  TEE_VALIDATORS,
  buildVerifiedAttestationEnvelope,
} from '../index'

test('exports stable public constants', () => {
  assert.equal(DARK_FOREST_PROGRAM_ID.toBase58(), '4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs')
  assert.equal(ESCROW_SEED.toString(), 'escrow')
  assert.equal(SETTLEMENT_SEED.toString(), 'settlement')
  assert.equal(PER_ENDPOINTS.devnet, 'https://tee.magicblock.app')
  assert.ok(TEE_VALIDATORS.devnet)
})

test('builds deterministic attestation report envelopes', () => {
  const report = DarkForestPayments.buildAttestationReport({
    escrowId: 42,
    jobPubkey: DARK_FOREST_PROGRAM_ID,
    validator: TEE_VALIDATORS.devnet,
    teePubkey: Array(32).fill(7),
    mppSessionId: Array(32).fill(9),
    issuedAt: 100,
    expiresAt: 200,
  })

  assert.equal(report.length, 160)
  assert.equal(report.subarray(0, 4).toString('utf8'), 'TFAT')
})

test('derives deterministic escrow and settlement PDAs', () => {
  const escrowOne = DarkForestPayments.escrowPda(42)
  const escrowTwo = DarkForestPayments.escrowPda(42)
  const settlementOne = DarkForestPayments.settlementPda(42)
  const settlementTwo = DarkForestPayments.settlementPda(42)

  assert.equal(escrowOne.toBase58(), escrowTwo.toBase58())
  assert.equal(settlementOne.toBase58(), settlementTwo.toBase58())
  assert.notEqual(escrowOne.toBase58(), settlementOne.toBase58())
})

test('connectToPer returns a Solana connection', () => {
  const payments = Object.create(DarkForestPayments.prototype) as any
  const connection = payments.connectToPer(PER_ENDPOINTS.devnet)

  assert.ok(connection instanceof Connection)
  assert.equal((connection as Connection).rpcEndpoint, PER_ENDPOINTS.devnet)
})

test('tracks an in-memory private session lifecycle', async () => {
  const payments = Object.create(DarkForestPayments.prototype) as any

  payments.sessionStore = new MemorySessionStore()
  payments.createEscrowWrapper = async () => 'escrow-tx'
  payments.delegateToPer = async () => 'delegate-tx'
  payments.recordSettlement = async () => 'settlement-tx'

  const session = await payments.startPrivateSession(77, DARK_FOREST_PROGRAM_ID, {
    agentEndpoint: 'https://agent.taskforest.xyz',
    token: 'SOL',
    budgetLamports: 1_500_000,
    perEndpoint: PER_ENDPOINTS.devnet,
  })

  assert.equal(session.escrowId, 77)
  assert.equal(session.isActive, true)
  assert.equal((await payments.getActiveSession(77))?.requestCount, 0)

  await payments.recordPayment(77, 500_000)
  assert.equal((await payments.getActiveSession(77))?.totalPaid, 500_000)
  assert.equal((await payments.getActiveSession(77))?.requestCount, 1)

  const tx = await payments.closeSession(77)
  assert.equal(tx, 'settlement-tx')
  assert.equal(await payments.getActiveSession(77), undefined)
})

test('returns null for unreadable escrow and settlement accounts', async () => {
  const payments = Object.create(DarkForestPayments.prototype) as any

  payments.program = {
    account: {
      escrowWrapper: { fetch: async () => { throw new Error('missing') } },
      settlementRecord: { fetch: async () => { throw new Error('missing') } },
    },
  }

  assert.equal(await payments.getEscrow(5), null)
  assert.equal(await payments.getSettlement(5), null)
})

test('persists sessions in local storage compatible store', async () => {
  const backing = new Map<string, string>()
  const storage = {
    getItem(key: string) { return backing.get(key) ?? null },
    setItem(key: string, value: string) { backing.set(key, value) },
    removeItem(key: string) { backing.delete(key) },
    clear() { backing.clear() },
    key(index: number) { return Array.from(backing.keys())[index] ?? null },
    get length() { return backing.size },
  } as Storage

  const store = new LocalStorageSessionStore(storage)
  await store.set({ sessionId: 'abc', escrowId: 5, totalPaid: 7, requestCount: 2, isActive: true })
  assert.equal((await store.get(5))?.sessionId, 'abc')
  await store.delete(5)
  assert.equal(await store.get(5), null)
})

test('verifies json-backed tdx quote claims against policy and builds attestation envelope', async () => {
  const verifier = new JsonTdxQuoteVerifier(TEE_VALIDATORS.devnet)
  const now = Math.floor(Date.now() / 1000)
  const quote = Buffer.from(JSON.stringify({
    teePubkey: Array(32).fill(3),
    mrTd: 'abcd',
    rtmr0: 'ef01',
    issuedAt: now - 60,
    expiresAt: now + 300,
  }))

  const verified = await verifier.verifyQuote(quote, {
    allowedMrTd: ['abcd'],
    allowedRtmr0: ['ef01'],
  })
  const envelope = buildVerifiedAttestationEnvelope(
    9,
    DARK_FOREST_PROGRAM_ID,
    Array(32).fill(4),
    verified,
  )

  assert.equal(envelope.escrowId, 9)
  assert.equal(envelope.validator.toBase58(), TEE_VALIDATORS.devnet.toBase58())
  assert.equal(envelope.teePubkey.length, 32)
})
