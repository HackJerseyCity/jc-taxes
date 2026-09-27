/** `jct-edge` — Worker + Static Assets origin for the JC-taxes map.
 *
 *  - static SPA (`../www/dist`) via the ASSETS binding + SPA fallback
 *  - per-URL Open Graph tags rewritten into the HTML shell at the edge
 *  - `/og` renders a 1200×630 stats card (satori + resvg-wasm), cached in R2
 *  - `/api/portfolios` serves the curated developer portfolios (D1 → R2)
 *  - `/api/summary` per view × focus × year totals / height-scale maxima (D1)
 *  - `/api/parcel` per-parcel details on demand, `/api/search` address search (D1)
 *  - `/d/*` serves DVC-cached map data from the `jc-taxes` bucket (`dvc.ts`)
 */
import type { Env } from './data'
import { handleDvc } from './dvc'
import { handleSummary } from './summary'
import { handleParcel, handleSearch } from './parcel'
import { getPortfolios } from './data'
import { normalizeParams, canonicalQuery } from './params'
import { cardContent, ogMeta, type CardContent } from './content'
import { rewriteOg } from './rewrite'
import { mapSize, renderCard } from './og/card'
import { handlePortfolios } from './portfolios'

async function portfolioKeys(env: Env): Promise<Set<string>> {
  const list = await getPortfolios(env)
  return new Set(list.map((p) => p.key))
}

// Bump when the card layout code changes. Data and map-image changes need no
// bump: the R2 key hashes the card's content and the map image's etag.
const CARD_VERSION = 'v3'

async function cacheKey(c: CardContent, mapEtag: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([CARD_VERSION, c, mapEtag])))
  const hex = [...new Uint8Array(digest)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('')
  return `cards/${CARD_VERSION}/${hex}.png`
}

function pngResponse(body: BodyInit, cache: 'HIT' | 'MISS' | 'BYPASS'): Response {
  return new Response(body, {
    headers: {
      'content-type': 'image/png',
      'cache-control': cache === 'BYPASS' ? 'no-store' : 'public, max-age=86400, s-maxage=604800',
      'access-control-allow-origin': '*',
      'x-og-cache': cache,
    },
  })
}

/** The pre-rendered map for a card (`maps/<key>-WxH.jpg`, captured offline),
 *  falling back to the citywide map when that view has none. */
async function mapImage(env: Env, c: CardContent): Promise<R2ObjectBody | null> {
  const size = mapSize(c.layout)
  if (!size) return null
  const [w, hgt] = size
  return (await env.OG.get(`maps/${c.mapKey}-${w}x${hgt}.jpg`)) ?? env.OG.get(`maps/citywide-${w}x${hgt}.jpg`)
}

async function handleOg(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const params = normalizeParams(url, await portfolioKeys(env))
  const content = await cardContent(params, env)
  const map = await mapImage(env, content)
  const mapBytes = map ? new Uint8Array(await map.arrayBuffer()) : null
  if (url.searchParams.has('nocache')) return pngResponse(await renderCard(content, mapBytes), 'BYPASS')

  const key = await cacheKey(content, map?.httpEtag ?? '')
  const hit = await env.OG.get(key)
  if (hit) return pngResponse(hit.body, 'HIT')

  const png = await renderCard(content, mapBytes)
  // Store without blocking the response.
  ctx.waitUntil(env.OG.put(key, png, { httpMetadata: { contentType: 'image/png' } }))
  return pngResponse(png, 'MISS')
}

// Side-by-side comparison of card layouts across a few views (review aid).
const REVIEW_VIEWS: [string, string][] = [
  ['Citywide, lots', 'agg=lot&y=25'],
  ['Newport portfolio', 'pf=newport&y=25'],
  ['Ward E, lots', 'agg=lot&w=e&y=25'],
  ['Namdar portfolio', 'pf=namdar&y=25'],
  ['Citywide, 2026 (billed)', 'agg=lot&y=26'],
]
const REVIEW_LAYOUTS: [string, string][] = [
  ['a', 'Text only (current)'],
  ['b', 'Map left, stats right'],
  ['c', 'Full-bleed map, stats overlay'],
  ['d', 'Stats left, map right'],
]
function handleReview(): Response {
  const cells = REVIEW_VIEWS.map(([label, q]) => `
    <h2>${label}</h2>
    <div class="row">${REVIEW_LAYOUTS.map(([l, name]) => `
      <figure><img src="/og?${q}&layout=${l}&nocache=1" width="600" height="315" alt="${label}: ${name}"><figcaption><b>${l}</b> · ${name}</figcaption></figure>`).join('')}
    </div>`).join('')
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OG card layouts</title>
<style>
  :root { color-scheme: dark; --bg: #0b0f19; --fg: #e8edf5; --muted: #93a1b8 }
  :root[data-theme="light"] { color-scheme: light; --bg: #f6f7fb; --fg: #0e1320; --muted: #5a6478 }
  @media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg: #f6f7fb; --fg: #0e1320; --muted: #5a6478 } }
  body { background: var(--bg); color: var(--fg); font: 15px/1.4 Inter, system-ui, sans-serif; margin: 0; padding: 16px }
  h1 { font-size: 20px; margin: 0 0 4px } p { color: var(--muted); margin: 0 0 16px }
  h2 { font-size: 16px; margin: 24px 0 8px }
  .row { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(600px, 100%), 1fr)); gap: 16px }
  figure { margin: 0 } img { width: 100%; height: auto; border-radius: 8px; display: block; background: #111 }
  figcaption { color: var(--muted); font-size: 13px; margin-top: 4px }
</style></head><body>
<h1>OG card layouts</h1>
<p>Live-rendered (<code>/og?…&amp;layout=</code>, uncached). Maps are pre-rendered captures (2025 lots); stats and sparkline come from the D1 aggregates.</p>
${cells}
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/api/portfolios') return handlePortfolios(env)
    if (path === '/api/summary') return handleSummary(url, env)
    if (path === '/api/parcel') return handleParcel(url, env)
    if (path === '/api/search') return handleSearch(url, env)
    if (path.startsWith('/d/')) return (await handleDvc(request, env, ctx)) ?? new Response('Not found', { status: 404 })
    if (path === '/og' || path === '/api/og') return handleOg(url, env, ctx)
    if (path === '/og/review') return handleReview()

    // Everything else → static assets. Rewrite OG tags when the response is the
    // HTML shell (direct hits + SPA fallback for client routes); pass other
    // assets (JS/CSS/images) straight through.
    const resp = await env.ASSETS.fetch(request)
    const ct = resp.headers.get('content-type') || ''
    if (!ct.includes('text/html')) return resp

    const params = normalizeParams(url, await portfolioKeys(env))
    const meta = ogMeta(params, await cardContent(params, env))
    return rewriteOg(resp, {
      ...meta,
      imageUrl: `${url.origin}/og?${canonicalQuery(params)}`,
      pageUrl: url.origin + path + (url.search || ''),
    })
  },
} satisfies ExportedHandler<Env>
