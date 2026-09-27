/** R2-backed data the Worker reads at runtime, cached per-isolate.
 *
 * `stats.json` (per-view + per-portfolio totals) and `portfolios.json` (curated
 * developer portfolios) are derived data kept OUT of git — they live in the
 * `jct-og` R2 bucket (`stats.json` written by `jct stats --upload`,
 * `portfolios.json` mirrored from the DVC-tracked data file). Fetching them at
 * the edge keeps developer/owner names out of the committed source and the
 * client bundle.
 */

export interface Env {
  ASSETS: Fetcher
  OG: R2Bucket
  // Production `jc-taxes` bucket, read-only use: DVC-cached map data (`dvc.ts`).
  DATA: R2Bucket
  // Bound only once a D1 database is provisioned (see edge/README.md); the
  // portfolios endpoint falls back to R2 when it's absent.
  DB?: D1Database
}

export interface YearStat {
  count: number
  paid: number
  billed?: number
}

export interface PortfolioStat {
  label: string
  years: Record<string, YearStat>
}

export interface Stats {
  generated: string
  years: number[]
  latestYear: number
  aggs: Record<string, Record<string, YearStat>>
  portfolios: Record<string, PortfolioStat>
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
let statsCache: Stats | null = null
let portfoliosCache: Portfolio[] | null = null

export async function getStats(env: Env): Promise<Stats | null> {
  if (statsCache) return statsCache
  const obj = await env.OG.get('stats.json')
  if (!obj) return null
  statsCache = await obj.json<Stats>()
  return statsCache
}

export async function getPortfolios(env: Env): Promise<Portfolio[]> {
  if (portfoliosCache) return portfoliosCache
  const obj = await env.OG.get('portfolios.json')
  portfoliosCache = obj ? await obj.json<Portfolio[]>() : []
  return portfoliosCache
}
