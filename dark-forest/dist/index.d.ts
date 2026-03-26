import { AnchorProvider, type Idl } from '@coral-xyz/anchor';
import { Connection, type Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
export * from './verifier';
export declare const DARK_FOREST_PROGRAM_ID: PublicKey;
export declare const ESCROW_SEED: Buffer<ArrayBuffer>;
export declare const SETTLEMENT_SEED: Buffer<ArrayBuffer>;
export declare const TEE_VALIDATORS: {
    readonly mainnet: PublicKey;
    readonly devnet: PublicKey;
};
export declare const PER_ENDPOINTS: {
    readonly mainnet: "https://mainnet-tee.magicblock.app";
    readonly devnet: "https://tee.magicblock.app";
    readonly devnetRouter: "https://devnet-router.magicblock.app";
};
export type MppSessionConfig = {
    agentEndpoint: string;
    token: 'SOL' | 'USDC' | 'PYUSD';
    budgetLamports: number;
    perEndpoint: string;
};
export type MppSessionState = {
    sessionId: string;
    escrowId: number;
    totalPaid: number;
    requestCount: number;
    isActive: boolean;
};
export interface SessionStore {
    get(escrowId: number): Promise<MppSessionState | null>;
    set(session: MppSessionState): Promise<void>;
    delete(escrowId: number): Promise<void>;
}
export declare class MemorySessionStore implements SessionStore {
    private sessions;
    get(escrowId: number): Promise<MppSessionState | null>;
    set(session: MppSessionState): Promise<void>;
    delete(escrowId: number): Promise<void>;
}
export declare class LocalStorageSessionStore implements SessionStore {
    private readonly storage;
    private readonly prefix;
    constructor(storage: Storage, prefix?: string);
    private key;
    get(escrowId: number): Promise<MppSessionState | null>;
    set(session: MppSessionState): Promise<void>;
    delete(escrowId: number): Promise<void>;
}
export interface EscrowState {
    escrowId: number;
    jobPubkey: PublicKey;
    poster: PublicKey;
    agent: PublicKey;
    deposited: number;
    status: 'Active' | 'Delegated' | 'Settled';
    teePubkey: number[];
    teeVerified: boolean;
    mppSessionId: number[];
    createdAt: number;
}
export interface SettlementState {
    escrowId: number;
    jobPubkey: PublicKey;
    poster: PublicKey;
    agent: PublicKey;
    totalDeposited: number;
    totalPaid: number;
    settledAt: number;
    settlementHash: number[];
}
export interface TeeAttestationEnvelope {
    escrowId: number;
    jobPubkey: PublicKey;
    validator: PublicKey;
    teePubkey: number[];
    mppSessionId: number[];
    issuedAt: number;
    expiresAt: number;
}
export interface DarkForestPaymentsOptions {
    sessionStore?: SessionStore;
}
export declare class DarkForestPayments {
    private program;
    private provider;
    private sessionStore;
    constructor(provider: AnchorProvider, idl: Idl, options?: DarkForestPaymentsOptions);
    connectToPer(endpoint?: string): Connection;
    static buildAttestationReport(envelope: TeeAttestationEnvelope): Buffer;
    static buildAttestationSignatureInstruction(validatorSigner: Keypair, report: Buffer): TransactionInstruction;
    createEscrowWrapper(escrowId: number, jobPubkey: PublicKey, depositSol: number, mppSessionId?: number[]): Promise<string>;
    delegateToPer(escrowId: number, validator?: PublicKey): Promise<string>;
    verifyTeeAttestation(escrowId: number, attestationReport: Buffer, teePubkey: number[], signatureInstruction?: TransactionInstruction): Promise<string>;
    recordSettlement(escrowId: number, totalPaidSol: number): Promise<string>;
    startPrivateSession(escrowId: number, jobPubkey: PublicKey, config: MppSessionConfig): Promise<MppSessionState>;
    recordPayment(escrowId: number, amountLamports: number): Promise<void>;
    closeSession(escrowId: number): Promise<string>;
    getActiveSession(escrowId: number): Promise<MppSessionState | undefined>;
    getEscrow(escrowId: number): Promise<EscrowState | null>;
    getSettlement(escrowId: number): Promise<SettlementState | null>;
    static escrowPda(escrowId: number): PublicKey;
    static settlementPda(escrowId: number): PublicKey;
}
