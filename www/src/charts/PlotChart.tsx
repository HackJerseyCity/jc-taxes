import { useEffect, useRef } from 'react'
import * as Plot from '@observablehq/plot'
import { useTheme } from '../ThemeContext'

type Spec = Plot.PlotOptions
type Build = (theme: 'light' | 'dark', width: number) => Spec

/**
 * Renders an Observable Plot spec into a div, re-rendering on theme/width
 * changes. `build` receives the current theme + measured container width
 * so each chart can pick colors + responsive sizing.
 */
export function PlotChart({ build, height = 360, ariaLabel }: {
  build: Build
  height?: number
  ariaLabel?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { actualTheme } = useTheme()

  useEffect(() => {
    const host = ref.current
    if (!host) return
    let cur: (SVGElement | HTMLElement) | null = null
    // Plot's tip fills from `var(--plot-background)`, which Plot sets to white
    // on the generated <svg> via a `:where(.plot-xxx)` rule. Set it inline on the
    // svg itself (inline beats the zero-specificity `:where` rule) so the tip
    // box is dark in dark mode instead of light text on white.
    const tipBg = actualTheme === 'dark' ? '#242424' : '#ffffff'
    const render = () => {
      const w = host.clientWidth || 720
      const spec = build(actualTheme, w)
      const next = Plot.plot({ height, ...spec })
      next.style.setProperty('--plot-background', tipBg)
      next.querySelectorAll('svg').forEach(svg => svg.style.setProperty('--plot-background', tipBg))
      if (next instanceof SVGElement) next.style.setProperty('--plot-background', tipBg)
      if (cur) cur.replaceWith(next)
      else host.appendChild(next)
      cur = next
    }
    render()
    const ro = new ResizeObserver(() => render())
    ro.observe(host)
    return () => { ro.disconnect(); cur?.remove() }
  }, [build, height, actualTheme])

  return <div ref={ref} role="img" aria-label={ariaLabel} style={{ width: '100%' }} />
}

/**
 * A single "unified" hover tooltip: hovering anywhere over an x-value shows one
 * tip listing every series at that x (instead of Plot's default per-mark tip).
 * `wide` is one row per x with a numeric field per series (+ optional total).
 * Series values render as aligned label/value rows; `header` is the bold title.
 */
export function unifiedTip(
  wide: Record<string, unknown>[],
  opts: {
    x: string
    y: string
    series: string[]
    format: (v: number) => string
    header: (d: Record<string, unknown>) => string
    total?: string
  },
) {
  const title = (d: Record<string, unknown>) => {
    const lines = [opts.header(d)]
    for (const s of opts.series) lines.push(`${s}: ${opts.format(d[s] as number)}`)
    if (opts.total) lines.push(`Total: ${opts.format(d[opts.total] as number)}`)
    return lines.join('\n')
  }
  return Plot.tip(
    wide,
    Plot.pointerX({ x: opts.x, y: opts.y, title, fontSize: 12, lineHeight: 1.3 }),
  )
}

// Shared color palettes per theme — each chart picks from these so the suite
// reads as one piece. `cls` keys mirror `class_group` values from the data.
export function palette(theme: 'light' | 'dark') {
  const isDark = theme === 'dark'
  return {
    text:       isDark ? '#e0e0e0' : '#1a1a1a',
    muted:      isDark ? '#888'    : '#666',
    grid:       isDark ? '#333'    : '#e5e5e5',
    accent:     isDark ? '#4ecdc4' : '#0a7572',
    jc:         isDark ? '#4ecdc4' : '#0a7572',
    other:      isDark ? '#555'    : '#bbb',
    land:       isDark ? '#f4a261' : '#d97706',
    improvement:isDark ? '#4ecdc4' : '#0a7572',
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
