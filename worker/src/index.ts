/**
 * TaskForest Metadata API
 * Cloudflare Worker + R2 for storing/fetching job metadata.
 *
 * Routes:
 *   PUT  /metadata/:hash  — Store metadata JSON (hash = SHA-256 of content)
 *   GET  /metadata/:hash  — Fetch metadata JSON
 *   GET  /health          — Health check
 */

export interface Env {
  METADATA: R2Bucket
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    const url = new URL(request.url)
    const path = url.pathname

    // Health check
    if (path === '/health') {
      return json({ status: 'ok', service: 'taskforest-metadata' })
    }

    // PUT /metadata/:hash — store metadata
    if (request.method === 'PUT' && path.startsWith('/metadata/')) {
      const hash = path.split('/metadata/')[1]
      if (!hash || hash.length < 8) {
        return json({ error: 'Invalid hash' }, 400)
      }

      try {
        const body = await request.text()

        // Verify: SHA-256 of the body should match the hash param
        const bodyBytes = new TextEncoder().encode(body)
        const hashBuffer = await crypto.subtle.digest('SHA-256', bodyBytes)
        const computedHash = Array.from(new Uint8Array(hashBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')

        if (computedHash !== hash) {
          return json({ error: 'Hash mismatch — content does not match provided hash' }, 400)
        }

        // Validate it's valid JSON
        JSON.parse(body)

        // Store in R2
        await env.METADATA.put(`metadata/${hash}.json`, body, {
          httpMetadata: { contentType: 'application/json' },
        })

        return json({ ok: true, hash, size: body.length })
      } catch (e) {
        return json({ error: `Upload failed: ${(e as Error).message}` }, 500)
      }
    }

    // GET /metadata/:hash — fetch metadata
    if (request.method === 'GET' && path.startsWith('/metadata/')) {
      const hash = path.split('/metadata/')[1]
      if (!hash) {
        return json({ error: 'Missing hash' }, 400)
      }

      const object = await env.METADATA.get(`metadata/${hash}.json`)
      if (!object) {
        return json({ error: 'Not found' }, 404)
      }

      const body = await object.text()
      return new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=31536000, immutable', // content-addressed = forever cacheable
          ...CORS_HEADERS,
        },
      })
    }

    return json({ error: 'Not found' }, 404)
  },
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  })
}
