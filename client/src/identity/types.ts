export type IdentityProvider = 'native' | '8004' | 'custom'

export type IdentityRecord = {
  provider: IdentityProvider
  id: string
  displayName?: string
  reputationScore?: number
  metadata?: Record<string, string>
}

export type IdentityAdapter = {
  provider: IdentityProvider
  validate(input: string): string | null
  resolveIdentity(input: string): Promise<IdentityRecord>
}
