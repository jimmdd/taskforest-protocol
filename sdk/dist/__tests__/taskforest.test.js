"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const web3_js_1 = require("@solana/web3.js");
// ── Mock IDL ───────────────────────────────────────────────────
vitest_1.vi.mock('../../../target/idl/taskforest.json', () => ({
    default: {
        address: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS',
        metadata: { name: 'taskforest', version: '0.1.0' },
        instructions: [],
        accounts: [],
    },
}));
// ── Shared mock state ──────────────────────────────────────────
const mockTxSig = 'mock_sig_abc123';
const mockInstruction = { keys: [], programId: web3_js_1.PublicKey.default, data: Buffer.from([]) };
let methodCalls = {};
// Track which program methods were called and in what mode
function trackMethod(name, mode, accounts) {
    if (!methodCalls[name])
        methodCalls[name] = [];
    methodCalls[name].push({ accounts, mode });
}
// ── Mock anchor ────────────────────────────────────────────────
vitest_1.vi.mock('@coral-xyz/anchor', () => {
    const BN = class BN {
        constructor(v) { this.value = v; }
        toNumber() { return this.value; }
    };
    const AnchorProvider = function () {
        this.connection = {};
    };
    const Program = function () {
        const createBuilder = (methodName) => {
            return (..._args) => {
                const builder = {
                    accounts: (accts) => {
                        builder._accounts = accts;
                        return builder;
                    },
                    instruction: async () => {
                        trackMethod(methodName, 'instruction', builder._accounts);
                        return mockInstruction;
                    },
                    transaction: async () => {
                        trackMethod(methodName, 'transaction', builder._accounts);
                        return new web3_js_1.Transaction();
                    },
                };
                return builder;
            };
        };
        this.methods = new Proxy({}, {
            get: (_t, prop) => createBuilder(prop),
        });
        this.account = {};
        this.coder = { accounts: { decode: () => ({}) } };
    };
    return { AnchorProvider, Program, BN, default: { BN } };
});
// ── Mock Connection via prototype ──────────────────────────────
const web3_js_2 = require("@solana/web3.js");
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: 'mock_blockhash',
    lastValidBlockHeight: 100,
});
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'sendRawTransaction').mockResolvedValue(mockTxSig);
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'confirmTransaction').mockResolvedValue({ value: { err: null } });
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'getBalance').mockResolvedValue(5 * web3_js_1.LAMPORTS_PER_SOL);
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'requestAirdrop').mockResolvedValue('airdrop_sig');
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'getAccountInfo').mockResolvedValue(null);
vitest_1.vi.spyOn(web3_js_2.Connection.prototype, 'getProgramAccounts').mockResolvedValue([]);
const taskforest_1 = require("../taskforest");
// ── Mock sendTx to bypass real signing/serialization ───────────
vitest_1.vi.spyOn(taskforest_1.TaskForest.prototype, 'sendTx').mockResolvedValue(mockTxSig);
// ════════════════════════════════════════════════════════════════
(0, vitest_1.describe)('TaskForest SDK', () => {
    let sdk;
    const wallet = web3_js_1.Keypair.generate();
    (0, vitest_1.beforeEach)(() => {
        methodCalls = {};
        sdk = new taskforest_1.TaskForest({
            rpc: 'https://api.devnet.solana.com',
            wallet,
            network: 'devnet',
        });
    });
    // ── Constructor ──────────────────────────────────────────────
    (0, vitest_1.describe)('constructor', () => {
        (0, vitest_1.it)('initializes with correct program ID', () => {
            (0, vitest_1.expect)(sdk.getProgramId()).toBeInstanceOf(web3_js_1.PublicKey);
            (0, vitest_1.expect)(sdk.getProgramId().toBase58()).toBe('Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS');
        });
        (0, vitest_1.it)('exposes wallet public key', () => {
            (0, vitest_1.expect)(sdk.getPublicKey()).toEqual(wallet.publicKey);
        });
        (0, vitest_1.it)('generates 32-byte encryption key', () => {
            const key = sdk.getEncryptionPublicKey();
            (0, vitest_1.expect)(key).toBeInstanceOf(Uint8Array);
            (0, vitest_1.expect)(key.length).toBe(32);
        });
    });
    // ── postTask (batched init + delegate) ───────────────────────
    (0, vitest_1.describe)('postTask', () => {
        (0, vitest_1.it)('returns jobId, pubkey, and signature', async () => {
            const result = await sdk.postTask({
                title: 'Test task',
                input: { data: 'hello' },
                reward: 0.5,
                deadline: '2h',
            });
            (0, vitest_1.expect)(result).toHaveProperty('jobId');
            (0, vitest_1.expect)(result).toHaveProperty('pubkey');
            (0, vitest_1.expect)(result).toHaveProperty('signature');
            (0, vitest_1.expect)(result.pubkey).toBeInstanceOf(web3_js_1.PublicKey);
            (0, vitest_1.expect)(typeof result.jobId).toBe('number');
        });
        (0, vitest_1.it)('batches initializeJob + delegateJob as instructions (not transactions)', async () => {
            await sdk.postTask({
                title: 'Batch test',
                input: {},
                reward: 0.1,
                deadline: 3600,
            });
            // Both should be called as .instruction() — proves batching
            (0, vitest_1.expect)(methodCalls['initializeJob']).toBeDefined();
            (0, vitest_1.expect)(methodCalls['initializeJob'][0].mode).toBe('instruction');
            (0, vitest_1.expect)(methodCalls['delegateJob']).toBeDefined();
            (0, vitest_1.expect)(methodCalls['delegateJob'][0].mode).toBe('instruction');
        });
        (0, vitest_1.it)('handles encrypted privacy level', async () => {
            const result = await sdk.postTask({
                title: 'Private task',
                input: { secret: true },
                reward: 1.0,
                deadline: '1d',
                privacy: 'encrypted',
            });
            (0, vitest_1.expect)(result.signature).toBe(mockTxSig);
        });
        (0, vitest_1.it)('handles TTD specification', async () => {
            const result = await sdk.postTask({
                title: 'Typed task',
                input: { repo: 'github.com/test' },
                reward: 0.5,
                deadline: '2h',
                ttd: 'code-review-v1',
            });
            (0, vitest_1.expect)(result.jobId).toBeGreaterThan(0);
        });
    });
    // ── bid ──────────────────────────────────────────────────────
    (0, vitest_1.describe)('bid', () => {
        (0, vitest_1.it)('places bid via placeBid instruction', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const sig = await sdk.bid(jobPubkey, { stake: 0.05 });
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['placeBid']).toBeDefined();
        });
    });
    // ── lockStake ────────────────────────────────────────────────
    (0, vitest_1.describe)('lockStake', () => {
        (0, vitest_1.it)('locks stake via lockStake instruction', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const sig = await sdk.lockStake(jobPubkey);
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['lockStake']).toBeDefined();
        });
    });
    // ── stakeAndProve (batched) ──────────────────────────────────
    (0, vitest_1.describe)('stakeAndProve', () => {
        (0, vitest_1.it)('batches lockStake + submitProof as instructions', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const sig = await sdk.stakeAndProve(jobPubkey, { result: 'done' });
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['lockStake']).toBeDefined();
            (0, vitest_1.expect)(methodCalls['lockStake'][0].mode).toBe('instruction');
            (0, vitest_1.expect)(methodCalls['submitProof']).toBeDefined();
            (0, vitest_1.expect)(methodCalls['submitProof'][0].mode).toBe('instruction');
        });
    });
    // ── submitProof ──────────────────────────────────────────────
    (0, vitest_1.describe)('submitProof', () => {
        (0, vitest_1.it)('submits proof hash', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const sig = await sdk.submitProof(jobPubkey, { analysis: 'looks good' });
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['submitProof']).toBeDefined();
        });
    });
    // ── settle ───────────────────────────────────────────────────
    (0, vitest_1.describe)('settle', () => {
        (0, vitest_1.it)('throws if job not found', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            await (0, vitest_1.expect)(sdk.settle(jobPubkey, true)).rejects.toThrow('Job not found');
        });
    });
    // ── settleAndArchive (batched) ───────────────────────────────
    (0, vitest_1.describe)('settleAndArchive', () => {
        (0, vitest_1.it)('throws if job not found', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            await (0, vitest_1.expect)(sdk.settleAndArchive(jobPubkey, true)).rejects.toThrow('Job not found');
        });
    });
    // ── compressFinishedJob ──────────────────────────────────────
    (0, vitest_1.describe)('compressFinishedJob', () => {
        (0, vitest_1.it)('calls compressFinishedJob instruction', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const sig = await sdk.compressFinishedJob(jobPubkey);
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['compressFinishedJob']).toBeDefined();
        });
    });
    // ── storeCredential ──────────────────────────────────────────
    (0, vitest_1.describe)('storeCredential', () => {
        (0, vitest_1.it)('stores encrypted credential', async () => {
            const jobPubkey = web3_js_1.Keypair.generate().publicKey;
            const data = new Uint8Array([1, 2, 3, 4]);
            const sig = await sdk.storeCredential(jobPubkey, data);
            (0, vitest_1.expect)(sig).toBe(mockTxSig);
            (0, vitest_1.expect)(methodCalls['storeCredential']).toBeDefined();
        });
    });
    // ── encrypt / decrypt ────────────────────────────────────────
    (0, vitest_1.describe)('encrypt/decrypt', () => {
        (0, vitest_1.it)('roundtrip encrypt → decrypt', () => {
            const sdk2 = new taskforest_1.TaskForest({
                rpc: 'https://api.devnet.solana.com',
                wallet: web3_js_1.Keypair.generate(),
            });
            const plaintext = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
            const { encrypted, nonce } = sdk.encrypt(plaintext, sdk2.getEncryptionPublicKey());
            const decrypted = sdk2.decrypt(encrypted, nonce, sdk.getEncryptionPublicKey());
            (0, vitest_1.expect)(Array.from(decrypted)).toEqual(Array.from(plaintext));
        });
        (0, vitest_1.it)('fails with wrong key', () => {
            const sdk2 = new taskforest_1.TaskForest({
                rpc: 'https://api.devnet.solana.com',
                wallet: web3_js_1.Keypair.generate(),
            });
            const sdk3 = new taskforest_1.TaskForest({
                rpc: 'https://api.devnet.solana.com',
                wallet: web3_js_1.Keypair.generate(),
            });
            const plaintext = new Uint8Array([1, 2, 3]);
            const { encrypted, nonce } = sdk.encrypt(plaintext, sdk2.getEncryptionPublicKey());
            (0, vitest_1.expect)(() => sdk3.decrypt(encrypted, nonce, sdk.getEncryptionPublicKey())).toThrow();
        });
    });
    // ── getBalance ───────────────────────────────────────────────
    (0, vitest_1.describe)('getBalance', () => {
        (0, vitest_1.it)('returns SOL balance', async () => {
            const balance = await sdk.getBalance();
            (0, vitest_1.expect)(balance).toBe(5);
        });
    });
    // ── airdrop ──────────────────────────────────────────────────
    (0, vitest_1.describe)('airdrop', () => {
        (0, vitest_1.it)('returns signature on devnet', async () => {
            const sig = await sdk.airdrop(2);
            (0, vitest_1.expect)(sig).toBe('airdrop_sig');
        });
        (0, vitest_1.it)('rejects on mainnet', async () => {
            const mainnetSdk = new taskforest_1.TaskForest({
                rpc: 'https://api.mainnet-beta.solana.com',
                wallet,
                network: 'mainnet-beta',
            });
            await (0, vitest_1.expect)(mainnetSdk.airdrop()).rejects.toThrow('Airdrop only available on devnet');
        });
    });
    // ── searchTasks ──────────────────────────────────────────────
    (0, vitest_1.describe)('searchTasks', () => {
        (0, vitest_1.it)('returns empty array when no jobs', async () => {
            const jobs = await sdk.searchTasks();
            (0, vitest_1.expect)(jobs).toEqual([]);
        });
    });
    // ── getTask ──────────────────────────────────────────────────
    (0, vitest_1.describe)('getTask', () => {
        (0, vitest_1.it)('returns null for non-existent job', async () => {
            const result = await sdk.getTask(web3_js_1.Keypair.generate().publicKey);
            (0, vitest_1.expect)(result).toBeNull();
        });
    });
    // ── deadline parsing ─────────────────────────────────────────
    (0, vitest_1.describe)('deadline parsing', () => {
        vitest_1.it.each([
            ['2h', 'hours'],
            ['1d', 'days'],
            ['30m', 'minutes'],
            ['1w', 'weeks'],
        ])('parses %s (%s)', async (deadline) => {
            const result = await sdk.postTask({
                title: 'Test', input: {}, reward: 0.1, deadline,
            });
            (0, vitest_1.expect)(result.signature).toBe(mockTxSig);
        });
        (0, vitest_1.it)('parses numeric seconds', async () => {
            const result = await sdk.postTask({
                title: 'Test', input: {}, reward: 0.1, deadline: 7200,
            });
            (0, vitest_1.expect)(result.signature).toBe(mockTxSig);
        });
    });
});
