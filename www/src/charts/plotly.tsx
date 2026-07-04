import type { Layout, Config } from 'plotly.js'

// Lazy-load the basic Plotly bundle (bar + scatter — all these charts need).
// Dynamic import keeps Plotly (~1MB) off the map route; it only downloads when
// an /about chart mounts.
export const loadPlotly = () =>
  import('plotly.js-basic-dist-min') as unknown as Promise<typeof import('plotly.js')>

// Series colors per theme. Mirrors the map's palette so the suite reads as one
// piece. `classes` keys match `group` values in modiv_class_composition.json.
export function chartColors(isDark: boolean) {
  return {
    land:        isDark ? '#f4a261' : '#d97706',
    improvement: isDark ? '#4ecdc4' : '#0a7572',
    jc:          isDark ? '#4ecdc4' : '#0a7572',
    other:       isDark ? '#555'    : '#bbb',
    classes: {
      residential: isDark ? '#4ecdc4' : '#0a7572',
      commercial:  isDark ? '#f4a261' : '#d97706',
      apartment:   isDark ? '#a78bfa' : '#7c3aed',
      industrial:  isDark ? '#fb7185' : '#be123c',
      exempt:      isDark ? '#94a3b8' : '#475569',
      vacant:      isDark ? '#facc15' : '#a16207',
      other:       isDark ? '#666'    : '#999',
    } as Record<string, string>,
  }
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
