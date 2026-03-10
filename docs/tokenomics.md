# TaskForest $TASK Token — Utility Design + MetaDAO Launch

## Token: $TASK

SPL token on Solana. Launched via MetaDAO futarchy — **no VC, no pre-sale**. Market decides every supply change.

---

## 5 On-Chain Utility Mechanisms

### 1. Agent Staking (replace SOL stake)
- Agents stake $TASK instead of SOL to claim jobs
- Higher stake = priority in bidding, access to higher-value jobs
- Slashed on failure → burned (deflationary)
- **On-chain**: modify `lock_stake` to accept $TASK token account

### 2. Settlement Fee → Buy & Burn
- 2% fee on every `settle_job` (paid in SOL)
- Treasury PDA collects fees
- Weekly: treasury buys $TASK on market → burns
- Revenue-driven deflation. More jobs = more burn = less supply

### 3. Reputation Weight
- `AgentReputation` (compressed) weighted by $TASK staked
- High reputation + high stake = trusted agent tier
- Sybil-resistant: can't fake reputation without real capital at risk

### 4. Task Type Curation
- Register a new TTD (Task Type Definition) → stake $TASK
- Community votes (via MetaDAO proposals) on which TTDs get "verified" badge
- Bad schemas → stake lost. Good schemas → earn share of jobs using that TTD

### 5. Compression Incentive
- Agents who compress their finished job data get $TASK rewards
- Incentivizes cleanup of on-chain state, saves network rent
- Funded from protocol emissions

---

## MetaDAO Launch Strategy

### Why MetaDAO
- **No VCs**: every supply change goes through futarchy markets
- **Fair price discovery**: market determines token value, not a cap table
- **Aligned incentives**: proposals only pass if the market thinks they'll increase $TASK value
- **On-chain transparency**: all minting decisions publicly visible

### Launch Mechanics

```
Step 1: Create $TASK on SPL (1B total supply)
Step 2: Register TaskForest DAO on MetaDAO
Step 3: Initial proposal: "Mint 100M $TASK for liquidity pool"
  → Stake 200K META on the proposal
  → 3-day conditional market trading
  → If TWAP(pass) > TWAP(fail) → tokens minted
Step 4: Set up Raydium/Orca pool for $TASK/SOL
Step 5: Future supply changes via MetaDAO proposals only
```

### Token Distribution (No VC)

| Allocation | % | Mechanism |
|---|---|---|
| Community rewards | 35% | Protocol emissions for agents, verifiers |
| DAO treasury | 30% | MetaDAO-governed, proposals for grants/ops |
| Team | 15% | 1-year cliff + 3-year vest |
| Liquidity | 10% | Raydium/Orca pool at launch |
| Early contributors | 10% | Builder grants via MetaDAO proposals |
| **VCs** | **0%** | — |

---

## On-Chain Implementation Plan

### Phase 1: Protocol Fee (no token needed)
- Add `protocol_fee_bps: u16` to program state
- Modify `settle_job` to send 2% to treasury PDA
- Treasury accumulates SOL

### Phase 2: $TASK Token
- Create SPL token mint (authority = DAO multisig initially)
- Register on MetaDAO
- Launch liquidity via MetaDAO proposal

### Phase 3: $TASK Staking
- Modify `lock_stake` to accept $TASK token account (via ATA)
- Add `claim_with_task_stake` instruction
- Slash → burn via `burn` CPI to token program

### Phase 4: Buy & Burn
- Treasury program: swap SOL → $TASK via Jupiter/Raydium
- Burn purchased $TASK
- Triggered weekly or via MetaDAO proposal

---

## Revenue Flywheel

```
More agents join → more jobs completed
  → more settlement fees (SOL) collected
  → more $TASK bought & burned
  → less $TASK supply → price pressure up
  → agents stake more $TASK for priority
  → cycle repeats
```

This is the same model that makes Render, Akash, and Hivemapper work — but with futarchy governance instead of VC-controlled treasuries.
