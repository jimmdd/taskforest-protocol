import { useState, useEffect, useCallback, useMemo } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  PublicKey, SystemProgram, Transaction, Keypair,
  LAMPORTS_PER_SOL, Connection,
} from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import idl from '../../target/idl/taskforest.json'
import './Board.css'

const PROGRAM_ID = new PublicKey('Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s')
const MAGIC_ROUTER = 'https://router-devnet.magicblock.app'

const STATUS_LABELS: Record<number, { label: string; color: string; icon: string }> = {
  0: { label: 'Open',      color: '#34d399', icon: '🟢' },
  1: { label: 'Bidding',   color: '#fbbf24', icon: '⚡' },
  2: { label: 'Claimed',   color: '#f97316', icon: '🔒' },
  3: { label: 'Submitted', color: '#818cf8', icon: '📝' },
  4: { label: 'Done',      color: '#8b5cf6', icon: '✅' },
  5: { label: 'Failed',    color: '#ef4444', icon: '❌' },
  6: { label: 'Staked',    color: '#06b6d4', icon: '💎' },
}

// Persistent burner key per browser session
const BURNER_KEY = 'taskforest_burner_v2'
function getBurner(): Keypair {
  const stored = sessionStorage.getItem(BURNER_KEY)
  if (stored) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)))
  const kp = Keypair.generate()
  sessionStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)))
  return kp
}

type JobOnChain = {
  pubkey: PublicKey
  poster: PublicKey
  jobId: number
  reward: number
  deadline: number
  status: number
  claimer: PublicKey
  claimerStake: number
  bestBidStake: number
  bestBidder: PublicKey
  bidCount: number
  proofHash: number[]
  submittedAt: number
}

export default function Board() {
  const { connection } = useConnection()
  const { publicKey, connected, sendTransaction } = useWallet()
  const [jobs, setJobs] = useState<JobOnChain[]>([])
  const [loading, setLoading] = useState(false)
  const [actionLog, setActionLog] = useState<string[]>([])
  const [acting, setActing] = useState<string | null>(null) // which job pubkey is being acted on

  const erBurner = useMemo(() => getBurner(), [])

  const program = useMemo(() => {
    if (!publicKey) return null
    const provider = new anchor.AnchorProvider(
      connection,
      { publicKey, signTransaction: async (tx: any) => tx, signAllTransactions: async (txs: any) => txs } as any,
      { commitment: 'confirmed' }
    )
    return new anchor.Program(idl as any, provider)
  }, [publicKey, connection])

  const log = useCallback((msg: string) => {
    setActionLog(prev => [...prev.slice(-20), `${new Date().toLocaleTimeString()} ${msg}`])
  }, [])

  // Fetch all jobs
  const fetchJobs = useCallback(async () => {
    setLoading(true)
    try {
      const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
        filters: [{ dataSize: 214 }], // Job account size (8 discriminator + 206 data)
      })

      const parsed: JobOnChain[] = []
      for (const { pubkey, account } of accounts) {
        try {
          if (!program) continue
          const decoded = (program as any).coder.accounts.decode('job', account.data)
          parsed.push({
            pubkey,
            poster: decoded.poster,
            jobId: decoded.jobId?.toNumber?.() ?? Number(decoded.jobId),
            reward: decoded.rewardLamports?.toNumber?.() ?? Number(decoded.rewardLamports),
            deadline: decoded.deadline?.toNumber?.() ?? Number(decoded.deadline),
            status: decoded.status,
            claimer: decoded.claimer,
            claimerStake: decoded.claimerStake?.toNumber?.() ?? Number(decoded.claimerStake),
            bestBidStake: decoded.bestBidStake?.toNumber?.() ?? Number(decoded.bestBidStake),
            bestBidder: decoded.bestBidder,
            bidCount: decoded.bidCount,
            proofHash: decoded.proofHash,
            submittedAt: decoded.submittedAt?.toNumber?.() ?? Number(decoded.submittedAt),
          })
        } catch { /* skip malformed */ }
      }

      parsed.sort((a, b) => b.jobId - a.jobId)
      setJobs(parsed)
    } catch (e) {
      log(`Fetch failed: ${(e as Error).message.slice(0, 100)}`)
    }
    setLoading(false)
  }, [connection, program, log])

  useEffect(() => {
    if (program) fetchJobs()
  }, [program, fetchJobs])

  // --- Send helpers ---
  async function sendTx(conn: Connection, tx: Transaction): Promise<string> {
    if (!publicKey || !sendTransaction) throw new Error('Wallet not connected')
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = publicKey
    const sig = await sendTransaction(tx, conn)
    await conn.confirmTransaction(sig, 'confirmed')
    return sig
  }

  async function sendL1WithBurner(tx: Transaction): Promise<string> {
    if (!publicKey || !sendTransaction) throw new Error('Wallet not connected')
    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.feePayer = publicKey
    tx.partialSign(erBurner)
    const sig = await sendTransaction(tx, connection)
    await connection.confirmTransaction(sig, 'confirmed')
    return sig
  }

  // --- Actions ---
  async function postJob() {
    if (!program || !publicKey) return
    setActing('new')
    const jobId = Math.floor(Math.random() * 2 ** 32)
    const idBuf = Buffer.alloc(8)
    idBuf.writeBigUInt64LE(BigInt(jobId))
    const [jobPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from('job'), publicKey.toBuffer(), idBuf],
      PROGRAM_ID
    )
    log(`Creating job #${jobId}...`)
    try {
      const tx = await program.methods
        .initializeJob(
          new anchor.BN(jobId),
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(Math.floor(Date.now() / 1000) + 7200),
          Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
        )
        .accounts({ job: jobPDA, poster: publicKey, systemProgram: SystemProgram.programId })
        .transaction()

      const sig = await sendTx(connection, tx)
      log(`✅ Job #${jobId} created (0.1 SOL escrowed) tx:${sig.slice(0, 12)}...`)
      await fetchJobs()
    } catch (e) {
      log(`❌ Create failed: ${(e as Error).message.slice(0, 100)}`)
    }
    setActing(null)
  }

  async function delegateJob(job: JobOnChain) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    log(`Delegating job #${job.jobId} to ER...`)
    try {
      const tx = await program.methods
        .delegateJob()
        .accounts({ payer: publicKey, job: job.pubkey })
        .transaction()
      const sig = await sendTx(connection, tx)
      log(`✅ Delegated to ER. tx:${sig.slice(0, 12)}...`)
      await fetchJobs()
    } catch (e) {
      log(`❌ Delegate failed: ${(e as Error).message.slice(0, 100)}`)
    }
    setActing(null)
  }

  async function bidOnJob(job: JobOnChain) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    log(`Bidding on job #${job.jobId} via ER...`)
    try {
      // Discover ER
      const resp = await fetch(MAGIC_ROUTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegation', params: [job.pubkey.toBase58()] }),
      })
      const result: any = await resp.json()
      let erUrl = result.result?.fqdn || result.result?.endpoint
      if (!erUrl) throw new Error('Job not delegated to ER')
      if (!erUrl.startsWith('http')) erUrl = `https://${erUrl}`

      const erConn = new Connection(erUrl, 'confirmed')
      const stakeAmount = Math.max(Math.floor(job.reward * 0.15), job.reward / 10 + 1000)
      const tx = await program.methods
        .placeBid(new anchor.BN(stakeAmount))
        .accounts({ job: job.pubkey, bidder: erBurner.publicKey })
        .transaction()

      const { blockhash } = await erConn.getLatestBlockhash('confirmed')
      tx.recentBlockhash = blockhash
      tx.feePayer = erBurner.publicKey
      tx.sign(erBurner)
      const sig = await erConn.sendRawTransaction(tx.serialize())
      log(`⚡ Bid placed on ER! stake=${(stakeAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL tx:${sig.slice(0, 12)}...`)

      // Auto-close bidding
      log('Closing bidding...')
      const closeTx = await program.methods
        .closeBidding()
        .accounts({ payer: erBurner.publicKey, job: job.pubkey })
        .transaction()
      const { blockhash: bh2 } = await erConn.getLatestBlockhash('confirmed')
      closeTx.recentBlockhash = bh2
      closeTx.feePayer = erBurner.publicKey
      closeTx.sign(erBurner)
      const sig2 = await erConn.sendRawTransaction(closeTx.serialize())
      log(`🔒 Bidding closed, committing to L1... tx:${sig2.slice(0, 12)}...`)

      // Poll for L1 commit
      for (let i = 0; i < 24; i++) {
        await new Promise(r => setTimeout(r, 5000))
        try {
          const check = await (program.account as any).job.fetch(job.pubkey)
          if ((check.status as number) >= 2) {
            log(`✅ Committed to L1 (status=${check.status})`)
            break
          }
          log(`⏳ Polling L1... (${(i + 1) * 5}s)`)
        } catch { /* keep polling */ }
      }
      await fetchJobs()
    } catch (e) {
      log(`❌ Bid failed: ${(e as Error).message.slice(0, 150)}`)
    }
    setActing(null)
  }

  async function lockStake(job: JobOnChain) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    log(`Locking stake for job #${job.jobId}...`)
    try {
      // Fund burner
      const fundAmount = job.claimerStake + 5_000_000
      const fundTx = new Transaction().add(
        SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: erBurner.publicKey, lamports: fundAmount })
      )
      await sendTx(connection, fundTx)
      log('Burner funded ✔')

      const tx = await program.methods.lockStake()
        .accounts({ job: job.pubkey, claimer: erBurner.publicKey, systemProgram: SystemProgram.programId })
        .transaction()
      const sig = await sendL1WithBurner(tx)
      log(`💎 Stake locked! tx:${sig.slice(0, 12)}...`)
      await fetchJobs()
    } catch (e) {
      log(`❌ Lock stake failed: ${(e as Error).message.slice(0, 150)}`)
    }
    setActing(null)
  }

  async function submitProof(job: JobOnChain) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    log(`Submitting proof for job #${job.jobId}...`)
    try {
      const proofHash = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))
      const tx = await program.methods.submitProof(proofHash)
        .accounts({ job: job.pubkey, submitter: erBurner.publicKey })
        .transaction()
      const sig = await sendL1WithBurner(tx)
      log(`📝 Proof submitted! tx:${sig.slice(0, 12)}...`)
      await fetchJobs()
    } catch (e) {
      log(`❌ Proof failed: ${(e as Error).message.slice(0, 150)}`)
    }
    setActing(null)
  }

  async function settleJob(job: JobOnChain, verdict: number) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    const action = verdict === 1 ? 'PASS' : 'FAIL'
    log(`Settling job #${job.jobId} (${action})...`)
    try {
      const tx = await program.methods
        .settleJob(verdict, Array.from({ length: 32 }, () => 0))
        .accounts({
          job: job.pubkey,
          settler: publicKey,
          posterAccount: job.poster,
          claimerAccount: job.claimer,
        })
        .transaction()
      const sig = await sendTx(connection, tx)
      log(`${verdict === 1 ? '✅' : '❌'} Job ${action}! SOL transferred. tx:${sig.slice(0, 12)}...`)
      await fetchJobs()
    } catch (e) {
      log(`❌ Settle failed: ${(e as Error).message.slice(0, 150)}`)
    }
    setActing(null)
  }

  // --- Role helpers ---
  function isPoster(job: JobOnChain) {
    return publicKey && job.poster.equals(publicKey)
  }
  function isDefaultKey(key: PublicKey) {
    return key.equals(PublicKey.default)
  }

  // --- Render ---
  return (
    <main className="board-app">
      <header className="board-header">
        <div className="board-logo-row">
          <a href="/" className="board-logo">
            <span>🌲</span> TaskForest <span className="board-subtitle">Job Board</span>
          </a>
          <div className="board-header-right">
            <a href="/pipeline" className="board-nav-link">⚡ Pipeline Demo</a>
            <div className="board-network"><span className="dot" /> devnet</div>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <div className="board-actions-bar">
        <button className="board-btn board-btn-post" onClick={postJob} disabled={!connected || !!acting}>
          {acting === 'new' ? '⏳ Creating...' : '➕ Post New Job (0.1 SOL)'}
        </button>
        <button className="board-btn board-btn-refresh" onClick={fetchJobs} disabled={loading}>
          {loading ? '⏳ Loading...' : '🔄 Refresh Jobs'}
        </button>
        <span className="board-job-count">{jobs.length} jobs on-chain</span>
      </div>

      {/* Job Grid */}
      <section className="board-grid">
        {jobs.length === 0 && !loading && (
          <div className="board-empty">
            {connected ? 'No jobs found. Post the first one!' : 'Connect wallet to browse jobs'}
          </div>
        )}
        {jobs.map(job => {
          const statusInfo = STATUS_LABELS[job.status] || { label: `Status ${job.status}`, color: '#888', icon: '❓' }
          const isMyJob = isPoster(job)
          const isActing = acting === job.pubkey.toBase58()
          const deadlineStr = new Date(job.deadline * 1000).toLocaleString()
          const isExpired = job.deadline < Date.now() / 1000

          return (
            <div key={job.pubkey.toBase58()} className={`job-card ${isMyJob ? 'job-mine' : ''} ${isActing ? 'job-acting' : ''}`}>
              <div className="job-card-top">
                <span className="job-status" style={{ color: statusInfo.color }}>
                  {statusInfo.icon} {statusInfo.label}
                </span>
                <span className="job-id">#{job.jobId}</span>
              </div>

              <div className="job-reward">
                {(job.reward / LAMPORTS_PER_SOL).toFixed(2)} SOL
              </div>

              <div className="job-details">
                <div className="job-detail">
                  <span className="job-detail-label">Poster</span>
                  <code>{job.poster.toBase58().slice(0, 8)}...{isMyJob ? ' (you)' : ''}</code>
                </div>
                {!isDefaultKey(job.claimer) && (
                  <div className="job-detail">
                    <span className="job-detail-label">Worker</span>
                    <code>{job.claimer.toBase58().slice(0, 8)}...</code>
                  </div>
                )}
                {job.claimerStake > 0 && (
                  <div className="job-detail">
                    <span className="job-detail-label">Stake</span>
                    <span>{(job.claimerStake / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>
                  </div>
                )}
                <div className="job-detail">
                  <span className="job-detail-label">Deadline</span>
                  <span className={isExpired ? 'expired' : ''}>{deadlineStr}</span>
                </div>
                <div className="job-detail">
                  <span className="job-detail-label">Bids</span>
                  <span>{job.bidCount}</span>
                </div>
              </div>

              {/* Role-aware action buttons */}
              <div className="job-actions">
                {/* Poster actions */}
                {isMyJob && job.status === 0 && (
                  <button className="action-btn action-delegate" onClick={() => delegateJob(job)} disabled={isActing}>
                    🔗 Delegate to ER
                  </button>
                )}
                {isMyJob && job.status === 3 && (
                  <>
                    <button className="action-btn action-pass" onClick={() => settleJob(job, 1)} disabled={isActing}>
                      ✅ Settle (PASS)
                    </button>
                    <button className="action-btn action-fail" onClick={() => settleJob(job, 0)} disabled={isActing}>
                      ❌ Reject (FAIL)
                    </button>
                  </>
                )}

                {/* Worker actions */}
                {!isMyJob && (job.status === 0 || job.status === 1) && (
                  <button className="action-btn action-bid" onClick={() => bidOnJob(job)} disabled={isActing}>
                    ⚡ Bid & Claim
                  </button>
                )}
                {job.status === 2 && (
                  <button className="action-btn action-stake" onClick={() => lockStake(job)} disabled={isActing}>
                    💎 Lock Stake
                  </button>
                )}
                {(job.status === 6 || job.status === 2) && (
                  <button className="action-btn action-prove" onClick={() => submitProof(job)} disabled={isActing}>
                    📝 Submit Proof
                  </button>
                )}

                {/* Completed */}
                {job.status === 4 && (
                  <span className="job-settled">✅ Completed</span>
                )}
                {job.status === 5 && (
                  <span className="job-settled fail">❌ Failed</span>
                )}
              </div>
            </div>
          )
        })}
      </section>

      {/* Action Log */}
      {actionLog.length > 0 && (
        <section className="board-log glass">
          <h3>📋 Action Log</h3>
          <div className="board-log-list">
            {actionLog.map((msg, i) => (
              <div key={i} className="board-log-entry">{msg}</div>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}
