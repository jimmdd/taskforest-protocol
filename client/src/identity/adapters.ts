import type { IdentityAdapter, IdentityProvider, IdentityRecord } from './types'

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function validateBase58(input: string): string | null {
  const value = input.trim()
  if (!value) {
    return 'Identity value is required'
  }
  if (!BASE58_RE.test(value)) {
    return 'Expected a base58 public key / asset id'
  }
  return null
}

const nativeAdapter: IdentityAdapter = {
  provider: 'native',
  validate(input: string) {
    return validateBase58(input)
  },
  async resolveIdentity(input: string): Promise<IdentityRecord> {
    return {
      provider: 'native',
      id: input.trim(),
      displayName: 'Native TaskForest identity',
      metadata: {
        source: 'taskforest-local',
      },
    }
  },
}

const registry8004Adapter: IdentityAdapter = {
  provider: '8004',
  validate(input: string) {
    return validateBase58(input)
  },
  async resolveIdentity(input: string): Promise<IdentityRecord> {
    const id = input.trim()
    return {
      provider: '8004',
      id,
      displayName: '8004 linked identity',
      metadata: {
        standard: 'ERC-8004 (Solana)',
        note: 'Optional adapter mode; external registry lookup can be layered in next',
      },
    }
  },
}

const customAdapter: IdentityAdapter = {
  provider: 'custom',
  validate(input: string) {
    if (!input.trim()) {
      return 'Custom identity reference is required'
    }
    return null
  },
  async resolveIdentity(input: string): Promise<IdentityRecord> {
    return {
      provider: 'custom',
      id: input.trim(),
      displayName: 'Custom linked identity',
    }
  },
}

const adapters: Record<IdentityProvider, IdentityAdapter> = {
  native: nativeAdapter,
  '8004': registry8004Adapter,
  custom: customAdapter,
}

export function getIdentityAdapter(provider: IdentityProvider): IdentityAdapter {
  return adapters[provider]
}
