/**
 * TaskForest SDK — Privacy Helpers
 * Convenience functions for creating privacy-enhanced jobs.
 */

import nacl from 'tweetnacl'

// --- Sealed bids ---

/** Create a sealed bid hash for commit-reveal scheme. */
export function sealBid(amountLamports: number, salt: Uint8Array): Uint8Array {
  const data = new Uint8Array(8 + salt.length)
  const view = new DataView(data.buffer)
  view.setBigUint64(0, BigInt(amountLamports), true)
  data.set(salt, 8)
  return nacl.hash(data).slice(0, 32)
}

/** Generate a random 32-byte salt. */
export function generateSalt(): Uint8Array {
  return nacl.randomBytes(32)
}

// --- Encryption ---

/** Generate an X25519 keypair for encryption. */
export function generateEncryptionKeypair() {
  return nacl.box.keyPair()
}

/** Encrypt task data with NaCl box. */
export function encryptTaskData(
  plaintext: string,
  recipientPubkey: Uint8Array,
  senderSecretKey: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const msg = new TextEncoder().encode(plaintext)
  const ct = nacl.box(msg, nonce, recipientPubkey, senderSecretKey)
  if (!ct) throw new Error('Encryption failed')
  return { ciphertext: ct, nonce }
}

/** Decrypt task data. */
export function decryptTaskData(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPubkey: Uint8Array,
  recipientSecretKey: Uint8Array
): string {
  const pt = nacl.box.open(ciphertext, nonce, senderPubkey, recipientSecretKey)
  if (!pt) throw new Error('Decryption failed')
  return new TextDecoder().decode(pt)
}

// --- Credential vault ---

/** Encrypt an API key for the credential vault. */
export function encryptCredential(
  credential: string,
  vaultPubkey: Uint8Array,
  posterSecretKey: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  return encryptTaskData(credential, vaultPubkey, posterSecretKey)
}

// --- Hash helpers ---

/** SHA-512 → 32 bytes (for on-chain hashes). */
export function hash32(data: Uint8Array): number[] {
  return Array.from(nacl.hash(data).slice(0, 32))
}

/** Hash a string to 32 bytes. */
export function hashString(str: string): number[] {
  return hash32(new TextEncoder().encode(str))
}

// --- Privacy levels ---
export const PRIVACY_PUBLIC = 0
export const PRIVACY_ENCRYPTED = 1
export const PRIVACY_PER = 2

// --- Job creation config ---
export interface PrivateJobConfig {
  privacyLevel: 0 | 1 | 2
  encryptionKeypair?: { publicKey: Uint8Array; secretKey: Uint8Array }
  taskData?: string
  credential?: string
}

/** Prepare privacy parameters for job creation. */
export function preparePrivateJob(config: PrivateJobConfig) {
  const encKp = config.encryptionKeypair || generateEncryptionKeypair()
  
  let encryptedPayload: { ciphertext: Uint8Array; nonce: Uint8Array } | null = null
  if (config.taskData && config.privacyLevel >= PRIVACY_ENCRYPTED) {
    encryptedPayload = encryptTaskData(config.taskData, encKp.publicKey, encKp.secretKey)
  }

  return {
    privacyLevel: config.privacyLevel,
    encryptionPubkey: Array.from(encKp.publicKey),
    encryptedPayload,
    encryptionKeypair: encKp,
  }
}
