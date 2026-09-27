/** Render a 1200×630 stats card as PNG (satori → SVG → resvg-wasm → PNG).
 *
 * v1 composites the stats over a flat themed background. The faithful-map
 * upgrade is Cloudflare Browser Rendering (screenshot the actual deck.gl view),
 * noted in edge/README.md; satori keeps v1 fast + fully in-Worker (no browser).
 */
import satori, { init as initSatori } from 'satori/standalone'
import { Resvg, initWasm } from '@resvg/resvg-wasm'
// Wrangler bundles these: `.wasm` as a WebAssembly module, `.ttf` as an
// ArrayBuffer (see the `Data` rule in wrangler.jsonc).
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm'
// Extracted by `scripts/extract-yoga.mjs` (postinstall); satori's shipped copy is corrupt.
import yogaWasm from '../../generated/yoga.wasm'
import interRegular from '../../assets/Inter-Regular.ttf'
import interBold from '../../assets/Inter-Bold.ttf'
import type { CardContent } from '../content'
import { abbr, counted } from '../content'

const WIDTH = 1200
const HEIGHT = 630

// Workers forbid compiling wasm from bytes at runtime, so both wasm deps must
// be instantiated from wrangler-precompiled `WebAssembly.Module`s. resvg's
// `initWasm` accepts a Module directly. satori's standalone `init` only takes
// bytes (its emscripten glue does `WebAssembly.instantiate(new
// Uint8Array(bin), imports)`), so hand it a sentinel buffer and intercept that
// one `instantiate` call to use the precompiled Yoga module instead.
const SENTINEL = new Uint8Array([0x6a, 0x63, 0x74, 0x2d, 0x79, 0x6f, 0x67, 0x61]) // "jct-yoga"
function isSentinel(src: unknown): boolean {
  if (!(src instanceof Uint8Array) || src.byteLength !== SENTINEL.byteLength) return false
  return SENTINEL.every((b, i) => src[i] === b)
}

let wasmReady: Promise<void> | null = null
function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    const orig = WebAssembly.instantiate
    const patched = ((src: unknown, imports?: WebAssembly.Imports) => {
      if (!isSentinel(src)) return (orig as (...a: unknown[]) => unknown)(src, imports)
      WebAssembly.instantiate = orig
      return orig(yogaWasm, imports).then((instance) => ({ instance, module: yogaWasm }))
    }) as typeof WebAssembly.instantiate
    WebAssembly.instantiate = patched
    initSatori(SENTINEL.slice().buffer)
    wasmReady = initWasm(resvgWasm)
  }
  return wasmReady
}

// Minimal hyperscript for satori (avoids a JSX toolchain). satori reads
// `element.type` and `element.props` just like a compiled JSX node.
function h(type: string, props: Record<string, unknown>, ...children: unknown[]): unknown {
  return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }
}

const COL = {
  bg0: '#0a1020',
  bg1: '#14213d',
  text: '#f5f7fa',
  muted: '#9fb0c8',
  accent: '#4ade80', // green — the "high $/sqft" end of the map ramp
  chip: 'rgba(255,255,255,0.08)',
  border: 'rgba(255,255,255,0.14)',
}

function textCard(c: CardContent): unknown {
  const paid = c.amount != null ? abbr(c.amount) : '—'
  const countLine = c.count != null ? counted(c.count, c.countNoun) : ''

  return h('div', {
    style: {
      width: WIDTH, height: HEIGHT, display: 'flex', flexDirection: 'column',
      justifyContent: 'space-between', padding: '64px 72px',
      background: `linear-gradient(135deg, ${COL.bg0} 0%, ${COL.bg1} 100%)`,
      fontFamily: 'Inter', color: COL.text,
    },
  },
    // Eyebrow
    h('div', { style: { display: 'flex', alignItems: 'center', fontSize: 26, color: COL.muted, letterSpacing: 2 } },
      h('div', { style: { display: 'flex' } }, 'JERSEY CITY · PROPERTY TAXES'),
    ),
    // Middle: scope + measure + big number
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', fontSize: 60, fontWeight: 700, lineHeight: 1.05, maxWidth: 1000 } }, c.scope),
      h('div', { style: { display: 'flex', fontSize: 30, color: COL.muted, marginTop: 14 } }, c.measure),
      h('div', { style: { display: 'flex', alignItems: 'flex-end', marginTop: 30 } },
        h('div', { style: { display: 'flex', fontSize: 132, fontWeight: 700, color: COL.accent, lineHeight: 1 } }, paid),
        h('div', { style: { display: 'flex', fontSize: 34, color: COL.muted, marginLeft: 20, marginBottom: 18 } }, `${c.billed ? 'billed' : 'paid'} · ${c.year}`),
      ),
    ),
    // Footer chips
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      h('div', { style: { display: 'flex', gap: 16 } },
        countLine
          ? h('div', { style: { display: 'flex', padding: '10px 20px', fontSize: 28, background: COL.chip, border: `1px solid ${COL.border}`, borderRadius: 999 } }, countLine)
          : h('div', { style: { display: 'flex' } }, ''),
      ),
      h('div', { style: { display: 'flex', fontSize: 28, color: COL.muted } }, 'jct.rbw.sh'),
    ),
  )
}

// ── Map layouts (b / c / d): a pre-rendered map image (captured offline; see
// edge/README.md) plus the stats, and a sparkline of every year's total. ──

const b64 = (bytes: Uint8Array) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}
const dataUrl = (bytes: Uint8Array, type: string) => `data:${type};base64,${b64(bytes)}`

/** Sparkline as an SVG data URL: every year's amount, the card's year marked. */
function sparkline(c: CardContent, w: number, hgt: number): string | null {
  const pts = c.series.filter(s => s.amount > 0)
  if (pts.length < 2) return null
  const max = Math.max(...pts.map(s => s.amount)), min = 0
  const x = (i: number) => 6 + (i * (w - 12)) / (pts.length - 1)
  const y = (v: number) => hgt - 6 - ((v - min) / (max - min || 1)) * (hgt - 12)
  const line = pts.map((s, i) => `${x(i).toFixed(1)},${y(s.amount).toFixed(1)}`).join(' ')
  const area = `6,${hgt - 6} ${line} ${x(pts.length - 1).toFixed(1)},${hgt - 6}`
  const ci = pts.findIndex(s => s.year === c.year)
  const dot = ci >= 0 ? `<circle cx="${x(ci)}" cy="${y(pts[ci].amount)}" r="7" fill="${COL.accent}" stroke="${COL.bg0}" stroke-width="3"/>` : ''
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}">`
    + `<polygon points="${area}" fill="${COL.accent}" fill-opacity="0.15"/>`
    + `<polyline points="${line}" fill="none" stroke="${COL.accent}" stroke-width="4" stroke-linejoin="round"/>${dot}</svg>`
  return `data:image/svg+xml;base64,${btoa(svg)}`
}

/** "×2.09 since 2015"; omitted when the first year's total is small next to
 *  the card's (mostly new construction, where a ×45 reads as noise). */
const MAX_GROWTH_SHOWN = 5
function growth(c: CardContent): string | null {
  const first = c.series.find(s => s.amount > 0), cur = c.series.find(s => s.year === c.year)
  if (!first || !cur || first.year === cur.year) return null
  const ratio = cur.amount / first.amount
  return ratio > MAX_GROWTH_SHOWN ? null : `×${ratio.toFixed(2)} since ${first.year}`
}

function statsColumn(c: CardContent, width: number, big: number): unknown {
  const amount = c.amount != null ? abbr(c.amount) : '—'
  const spark = sparkline(c, width, 110)
  const g = growth(c)
  return h('div', { style: { display: 'flex', flexDirection: 'column', width, justifyContent: 'space-between', height: '100%' } },
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', fontSize: 20, color: COL.muted, letterSpacing: 2 } }, 'JERSEY CITY · PROPERTY TAXES'),
      h('div', { style: { display: 'flex', fontSize: 44, fontWeight: 700, lineHeight: 1.1, marginTop: 18 } }, c.scope),
      h('div', { style: { display: 'flex', fontSize: 24, color: COL.muted, marginTop: 10 } }, c.measure),
    ),
    h('div', { style: { display: 'flex', flexDirection: 'column' } },
      h('div', { style: { display: 'flex', fontSize: big, fontWeight: 700, color: COL.accent, lineHeight: 1 } }, amount),
      h('div', { style: { display: 'flex', fontSize: 26, color: COL.muted, marginTop: 8 } },
        `${c.billed ? 'billed' : 'paid'} in ${c.year}${c.count != null ? ` · ${counted(c.count, c.countNoun)}` : ''}`),
      spark ? h('img', { src: spark, width, height: 110, style: { marginTop: 22 } }) : h('div', { style: { display: 'flex' } }, ''),
      h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: 22, color: COL.muted, marginTop: 6 } },
        h('div', { style: { display: 'flex' } }, g ?? ''),
        h('div', { style: { display: 'flex' } }, 'jct.rbw.sh'),
      ),
    ),
  )
}

/** b: map left (720×630), stats right. */
function mapLeft(c: CardContent, map: string): unknown {
  return h('div', { style: { width: WIDTH, height: HEIGHT, display: 'flex', background: COL.bg0, fontFamily: 'Inter', color: COL.text } },
    h('img', { src: map, width: 720, height: HEIGHT }),
    h('div', { style: { display: 'flex', padding: '44px 40px', width: 480, height: HEIGHT } }, statsColumn(c, 400, 84)),
  )
}

/** c: full-bleed map, stats over a dark gradient on the left. */
function fullBleed(c: CardContent, map: string): unknown {
  return h('div', { style: { width: WIDTH, height: HEIGHT, display: 'flex', position: 'relative', fontFamily: 'Inter', color: COL.text, background: COL.bg0 } },
    h('img', { src: map, width: WIDTH, height: HEIGHT, style: { position: 'absolute', left: 0, top: 0 } }),
    h('div', { style: { position: 'absolute', left: 0, top: 0, width: 620, height: HEIGHT, display: 'flex', background: 'linear-gradient(90deg, rgba(10,16,32,0.96) 0%, rgba(10,16,32,0.85) 70%, rgba(10,16,32,0) 100%)' } }),
    h('div', { style: { position: 'absolute', left: 0, top: 0, display: 'flex', padding: '44px 48px', height: HEIGHT } }, statsColumn(c, 440, 92)),
  )
}

/** d: big number left, map right. */
function mapRight(c: CardContent, map: string): unknown {
  return h('div', { style: { width: WIDTH, height: HEIGHT, display: 'flex', background: COL.bg0, fontFamily: 'Inter', color: COL.text } },
    h('div', { style: { display: 'flex', padding: '44px 40px', width: 480, height: HEIGHT } }, statsColumn(c, 400, 96)),
    h('img', { src: map, width: 720, height: HEIGHT }),
  )
}

/** Map image size a layout needs (`maps/<key>-WxH.jpg`), or null for text-only. */
export function mapSize(layout: CardContent['layout']): [number, number] | null {
  return layout === 'c' ? [1200, 630] : layout === 'b' || layout === 'd' ? [720, 630] : null
}

function tree(c: CardContent, map: Uint8Array | null): unknown {
  if (!map || c.layout === 'a') return textCard(c)
  const url = dataUrl(map, 'image/jpeg')
  return c.layout === 'b' ? mapLeft(c, url) : c.layout === 'c' ? fullBleed(c, url) : mapRight(c, url)
}

export async function renderCard(c: CardContent, map: Uint8Array | null = null): Promise<Uint8Array> {
  await ensureWasm()
  const svg = await satori(tree(c, map) as never, {
    width: WIDTH,
    height: HEIGHT,
    fonts: [
      { name: 'Inter', data: interRegular as ArrayBuffer, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold as ArrayBuffer, weight: 700, style: 'normal' },
    ],
  })
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: WIDTH },
    font: {
      fontBuffers: [new Uint8Array(interRegular as ArrayBuffer), new Uint8Array(interBold as ArrayBuffer)],
      loadSystemFonts: false,
    },
  })
  return resvg.render().asPng()
}
