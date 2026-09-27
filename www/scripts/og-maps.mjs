#!/usr/bin/env node
// Capture the map images OG cards embed (`maps/<key>-WxH.jpg` in the `jct-og`
// bucket), from the live app with `clean=1` (no controls).
//
//   node scripts/og-maps.mjs [-b <base url>] [-o <out dir>] [-u] [key[=query] ...]
//
// A `key=query` positional captures an ad-hoc query under that key (for
// trying cameras).
//
// -b  app to capture (default https://jct.rbw.sh)
// -o  output dir (default ../tmp/og-maps)
// -u  upload the JPEGs to R2 (`wrangler r2 object put jct-og/maps/…`)
import { chromium } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { parseArgs } from 'node:util'

// Card key → app query, or `{ WxH: query }` per map size. Citywide pins the
// camera (`v`: lat lng zoom pitch bearing) on downtown / Journal Square,
// cropping the river and Manhattan; the 1200-wide map (layout c, stats overlaid
// on its left) shifts the city right. Wards and portfolios (listed from
// `/api/portfolios`) are auto-fit to their members.
const CITYWIDE = {
  '720x630': 'a=l&v=40.7275-74.0560+12.6+45-20',
  '1200x630': 'a=l&v=40.7260-74.0740+12.9+48-25',
}
const WARDS = ['a', 'b', 'c', 'd', 'e', 'f']
// Map sizes the card layouts use (`mapSize` in edge/src/og/card.ts).
const SIZES = [[720, 630], [1200, 630]]

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: 'string', short: 'b', default: 'https://jct.rbw.sh' },
    out: { type: 'string', short: 'o', default: '../tmp/og-maps' },
    upload: { type: 'boolean', short: 'u', default: false },
  },
})
const { portfolios } = await (await fetch(`${values.base}/api/portfolios`)).json()
const VIEWS = {
  citywide: CITYWIDE,
  ...Object.fromEntries(WARDS.map(w => [`ward-${w}`, `a=l&w=${w}`])),
  ...Object.fromEntries(portfolios.map(({ key }) => [key, `a=l&p=${key}`])),
}
const views = positionals.length
  ? positionals.map(a => { const [k, ...q] = a.split('='); return [k, q.length ? q.join('=') : VIEWS[k]] })
  : Object.entries(VIEWS)
mkdirSync(values.out, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--ignore-gpu-blocklist'] })
const files = []
for (const [w, h] of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  for (const [key, query] of views) {
    const q = typeof query === 'string' ? query : query[`${w}x${h}`]
    const page = await ctx.newPage()
    await page.goto(`${values.base}/?${q}&y=25&so=0&ti=0&clean=1`)
    await page.locator('[data-loaded]').waitFor({ timeout: 60000 })
    // Basemap tiles + bar transitions settle.
    await page.waitForTimeout(6000)
    await page.addStyleTag({ content: '.maplibregl-ctrl, .maplibregl-ctrl-attrib { display: none !important }' })
    const path = `${values.out}/${key}-${w}x${h}.jpg`
    await page.screenshot({ path, type: 'jpeg', quality: 82 })
    files.push(path)
    console.error(path)
    await page.close()
  }
  await ctx.close()
}
await browser.close()

if (values.upload) {
  for (const path of files) {
    const name = path.split('/').pop()
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `jct-og/maps/${name}`, '--file', path, '--content-type', 'image/jpeg', '--remote'], { cwd: '../edge', stdio: 'inherit' })
  }
}
