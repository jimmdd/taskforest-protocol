import { createHash, X509Certificate } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'

export interface TdxQuoteVerificationPolicy {
  allowedMrTd?: string[]
  allowedRtmr0?: string[]
  allowedRtmr1?: string[]
  allowedRtmr2?: string[]
  allowedRtmr3?: string[]
  requireCertificateChain?: boolean
  trustedRootFingerprints?: string[]
  notAfterGraceSeconds?: number
}

export interface TdxQuoteClaims {
  teePubkey: Uint8Array
  mrTd?: string
  rtmr0?: string
  rtmr1?: string
  rtmr2?: string
  rtmr3?: string
  issuedAt: number
  expiresAt: number
  certificateChainPem?: string[]
}

export interface VerifiedTdxQuote {
  claims: TdxQuoteClaims
  verifier: PublicKey
  verifiedAt: number
}

export interface TdxQuoteVerifier {
  verifyQuote(quote: Uint8Array, policy: TdxQuoteVerificationPolicy): Promise<VerifiedTdxQuote>
}

export interface VerifiedAttestationEnvelope {
  escrowId: number
  jobPubkey: PublicKey
  validator: PublicKey
  teePubkey: number[]
  mppSessionId: number[]
  issuedAt: number
  expiresAt: number
}

function normalizeHex(value?: string): string | undefined {
  return value?.toLowerCase().replace(/^0x/, '')
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function ensureAllowed(label: string, value: string | undefined, allowed?: string[]) {
  if (!allowed || allowed.length === 0) return
  const normalized = normalizeHex(value)
  const expected = new Set(allowed.map((item) => normalizeHex(item)))
  if (!normalized || !expected.has(normalized)) {
    throw new Error(`TDX policy mismatch for ${label}`)
  }
}

export function verifyCertificateChainPem(
  chainPem: string[],
  trustedRootFingerprints?: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
  graceSeconds: number = 0,
): void {
  if (!chainPem.length) throw new Error('Missing certificate chain')

  const certs = chainPem.map((pem) => new X509Certificate(pem))
  for (let i = 0; i < certs.length; i += 1) {
    const cert = certs[i]
    const now = nowSec * 1000
    if (Date.parse(cert.validFrom) > now) throw new Error('Certificate not yet valid')
    if (Date.parse(cert.validTo) + graceSeconds * 1000 < now) throw new Error('Certificate expired')

    if (i < certs.length - 1) {
      const issuer = certs[i + 1]
      if (!cert.verify(issuer.publicKey)) throw new Error('Certificate chain signature invalid')
    }
  }

  if (trustedRootFingerprints?.length) {
    const root = certs[certs.length - 1]
    const fingerprint = sha256Hex(root.raw)
    const trusted = new Set(trustedRootFingerprints.map((item) => normalizeHex(item)))
    if (!trusted.has(normalizeHex(fingerprint))) {
      throw new Error('Certificate root is not trusted')
    }
  }
}

export function assertTdxQuotePolicy(
  claims: TdxQuoteClaims,
  policy: TdxQuoteVerificationPolicy,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  if (claims.issuedAt > nowSec) throw new Error('TDX quote is not yet valid')
  if (claims.expiresAt < nowSec) throw new Error('TDX quote has expired')

  ensureAllowed('mrTd', claims.mrTd, policy.allowedMrTd)
  ensureAllowed('rtmr0', claims.rtmr0, policy.allowedRtmr0)
  ensureAllowed('rtmr1', claims.rtmr1, policy.allowedRtmr1)
  ensureAllowed('rtmr2', claims.rtmr2, policy.allowedRtmr2)
  ensureAllowed('rtmr3', claims.rtmr3, policy.allowedRtmr3)

  if (policy.requireCertificateChain) {
    verifyCertificateChainPem(
      claims.certificateChainPem ?? [],
      policy.trustedRootFingerprints,
      nowSec,
      policy.notAfterGraceSeconds ?? 0,
    )
  }
}

export class JsonTdxQuoteVerifier implements TdxQuoteVerifier {
  constructor(private readonly verifier: PublicKey) {}

  async verifyQuote(quote: Uint8Array, policy: TdxQuoteVerificationPolicy): Promise<VerifiedTdxQuote> {
    const claims = JSON.parse(Buffer.from(quote).toString('utf8')) as TdxQuoteClaims
    assertTdxQuotePolicy(claims, policy)
    return {
      claims,
      verifier: this.verifier,
      verifiedAt: Math.floor(Date.now() / 1000),
    }
  }
}

export function buildVerifiedAttestationEnvelope(
  escrowId: number,
  jobPubkey: PublicKey,
  mppSessionId: number[],
  verified: VerifiedTdxQuote,
): VerifiedAttestationEnvelope {
  return {
    escrowId,
    jobPubkey,
    validator: verified.verifier,
    teePubkey: Array.from(verified.claims.teePubkey),
    mppSessionId,
    issuedAt: verified.claims.issuedAt,
    expiresAt: verified.claims.expiresAt,
  }
}
