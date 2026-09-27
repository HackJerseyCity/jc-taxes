/** `GET /api/portfolios` — the curated developer/owner portfolios as data.
 *
 * Prefers D1 (the intended home; see edge/README.md for provisioning) and falls
 * back to the R2 `portfolios.json` mirror when D1 isn't bound yet, so the
 * endpoint works today and D1 is a drop-in later. The app keeps reading its own
 * copy until a separate cutover; this endpoint is the groundwork.
 */
import type { Env, Portfolio } from './data'
import { getPortfolios } from './data'

interface D1PortfolioRow {
  key: string
  label: string
  note: string | null
  blocks: string | null
  parcels: string | null
  keywords: string | null
}

function parseList(s: string | null): string[] | undefined {
  if (!s) return undefined
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) && v.length ? v : undefined
  } catch {
    return undefined
  }
}

async function fromD1(db: D1Database): Promise<Portfolio[]> {
  const { results } = await db
    .prepare('SELECT key, label, note, blocks, parcels, keywords FROM portfolios ORDER BY ord, key')
    .all<D1PortfolioRow>()
  return results.map((r) => ({
    key: r.key,
    label: r.label,
    note: r.note ?? undefined,
    blocks: parseList(r.blocks),
    parcels: parseList(r.parcels),
    keywords: parseList(r.keywords),
  }))
}

export async function handlePortfolios(env: Env): Promise<Response> {
  const source = env.DB ? 'd1' : 'r2'
  const portfolios = env.DB ? await fromD1(env.DB) : await getPortfolios(env)
  return new Response(JSON.stringify({ source, portfolios }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  })
}
