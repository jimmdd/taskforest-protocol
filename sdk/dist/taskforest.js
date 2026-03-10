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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskForest = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor = __importStar(require("@coral-xyz/anchor"));
const tweetnacl_1 = __importDefault(require("tweetnacl"));
const crypto_1 = require("crypto");
// Load IDL from compiled artifact
const taskforest_json_1 = __importDefault(require("../../target/idl/taskforest.json"));
const DEFAULT_PROGRAM_ID = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const STATUS_LABELS = {
    0: 'open',
    1: 'claimed',
    2: 'staked',
    3: 'submitted',
    4: 'settled',
    5: 'failed',
    6: 'wip',
};
const PRIVACY_MAP = {
    public: 0,
    encrypted: 1,
    per: 2,
};
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
class TaskForest {
    constructor(config) {
        this.connection = new web3_js_1.Connection(config.rpc, 'confirmed');
        this.wallet = config.wallet;
        this.network = config.network || 'devnet';
        this.programId = new web3_js_1.PublicKey(config.programId || DEFAULT_PROGRAM_ID);
        this.encryptionKeypair = tweetnacl_1.default.box.keyPair();
        const provider = new anchor.AnchorProvider(this.connection, {
            publicKey: this.wallet.publicKey,
            signTransaction: async (tx) => {
                tx.partialSign(this.wallet);
                return tx;
            },
            signAllTransactions: async (txs) => {
                txs.forEach((tx) => tx.partialSign(this.wallet));
                return txs;
            },
        }, { commitment: 'confirmed' });
        this.program = new anchor.Program(taskforest_json_1.default, provider);
    }
    // ─── Job PDA Derivation ─────────────────────────────────────
    getJobPDA(jobId) {
        const idBuf = Buffer.alloc(8);
        idBuf.writeBigUInt64LE(BigInt(jobId));
        return web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('job'), this.wallet.publicKey.toBuffer(), idBuf], this.programId);
    }
    // ─── Hashing ────────────────────────────────────────────────
    hashData(data) {
        const hash = (0, crypto_1.createHash)('sha256')
            .update(JSON.stringify(data))
            .digest();
        return Array.from(hash);
    }
    parseDeadline(deadline) {
        if (typeof deadline === 'number') {
            return Math.floor(Date.now() / 1000) + deadline;
        }
        const match = deadline.match(/^(\d+)(h|d|m|w)$/);
        if (!match)
            throw new Error(`Invalid deadline format: ${deadline}. Use '2h', '1d', '30m', or '1w'`);
        const value = parseInt(match[1]);
        const unit = match[2];
        const multiplier = { m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 3600;
        return Math.floor(Date.now() / 1000) + value * multiplier;
    }
    // ─── Send Transaction Helper ────────────────────────────────
    async sendTx(tx) {
        const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer = this.wallet.publicKey;
        tx.sign(this.wallet);
        const sig = await this.connection.sendRawTransaction(tx.serialize());
        await this.connection.confirmTransaction(sig, 'confirmed');
        return sig;
    }
    // ─── Post Task ──────────────────────────────────────────────
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
    async postTask(opts) {
        const jobId = Math.floor(Math.random() * 2 ** 32);
        const [jobPDA] = this.getJobPDA(jobId);
        const rewardLamports = Math.floor(opts.reward * web3_js_1.LAMPORTS_PER_SOL);
        const deadlineSec = this.parseDeadline(opts.deadline);
        const privacyLevel = PRIVACY_MAP[opts.privacy || 'public'];
        const proofSpecHash = this.hashData({ title: opts.title, ...opts.input });
        const ttdHash = opts.ttd ? this.hashData(opts.ttd) : Array.from({ length: 32 }, () => 0);
        const encryptionPubkey = privacyLevel > 0
            ? Array.from(this.encryptionKeypair.publicKey)
            : Array.from({ length: 32 }, () => 0);
        // Batch init + delegate into 1 tx (1 signature)
        const initIx = await this.program.methods
            .initializeJob(new anchor.BN(jobId), new anchor.BN(rewardLamports), new anchor.BN(deadlineSec), proofSpecHash, ttdHash, privacyLevel, encryptionPubkey)
            .accounts({ job: jobPDA, poster: this.wallet.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .instruction();
        const delegateIx = await this.program.methods
            .delegateJob()
            .accounts({ payer: this.wallet.publicKey, job: jobPDA })
            .instruction();
        const tx = new web3_js_1.Transaction().add(initIx).add(delegateIx);
        const sig = await this.sendTx(tx);
        return { jobId, pubkey: jobPDA, signature: sig };
    }
    // ─── Search Tasks ───────────────────────────────────────────
    /**
     * Search for open tasks on-chain.
     *
     * ```ts
     * const tasks = await tf.searchTasks({ minReward: 0.1 })
     * ```
     */
    async searchTasks(filter) {
        // Fetch all job accounts (v1=222, v2=254, v3=351 bytes)
        const [v1, v2, v3] = await Promise.all([
            this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 222 }] }),
            this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 254 }] }),
            this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 351 }] }),
        ]);
        const accounts = [...v1, ...v2, ...v3];
        const jobs = [];
        for (const { pubkey, account } of accounts) {
            try {
                const decoded = this.program.coder.accounts.decode('job', account.data);
                const job = {
                    pubkey,
                    jobId: decoded.jobId?.toNumber?.() ?? Number(decoded.jobId),
                    poster: decoded.poster,
                    worker: decoded.claimer,
                    rewardLamports: decoded.rewardLamports?.toNumber?.() ?? Number(decoded.rewardLamports),
                    reward: (decoded.rewardLamports?.toNumber?.() ?? Number(decoded.rewardLamports)) / web3_js_1.LAMPORTS_PER_SOL,
                    deadline: decoded.deadline?.toNumber?.() ?? Number(decoded.deadline),
                    status: decoded.status,
                    statusLabel: STATUS_LABELS[decoded.status] || 'unknown',
                    proofHash: decoded.proofHash || [],
                    privacyLevel: decoded.privacyLevel ?? 0,
                    ttdHash: decoded.ttdHash || [],
                    claimerStake: decoded.claimerStake?.toNumber?.() ?? 0,
                    bestBidStake: decoded.bestBidStake?.toNumber?.() ?? 0,
                    bidCount: decoded.bidCount ?? 0,
                };
                // Apply filters
                if (filter?.status) {
                    const statusMap = { open: 0, claimed: 1, staked: 2, submitted: 3 };
                    if (job.status !== statusMap[filter.status])
                        continue;
                }
                if (filter?.minReward && job.reward < filter.minReward)
                    continue;
                jobs.push(job);
            }
            catch { /* skip malformed */ }
        }
        return jobs.sort((a, b) => b.jobId - a.jobId);
    }
    // ─── Get Task Details ───────────────────────────────────────
    /**
     * Get details for a specific job by PDA pubkey.
     */
    async getTask(jobPubkey) {
        try {
            const account = await this.connection.getAccountInfo(jobPubkey);
            if (!account)
                return null;
            const decoded = this.program.coder.accounts.decode('job', account.data);
            return {
                pubkey: jobPubkey,
                jobId: decoded.jobId?.toNumber?.() ?? Number(decoded.jobId),
                poster: decoded.poster,
                worker: decoded.claimer,
                rewardLamports: decoded.rewardLamports?.toNumber?.() ?? 0,
                reward: (decoded.rewardLamports?.toNumber?.() ?? 0) / web3_js_1.LAMPORTS_PER_SOL,
                deadline: decoded.deadline?.toNumber?.() ?? 0,
                status: decoded.status,
                statusLabel: STATUS_LABELS[decoded.status] || 'unknown',
                proofHash: decoded.proofHash || [],
                privacyLevel: decoded.privacyLevel ?? 0,
                ttdHash: decoded.ttdHash || [],
                claimerStake: decoded.claimerStake?.toNumber?.() ?? 0,
                bestBidStake: decoded.bestBidStake?.toNumber?.() ?? 0,
                bidCount: decoded.bidCount ?? 0,
            };
        }
        catch {
            return null;
        }
    }
    // ─── Bid on Task ────────────────────────────────────────────
    /**
     * Place a bid on an open task.
     *
     * ```ts
     * await tf.bid(jobPubkey, { stake: 0.05 })
     * ```
     */
    async bid(jobPubkey, opts) {
        const stakeLamports = Math.floor(opts.stake * web3_js_1.LAMPORTS_PER_SOL);
        const tx = await this.program.methods
            .placeBid(new anchor.BN(stakeLamports))
            .accounts({ bidder: this.wallet.publicKey, job: jobPubkey })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Lock Stake ─────────────────────────────────────────────
    /**
     * Lock SOL stake after winning a bid.
     */
    async lockStake(jobPubkey) {
        const tx = await this.program.methods
            .lockStake()
            .accounts({ worker: this.wallet.publicKey, job: jobPubkey, systemProgram: web3_js_1.SystemProgram.programId })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Batched: Stake + Prove (1 tx, 1 sign) ─────────────────
    /**
     * Lock stake and submit proof in a single transaction.
     *
     * ```ts
     * await tf.stakeAndProve(jobPubkey, { analysis: '...' })
     * ```
     */
    async stakeAndProve(jobPubkey, result) {
        const proofHash = this.hashData(result);
        const stakeIx = await this.program.methods
            .lockStake()
            .accounts({ job: jobPubkey, claimer: this.wallet.publicKey, systemProgram: web3_js_1.SystemProgram.programId })
            .instruction();
        const proveIx = await this.program.methods
            .submitProof(proofHash)
            .accounts({ job: jobPubkey, submitter: this.wallet.publicKey })
            .instruction();
        const tx = new web3_js_1.Transaction().add(stakeIx).add(proveIx);
        return this.sendTx(tx);
    }
    // ─── Submit Proof ───────────────────────────────────────────
    /**
     * Submit proof of completed work.
     *
     * ```ts
     * await tf.submitProof(jobPubkey, { review: '...', severity: 'minor' })
     * ```
     */
    async submitProof(jobPubkey, result) {
        const proofHash = this.hashData(result);
        const tx = await this.program.methods
            .submitProof(proofHash)
            .accounts({ worker: this.wallet.publicKey, job: jobPubkey })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Submit Encrypted Proof ─────────────────────────────────
    /**
     * Submit proof with encrypted I/O hashes (privacy mode).
     */
    async submitEncryptedProof(jobPubkey, result, encryptedInputHash) {
        const proofHash = this.hashData(result);
        const encryptedOutputHash = this.hashData({ encrypted: true, output: result });
        const tx = await this.program.methods
            .submitEncryptedProof(proofHash, encryptedInputHash, encryptedOutputHash)
            .accounts({ worker: this.wallet.publicKey, job: jobPubkey })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Settle Job ─────────────────────────────────────────────
    /**
     * Settle a job (poster only). Verdict: 1 = pass, 2 = fail.
     */
    async settle(jobPubkey, pass) {
        const verdict = pass ? 1 : 2;
        const job = await this.getTask(jobPubkey);
        if (!job)
            throw new Error('Job not found');
        const tx = await this.program.methods
            .settleJob(verdict)
            .accounts({ poster: this.wallet.publicKey, job: jobPubkey, worker: job.worker })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Archive Settlement ─────────────────────────────────────
    /**
     * Archive a settled job for permanent record.
     */
    async archiveSettlement(jobPubkey) {
        const [archivePDA] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('archive'), jobPubkey.toBuffer()], this.programId);
        const tx = await this.program.methods
            .archiveSettlement()
            .accounts({
            poster: this.wallet.publicKey,
            job: jobPubkey,
            archive: archivePDA,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Batched: Settle + Archive (1 tx, 1 sign) ──────────────
    /**
     * Settle and archive in a single transaction.
     *
     * ```ts
     * await tf.settleAndArchive(jobPubkey, true)
     * ```
     */
    async settleAndArchive(jobPubkey, pass) {
        const verdict = pass ? 1 : 2;
        const job = await this.getTask(jobPubkey);
        if (!job)
            throw new Error('Job not found');
        const [archivePDA] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('archive'), jobPubkey.toBuffer()], this.programId);
        const settleIx = await this.program.methods
            .settleJob(verdict)
            .accounts({ poster: this.wallet.publicKey, job: jobPubkey, worker: job.worker })
            .instruction();
        const archiveIx = await this.program.methods
            .archiveSettlement()
            .accounts({
            poster: this.wallet.publicKey,
            job: jobPubkey,
            archive: archivePDA,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .instruction();
        const tx = new web3_js_1.Transaction().add(settleIx).add(archiveIx);
        return this.sendTx(tx);
    }
    // ─── Compress Finished Job (ZK) ─────────────────────────────
    /**
     * Compress a finished job PDA into a Merkle leaf and reclaim rent.
     * Requires Light Protocol indexer in production.
     */
    async compressFinishedJob(jobPubkey) {
        const tx = await this.program.methods
            .compressFinishedJob()
            .accounts({ poster: this.wallet.publicKey, job: jobPubkey })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Store Credential ──────────────────────────────────────
    /**
     * Store encrypted credential in the on-chain vault.
     */
    async storeCredential(jobPubkey, data) {
        const [vaultPDA] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('vault'), jobPubkey.toBuffer()], this.programId);
        const tx = await this.program.methods
            .storeCredential(Array.from(data))
            .accounts({
            poster: this.wallet.publicKey,
            job: jobPubkey,
            vault: vaultPDA,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .transaction();
        return this.sendTx(tx);
    }
    // ─── Watch Tasks (onTask) ───────────────────────────────────
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
    onTask(filter, handler) {
        let running = true;
        const seen = new Set();
        const poll = async () => {
            while (running) {
                try {
                    const jobs = await this.searchTasks({ ...filter, status: 'open' });
                    for (const job of jobs) {
                        const key = job.pubkey.toBase58();
                        if (seen.has(key))
                            continue;
                        seen.add(key);
                        const ctx = {
                            job,
                            getInput: async () => {
                                // In a real implementation, fetch + decrypt off-chain metadata
                                return { jobId: job.jobId, reward: job.reward };
                            },
                            submitProof: async (result) => {
                                return this.submitProof(job.pubkey, result);
                            },
                        };
                        handler(ctx).catch(console.error);
                    }
                }
                catch (e) {
                    console.error('TaskForest poll error:', e);
                }
                // Poll every 10 seconds
                await new Promise(r => setTimeout(r, 10000));
            }
        };
        poll();
        return { stop: () => { running = false; } };
    }
    // ─── Encrypt / Decrypt ──────────────────────────────────────
    /**
     * Encrypt data with the recipient's public key.
     */
    encrypt(data, recipientPubkey) {
        const nonce = tweetnacl_1.default.randomBytes(tweetnacl_1.default.box.nonceLength);
        const encrypted = tweetnacl_1.default.box(data, nonce, recipientPubkey, this.encryptionKeypair.secretKey);
        if (!encrypted)
            throw new Error('Encryption failed');
        return { encrypted, nonce };
    }
    /**
     * Decrypt data from a sender's public key.
     */
    decrypt(encrypted, nonce, senderPubkey) {
        const decrypted = tweetnacl_1.default.box.open(encrypted, nonce, senderPubkey, this.encryptionKeypair.secretKey);
        if (!decrypted)
            throw new Error('Decryption failed');
        return decrypted;
    }
    // ─── Utilities ──────────────────────────────────────────────
    /** Get the program ID */
    getProgramId() { return this.programId; }
    /** Get the wallet's public key */
    getPublicKey() { return this.wallet.publicKey; }
    /** Get the encryption public key */
    getEncryptionPublicKey() { return this.encryptionKeypair.publicKey; }
    /** Get SOL balance */
    async getBalance() {
        const lamports = await this.connection.getBalance(this.wallet.publicKey);
        return lamports / web3_js_1.LAMPORTS_PER_SOL;
    }
    /** Request devnet airdrop */
    async airdrop(sol = 1) {
        if (this.network !== 'devnet')
            throw new Error('Airdrop only available on devnet');
        const sig = await this.connection.requestAirdrop(this.wallet.publicKey, sol * web3_js_1.LAMPORTS_PER_SOL);
        await this.connection.confirmTransaction(sig, 'confirmed');
        return sig;
    }
}
exports.TaskForest = TaskForest;
