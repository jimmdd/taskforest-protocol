/**
 * TaskForest Privacy — NaCl encryption helpers
 * Uses tweetnacl (transitive dep of @solana/web3.js) for X25519 box encryption.
 */
import nacl from 'tweetnacl'
import { Buffer } from 'buffer'

// --- Key generation ---

/** Generate an X25519 keypair for encryption (separate from Solana signing keys). */
export function generateEncryptionKeypair() {
  const kp = nacl.box.keyPair()
  return { publicKey: kp.publicKey, secretKey: kp.secretKey }
}

// --- Encryption ---

/** Encrypt data with NaCl box (X25519 + XSalsa20-Poly1305). */
export function encryptData(
  plaintext: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array
): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const messageBytes = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box(messageBytes, nonce, recipientPublicKey, senderSecretKey)
  if (!ciphertext) throw new Error('Encryption failed')
  return { ciphertext, nonce }
}

/** Decrypt NaCl box ciphertext. */
export function decryptData(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): string {
  const plaintext = nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey)
  if (!plaintext) throw new Error('Decryption failed — wrong key or corrupted data')
  return new TextDecoder().decode(plaintext)
}

// --- Sealed bids ---

/** Create a sealed bid: hash(amount + salt) for commit-reveal scheme. */
export function sealBid(amountLamports: number, salt: Uint8Array): Uint8Array {
  const data = new Uint8Array(8 + salt.length)
  // Little-endian u64
  const view = new DataView(data.buffer)
  view.setBigUint64(0, BigInt(amountLamports), true)
  data.set(salt, 8)
  return nacl.hash(data).slice(0, 32) // SHA-512 truncated to 32 bytes
}

/** Generate a random 32-byte salt for sealed bids. */
export function generateSalt(): Uint8Array {
  return nacl.randomBytes(32)
}

// --- Credential vault ---

/** Encrypt an API key or credential for storage in the credential vault. */
export function encryptCredential(
  credential: string,
  vaultPublicKey: Uint8Array,
  posterSecretKey: Uint8Array
): { encrypted: string; nonce: string } {
  const { ciphertext, nonce } = encryptData(credential, vaultPublicKey, posterSecretKey)
  return {
    encrypted: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
  }
}

/** Decrypt a credential from the vault. */
export function decryptCredential(
  encryptedBase64: string,
  nonceBase64: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array
): string {
  const ciphertext = new Uint8Array(Buffer.from(encryptedBase64, 'base64'))
  const nonce = new Uint8Array(Buffer.from(nonceBase64, 'base64'))
  return decryptData(ciphertext, nonce, senderPublicKey, recipientSecretKey)
}

// --- Hashing helpers ---

/** SHA-512 hash (truncated to 32 bytes) for on-chain proof/verification. */
export function hash32(data: Uint8Array): number[] {
  return Array.from(nacl.hash(data).slice(0, 32))
}

/** Hash a string to 32 bytes. */
export function hashString(str: string): number[] {
  return hash32(new TextEncoder().encode(str))
}

// --- Serialization ---

/** Pack encrypted task data for IPFS storage. */
export function packEncryptedPayload(
  ciphertext: Uint8Array,
  nonce: Uint8Array,
  senderPublicKey: Uint8Array
): string {
  return JSON.stringify({
    v: 1,
    ct: Buffer.from(ciphertext).toString('base64'),
    nonce: Buffer.from(nonce).toString('base64'),
    sender: Buffer.from(senderPublicKey).toString('base64'),
  })
}

/** Unpack encrypted payload from IPFS. */
export function unpackEncryptedPayload(json: string): {
  ciphertext: Uint8Array
  nonce: Uint8Array
  senderPublicKey: Uint8Array
} {
  const obj = JSON.parse(json)
  return {
    ciphertext: new Uint8Array(Buffer.from(obj.ct, 'base64')),
    nonce: new Uint8Array(Buffer.from(obj.nonce, 'base64')),
    senderPublicKey: new Uint8Array(Buffer.from(obj.sender, 'base64')),
  }
}
