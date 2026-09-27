import type { Env } from './data'

// `GET /api/parcel?view=<lot|unit>&id=<block-lot[-qual]>`: per-parcel details
// fetched on hover / select rather than shipped with every parcel's geometry.
// Currently the owner history (`owners`, D1 table filled by `jct bundle`),
// run-length by year: `[[firstYear, owner], …]`.
const VIEWS = new Set(['lot', 'unit'])

export async function handleParcel(url: URL, env: Env): Promise<Response> {
  const view = url.searchParams.get('view') ?? ''
  const id = url.searchParams.get('id') ?? ''
  if (!VIEWS.has(view) || !id) return json({ error: 'view (lot|unit) and id required' }, 400)
  if (!env.DB) return json({ error: 'D1 not bound' }, 503)
  const row = await env.DB
    .prepare('SELECT owners FROM owners WHERE view = ? AND id = ?')
    .bind(view, id)
    .first<{ owners: string }>()
  return json({ view, id, owners: row ? JSON.parse(row.owners) : [] })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  })
}
