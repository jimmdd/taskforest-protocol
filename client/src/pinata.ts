/**
 * Metadata storage client.
 * Uploads/fetches task metadata via the Cloudflare Worker + R2 API.
 * Falls back to localStorage-only if no API URL is configured.
 */

// Set this to your deployed Worker URL, or leave empty for local-only mode
const API_URL = import.meta.env.VITE_METADATA_API || ''

export interface TaskMetadata {
  title: string
  description: string
  category?: string
  requirements?: string[]
  createdAt: string
  poster: string
  reward: number
  deadline: number
}

/**
 * SHA-256 hash of the metadata JSON as a hex string.
 */
export async function hashMetadataHex(metadata: TaskMetadata): Promise<string> {
  const json = JSON.stringify(metadata)
  const encoded = new TextEncoder().encode(json)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * SHA-256 hash as a 32-byte array (for on-chain storage).
 */
export async function hashMetadata(metadata: TaskMetadata): Promise<number[]> {
  const json = JSON.stringify(metadata)
  const encoded = new TextEncoder().encode(json)
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(hashBuffer))
}

/**
 * Upload task metadata to R2 via the Worker API.
 * Returns the content hash (used as the key).
 */
export async function uploadMetadata(metadata: TaskMetadata): Promise<string> {
  const json = JSON.stringify(metadata)
  const hash = await hashMetadataHex(metadata)

  if (!API_URL) {
    console.warn('VITE_METADATA_API not set — using local-only storage')
    return hash // return hash anyway for localStorage keying
  }

  const res = await fetch(`${API_URL}/metadata/${hash}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Upload failed: ${err}`)
  }

  return hash
}

/**
 * Fetch task metadata from the Worker API.
 * Uses localStorage as cache to avoid repeated fetches.
 */
export async function fetchMetadata(hash: string): Promise<TaskMetadata | null> {
  if (!hash) return null

  // Check cache first
  const cacheKey = `tf_meta_${hash}`
  const cached = localStorage.getItem(cacheKey)
  if (cached) {
    try { return JSON.parse(cached) } catch { /* re-fetch */ }
  }

  if (!API_URL) return null

  try {
    const res = await fetch(`${API_URL}/metadata/${hash}`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    const metadata = await res.json() as TaskMetadata
    localStorage.setItem(cacheKey, JSON.stringify(metadata))
    return metadata
  } catch {
    return null
  }
}
