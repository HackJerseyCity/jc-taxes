const defaultView = '?v=40.7309-74.0630+12.3+52-28'
const westView = '?v=40.7192-74.0411+12.5+57+106'
const wardView = '?v=40.7310-74.0471+11.8+57-2'
const unitView = '?v=40.7188-74.0563+13.6+66-34&agg=unit&mh=1100&pct=99&sp=br&so=0&sel=11604-1'

export default {
  engine: 'puppeteer' as const,
  host: 3201,
  output: 'public',
  selector: '[data-loaded]',
  browserArgs: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  screenshots: {
    'og-lot': {
      query: `${defaultView}&agg=lot&sel=14507-1`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-lot.png',
    },
    'og-block': {
      query: `${defaultView}&agg=block&sel=14507`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-block.png',
    },
    'og-west-lot': {
      query: `${westView}&agg=lot&sel=14507-1`,
      width: 800,
      height: 800,
      preScreenshotSleep: 6000,
      path: 'og-west-lot.png',
    },
    'og-west-block': {
      query: `${westView}&agg=block&sel=14507`,
      width: 800,
      height: 800,
      preScreenshotSleep: 6000,
      path: 'og-west-block.png',
    },
    'og-ward': {
      query: `${wardView}&agg=ward&sel=ward-E&wg=blocks`,
      width: 1200,
      height: 630,
      preScreenshotSleep: 10000,
      path: 'og-ward.png',
    },
    'og-unit': {
      query: unitView,
      width: 1200,
      height: 630,
      preScreenshotSleep: 6000,
      path: 'og-unit.png',
    },
    cast: {
      query: '?v=40.7190-74.0440+12.0+52-28&agg=lot',
      width: 800,
      height: 500,
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
