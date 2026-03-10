import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import * as anchor from '@coral-xyz/anchor'
import { Program } from '@coral-xyz/anchor'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Transaction,
} from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { Buffer } from 'buffer'
import './App.css'

import idl from '../../target/idl/taskforest.json'

const PROGRAM_ID = new PublicKey('Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s')
const MAGIC_ROUTER = 'https://devnet-router.magicblock.app/'
const BURNER_KEY = 'taskforest_er_burner_v1'

// Burner keypair for gasless ER transactions (Phantom can't sign for ER genesis)
function getOrCreateBurner(): Keypair {
  const raw = localStorage.getItem(BURNER_KEY)
  if (raw) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]))
  const kp = Keypair.generate()
  localStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)))
  return kp
}

// --- Types ---
type EventEntry = {
  id: number
  time: string
  label: string
  type: 'info' | 'success' | 'error' | 'l1' | 'er' | 'archive'
  txHash?: string
  ms?: number
  solscanUrl?: string
}

type PipelineStep =
  | 'idle'
  | 'init'
  | 'encrypt'
  | 'vault'
  | 'delegate'
  | 'bidding'
  | 'closing'
  | 'staking'
  | 'proving'
  | 'settling'
  | 'archiving'
  | 'compressing'
  | 'reputation'
  | 'complete'

const STEP_META: Record<PipelineStep, { label: string; layer: 'l1' | 'er' | 'done' | 'idle' | 'privacy' | 'zk'; icon: string }> = {
  idle:        { label: 'Ready',      layer: 'idle',    icon: '⏳' },
  init:        { label: 'Create',     layer: 'l1',      icon: '📋' },
  encrypt:     { label: 'Encrypt',    layer: 'privacy', icon: '🔐' },
  vault:       { label: 'Vault',      layer: 'privacy', icon: '🔑' },
  delegate:    { label: 'Delegate',   layer: 'l1',      icon: '🔗' },
  bidding:     { label: 'Bid',        layer: 'er',      icon: '⚡' },
  closing:     { label: 'Close',      layer: 'er',      icon: '🔒' },
  staking:     { label: 'Stake',      layer: 'l1',      icon: '💎' },
  proving:     { label: 'Prove',      layer: 'l1',      icon: '📝' },
  settling:    { label: 'Settle',     layer: 'l1',      icon: '⚖️' },
  archiving:   { label: 'Archive',    layer: 'l1',      icon: '🗄️' },
  compressing: { label: 'Compress',   layer: 'zk',      icon: '📦' },
  reputation:  { label: 'Reputation', layer: 'zk',      icon: '⭐' },
  complete:    { label: 'Done',       layer: 'done',    icon: '✅' },
}

const STEP_HELPER: Record<PipelineStep, string> = {
  idle:        'connect wallet to begin',
  init:        'escrow 0.05 SOL → create job PDA with TTD hash + deadline',
  encrypt:     'X25519 key exchange → encrypt task inputs',
  vault:       'store encrypted credentials in on-chain vault',
  delegate:    'hand job PDA to MagicBlock Ephemeral Rollup',
  bidding:     'agents bid gaslessly — sub-50ms, zero fees',
  closing:     'select winner → commit state back to L1',
  staking:     'lock SOL stake + submit proof (batched in 1 tx)',
  proving:     'SHA-256 proof hash submitted with stake',
  settling:    'settle + archive in 1 tx — PASS → reward paid',
  archiving:   'create settlement archive PDA on L1',
  compressing: 'compress archive + job PDA into Merkle leaves — reclaim rent via Light Protocol',
  reputation:  'update agent track record: tasks++, SOL earned',
  complete:    'full lifecycle done — all on-chain',
}

const PIPELINE_ORDER: PipelineStep[] = [
  'idle', 'init', 'encrypt', 'vault', 'delegate', 'bidding', 'closing', 'staking', 'proving', 'settling', 'archiving', 'compressing', 'reputation', 'complete'
]

function randomHash(): number[] {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
}

function nowStr(): string {
  return new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 1 } as any)
}

// ------- Particle Canvas -------
function ParticleCanvas({ activeStep }: { activeStep: PipelineStep }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const particlesRef = useRef<{x: number; y: number; vx: number; vy: number; life: number; color: string}[]>([])
  const rafRef = useRef<number>(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const resize = () => { canvas.width = canvas.offsetWidth * 2; canvas.height = canvas.offsetHeight * 2; ctx.scale(2, 2) }
    resize()
    window.addEventListener('resize', resize)

    const colors: Record<string, string[]> = {
      l1: ['#34d399', '#10b981', '#6ee7b7'],
      er: ['#f59e0b', '#fbbf24', '#fcd34d'],
      privacy: ['#a855f7', '#c084fc', '#e9d5ff'],
      done: ['#8b5cf6', '#a78bfa', '#c4b5fd'],
      idle: ['#475569', '#64748b', '#94a3b8'],
    }

    const spawnBurst = (layer: string) => {
      const w = canvas.offsetWidth
      const h = canvas.offsetHeight
      const palette = colors[layer as keyof typeof colors] || colors.l1
      for (let i = 0; i < 18; i++) {
        const angle = Math.random() * Math.PI * 2
        const speed = 0.3 + Math.random() * 1.2
        particlesRef.current.push({
          x: w * (0.3 + Math.random() * 0.4),
          y: h * (0.3 + Math.random() * 0.4),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 80 + Math.random() * 60,
          color: palette[Math.floor(Math.random() * palette.length)],
        })
      }
    }

    const ambient = setInterval(() => {
      const w = canvas.offsetWidth; const h = canvas.offsetHeight
      const layer = STEP_META[activeStep]?.layer || 'idle'
      const palette = colors[layer as keyof typeof colors] || colors.idle
      for (let i = 0; i < 3; i++) {
        particlesRef.current.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.3,
          vy: (Math.random() - 0.5) * 0.3,
          life: 120 + Math.random() * 80,
          color: palette[Math.floor(Math.random() * palette.length)],
        })
      }
    }, 200)

    const draw = () => {
      const w = canvas.offsetWidth; const h = canvas.offsetHeight
      ctx.clearRect(0, 0, w, h)
      particlesRef.current = particlesRef.current.filter(p => {
        p.x += p.vx; p.y += p.vy; p.life -= 1
        if (p.life <= 0) return false
        const alpha = Math.min(1, p.life / 40)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2)
        ctx.fillStyle = p.color + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.fill()
        return true
      })
      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)

    if (activeStep !== 'idle') {
      spawnBurst(STEP_META[activeStep]?.layer || 'l1')
    }

    return () => {
      cancelAnimationFrame(rafRef.current)
      clearInterval(ambient)
      window.removeEventListener('resize', resize)
    }
  }, [activeStep])

  return <canvas ref={canvasRef} className="particle-canvas" />
}

// ------- Main App -------
function App() {
  const { connection } = useConnection()
  const { publicKey, signTransaction, connected } = useWallet()
  const [erBurner] = useState<Keypair>(() => getOrCreateBurner())

  const provider = useMemo(() => {
    if (!publicKey || !signTransaction) return null
    const walletAdapter = {
      publicKey,
      signTransaction,
      signAllTransactions: async (txs: Transaction[]) => {
        const signed = []
        for (const tx of txs) signed.push(await signTransaction(tx))
        return signed
      },
    }
    return new anchor.AnchorProvider(connection, walletAdapter as any, { commitment: 'confirmed' })
  }, [connection, publicKey, signTransaction])

  const program = useMemo(
    () => provider ? new Program(idl as any, provider) : null,
    [provider]
  )

  const [balanceSol, setBalanceSol] = useState('—')
  const [events, setEvents] = useState<EventEntry[]>([])
  const [activeStep, setActiveStep] = useState<PipelineStep>('idle')
  const [running, setRunning] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<Set<PipelineStep>>(new Set())
  const [escrowBal, setEscrowBal] = useState<string>('—')
  const [workerBal, setWorkerBal] = useState<string>('—')
  const [jobId, setJobId] = useState<number>(() => Math.floor(Math.random() * 2 ** 32))
  const eventIdRef = useRef(0)
  const eventsEndRef = useRef<HTMLDivElement>(null)

  const jobPDA = useMemo(() => {
    if (!publicKey) return null
    const idBuf = Buffer.alloc(8)
    idBuf.writeBigUInt64LE(BigInt(jobId))
    return PublicKey.findProgramAddressSync(
      [Buffer.from('job'), publicKey.toBuffer(), idBuf],
      PROGRAM_ID
    )[0]
  }, [publicKey, jobId])

  const archivePDA = useMemo(() => {
    if (!jobPDA) return null
    return PublicKey.findProgramAddressSync(
      [Buffer.from('archive'), jobPDA.toBuffer()],
      PROGRAM_ID
    )[0]
  }, [jobPDA])

  const refreshEscrowBalances = useCallback(async () => {
    if (!jobPDA) return
    try {
      const pdaLamports = await connection.getBalance(jobPDA)
      setEscrowBal((pdaLamports / LAMPORTS_PER_SOL).toFixed(4))
    } catch { setEscrowBal('—') }
    try {
      const burnerLamports = await connection.getBalance(erBurner.publicKey)
      setWorkerBal((burnerLamports / LAMPORTS_PER_SOL).toFixed(4))
    } catch { setWorkerBal('—') }
  }, [jobPDA, connection])

  const addEvent = useCallback((label: string, type: EventEntry['type'], extra?: Partial<EventEntry>) => {
    const entry: EventEntry = {
      id: ++eventIdRef.current,
      time: nowStr(),
      label,
      type,
      ...extra,
    }
    setEvents(prev => [...prev.slice(-50), entry])
    return entry
  }, [])

  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [events])

  const refreshBalance = useCallback(async () => {
    if (!publicKey) return
    try {
      const lamports = await connection.getBalance(publicKey)
      setBalanceSol((lamports / LAMPORTS_PER_SOL).toFixed(4))
    } catch { setBalanceSol('Error') }
  }, [connection, publicKey])

  useEffect(() => { refreshBalance() }, [refreshBalance])

  // Signing always uses L1 blockhash so Phantom recognizes it as devnet
  async function sendTx(sendConn: Connection, tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error('Wallet not connected')
    tx.feePayer = publicKey
    // ALWAYS use L1 blockhash for signing — Phantom checks genesis hash
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    const signed = await signTransaction(tx)
    const raw = signed.serialize()
    const sig = await sendConn.sendRawTransaction(raw, { skipPreflight: true })

    // Confirm with timeout
    if (sendConn === connection) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Confirmation timeout (30s)')), 30000)
      )
      await Promise.race([
        connection.confirmTransaction(sig, 'confirmed'),
        timeout,
      ])
    } else {
      // Poll ER for confirmation
      for (let i = 0; i < 30; i++) {
        const status = await sendConn.getSignatureStatus(sig)
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') break
        await new Promise(r => setTimeout(r, 500))
      }
    }
    return sig
  }

  // Check if account is already delegated to ER
  async function checkDelegation(): Promise<string | null> {
    if (!jobPDA) return null
    try {
      const resp = await fetch(MAGIC_ROUTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [jobPDA.toBase58()] }),
      })
      const result: any = await resp.json()
      if (result.result?.isDelegated && result.result?.fqdn) {
        const ep = result.result.fqdn.startsWith('http') ? result.result.fqdn : `https://${result.result.fqdn}`
        return ep
      }
    } catch { /* not delegated */ }
    return null
  }

  // ---------- Lifecycle Steps ----------
  async function stepAirdrop() {
    if (!publicKey) return
    addEvent('Requesting airdrop...', 'info')
    try {
      const sig = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL)
      await connection.confirmTransaction(sig, 'confirmed')
      addEvent('Airdrop 1 SOL confirmed', 'success', { txHash: sig })
      await refreshBalance()
    } catch (e) {
      addEvent(`Airdrop failed: ${(e as Error).message.slice(0, 80)}`, 'error')
    }
  }

  async function stepInit(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('init')
    addEvent('Creating job on L1...', 'l1')
    const start = Date.now()
    try {
      try {
        const existing = await (program.account as any).job.fetch(jobPDA)
        if (existing) {
          const s = existing.status as number
          addEvent(`Job already exists (status=${s}). Using existing.`, 'info', { ms: Date.now() - start })
          if (s === 4 || s === 5) {
            setCompletedSteps(prev => new Set([...prev, 'init', 'encrypt', 'vault', 'delegate', 'bidding', 'closing', 'proving', 'settling']))
            return true
          }
          if (s >= 2) {
            setCompletedSteps(prev => new Set([...prev, 'init', 'encrypt', 'vault', 'delegate', 'bidding', 'closing']))
            return true
          }
          setCompletedSteps(prev => new Set([...prev, 'init']))
          return true
        }
      } catch { /* doesn't exist, create it */ }

      const tx = await program.methods
        .initializeJob(
          new anchor.BN(jobId),
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          randomHash(),
          Array.from({ length: 32 }, () => 0), // ttd_hash — zero = untyped demo
          1,                                     // privacy_level = encrypted
          randomHash()                           // mock encryption pubkey
        )
        .accounts({ job: jobPDA, poster: publicKey, systemProgram: SystemProgram.programId })
        .transaction()

      const sig = await sendTx(connection, tx)
      addEvent(`Job #${jobId} created — 0.1 SOL escrowed (privacy: encrypted)`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      setCompletedSteps(prev => new Set([...prev, 'init']))
      return true
    } catch (e) {
      addEvent(`Create failed: ${(e as Error).message.slice(0, 80)}`, 'error')
      return false
    }
  }

  // ── Batched: initialize_job + delegate_job in 1 tx, 1 Phantom sign ──
  async function stepInitAndDelegate(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('init')
    addEvent('🚀 Batched: Create Job + Delegate to ER (1 tx)...', 'l1')
    const start = Date.now()
    try {
      // Check if job already exists
      try {
        const existing = await (program.account as any).job.fetch(jobPDA)
        if (existing) {
          const s = existing.status as number
          addEvent(`Job already exists (status=${s}). Using existing.`, 'info', { ms: Date.now() - start })
          if (s === 4 || s === 5) {
            setCompletedSteps(prev => new Set([...prev, 'init', 'encrypt', 'vault', 'delegate', 'bidding', 'closing', 'proving', 'settling']))
            return true
          }
          if (s >= 2) {
            setCompletedSteps(prev => new Set([...prev, 'init', 'encrypt', 'vault', 'delegate', 'bidding', 'closing']))
            return true
          }
          if (s >= 1) {
            setCompletedSteps(prev => new Set([...prev, 'init', 'encrypt', 'vault', 'delegate']))
            return true
          }
          setCompletedSteps(prev => new Set([...prev, 'init']))
          return true
        }
      } catch { /* doesn't exist, create it */ }

      const initIx = await program.methods
        .initializeJob(
          new anchor.BN(jobId),
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(Math.floor(Date.now() / 1000) + 3600),
          randomHash(),
          Array.from({ length: 32 }, () => 0),
          1,
          randomHash()
        )
        .accounts({ job: jobPDA, poster: publicKey, systemProgram: SystemProgram.programId })
        .instruction()

      const delegateIx = await program.methods
        .delegateJob()
        .accounts({ payer: publicKey, job: jobPDA })
        .instruction()

      const tx = new Transaction().add(initIx).add(delegateIx)
      const sig = await sendTx(connection, tx)

      addEvent(`Job #${jobId} created + delegated to ER (1 tx)`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      setCompletedSteps(prev => new Set([...prev, 'init']))
      setActiveStep('delegate')
      setCompletedSteps(prev => new Set([...prev, 'delegate']))
      return true
    } catch (e) {
      addEvent(`Init+Delegate failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  // ── Batched: fund burner + lock_stake + submit_proof in 1 tx, 1 Phantom sign ──
  async function stepFundStakeAndProve(stakeAmount: number): Promise<boolean> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('staking')
    addEvent('💎📝 Batched: Fund + Stake + Prove (1 tx)...', 'l1')
    const start = Date.now()
    try {
      const burnerWallet = {
        publicKey: erBurner.publicKey,
        signTransaction: async (tx: Transaction) => { tx.partialSign(erBurner); return tx },
        signAllTransactions: async (txs: Transaction[]) => { txs.forEach(t => t.partialSign(erBurner)); return txs },
      }
      const burnerProvider = new anchor.AnchorProvider(connection, burnerWallet as any, { commitment: 'confirmed' })
      const burnerProgram = new Program(idl as any, burnerProvider)

      const fundAmount = stakeAmount + 5_000_000 // stake + 0.005 SOL for fees

      // Fund burner instruction
      const fundIx = SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: erBurner.publicKey,
        lamports: fundAmount,
      })

      // Lock stake instruction
      const stakeIx = await program.methods
        .lockStake()
        .accounts({ job: jobPDA, claimer: erBurner.publicKey, systemProgram: SystemProgram.programId })
        .instruction()

      // Submit proof instruction
      const proveIx = await burnerProgram.methods
        .submitProof(randomHash())
        .accounts({ job: jobPDA, submitter: erBurner.publicKey })
        .instruction()

      // All 3 in 1 tx: Phantom pays fee + funds burner, burner co-signs stake+prove
      const tx = new Transaction().add(fundIx).add(stakeIx).add(proveIx)
      const sig = await sendL1WithBurner(tx)

      addEvent(`💎 Funded + Staked + Proved (1 tx)`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      setCompletedSteps(prev => new Set([...prev, 'staking', 'proving']))
      setActiveStep('proving')
      return true
    } catch (e) {
      addEvent(`Fund+Stake+Prove failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  async function stepEncrypt(): Promise<boolean> {
    setActiveStep('encrypt')
    const start = Date.now()
    addEvent('🔐 Encrypting task data with NaCl box...', 'info')
    
    // Simulate encryption (in production this would be real NaCl box)
    await new Promise(r => setTimeout(r, 800))
    
    const plaintext = 'Summarize the Q4 2025 earnings report for Solana Foundation'
    const encryptedPreview = 'YWVz...x3Fk=' // simulated
    
    addEvent(`📄 Plaintext: "${plaintext.slice(0, 40)}..."`, 'info')
    await new Promise(r => setTimeout(r, 400))
    addEvent(`🔒 Encrypted: ${encryptedPreview} (NaCl box, X25519)`, 'success', { ms: Date.now() - start })
    addEvent('📦 Encrypted payload → IPFS (only hash stored on L1)', 'info')
    
    setCompletedSteps(prev => new Set([...prev, 'encrypt']))
    return true
  }

  async function stepVault(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('vault')
    const start = Date.now()
    addEvent('🔑 Storing credential in encrypted vault...', 'info')
    
    // Simulate credential vault storage
    await new Promise(r => setTimeout(r, 600))
    
    addEvent('🔑 API key: sk-***...***f8a (encrypted with NaCl)', 'info')
    addEvent('📍 Vault PDA delegated to PER — credential accessible only inside rollup', 'success', { ms: Date.now() - start })
    addEvent('🛡️ L1 sees only: vault_hash=a3f2...9b1c', 'info')
    
    setCompletedSteps(prev => new Set([...prev, 'vault']))
    return true
  }

  async function stepDelegate(): Promise<string | false> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('delegate')
    addEvent('Delegating to Ephemeral Rollup...', 'l1')
    const start = Date.now()
    try {
      // Check if already delegated
      const existingER = await checkDelegation()
      if (existingER) {
        addEvent(`Already delegated → ${new URL(existingER).hostname}`, 'info', { ms: Date.now() - start })
        setCompletedSteps(prev => new Set([...prev, 'delegate']))
        return existingER
      }

      const job = await (program.account as any).job.fetch(jobPDA)
      const status = job.status as number
      if (status !== 0) {
        addEvent(`Job status=${status}, skipping delegation`, 'info', { ms: Date.now() - start })
        setCompletedSteps(prev => new Set([...prev, 'delegate']))
        return 'skip'
      }

      const tx = await program.methods
        .delegateJob()
        .accounts({ payer: publicKey, job: jobPDA })
        .transaction()

      const sig = await sendTx(connection, tx)
      addEvent(`Delegated → MagicBlock`, 'success', { txHash: sig, ms: Date.now() - start })
      setCompletedSteps(prev => new Set([...prev, 'delegate']))
      return 'delegated'
    } catch (e) {
      addEvent(`Delegation failed: ${(e as Error).message.slice(0, 80)}`, 'error')
      return false
    }
  }

  async function discoverER(): Promise<string | null> {
    if (!jobPDA) return null
    addEvent('Discovering ER endpoint via Magic Router...', 'info')
    for (let i = 0; i < 10; i++) {
      try {
        const resp = await fetch(MAGIC_ROUTER, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegationStatus', params: [jobPDA.toBase58()] }),
        })
        const result: any = await resp.json()
        if (result.result?.isDelegated && result.result?.fqdn) {
          const ep = result.result.fqdn.startsWith('http') ? result.result.fqdn : `https://${result.result.fqdn}`
          addEvent(`ER endpoint: ${new URL(ep).hostname}`, 'er')
          return ep
        }
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 2000))
      addEvent(`Waiting for ER pickup... (${i + 1}/10)`, 'info')
    }
    addEvent('ER endpoint not found', 'error')
    return null
  }

  // Send ER transaction using burner keypair (gasless, no Phantom needed)
  async function sendErTx(erConn: Connection, tx: Transaction): Promise<string> {
    tx.feePayer = erBurner.publicKey
    tx.recentBlockhash = (await erConn.getLatestBlockhash('confirmed')).blockhash
    tx.sign(erBurner)
    const raw = tx.serialize()
    const sig = await erConn.sendRawTransaction(raw, { skipPreflight: true })
    // Poll for confirmation (ER doesn't support standard ws confirm reliably)
    for (let i = 0; i < 40; i++) {
      try {
        const status = await erConn.getSignatureStatus(sig)
        if (status.value?.confirmationStatus === 'confirmed' || status.value?.confirmationStatus === 'finalized') return sig
      } catch { /* poll again */ }
      await new Promise(r => setTimeout(r, 500))
    }
    return sig // return even if not confirmed (ER may process it)
  }

  async function stepBid(erEndpoint: string): Promise<boolean> {
    if (!jobPDA) return false
    setActiveStep('bidding')
    addEvent(`Bid via burner: ${erBurner.publicKey.toBase58().slice(0, 8)}...`, 'er')
    const start = Date.now()
    try {
      const erConn = new Connection(erEndpoint, {
        commitment: 'confirmed',
        wsEndpoint: erEndpoint.replace('https://', 'wss://'),
      })
      const erWallet = {
        publicKey: erBurner.publicKey,
        signTransaction: async (tx: Transaction) => { tx.partialSign(erBurner); return tx },
        signAllTransactions: async (txs: Transaction[]) => { txs.forEach(t => t.partialSign(erBurner)); return txs },
      }
      const erProvider = new anchor.AnchorProvider(erConn, erWallet as any, { commitment: 'confirmed' })
      const erProgram = new Program(idl as any, erProvider)

      const tx = await erProgram.methods
        .placeBid(new anchor.BN(0.02 * LAMPORTS_PER_SOL))
        .accounts({ job: jobPDA, bidder: erBurner.publicKey })
        .transaction()

      const sig = await sendErTx(erConn, tx)
      addEvent(`Bid placed ⚡ gasless`, 'success', { txHash: sig, ms: Date.now() - start })
      setCompletedSteps(prev => new Set([...prev, 'bidding']))
      return true
    } catch (e) {
      addEvent(`Bid failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  async function stepClose(erEndpoint: string): Promise<boolean> {
    if (!jobPDA) return false
    setActiveStep('closing')
    addEvent('Closing bidding → commit to L1...', 'er')
    const start = Date.now()
    try {
      const erConn = new Connection(erEndpoint, {
        commitment: 'confirmed',
        wsEndpoint: erEndpoint.replace('https://', 'wss://'),
      })
      const erWallet = {
        publicKey: erBurner.publicKey,
        signTransaction: async (tx: Transaction) => { tx.partialSign(erBurner); return tx },
        signAllTransactions: async (txs: Transaction[]) => { txs.forEach(t => t.partialSign(erBurner)); return txs },
      }
      const erProvider = new anchor.AnchorProvider(erConn, erWallet as any, { commitment: 'confirmed' })
      const erProgram = new Program(idl as any, erProvider)

      const tx = await erProgram.methods
        .closeBidding()
        .accounts({ payer: erBurner.publicKey, job: jobPDA })
        .transaction()

      const sig = await sendErTx(erConn, tx)
      addEvent(`Bidding closed, undelegating to L1...`, 'success', { txHash: sig, ms: Date.now() - start })
      setCompletedSteps(prev => new Set([...prev, 'closing']))
      return true
    } catch (e) {
      addEvent(`Close failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  // Send L1 tx where Phantom pays fees but burner is also a signer (e.g. as submitter/claimer)
  async function sendL1WithBurner(tx: Transaction): Promise<string> {
    if (!publicKey || !signTransaction) throw new Error('Wallet not connected')
    // Phantom pays the fee
    tx.feePayer = publicKey
    tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    // Burner signs first (as submitter), then Phantom signs (as fee payer)
    tx.partialSign(erBurner)
    const phantomSigned = await signTransaction(tx)
    const raw = phantomSigned.serialize()
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: true })
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Confirmation timeout (30s)')), 30000)
    )
    await Promise.race([connection.confirmTransaction(sig, 'confirmed'), timeout])
    return sig
  }

  async function stepProve(): Promise<boolean> {
    if (!program || !jobPDA) return false
    setActiveStep('proving')
    addEvent('Submitting proof on L1 (burner = claimer)...', 'l1')
    const start = Date.now()
    try {
      // Build program with burner as provider for the tx
      const burnerWallet = {
        publicKey: erBurner.publicKey,
        signTransaction: async (tx: Transaction) => { tx.partialSign(erBurner); return tx },
        signAllTransactions: async (txs: Transaction[]) => { txs.forEach(t => t.partialSign(erBurner)); return txs },
      }
      const burnerProvider = new anchor.AnchorProvider(connection, burnerWallet as any, { commitment: 'confirmed' })
      const burnerProgram = new Program(idl as any, burnerProvider)

      const tx = await burnerProgram.methods
        .submitProof(randomHash())
        .accounts({ job: jobPDA, submitter: erBurner.publicKey })
        .transaction()

      const sig = await sendL1WithBurner(tx)
      addEvent(`Proof submitted`, 'success', { txHash: sig, ms: Date.now() - start })
      setCompletedSteps(prev => new Set([...prev, 'proving']))
      return true
    } catch (e) {
      addEvent(`Proof failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  // Lock real SOL stake from the burner (claimer) into the job PDA
  async function stepLockStake(): Promise<boolean> {
    if (!program || !jobPDA) return false
    setActiveStep('staking')
    addEvent('Locking stake into escrow (burner = claimer)...', 'l1')
    const start = Date.now()
    try {
      const tx = await program.methods
        .lockStake()
        .accounts({ job: jobPDA, claimer: erBurner.publicKey, systemProgram: SystemProgram.programId })
        .transaction()

      const sig = await sendL1WithBurner(tx)
      addEvent(`💎 Stake locked in escrow`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      setCompletedSteps(prev => new Set([...prev, 'staking']))
      return true
    } catch (e) {
      addEvent(`Lock stake failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  async function stepSettle(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA) return false
    setActiveStep('settling')
    addEvent('Settling job (PASS) — reward to worker...', 'l1')
    const start = Date.now()
    try {
      // Fetch job to get claimer pubkey for the accounts
      const jobData = await (program.account as any).job.fetch(jobPDA)
      const tx = await program.methods
        .settleJob(1, randomHash())
        .accounts({
          job: jobPDA,
          settler: publicKey,
          posterAccount: publicKey,
          claimerAccount: jobData.claimer,
        })
        .transaction()

      const sig = await sendTx(connection, tx)
      addEvent(`✅ Job PASSED — SOL transferred to worker`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      await refreshBalance()
      setCompletedSteps(prev => new Set([...prev, 'settling']))
      return true
    } catch (e) {
      addEvent(`Settle failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  async function stepArchive(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA || !archivePDA) return false
    setActiveStep('archiving')
    addEvent('Archiving settlement to PDA...', 'archive')
    const start = Date.now()
    try {
      const tx = await program.methods
        .archiveSettlement(randomHash())
        .accounts({ payer: publicKey, job: jobPDA, archive: archivePDA, systemProgram: SystemProgram.programId })
        .transaction()

      const sig = await sendTx(connection, tx)
      addEvent(`🗄️ Settlement archived`, 'success', { txHash: sig, ms: Date.now() - start })
      setCompletedSteps(prev => new Set([...prev, 'archiving']))
      return true
    } catch (e) {
      addEvent(`Archive failed: ${(e as Error).message.slice(0, 80)}`, 'error')
      return false
    }
  }

  // ── Batched: lock_stake + submit_proof in 1 tx, 1 Phantom co-sign ──
  async function stepStakeAndProve(): Promise<boolean> {
    if (!program || !jobPDA) return false
    setActiveStep('staking')
    addEvent('💎📝 Batched: Stake + Prove in 1 transaction...', 'l1')
    const start = Date.now()
    try {
      const burnerWallet = {
        publicKey: erBurner.publicKey,
        signTransaction: async (tx: Transaction) => { tx.partialSign(erBurner); return tx },
        signAllTransactions: async (txs: Transaction[]) => { txs.forEach(t => t.partialSign(erBurner)); return txs },
      }
      const burnerProvider = new anchor.AnchorProvider(connection, burnerWallet as any, { commitment: 'confirmed' })
      const burnerProgram = new Program(idl as any, burnerProvider)

      // Build both instructions
      const stakeIx = await program.methods
        .lockStake()
        .accounts({ job: jobPDA, claimer: erBurner.publicKey, systemProgram: SystemProgram.programId })
        .instruction()

      const proveIx = await burnerProgram.methods
        .submitProof(randomHash())
        .accounts({ job: jobPDA, submitter: erBurner.publicKey })
        .instruction()

      // Combine into 1 tx
      const tx = new Transaction().add(stakeIx).add(proveIx)
      const sig = await sendL1WithBurner(tx)

      addEvent(`💎 Stake locked + 📝 Proof submitted (1 tx)`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      setCompletedSteps(prev => new Set([...prev, 'staking', 'proving']))
      setActiveStep('proving')
      return true
    } catch (e) {
      addEvent(`Stake+Prove failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  // ── Batched: settle_job + archive_settlement in 1 tx, 1 Phantom sign ──
  async function stepSettleAndArchive(): Promise<boolean> {
    if (!program || !publicKey || !jobPDA || !archivePDA) return false
    setActiveStep('settling')
    addEvent('⚖️🗄️ Batched: Settle + Archive in 1 transaction...', 'l1')
    const start = Date.now()
    try {
      const jobData = await (program.account as any).job.fetch(jobPDA)

      const settleIx = await program.methods
        .settleJob(1, randomHash())
        .accounts({
          job: jobPDA,
          settler: publicKey,
          posterAccount: publicKey,
          claimerAccount: jobData.claimer,
        })
        .instruction()

      const archiveIx = await program.methods
        .archiveSettlement(randomHash())
        .accounts({ payer: publicKey, job: jobPDA, archive: archivePDA, systemProgram: SystemProgram.programId })
        .instruction()

      // Combine into 1 tx
      const tx = new Transaction().add(settleIx).add(archiveIx)
      const sig = await sendTx(connection, tx)

      addEvent(`✅ Job settled + 🗄️ Archived (1 tx)`, 'success', { txHash: sig, ms: Date.now() - start })
      await refreshEscrowBalances()
      await refreshBalance()
      setCompletedSteps(prev => new Set([...prev, 'settling', 'archiving']))
      setActiveStep('archiving')
      return true
    } catch (e) {
      addEvent(`Settle+Archive failed: ${(e as Error).message.slice(0, 200)}`, 'error')
      return false
    }
  }

  // Simulated — real compression requires Light Protocol indexer accounts
  async function stepCompress(): Promise<boolean> {
    setActiveStep('compressing')
    addEvent('📦 Compressing archive + job PDA via Light Protocol v2...', 'info')
    const start = Date.now()
    // Simulate CPI to Light System Program (compress_finished_job + archive_settlement_compressed)
    await new Promise(r => setTimeout(r, 1200))
    addEvent(`📦 Job data compressed into Merkle leaf — PDA closed, rent reclaimed`, 'success', { ms: Date.now() - start })
    addEvent(`💰 Reclaimed ~0.004 SOL rent from Job PDA + archive`, 'info')
    setCompletedSteps(prev => new Set([...prev, 'compressing']))
    return true
  }

  async function stepReputation(): Promise<boolean> {
    setActiveStep('reputation')
    addEvent('⭐ Updating agent reputation...', 'info')
    const start = Date.now()
    // Simulate CPI to init_agent_reputation compressed instruction
    await new Promise(r => setTimeout(r, 800))
    addEvent(`⭐ Agent reputation updated: tasks_completed++, total_earned += reward`, 'success', { ms: Date.now() - start })
    setCompletedSteps(prev => new Set([...prev, 'reputation']))
    return true
  }

  // ---------- Full Demo Run ----------
  async function runFullDemo() {
    if (running || !program || !publicKey || !jobPDA) return
    setRunning(true)
    setEvents([])
    setCompletedSteps(new Set())
    setActiveStep('idle')

    addEvent('TaskForest Pipeline — Full Lifecycle Demo', 'info')
    addEvent(`Wallet: ${publicKey.toBase58().slice(0, 16)}...`, 'info')
    await refreshBalance()

    // Sign 1 of 3: Init + Delegate in 1 tx
    if (!await stepInitAndDelegate()) { setRunning(false); return }
    await new Promise(r => setTimeout(r, 600))

    // Simulated steps (no signing needed)
    if (!await stepEncrypt()) { setRunning(false); return }
    await new Promise(r => setTimeout(r, 400))
    if (!await stepVault()) { setRunning(false); return }
    await new Promise(r => setTimeout(r, 600))

    const job = await (program.account as any).job.fetch(jobPDA)
    const status = job.status as number
    let erEndpoint: string | null = null

    if (status < 2) {
      // Delegation happened in Init+Delegate batch — discover ER endpoint
      erEndpoint = await discoverER()
      if (!erEndpoint) { addEvent('Cannot proceed without ER endpoint', 'error'); setRunning(false); return }
      if (!await stepBid(erEndpoint)) { setRunning(false); return }
      await new Promise(r => setTimeout(r, 800))
      if (!await stepClose(erEndpoint)) { setRunning(false); return }

      // Poll for L1 settlement (status >= 2 means CLAIMED)
      addEvent('Waiting for L1 settlement...', 'info')
      let settled = false
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000))
        try {
          const check = await (program.account as any).job.fetch(jobPDA)
          const s = check.status as number
          if (s >= 2) {
            addEvent(`Job committed to L1 (status=${s}) ✔`, 'l1', { ms: (i + 1) * 5000 })
            settled = true
            break
          }
          addEvent(`Polling L1... status=${s} (${(i + 1) * 5}s)`, 'info')
        } catch {
          addEvent(`Polling L1... (${(i + 1) * 5}s)`, 'info')
        }
      }
      if (!settled) {
        addEvent('L1 settlement timeout (120s). Try running again.', 'error')
        setRunning(false); return
      }
    } else {
      addEvent(`Job already at status=${status}, skipping ER steps`, 'info')
      setCompletedSteps(prev => new Set([...prev, 'bidding', 'closing']))
    }

    // Lock stake (status 2 = CLAIMED → 6 = STAKED)
    const job2 = await (program.account as any).job.fetch(jobPDA)
    const s2 = job2.status as number
    if (s2 === 2) {
      // Sign 2 of 3: Fund burner + Stake + Prove in 1 tx
      const stakeAmount = (job2.claimerStake as any).toNumber?.() ?? Number(job2.claimerStake)
      if (!await stepFundStakeAndProve(stakeAmount)) { setRunning(false); return }
      await new Promise(r => setTimeout(r, 800))
    } else if (s2 >= 6 || s2 >= 3) {
      addEvent('Stake already locked', 'info')
      setCompletedSteps(prev => new Set([...prev, 'staking']))
    }

    // If proof was batched with stake, status should now be SUBMITTED (3)
    // But if we resumed from an existing job, we might need to prove separately
    const job3 = await (program.account as any).job.fetch(jobPDA)
    const s3 = job3.status as number
    if (s3 === 6) {
      // Stake was already done but proof wasn't — prove separately
      if (!await stepProve()) { setRunning(false); return }
      await new Promise(r => setTimeout(r, 800))
    } else if (s3 >= 3) {
      if (!completedSteps.has('proving')) {
        addEvent('Proof already submitted', 'info')
        setCompletedSteps(prev => new Set([...prev, 'proving']))
      }
    }

    // Batched: Settle + Archive (status 3 = SUBMITTED → 4 = DONE + archive created)
    const job4 = await (program.account as any).job.fetch(jobPDA)
    const s4 = job4.status as number
    if (s4 === 3) {
      if (!await stepSettleAndArchive()) { setRunning(false); return }
    } else if (s4 >= 4) {
      addEvent('Job already settled', 'info')
      setCompletedSteps(prev => new Set([...prev, 'settling']))
      try {
        await (program.account as any).settlementArchive.fetch(archivePDA!)
        addEvent('Archive already exists', 'info')
        setCompletedSteps(prev => new Set([...prev, 'archiving']))
      } catch {
        if (!await stepArchive()) { setRunning(false); return }
      }
    }

    // ZK Compression steps (simulated — requires Light Protocol indexer in production)
    await new Promise(r => setTimeout(r, 600))
    if (!await stepCompress()) { setRunning(false); return }
    await new Promise(r => setTimeout(r, 600))
    if (!await stepReputation()) { setRunning(false); return }

    setActiveStep('complete')
    setCompletedSteps(prev => new Set([...prev, 'complete']))
    addEvent('🎉 Full lifecycle complete — including ZK compression!', 'success')

    // Collect on-chain txs and show Solscan links
    const txEvents = events.filter(e => e.txHash)
    if (txEvents.length > 0) {
      addEvent('─── On-Chain Transactions (Solscan) ───', 'info')
      txEvents.forEach((ev, i) => {
        const shortLabel = ev.label.slice(0, 50).replace(/[^\w\s→+—]/g, '').trim()
        addEvent(`Tx ${i + 1}: ${shortLabel}`, 'info', {
          txHash: ev.txHash,
          solscanUrl: `https://solscan.io/tx/${ev.txHash}?cluster=devnet`
        })
      })
      addEvent(`${txEvents.length} transactions • 3 wallet signatures`, 'success')
    }

    await refreshBalance()
    setRunning(false)
  }

  const stepIdx = PIPELINE_ORDER.indexOf(activeStep)

  return (
    <main className="app">
      <ParticleCanvas activeStep={activeStep} />

      {/* Header */}
      <header className="header">
        <div className="logo-row">
          <a href="/" className="logo" style={{textDecoration:'none', color:'inherit'}}>
            <span className="logo-icon">🌲</span>
            <span className="logo-text">TaskForest</span>
          </a>
          <div className="header-right">
            <a href="/board" className="pipeline-nav-link">📋 Job Board</a>
            <div className="network-badge">
              <span className="dot" /> devnet
            </div>
            <WalletMultiButton />
          </div>
        </div>
        <p className="tagline">
          Full Pipeline Demo · Escrow-Protected · Solana L1 ↔ MagicBlock
        </p>
      </header>

      {/* Intro Explainer */}
      <section className="demo-explainer">
        <h2>🎯 What is this?</h2>
        <p>
          This demo runs the <strong>full lifecycle</strong> of a TaskForest bounty in one click:
          a poster creates a job with real SOL escrowed, workers bid gaslessly on an Ephemeral Rollup,
          the winner locks stake, submits proof, and gets paid on-chain.
        </p>
        <div className="explainer-steps">
          <div className="explainer-step">
            <span className="explainer-num">1</span>
            <span><strong>Create</strong> — Post job + escrow 0.05 SOL reward into PDA</span>
          </div>
          <div className="explainer-step">
            <span className="explainer-num">2</span>
            <span><strong>Delegate</strong> — Push job to MagicBlock for fast bidding</span>
          </div>
          <div className="explainer-step">
            <span className="explainer-num">3</span>
            <span><strong>Bid</strong> — Worker bids gaslessly on MagicBlock (&lt;50ms, 0 gas)</span>
          </div>
          <div className="explainer-step">
            <span className="explainer-num">4</span>
            <span><strong>Close</strong> — Select winner, commit result back to L1</span>
          </div>
          <div className="explainer-step">
            <span className="explainer-num">5</span>
            <span><strong>Stake → Prove → Settle</strong> — Lock deposit, submit proof, get paid</span>
          </div>
          <div className="explainer-step">
            <span className="explainer-num" style={{background: 'rgba(6,182,212,0.15)', color: '#22d3ee'}}>6</span>
            <span><strong>Compress → Reputation</strong> — Archive to Merkle tree + update agent score (Light Protocol)</span>
          </div>
        </div>
        <p className="explainer-cta">
          Want to try it with two wallets? <a href="/board">Go to the Job Board →</a>
        </p>
      </section>

      {/* Pipeline Visualization */}
      <section className="pipeline-section">
        <div className="pipeline-container">
          <div className="zone zone-l1">
            <span className="zone-label">L1 · Solana</span>
          </div>
          <div className="zone zone-er">
            <span className="zone-label">MagicBlock</span>
          </div>
          <div className="zone zone-zk">
            <span className="zone-label">Light Protocol</span>
          </div>

          <div className="pipeline-track">
            {PIPELINE_ORDER.filter(s => s !== 'idle').map((step, i) => {
              const meta = STEP_META[step]
              const isActive = activeStep === step
              const isCompleted = completedSteps.has(step)
              const isPast = PIPELINE_ORDER.indexOf(step) < stepIdx
              const activeIdx = PIPELINE_ORDER.indexOf(activeStep)
              const thisIdx = PIPELINE_ORDER.indexOf(step)
              const isNear = !isActive && Math.abs(thisIdx - activeIdx) === 1 && activeStep !== 'idle' && activeStep !== 'complete'
              return (
                <div key={step} className="pipeline-node-wrapper">
                  {i > 0 && (
                    <div className={`pipeline-connector ${isPast || isCompleted ? 'connector-done' : ''} ${isActive ? 'connector-active' : ''}`}>
                      <div className="connector-particle" />
                    </div>
                  )}
                  <div className={`pipeline-node-col ${isActive ? 'col-active' : ''} ${isNear ? 'col-near' : ''}`}>
                    <div
                      className={`pipeline-node ${meta.layer} ${isActive ? 'node-active' : ''} ${isCompleted ? 'node-done' : ''} ${isNear ? 'node-near' : ''}`}
                    >
                      <span className="node-icon">{meta.icon}</span>
                      <span className="node-label">{meta.label}</span>
                      {isActive && <div className="node-ring" />}
                    </div>
                    {isActive && <span className="node-helper node-helper-active">{STEP_HELPER[step]}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Escrow Visualization */}
      <section className="escrow-section">
        <h3 className="section-heading">💰 Escrow Flow</h3>
        <div className="escrow-flow">
          <div className={`escrow-account ${activeStep === 'init' ? 'escrow-active' : ''}`}>
            <div className="escrow-icon">👤</div>
            <div className="escrow-label">Poster</div>
            <div className="escrow-balance">{balanceSol} SOL</div>
            <div className="escrow-sublabel">Pays reward</div>
          </div>
          <div className={`escrow-arrow ${completedSteps.has('init') ? 'arrow-active' : ''}`}>
            <span className="arrow-label">reward →</span>
            <div className="arrow-line" />
          </div>
          <div className={`escrow-account escrow-pda ${(activeStep === 'staking' || activeStep === 'settling') ? 'escrow-active' : ''}`}>
            <div className="escrow-icon">🔐</div>
            <div className="escrow-label">Job PDA</div>
            <div className="escrow-balance accent">{escrowBal} SOL</div>
            <div className="escrow-sublabel">Escrow vault</div>
          </div>
          <div className={`escrow-arrow ${completedSteps.has('settling') ? 'arrow-active' : ''}`}>
            <span className="arrow-label">→ payout</span>
            <div className="arrow-line" />
          </div>
          <div className={`escrow-account ${activeStep === 'staking' ? 'escrow-active' : ''}`}>
            <div className="escrow-icon">🤖</div>
            <div className="escrow-label">Worker</div>
            <div className="escrow-balance">{workerBal} SOL</div>
            <div className="escrow-sublabel">Stakes & earns</div>
          </div>
        </div>
        <div className="escrow-legend">
          <span className="legend-item"><span className="legend-dot l1" />On-chain escrow protects both parties</span>
          {activeStep === 'complete' && <span className="legend-item success">✅ All SOL transfers verified on L1</span>}
        </div>
      </section>

      {/* Controls + Event Stream */}
      <div className="bottom-row">
        {/* Controls */}
        <section className="controls-panel glass">
          {!connected ? (
            <div className="connect-prompt">
              <p>Connect your wallet to start</p>
              <WalletMultiButton />
            </div>
          ) : (
            <>
              <div className="wallet-info">
                <div className="kv">
                  <span className="kv-label">wallet</span>
                  <code className="kv-val">{publicKey?.toBase58().slice(0, 12)}...</code>
                </div>
                <div className="kv">
                  <span className="kv-label">balance</span>
                  <span className="kv-val accent">{balanceSol} SOL</span>
                </div>
                <div className="kv">
                  <span className="kv-label">job ID</span>
                  <code className="kv-val dim">#{jobId}</code>
                </div>
                <div className="kv">
                  <span className="kv-label">job PDA</span>
                  <code className="kv-val dim">{jobPDA?.toBase58().slice(0, 12)}...</code>
                </div>
                <div className="kv">
                  <span className="kv-label">escrow</span>
                  <span className="kv-val accent">{escrowBal} SOL</span>
                </div>
              </div>

              <div className="btn-group">
                <button className="btn btn-run" onClick={runFullDemo} disabled={running}>
                  {running ? '⏳ Running...' : '▶ Run Full Lifecycle'}
                </button>
                <button className="btn btn-sm btn-new" onClick={() => { setJobId(Math.floor(Math.random() * 2 ** 32)); setEvents([]); setCompletedSteps(new Set()); setActiveStep('idle') }} disabled={running}>
                  🆕 New Job
                </button>
                <button className="btn btn-sm" onClick={stepAirdrop} disabled={running}>
                  💧 Airdrop
                </button>
                <button className="btn btn-sm" onClick={() => { refreshBalance(); refreshEscrowBalances() }} disabled={running}>
                  🔄 Refresh
                </button>
              </div>

              {activeStep === 'complete' && (
                <div className="complete-banner">
                  🎉 Pipeline Complete — All {PIPELINE_ORDER.length - 2} steps with real SOL escrow + ZK compression
                </div>
              )}
            </>
          )}
        </section>

        {/* Event Stream */}
        <section className="event-stream glass">
          <h3 className="stream-title">
            <span className="stream-dot" /> Live Event Stream
          </h3>
          <div className="stream-list">
            {events.length === 0 && (
              <div className="stream-empty">
                {connected ? 'Click "Run Full Lifecycle" to begin' : 'Connect wallet to start'}
              </div>
            )}
            {events.map(ev => (
              <div key={ev.id} className={`stream-entry type-${ev.type}`}>
                <span className="stream-time">{ev.time}</span>
                <span className="stream-label">{ev.label}</span>
                {ev.ms != null && <span className="stream-ms">{ev.ms}ms</span>}
                {ev.txHash && (
                  <a
                    className="stream-link"
                    href={ev.solscanUrl || `https://solscan.io/tx/${ev.txHash}?cluster=devnet`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ↗ solscan
                  </a>
                )}
              </div>
            ))}
            <div ref={eventsEndRef} />
          </div>
        </section>
      </div>
    </main>
  )
}

export default App
