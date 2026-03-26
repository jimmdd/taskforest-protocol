"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DarkForestPayments = exports.LocalStorageSessionStore = exports.MemorySessionStore = exports.PER_ENDPOINTS = exports.TEE_VALIDATORS = exports.SETTLEMENT_SEED = exports.ESCROW_SEED = exports.DARK_FOREST_PROGRAM_ID = void 0;
const anchor_1 = require("@coral-xyz/anchor");
const web3_js_1 = require("@solana/web3.js");
__exportStar(require("./verifier"), exports);
exports.DARK_FOREST_PROGRAM_ID = new web3_js_1.PublicKey('4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs');
exports.ESCROW_SEED = Buffer.from('escrow');
exports.SETTLEMENT_SEED = Buffer.from('settlement');
exports.TEE_VALIDATORS = {
    mainnet: new web3_js_1.PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'),
    devnet: new web3_js_1.PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'),
};
exports.PER_ENDPOINTS = {
    mainnet: 'https://mainnet-tee.magicblock.app',
    devnet: 'https://tee.magicblock.app',
    devnetRouter: 'https://devnet-router.magicblock.app',
};
class MemorySessionStore {
    constructor() {
        this.sessions = new Map();
    }
    async get(escrowId) {
        return this.sessions.get(escrowId) ?? null;
    }
    async set(session) {
        this.sessions.set(session.escrowId, session);
    }
    async delete(escrowId) {
        this.sessions.delete(escrowId);
    }
}
exports.MemorySessionStore = MemorySessionStore;
class LocalStorageSessionStore {
    constructor(storage, prefix = 'taskforest:dark-forest:session:') {
        this.storage = storage;
        this.prefix = prefix;
    }
    key(escrowId) {
        return `${this.prefix}${escrowId}`;
    }
    async get(escrowId) {
        const raw = this.storage.getItem(this.key(escrowId));
        return raw ? JSON.parse(raw) : null;
    }
    async set(session) {
        this.storage.setItem(this.key(session.escrowId), JSON.stringify(session));
    }
    async delete(escrowId) {
        this.storage.removeItem(this.key(escrowId));
    }
}
exports.LocalStorageSessionStore = LocalStorageSessionStore;
function deriveEscrowPda(escrowId) {
    return web3_js_1.PublicKey.findProgramAddressSync([exports.ESCROW_SEED, new anchor_1.BN(escrowId).toArrayLike(Buffer, 'le', 8)], exports.DARK_FOREST_PROGRAM_ID);
}
function deriveSettlementPda(escrowId) {
    return web3_js_1.PublicKey.findProgramAddressSync([exports.SETTLEMENT_SEED, new anchor_1.BN(escrowId).toArrayLike(Buffer, 'le', 8)], exports.DARK_FOREST_PROGRAM_ID);
}
class DarkForestPayments {
    constructor(provider, idl, options = {}) {
        this.provider = provider;
        this.program = new anchor_1.Program(idl, provider);
        this.sessionStore = options.sessionStore ?? new MemorySessionStore();
    }
    connectToPer(endpoint = exports.PER_ENDPOINTS.devnet) {
        return new web3_js_1.Connection(endpoint, 'confirmed');
    }
    static buildAttestationReport(envelope) {
        return Buffer.concat([
            Buffer.from('TFAT'),
            Buffer.from([1, 0, 0, 0]),
            new anchor_1.BN(envelope.escrowId).toArrayLike(Buffer, 'le', 8),
            envelope.jobPubkey.toBuffer(),
            envelope.validator.toBuffer(),
            Buffer.from(envelope.teePubkey),
            Buffer.from(envelope.mppSessionId),
            new anchor_1.BN(envelope.issuedAt).toTwos(64).toArrayLike(Buffer, 'le', 8),
            new anchor_1.BN(envelope.expiresAt).toTwos(64).toArrayLike(Buffer, 'le', 8),
        ]);
    }
    static buildAttestationSignatureInstruction(validatorSigner, report) {
        return web3_js_1.Ed25519Program.createInstructionWithPrivateKey({
            privateKey: validatorSigner.secretKey,
            message: report,
        });
    }
    async createEscrowWrapper(escrowId, jobPubkey, depositSol, mppSessionId = Array(32).fill(0)) {
        const [escrowPda] = deriveEscrowPda(escrowId);
        return this.program.methods
            .createEscrowWrapper(new anchor_1.BN(escrowId), new anchor_1.BN(Math.floor(depositSol * web3_js_1.LAMPORTS_PER_SOL)), mppSessionId)
            .accounts({
            job: jobPubkey,
            escrow: escrowPda,
            poster: this.provider.wallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
    }
    async delegateToPer(escrowId, validator) {
        const [escrowPda] = deriveEscrowPda(escrowId);
        const method = this.program.methods
            .delegateToPer(new anchor_1.BN(escrowId))
            .accounts({
            pda: escrowPda,
            payer: this.provider.wallet.publicKey,
        });
        if (validator) {
            return method
                .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }])
                .rpc();
        }
        return method.rpc();
    }
    async verifyTeeAttestation(escrowId, attestationReport, teePubkey, signatureInstruction) {
        const [escrowPda] = deriveEscrowPda(escrowId);
        const method = this.program.methods
            .verifyTeeAttestation(new anchor_1.BN(escrowId), attestationReport, teePubkey)
            .accounts({
            escrow: escrowPda,
            validator: this.provider.wallet.publicKey,
            payer: this.provider.wallet.publicKey,
            instructionsSysvar: web3_js_1.SYSVAR_INSTRUCTIONS_PUBKEY,
        });
        if (signatureInstruction) {
            return method.preInstructions([signatureInstruction]).rpc();
        }
        return method
            .rpc();
    }
    async recordSettlement(escrowId, totalPaidSol) {
        const [escrowPda] = deriveEscrowPda(escrowId);
        const [settlementPda] = deriveSettlementPda(escrowId);
        const escrow = await this.getEscrow(escrowId);
        if (!escrow)
            throw new Error(`Escrow ${escrowId} not found`);
        return this.program.methods
            .recordSettlement(new anchor_1.BN(escrowId), new anchor_1.BN(Math.floor(totalPaidSol * web3_js_1.LAMPORTS_PER_SOL)))
            .accounts({
            escrow: escrowPda,
            settlementRecord: settlementPda,
            poster: this.provider.wallet.publicKey,
            agent: escrow.agent,
            payer: this.provider.wallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .rpc();
    }
    async startPrivateSession(escrowId, jobPubkey, config) {
        const depositSol = config.budgetLamports / web3_js_1.LAMPORTS_PER_SOL;
        const sessionId = `dark-${escrowId}-${Date.now()}`;
        const sessionIdBytes = Array.from(Buffer.from(sessionId.padEnd(32, '\0').slice(0, 32)));
        await this.createEscrowWrapper(escrowId, jobPubkey, depositSol, sessionIdBytes);
        await this.delegateToPer(escrowId);
        const session = {
            sessionId,
            escrowId,
            totalPaid: 0,
            requestCount: 0,
            isActive: true,
        };
        await this.sessionStore.set(session);
        return session;
    }
    async recordPayment(escrowId, amountLamports) {
        const session = await this.sessionStore.get(escrowId);
        if (!session || !session.isActive)
            throw new Error('No active session for this escrow');
        await this.sessionStore.set({
            ...session,
            totalPaid: session.totalPaid + amountLamports,
            requestCount: session.requestCount + 1,
        });
    }
    async closeSession(escrowId) {
        const session = await this.sessionStore.get(escrowId);
        if (!session)
            throw new Error('No session for this escrow');
        await this.sessionStore.set({ ...session, isActive: false });
        const totalPaidSol = session.totalPaid / web3_js_1.LAMPORTS_PER_SOL;
        const tx = await this.recordSettlement(escrowId, totalPaidSol);
        await this.sessionStore.delete(escrowId);
        return tx;
    }
    async getActiveSession(escrowId) {
        return (await this.sessionStore.get(escrowId)) ?? undefined;
    }
    async getEscrow(escrowId) {
        const [escrowPda] = deriveEscrowPda(escrowId);
        try {
            const account = await this.program.account.escrowWrapper.fetch(escrowPda);
            const statusMap = { 0: 'Active', 1: 'Delegated', 2: 'Settled' };
            return {
                escrowId: account.escrowId.toNumber(),
                jobPubkey: account.jobPubkey,
                poster: account.poster,
                agent: account.agent,
                deposited: account.deposited.toNumber(),
                status: statusMap[account.status.active !== undefined ? 0 : account.status.delegated !== undefined ? 1 : 2] ?? 'Active',
                teePubkey: account.teePubkey,
                teeVerified: account.teeVerified,
                mppSessionId: account.mppSessionId,
                createdAt: account.createdAt.toNumber(),
            };
        }
        catch {
            return null;
        }
    }
    async getSettlement(escrowId) {
        const [settlementPda] = deriveSettlementPda(escrowId);
        try {
            const account = await this.program.account.settlementRecord.fetch(settlementPda);
            return {
                escrowId: account.escrowId.toNumber(),
                jobPubkey: account.jobPubkey,
                poster: account.poster,
                agent: account.agent,
                totalDeposited: account.totalDeposited.toNumber(),
                totalPaid: account.totalPaid.toNumber(),
                settledAt: account.settledAt.toNumber(),
                settlementHash: account.settlementHash,
            };
        }
        catch {
            return null;
        }
    }
    static escrowPda(escrowId) {
        return deriveEscrowPda(escrowId)[0];
    }
    static settlementPda(escrowId) {
        return deriveSettlementPda(escrowId)[0];
    }
}
exports.DarkForestPayments = DarkForestPayments;
