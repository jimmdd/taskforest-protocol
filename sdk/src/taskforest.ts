import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import nacl from 'tweetnacl'
import { createHash } from 'crypto'
import { hashSpec } from './spec'

import {
  TaskForestConfig,
  PostTaskOptions,
  BidOptions,
  TaskFilter,
  Job,
  TaskContext,
  AgentProfile,
  AgentCapabilities,
  PrivacyLevel,
  TaskMetadata,
  GroveAgent,
  RegisterAgentOptions,
  HireAgentOptions,
  HireResult,
  AutoAssignOptions,
  CreateSubJobOptions,
  SubmitVerifiedProofOptions,
  DisputeRecord,
  OpenDisputeOptions,
  ResolveDisputeOptions,
  PosterReputation,
  VerifierVote,
  CastVoteOptions,
} from './types'

// Load IDL from compiled artifact
import idl from '../../target/idl/taskforest.json'

const DEFAULT_PROGRAM_ID = 'Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s'

/** Pre-configured environment presets */
export const ENVIRONMENT_PRESETS = {
  devnet: {
    rpc: 'https://api.devnet.solana.com',
    network: 'devnet' as const,
    programId: DEFAULT_PROGRAM_ID,
  },
  'mainnet-beta': {
    rpc: 'https://api.mainnet-beta.solana.com',
    network: 'mainnet-beta' as const,
    programId: DEFAULT_PROGRAM_ID,
  },
} satisfies Record<string, Omit<TaskForestConfig, 'wallet'>>

const STATUS_LABELS: Record<number, string> = {
  0: 'open',
  1: 'claimed',
  2: 'staked',
  3: 'submitted',
  4: 'settled',
  5: 'failed',
  6: 'wip',
  7: 'verified',
}

const PRIVACY_MAP: Record<PrivacyLevel, number> = {
  public: 0,
  encrypted: 1,
  per: 2,
}

const VERIFICATION_MODE_MAP: Record<'poster_review' | 'test_suite' | 'judge', number> = {
  poster_review: 0,
  test_suite: 1,
  judge: 2,
}

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
export class TaskForest {
  private connection: Connection
  private wallet: Keypair
  private programId: PublicKey
  private program: anchor.Program
  private network: string
  private encryptionKeypair: nacl.BoxKeyPair

  constructor(config: TaskForestConfig) {
    this.connection = new Connection(config.rpc, 'confirmed')
    this.wallet = config.wallet
    this.network = config.network || 'devnet'
    this.programId = new PublicKey(config.programId || DEFAULT_PROGRAM_ID)
    this.encryptionKeypair = nacl.box.keyPair()

    const provider = new anchor.AnchorProvider(
      this.connection,
      {
        publicKey: this.wallet.publicKey,
        signTransaction: async (tx: any) => {
          tx.partialSign(this.wallet)
          return tx
        },
        signAllTransactions: async (txs: any) => {
          txs.forEach((tx: any) => tx.partialSign(this.wallet))
          return txs
        },
      } as any,
      { commitment: 'confirmed' }
    )
    this.program = new anchor.Program(idl as any, provider)
  }

  static devnet(wallet: Keypair, rpcOverride?: string): TaskForest {
    return new TaskForest({
      ...ENVIRONMENT_PRESETS.devnet,
      wallet,
      ...(rpcOverride ? { rpc: rpcOverride } : {}),
    })
  }

  static mainnet(wallet: Keypair, rpcOverride?: string): TaskForest {
    return new TaskForest({
      ...ENVIRONMENT_PRESETS['mainnet-beta'],
      wallet,
      ...(rpcOverride ? { rpc: rpcOverride } : {}),
    })
  }

  // ─── Job PDA Derivation ─────────────────────────────────────
  private getJobPDA(jobId: number): [PublicKey, number] {
    const idBuf = Buffer.alloc(8)
    idBuf.writeBigUInt64LE(BigInt(jobId))
    return PublicKey.findProgramAddressSync(
      [Buffer.from('job'), this.wallet.publicKey.toBuffer(), idBuf],
      this.programId
    )
  }

  // ─── Hashing ────────────────────────────────────────────────
  private hashData(data: any): number[] {
    const hash = createHash('sha256')
      .update(JSON.stringify(data))
      .digest()
    return Array.from(hash)
  }

  private parseDeadline(deadline: string | number): number {
    if (typeof deadline === 'number') {
      return Math.floor(Date.now() / 1000) + deadline
    }
    const match = deadline.match(/^(\d+)(h|d|m|w)$/)
    if (!match) throw new Error(`Invalid deadline format: ${deadline}. Use '2h', '1d', '30m', or '1w'`)
    const value = parseInt(match[1])
    const unit = match[2]
    const multiplier = { m: 60, h: 3600, d: 86400, w: 604800 }[unit] || 3600
    return Math.floor(Date.now() / 1000) + value * multiplier
  }

  // ─── Send Transaction Helper ────────────────────────────────
  private async sendTx(tx: Transaction): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = this.wallet.publicKey
    tx.sign(this.wallet)
    const sig = await this.connection.sendRawTransaction(tx.serialize())
    await this.connection.confirmTransaction(sig, 'confirmed')
    return sig
  }

  // ─── Post Task ──────────────────────────────────────────────
  /**
   * Post a new task with SOL escrow.
   *
   * ```ts
   * const spec = new SpecBuilder('Review my Solana program')
   *   .description('Review the repository and return a markdown report.')
   *   .criterion('ac-1', 'Cover the requested scope', 'coverage', { required: true, weight: 50 })
   *   .criterion('ac-2', 'Return a markdown report', 'output', { required: true, weight: 50 })
   *   .input('url', 'Repository URL')
   *   .output('file', 'Audit report', { format: 'markdown' })
   *   .judgeMode('Score each criterion from 0-100.', 70)
   *   .build()
   *
   * const job = await tf.postTask({
   *   title: spec.metadata.title,
   *   input: { repo_url: 'https://github.com/example/repo' },
   *   spec,
   *   reward: 0.5,
   *   deadline: '2h',
   *   privacy: 'encrypted',
   * })
   * ```
   */
  async postTask(opts: PostTaskOptions): Promise<{ jobId: number; pubkey: PublicKey; signature: string }> {
    const jobId = Math.floor(Math.random() * 2 ** 32)
    const [jobPDA] = this.getJobPDA(jobId)
    const rewardLamports = Math.floor(opts.reward * LAMPORTS_PER_SOL)
    const deadlineSec = this.parseDeadline(opts.deadline)
    const privacyLevel = PRIVACY_MAP[opts.privacy || 'public']
    const specHash = opts.specHash ?? (opts.spec ? hashSpec(opts.spec) : this.hashData({ title: opts.title, ...opts.input }))
    const ttdHash = opts.ttd ? this.hashData(opts.ttd) : Array.from({ length: 32 }, () => 0)
    const encryptionPubkey = privacyLevel > 0
      ? Array.from(this.encryptionKeypair.publicKey)
      : Array.from({ length: 32 }, () => 0)
    const assignmentMode = opts.assignmentMode === 'auto-match' ? 1 : 0
    const verificationLevel = opts.verificationLevel ?? 0
    const verificationMode = VERIFICATION_MODE_MAP[opts.verificationMode ?? opts.spec?.verification.mode ?? 'poster_review']

    // Batch init + delegate into 1 tx (1 signature)
    const initIx = await (this.program.methods as any)
      .initializeJob(
        new anchor.BN(jobId),
        new anchor.BN(rewardLamports),
        new anchor.BN(deadlineSec),
        specHash,
        ttdHash,
        privacyLevel,
        encryptionPubkey,
        assignmentMode,
        verificationLevel,
        verificationMode
      )
      .accounts({ job: jobPDA, poster: this.wallet.publicKey, systemProgram: SystemProgram.programId })
      .instruction()

    const delegateIx = await (this.program.methods as any)
      .delegateJob()
      .accounts({ payer: this.wallet.publicKey, job: jobPDA })
      .instruction()

    const tx = new Transaction().add(initIx).add(delegateIx)
    const sig = await this.sendTx(tx)

    return { jobId, pubkey: jobPDA, signature: sig }
  }

  // ─── Search Tasks ───────────────────────────────────────────
  /**
   * Search for open tasks on-chain.
   *
   * ```ts
   * const tasks = await tf.searchTasks({ minReward: 0.1 })
   * ```
   */
  async searchTasks(filter?: TaskFilter): Promise<Job[]> {
    // Fetch all job accounts (v1=222, v2=254, v3=351 bytes)
    const [v1, v2, v3] = await Promise.all([
      this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 222 }] }),
      this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 254 }] }),
      this.connection.getProgramAccounts(this.programId, { filters: [{ dataSize: 351 }] }),
    ])
    const accounts = [...v1, ...v2, ...v3]

    const jobs: Job[] = []
    for (const { pubkey, account } of accounts) {
      try {
        const decoded = (this.program as any).coder.accounts.decode('job', account.data)
        const job: Job = {
          pubkey,
          jobId: decoded.jobId?.toNumber?.() ?? Number(decoded.jobId),
          poster: decoded.poster,
          worker: decoded.claimer,
          rewardLamports: decoded.rewardLamports?.toNumber?.() ?? Number(decoded.rewardLamports),
          reward: (decoded.rewardLamports?.toNumber?.() ?? Number(decoded.rewardLamports)) / LAMPORTS_PER_SOL,
          deadline: decoded.deadline?.toNumber?.() ?? Number(decoded.deadline),
          status: decoded.status,
          statusLabel: STATUS_LABELS[decoded.status] || 'unknown',
          proofHash: decoded.proofHash || [],
          privacyLevel: decoded.privacyLevel ?? 0,
          specHash: decoded.specHash || [],
          ttdHash: decoded.ttdHash || [],
          claimerStake: decoded.claimerStake?.toNumber?.() ?? 0,
          bestBidStake: decoded.bestBidStake?.toNumber?.() ?? 0,
          bidCount: decoded.bidCount ?? 0,
          assignmentMode: decoded.assignmentMode ?? 0,
          parentJob: decoded.parentJob ?? PublicKey.default,
          subJobCount: decoded.subJobCount ?? 0,
          verificationLevel: decoded.verificationLevel ?? 0,
          verificationMode: decoded.verificationMode ?? 0,
          receiptRoot: decoded.receiptRoot || [],
          receiptUri: decoded.receiptUri || [],
          attestationHash: decoded.attestationHash || [],
          disputeWindowEnd: decoded.disputeWindowEnd?.toNumber?.() ?? 0,
        }

        // Apply filters
        if (filter?.status) {
          const statusMap: Record<string, number> = { open: 0, claimed: 1, staked: 2, submitted: 3 }
          if (job.status !== statusMap[filter.status]) continue
        }
        if (filter?.minReward && job.reward < filter.minReward) continue

        jobs.push(job)
      } catch { /* skip malformed */ }
    }

    return jobs.sort((a, b) => b.jobId - a.jobId)
  }

  // ─── Get Task Details ───────────────────────────────────────
  /**
   * Get details for a specific job by PDA pubkey.
   */
  async getTask(jobPubkey: PublicKey): Promise<Job | null> {
    try {
      const account = await this.connection.getAccountInfo(jobPubkey)
      if (!account) return null
      const decoded = (this.program as any).coder.accounts.decode('job', account.data)
      return {
        pubkey: jobPubkey,
        jobId: decoded.jobId?.toNumber?.() ?? Number(decoded.jobId),
        poster: decoded.poster,
        worker: decoded.claimer,
        rewardLamports: decoded.rewardLamports?.toNumber?.() ?? 0,
        reward: (decoded.rewardLamports?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
        deadline: decoded.deadline?.toNumber?.() ?? 0,
        status: decoded.status,
        statusLabel: STATUS_LABELS[decoded.status] || 'unknown',
        proofHash: decoded.proofHash || [],
        privacyLevel: decoded.privacyLevel ?? 0,
          specHash: decoded.specHash || [],
        ttdHash: decoded.ttdHash || [],
        claimerStake: decoded.claimerStake?.toNumber?.() ?? 0,
        bestBidStake: decoded.bestBidStake?.toNumber?.() ?? 0,
        bidCount: decoded.bidCount ?? 0,
        assignmentMode: decoded.assignmentMode ?? 0,
        parentJob: decoded.parentJob ?? PublicKey.default,
        subJobCount: decoded.subJobCount ?? 0,
        verificationLevel: decoded.verificationLevel ?? 0,
        verificationMode: decoded.verificationMode ?? 0,
        receiptRoot: decoded.receiptRoot || [],
        receiptUri: decoded.receiptUri || [],
        attestationHash: decoded.attestationHash || [],
        disputeWindowEnd: decoded.disputeWindowEnd?.toNumber?.() ?? 0,
      }
    } catch {
      return null
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
  async bid(jobPubkey: PublicKey, opts: BidOptions): Promise<string> {
    const stakeLamports = Math.floor(opts.stake * LAMPORTS_PER_SOL)
    const tx = await (this.program.methods as any)
      .placeBid(new anchor.BN(stakeLamports))
      .accounts({ bidder: this.wallet.publicKey, job: jobPubkey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Lock Stake ─────────────────────────────────────────────
  /**
   * Lock SOL stake after winning a bid.
   */
  async lockStake(jobPubkey: PublicKey): Promise<string> {
    const tx = await (this.program.methods as any)
      .lockStake()
      .accounts({ worker: this.wallet.publicKey, job: jobPubkey, systemProgram: SystemProgram.programId })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Batched: Stake + Prove (1 tx, 1 sign) ─────────────────
  /**
   * Lock stake and submit proof in a single transaction.
   *
   * ```ts
   * await tf.stakeAndProve(jobPubkey, { analysis: '...' })
   * ```
   */
  async stakeAndProve(jobPubkey: PublicKey, result: any): Promise<string> {
    const proofHash = this.hashData(result)

    const stakeIx = await (this.program.methods as any)
      .lockStake()
      .accounts({ job: jobPubkey, claimer: this.wallet.publicKey, systemProgram: SystemProgram.programId })
      .instruction()

    const proveIx = await (this.program.methods as any)
      .submitProof(proofHash)
      .accounts({ job: jobPubkey, submitter: this.wallet.publicKey })
      .instruction()

    const tx = new Transaction().add(stakeIx).add(proveIx)
    return this.sendTx(tx)
  }

  // ─── Submit Proof ───────────────────────────────────────────
  /**
   * Submit proof of completed work.
   *
   * ```ts
   * await tf.submitProof(jobPubkey, { review: '...', severity: 'minor' })
   * ```
   */
  async submitProof(jobPubkey: PublicKey, result: any): Promise<string> {
    const proofHash = this.hashData(result)
    const tx = await (this.program.methods as any)
      .submitProof(proofHash)
      .accounts({ worker: this.wallet.publicKey, job: jobPubkey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Submit Encrypted Proof ─────────────────────────────────
  /**
   * Submit proof with encrypted I/O hashes (privacy mode).
   */
  async submitEncryptedProof(
    jobPubkey: PublicKey,
    result: any,
    encryptedInputHash: number[],
  ): Promise<string> {
    const proofHash = this.hashData(result)
    const encryptedOutputHash = this.hashData({ encrypted: true, output: result })
    const tx = await (this.program.methods as any)
      .submitEncryptedProof(proofHash, encryptedInputHash, encryptedOutputHash)
      .accounts({ worker: this.wallet.publicKey, job: jobPubkey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Settle Job ─────────────────────────────────────────────
  /**
   * Settle a job (poster only). Verdict: 1 = pass, 2 = fail.
   */
  async settle(jobPubkey: PublicKey, pass: boolean): Promise<string> {
    const verdict = pass ? 1 : 2
    const job = await this.getTask(jobPubkey)
    if (!job) throw new Error('Job not found')
    const tx = await (this.program.methods as any)
      .settleJob(verdict)
      .accounts({ poster: this.wallet.publicKey, job: jobPubkey, worker: job.worker })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Archive Settlement ─────────────────────────────────────
  /**
   * Archive a settled job for permanent record.
   */
  async archiveSettlement(jobPubkey: PublicKey): Promise<string> {
    const [archivePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('archive'), jobPubkey.toBuffer()],
      this.programId
    )
    const tx = await (this.program.methods as any)
      .archiveSettlement()
      .accounts({
        poster: this.wallet.publicKey,
        job: jobPubkey,
        archive: archivePDA,
        systemProgram: SystemProgram.programId,
      })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Batched: Settle + Archive (1 tx, 1 sign) ──────────────
  /**
   * Settle and archive in a single transaction.
   *
   * ```ts
   * await tf.settleAndArchive(jobPubkey, true)
   * ```
   */
  async settleAndArchive(jobPubkey: PublicKey, pass: boolean): Promise<string> {
    const verdict = pass ? 1 : 2
    const job = await this.getTask(jobPubkey)
    if (!job) throw new Error('Job not found')

    const [archivePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('archive'), jobPubkey.toBuffer()],
      this.programId
    )

    const settleIx = await (this.program.methods as any)
      .settleJob(verdict)
      .accounts({ poster: this.wallet.publicKey, job: jobPubkey, worker: job.worker })
      .instruction()

    const archiveIx = await (this.program.methods as any)
      .archiveSettlement()
      .accounts({
        poster: this.wallet.publicKey,
        job: jobPubkey,
        archive: archivePDA,
        systemProgram: SystemProgram.programId,
      })
      .instruction()

    const tx = new Transaction().add(settleIx).add(archiveIx)
    return this.sendTx(tx)
  }

  // ─── Compress Finished Job (ZK) ─────────────────────────────
  /**
   * Compress a finished job PDA into a Merkle leaf and reclaim rent.
   * Requires Light Protocol indexer in production.
   */
  async compressFinishedJob(jobPubkey: PublicKey): Promise<string> {
    const tx = await (this.program.methods as any)
      .compressFinishedJob()
      .accounts({ poster: this.wallet.publicKey, job: jobPubkey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Store Credential ──────────────────────────────────────
  /**
   * Store encrypted credential in the on-chain vault.
   */
  async storeCredential(jobPubkey: PublicKey, data: Uint8Array): Promise<string> {
    const [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault'), jobPubkey.toBuffer()],
      this.programId
    )
    const tx = await (this.program.methods as any)
      .storeCredential(Array.from(data))
      .accounts({
        poster: this.wallet.publicKey,
        job: jobPubkey,
        vault: vaultPDA,
        systemProgram: SystemProgram.programId,
      })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Watch Tasks (onTask) ───────────────────────────────────
  /**
   * Watch for matching tasks and execute a handler.
   *
   * ```ts
   * tf.onTask({ minReward: 0.1, status: 'open' }, async (task) => {
   *   const input = await task.getInput()
   *   await task.submitProof(result)
   * })
   * ```
   */
  onTask(filter: TaskFilter, handler: (ctx: TaskContext) => Promise<void>): { stop: () => void } {
    let running = true
    const seen = new Set<string>()

    const poll = async () => {
      while (running) {
        try {
          const jobs = await this.searchTasks({ ...filter, status: 'open' })
          for (const job of jobs) {
            const key = job.pubkey.toBase58()
            if (seen.has(key)) continue
            seen.add(key)

            const ctx: TaskContext = {
              job,
              getInput: async () => {
                // In a real implementation, fetch + decrypt off-chain metadata
                return { jobId: job.jobId, reward: job.reward }
              },
              submitProof: async (result: any) => {
                return this.submitProof(job.pubkey, result)
              },
            }
            handler(ctx).catch(console.error)
          }
        } catch (e) {
          console.error('TaskForest poll error:', e)
        }
        // Poll every 10 seconds
        await new Promise(r => setTimeout(r, 10_000))
      }
    }
    poll()

    return { stop: () => { running = false } }
  }

  // ─── Encrypt / Decrypt ──────────────────────────────────────
  /**
   * Encrypt data with the recipient's public key.
   */
  encrypt(data: Uint8Array, recipientPubkey: Uint8Array): { encrypted: Uint8Array; nonce: Uint8Array } {
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const encrypted = nacl.box(data, nonce, recipientPubkey, this.encryptionKeypair.secretKey)
    if (!encrypted) throw new Error('Encryption failed')
    return { encrypted, nonce }
  }

  /**
   * Decrypt data from a sender's public key.
   */
  decrypt(encrypted: Uint8Array, nonce: Uint8Array, senderPubkey: Uint8Array): Uint8Array {
    const decrypted = nacl.box.open(encrypted, nonce, senderPubkey, this.encryptionKeypair.secretKey)
    if (!decrypted) throw new Error('Decryption failed')
    return decrypted
  }

  // ─── Utilities ──────────────────────────────────────────────
  /** Get the program ID */
  getProgramId(): PublicKey { return this.programId }

  /** Get the wallet's public key */
  getPublicKey(): PublicKey { return this.wallet.publicKey }

  /** Get the encryption public key */
  getEncryptionPublicKey(): Uint8Array { return this.encryptionKeypair.publicKey }

  /** Get SOL balance */
  async getBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(this.wallet.publicKey)
    return lamports / LAMPORTS_PER_SOL
  }

  /** Request devnet airdrop */
  async airdrop(sol: number = 1): Promise<string> {
    if (this.network !== 'devnet') throw new Error('Airdrop only available on devnet')
    const sig = await this.connection.requestAirdrop(this.wallet.publicKey, sol * LAMPORTS_PER_SOL)
    await this.connection.confirmTransaction(sig, 'confirmed')
    return sig
  }

  // ─── The Grove: Agent Registry ──────────────────────────────
  /**
   * Register an agent in The Grove (ZK compressed).
   *
   * ```ts
   * const agent = await tf.registerAgent({
   *   name: 'SentinelBot',
   *   description: 'Security auditor for Solana programs',
   *   ttds: ['code-review-v1'],
   *   priceMin: 0.3,
   *   priceMax: 0.8,
   *   stakeAmount: 1.0,
   * })
   * ```
   */
  async registerAgent(opts: RegisterAgentOptions): Promise<{ pubkey: PublicKey; signature: string }> {
    const stakeLamports = Math.floor(opts.stakeAmount * LAMPORTS_PER_SOL)
    const profileHash = this.hashData({
      name: opts.name,
      description: opts.description,
      ttds: opts.ttds,
      priceMin: opts.priceMin,
      priceMax: opts.priceMax,
    })

    const [agentPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), this.wallet.publicKey.toBuffer()],
      this.programId
    )

    const tx = await (this.program.methods as any)
      .registerAgent(profileHash, new anchor.BN(stakeLamports))
      .accounts({
        agent: agentPDA,
        owner: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction()

    const sig = await this.sendTx(tx)
    return { pubkey: agentPDA, signature: sig }
  }

  /**
   * Get an agent's profile from The Grove.
   *
   * ```ts
   * const agent = await tf.getAgent('7xKX...q9Rf')
   * ```
   */
  async getAgent(walletAddress: string): Promise<GroveAgent | null> {
    const walletPubkey = new PublicKey(walletAddress)
    const [agentPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), walletPubkey.toBuffer()],
      this.programId
    )

    try {
      const account = await this.connection.getAccountInfo(agentPDA)
      if (!account) return null
      const decoded = (this.program as any).coder.accounts.decode('agentProfile', account.data)
      return {
        pubkey: walletAddress,
        name: decoded.name || '',
        description: decoded.description || '',
        ttds: decoded.ttds || [],
        priceMin: (decoded.priceMin?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
        priceMax: (decoded.priceMax?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
        reputation: decoded.reputation ?? 0,
        totalJobs: decoded.totalJobs ?? 0,
        successRate: decoded.successRate ?? 0,
        stakeAmount: (decoded.stakeAmount?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
        registeredAt: decoded.registeredAt?.toNumber?.() ?? 0,
        lastActive: decoded.lastActive?.toNumber?.() ?? 0,
        compressed: decoded.compressed ?? false,
      }
    } catch {
      return null
    }
  }

  /**
   * Search for agents in The Grove.
   *
   * ```ts
   * const agents = await tf.searchAgents({ ttds: ['code-review-v1'], maxPrice: 0.5 })
   * ```
   */
  async searchAgents(filter?: { ttds?: string[]; maxPrice?: number; minReputation?: number }): Promise<GroveAgent[]> {
    // Fetch all agent profile accounts
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [{ memcmp: { offset: 0, bytes: 'agent' } }],
    })

    const agents: GroveAgent[] = []
    for (const { account } of accounts) {
      try {
        const decoded = (this.program as any).coder.accounts.decode('agentProfile', account.data)
        const agent: GroveAgent = {
          pubkey: decoded.owner?.toBase58?.() ?? '',
          name: decoded.name || '',
          description: decoded.description || '',
          ttds: decoded.ttds || [],
          priceMin: (decoded.priceMin?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
          priceMax: (decoded.priceMax?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
          reputation: decoded.reputation ?? 0,
          totalJobs: decoded.totalJobs ?? 0,
          successRate: decoded.successRate ?? 0,
          stakeAmount: (decoded.stakeAmount?.toNumber?.() ?? 0) / LAMPORTS_PER_SOL,
          registeredAt: decoded.registeredAt?.toNumber?.() ?? 0,
          lastActive: decoded.lastActive?.toNumber?.() ?? 0,
          compressed: decoded.compressed ?? false,
        }

        // Apply filters
        if (filter?.ttds && !agent.ttds.some(t => filter.ttds!.includes(t))) continue
        if (filter?.maxPrice && agent.priceMin > filter.maxPrice) continue
        if (filter?.minReputation && agent.reputation < filter.minReputation) continue

        agents.push(agent)
      } catch { /* skip malformed */ }
    }

    return agents.sort((a, b) => b.reputation - a.reputation)
  }

  /**
   * Update an agent's reputation after job completion (called internally by settle).
   */
  async updateAgentReputation(agentWallet: PublicKey, passed: boolean): Promise<string> {
    const [agentPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('agent'), agentWallet.toBuffer()],
      this.programId
    )

    const tx = await (this.program.methods as any)
      .updateReputation(passed)
      .accounts({
        agent: agentPDA,
        authority: this.wallet.publicKey,
      })
      .transaction()

    return this.sendTx(tx)
  }

  // ─── Auto-Assign Job (Router) ────────────────────────────────
  async autoAssignJob(opts: AutoAssignOptions): Promise<string> {
    const tx = await (this.program.methods as any)
      .autoAssignJob(opts.assignedAgent)
      .accounts({ job: opts.jobPubkey, poster: this.wallet.publicKey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Create Sub-Job ────────────────────────────────────────
  async createSubJob(opts: CreateSubJobOptions): Promise<{ subJobPubkey: PublicKey; signature: string }> {
    const idBuf = Buffer.alloc(8)
    idBuf.writeBigUInt64LE(BigInt(opts.subJobId))
    const posterKey = (await this.getTask(opts.parentJobPubkey))?.poster
    if (!posterKey) throw new Error('Parent job not found')

    const [subJobPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('job'), posterKey.toBuffer(), idBuf],
      this.programId,
    )

    const tx = await (this.program.methods as any)
      .createSubJob(
        new anchor.BN(opts.subJobId),
        opts.assignedAgent,
        new anchor.BN(opts.rewardLamports),
        new anchor.BN(opts.deadline),
        opts.ttdHash,
      )
      .accounts({
        parentJob: opts.parentJobPubkey,
        subJob: subJobPDA,
        orchestrator: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction()

    const sig = await this.sendTx(tx)
    return { subJobPubkey: subJobPDA, signature: sig }
  }

  // ─── Submit Verified Proof ─────────────────────────────────
  async submitVerifiedProof(opts: SubmitVerifiedProofOptions): Promise<string> {
    const tx = await (this.program.methods as any)
      .submitVerifiedProof(
        opts.proofHash,
        opts.receiptRoot,
        opts.receiptUri,
        opts.attestationHash,
      )
      .accounts({ job: opts.jobPubkey, submitter: this.wallet.publicKey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Auto-Settle (dispute window expired) ──────────────────
  async autoSettle(jobPubkey: PublicKey): Promise<string> {
    const tx = await (this.program.methods as any)
      .autoSettle()
      .accounts({ job: jobPubkey, claimer: this.wallet.publicKey })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Open Dispute ───────────────────────────────────────────
  async openDispute(opts: OpenDisputeOptions): Promise<{ disputePubkey: PublicKey; signature: string }> {
    const threadBuf = Buffer.alloc(4)
    threadBuf.writeUInt32LE(opts.disputedThread)

    const [disputePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('dispute'), opts.jobPubkey.toBuffer(), threadBuf],
      this.programId,
    )

    const tx = await (this.program.methods as any)
      .openDispute(
        opts.disputedThread,
        opts.challengerReceiptHash,
        opts.evidenceUri,
      )
      .accounts({
        job: opts.jobPubkey,
        dispute: disputePDA,
        challenger: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction()

    const sig = await this.sendTx(tx)
    return { disputePubkey: disputePDA, signature: sig }
  }

  // ─── Resolve Dispute ──────────────────────────────────────
  async resolveDispute(opts: ResolveDisputeOptions): Promise<string> {
    const tx = await (this.program.methods as any)
      .resolveDispute(opts.verdict)
      .accounts({
        job: opts.jobPubkey,
        dispute: opts.disputePubkey,
        resolver: this.wallet.publicKey,
        challengerAccount: opts.challengerPubkey,
      })
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Get Dispute ──────────────────────────────────────────
  async getDispute(jobPubkey: PublicKey, threadId: number): Promise<DisputeRecord | null> {
    const threadBuf = Buffer.alloc(4)
    threadBuf.writeUInt32LE(threadId)

    const [disputePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('dispute'), jobPubkey.toBuffer(), threadBuf],
      this.programId,
    )

    try {
      const account = await this.connection.getAccountInfo(disputePDA)
      if (!account) return null
      const decoded = (this.program as any).coder.accounts.decode('disputeRecord', account.data)
      return {
        pubkey: disputePDA,
        job: decoded.job,
        specHash: decoded.specHash || [],
        challenger: decoded.challenger,
        challengerStake: decoded.challengerStake?.toNumber?.() ?? 0,
        disputedThread: decoded.disputedThread ?? 0,
        challengerReceiptHash: decoded.challengerReceiptHash || [],
        originalReceiptHash: decoded.originalReceiptHash || [],
        status: decoded.status ?? 0,
        evidenceUri: decoded.evidenceUri || [],
        openedAt: decoded.openedAt?.toNumber?.() ?? 0,
        resolvedAt: decoded.resolvedAt?.toNumber?.() ?? 0,
      }
    } catch {
      return null
    }
  }

  // ─── Cast Panel Vote ────────────────────────────────────────
  async castVote(opts: CastVoteOptions): Promise<{ votePubkey: PublicKey; signature: string }> {
    const [votePDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('vote'), opts.disputePubkey.toBuffer(), this.wallet.publicKey.toBuffer()],
      this.programId,
    )

    const tx = await (this.program.methods as any)
      .castVote(opts.verdict)
      .accounts({
        dispute: opts.disputePubkey,
        vote: votePDA,
        verifier: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .transaction()

    const sig = await this.sendTx(tx)
    return { votePubkey: votePDA, signature: sig }
  }

  // ─── Tally Panel ──────────────────────────────────────────
  async tallyPanel(
    jobPubkey: PublicKey,
    disputePubkey: PublicKey,
    challengerPubkey: PublicKey,
    votePubkeys: PublicKey[],
  ): Promise<string> {
    const tx = await (this.program.methods as any)
      .tallyPanel()
      .accounts({
        job: jobPubkey,
        dispute: disputePubkey,
        resolver: this.wallet.publicKey,
        challengerAccount: challengerPubkey,
      })
      .remainingAccounts(
        votePubkeys.map((pk) => ({ pubkey: pk, isWritable: false, isSigner: false })),
      )
      .transaction()
    return this.sendTx(tx)
  }

  // ─── Hire Agent (end-to-end) ──────────────────────────────────
  /**
   * Hire an agent end-to-end: match → post task → escrow → auto-assign.
   *
   * ```ts
   * const result = await tf.hireAgent({
   *   problem: 'Review my Solana program for security vulnerabilities',
   *   maxBudget: 0.5,
   *   deadline: '2h',
   *   privacy: 'encrypted',
   * })
   * console.log(result.agent.name, result.signature)
   * ```
   */
  async hireAgent(opts: HireAgentOptions): Promise<HireResult> {
    // 1. Search for matching agents
    const agents = await this.searchAgents({
      ttds: opts.ttd ? [opts.ttd] : undefined,
      maxPrice: opts.maxBudget,
    })

    if (agents.length === 0) {
      throw new Error('No agents found matching your requirements and budget')
    }

    // 2. Pick best match (highest reputation within budget)
    const bestAgent = agents[0] // Already sorted by reputation

    // 3. Post the task with escrow
    const job = await this.postTask({
      title: opts.problem,
      ttd: opts.ttd || bestAgent.ttds[0],
      input: { problem: opts.problem, context: opts.context || {} },
      reward: Math.min(opts.maxBudget, bestAgent.priceMax),
      deadline: opts.deadline,
      privacy: opts.privacy,
    })

    return {
      jobId: job.jobId,
      jobPubkey: job.pubkey.toBase58(),
      agent: bestAgent,
      escrowedSol: Math.min(opts.maxBudget, bestAgent.priceMax),
      signature: job.signature,
    }
  }
}
