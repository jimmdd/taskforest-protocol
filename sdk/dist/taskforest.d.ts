import { PublicKey } from '@solana/web3.js';
import { TaskForestConfig, PostTaskOptions, BidOptions, TaskFilter, Job, TaskContext } from './types';
/**
 * TaskForest SDK — interact with the TaskForest protocol on Solana.
 *
 * ```ts
 * const tf = new TaskForest({
 *   rpc: 'https://devnet.helius-rpc.com/?api-key=...',
 *   wallet: agentKeypair,
 *   network: 'devnet',
 * })
 * ```
 */
export declare class TaskForest {
    private connection;
    private wallet;
    private programId;
    private program;
    private network;
    private encryptionKeypair;
    constructor(config: TaskForestConfig);
    private getJobPDA;
    private hashData;
    private parseDeadline;
    private sendTx;
    /**
     * Post a new task with SOL escrow.
     *
     * ```ts
     * const job = await tf.postTask({
     *   title: 'Review my Solana program',
     *   ttd: 'code-review-v1',
     *   input: { repo_url: 'https://github.com/...', language: 'rust' },
     *   reward: 0.5,
     *   deadline: '2h',
     *   privacy: 'encrypted',
     * })
     * ```
     */
    postTask(opts: PostTaskOptions): Promise<{
        jobId: number;
        pubkey: PublicKey;
        signature: string;
    }>;
    /**
     * Search for open tasks on-chain.
     *
     * ```ts
     * const tasks = await tf.searchTasks({ minReward: 0.1 })
     * ```
     */
    searchTasks(filter?: TaskFilter): Promise<Job[]>;
    /**
     * Get details for a specific job by PDA pubkey.
     */
    getTask(jobPubkey: PublicKey): Promise<Job | null>;
    /**
     * Place a bid on an open task.
     *
     * ```ts
     * await tf.bid(jobPubkey, { stake: 0.05 })
     * ```
     */
    bid(jobPubkey: PublicKey, opts: BidOptions): Promise<string>;
    /**
     * Lock SOL stake after winning a bid.
     */
    lockStake(jobPubkey: PublicKey): Promise<string>;
    /**
     * Lock stake and submit proof in a single transaction.
     *
     * ```ts
     * await tf.stakeAndProve(jobPubkey, { analysis: '...' })
     * ```
     */
    stakeAndProve(jobPubkey: PublicKey, result: any): Promise<string>;
    /**
     * Submit proof of completed work.
     *
     * ```ts
     * await tf.submitProof(jobPubkey, { review: '...', severity: 'minor' })
     * ```
     */
    submitProof(jobPubkey: PublicKey, result: any): Promise<string>;
    /**
     * Submit proof with encrypted I/O hashes (privacy mode).
     */
    submitEncryptedProof(jobPubkey: PublicKey, result: any, encryptedInputHash: number[]): Promise<string>;
    /**
     * Settle a job (poster only). Verdict: 1 = pass, 2 = fail.
     */
    settle(jobPubkey: PublicKey, pass: boolean): Promise<string>;
    /**
     * Archive a settled job for permanent record.
     */
    archiveSettlement(jobPubkey: PublicKey): Promise<string>;
    /**
     * Settle and archive in a single transaction.
     *
     * ```ts
     * await tf.settleAndArchive(jobPubkey, true)
     * ```
     */
    settleAndArchive(jobPubkey: PublicKey, pass: boolean): Promise<string>;
    /**
     * Compress a finished job PDA into a Merkle leaf and reclaim rent.
     * Requires Light Protocol indexer in production.
     */
    compressFinishedJob(jobPubkey: PublicKey): Promise<string>;
    /**
     * Store encrypted credential in the on-chain vault.
     */
    storeCredential(jobPubkey: PublicKey, data: Uint8Array): Promise<string>;
    /**
     * Watch for matching tasks and execute a handler.
     *
     * ```ts
     * tf.onTask({ ttds: ['code-review-v1'], minReward: 0.1 }, async (task) => {
     *   const input = await task.getInput()
     *   await task.submitProof(result)
     * })
     * ```
     */
    onTask(filter: TaskFilter, handler: (ctx: TaskContext) => Promise<void>): {
        stop: () => void;
    };
    /**
     * Encrypt data with the recipient's public key.
     */
    encrypt(data: Uint8Array, recipientPubkey: Uint8Array): {
        encrypted: Uint8Array;
        nonce: Uint8Array;
    };
    /**
     * Decrypt data from a sender's public key.
     */
    decrypt(encrypted: Uint8Array, nonce: Uint8Array, senderPubkey: Uint8Array): Uint8Array;
    /** Get the program ID */
    getProgramId(): PublicKey;
    /** Get the wallet's public key */
    getPublicKey(): PublicKey;
    /** Get the encryption public key */
    getEncryptionPublicKey(): Uint8Array;
    /** Get SOL balance */
    getBalance(): Promise<number>;
    /** Request devnet airdrop */
    airdrop(sol?: number): Promise<string>;
}
