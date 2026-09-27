/** App data the Worker reads at runtime, cached per-isolate: curated developer
 * portfolios from D1 (fallback: the `portfolios.json` mirror in the `jct-og` R2
 * bucket). Kept out of git — developer / owner names never go in the source or
 * the client bundle. Totals / aggregates come from D1 (`content.ts`).
 */

export interface Env {
  ASSETS: Fetcher
  OG: R2Bucket
  // Production `jc-taxes` bucket, read-only use: DVC-cached map data (`dvc.ts`).
  DATA: R2Bucket
  // D1 `jct` (edge/d1/migrations). Optional so local tooling without the
  // binding still runs; portfolios then fall back to R2.
  DB?: D1Database
}

export interface Portfolio {
  key: string
  label: string
  blocks?: string[]
  parcels?: string[]
  keywords?: string[]
  note?: string
}

// Per-isolate memo. R2 GETs are in-region and fast, but a warm isolate serves
// many crawls, so cache the parsed JSON for the isolate's lifetime.
let portfoliosCache: Portfolio[] | null = null

export async function getPortfolios(env: Env): Promise<Portfolio[]> {
  if (portfoliosCache) return portfoliosCache
  if (env.DB) {
    const { results } = await env.DB.prepare('SELECT key, label FROM portfolios ORDER BY ord, key').all<Portfolio>()
    portfoliosCache = results
  } else {
    const obj = await env.OG.get('portfolios.json')
    portfoliosCache = obj ? await obj.json<Portfolio[]>() : []
  }
  return portfoliosCache
}
