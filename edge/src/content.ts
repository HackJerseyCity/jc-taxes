/** Shared card/OG text derived from normalized params + stats. Used by both the
 * HTMLRewriter meta tags and the rendered OG image, so they always agree. */
import type { CardParams } from './params'
import type { Stats, YearStat } from './data'

// Compact dollars — mirrors `abbr` in `www/src/MapView.tsx`.
export function abbr(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${Math.round(n)}`
}

const AGG_SINGULAR: Record<string, string> = {
  block: 'block', lot: 'lot', unit: 'unit', ward: 'ward', 'census-block': 'census block',
}
const AGG_PLURAL: Record<string, string> = {
  block: 'blocks', lot: 'lots', unit: 'units', ward: 'wards', 'census-block': 'census blocks',
}
const METRIC_LABEL: Record<string, string> = {
  per_sqft: 'Paid per sq ft', per_capita: 'Paid per capita', total: 'Total paid',
}

export interface CardContent {
  // Big scope/area label (top line of the card + og:title lead).
  scope: string
  // What's being measured, e.g. "Paid per sq ft · by block".
  measure: string
  year: number
  paid: number | null
  count: number | null
  // Plural noun for `count` ("parcels", "blocks", "wards", …).
  countNoun: string
}

export function cardContent(p: CardParams, stats: Stats | null): CardContent {
  if (p.pf) {
    const pf = stats?.portfolios?.[p.pf]
    const ys: YearStat | undefined = pf?.years?.[String(p.year)]
    return {
      scope: pf?.label ?? p.pf,
      measure: 'Developer portfolio · taxes paid',
      year: p.year,
      paid: ys ? ys.paid : null,
      count: ys ? ys.count : null,
      countNoun: 'parcels',
    }
  }
  const ys: YearStat | undefined = stats?.aggs?.[p.agg]?.[String(p.year)]
  return {
    scope: 'Jersey City Property Taxes',
    measure: `${METRIC_LABEL[p.metric]} · by ${AGG_SINGULAR[p.agg]}`,
    year: p.year,
    paid: ys ? ys.paid : null,
    count: ys ? ys.count : null,
    countNoun: AGG_PLURAL[p.agg],
  }
}

export interface OgMeta {
  title: string
  description: string
}

export function ogMeta(p: CardParams, stats: Stats | null): OgMeta {
  const c = cardContent(p, stats)
  if (p.pf) {
    const totals = c.paid != null && c.count != null
      ? `${c.count.toLocaleString()} parcels · ${abbr(c.paid)} paid in ${c.year}`
      : `Jersey City property portfolio`
    return {
      title: `${c.scope} — JC property portfolio`,
      description: `${totals}. Interactive 3D map of Jersey City property taxes.`,
    }
  }
  const totals = c.paid != null && c.count != null
    ? `${c.count.toLocaleString()} ${c.countNoun} · ${abbr(c.paid)} paid in ${c.year}. `
    : ''
  return {
    title: `JC Property Taxes — ${c.measure}`,
    description: `${totals}Interactive 3D map of Jersey City property taxes.`,
  }
}
