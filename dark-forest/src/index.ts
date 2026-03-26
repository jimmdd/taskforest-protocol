import { Program, AnchorProvider, BN, type Idl } from '@coral-xyz/anchor'
import {
  Connection,
  Ed25519Program,
  type Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  type TransactionInstruction,
} from '@solana/web3.js'
export * from './verifier'

export const DARK_FOREST_PROGRAM_ID = new PublicKey('4hNP2tU5r5GgyASTrou84kWHbCwdyXVJJN4mve99rjgs')
export const ESCROW_SEED = Buffer.from('escrow')
export const SETTLEMENT_SEED = Buffer.from('settlement')

export const TEE_VALIDATORS = {
  mainnet: new PublicKey('MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo'),
  devnet: new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA'),
} as const

export const PER_ENDPOINTS = {
  mainnet: 'https://mainnet-tee.magicblock.app',
  devnet: 'https://tee.magicblock.app',
  devnetRouter: 'https://devnet-router.magicblock.app',
} as const

export type MppSessionConfig = {
  agentEndpoint: string
  token: 'SOL' | 'USDC' | 'PYUSD'
  budgetLamports: number
  perEndpoint: string
}

export type MppSessionState = {
  sessionId: string
  escrowId: number
  totalPaid: number
  requestCount: number
  isActive: boolean
}

export interface SessionStore {
  get(escrowId: number): Promise<MppSessionState | null>
  set(session: MppSessionState): Promise<void>
  delete(escrowId: number): Promise<void>
}

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<number, MppSessionState>()

  async get(escrowId: number): Promise<MppSessionState | null> {
    return this.sessions.get(escrowId) ?? null
  }

  async set(session: MppSessionState): Promise<void> {
    this.sessions.set(session.escrowId, session)
  }

  async delete(escrowId: number): Promise<void> {
    this.sessions.delete(escrowId)
  }
}

export class LocalStorageSessionStore implements SessionStore {
  constructor(private readonly storage: Storage, private readonly prefix: string = 'taskforest:dark-forest:session:') {}

  private key(escrowId: number): string {
    return `${this.prefix}${escrowId}`
  }

  async get(escrowId: number): Promise<MppSessionState | null> {
    const raw = this.storage.getItem(this.key(escrowId))
    return raw ? JSON.parse(raw) as MppSessionState : null
  }

  async set(session: MppSessionState): Promise<void> {
    this.storage.setItem(this.key(session.escrowId), JSON.stringify(session))
  }

  async delete(escrowId: number): Promise<void> {
    this.storage.removeItem(this.key(escrowId))
  }
}

export interface EscrowState {
  escrowId: number
  jobPubkey: PublicKey
  poster: PublicKey
  agent: PublicKey
  deposited: number
  status: 'Active' | 'Delegated' | 'Settled'
  teePubkey: number[]
  teeVerified: boolean
  mppSessionId: number[]
  createdAt: number
}

export interface SettlementState {
  escrowId: number
  jobPubkey: PublicKey
  poster: PublicKey
  agent: PublicKey
  totalDeposited: number
  totalPaid: number
  settledAt: number
  settlementHash: number[]
}

export interface TeeAttestationEnvelope {
  escrowId: number
  jobPubkey: PublicKey
  validator: PublicKey
  teePubkey: number[]
  mppSessionId: number[]
  issuedAt: number
  expiresAt: number
}

export interface DarkForestPaymentsOptions {
  sessionStore?: SessionStore
}

function deriveEscrowPda(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, new BN(escrowId).toArrayLike(Buffer, 'le', 8)],
    DARK_FOREST_PROGRAM_ID,
  )
}

function deriveSettlementPda(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, new BN(escrowId).toArrayLike(Buffer, 'le', 8)],
    DARK_FOREST_PROGRAM_ID,
  )
}

export class DarkForestPayments {
  private program: Program<Idl>
  private provider: AnchorProvider
  private sessionStore: SessionStore

  constructor(provider: AnchorProvider, idl: Idl, options: DarkForestPaymentsOptions = {}) {
    this.provider = provider
    this.program = new Program(idl, provider)
    this.sessionStore = options.sessionStore ?? new MemorySessionStore()
  }

  connectToPer(endpoint: string = PER_ENDPOINTS.devnet): Connection {
    return new Connection(endpoint, 'confirmed')
  }

  static buildAttestationReport(envelope: TeeAttestationEnvelope): Buffer {
    return Buffer.concat([
      Buffer.from('TFAT'),
      Buffer.from([1, 0, 0, 0]),
      new BN(envelope.escrowId).toArrayLike(Buffer, 'le', 8),
      envelope.jobPubkey.toBuffer(),
      envelope.validator.toBuffer(),
      Buffer.from(envelope.teePubkey),
      Buffer.from(envelope.mppSessionId),
      new BN(envelope.issuedAt).toTwos(64).toArrayLike(Buffer, 'le', 8),
      new BN(envelope.expiresAt).toTwos(64).toArrayLike(Buffer, 'le', 8),
    ])
  }

  static buildAttestationSignatureInstruction(
    validatorSigner: Keypair,
    report: Buffer,
  ): TransactionInstruction {
    return Ed25519Program.createInstructionWithPrivateKey({
      privateKey: validatorSigner.secretKey,
      message: report,
    })
  }

  async createEscrowWrapper(
    escrowId: number,
    jobPubkey: PublicKey,
    depositSol: number,
    mppSessionId: number[] = Array(32).fill(0),
  ): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    return this.program.methods
      .createEscrowWrapper(
        new BN(escrowId),
        new BN(Math.floor(depositSol * LAMPORTS_PER_SOL)),
        mppSessionId,
      )
      .accounts({
        job: jobPubkey,
        escrow: escrowPda,
        poster: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  }

  async delegateToPer(
    escrowId: number,
    validator?: PublicKey,
  ): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    const method = this.program.methods
      .delegateToPer(new BN(escrowId))
      .accounts({
        pda: escrowPda,
        payer: this.provider.wallet.publicKey,
      })

    if (validator) {
      return method
        .remainingAccounts([{ pubkey: validator, isSigner: false, isWritable: false }])
        .rpc()
    }
    return method.rpc()
  }

  async verifyTeeAttestation(
    escrowId: number,
    attestationReport: Buffer,
    teePubkey: number[],
    signatureInstruction?: TransactionInstruction,
  ): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    const method = this.program.methods
      .verifyTeeAttestation(new BN(escrowId), attestationReport, teePubkey)
      .accounts({
        escrow: escrowPda,
        validator: this.provider.wallet.publicKey,
        payer: this.provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
    if (signatureInstruction) {
      return method.preInstructions([signatureInstruction]).rpc()
    }
    return method
      .rpc()
  }

  async recordSettlement(escrowId: number, totalPaidSol: number): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    const [settlementPda] = deriveSettlementPda(escrowId)
    const escrow = await this.getEscrow(escrowId)
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`)
    return this.program.methods
      .recordSettlement(new BN(escrowId), new BN(Math.floor(totalPaidSol * LAMPORTS_PER_SOL)))
      .accounts({
        escrow: escrowPda,
        settlementRecord: settlementPda,
        poster: this.provider.wallet.publicKey,
        agent: escrow.agent,
        payer: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  }

  async startPrivateSession(
    escrowId: number,
    jobPubkey: PublicKey,
    config: MppSessionConfig,
  ): Promise<MppSessionState> {
    const depositSol = config.budgetLamports / LAMPORTS_PER_SOL
    const sessionId = `dark-${escrowId}-${Date.now()}`
    const sessionIdBytes = Array.from(Buffer.from(sessionId.padEnd(32, '\0').slice(0, 32)))

    await this.createEscrowWrapper(escrowId, jobPubkey, depositSol, sessionIdBytes)
    await this.delegateToPer(escrowId)

    const session: MppSessionState = {
      sessionId,
      escrowId,
      totalPaid: 0,
      requestCount: 0,
      isActive: true,
    }
    await this.sessionStore.set(session)

    return session
  }

  async recordPayment(escrowId: number, amountLamports: number): Promise<void> {
    const session = await this.sessionStore.get(escrowId)
    if (!session || !session.isActive) throw new Error('No active session for this escrow')

    await this.sessionStore.set({
      ...session,
      totalPaid: session.totalPaid + amountLamports,
      requestCount: session.requestCount + 1,
    })
  }

  async closeSession(escrowId: number): Promise<string> {
    const session = await this.sessionStore.get(escrowId)
    if (!session) throw new Error('No session for this escrow')

    await this.sessionStore.set({ ...session, isActive: false })
    const totalPaidSol = session.totalPaid / LAMPORTS_PER_SOL

    const tx = await this.recordSettlement(escrowId, totalPaidSol)
    await this.sessionStore.delete(escrowId)
    return tx
  }

  async getActiveSession(escrowId: number): Promise<MppSessionState | undefined> {
    return (await this.sessionStore.get(escrowId)) ?? undefined
  }

  async getEscrow(escrowId: number): Promise<EscrowState | null> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    try {
      const account = await (this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<Record<string, unknown>> }>).escrowWrapper.fetch(escrowPda)
      const statusMap: Record<number, EscrowState['status']> = { 0: 'Active', 1: 'Delegated', 2: 'Settled' }
      return {
        escrowId: (account.escrowId as BN).toNumber(),
        jobPubkey: account.jobPubkey as PublicKey,
        poster: account.poster as PublicKey,
        agent: account.agent as PublicKey,
        deposited: (account.deposited as BN).toNumber(),
        status: statusMap[(account.status as { active?: unknown }).active !== undefined ? 0 : (account.status as { delegated?: unknown }).delegated !== undefined ? 1 : 2] ?? 'Active',
        teePubkey: account.teePubkey as number[],
        teeVerified: account.teeVerified as boolean,
        mppSessionId: account.mppSessionId as number[],
        createdAt: (account.createdAt as BN).toNumber(),
      }
    } catch {
      return null
    }
  }

  async getSettlement(escrowId: number): Promise<SettlementState | null> {
    const [settlementPda] = deriveSettlementPda(escrowId)
    try {
      const account = await (this.program.account as Record<string, { fetch: (key: PublicKey) => Promise<Record<string, unknown>> }>).settlementRecord.fetch(settlementPda)
      return {
        escrowId: (account.escrowId as BN).toNumber(),
        jobPubkey: account.jobPubkey as PublicKey,
        poster: account.poster as PublicKey,
        agent: account.agent as PublicKey,
        totalDeposited: (account.totalDeposited as BN).toNumber(),
        totalPaid: (account.totalPaid as BN).toNumber(),
        settledAt: (account.settledAt as BN).toNumber(),
        settlementHash: account.settlementHash as number[],
      }
    } catch {
      return null
    }
  }

  static escrowPda(escrowId: number): PublicKey {
    return deriveEscrowPda(escrowId)[0]
  }

  static settlementPda(escrowId: number): PublicKey {
    return deriveSettlementPda(escrowId)[0]
  }
}
