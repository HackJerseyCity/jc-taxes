/** Normalize the map's URL query params into a canonical card spec.
 *
 * Mirrors the app's `useUrlState` defaults + `effectiveMetricFor` in
 * `www/src/MapView.tsx`, so a shared link's OG card matches what the map shows.
 */

export const AGGS = ['block', 'lot', 'unit', 'ward', 'census-block'] as const
export const METRICS = ['per_sqft', 'per_capita', 'total'] as const
export const MIN_YEAR = 2015
export const MAX_YEAR = 2025

export type Agg = (typeof AGGS)[number]
export type Metric = (typeof METRICS)[number]

export interface CardParams {
  agg: Agg
  metric: Metric
  year: number
  pf: string
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], dflt: T): T {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : dflt
}

// Short URL codes (canonical; see `www/src/urlParams.ts`); long forms still accepted.
const AGG_BY_CODE: Record<string, Agg> = { b: 'block', l: 'lot', u: 'unit', c: 'census-block', w: 'ward' }
const METRIC_BY_CODE: Record<string, Metric> = { s: 'per_sqft', t: 'total', c: 'per_capita' }

function get(url: URL, short: string, long: string, byCode: Record<string, string> = {}): string | null {
  const s = url.searchParams.get(short)
  if (s != null) return byCode[s] ?? s
  return url.searchParams.get(long)
}

export function normalizeParams(url: URL, portfolioKeys: Set<string>): CardParams {
  const agg = pick(get(url, 'a', 'agg', AGG_BY_CODE), AGGS, 'block')
  let metric = pick(get(url, 'm', 'mt', METRIC_BY_CODE), METRICS, 'per_sqft')
  // per_capita needs population data — only ward / census-block have it.
  if (metric === 'per_capita' && agg !== 'ward' && agg !== 'census-block') metric = 'per_sqft'

  const yRaw = url.searchParams.get('y')
  let year = MAX_YEAR
  if (yRaw != null) {
    let n = Math.floor(parseFloat(yRaw))
    if (n < 100) n += 2000
    if (!Number.isNaN(n)) year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, n))
  }

  const pfRaw = get(url, 'p', 'pf') ?? ''
  const pf = portfolioKeys.has(pfRaw) ? pfRaw : ''

  return { agg, metric, year, pf }
}

/** Stable, canonical query string — the OG-image URL + R2 cache key. Only
 * meaningful params, always in the same order, so equivalent views collapse to
 * one cached card. */
export function canonicalQuery(p: CardParams): string {
  const sp = new URLSearchParams()
  if (p.pf) {
    sp.set('pf', p.pf)
  } else {
    sp.set('agg', p.agg)
    sp.set('mt', p.metric)
  }
  sp.set('y', String(p.year))
  return sp.toString()
}
