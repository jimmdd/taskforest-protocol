import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Keypair, PublicKey, Transaction, LAMPORTS_PER_SOL } from '@solana/web3.js'

// ── Mock IDL ───────────────────────────────────────────────────
vi.mock('../../../target/idl/taskforest.json', () => ({
  default: {
    address: 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS',
    metadata: { name: 'taskforest', version: '0.1.0' },
    instructions: [],
    accounts: [],
  },
}))

// ── Shared mock state ──────────────────────────────────────────
const mockTxSig = 'mock_sig_abc123'
const mockInstruction = { keys: [], programId: PublicKey.default, data: Buffer.from([]) }
let methodCalls: Record<string, { accounts: any; mode: string }[]> = {}

// Track which program methods were called and in what mode
function trackMethod(name: string, mode: string, accounts: any) {
  if (!methodCalls[name]) methodCalls[name] = []
  methodCalls[name].push({ accounts, mode })
}

// ── Mock anchor ────────────────────────────────────────────────
vi.mock('@coral-xyz/anchor', () => {
  const BN = class BN {
    value: number
    constructor(v: number) { this.value = v }
    toNumber() { return this.value }
  }

  const AnchorProvider = function(this: any) {
    this.connection = {}
  } as any

  const Program = function(this: any) {
    const createBuilder = (methodName: string) => {
      return (..._args: any[]) => {
        const builder: any = {
          accounts: (accts: any) => {
            builder._accounts = accts
            return builder
          },
          instruction: async () => {
            trackMethod(methodName, 'instruction', builder._accounts)
            return mockInstruction
          },
          transaction: async () => {
            trackMethod(methodName, 'transaction', builder._accounts)
            return new Transaction()
          },
        }
        return builder
      }
    }

    this.methods = new Proxy({}, {
      get: (_t, prop) => createBuilder(prop as string),
    })
    this.account = {}
    this.coder = { accounts: { decode: () => ({}) } }
  } as any

  return { AnchorProvider, Program, BN, default: { BN } }
})

// ── Mock Connection via prototype ──────────────────────────────
import { Connection } from '@solana/web3.js'
vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
  blockhash: 'mock_blockhash',
  lastValidBlockHeight: 100,
} as any)
vi.spyOn(Connection.prototype, 'sendRawTransaction').mockResolvedValue(mockTxSig)
vi.spyOn(Connection.prototype, 'confirmTransaction').mockResolvedValue({ value: { err: null } } as any)
vi.spyOn(Connection.prototype, 'getBalance').mockResolvedValue(5 * LAMPORTS_PER_SOL)
vi.spyOn(Connection.prototype, 'requestAirdrop').mockResolvedValue('airdrop_sig')
vi.spyOn(Connection.prototype, 'getAccountInfo').mockResolvedValue(null)
vi.spyOn(Connection.prototype, 'getProgramAccounts').mockResolvedValue([])

import { TaskForest } from '../taskforest'
import type { TaskForestSpec } from '../spec'

// ── Mock sendTx to bypass real signing/serialization ───────────
vi.spyOn(TaskForest.prototype as any, 'sendTx').mockResolvedValue(mockTxSig)

// ════════════════════════════════════════════════════════════════
describe('TaskForest SDK', () => {
  let sdk: TaskForest
  const wallet = Keypair.generate()

  beforeEach(() => {
    methodCalls = {}
    sdk = new TaskForest({
      rpc: 'https://api.devnet.solana.com',
      wallet,
      network: 'devnet',
    })
  })

  // ── Constructor ──────────────────────────────────────────────
  describe('constructor', () => {
    it('initializes with correct program ID', () => {
      expect(sdk.getProgramId()).toBeInstanceOf(PublicKey)
      expect(sdk.getProgramId().toBase58()).toBe('Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s')
    })

    it('exposes wallet public key', () => {
      expect(sdk.getPublicKey()).toEqual(wallet.publicKey)
    })

    it('generates 32-byte encryption key', () => {
      const key = sdk.getEncryptionPublicKey()
      expect(key).toBeInstanceOf(Uint8Array)
      expect(key.length).toBe(32)
    })
  })

  // ── postTask (batched init + delegate) ───────────────────────
  describe('postTask', () => {
    it('returns jobId, pubkey, and signature', async () => {
      const result = await sdk.postTask({
        title: 'Test task',
        input: { data: 'hello' },
        reward: 0.5,
        deadline: '2h',
      })

      expect(result).toHaveProperty('jobId')
      expect(result).toHaveProperty('pubkey')
      expect(result).toHaveProperty('signature')
      expect(result.pubkey).toBeInstanceOf(PublicKey)
      expect(typeof result.jobId).toBe('number')
    })

    it('batches initializeJob + delegateJob as instructions (not transactions)', async () => {
      await sdk.postTask({
        title: 'Batch test',
        input: {},
        reward: 0.1,
        deadline: 3600,
      })

      // Both should be called as .instruction() — proves batching
      expect(methodCalls['initializeJob']).toBeDefined()
      expect(methodCalls['initializeJob'][0].mode).toBe('instruction')
      expect(methodCalls['delegateJob']).toBeDefined()
      expect(methodCalls['delegateJob'][0].mode).toBe('instruction')
    })

    it('handles encrypted privacy level', async () => {
      const result = await sdk.postTask({
        title: 'Private task',
        input: { secret: true },
        reward: 1.0,
        deadline: '1d',
        privacy: 'encrypted',
      })
      expect(result.signature).toBe(mockTxSig)
    })

    it('handles TTD specification', async () => {
      const result = await sdk.postTask({
        title: 'Typed task',
        input: { repo: 'github.com/test' },
        reward: 0.5,
        deadline: '2h',
        ttd: 'code-review-v1',
      })
      expect(result.jobId).toBeGreaterThan(0)
    })

    it('accepts a canonical spec object for spec-hash commitment', async () => {
      const spec: TaskForestSpec = {
        version: 1,
        metadata: { title: 'Spec backed task', tags: ['code-review'] },
        description: 'Review a repo against explicit acceptance criteria',
        acceptance_criteria: [
          { id: 'ac-1', description: 'Report findings', type: 'output', required: true, weight: 100 },
        ],
        constraints: [],
        inputs: [{ type: 'url', description: 'Repository URL', encrypted: false }],
        outputs: [{ type: 'text', description: 'Review report', format: 'markdown' }],
        verification: {
          mode: 'judge',
          config: { rubric: 'Score completeness and correctness', required_criteria_must_pass: true },
        },
      }

      const result = await sdk.postTask({
        title: 'Spec backed task',
        input: { repo: 'github.com/test' },
        spec,
        reward: 0.5,
        deadline: '2h',
      })

      expect(result.jobId).toBeGreaterThan(0)
    })
  })

  // ── bid ──────────────────────────────────────────────────────
  describe('bid', () => {
    it('places bid via placeBid instruction', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const sig = await sdk.bid(jobPubkey, { stake: 0.05 })

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['placeBid']).toBeDefined()
    })
  })

  // ── lockStake ────────────────────────────────────────────────
  describe('lockStake', () => {
    it('locks stake via lockStake instruction', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const sig = await sdk.lockStake(jobPubkey)

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['lockStake']).toBeDefined()
    })
  })

  // ── stakeAndProve (batched) ──────────────────────────────────
  describe('stakeAndProve', () => {
    it('batches lockStake + submitProof as instructions', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const sig = await sdk.stakeAndProve(jobPubkey, { result: 'done' })

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['lockStake']).toBeDefined()
      expect(methodCalls['lockStake'][0].mode).toBe('instruction')
      expect(methodCalls['submitProof']).toBeDefined()
      expect(methodCalls['submitProof'][0].mode).toBe('instruction')
    })
  })

  // ── submitProof ──────────────────────────────────────────────
  describe('submitProof', () => {
    it('submits proof hash', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const sig = await sdk.submitProof(jobPubkey, { analysis: 'looks good' })

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['submitProof']).toBeDefined()
    })
  })

  // ── settle ───────────────────────────────────────────────────
  describe('settle', () => {
    it('throws if job not found', async () => {
      const jobPubkey = Keypair.generate().publicKey
      await expect(sdk.settle(jobPubkey, true)).rejects.toThrow('Job not found')
    })
  })

  // ── settleAndArchive (batched) ───────────────────────────────
  describe('settleAndArchive', () => {
    it('throws if job not found', async () => {
      const jobPubkey = Keypair.generate().publicKey
      await expect(sdk.settleAndArchive(jobPubkey, true)).rejects.toThrow('Job not found')
    })
  })

  // ── compressFinishedJob ──────────────────────────────────────
  describe('compressFinishedJob', () => {
    it('calls compressFinishedJob instruction', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const sig = await sdk.compressFinishedJob(jobPubkey)

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['compressFinishedJob']).toBeDefined()
    })
  })

  // ── storeCredential ──────────────────────────────────────────
  describe('storeCredential', () => {
    it('stores encrypted credential', async () => {
      const jobPubkey = Keypair.generate().publicKey
      const data = new Uint8Array([1, 2, 3, 4])
      const sig = await sdk.storeCredential(jobPubkey, data)

      expect(sig).toBe(mockTxSig)
      expect(methodCalls['storeCredential']).toBeDefined()
    })
  })

  // ── encrypt / decrypt ────────────────────────────────────────
  describe('encrypt/decrypt', () => {
    it('roundtrip encrypt → decrypt', () => {
      const sdk2 = new TaskForest({
        rpc: 'https://api.devnet.solana.com',
        wallet: Keypair.generate(),
      })

      const plaintext = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
      const { encrypted, nonce } = sdk.encrypt(plaintext, sdk2.getEncryptionPublicKey())

      const decrypted = sdk2.decrypt(encrypted, nonce, sdk.getEncryptionPublicKey())
      expect(Array.from(decrypted)).toEqual(Array.from(plaintext))
    })

    it('fails with wrong key', () => {
      const sdk2 = new TaskForest({
        rpc: 'https://api.devnet.solana.com',
        wallet: Keypair.generate(),
      })
      const sdk3 = new TaskForest({
        rpc: 'https://api.devnet.solana.com',
        wallet: Keypair.generate(),
      })

      const plaintext = new Uint8Array([1, 2, 3])
      const { encrypted, nonce } = sdk.encrypt(plaintext, sdk2.getEncryptionPublicKey())
      expect(() => sdk3.decrypt(encrypted, nonce, sdk.getEncryptionPublicKey())).toThrow()
    })
  })

  // ── getBalance ───────────────────────────────────────────────
  describe('getBalance', () => {
    it('returns SOL balance', async () => {
      const balance = await sdk.getBalance()
      expect(balance).toBe(5)
    })
  })

  // ── airdrop ──────────────────────────────────────────────────
  describe('airdrop', () => {
    it('returns signature on devnet', async () => {
      const sig = await sdk.airdrop(2)
      expect(sig).toBe('airdrop_sig')
    })

    it('rejects on mainnet', async () => {
      const mainnetSdk = new TaskForest({
        rpc: 'https://api.mainnet-beta.solana.com',
        wallet,
        network: 'mainnet-beta',
      })
      await expect(mainnetSdk.airdrop()).rejects.toThrow('Airdrop only available on devnet')
    })
  })

  // ── searchTasks ──────────────────────────────────────────────
  describe('searchTasks', () => {
    it('returns empty array when no jobs', async () => {
      const jobs = await sdk.searchTasks()
      expect(jobs).toEqual([])
    })
  })

  // ── getTask ──────────────────────────────────────────────────
  describe('getTask', () => {
    it('returns null for non-existent job', async () => {
      const result = await sdk.getTask(Keypair.generate().publicKey)
      expect(result).toBeNull()
    })
  })

  // ── deadline parsing ─────────────────────────────────────────
  describe('deadline parsing', () => {
    it.each([
      ['2h', 'hours'],
      ['1d', 'days'],
      ['30m', 'minutes'],
      ['1w', 'weeks'],
    ])('parses %s (%s)', async (deadline) => {
      const result = await sdk.postTask({
        title: 'Test', input: {}, reward: 0.1, deadline,
      })
      expect(result.signature).toBe(mockTxSig)
    })

    it('parses numeric seconds', async () => {
      const result = await sdk.postTask({
        title: 'Test', input: {}, reward: 0.1, deadline: 7200,
      })
      expect(result.signature).toBe(mockTxSig)
    })
  })
})
