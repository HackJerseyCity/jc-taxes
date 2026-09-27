import type { Env } from './data'

// `GET /api/summary?view=<agg>&focus=<focus>`: every year's totals and
// height-scale maxima for one view × focus, from the D1 `aggregates` table
// (filled by `jct aggregates`). Lets the client show totals, the sparkline and
// a cross-year height scale without loading other years' data.
//   focus: '' (citywide), 'pf:<key>', 'ward:<A-F>', 'hood:<name>'
const VIEWS = new Set(['block', 'lot', 'unit', 'ward', 'census-block'])
const METRICS = ['per_sqft', 'total', 'per_capita'] as const

interface Row {
  year: number
  count: number
  amount: number
  paid: number
  billed: number
  max_per_sqft: number | null
  max_total: number | null
  max_per_capita: number | null
}

export async function handleSummary(url: URL, env: Env): Promise<Response> {
  const view = url.searchParams.get('view') ?? 'block'
  const focus = url.searchParams.get('focus') ?? ''
  if (!VIEWS.has(view)) return json({ error: `unknown view: ${view}` }, 400)
  if (!env.DB) return json({ error: 'D1 not bound' }, 503)
  const { results } = await env.DB
    .prepare('SELECT year, count, amount, paid, billed, max_per_sqft, max_total, max_per_capita FROM aggregates WHERE view = ? AND focus = ? ORDER BY year')
    .bind(view, focus)
    .all<Row>()
  const years = results.map(r => ({
    year: r.year,
    count: r.count,
    amount: r.amount,
    paid: r.paid,
    billed: r.billed,
    max: { per_sqft: r.max_per_sqft, total: r.max_total, per_capita: r.max_per_capita },
  }))
  const max = Object.fromEntries(METRICS.map(m => [
    m,
    years.reduce<number | null>((acc, y) => y.max[m] == null ? acc : Math.max(acc ?? 0, y.max[m]!), null),
  ]))
  return json({ view, focus, years, max })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Changes only when the pipeline reloads D1; short edge/browser cache.
      'cache-control': 'public, max-age=300',
    },
  })
}
