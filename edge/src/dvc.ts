import type { Env } from './data'

// `/d/files/md5/<xx>/<rest>` → the `jc-taxes` bucket's DVC cache object
// `.dvc/cache/files/md5/<xx>/<rest>` (what `vite-plugin-dvc` resolves to when
// the SPA is built with `VITE_DVC_BASE_URL=/d`).
//
// Serving these through the Worker instead of the bucket's public domain:
// - DVC objects are stored without a Content-Type, so Cloudflare neither
//   compresses nor caches them there (25 MB raw per lots GeoJSON). Here they
//   go out as JSON, which the edge compresses (≈6× smaller).
// - Keys are content-addressed, so responses are immutable and edge-cached.
// - Same-origin with the app: no bucket CORS needed.
// Read-only: only `get` is ever called on the binding.
const MD5_PATH = /^\/d\/files\/md5\/([0-9a-f]{2})\/([0-9a-f]{30})$/

export async function handleDvc(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null> {
  const m = new URL(request.url).pathname.match(MD5_PATH)
  if (!m) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } })
  }
  const cache = caches.default
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' })
  const hit = await cache.match(cacheKey)
  if (hit) return request.method === 'HEAD' ? new Response(null, hit) : hit

  const obj = await env.DATA.get(`.dvc/cache/files/md5/${m[1]}/${m[2]}`)
  if (!obj) return new Response('Not found', { status: 404 })
  const resp = new Response(obj.body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: obj.httpEtag,
    },
  })
  ctx.waitUntil(cache.put(cacheKey, resp.clone()))
  return request.method === 'HEAD' ? new Response(null, resp) : resp
}
