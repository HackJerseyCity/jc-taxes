#!/usr/bin/env node
// Smoke test: record JC tax-payment animation 2018→2025 via puppeteer-capture.
// Uses CDP HeadlessExperimental.beginFrame for deterministic per-frame capture.
// macOS host is unsupported by beginFrame — run inside the Docker image instead
// (see docker/Dockerfile.capture and scripts/capture-docker.sh).
import { capture, launch } from 'puppeteer-capture'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const URL = process.env.JCT_URL ?? 'http://localhost:3201/?agg=lot&3d=1&y=2018&animYr=2018-2025:1&v=40.7197-74.0506+12.0+45+0'
const OUT = process.env.JCT_OUT ?? 'tmp/jc-anim.mp4'
const SECS = Number(process.env.JCT_SECS ?? 9)
const FPS = Number(process.env.JCT_FPS ?? 30)
// JCT_MODE=screenshot: skip the beginFrame recorder, just navigate + take a
// PNG. Used to debug whether the page renders at all (independent of
// puppeteer-capture's deterministic-mode interaction with WebGL).
const MODE = process.env.JCT_MODE ?? 'capture'

function findBrowser(name) {
  // 1) Honor explicit env override (set in Docker image)
  if (name === 'chrome-headless-shell' && process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }

  // 2) Search ~/.cache/puppeteer/<name>/<version>/<archDir>/<name>
  const cacheRoot = process.env.PUPPETEER_CACHE_DIR
    ?? path.join(os.homedir(), '.cache', 'puppeteer')
  const root = path.join(cacheRoot, name)
  if (!fs.existsSync(root)) {
    throw new Error(`No ${name} at ${root}; run: npx puppeteer browsers install ${name}`)
  }
  for (const verDir of fs.readdirSync(root)) {
    const verPath = path.join(root, verDir)
    if (!fs.statSync(verPath).isDirectory()) continue
    for (const archDir of fs.readdirSync(verPath)) {
      const candidate = path.join(verPath, archDir, name)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error(`Found ${root} but no ${name} binary inside`)
}

console.log(`Mode=${MODE} URL=${URL} → ${OUT} (${SECS}s @ ${FPS}fps)`)

import puppeteerCore from 'puppeteer-core'

// puppeteer-capture (capture mode) requires chrome-headless-shell. The
// screenshot/screencast modes use the full chrome binary, which has better
// WebGL support than the shell variant.
const browserName = MODE === 'capture' ? 'chrome-headless-shell' : 'chrome'
const launchArgs = {
  executablePath: findBrowser(browserName),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    // Modern Chrome: ANGLE + SwiftShader is the supported software-WebGL path.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-features=WebGPU',
  ],
}

console.log('launching browser')
const browser = MODE === 'capture'
  ? await launch(launchArgs)
  : await puppeteerCore.launch({ ...launchArgs, headless: 'shell' })
try {
  console.log('opening page')
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 })

  // Surface page errors to host stdout so we can diagnose render failures.
  page.on('console', msg => console.log(`[page] ${msg.type()}: ${msg.text()}`))
  page.on('pageerror', err => console.log(`[page] error: ${err.message}`))

  if (MODE === 'screenshot') {
    console.log(`navigating to ${URL}`)
    await page.goto(URL, { waitUntil: 'load', timeout: 30_000 })

    // Probe WebGL details before settling — surfaces renderer/version info
    // separately from any later page errors.
    try {
      const info = await page.evaluate(() => {
        const c = document.createElement('canvas')
        const gl = c.getContext('webgl2') || c.getContext('webgl')
        if (!gl) return { ok: false, reason: 'getContext returned null' }
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        return {
          ok: true,
          version: gl.getParameter(gl.VERSION),
          shading: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          vendor: gl.getParameter(gl.VENDOR),
          renderer: gl.getParameter(gl.RENDERER),
          unmaskedVendor: dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
          unmaskedRenderer: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        }
      })
      console.log(`[webgl] ${JSON.stringify(info)}`)
    } catch (e) {
      console.log(`[webgl] probe failed: ${e.message}`)
    }

    const png = OUT.endsWith('.png') ? OUT : OUT.replace(/\.[^.]+$/, '.png')

    // Take a series of screenshots to see how the page evolves as deck.gl
    // initializes. Each one is wrapped in a 5s timeout to detect hangs.
    for (const t of [0, 1, 3, SECS]) {
      if (t > 0) await new Promise(r => setTimeout(r, (t - (t > 1 ? t - 1 : 0)) * 1000))
      const file = png.replace(/\.png$/, `-${t}s.png`)
      console.log(`screenshot at t=${t}s → ${file}`)
      try {
        await Promise.race([
          page.screenshot({ path: file }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('screenshot timed out after 10s')), 10_000)),
        ])
        console.log(`  ok`)
      } catch (e) {
        console.log(`  FAIL: ${e.message}`)
      }
    }
  } else {
    console.log('attaching recorder')
    const recorder = await capture(page, { fps: FPS })

    console.log(`navigating to ${URL}`)
    await page.goto(URL, { waitUntil: 'load', timeout: 30_000 })
    console.log('navigation complete; settling for 3s')
    await new Promise(r => setTimeout(r, 3000))

    console.log(`starting recorder → ${OUT}`)
    await recorder.start(OUT)
    console.log(`recording ${SECS}s of virtual time`)
    await recorder.waitForTimeout(SECS * 1000)
    console.log('stopping recorder')
    await recorder.stop()
    console.log('detaching')
    await recorder.detach()
    console.log(`Wrote ${OUT}`)
  }
} finally {
  await browser.close()
}
