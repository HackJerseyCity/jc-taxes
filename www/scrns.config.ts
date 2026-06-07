const defaultView = '?v=40.7309-74.0630+12.3+52-28'
const westView = '?v=40.7192-74.0411+12.5+57+106'
const wardView = '?v=40.7085-74.0300+11.8+54+100'
const unitView = '?v=40.7188-74.0563+13.6+66-34&agg=unit&mh=1100&pct=99&sp=br&so=0&sel=11604-1'
// OGI captures suppress the on-screen title (overlap with og:title / og:description).
const noTitle = '&ti=0'

export default {
  engine: 'puppeteer' as const,
  host: 3201,
  output: 'public',
  selector: '[data-loaded]',
  browserArgs: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  screenshots: {
    'og-lot': {
      query: `${defaultView}&agg=lot&sel=14507-1${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-lot.png',
    },
    'og-block': {
      query: `${defaultView}&agg=block&sel=14507${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-block.png',
    },
    'og-west-lot': {
      query: `${westView}&agg=lot&sel=14507-1${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-west-lot.png',
    },
    'og-west-block': {
      query: `${westView}&agg=block&sel=14507${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-west-block.png',
    },
    'og-ward': {
      query: `${wardView}&agg=ward&sel=ward-E&wg=blocks${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 10000,
      path: 'og-ward.png',
    },
    'og-unit': {
      query: `${unitView}${noTitle}`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-unit.png',
    },
    'anim-frac-v8': {
      // Deterministic per-frame capture via `?y` fractional-year interpolation.
      // `?animYr=2018-2025` (no `:dwell`) just preloads all years' data so
      // `window.__setYear(...)` calls hit cache → no spinner, no race with
      // deck.gl tweens. 120 frames / 30 fps = 4s video covering 2018→2025.
      query: `${defaultView}&agg=lot&animYr=2018-2025${noTitle}`,
      width: 1200,
      height: 630,
      headless: false,
      preScreenshotSleep: 8000, // long enough to preload 8 years of geojson cold
      fps: 30,
      videoCrf: 20,
      path: 'anim-frac-v8.mp4',
      actions: [
        { type: 'animate', frames: 120, eval: '(i, n) => window.__setYear(2018 + (i/(n-1)) * 7)' },
      ],
    },
    cast: {
      query: '?v=40.7190-74.0440+12.0+52-28&agg=lot',
      width: 800,
      height: 500,
      headless: false,
      preScreenshotSleep: 6000,
      path: 'cast.gif',
      fps: 30,
      actions: [
        { type: 'wait', duration: 500 },
        { type: 'animate', frames: 75, eval: '(i, n) => window.__setViewState({ bearing: -28 + (i / (n - 1)) * 100 })' },
        { type: 'wait', duration: 250 },
      ],
    },
  },
}
