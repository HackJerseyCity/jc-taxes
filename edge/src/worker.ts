/** `jct-edge` — Worker + Static Assets origin for the JC-taxes map.
 *
 *  - static SPA (`../www/dist`) via the ASSETS binding + SPA fallback
 *  - per-URL Open Graph tags rewritten into the HTML shell at the edge
 *  - `/og` renders a 1200×630 stats card (satori + resvg-wasm), cached in R2
 *  - `/api/portfolios` serves the curated developer portfolios (D1 → R2)
 */
import type { Env } from './data'
import { getStats, getPortfolios } from './data'
import { normalizeParams, canonicalQuery, type CardParams } from './params'
import { cardContent, ogMeta } from './content'
import { rewriteOg } from './rewrite'
import { renderCard } from './og/card'
import { handlePortfolios } from './portfolios'

async function portfolioKeys(env: Env): Promise<Set<string>> {
  const list = await getPortfolios(env)
  return new Set(list.map((p) => p.key))
}

// Bump when the card layout changes, so stale R2 renders are bypassed (old
// keys can then be deleted at leisure). Stats changes are handled by `jct
// stats --upload` embedding `generated` into the key (see below).
const CARD_VERSION = 'v2'

function cacheKey(p: CardParams, statsGenerated: string): string {
  const base = p.pf ? `pf-${p.pf}` : `${p.agg}-${p.metric}`
  // `generated` changes on every stats regen → fresh cards, no purge needed.
  const gen = statsGenerated.replace(/[^0-9]/g, '').slice(0, 14) || 'nostats'
  return `cards/${CARD_VERSION}/${gen}/${base}-${p.year}.png`
}

function pngResponse(body: BodyInit, cache: 'HIT' | 'MISS'): Response {
  return new Response(body, {
    headers: {
      'content-type': 'image/png',
      // Long browser/CDN cache; the R2 key embeds the card version + stats
      // generation time, so new data/layouts produce new objects.
      'cache-control': 'public, max-age=86400, s-maxage=604800',
      'access-control-allow-origin': '*',
      'x-og-cache': cache,
    },
  })
}

async function handleOg(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const stats = await getStats(env)
  const params = normalizeParams(url, await portfolioKeys(env))
  const key = cacheKey(params, stats?.generated ?? '')

  const hit = await env.OG.get(key)
  if (hit) return pngResponse(hit.body, 'HIT')

  const png = await renderCard(cardContent(params, stats))
  // Store without blocking the response.
  ctx.waitUntil(env.OG.put(key, png, { httpMetadata: { contentType: 'image/png' } }))
  return pngResponse(png, 'MISS')
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === '/api/portfolios') return handlePortfolios(env)
    if (path === '/og' || path === '/api/og') return handleOg(url, env, ctx)

    // Everything else → static assets. Rewrite OG tags when the response is the
    // HTML shell (direct hits + SPA fallback for client routes); pass other
    // assets (JS/CSS/images) straight through.
    const resp = await env.ASSETS.fetch(request)
    const ct = resp.headers.get('content-type') || ''
    if (!ct.includes('text/html')) return resp

    const stats = await getStats(env)
    const params = normalizeParams(url, await portfolioKeys(env))
    const meta = ogMeta(params, stats)
    return rewriteOg(resp, {
      ...meta,
      imageUrl: `${url.origin}/og?${canonicalQuery(params)}`,
      pageUrl: url.origin + path + (url.search || ''),
    })
  },
} satisfies ExportedHandler<Env>
