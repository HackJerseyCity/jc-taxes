import type { Env } from './data'

// Per-parcel details fetched on demand instead of shipped with every parcel's
// geometry (D1 `parcels`, filled by `jct bundle`; lot / unit views):
//   GET /api/parcel?view=<lot|unit>&id=<block-lot[-qual]>
//     → { addr, bldg_desc, stories, units, bldg_sqft, lng, lat, owners }
//       (`owners`: run-length by year, `[[firstYear, owner], …]`)
//   GET /api/search?q=<address words>[&limit=]
//     → { results: [{ id, addr, lng, lat }] }  (lot-level, FTS5 prefix match)
const VIEWS = new Set(['lot', 'unit'])

interface Row {
  addr: string | null
  bldg_desc: string | null
  stories: number | null
  units: number | null
  bldg_sqft: number | null
  lng: number
  lat: number
  owners: string
}

export async function handleParcel(url: URL, env: Env): Promise<Response> {
  const view = url.searchParams.get('view') ?? ''
  const id = url.searchParams.get('id') ?? ''
  if (!VIEWS.has(view) || !id) return json({ error: 'view (lot|unit) and id required' }, 400)
  if (!env.DB) return json({ error: 'D1 not bound' }, 503)
  const row = await env.DB
    .prepare('SELECT addr, bldg_desc, stories, units, bldg_sqft, lng, lat, owners FROM parcels WHERE view = ? AND id = ?')
    .bind(view, id)
    .first<Row>()
  if (!row) return json({ view, id, owners: [] }, 404)
  return json({ view, id, ...row, owners: JSON.parse(row.owners) }, 200, 'public, max-age=3600')
}

// "638 lib" → `"638"* "lib"*`: every word as a quoted prefix (quotes keep FTS
// operators / punctuation in user input literal).
export function queryWords(q: string): string[] {
  return q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}
export const ftsQuery = (words: string[]) => words.map(w => `"${w}"*`).join(' ')

export async function handleSearch(url: URL, env: Env): Promise<Response> {
  const words = queryWords(url.searchParams.get('q') ?? '')
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 10) || 10, 50)
  if (!words.length) return json({ results: [] })
  if (!env.DB) return json({ error: 'D1 not bound' }, 503)
  // Every word is a prefix match, so "1 exchange" also hits "10 EXCHANGE";
  // addresses starting with the first word exactly (the house number, usually) rank first.
  const { results } = await env.DB
    .prepare(`SELECT p.id, p.addr, p.lng, p.lat FROM parcels_fts f JOIN parcels p ON p.rowid = f.rowid
              WHERE parcels_fts MATCH ? AND p.view = 'lot'
              ORDER BY (p.addr LIKE ? || ' %') DESC, rank LIMIT ?`)
    .bind(ftsQuery(words), words[0], limit)
    .all<{ id: string, addr: string, lng: number, lat: number }>()
  return json({ results }, 200, 'public, max-age=3600')
}

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
  })
}
