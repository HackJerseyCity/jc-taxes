const defaultView = '?v=40.7309-74.0630+12.3+52-28'
const westView = '?v=40.7192-74.0411+12.5+57+106'
const wardView = '?v=40.7310-74.0471+11.8+57-2'

export default {
  host: 3201,
  output: 'public',
  selector: '#root',
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
