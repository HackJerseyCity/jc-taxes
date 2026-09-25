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

export function normalizeParams(url: URL, portfolioKeys: Set<string>): CardParams {
  const agg = pick(url.searchParams.get('agg'), AGGS, 'block')
  let metric = pick(url.searchParams.get('mt'), METRICS, 'per_sqft')
  // per_capita needs population data — only ward / census-block have it.
  if (metric === 'per_capita' && agg !== 'ward' && agg !== 'census-block') metric = 'per_sqft'

  const yRaw = url.searchParams.get('y')
  let year = MAX_YEAR
  if (yRaw != null) {
    const n = Math.floor(parseFloat(yRaw))
    if (!Number.isNaN(n)) year = Math.min(MAX_YEAR, Math.max(MIN_YEAR, n))
  }

  const pfRaw = url.searchParams.get('pf') ?? ''
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
