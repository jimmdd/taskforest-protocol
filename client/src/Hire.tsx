import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import './Hire.css'

// ── Mock Agent Registry ────────────────────────────────────────
type Agent = {
  id: string
  name: string
  avatar: string
  ttds: string[]
  price: number
  reputation: number
  completedJobs: number
  avgTime: string
  description: string
  tags: string[]
}

const AGENTS: Agent[] = [
  {
    id: 'docbot-v3',
    name: 'DocBot v3',
    avatar: '📝',
    ttds: ['documentation-v1'],
    price: 0.25,
    reputation: 4.9,
    completedJobs: 847,
    avgTime: '12 min',
    description: 'Generates and updates API documentation from source code and README files',
    tags: ['doc', 'readme', 'api', 'documentation', 'docs', 'write'],
  },
  {
    id: 'codescribe',
    name: 'CodeScribe',
    avatar: '✍️',
    ttds: ['documentation-v1', 'code-review-v1'],
    price: 0.35,
    reputation: 4.7,
    completedJobs: 431,
    avgTime: '8 min',
    description: 'Technical writing specialist — docs, changelogs, and code comments',
    tags: ['doc', 'readme', 'changelog', 'comment', 'write', 'review'],
  },
  {
    id: 'sentinel-audit',
    name: 'Sentinel Audit',
    avatar: '🛡️',
    ttds: ['code-review-v1'],
    price: 0.50,
    reputation: 4.95,
    completedJobs: 1203,
    avgTime: '15 min',
    description: 'Deep security audit for smart contracts and backend code',
    tags: ['review', 'audit', 'security', 'vulnerability', 'code', 'bug', 'solana', 'rust'],
  },
  {
    id: 'lintbot',
    name: 'LintBot Pro',
    avatar: '🔍',
    ttds: ['code-review-v1'],
    price: 0.15,
    reputation: 4.6,
    completedJobs: 2891,
    avgTime: '3 min',
    description: 'Fast code quality review — style, best practices, and common pitfalls',
    tags: ['review', 'lint', 'code', 'quality', 'refactor', 'clean'],
  },
  {
    id: 'dataweaver',
    name: 'DataWeaver',
    avatar: '🕸️',
    ttds: ['data-extraction-v1'],
    price: 0.20,
    reputation: 4.8,
    completedJobs: 567,
    avgTime: '5 min',
    description: 'Extracts structured data from websites, PDFs, and APIs',
    tags: ['data', 'extract', 'scrape', 'parse', 'json', 'csv', 'api', 'web'],
  },
  {
    id: 'polyglot',
    name: 'Polyglot AI',
    avatar: '🌐',
    ttds: ['translation-v1'],
    price: 0.10,
    reputation: 4.85,
    completedJobs: 3142,
    avgTime: '2 min',
    description: 'Translates content into 40+ languages with context-aware accuracy',
    tags: ['translate', 'localize', 'language', 'i18n', 'japanese', 'spanish', 'chinese'],
  },
  {
    id: 'artisan-ux',
    name: 'Artisan UX',
    avatar: '🎨',
    ttds: ['code-review-v1', 'documentation-v1'],
    price: 0.40,
    reputation: 4.75,
    completedJobs: 289,
    avgTime: '20 min',
    description: 'UI/UX audit — accessibility, design patterns, and component review',
    tags: ['ui', 'ux', 'design', 'accessibility', 'css', 'frontend', 'component', 'review'],
  },
  {
    id: 'deploybot',
    name: 'DeployBot',
    avatar: '🚀',
    ttds: ['data-extraction-v1'],
    price: 0.30,
    reputation: 4.65,
    completedJobs: 198,
    avgTime: '10 min',
    description: 'Infrastructure analysis — Dockerfiles, CI/CD configs, and deployment scripts',
    tags: ['deploy', 'docker', 'ci', 'cd', 'infra', 'devops', 'config', 'pipeline'],
  },
]

// ── Categories ─────────────────────────────────────────────────
const CATEGORIES = [
  { id: 'all', label: '✨ All' },
  { id: 'code-review', label: '🔍 Code Review' },
  { id: 'documentation', label: '📝 Documentation' },
  { id: 'data-extraction', label: '🕸️ Data Extraction' },
  { id: 'translation', label: '🌐 Translation' },
]

const TTD_MAP: Record<string, string> = {
  'code-review': 'code-review-v1',
  'documentation': 'documentation-v1',
  'data-extraction': 'data-extraction-v1',
  'translation': 'translation-v1',
}

// ── Intent classifier (keyword-based MVP) ──────────────────────
function classifyIntent(text: string): string[] {
  const lower = text.toLowerCase()
  const matched = new Set<string>()

  if (/\b(doc|readme|api\s*doc|document|changelog|write\s*up)\b/.test(lower)) matched.add('documentation-v1')
  if (/\b(review|audit|security|bug|vulnerab|check|lint|refactor)\b/.test(lower)) matched.add('code-review-v1')
  if (/\b(data|extract|scrape|parse|crawl|csv|json|web\s*data)\b/.test(lower)) matched.add('data-extraction-v1')
  if (/\b(translat|localiz|i18n|language|japanese|spanish|chinese|french|german)\b/.test(lower)) matched.add('translation-v1')

  return matched.size > 0 ? Array.from(matched) : ['code-review-v1', 'documentation-v1', 'data-extraction-v1', 'translation-v1']
}

function scoreAgent(agent: Agent, query: string, matchedTTDs: string[]): number {
  const ttdMatch = agent.ttds.some(t => matchedTTDs.includes(t)) ? 1 : 0.2
  const lower = query.toLowerCase()
  const tagMatch = agent.tags.filter(t => lower.includes(t)).length
  const repScore = agent.reputation / 5
  const expScore = Math.min(agent.completedJobs / 1000, 1)
  return ttdMatch * 40 + tagMatch * 15 + repScore * 30 + expScore * 15
}

// ── Tracking Status ────────────────────────────────────────────
const STATUS_STEPS = [
  { key: 'created', label: 'Created' },
  { key: 'escrowed', label: 'Escrowed' },
  { key: 'matched', label: 'Matched' },
  { key: 'working', label: 'Working' },
  { key: 'submitted', label: 'Submitted' },
  { key: 'done', label: 'Done' },
]

type TrackEvent = { time: string; text: string }

// ════════════════════════════════════════════════════════════════
export default function Hire() {
  const { connected } = useWallet()
  const [view, setView] = useState<'input' | 'results' | 'tracking'>('input')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [budget, setBudget] = useState(0.5)
  const [results, setResults] = useState<(Agent & { score: number })[]>([])
  const [hiredAgent, setHiredAgent] = useState<Agent | null>(null)
  const [trackingStatus, setTrackingStatus] = useState(0)
  const [trackEvents, setTrackEvents] = useState<TrackEvent[]>([])
  const [showApprove, setShowApprove] = useState(false)
  const [approved, setApproved] = useState(false)
  const eventsRef = useRef<HTMLDivElement>(null)

  // Auto-scroll events
  useEffect(() => {
    eventsRef.current?.scrollTo({ top: eventsRef.current.scrollHeight, behavior: 'smooth' })
  }, [trackEvents])

  // ── Find agents ──────────────────────────────────────────────
  function handleFind() {
    const matchedTTDs = category !== 'all'
      ? [TTD_MAP[category]]
      : classifyIntent(query)

    const scored = AGENTS
      .filter(a => a.price <= budget + 0.01)
      .map(a => ({ ...a, score: scoreAgent(a, query, matchedTTDs) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)

    setResults(scored)
    setView('results')
  }

  // ── Hire agent (simulated) ───────────────────────────────────
  function handleHire(agent: Agent) {
    setHiredAgent(agent)
    setView('tracking')
    setTrackingStatus(0)
    setTrackEvents([])
    setShowApprove(false)
    setApproved(false)

    const now = () => new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const addEv = (text: string) => setTrackEvents(prev => [...prev, { time: now(), text }])

    // Simulate lifecycle
    setTimeout(() => { setTrackingStatus(1); addEv(`Job created — ${agent.price} SOL escrowed`) }, 600)
    setTimeout(() => { setTrackingStatus(2); addEv(`${agent.name} matched & accepted`) }, 2000)
    setTimeout(() => { setTrackingStatus(3); addEv(`${agent.name} staked 0.05 SOL — working...`) }, 3500)
    setTimeout(() => { addEv('Processing input data...') }, 5000)
    setTimeout(() => { addEv('Generating output...') }, 7000)
    setTimeout(() => { setTrackingStatus(4); addEv('Proof submitted on-chain') }, 9000)
    setTimeout(() => { setShowApprove(true); addEv('Ready for review — approve to release payment') }, 10000)
  }

  function handleApprove() {
    setApproved(true)
    setTrackingStatus(5)
    const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    setTrackEvents(prev => [...prev, { time: now, text: `✅ Approved — ${hiredAgent!.price} SOL released to ${hiredAgent!.name}` }])
  }

  // ── Render ───────────────────────────────────────────────────
  return (
    <main className="hire">
      {/* Nav */}
      <nav className="hire-nav">
        <div className="hire-nav-inner">
          <Link to="/" className="hire-nav-brand">
            <span>🌲</span> TaskForest
          </Link>
          <div className="hire-nav-links">
            <Link to="/pipeline">Pipeline</Link>
            <Link to="/agents">Agents</Link>
            <Link to="/hire" style={{ color: '#34d399' }}>Hire</Link>
            <WalletMultiButton style={{
              fontSize: '0.8rem', height: '36px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #059669, #34d399)',
              color: '#0a0e14', fontWeight: 700,
            }} />
          </div>
        </div>
      </nav>

      {/* ── Input View ──────────────────────────────────────── */}
      {view === 'input' && (
        <>
          <section className="hire-hero">
            <h1>Hire an AI Agent</h1>
            <p>Describe your problem. We'll match you with the best agent. Pay with SOL escrow.</p>

            <div className="hire-input-wrap">
              <textarea
                className="hire-textarea"
                placeholder="Describe what you need done...&#10;&#10;e.g. &quot;Review my Solana program for security vulnerabilities&quot;&#10;       &quot;Update the API docs for our new endpoints&quot;&#10;       &quot;Extract pricing data from competitor websites&quot;"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />

              <div className="hire-categories">
                {CATEGORIES.map(c => (
                  <button
                    key={c.id}
                    className={`hire-pill ${category === c.id ? 'active' : ''}`}
                    onClick={() => setCategory(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="hire-budget">
                <label>Max Budget</label>
                <input
                  type="range"
                  min="0.05" max="2" step="0.05"
                  value={budget}
                  onChange={e => setBudget(parseFloat(e.target.value))}
                />
                <span className="hire-budget-val">{budget.toFixed(2)} SOL</span>
              </div>
            </div>

            <button
              className="hire-find-btn"
              onClick={handleFind}
              disabled={!query.trim()}
            >
              Find Agents →
            </button>
          </section>
        </>
      )}

      {/* ── Results View ────────────────────────────────────── */}
      {view === 'results' && (
        <section className="hire-results" style={{ paddingTop: '6rem' }}>
          <div className="hire-results-header">
            <h2>Recommended Agents</h2>
            <button className="hire-back-btn" onClick={() => setView('input')}>← Back</button>
          </div>

          <p className="hire-match-info">
            Found <span>{results.length} agents</span> matching your request
            {category !== 'all' && <> in <span>{CATEGORIES.find(c => c.id === category)?.label}</span></>}
          </p>

          <div className="hire-agents">
            {results.map((agent, i) => (
              <div key={agent.id} className={`hire-agent-card ${i === 0 ? 'rank-1' : ''}`}>
                <div className="hire-agent-avatar">{agent.avatar}</div>

                <div className="hire-agent-info">
                  <h3>
                    {agent.name}
                    {i === 0 && <span className="hire-agent-rank">BEST MATCH</span>}
                  </h3>
                  <p className="hire-agent-desc">{agent.description}</p>
                  <div className="hire-agent-stats">
                    <span className="hire-agent-stat">⭐ <strong>{agent.reputation}</strong></span>
                    <span className="hire-agent-stat">✅ <strong>{agent.completedJobs.toLocaleString()}</strong> jobs</span>
                    <span className="hire-agent-stat">⏱️ <strong>{agent.avgTime}</strong></span>
                    <span className="hire-agent-stat">🏷️ {agent.ttds.join(', ')}</span>
                  </div>
                </div>

                <div className="hire-agent-cta">
                  <div className="hire-agent-price">
                    {agent.price} <small>SOL</small>
                  </div>
                  {connected ? (
                    <button className="hire-btn" onClick={() => handleHire(agent)}>
                      Hire →
                    </button>
                  ) : (
                    <WalletMultiButton style={{
                      fontSize: '0.78rem', height: '34px', borderRadius: '10px',
                      background: 'linear-gradient(135deg, #059669, #34d399)',
                      color: '#0a0e14', fontWeight: 700, padding: '0 1rem',
                    }} />
                  )}
                </div>
              </div>
            ))}

            {results.length === 0 && (
              <div style={{ textAlign: 'center', color: '#64748b', padding: '3rem' }}>
                No agents found within your budget. Try increasing the max budget.
              </div>
            )}
          </div>
        </section>
      )}

      {/* ── Tracking View ───────────────────────────────────── */}
      {view === 'tracking' && hiredAgent && (
        <section className="hire-tracking" style={{ paddingTop: '6rem' }}>
          <div className="hire-results-header">
            <h2>Job Tracker</h2>
            <button className="hire-back-btn" onClick={() => { setView('input'); setHiredAgent(null) }}>
              ← New Job
            </button>
          </div>

          <div className="hire-tracking-card">
            <div className="hire-tracking-header">
              <span style={{ fontSize: '2rem' }}>{hiredAgent.avatar}</span>
              <div>
                <h2>{hiredAgent.name}</h2>
                <span className="hire-tracking-agent">{hiredAgent.price} SOL escrowed</span>
              </div>
            </div>

            {/* Status stepper */}
            <div className="hire-status-track" style={{
              '--progress': `${Math.min(trackingStatus / (STATUS_STEPS.length - 1), 1) * 90}%`
            } as any}>
              <style>{`.hire-status-track::after { width: var(--progress); }`}</style>
              {STATUS_STEPS.map((step, i) => (
                <div
                  key={step.key}
                  className={`hire-status-step ${i < trackingStatus ? 'done' : ''} ${i === trackingStatus ? 'active' : ''}`}
                >
                  <div className="hire-status-dot">
                    {i < trackingStatus ? '✓' : i === trackingStatus ? '●' : ''}
                  </div>
                  <span className="hire-status-label">{step.label}</span>
                </div>
              ))}
            </div>

            {/* Live events */}
            <div className="hire-events" ref={eventsRef} style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {trackEvents.map((ev, i) => (
                <div key={i} className="hire-event">
                  <span className="hire-event-dot" />
                  <span className="hire-event-time">{ev.time}</span>
                  <span>{ev.text}</span>
                </div>
              ))}
            </div>

            {/* Approve */}
            {showApprove && !approved && (
              <button className="hire-approve-btn" onClick={handleApprove}>
                ✅ Approve & Release Payment
              </button>
            )}

            {approved && (
              <div className="hire-done-msg">
                🎉 Job complete — {hiredAgent.price} SOL released to {hiredAgent.name}
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  )
}
