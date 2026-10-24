import { test, expect, type Page } from '@playwright/test'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(__dirname, 'fixtures')

/** Fixture filenames keyed by GeoJSON type suffix. */
const FIXTURES: Record<string, string> = {
  blocks: 'taxes-2025-blocks.geojson',
  lots: 'taxes-2025-lots.geojson',
  wards: 'taxes-2025-wards.geojson',
  'census-blocks': 'taxes-2025-census-blocks.geojson',
  units: 'taxes-2025-units.geojson',
}

const fixtureCache = new Map<string, string | Buffer>()
function readFixture(name: string): string {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, readFileSync(join(fixtureDir, name), 'utf-8'))
  }
  return fixtureCache.get(name) as string
}

// Bundled views (`src/bundle.ts`): geometry + per-year values, synthesized from
// the 2025 fixture (same amounts every year).
const BUNDLE_DYNAMIC = new Set(['paid', 'billed', 'paid_per_sqft', 'billed_per_sqft', 'year'])
// Wards / census blocks: per-year JSON values (with area); ward alt shapes in `ward-shapes-{year}.json`.
const SMALL_VIEWS = new Set(['wards', 'census-blocks'])
const SMALL_DYNAMIC = new Set([...BUNDLE_DYNAMIC, 'area_sqft', 'paid_per_capita', 'billed_per_capita', 'lots', 'blocks'])
// Lot / unit details served by `/api/parcel` instead (DETAIL_PROPS + owner in src/jc_taxes/bundle.py).
const DETAIL_PROPS = new Set(['addr', 'bldg_desc', 'stories', 'units', 'bldg_sqft', 'owner'])
function bundleFixture(kind: 'geom' | 'values', view: string, year?: number): string | Buffer {
  const key = `${kind}-${view}-${year ?? ''}`
  if (!fixtureCache.has(key)) {
    const features: { geometry: unknown, properties: Record<string, unknown> }[] = JSON.parse(readFixture(FIXTURES[view])).features
    if (kind === 'geom') {
      fixtureCache.set(key, JSON.stringify({
        type: 'FeatureCollection',
        features: features.map(f => ({
          type: 'Feature',
          geometry: f.geometry,
          properties: Object.fromEntries(Object.entries(f.properties).filter(([k]) =>
            !(SMALL_VIEWS.has(view) ? SMALL_DYNAMIC : BUNDLE_DYNAMIC).has(k) && !(view !== 'blocks' && DETAIL_PROPS.has(k)))),
        })),
      }))
    } else if (SMALL_VIEWS.has(view)) {
      const col = (k: string) => features.map(f => Number(f.properties[k] ?? 0))
      fixtureCache.set(key, JSON.stringify({ count: features.length, paid: col('paid'), billed: col('billed'), area_sqft: col('area_sqft') }))
    } else {
      // `values-{view}.bin` (VALUES_FORMAT in src/jc_taxes/bundle.py).
      const n = features.length, ny = 1
      const buf = Buffer.alloc(24 + 16 * n * ny)
      buf.write('JCTV', 0, 'ascii')
      // version 1, f64 elements (fixture amounts include block totals over i32 cents)
      buf.writeUInt32LE(1, 4); buf.writeUInt32LE(2, 8); buf.writeUInt32LE(year!, 12); buf.writeUInt32LE(ny, 16); buf.writeUInt32LE(n, 20)
      features.forEach((f, i) => {
        const paid = Math.round(Number(f.properties.paid ?? 0) * 100)
        const delta = Math.round(Number(f.properties.billed ?? 0) * 100) - paid
        for (let y = 0; y < ny; y++) {
          buf.writeDoubleLE(paid, 24 + 8 * (i * ny + y))
          buf.writeDoubleLE(delta, 24 + 8 * (n * ny + i * ny + y))
        }
      })
      fixtureCache.set(key, buf)
    }
  }
  return fixtureCache.get(key)!
}

/** Fixture body for a data file name (`taxes-2025-lots.geojson`, `geom-lots.geojson`, `values-lots.json`), or null. */
function fixtureFor(name: string): string | Buffer | null {
  let m = name.match(/^taxes-\d{4}-([\w-]+)\.geojson$/)
  if (m && FIXTURES[m[1]]) return readFixture(FIXTURES[m[1]])
  m = name.match(/^geom-(blocks|lots|units|wards|census-blocks)\.geojson$/)
  if (m) return bundleFixture('geom', m[1])
  m = name.match(/^values-(blocks|lots|units|wards|census-blocks)-(\d{4})\.(?:bin|json)$/)
  if (m) return bundleFixture('values', m[1], Number(m[2]))
  if (/^ward-shapes-\d{4}\.json$/.test(name)) {
    const wards: { properties: Record<string, unknown> }[] = JSON.parse(readFixture(FIXTURES.wards)).features
    return JSON.stringify(Object.fromEntries(wards.map(({ properties: p }) => [p.ward, { lots: p.lots, blocks: p.blocks }])))
  }
  return null
}
const DATA_NAME = /(taxes-\d{4}-[\w-]+\.geojson|(?:geom|values)-[\w-]+\.(?:geojson|bin|json)|ward-shapes-\d{4}\.json)/

/**
 * Build reverse map from built DVC cache URLs → data file name. Only needed for
 * build/preview mode, where `dvcResolve` returns opaque hash URLs.
 */
let s3Map: Map<string, string> | undefined
function getS3Map(): Map<string, string> {
  if (s3Map) return s3Map
  s3Map = new Map()
  const distDir = join(__dirname, '..', 'dist', 'assets')
  if (!existsSync(distDir)) return s3Map
  const files = readdirSync(distDir).filter(f => f.startsWith('index-') && f.endsWith('.js'))
  if (files.length === 0) return s3Map
  const js = readFileSync(join(distDir, files[0]), 'utf-8')
  // Absolute (S3 / R2 host) or same-origin (`VITE_DVC_BASE_URL=/d`, the edge Worker route).
  const re = /"([\w.-]+\.(?:geojson|json|bin))":"(https:\/\/[^"]*|\/d\/[^"]*)"/g
  let m
  while ((m = re.exec(js)) !== null) {
    s3Map.set(m[2], m[1])
  }
  return s3Map
}

/**
 * Intercept map data fetches and serve local fixtures instead of real data.
 * Handles both dev mode (local paths) and build mode (DVC cache URLs), and
 * mocks the `/api/*` endpoints.
 */
async function mockGeoJSON(page: Page) {
  await mockPortfolios(page)
  // Dev mode: URLs contain the filename (e.g. /taxes-2025-wards.geojson, /geom-lots.geojson)
  await page.route(new RegExp(`/${DATA_NAME.source}$`), async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1)
    const body = fixtureFor(name)
    if (body) await route.fulfill({ contentType: typeof body === 'string' ? 'application/json' : 'application/octet-stream', body })
    else await route.continue()
  })

  // Build mode: URLs are opaque cache hashes; use reverse map from built JS.
  // Hosts: S3 (plugin default), R2, and same-origin `/d` (what CI builds
  // with). Missing the live host means every test downloads the real 20-40 MB
  // data instead of the fixtures, which times the suite out.
  const map = getS3Map()
  if (map.size > 0) {
    await page.route(/jc-taxes\.s3\.amazonaws\.com|data\.jct\.rbw\.sh|\/d\/files\/md5\//, async (route) => {
      const url = route.request().url()
      const name = map.get(url) ?? map.get(new URL(url).pathname)
      const body = name ? fixtureFor(name) : null
      if (body) await route.fulfill({ contentType: typeof body === 'string' ? 'application/json' : 'application/octet-stream', body })
      else await route.continue()
    })
  }
}

/** `/api/portfolios` (D1, via the edge Worker) from the local DVC checkout of
 *  `portfolios.json`, or an empty list where it isn't pulled (CI); `/api/summary` off. */
async function mockPortfolios(page: Page) {
  const local = join(__dirname, '..', 'public', 'portfolios.json')
  const portfolios = existsSync(local) ? JSON.parse(readFileSync(local, 'utf-8')) : []
  await page.route(/\/api\/portfolios$/, route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ source: 'fixture', portfolios }),
  }))
  // Aggregates are computed from the full data, which the fixtures only sample:
  // unavailable here, so the app's client-side fallback (from loaded features) runs.
  await page.route(/\/api\/summary\?/, route => route.fulfill({ status: 503, body: 'no summary in e2e' }))
  // Details from the lot / unit fixtures, as the D1 `parcels` table has them.
  await page.route(/\/api\/parcel\?/, route => {
    const u = new URL(route.request().url())
    const view = u.searchParams.get('view') === 'unit' ? 'units' : 'lots'
    const id = u.searchParams.get('id')
    const f = (JSON.parse(readFixture(FIXTURES[view])).features as { properties: Record<string, unknown> }[])
      .find(({ properties: p }) => [p.block, p.lot, p.qual].filter(Boolean).join('-') === id)
    if (!f) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ owners: [] }) })
    const p = f.properties
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ addr: p.addr, bldg_desc: p.bldg_desc, stories: p.stories, units: p.units, bldg_sqft: p.bldg_sqft, owners: p.owner ? [[2015, p.owner]] : [] }),
    })
  })
  await page.route(/\/api\/search\?/, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ results: [] }) }))
}

/** Wait for the app to finish loading data (data-loaded attribute present). */
async function waitForLoad(page: Page) {
  await page.locator('[data-loaded]').waitFor()
}

/**
 * Wait for a view switch to complete by waiting for the loaded view to *be*
 * the target aggregation: `data-loaded` carries the current aggregateMode (and
 * is absent while loading), so `[data-loaded="<agg>"]` is the unambiguous
 * end-state. Robust even when the load is instant (mocked) or short-circuited
 * by the cache — both of which made the old detach/reattach catch flaky.
 */
async function waitForView(page: Page, agg: string) {
  await page.locator(`[data-loaded="${agg}"]`).waitFor()
}

test.describe('Loading & data', () => {
  test('default page loads and shows parcel count', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)
    await expect(page.getByText(/\$[\d.]+[KMB] · [\d,]+ (blocks|lots|wards)/)).toBeVisible()
  })
})

test.describe('Aggregation modes', () => {
  for (const agg of ['lot', 'block', 'ward'] as const) {
    test(`loads with agg=${agg}`, async ({ page }) => {
      await mockGeoJSON(page)
      await page.goto(`/?agg=${agg}`)
      await waitForLoad(page)
      await expect(page.getByText(/\$[\d.]+[KMB] · [\d,]+ (blocks|lots|wards)/)).toBeVisible()
    })
  }
})

test.describe('URL params round-trip', () => {
  test('short params are retained after load', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?a=l&y=20')
    await waitForLoad(page)
    const url = new URL(page.url())
    expect([...url.searchParams.entries()].filter(([k]) => k === 'a' || k === 'y')).toEqual([['a', 'l'], ['y', '20']])
  })

  test('legacy long params still load, and are rewritten to short form', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot&mt=total&y=2020&rg=ward:E')
    await waitForView(page, 'lot')
    await expect(page).toHaveURL(/[?&]a=l(&|$)/)
    const url = new URL(page.url())
    expect(['agg', 'mt', 'rg'].map(k => url.searchParams.get(k))).toEqual([null, null, null])
    // `y` isn't aliased: a 4-digit year still decodes, and stays as given until changed.
    expect(['a', 'm', 'y', 'w'].map(k => url.searchParams.get(k))).toEqual(['l', 't', '2020', 'e'])
  })

  test('year select updates URL', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)
    await page.getByLabel('Change tax year').selectOption('2020')
    await expect(page).toHaveURL(/[?&]y=20(&|$)/)
  })
})

test.describe('Keyboard shortcuts', () => {
  test('l → a=l, w → a=w, b → block (default, omitted)', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    await page.keyboard.press('l')
    await expect(page).toHaveURL(/[?&]a=l(&|$)/)

    await page.keyboard.press('w')
    await expect(page).toHaveURL(/[?&]a=w(&|$)/)

    await page.keyboard.press('b')
    // block is the default agg, so the param is omitted from URL
    await expect(page).not.toHaveURL(/[?&]a=/)
  })

  test('] increments year, [ decrements year', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?y=22')
    await waitForLoad(page)

    await page.keyboard.press(']')
    await expect(page).toHaveURL(/[?&]y=23(&|$)/)

    await page.keyboard.press('[')
    await expect(page).toHaveURL(/[?&]y=22(&|$)/)
  })

  test('k increments year, j decrements year', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?y=22')
    await waitForLoad(page)

    await page.keyboard.press('k')
    await expect(page).toHaveURL(/[?&]y=23(&|$)/)

    await page.keyboard.press('j')
    await expect(page).toHaveURL(/[?&]y=22(&|$)/)
  })

  test('year keys step from the last year; J / K jump to first / last', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?y=26')
    await waitForLoad(page)

    await page.keyboard.press('k')
    await expect(page).toHaveURL(/[?&]y=26(&|$)/)
    await page.keyboard.press('j')
    // 2025 is the default year, so `y` is omitted
    await expect(page).not.toHaveURL(/[?&]y=/)
    await page.keyboard.press('Shift+J')
    await expect(page).toHaveURL(/[?&]y=15(&|$)/)
    await page.keyboard.press('Shift+K')
    await expect(page).toHaveURL(/[?&]y=26(&|$)/)
  })
})

test.describe('Omnibar', () => {
  test('Cmd+K opens omnibar, Escape closes it', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    // use-kbd binds to Meta; Playwright synthesizes metaKey on any OS
    await page.keyboard.press('Meta+k')

    // Omnibar should have an input
    const input = page.locator('input[type="text"]').first()
    await expect(input).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(input).not.toBeVisible()
  })

  test('address search selects the lot in lot view', async ({ page }) => {
    await mockGeoJSON(page)
    // Registered after mockGeoJSON's empty-result mock, so it takes precedence.
    await page.route(/\/api\/search\?/, route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ results: [{ id: '302-21', addr: '638 LIBERTY AVE.', lng: -74.051, lat: 40.73 }] }),
    }))
    await page.goto('/')
    await waitForLoad(page)

    await page.keyboard.press('Meta+k')
    const input = page.locator('input[type="text"]').first()
    await expect(input).toBeFocused()
    await input.fill('638 liberty')
    await expect(page.locator('.kbd-omnibar-result-label').first()).toHaveText('638 LIBERTY AVE.')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]a=l(&|$)/)
    await expect(page).toHaveURL(/[?&]sel=302-21(&|$)/)
  })

  test('searching a year selects it', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?y=22')
    await waitForLoad(page)

    await page.keyboard.press('Meta+k')
    const input = page.locator('input[type="text"]').first()
    await expect(input).toBeFocused()
    await input.fill('2019')
    await expect(page.locator('.kbd-omnibar-result-label').first()).toHaveText('Year 2019')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/[?&]y=19(&|$)/)
  })
})

test.describe('Selected lot tooltip', () => {
  // 302-21 = 638 Liberty Ave: has stories, units, yr_built, bldg_sqft
  const SEL = '302-21'
  const ADDR = '638 LIBERTY AVE.'

  test('sel= URL param shows pinned tooltip with address', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    await expect(page.locator('text=' + ADDR)).toBeVisible()
  })

  test('tooltip shows building info', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    await expect(page.getByText('2 stories')).toBeVisible()
    await expect(page.getByText('built 1968')).toBeVisible()
  })

  test('tooltip has Maps and Earth links with address', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    const mapsLink = page.locator('a', { hasText: 'Maps' })
    await expect(mapsLink).toBeVisible()
    const href = await mapsLink.getAttribute('href')
    expect(href).toContain('Jersey%20City')
    expect(href).toContain('LIBERTY')
    const earthLink = page.locator('a', { hasText: 'Earth' })
    await expect(earthLink).toBeVisible()
    const earthHref = await earthLink.getAttribute('href')
    expect(earthHref).toContain('earth.google.com')
    expect(earthHref).toContain('Jersey%20City')
  })

  test('lot note appears for annotated lots', async ({ page }) => {
    await mockGeoJSON(page)
    // 26001-47 = 33 Bayside Terrace, has a note
    await page.goto('/?agg=lot&sel=26001-47')
    await waitForLoad(page)
    await expect(page.getByText('lot-line-adjustment remnant')).toBeVisible()
  })
})

test.describe('Color by year built', () => {
  const SEL = '302-21'

  test('checkbox appears in lot view, absent in block view', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot')
    await waitForLoad(page)
    await expect(page.getByText('Color by year built')).toBeVisible()

    await page.keyboard.press('b')
    await waitForView(page, 'block')
    await expect(page.getByText('Color by year built')).not.toBeVisible()
  })

  test('y key toggles cb URL param in lot view', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot')
    await waitForLoad(page)

    await page.keyboard.press('y')
    await expect(page).toHaveURL(/[?&]cb=yr_built/)

    await page.keyboard.press('y')
    await expect(page).not.toHaveURL(/[?&]cb=yr_built/)
  })

  test('y key does nothing in block view', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)
    await page.keyboard.press('y')
    await expect(page).not.toHaveURL(/[?&]cb=yr_built/)
  })

  test('gradient shows year range when cb=yr_built', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot&cb=yr_built')
    await waitForLoad(page)
    // Gradient endpoint labels (the title's year picker also reads 2025, hence `.last()`;
    // `visible` skips the settings' select options).
    await expect(page.getByText('1870', { exact: true })).toBeVisible()
    await expect(page.getByText('2025', { exact: true }).filter({ visible: true }).last()).toBeVisible()
  })

  test('hoverbox highlights yr_built when coloring active', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto(`/?agg=lot&sel=${SEL}&cb=yr_built`)
    await waitForLoad(page)
    const builtSpan = page.getByText('built 1968', { exact: true })
    await expect(builtSpan).toBeVisible()
    const color = await builtSpan.evaluate(el => getComputedStyle(el).color)
    expect(color).not.toBe('rgb(128, 128, 128)')
  })

  test('switching to block view clears cb=yr_built', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot&cb=yr_built')
    await waitForLoad(page)
    await page.keyboard.press('b')
    await waitForView(page, 'block')
    await expect(page).not.toHaveURL(/[?&]cb=yr_built/)
  })
})

test.describe('Built since', () => {
  // Lot fixture: 101-23.01 built 2022 (av $2.0M, paid $35,588), 101-2 built
  // 1990 (av $0.5M), 302-21 built 1968; 4 lots have no year built.
  test('bs=21 at the assessed year lights built-since lots and reports their share', async ({ page }) => {
    await mockGeoJSON(page)
    // Assessed value is 2026-only data, so view 2026 to see the assessed line.
    await page.goto('/?a=l&bs=21&y=26')
    await waitForLoad(page)
    await expect(page.getByTestId('built-since-label')).toContainText('· built since 2021')
    await expect(page.getByTestId('totals-chip')).toContainText('$36K (49% of citywide billed) · 1 lot')
    const stats = page.getByTestId('built-since-stats')
    await expect(stats).toContainText('2026 taxable assessed $2.0M (80% of citywide assessed)')
    await expect(stats).toContainText('4 lots with no year built (excluded)')
  })

  test('away from the assessed year the chip hides the fixed-year assessed value', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?a=l&bs=21')  // default year 2025, not the 2026 assessed year
    await waitForLoad(page)
    const stats = page.getByTestId('built-since-stats')
    // No stale "2026 taxable assessed" figure beside a 2025 total, but the
    // year-independent unknown-count still shows.
    await expect(stats).not.toContainText('taxable assessed')
    await expect(stats).toContainText('4 lots with no year built (excluded)')
    // Paid share is still reported and still citywide-scoped.
    await expect(page.getByTestId('totals-chip')).toContainText('of citywide paid')
  })

  test('built-since label clears only the built-since filter', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?a=l&bs=21')
    await waitForLoad(page)
    // Built-since is the only focus, so the combined "Clear highlight" button is not shown;
    // only the inline built-since clear is present.
    await expect(page.getByRole('button', { name: 'Clear highlight' })).toHaveCount(0)
    await page.getByTestId('built-since-label').click()
    await expect(page).not.toHaveURL(/[?&]bs=/)
    await expect(page).toHaveURL(/[?&]a=l(&|$)/)  // still in lot view
    await expect(page.getByTestId('built-since-stats')).toHaveCount(0)
  })

  test('settings select sets bs; leaving lot / unit views clears it', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?a=l')
    await waitForLoad(page)
    await page.getByLabel('Built since').selectOption('2021')
    await expect(page).toHaveURL(/[?&]bs=21(&|$)/)
    await expect(page.getByTestId('totals-chip')).toContainText('· 1 lot')
    await page.keyboard.press('b')
    await waitForView(page, 'block')
    await expect(page).not.toHaveURL(/[?&]bs=/)
    await expect(page.getByTestId('built-since-stats')).toHaveCount(0)
  })
})

test.describe('Total-$ metric', () => {
  test('m=t retitles the map and exposes the bar-radius control', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?m=t')
    await waitForLoad(page)
    await expect(page.getByLabel('Metric')).toHaveValue('total')
    // Uniform-footprint columns only exist in 3D
    await expect(page.getByText('Bar radius:')).toBeVisible()
  })

  test('bar-radius control is hidden in 2D', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?m=t&3d=0')
    await waitForLoad(page)
    await expect(page.getByText('Bar radius:')).not.toBeVisible()
  })

  test('m cycles $/sqft → total → $/sqft in block view', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    await page.keyboard.press('m')
    await expect(page).toHaveURL(/[?&]m=t(&|$)/)

    await page.keyboard.press('m')
    // per_sqft is the default metric, so the param drops out of the URL
    await expect(page).not.toHaveURL(/[?&]m=/)
  })

  test('m=t survives an aggregation switch', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?m=t')
    await waitForLoad(page)
    await page.keyboard.press('l')
    await waitForView(page, 'lot')
    await expect(page).toHaveURL(/[?&]m=t(&|$)/)
  })

  test('per_capita downgrades to per_sqft when leaving ward view', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?a=w&m=c')
    await waitForLoad(page)
    await page.keyboard.press('b')
    await waitForView(page, 'block')
    await expect(page).not.toHaveURL(/[?&]m=c(&|$)/)
  })
})

test.describe('Settings panel', () => {
  test('s toggles settings panel', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    const taxYearLabel = page.getByText('Max height:')
    const initiallyVisible = await taxYearLabel.isVisible()

    await page.keyboard.press('s')
    if (initiallyVisible) {
      await expect(taxYearLabel).not.toBeVisible()
    } else {
      await expect(taxYearLabel).toBeVisible()
    }

    await page.keyboard.press('s')
    if (initiallyVisible) {
      await expect(taxYearLabel).toBeVisible()
    } else {
      await expect(taxYearLabel).not.toBeVisible()
    }
  })
})

test.describe('Routing', () => {
  test('GET / shows the map (not the landing page)', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)
    await expect(page.getByText(/\$[\d.]+[KMB] · [\d,]+ (blocks|lots|wards)/)).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/')
  })

  test('GET /about shows the landing page', async ({ page }) => {
    await page.goto('/about')
    await expect(page.getByRole('heading', { level: 1, name: /Where Your Property Taxes Go/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /Explore the 3D map/i })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe('/about')
  })

  test('CTA on /about navigates to the map at /', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/about')
    await page.getByRole('link', { name: /Explore the 3D map/i }).click()
    await waitForLoad(page)
    expect(new URL(page.url()).pathname).toBe('/')
  })
})
