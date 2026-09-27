import { test, expect, type Page, type CDPSession } from '@playwright/test'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// What each user flow downloads, from a deployed site with a cold cache.
// First-party bytes are checked against `baseline.json`: the set of data files
// fetched must match exactly, and transfer bytes per kind may not grow more
// than `TOLERANCE`. `NET_UPDATE=1` rewrites the baseline and appends a line to
// `history.jsonl` instead.

const TOLERANCE = 0.1
const here = dirname(fileURLToPath(import.meta.url))
const BASELINE = join(here, 'baseline.json')
const HISTORY = join(here, 'history.jsonl')
const UPDATE = !!process.env.NET_UPDATE

type Kind = 'data' | 'api' | 'app' | 'files' | 'basemap'
interface Totals { requests: number, transfer: number, decoded: number }
interface FlowResult {
  /** First-party data / API resources, by name (sorted). */
  fetched: string[]
  byKind: Partial<Record<Kind, Totals>>
}

interface Flow {
  name: string
  path: string
  /** Visible once the flow's initial render is done (default: the map's `data-loaded`). */
  ready?: string
  /** Extra interaction after the initial load settles. */
  then?: (page: Page) => Promise<void>
}

const FLOWS: Flow[] = [
  { name: 'home (blocks)', path: '/' },
  { name: 'lots', path: '/?a=l' },
  { name: 'units', path: '/?a=u' },
  { name: 'portfolio (lots)', path: '/?p=newport&a=l' },
  { name: 'step year (lots, j)', path: '/?a=l', then: async page => { await page.keyboard.press('j') } },
  { name: 'playback (blocks)', path: '/?play=1' },
  { name: 'playback (lots)', path: '/?a=l&play=1' },
  { name: 'files (parquet)', path: '/files/records/payments.parquet', ready: 'text=/row group \\d+/' },
]

// `/d/files/md5/…` → `taxes-2025-lots.geojson`, from the deployed bundle's DVC map.
async function dvcNames(page: Page, origin: string): Promise<Map<string, string>> {
  const html = await (await page.request.get('/')).text()
  const js = html.match(/assets\/index-[^"]+\.js/)?.[0]
  const names = new Map<string, string>()
  if (!js) return names
  const src = await (await page.request.get(`/${js}`)).text()
  for (const m of src.matchAll(/"([^"]+)":"(\/d\/files\/md5\/[0-9a-f/]+|https:\/\/[^"]+\/files\/md5\/[0-9a-f/]+)"/g)) {
    names.set(new URL(m[2], origin).pathname, m[1])
  }
  return names
}

function kindOf(url: URL, origin: string): Kind {
  if (url.origin !== origin) return url.hostname.startsWith('jct-files.') ? 'files' : 'basemap'
  if (url.pathname.startsWith('/d/')) return 'data'
  if (url.pathname.startsWith('/api/')) return 'api'
  return 'app'
}

/** Records every response (bytes on the wire + decoded) via CDP. */
async function recordNetwork(page: Page) {
  const cdp: CDPSession = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  const urls = new Map<string, string>()
  const decoded = new Map<string, number>()
  const done: { url: string, transfer: number, decoded: number }[] = []
  const inflight = new Set<string>()
  let lastActivity = Date.now()
  // Redirects re-fire `requestWillBeSent` under the same id, hence a set.
  // In-page `blob:` / `data:` URLs (e.g. maplibre's worker script) never report finishing.
  cdp.on('Network.requestWillBeSent', e => {
    if (/^(blob|data):/.test(e.request.url)) return
    urls.set(e.requestId, e.request.url)
    inflight.add(e.requestId)
    lastActivity = Date.now()
  })
  cdp.on('Network.dataReceived', e => { decoded.set(e.requestId, (decoded.get(e.requestId) ?? 0) + e.dataLength); lastActivity = Date.now() })
  cdp.on('Network.loadingFinished', e => {
    inflight.delete(e.requestId)
    lastActivity = Date.now()
    const url = urls.get(e.requestId)
    if (url) done.push({ url, transfer: e.encodedDataLength, decoded: decoded.get(e.requestId) ?? 0 })
  })
  cdp.on('Network.loadingFailed', e => { inflight.delete(e.requestId); lastActivity = Date.now() })
  /** Resolves once nothing has been in flight for `quietMs`. */
  const settle = async (quietMs = 2500, maxMs = 200_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < maxMs) {
      if (inflight.size === 0 && Date.now() - lastActivity > quietMs) return
      await page.waitForTimeout(250)
    }
    throw new Error(`network not idle after ${maxMs}ms; in flight: ${[...inflight].map(id => urls.get(id)).join(', ')}`)
  }
  return { done, settle }
}

const results: Record<string, FlowResult> = {}

for (const flow of FLOWS) {
  test(flow.name, async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const names = await dvcNames(page, origin)
    const { done, settle } = await recordNetwork(page)
    await page.goto(flow.path)
    // Idle alone can fire during a long JS parse, before the app has asked for data.
    await page.locator(flow.ready ?? '[data-loaded]').first().waitFor({ timeout: 120_000 })
    await settle()
    if (flow.then) {
      await flow.then(page)
      await settle()
    }
    const byKind: FlowResult['byKind'] = {}
    const fetched: string[] = []
    for (const r of done) {
      const url = new URL(r.url)
      const kind = kindOf(url, origin)
      const t = byKind[kind] ??= { requests: 0, transfer: 0, decoded: 0 }
      t.requests++
      t.transfer += r.transfer
      t.decoded += r.decoded
      if (kind === 'data') fetched.push(names.get(url.pathname) ?? url.pathname)
      if (kind === 'api') fetched.push(url.pathname)
    }
    fetched.sort()
    results[flow.name] = { fetched, byKind }

    const mb = (n: number) => (n / 1e6).toFixed(2).padStart(7)
    console.log(`\n${flow.name}`)
    for (const [k, t] of Object.entries(byKind)) {
      console.log(`  ${k.padEnd(8)} ${String(t.requests).padStart(4)} req  ${mb(t.transfer)} MB wire  ${mb(t.decoded)} MB decoded`)
    }

    if (UPDATE) return
    const base: FlowResult | undefined = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8'))[flow.name] : undefined
    expect(base, `no baseline for "${flow.name}" (run with NET_UPDATE=1)`).toBeDefined()
    expect(fetched).toEqual(base!.fetched)
    for (const kind of ['data', 'api', 'app'] as const) {
      const cur = byKind[kind]?.transfer ?? 0
      const prev = base!.byKind[kind]?.transfer ?? 0
      expect(cur, `${kind} transfer bytes vs baseline ${prev}`).toBeLessThanOrEqual(Math.max(prev * (1 + TOLERANCE), prev + 20_000))
    }
  })
}

test.afterAll(({ baseURL }) => {
  if (!UPDATE) return
  // Merge, so updating a subset of flows (`-g`) keeps the others.
  const prev = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
  const merged = Object.fromEntries(FLOWS.map(f => f.name).filter(n => n in results || n in prev).map(n => [n, results[n] ?? prev[n]]))
  writeFileSync(BASELINE, JSON.stringify(merged, null, 2) + '\n')
  const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
  const summary = Object.fromEntries(Object.entries(results).map(([name, r]) => [
    name,
    Object.fromEntries(Object.entries(r.byKind).map(([k, t]) => [k, t.transfer])),
  ]))
  appendFileSync(HISTORY, JSON.stringify({ date: new Date().toISOString(), sha, base: baseURL, transfer: summary }) + '\n')
})
