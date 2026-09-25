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
import { abbr } from '../content'

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

function tree(c: CardContent): unknown {
  const paid = c.paid != null ? abbr(c.paid) : '—'
  const countLine = c.count != null ? `${c.count.toLocaleString()} ${c.countNoun}` : ''

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
        h('div', { style: { display: 'flex', fontSize: 34, color: COL.muted, marginLeft: 20, marginBottom: 18 } }, `paid · ${c.year}`),
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

export async function renderCard(c: CardContent): Promise<Uint8Array> {
  await ensureWasm()
  const svg = await satori(tree(c) as never, {
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
