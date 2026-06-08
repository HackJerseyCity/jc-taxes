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

const fixtureCache = new Map<string, string>()
function readFixture(name: string): string {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, readFileSync(join(fixtureDir, name), 'utf-8'))
  }
  return fixtureCache.get(name)!
}

/**
 * Build reverse map from S3 DVC cache URLs → GeoJSON suffix.
 * Only needed for build/preview mode where dvcResolve returns opaque S3 URLs.
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
  const re = /"taxes-\d{4}-(blocks|lots|wards|census-blocks|units)\.geojson":"(https:\/\/[^"]*)"/g
  let m
  while ((m = re.exec(js)) !== null) {
    s3Map.set(m[2], m[1])
  }
  return s3Map
}

/**
 * Intercept GeoJSON fetches and serve local fixtures instead of real data.
 * Handles both dev mode (local paths) and build mode (S3 DVC cache URLs).
 */
async function mockGeoJSON(page: Page) {
  // Dev mode: URLs contain the filename (e.g. /taxes-2025-lots.geojson)
  await page.route(/\/taxes-\d{4}-(blocks|lots|wards|census-blocks|units)\.geojson/, async (route) => {
    const match = route.request().url().match(/taxes-\d{4}-(blocks|lots|wards|census-blocks|units)\.geojson/)
    if (match && FIXTURES[match[1]]) {
      await route.fulfill({ contentType: 'application/json', body: readFixture(FIXTURES[match[1]]) })
    } else {
      await route.continue()
    }
  })

  // Build mode: URLs are opaque S3 hashes; use reverse map from built JS
  const map = getS3Map()
  if (map.size > 0) {
    await page.route(/jc-taxes\.s3\.amazonaws\.com/, async (route) => {
      const suffix = map.get(route.request().url())
      if (suffix && FIXTURES[suffix]) {
        await route.fulfill({ contentType: 'application/json', body: readFixture(FIXTURES[suffix]) })
      } else {
        await route.continue()
      }
    })
  }
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
    await expect(page.getByText(/\d+ parcels/)).toBeVisible()
  })
})

test.describe('Aggregation modes', () => {
  for (const agg of ['lot', 'block', 'ward'] as const) {
    test(`loads with agg=${agg}`, async ({ page }) => {
      await mockGeoJSON(page)
      await page.goto(`/?agg=${agg}`)
      await waitForLoad(page)
      await expect(page.getByText(/\d+ parcels/)).toBeVisible()
    })
  }
})

test.describe('URL params round-trip', () => {
  test('retains agg and year params after load', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?agg=lot&y=2020')
    await waitForLoad(page)
    const url = new URL(page.url())
    expect(url.searchParams.get('agg')).toBe('lot')
    expect(url.searchParams.get('y')).toBe('2020')
  })

  test('year select updates URL', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)
    await page.getByLabel('Tax Year:').selectOption('2020')
    await expect(page).toHaveURL(/[?&]y=2020/)
  })
})

test.describe('Keyboard shortcuts', () => {
  test('l → agg=lot, w → agg=ward, b → agg=block', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    await page.keyboard.press('l')
    await expect(page).toHaveURL(/[?&]agg=lot/)

    await page.keyboard.press('w')
    await expect(page).toHaveURL(/[?&]agg=ward/)

    await page.keyboard.press('b')
    // block is the default agg, so the param is omitted from URL
    await expect(page).not.toHaveURL(/[?&]agg=/)
  })

  test('] increments year, [ decrements year', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/?y=2022')
    await waitForLoad(page)

    await page.keyboard.press(']')
    await expect(page).toHaveURL(/[?&]y=2023/)

    await page.keyboard.press('[')
    await expect(page).toHaveURL(/[?&]y=2022/)
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
    await expect(page.getByText('1870')).toBeVisible()
    await expect(page.locator('span', { hasText: /^2025$/ })).toBeVisible()
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

test.describe('Settings panel', () => {
  test('s toggles settings panel', async ({ page }) => {
    await mockGeoJSON(page)
    await page.goto('/')
    await waitForLoad(page)

    const taxYearLabel = page.getByText('Tax Year:')
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
