import { PublicKey, Connection, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Program, AnchorProvider, BN, Wallet, Idl } from '@coral-xyz/anchor'

const PROGRAM_ID = new PublicKey('DFpay111111111111111111111111111111111111111')
const ESCROW_SEED = Buffer.from('escrow')
const SETTLEMENT_SEED = Buffer.from('settlement')

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

function deriveEscrowPda(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, new BN(escrowId).toArrayLike(Buffer, 'le', 8)],
    PROGRAM_ID,
  )
}

function deriveSettlementPda(escrowId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, new BN(escrowId).toArrayLike(Buffer, 'le', 8)],
    PROGRAM_ID,
  )
}

export class DarkForestPayments {
  private program: Program<Idl>
  private provider: AnchorProvider
  private perConnection: Connection | null = null
  private activeSessions: Map<number, MppSessionState> = new Map()

  constructor(provider: AnchorProvider, idl: Idl) {
    this.provider = provider
    this.program = new Program(idl, provider)
  }

  connectToPer(endpoint: string = PER_ENDPOINTS.devnet): void {
    this.perConnection = new Connection(endpoint, 'confirmed')
  }

  // ── On-chain: Escrow Wrapper ──────────────────────────────────

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
    validator: PublicKey = TEE_VALIDATORS.devnet,
  ): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    return this.program.methods
      .delegateToPer()
      .accounts({
        pda: escrowPda,
        payer: this.provider.wallet.publicKey,
        validator,
      })
      .rpc()
  }

  async verifyTeeAttestation(
    escrowId: number,
    attestationReport: Buffer,
    teePubkey: number[],
  ): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    return this.program.methods
      .verifyTeeAttestation(new BN(escrowId), attestationReport, teePubkey)
      .accounts({
        escrow: escrowPda,
        payer: this.provider.wallet.publicKey,
      })
      .rpc()
  }

  async recordSettlement(escrowId: number, totalPaidSol: number): Promise<string> {
    const [escrowPda] = deriveEscrowPda(escrowId)
    const [settlementPda] = deriveSettlementPda(escrowId)
    return this.program.methods
      .recordSettlement(new BN(escrowId), new BN(Math.floor(totalPaidSol * LAMPORTS_PER_SOL)))
      .accounts({
        escrow: escrowPda,
        settlementRecord: settlementPda,
        poster: this.provider.wallet.publicKey,
        payer: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  }

  // ── MPP Session (private via PER) ─────────────────────────────

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
    this.activeSessions.set(escrowId, session)

    // MPP Session would be opened here pointing to PER RPC:
    // const mppSession = new MppSession({ rpc: config.perEndpoint, ... })
    // For now, the session is tracked locally — MPP SDK plugs in when published

    return session
  }

  async recordPayment(escrowId: number, amountLamports: number): Promise<void> {
    const session = this.activeSessions.get(escrowId)
    if (!session || !session.isActive) throw new Error('No active session for this escrow')

    session.totalPaid += amountLamports
    session.requestCount += 1

    // MPP voucher would be sent here inside PER:
    // await mppSession.sendVoucher(amountLamports)
    // PER RPC endpoint ensures this is private
  }

  async closeSession(escrowId: number): Promise<string> {
    const session = this.activeSessions.get(escrowId)
    if (!session) throw new Error('No session for this escrow')

    session.isActive = false
    const totalPaidSol = session.totalPaid / LAMPORTS_PER_SOL

    const tx = await this.recordSettlement(escrowId, totalPaidSol)
    this.activeSessions.delete(escrowId)
    return tx
  }

  // ── Read State ────────────────────────────────────────────────

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

  getActiveSession(escrowId: number): MppSessionState | undefined {
    return this.activeSessions.get(escrowId)
  }

  // ── PDA Helpers ───────────────────────────────────────────────

  static escrowPda(escrowId: number): PublicKey { return deriveEscrowPda(escrowId)[0] }
  static settlementPda(escrowId: number): PublicKey { return deriveSettlementPda(escrowId)[0] }
  static get programId(): PublicKey { return PROGRAM_ID }
}
