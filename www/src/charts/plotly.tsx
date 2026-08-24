import type { Layout, Config } from 'plotly.js'

// Lazy-load the basic Plotly bundle (bar + scatter — all these charts need).
// Dynamic import keeps Plotly (~1MB) off the map route; it only downloads when
// an /about chart mounts.
export const loadPlotly = () =>
  import('plotly.js-basic-dist-min') as unknown as Promise<typeof import('plotly.js')>

// Series colors per theme. Mirrors the map's palette so the suite reads as one
// piece. The levy split (school / municipal / county) is the page's spine, so
// those get the three most distinct hues; `pilot` reuses the amber accent.
export function chartColors(isDark: boolean) {
  return {
    school:      isDark ? '#4ecdc4' : '#0a7572',
    municipal:   isDark ? '#f4a261' : '#d97706',
    county:      isDark ? '#a78bfa' : '#7c3aed',
    pilot:       isDark ? '#f4a261' : '#d97706',
    total:       isDark ? '#e8e8e8' : '#1a1a1a',
    other:       isDark ? '#555'    : '#bbb',
  }
}

// Qualitative palette for the per-development expiration chart — mid-tones that
// stay legible on both the dark and light panel backgrounds. `projectColor`
// maps a project label to a stable color; "Other" is the neutral grey.
const PROJECT_PALETTE = ['#4ecdc4', '#f4a261', '#a78bfa', '#fb7185', '#60a5fa', '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#c084fc']
export function projectColor(label: string, index: number, isDark: boolean): string {
  if (label === 'Other') return isDark ? '#555' : '#c4c4c4'
  return PROJECT_PALETTE[index % PROJECT_PALETTE.length]
}

// Structural layout shared across the /about charts. pltly deep-merges its
// themed layout (font color, gridcolor, transparent bg) per-axis on top of
// this, so we only set structure/formatting here. pltly's theme doesn't cover
// the hover box, so we set `hoverlabel` colors explicitly (else it's a white
// box with light text in dark mode).
export function baseLayout(isDark: boolean): Partial<Layout> {
  return {
    margin: { l: 64, r: 20, t: 8, b: 32 },
    showlegend: true,
    legend: { orientation: 'h', y: 1.1, x: 0, font: { size: 12 } },
    hoverlabel: {
      align: 'left',
      bgcolor: isDark ? '#242424' : '#ffffff',
      bordercolor: isDark ? '#4a4a4a' : '#d0d0d0',
      font: { color: isDark ? '#e8e8e8' : '#1a1a1a', size: 12 },
    },
    bargap: 0.28,
  }
}

export const plotConfig: Partial<Config> = { responsive: true, displayModeBar: false }
