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
    const render = () => {
      const w = host.clientWidth || 720
      const spec = build(actualTheme, w)
      const next = Plot.plot({ height, ...spec })
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
