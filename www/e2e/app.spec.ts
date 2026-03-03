import { test, expect, type Page } from '@playwright/test'

/** Wait for the app to finish loading data. */
async function waitForLoad(page: Page) {
  await page.locator('[data-loaded]').waitFor({ timeout: 15000 })
}

test.describe('Loading & data', () => {
  test('default page loads and shows parcel count', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
    await expect(page.getByText(/\d+ parcels/)).toBeVisible()
  })
})

test.describe('Aggregation modes', () => {
  for (const agg of ['lot', 'block', 'ward'] as const) {
    test(`loads with agg=${agg}`, async ({ page }) => {
      await page.goto(`/?agg=${agg}`)
      await waitForLoad(page)
      await expect(page.getByText(/\d+ parcels/)).toBeVisible()
    })
  }
})

test.describe('URL params round-trip', () => {
  test('retains agg and year params after load', async ({ page }) => {
    await page.goto('/?agg=lot&y=2020')
    await waitForLoad(page)
    const url = new URL(page.url())
    expect(url.searchParams.get('agg')).toBe('lot')
    expect(url.searchParams.get('y')).toBe('2020')
  })

  test('year select updates URL', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)
    await page.getByLabel('Tax Year:').selectOption('2020')
    await expect(page).toHaveURL(/[?&]y=2020/)
  })
})

test.describe('Keyboard shortcuts', () => {
  test('l → agg=lot, w → agg=ward, b → agg=block', async ({ page }) => {
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
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    const tooltip = page.locator('text=' + ADDR)
    await expect(tooltip).toBeVisible({ timeout: 5000 })
  })

  test('tooltip shows building info', async ({ page }) => {
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    // Building info line: "2 stories · 2 units · built 1968 · 2,264 sqft (bldg)"
    await expect(page.getByText('2 stories')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('built 1968')).toBeVisible()
  })

  test('tooltip has Maps and Earth links with address', async ({ page }) => {
    await page.goto(`/?agg=lot&sel=${SEL}`)
    await waitForLoad(page)
    const mapsLink = page.locator('a', { hasText: 'Maps' })
    await expect(mapsLink).toBeVisible({ timeout: 5000 })
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
    // 26001-47 = 33 Bayside Terrace, has a note
    await page.goto('/?agg=lot&sel=26001-47')
    await waitForLoad(page)
    await expect(page.getByText('lot-line-adjustment remnant')).toBeVisible({ timeout: 5000 })
  })
})

test.describe('Settings panel', () => {
  test('s toggles settings panel', async ({ page }) => {
    await page.goto('/')
    await waitForLoad(page)

    const taxYearLabel = page.getByText('Tax Year:')
    // Settings may be open by default on desktop; determine initial state
    const initiallyVisible = await taxYearLabel.isVisible()

    // First press toggles
    await page.keyboard.press('s')
    if (initiallyVisible) {
      await expect(taxYearLabel).not.toBeVisible()
    } else {
      await expect(taxYearLabel).toBeVisible()
    }

    // Second press toggles back
    await page.keyboard.press('s')
    if (initiallyVisible) {
      await expect(taxYearLabel).toBeVisible()
    } else {
      await expect(taxYearLabel).not.toBeVisible()
    }
  })
})
