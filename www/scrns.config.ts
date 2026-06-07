const defaultView = '?v=40.7309-74.0630+12.3+52-28'
const westView = '?v=40.7192-74.0411+12.5+57+106'
const wardView = '?v=40.7085-74.0300+11.8+54+100'
const unitView = '?v=40.7188-74.0563+13.6+66-34&agg=unit&mh=1100&pct=99&sp=br&so=0&sel=11604-1'
// OGI captures suppress the on-screen title (overlap with og:title / og:description).
const noTitle = '&ti=0'

// Hold-then-transition schedule for year-cycling captures.
// Per "year cycle": `hold` frames at the integer year (so the year reads
// cleanly) then `trans` frames smoothly ramping to the next.
// Total frames = N_years * hold + (N_years - 1) * trans.
// Returns a single-line JS string suitable as scrns `animate.eval`.
function holdEval(fromY: number, toY: number, hold: number, trans: number): string {
  return `(i, n) => { const f=${fromY}, t=${toY}, h=${hold}, r=${trans}; let p=i; for (let y=0; y<=t-f; y++) { if (p<h) return window.__setYear(f+y); p-=h; if (p<r) return window.__setYear(f+y+p/r); p-=r; } return window.__setYear(t); }`
}
function holdFrames(fromY: number, toY: number, hold: number, trans: number): number {
  return (toY - fromY + 1) * hold + (toY - fromY) * trans
}

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
    // Two pacing variants — keep both around to compare what feels best.
    // "half": 0.5s pause + 0.5s ramp per year (most readable year marks).
    // "snappy": 0.3s pause + 0.7s ramp (briefer marks, smoother roll).
    'anim-frac-v11-half': {
      // Title-on (no `&ti=0`): the rolling odometer + subtitle is the point.
      query: `${defaultView}&agg=lot&animYr=2015-2025`,
      width: 1200,
      height: 630,
      headless: false,
      preScreenshotSleep: 12000, // 11 years of geojson preload, cold start
      fps: 30,
      videoCrf: 20,
      path: 'anim-frac-v11-half.mp4',
      actions: [
        { type: 'animate', frames: holdFrames(2015, 2025, 15, 15), eval: holdEval(2015, 2025, 15, 15) },
      ],
    },
    'anim-frac-v11-snappy': {
      query: `${defaultView}&agg=lot&animYr=2015-2025`,
      width: 1200,
      height: 630,
      headless: false,
      preScreenshotSleep: 12000,
      fps: 30,
      videoCrf: 20,
      path: 'anim-frac-v11-snappy.mp4',
      actions: [
        { type: 'animate', frames: holdFrames(2015, 2025, 9, 21), eval: holdEval(2015, 2025, 9, 21) },
      ],
    },
    'anim-frac-v11-ward': {
      // Wards view with block-level geometry; same hold/transition schedule
      // as `v10-half` so visual pacing matches across lot↔ward comparisons.
      query: `${wardView}&agg=ward&wg=blocks&animYr=2015-2025`,
      width: 1200,
      height: 630,
      headless: false,
      preScreenshotSleep: 14000, // ward fixture + 11-year preload
      fps: 30,
      videoCrf: 20,
      path: 'anim-frac-v11-ward.mp4',
      actions: [
        { type: 'animate', frames: holdFrames(2015, 2025, 15, 15), eval: holdEval(2015, 2025, 15, 15) },
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
