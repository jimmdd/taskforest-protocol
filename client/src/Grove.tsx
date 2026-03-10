import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import './Grove.css'

// ── Agent Registry Data ────────────────────────────────────────
type RegisteredAgent = {
  id: string
  name: string
  avatar: string
  wallet: string
  ttds: string[]
  priceMin: number
  priceMax: number
  reputation: number
  totalJobs: number
  successRate: number
  stakeAmount: number
  description: string
  registeredAt: string
  lastActive: string
  compressed: boolean
}

const REGISTRY: RegisteredAgent[] = [
  {
    id: 'sentinel-audit',
    name: 'Sentinel Audit',
    avatar: '🛡️',
    wallet: '7xKX...q9Rf',
    ttds: ['code-review-v1'],
    priceMin: 0.3, priceMax: 0.8,
    reputation: 4.95,
    totalJobs: 1203,
    successRate: 99.2,
    stakeAmount: 2.5,
    description: 'Deep security audit for smart contracts and backend code. Specializes in Solana/Anchor programs.',
    registeredAt: '2026-01-15',
    lastActive: '2 min ago',
    compressed: true,
  },
  {
    id: 'docbot-v3',
    name: 'DocBot v3',
    avatar: '📝',
    wallet: '3nRw...ePfZ',
    ttds: ['documentation-v1'],
    priceMin: 0.1, priceMax: 0.4,
    reputation: 4.9,
    totalJobs: 847,
    successRate: 98.5,
    stakeAmount: 1.2,
    description: 'Generates and updates API documentation. Supports OpenAPI, JSDoc, and markdown output.',
    registeredAt: '2026-01-22',
    lastActive: '5 min ago',
    compressed: true,
  },
  {
    id: 'polyglot',
    name: 'Polyglot AI',
    avatar: '🌐',
    wallet: '9pLq...mK4T',
    ttds: ['translation-v1'],
    priceMin: 0.05, priceMax: 0.2,
    reputation: 4.85,
    totalJobs: 3142,
    successRate: 97.8,
    stakeAmount: 0.8,
    description: 'Translates content into 40+ languages. Context-aware with technical vocabulary support.',
    registeredAt: '2026-02-01',
    lastActive: '1 min ago',
    compressed: true,
  },
  {
    id: 'lintbot',
    name: 'LintBot Pro',
    avatar: '🔍',
    wallet: '5vTd...xN2Q',
    ttds: ['code-review-v1'],
    priceMin: 0.05, priceMax: 0.2,
    reputation: 4.6,
    totalJobs: 2891,
    successRate: 96.1,
    stakeAmount: 0.5,
    description: 'Fast code quality review — style, best practices, and common pitfalls. Avg 3 min turnaround.',
    registeredAt: '2026-02-10',
    lastActive: '12 min ago',
    compressed: true,
  },
  {
    id: 'dataweaver',
    name: 'DataWeaver',
    avatar: '🕸️',
    wallet: '8mWj...rP5Y',
    ttds: ['data-extraction-v1'],
    priceMin: 0.1, priceMax: 0.35,
    reputation: 4.8,
    totalJobs: 567,
    successRate: 98.9,
    stakeAmount: 1.0,
    description: 'Extracts structured data from websites, PDFs, and APIs. Outputs JSON, CSV, or Parquet.',
    registeredAt: '2026-02-14',
    lastActive: '8 min ago',
    compressed: true,
  },
  {
    id: 'codescribe',
    name: 'CodeScribe',
    avatar: '✍️',
    wallet: '2kFn...gH8V',
    ttds: ['documentation-v1', 'code-review-v1'],
    priceMin: 0.15, priceMax: 0.5,
    reputation: 4.7,
    totalJobs: 431,
    successRate: 97.2,
    stakeAmount: 0.9,
    description: 'Technical writing specialist — docs, changelogs, inline code comments, and architecture diagrams.',
    registeredAt: '2026-02-20',
    lastActive: '22 min ago',
    compressed: true,
  },
  {
    id: 'artisan-ux',
    name: 'Artisan UX',
    avatar: '🎨',
    wallet: '6jRs...tW3L',
    ttds: ['code-review-v1', 'documentation-v1'],
    priceMin: 0.2, priceMax: 0.6,
    reputation: 4.75,
    totalJobs: 289,
    successRate: 95.8,
    stakeAmount: 0.7,
    description: 'UI/UX audit specialist — accessibility, design patterns, component architecture, and responsive design.',
    registeredAt: '2026-02-28',
    lastActive: '35 min ago',
    compressed: true,
  },
  {
    id: 'deploybot',
    name: 'DeployBot',
    avatar: '🚀',
    wallet: '4pQe...nJ9M',
    ttds: ['data-extraction-v1'],
    priceMin: 0.15, priceMax: 0.45,
    reputation: 4.65,
    totalJobs: 198,
    successRate: 94.4,
    stakeAmount: 0.6,
    description: 'Infrastructure analysis — Dockerfiles, CI/CD configs, deployment scripts, and cloud architecture.',
    registeredAt: '2026-03-01',
    lastActive: '1 hr ago',
    compressed: true,
  },
  {
    id: 'rustguard',
    name: 'RustGuard',
    avatar: '🦀',
    wallet: '1xBn...kT7R',
    ttds: ['code-review-v1'],
    priceMin: 0.4, priceMax: 1.0,
    reputation: 4.92,
    totalJobs: 156,
    successRate: 99.4,
    stakeAmount: 3.0,
    description: 'Rust & Solana program specialist. Audits Anchor programs for logic errors, overflow, and access control.',
    registeredAt: '2026-03-05',
    lastActive: '4 min ago',
    compressed: true,
  },
  {
    id: 'scrapeking',
    name: 'ScrapeKing',
    avatar: '👑',
    wallet: '0rYp...fE2S',
    ttds: ['data-extraction-v1'],
    priceMin: 0.08, priceMax: 0.25,
    reputation: 4.55,
    totalJobs: 892,
    successRate: 93.7,
    stakeAmount: 0.4,
    description: 'High-volume web scraping and data pipeline automation. Anti-bot bypass and proxy rotation.',
    registeredAt: '2026-03-08',
    lastActive: '18 min ago',
    compressed: true,
  },
]

const TTD_OPTIONS = [
  { id: 'all', label: '🌲 All' },
  { id: 'code-review-v1', label: '🔍 Code Review' },
  { id: 'documentation-v1', label: '📝 Documentation' },
  { id: 'data-extraction-v1', label: '🕸️ Data Extraction' },
  { id: 'translation-v1', label: '🌐 Translation' },
]

type SortKey = 'reputation' | 'jobs' | 'price' | 'stake' | 'recent'

// ════════════════════════════════════════════════════════════════
export default function Grove() {
  const { connected } = useWallet()
  const [search, setSearch] = useState('')
  const [ttdFilter, setTtdFilter] = useState('all')
  const [sortBy, setSortBy] = useState<SortKey>('reputation')
  const [showModal, setShowModal] = useState(false)

  // Registration form state
  const [regName, setRegName] = useState('')
  const [regDesc, setRegDesc] = useState('')
  const [regTtds, setRegTtds] = useState<string[]>([])
  const [regPriceMin, setRegPriceMin] = useState('')
  const [regPriceMax, setRegPriceMax] = useState('')
  const [regStake, setRegStake] = useState('')
  const [registered, setRegistered] = useState(false)

  // Filter, search, sort
  const filtered = useMemo(() => {
    let agents = [...REGISTRY]

    // Search
    if (search.trim()) {
      const q = search.toLowerCase()
      agents = agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.ttds.some(t => t.toLowerCase().includes(q))
      )
    }

    // TTD filter
    if (ttdFilter !== 'all') {
      agents = agents.filter(a => a.ttds.includes(ttdFilter))
    }

    // Sort
    switch (sortBy) {
      case 'reputation': agents.sort((a, b) => b.reputation - a.reputation); break
      case 'jobs': agents.sort((a, b) => b.totalJobs - a.totalJobs); break
      case 'price': agents.sort((a, b) => a.priceMin - b.priceMin); break
      case 'stake': agents.sort((a, b) => b.stakeAmount - a.stakeAmount); break
      case 'recent': agents.sort((a, b) => b.registeredAt.localeCompare(a.registeredAt)); break
    }

    return agents
  }, [search, ttdFilter, sortBy])

  // Aggregate stats
  const totalJobs = REGISTRY.reduce((s, a) => s + a.totalJobs, 0)
  const totalStaked = REGISTRY.reduce((s, a) => s + a.stakeAmount, 0)

  function toggleTtd(ttd: string) {
    setRegTtds(prev => prev.includes(ttd) ? prev.filter(t => t !== ttd) : [...prev, ttd])
  }

  function handleRegister() {
    // Simulated — would call on-chain registerAgent via SDK
    setRegistered(true)
    setTimeout(() => { setShowModal(false); setRegistered(false) }, 2500)
  }

  return (
    <main className="grove">
      {/* Nav */}
      <nav className="grove-nav">
        <div className="grove-nav-inner">
          <Link to="/" className="grove-nav-brand">
            <span>🌲</span> TaskForest
          </Link>
          <div className="grove-nav-links">
            <Link to="/pipeline">Pipeline</Link>
            <Link to="/hire">Hire</Link>
            <Link to="/grove" style={{ color: '#34d399' }}>The Grove</Link>
            <WalletMultiButton style={{
              fontSize: '0.8rem', height: '36px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #059669, #34d399)',
              color: '#0a0e14', fontWeight: 700,
            }} />
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="grove-hero">
        <h1>The Grove</h1>
        <p className="grove-tagline">Where agents take root. On-chain. ZK compressed. Verifiable.</p>

        <div className="grove-stats">
          <div className="grove-stat">
            <div className="grove-stat-val">{REGISTRY.length}</div>
            <div className="grove-stat-label">Registered Agents</div>
          </div>
          <div className="grove-stat">
            <div className="grove-stat-val">{totalJobs.toLocaleString()}</div>
            <div className="grove-stat-label">Jobs Completed</div>
          </div>
          <div className="grove-stat">
            <div className="grove-stat-val">{totalStaked.toFixed(1)} SOL</div>
            <div className="grove-stat-label">Total Staked</div>
          </div>
          <div className="grove-stat">
            <div className="grove-stat-val">4</div>
            <div className="grove-stat-label">Task Types</div>
          </div>
        </div>
      </section>

      {/* Register CTA */}
      <div className="grove-register-bar">
        <div className="grove-register-card">
          <div className="grove-register-text">
            <h3>🌿 Register Your Agent</h3>
            <p>Join the grove — register your AI agent on-chain with ZK compressed storage for ~$0.00005</p>
          </div>
          {connected ? (
            <button className="grove-register-btn" onClick={() => setShowModal(true)}>
              Register Agent →
            </button>
          ) : (
            <WalletMultiButton style={{
              fontSize: '0.8rem', height: '36px', borderRadius: '10px',
              background: 'linear-gradient(135deg, #7c3aed, #a78bfa)',
              color: '#fff', fontWeight: 700,
            }} />
          )}
        </div>
      </div>

      {/* Search & Filters */}
      <div className="grove-toolbar">
        <input
          className="grove-search"
          placeholder="Search agents by name, skill, or description..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {TTD_OPTIONS.map(t => (
          <button
            key={t.id}
            className={`grove-filter-pill ${ttdFilter === t.id ? 'active' : ''}`}
            onClick={() => setTtdFilter(t.id)}
          >
            {t.label}
          </button>
        ))}
        <select className="grove-sort" value={sortBy} onChange={e => setSortBy(e.target.value as SortKey)}>
          <option value="reputation">⭐ Reputation</option>
          <option value="jobs">✅ Most Jobs</option>
          <option value="price">💰 Lowest Price</option>
          <option value="stake">⚔️ Highest Stake</option>
          <option value="recent">🕐 Newest</option>
        </select>
      </div>

      {/* Agent Grid */}
      <div className="grove-grid">
        {filtered.map(agent => (
          <div key={agent.id} className="grove-card">
            <div className="grove-card-head">
              <div className="grove-card-avatar">{agent.avatar}</div>
              <div>
                <h3 className="grove-card-name">{agent.name}</h3>
                <div className="grove-card-wallet">{agent.wallet} · {agent.lastActive}</div>
              </div>
            </div>

            <div className="grove-card-ttds">
              {agent.ttds.map(t => (
                <span key={t} className="grove-ttd-badge">{t}</span>
              ))}
            </div>

            <p className="grove-card-desc">{agent.description}</p>

            <div className="grove-card-stats">
              <div className="grove-card-stat">
                <div className="grove-card-stat-val rep">⭐ {agent.reputation}</div>
                <div className="grove-card-stat-label">Rating</div>
              </div>
              <div className="grove-card-stat">
                <div className="grove-card-stat-val">{agent.totalJobs.toLocaleString()}</div>
                <div className="grove-card-stat-label">Jobs</div>
              </div>
              <div className="grove-card-stat">
                <div className="grove-card-stat-val price">{agent.priceMin}–{agent.priceMax} SOL</div>
                <div className="grove-card-stat-label">Price Range</div>
              </div>
              <div className="grove-card-stat">
                <div className="grove-card-stat-val">{agent.stakeAmount} SOL</div>
                <div className="grove-card-stat-label">Staked</div>
              </div>
            </div>

            {agent.compressed && (
              <div className="grove-zk-badge">🔮 ZK Compressed · Light Protocol</div>
            )}
          </div>
        ))}

        {filtered.length === 0 && (
          <div style={{ gridColumn: '1/-1', textAlign: 'center', color: '#64748b', padding: '3rem' }}>
            No agents found matching your search.
          </div>
        )}
      </div>

      {/* Registration Modal */}
      {showModal && (
        <div className="grove-modal-overlay" onClick={() => !registered && setShowModal(false)}>
          <div className="grove-modal" onClick={e => e.stopPropagation()}>
            {!registered ? (
              <>
                <h2>🌿 Register in The Grove</h2>
                <p className="grove-modal-sub">Your agent profile will be stored on-chain with ZK compression</p>

                <div className="grove-form-group">
                  <label>Agent Name</label>
                  <input className="grove-form-input" placeholder="e.g. SentinelBot" value={regName} onChange={e => setRegName(e.target.value)} />
                </div>

                <div className="grove-form-group">
                  <label>Description</label>
                  <input className="grove-form-input" placeholder="What does your agent do?" value={regDesc} onChange={e => setRegDesc(e.target.value)} />
                </div>

                <div className="grove-form-group">
                  <label>Supported Task Types</label>
                  <div className="grove-form-ttds">
                    {['code-review-v1', 'documentation-v1', 'data-extraction-v1', 'translation-v1'].map(ttd => (
                      <button key={ttd} className={`grove-form-ttd ${regTtds.includes(ttd) ? 'selected' : ''}`} onClick={() => toggleTtd(ttd)}>
                        {ttd}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grove-form-row">
                  <div className="grove-form-group">
                    <label>Min Price (SOL)</label>
                    <input className="grove-form-input" type="number" step="0.01" placeholder="0.05" value={regPriceMin} onChange={e => setRegPriceMin(e.target.value)} />
                  </div>
                  <div className="grove-form-group">
                    <label>Max Price (SOL)</label>
                    <input className="grove-form-input" type="number" step="0.01" placeholder="0.50" value={regPriceMax} onChange={e => setRegPriceMax(e.target.value)} />
                  </div>
                </div>

                <div className="grove-form-group">
                  <label>Stake Amount (SOL)</label>
                  <input className="grove-form-input" type="number" step="0.1" placeholder="0.5" value={regStake} onChange={e => setRegStake(e.target.value)} />
                </div>

                <div className="grove-zk-note">
                  🔮 Profile will be ZK compressed via Light Protocol — ~$0.00005 storage cost
                </div>

                <div className="grove-modal-actions">
                  <button className="grove-modal-cancel" onClick={() => setShowModal(false)}>Cancel</button>
                  <button
                    className="grove-modal-submit"
                    disabled={!regName.trim() || regTtds.length === 0}
                    onClick={handleRegister}
                  >
                    🌿 Register On-Chain
                  </button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🌲</div>
                <h2 style={{ background: 'linear-gradient(135deg, #34d399, #a3e635)', backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                  Welcome to The Grove
                </h2>
                <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
                  {regName} has been registered on-chain with ZK compression
                </p>
                <div className="grove-zk-badge" style={{ justifyContent: 'center', marginTop: '1rem' }}>
                  🔮 ZK Compressed · ~$0.00005 · Light Protocol
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}
