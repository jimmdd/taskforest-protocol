import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  PublicKey, SystemProgram, Transaction, Keypair,
  LAMPORTS_PER_SOL, Connection,
} from '@solana/web3.js'
import * as anchor from '@coral-xyz/anchor'
import idl from '../../target/idl/taskforest.json'
import { uploadMetadata, fetchMetadata, hashMetadata, hashMetadataHex } from './pinata'
import type { TaskMetadata } from './pinata'
import './Board.css'

const PROGRAM_ID = new PublicKey('Fgiye795epSDkytp6a334Y2AwjqdGDecWV24yc2neZ4s')
const MAGIC_ROUTER = 'https://router-devnet.magicblock.app'

const STATUS_LABELS: Record<number, { label: string; color: string; icon: string }> = {
  0: { label: 'Open',             color: '#34d399', icon: '🟢' },
  1: { label: 'Open for Bidding', color: '#fbbf24', icon: '⚡' },
  2: { label: 'Claimed',          color: '#f97316', icon: '🔒' },
  3: { label: 'Proof Submitted',  color: '#818cf8', icon: '📝' },
  4: { label: 'Completed',        color: '#8b5cf6', icon: '✅' },
  5: { label: 'Failed',           color: '#ef4444', icon: '❌' },
  6: { label: 'Work in Progress', color: '#06b6d4', icon: '💎' },
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
  const [actionLog, setActionLog] = useState<React.ReactNode[]>([])
  const [acting, setActing] = useState<string | null>(null)
  const [rewardSol, setRewardSol] = useState('0.1')
  const [jobDesc, setJobDesc] = useState('Summarize this research paper')
  const [jobTitle, setJobTitle] = useState('Research Task')
  const [jobCategory, setJobCategory] = useState('')
  const [jobRequirements, setJobRequirements] = useState('')
  const [deadlineHours, setDeadlineHours] = useState('2')
  const [metadataMap, setMetadataMap] = useState<Record<string, TaskMetadata>>({})
  const [statusFilter, setStatusFilter] = useState<string>('all')

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

  const log = useCallback((msg: React.ReactNode) => {
    setActionLog(prev => [...prev.slice(-20), <span key={Date.now()}>[{new Date().toLocaleTimeString()}] {msg}</span>])
  }, [])

  const txLink = (sig: string) => (
    <a href={`https://solscan.io/tx/${sig}?cluster=devnet`} target="_blank" rel="noreferrer" className="tx-link">
      {sig.slice(0, 12)}…
    </a>
  )

  // Fetch all jobs
  const fetchJobs = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch old (222), TTD-era (254), and privacy-era (351) Job account sizes
      const [v1Accounts, v2Accounts, v3Accounts] = await Promise.all([
        connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 222 }] }),
        connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 254 }] }),
        connection.getProgramAccounts(PROGRAM_ID, { filters: [{ dataSize: 351 }] }),
      ])
      const accounts = [...v1Accounts, ...v2Accounts, ...v3Accounts]

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

      // Fetch metadata from API for all jobs
      for (const job of parsed) {
        const hashKey = localStorage.getItem(`tf_hash_${job.pubkey.toBase58()}`)
        if (hashKey) {
          fetchMetadata(hashKey).then(meta => {
            if (meta) setMetadataMap(prev => ({ ...prev, [job.pubkey.toBase58()]: meta }))
          })
        }
      }
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
      const rewardLamports = Math.floor(parseFloat(rewardSol) * LAMPORTS_PER_SOL)
      if (isNaN(rewardLamports) || rewardLamports <= 0) {
        log('❌ Invalid reward amount')
        setActing(null)
        return
      }

      // Build metadata and upload
      const deadlineSec = Math.floor(Date.now() / 1000) + Math.max(1, parseFloat(deadlineHours)) * 3600
      const metadata: TaskMetadata = {
        title: jobTitle || 'Untitled Task',
        description: jobDesc || '',
        ...(jobCategory ? { category: jobCategory } : {}),
        ...(jobRequirements.trim() ? { requirements: jobRequirements.split(',').map(r => r.trim()).filter(Boolean) } : {}),
        createdAt: new Date().toISOString(),
        poster: publicKey.toBase58(),
        reward: parseFloat(rewardSol),
        deadline: deadlineSec,
      }

      log('Uploading task metadata...')
      let metaHash = ''
      try {
        metaHash = await uploadMetadata(metadata)
        if (metaHash) {
          log(`📄 Metadata stored: ${metaHash.slice(0, 16)}...`)
        }
      } catch (e) {
        log(`⚠️ Upload failed, continuing with local: ${(e as Error).message.slice(0, 60)}`)
        metaHash = await hashMetadataHex(metadata)
      }

      // Hash metadata for on-chain verification
      const proofSpecHash = await hashMetadata(metadata)

      // Step 1: Create job (escrow reward)
      const tx = await program.methods
        .initializeJob(
          new anchor.BN(jobId),
          new anchor.BN(rewardLamports),
          new anchor.BN(deadlineSec),
          proofSpecHash,
          Array.from({ length: 32 }, () => 0), // ttd_hash — zero = untyped
          0,                                     // privacy_level = public
          Array.from({ length: 32 }, () => 0)   // no encryption pubkey
        )
        .accounts({ job: jobPDA, poster: publicKey, systemProgram: SystemProgram.programId })
        .transaction()

      const sig = await sendTx(connection, tx)
      log(<>✅ Job #{jobId} created ({rewardSol} SOL escrowed) tx:{txLink(sig)}</>)

      // Save hash + metadata locally for display
      localStorage.setItem(`tf_hash_${jobPDA.toBase58()}`, metaHash)
      localStorage.setItem(`tf_meta_${metaHash}`, JSON.stringify(metadata))
      setMetadataMap(prev => ({ ...prev, [jobPDA.toBase58()]: metadata }))

      // Step 2: Auto-delegate to open for bidding
      log('Opening job for bidding...')
      const delegateTx = await program.methods
        .delegateJob()
        .accounts({ payer: publicKey, job: jobPDA })
        .transaction()
      const sig2 = await sendTx(connection, delegateTx)
      log(<>✅ Job is now open for bidding! tx:{txLink(sig2)}</>)

      await fetchJobs()
    } catch (e) {
      log(`❌ Create failed: ${(e as Error).message.slice(0, 100)}`)
    }
    setActing(null)
  }


  async function bidOnJob(job: JobOnChain) {
    if (!program || !publicKey) return
    setActing(job.pubkey.toBase58())
    log(`Bidding on job #${job.jobId} via MagicBlock...`)
    try {
      // Discover ER
      const resp = await fetch(MAGIC_ROUTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getDelegation', params: [job.pubkey.toBase58()] }),
      })
      const result: any = await resp.json()
      let erUrl = result.result?.fqdn || result.result?.endpoint
      if (!erUrl) throw new Error('Job not delegated yet')
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
      log(<>⚡ Bid placed! stake={(stakeAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL tx:{txLink(sig)}</>)

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
      log(<>🔒 Bidding closed, committing to L1... tx:{txLink(sig2)}</>)

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
      log(<>💎 Stake locked! tx:{txLink(sig)}</>)
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
      log(<>📝 Proof submitted! tx:{txLink(sig)}</>)
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
      log(<>{verdict === 1 ? '✅' : '❌'} Job {action}! SOL transferred. tx:{txLink(sig)}</>)
      await fetchJobs()
    } catch (e) {
      log(`❌ Settle failed: ${(e as Error).message.slice(0, 150)}`)
    }
    setActing(null)
  }

  // --- Filtered jobs ---
  const now = Date.now() / 1000
  const filteredJobs = useMemo(() => {
    return jobs.filter((j: JobOnChain) => {
      const isExpired = j.deadline < now && (j.status === 0 || j.status === 1)
      if (statusFilter === 'all') return true
      if (statusFilter === 'expired') return isExpired
      if (statusFilter === 'open') return j.status === 0 && !isExpired
      if (statusFilter === 'bidding') return j.status === 1 && !isExpired
      if (statusFilter === 'active') return j.status >= 2 && j.status <= 3
      if (statusFilter === 'done') return j.status >= 4
      return true
    })
  }, [jobs, statusFilter, now])

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
            <a href="/pipeline" className="board-nav-link">⚡ Full Pipeline Demo</a>
            <div className="board-network"><span className="dot" /> devnet</div>
            <WalletMultiButton />
          </div>
        </div>
      </header>

      <div className="board-actions-bar">
        <button className="board-btn board-btn-refresh" onClick={fetchJobs} disabled={loading}>
          {loading ? '⏳ Loading...' : '🔄 Refresh'}
        </button>
        <div className="board-filter">
          {['all', 'open', 'bidding', 'active', 'done', 'expired'].map(f => (
            <button
              key={f}
              className={`filter-btn ${statusFilter === f ? 'active' : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all' ? 'All' : f === 'open' ? '🟢 Open' : f === 'bidding' ? '⚡ Bidding' : f === 'active' ? '🔒 Active' : f === 'done' ? '✅ Done' : '⏰ Expired'}
            </button>
          ))}
        </div>
        <span className="board-job-count">
          {filteredJobs.length} / {jobs.length} jobs
        </span>
      </div>

      {/* Job Grid */}
      <section className="board-grid">
        {filteredJobs.length === 0 && !loading && (
          <div className="board-empty">
            {connected ? 'No jobs match this filter.' : 'Connect wallet to browse jobs'}
          </div>
        )}
        {filteredJobs.map(job => {
          const statusInfo = STATUS_LABELS[job.status] || { label: `Status ${job.status}`, color: '#888', icon: '❓' }
          const isMyJob = isPoster(job)
          const isActing = acting === job.pubkey.toBase58()
          const deadlineStr = new Date(job.deadline * 1000).toLocaleString()
          const isExpired = job.deadline < Date.now() / 1000

          return (
            <div key={job.pubkey.toBase58()} className={`job-card ${isMyJob ? 'job-mine' : ''} ${isActing ? 'job-acting' : ''} ${isExpired && job.status < 4 ? 'job-expired' : ''}`}>
              <div className="job-card-top">
                <span className="job-status" style={{ color: isExpired && job.status < 4 ? '#ef4444' : statusInfo.color }}>
                  {isExpired && (job.status === 0 || job.status === 1) ? '⏰ Expired' : `${statusInfo.icon} ${statusInfo.label}`}
                </span>
                <span className="job-id">#{job.jobId}</span>
              </div>

              <div className="job-reward">
                {(job.reward / LAMPORTS_PER_SOL).toFixed(2)} SOL
              </div>

              {(() => {
                const meta = metadataMap[job.pubkey.toBase58()]
                const desc = meta?.description || localStorage.getItem(`tf_desc_${job.pubkey.toBase58()}`)
                const title = meta?.title
                const hash = localStorage.getItem(`tf_hash_${job.pubkey.toBase58()}`)
                return (
                  <div className="job-meta-block">
                    {title && <div className="job-meta-title">{title}</div>}
                    {desc && <div className="job-desc">{desc}</div>}
                    {hash && (
                      <span className="job-ipfs-link">
                        🔗 {hash.slice(0, 16)}...
                      </span>
                    )}
                  </div>
                )
              })()}

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
                {/* Expired job — poster controls */}
                {isMyJob && isExpired && (job.status === 0 || job.status === 1) && (
                  <>
                    <button className="action-btn action-extend" onClick={async () => {
                      setActing(job.pubkey.toBase58())
                      try {
                        const newDeadline = new anchor.BN(Math.floor(Date.now() / 1000) + 7200) // +2 hours
                        const tx = await program!.methods
                          .extendDeadline(newDeadline)
                          .accounts({ job: job.pubkey, poster: publicKey })
                          .transaction()
                        const sig = await sendTransaction(tx, connection)
                        log(<>🔄 Deadline extended +2h — tx:{txLink(sig)}</>)
                        setTimeout(fetchJobs, 2000)
                      } catch (e) { log(`❌ Extend failed: ${(e as Error).message.slice(0, 80)}`) }
                      setActing(null)
                    }} disabled={isActing}>
                      🔄 Extend +2h
                    </button>
                    <button className="action-btn action-fail" onClick={async () => {
                      setActing(job.pubkey.toBase58())
                      try {
                        const tx = await program!.methods
                          .expireUnclaimed()
                          .accounts({ job: job.pubkey, poster: publicKey })
                          .transaction()
                        const sig = await sendTransaction(tx, connection)
                        log(<>💰 SOL reclaimed — tx:{txLink(sig)}</>)
                        setTimeout(fetchJobs, 2000)
                      } catch (e) { log(`❌ Reclaim failed: ${(e as Error).message.slice(0, 80)}`) }
                      setActing(null)
                    }} disabled={isActing}>
                      💰 Reclaim SOL
                    </button>
                  </>
                )}

                {/* Expired job — non-poster sees disabled */}
                {!isMyJob && isExpired && (job.status === 0 || job.status === 1) && (
                  <span className="job-settled fail">⏰ Deadline passed</span>
                )}

                {/* Poster actions (non-expired) */}
                {isMyJob && !isExpired && job.status === 0 && (
                  <span className="job-settled" style={{color: 'var(--text-dim)'}}>Opening for bidding...</span>
                )}
                {isMyJob && job.status === 3 && (
                  <>
                    <button className="action-btn action-pass" onClick={() => settleJob(job, 1)} disabled={isActing}>
                      ✅ Approve Work
                    </button>
                    <button className="action-btn action-fail" onClick={() => settleJob(job, 0)} disabled={isActing}>
                      ❌ Reject Work
                    </button>
                  </>
                )}

                {/* Worker actions (non-expired) */}
                {!isMyJob && !isExpired && (job.status === 0 || job.status === 1) && (
                  <button className="action-btn action-bid" onClick={() => bidOnJob(job)} disabled={isActing}>
                    🤚 Accept Job
                  </button>
                )}
                {job.status === 2 && (
                  <button className="action-btn action-stake" onClick={() => lockStake(job)} disabled={isActing}>
                    💎 Lock Deposit
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

      {/* Post New Job */}
      {connected && (
        <section className="board-post-card glass">
          <h3>➕ Post a New Task</h3>
          <p className="post-note">Title & description are stored off-chain. Reward & deadline go on-chain.</p>
          <div className="post-form">
            <label className="post-label">
              Task Title <span className="required">*</span>
              <input
                type="text"
                className="post-input"
                placeholder="e.g. Summarize research paper on AI alignment"
                value={jobTitle}
                onChange={e => setJobTitle(e.target.value)}
                disabled={!!acting}
              />
            </label>
            <label className="post-label">
              Description <span className="required">*</span>
              <textarea
                className="post-input post-textarea"
                placeholder="e.g. Read the attached paper and provide a 500-word summary covering key findings, methodology, and conclusions."
                value={jobDesc}
                onChange={e => setJobDesc(e.target.value)}
                disabled={!!acting}
                rows={3}
              />
            </label>
            <div className="post-row-2col">
              <label className="post-label">
                Category <span className="optional">(optional)</span>
                <select
                  className="post-input post-select"
                  value={jobCategory}
                  onChange={e => setJobCategory(e.target.value)}
                  disabled={!!acting}
                >
                  <option value="">Select category...</option>
                  <option value="research">📚 Research</option>
                  <option value="development">💻 Development</option>
                  <option value="design">🎨 Design</option>
                  <option value="writing">✍️ Writing</option>
                  <option value="data">📊 Data Analysis</option>
                  <option value="testing">🧪 Testing / QA</option>
                  <option value="other">🔧 Other</option>
                </select>
              </label>
              <label className="post-label">
                Deadline <span className="required">*</span>
                <select
                  className="post-input post-select"
                  value={deadlineHours}
                  onChange={e => setDeadlineHours(e.target.value)}
                  disabled={!!acting}
                >
                  <option value="1">1 hour</option>
                  <option value="2">2 hours</option>
                  <option value="6">6 hours</option>
                  <option value="12">12 hours</option>
                  <option value="24">24 hours</option>
                  <option value="72">3 days</option>
                  <option value="168">1 week</option>
                </select>
              </label>
            </div>
            <label className="post-label">
              Requirements <span className="optional">(optional)</span>
              <input
                type="text"
                className="post-input"
                placeholder="e.g. Python, GPT-4, academic writing (comma-separated)"
                value={jobRequirements}
                onChange={e => setJobRequirements(e.target.value)}
                disabled={!!acting}
              />
            </label>
            <div className="post-row">
              <label className="post-label reward-label">
                Reward <span className="required">*</span>
                <div className="reward-input-wrap">
                  <input
                    type="number"
                    className="reward-input"
                    value={rewardSol}
                    onChange={e => setRewardSol(e.target.value)}
                    min="0.01"
                    step="0.05"
                    disabled={!!acting}
                  />
                  <span className="reward-suffix">SOL</span>
                </div>
              </label>
              <button className="board-btn board-btn-post" onClick={postJob} disabled={!connected || !!acting}>
                {acting === 'new' ? '⏳ Posting...' : '🚀 Post Task'}
              </button>
            </div>
          </div>
        </section>
      )}

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
