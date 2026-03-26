"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = __importDefault(require("node:test"));
const web3_js_1 = require("@solana/web3.js");
const index_1 = require("../index");
(0, node_test_1.default)('exports stable public constants', () => {
    strict_1.default.equal(index_1.DARK_FOREST_PROGRAM_ID.toBase58(), '4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs');
    strict_1.default.equal(index_1.ESCROW_SEED.toString(), 'escrow');
    strict_1.default.equal(index_1.SETTLEMENT_SEED.toString(), 'settlement');
    strict_1.default.equal(index_1.PER_ENDPOINTS.devnet, 'https://tee.magicblock.app');
    strict_1.default.ok(index_1.TEE_VALIDATORS.devnet);
});
(0, node_test_1.default)('builds deterministic attestation report envelopes', () => {
    const report = index_1.DarkForestPayments.buildAttestationReport({
        escrowId: 42,
        jobPubkey: index_1.DARK_FOREST_PROGRAM_ID,
        validator: index_1.TEE_VALIDATORS.devnet,
        teePubkey: Array(32).fill(7),
        mppSessionId: Array(32).fill(9),
        issuedAt: 100,
        expiresAt: 200,
    });
    strict_1.default.equal(report.length, 160);
    strict_1.default.equal(report.subarray(0, 4).toString('utf8'), 'TFAT');
});
(0, node_test_1.default)('derives deterministic escrow and settlement PDAs', () => {
    const escrowOne = index_1.DarkForestPayments.escrowPda(42);
    const escrowTwo = index_1.DarkForestPayments.escrowPda(42);
    const settlementOne = index_1.DarkForestPayments.settlementPda(42);
    const settlementTwo = index_1.DarkForestPayments.settlementPda(42);
    strict_1.default.equal(escrowOne.toBase58(), escrowTwo.toBase58());
    strict_1.default.equal(settlementOne.toBase58(), settlementTwo.toBase58());
    strict_1.default.notEqual(escrowOne.toBase58(), settlementOne.toBase58());
});
(0, node_test_1.default)('connectToPer returns a Solana connection', () => {
    const payments = Object.create(index_1.DarkForestPayments.prototype);
    const connection = payments.connectToPer(index_1.PER_ENDPOINTS.devnet);
    strict_1.default.ok(connection instanceof web3_js_1.Connection);
    strict_1.default.equal(connection.rpcEndpoint, index_1.PER_ENDPOINTS.devnet);
});
(0, node_test_1.default)('tracks an in-memory private session lifecycle', async () => {
    const payments = Object.create(index_1.DarkForestPayments.prototype);
    payments.sessionStore = new index_1.MemorySessionStore();
    payments.createEscrowWrapper = async () => 'escrow-tx';
    payments.delegateToPer = async () => 'delegate-tx';
    payments.recordSettlement = async () => 'settlement-tx';
    const session = await payments.startPrivateSession(77, index_1.DARK_FOREST_PROGRAM_ID, {
        agentEndpoint: 'https://agent.taskforest.xyz',
        token: 'SOL',
        budgetLamports: 1500000,
        perEndpoint: index_1.PER_ENDPOINTS.devnet,
    });
    strict_1.default.equal(session.escrowId, 77);
    strict_1.default.equal(session.isActive, true);
    strict_1.default.equal((await payments.getActiveSession(77))?.requestCount, 0);
    await payments.recordPayment(77, 500000);
    strict_1.default.equal((await payments.getActiveSession(77))?.totalPaid, 500000);
    strict_1.default.equal((await payments.getActiveSession(77))?.requestCount, 1);
    const tx = await payments.closeSession(77);
    strict_1.default.equal(tx, 'settlement-tx');
    strict_1.default.equal(await payments.getActiveSession(77), undefined);
});
(0, node_test_1.default)('returns null for unreadable escrow and settlement accounts', async () => {
    const payments = Object.create(index_1.DarkForestPayments.prototype);
    payments.program = {
        account: {
            escrowWrapper: { fetch: async () => { throw new Error('missing'); } },
            settlementRecord: { fetch: async () => { throw new Error('missing'); } },
        },
    };
    strict_1.default.equal(await payments.getEscrow(5), null);
    strict_1.default.equal(await payments.getSettlement(5), null);
});
(0, node_test_1.default)('persists sessions in local storage compatible store', async () => {
    const backing = new Map();
    const storage = {
        getItem(key) { return backing.get(key) ?? null; },
        setItem(key, value) { backing.set(key, value); },
        removeItem(key) { backing.delete(key); },
        clear() { backing.clear(); },
        key(index) { return Array.from(backing.keys())[index] ?? null; },
        get length() { return backing.size; },
    };
    const store = new index_1.LocalStorageSessionStore(storage);
    await store.set({ sessionId: 'abc', escrowId: 5, totalPaid: 7, requestCount: 2, isActive: true });
    strict_1.default.equal((await store.get(5))?.sessionId, 'abc');
    await store.delete(5);
    strict_1.default.equal(await store.get(5), null);
});
(0, node_test_1.default)('verifies json-backed tdx quote claims against policy and builds attestation envelope', async () => {
    const verifier = new index_1.JsonTdxQuoteVerifier(index_1.TEE_VALIDATORS.devnet);
    const now = Math.floor(Date.now() / 1000);
    const quote = Buffer.from(JSON.stringify({
        teePubkey: Array(32).fill(3),
        mrTd: 'abcd',
        rtmr0: 'ef01',
        issuedAt: now - 60,
        expiresAt: now + 300,
    }));
    const verified = await verifier.verifyQuote(quote, {
        allowedMrTd: ['abcd'],
        allowedRtmr0: ['ef01'],
    });
    const envelope = (0, index_1.buildVerifiedAttestationEnvelope)(9, index_1.DARK_FOREST_PROGRAM_ID, Array(32).fill(4), verified);
    strict_1.default.equal(envelope.escrowId, 9);
    strict_1.default.equal(envelope.validator.toBase58(), index_1.TEE_VALIDATORS.devnet.toBase58());
    strict_1.default.equal(envelope.teePubkey.length, 32);
});
