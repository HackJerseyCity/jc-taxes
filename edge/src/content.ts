/** Shared card/OG text derived from normalized params + the D1 aggregates.
 * Used by both the HTMLRewriter meta tags and the rendered OG image, so they
 * always agree. */
import type { CardParams } from './params'
import { BILLED_YEARS } from './params'
import type { Env } from './data'
import { getPortfolios } from './data'

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
  /** Paid, or billed for billed-basis years (`billed`). */
  amount: number | null
  billed: boolean
  count: number | null
  // Plural noun for `count` ("parcels", "blocks", "wards", …).
  countNoun: string
  /** Every year's amount (same basis rules), for the sparkline. */
  series: { year: number, amount: number }[]
  /** Pre-rendered map image key prefix in the OG bucket (`maps/<key>-WxH.jpg`). */
  mapKey: string
  layout: CardParams['layout']
}

interface AggRow { year: number, count: number, amount: number }

// Per-isolate memo: aggregates only change when the pipeline reloads D1.
const aggMemo = new Map<string, Promise<AggRow[]>>()
function aggregates(env: Env, view: string, focus: string): Promise<AggRow[]> {
  const k = `${view}|${focus}`
  let p = aggMemo.get(k)
  if (!p) {
    p = env.DB
      ? env.DB.prepare('SELECT year, count, amount FROM aggregates WHERE view = ? AND focus = ? ORDER BY year')
        .bind(view, focus).all<AggRow>().then(r => r.results)
      : Promise.resolve([])
    p.catch(() => aggMemo.delete(k))
    aggMemo.set(k, p)
  }
  return p
}

export async function cardContent(p: CardParams, env: Env): Promise<CardContent> {
  const billed = BILLED_YEARS.has(p.year)
  if (p.pf) {
    // Amounts at unit granularity (unit-level portfolio entries only match
    // there); the parcel count from the lot view.
    const [units, lots, portfolios] = await Promise.all([
      aggregates(env, 'unit', `pf:${p.pf}`), aggregates(env, 'lot', `pf:${p.pf}`), getPortfolios(env),
    ])
    const y = units.find(r => r.year === p.year)
    return {
      scope: portfolios.find(x => x.key === p.pf)?.label ?? p.pf,
      measure: `Developer portfolio · taxes ${billed ? 'billed' : 'paid'}`,
      year: p.year,
      amount: y?.amount ?? null,
      billed,
      count: lots.find(r => r.year === p.year)?.count ?? null,
      countNoun: 'lots',
      series: units.map(r => ({ year: r.year, amount: r.amount })),
      mapKey: p.pf,
      layout: p.layout,
    }
  }
  const focus = p.ward ? `ward:${p.ward}` : ''
  const rows = await aggregates(env, p.agg, focus)
  const y = rows.find(r => r.year === p.year)
  const metric = billed ? METRIC_LABEL[p.metric].replace('Paid', 'Billed') : METRIC_LABEL[p.metric]
  return {
    scope: p.ward ? `Ward ${p.ward}, Jersey City` : 'Jersey City Property Taxes',
    measure: `${metric} · by ${AGG_SINGULAR[p.agg]}`,
    year: p.year,
    amount: y?.amount ?? null,
    billed,
    count: y?.count ?? null,
    countNoun: AGG_PLURAL[p.agg],
    series: rows.map(r => ({ year: r.year, amount: r.amount })),
    mapKey: p.ward ? `ward-${p.ward.toLowerCase()}` : 'citywide',
    layout: p.layout,
  }
}

export interface OgMeta {
  title: string
  description: string
}

export function ogMeta(p: CardParams, c: CardContent): OgMeta {
  const verb = c.billed ? 'billed' : 'paid'
  if (p.pf) {
    const totals = c.amount != null && c.count != null
      ? `${c.count.toLocaleString()} lots · ${abbr(c.amount)} ${verb} in ${c.year}`
      : `Jersey City property portfolio`
    return {
      title: `${c.scope} — JC property portfolio`,
      description: `${totals}. Interactive 3D map of Jersey City property taxes.`,
    }
  }
  const totals = c.amount != null && c.count != null
    ? `${c.count.toLocaleString()} ${c.countNoun} · ${abbr(c.amount)} ${verb} in ${c.year}. `
    : ''
  return {
    title: `${p.ward ? `Ward ${p.ward} — ` : ''}JC Property Taxes — ${c.measure}`,
    description: `${totals}Interactive 3D map of Jersey City property taxes.`,
  }
}
