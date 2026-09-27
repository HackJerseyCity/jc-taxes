import type { Env } from './data'

// `/d/files/md5/<xx>/<rest>` → the `jc-taxes` bucket's DVC cache object
// `.dvc/cache/files/md5/<xx>/<rest>` (what `vite-plugin-dvc` resolves to when
// the SPA is built with `VITE_DVC_BASE_URL=/d`).
//
// Serving these through the Worker instead of the bucket's public domain:
// - DVC objects are stored without a Content-Type, so Cloudflare neither
//   compresses nor caches them there.
// - When the pipeline has uploaded a max-brotli copy (`jct r2 precompress` →
//   `br/<md5>`, with the original Content-Type), it's sent as-is with
//   `Content-Encoding: br` (~25–40% smaller than on-the-fly compression).
//   Otherwise the raw object goes out as JSON, which the edge compresses.
// - Keys are content-addressed, so responses are immutable and edge-cached.
// - Same-origin with the app: no bucket CORS needed.
// Read-only: only `get` is ever called on the binding.
const MD5_PATH = /^\/d\/files\/md5\/([0-9a-f]{2})\/([0-9a-f]{30})$/
const IMMUTABLE = 'public, max-age=31536000, immutable'

export async function handleDvc(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url)
  const m = url.pathname.match(MD5_PATH)
  if (!m) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const md5 = m[1] + m[2]
  const br = /\bbr\b/.test(request.headers.get('accept-encoding') ?? '')
  // Pre-compressed copies bypass the Cache API: a cached response comes back
  // with `Content-Encoding: br` but default (automatic) body encoding, so
  // returning it would brotli the brotli (observed: browsers got br(br(json))).
  // They're a single R2 read, and immutable for browsers anyway.
  if (br) {
    const obj = await env.DATA.get(`br/${md5}`)
    if (obj) {
      const resp = new Response(obj.body, {
        encodeBody: 'manual',
        headers: {
          'content-type': obj.httpMetadata?.contentType ?? 'application/json',
          'content-encoding': 'br',
          'cache-control': IMMUTABLE,
          vary: 'accept-encoding',
          etag: `"${md5}-br"`,
        },
      })
      return request.method === 'HEAD' ? new Response(null, resp) : resp
    }
  }
  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: 'GET' })
  const cache = caches.default
  const hit = await cache.match(cacheKey)
  if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit
  const obj = await env.DATA.get(`.dvc/cache/files/md5/${m[1]}/${m[2]}`)
  if (!obj) return new Response('Not found', { status: 404 })
  const resp = new Response(obj.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': IMMUTABLE,
      vary: 'accept-encoding',
      etag: obj.httpEtag,
    },
  })
  ctx.waitUntil(cache.put(cacheKey, resp.clone()))
  return request.method === 'HEAD' ? new Response(null, resp) : resp
}
