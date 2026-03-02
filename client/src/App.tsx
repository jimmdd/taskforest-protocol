import { useEffect, useMemo, useState } from 'react'
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { Buffer } from 'buffer'
import './App.css'

const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
const DEFAULT_PROGRAM_ID = '11111111111111111111111111111111'
const BURNER_KEY = 'taskforest_burner_secret_key'

type CreateJobForm = {
  jobId: string
  poster: string
  rewardUsdc: string
  deadlineEpochSecs: string
  proofSpecHash: string
}

function getOrCreateBurner(): Keypair {
  const raw = localStorage.getItem(BURNER_KEY)
  if (raw) {
    const bytes = Uint8Array.from(JSON.parse(raw) as number[])
    return Keypair.fromSecretKey(bytes)
  }
  const kp = Keypair.generate()
  localStorage.setItem(BURNER_KEY, JSON.stringify(Array.from(kp.secretKey)))
  return kp
}

function createJobPayload(form: CreateJobForm): string {
  return [
    'create_job',
    form.jobId,
    form.poster,
    form.rewardUsdc,
    form.deadlineEpochSecs,
    form.proofSpecHash,
  ].join('|')
}

function App() {
  const connection = useMemo(() => new Connection(clusterApiUrl('devnet'), 'confirmed'), [])
  const [burner] = useState<Keypair>(() => getOrCreateBurner())
  const [programId, setProgramId] = useState(DEFAULT_PROGRAM_ID)
  const [signature, setSignature] = useState('')
  const [status, setStatus] = useState('Idle')
  const [balanceSol, setBalanceSol] = useState('0')
  const [createJob, setCreateJob] = useState<CreateJobForm>({
    jobId: '1',
    poster: 'poster-devnet',
    rewardUsdc: '1000',
    deadlineEpochSecs: String(Math.floor(Date.now() / 1000) + 3600),
    proofSpecHash: 'proof-spec-devnet-v1',
  })

  async function refreshBalance() {
    const lamports = await connection.getBalance(burner.publicKey)
    setBalanceSol((lamports / 1_000_000_000).toFixed(4))
  }

  useEffect(() => {
    refreshBalance().catch(() => {
      setStatus('Could not fetch balance')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function airdropOneSol() {
    try {
      setStatus('Requesting airdrop...')
      const sig = await connection.requestAirdrop(burner.publicKey, 1_000_000_000)
      const latest = await connection.getLatestBlockhash('confirmed')
      await connection.confirmTransaction(
        {
          signature: sig,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        'confirmed',
      )
      setStatus('Airdrop confirmed')
      setSignature(sig)
      await refreshBalance()
    } catch (error) {
      setStatus(`Airdrop failed: ${(error as Error).message}`)
    }
  }

  async function sendMemo() {
    try {
      setStatus('Sending memo transaction...')
      const ix = new TransactionInstruction({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from('TaskForest devnet ping', 'utf8'),
      })
      const tx = new Transaction().add(ix)
      tx.feePayer = burner.publicKey
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = latest.blockhash
      const sig = await sendAndConfirmTransaction(connection, tx, [burner], {
        commitment: 'confirmed',
      })
      setSignature(sig)
      setStatus('Memo transaction confirmed')
      await refreshBalance()
    } catch (error) {
      setStatus(`Memo failed: ${(error as Error).message}`)
    }
  }

  async function sendCreateJobInstruction() {
    try {
      setStatus('Submitting create_job instruction...')
      const targetProgram = new PublicKey(programId)
      const payload = createJobPayload(createJob)
      const ix = new TransactionInstruction({
        keys: [],
        programId: targetProgram,
        data: Buffer.from(payload, 'utf8'),
      })
      const tx = new Transaction().add(ix)
      tx.feePayer = burner.publicKey
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = latest.blockhash
      const sig = await sendAndConfirmTransaction(connection, tx, [burner], {
        commitment: 'confirmed',
      })
      setSignature(sig)
      setStatus('create_job instruction confirmed')
      await refreshBalance()
    } catch (error) {
      setStatus(`create_job failed: ${(error as Error).message}`)
    }
  }

  async function transferSelfTest() {
    try {
      setStatus('Sending tiny self-transfer...')
      const ix = SystemProgram.transfer({
        fromPubkey: burner.publicKey,
        toPubkey: burner.publicKey,
        lamports: 5000,
      })
      const tx = new Transaction().add(ix)
      tx.feePayer = burner.publicKey
      const latest = await connection.getLatestBlockhash('confirmed')
      tx.recentBlockhash = latest.blockhash
      const sig = await sendAndConfirmTransaction(connection, tx, [burner], {
        commitment: 'confirmed',
      })
      setSignature(sig)
      setStatus('Self-transfer confirmed')
      await refreshBalance()
    } catch (error) {
      setStatus(`Self-transfer failed: ${(error as Error).message}`)
    }
  }

  return (
    <main className="app">
      <header>
        <p className="tag">TaskForest Devnet Client</p>
        <h1>Simple protocol transaction UI</h1>
      </header>

      <section className="panel">
        <h2>Burner wallet</h2>
        <p><strong>Address:</strong> <code>{burner.publicKey.toBase58()}</code></p>
        <p><strong>Balance:</strong> {balanceSol} SOL</p>
        <div className="actions">
          <button onClick={airdropOneSol}>Airdrop 1 SOL</button>
          <button onClick={refreshBalance}>Refresh balance</button>
          <button onClick={transferSelfTest}>Self-transfer test</button>
          <button onClick={sendMemo}>Memo test tx</button>
        </div>
      </section>

      <section className="panel">
        <h2>TaskForest instruction (create_job)</h2>
        <label>
          Program ID
          <input
            value={programId}
            onChange={(e) => setProgramId(e.target.value.trim())}
            placeholder="TaskForest program id"
          />
        </label>

        <div className="grid">
          <label>
            Job ID
            <input value={createJob.jobId} onChange={(e) => setCreateJob((v) => ({ ...v, jobId: e.target.value }))} />
          </label>
          <label>
            Poster
            <input value={createJob.poster} onChange={(e) => setCreateJob((v) => ({ ...v, poster: e.target.value }))} />
          </label>
          <label>
            Reward USDC
            <input value={createJob.rewardUsdc} onChange={(e) => setCreateJob((v) => ({ ...v, rewardUsdc: e.target.value }))} />
          </label>
          <label>
            Deadline Epoch
            <input value={createJob.deadlineEpochSecs} onChange={(e) => setCreateJob((v) => ({ ...v, deadlineEpochSecs: e.target.value }))} />
          </label>
          <label className="wide">
            Proof Spec Hash
            <input value={createJob.proofSpecHash} onChange={(e) => setCreateJob((v) => ({ ...v, proofSpecHash: e.target.value }))} />
          </label>
        </div>

        <p><strong>Encoded payload:</strong> <code>{createJobPayload(createJob)}</code></p>
        <button onClick={sendCreateJobInstruction}>Send create_job tx</button>
        <p className="hint">Use this after deploying TaskForest program to devnet. For now, memo/self-transfer validate wallet and RPC flow.</p>
      </section>

      <section className="panel status">
        <p><strong>Status:</strong> {status}</p>
        {signature && (
          <p>
            <strong>Signature:</strong>{' '}
            <a href={`https://explorer.solana.com/tx/${signature}?cluster=devnet`} target="_blank" rel="noreferrer">
              {signature}
            </a>
          </p>
        )}
      </section>
    </main>
  )
}

export default App
