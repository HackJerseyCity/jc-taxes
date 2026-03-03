import { useAction } from 'use-kbd'
import { LinearInterpolator } from '@deck.gl/core'
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'

const AVAILABLE_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]

export type ViewState = {
  latitude: number
  longitude: number
  zoom: number
  pitch: number
  bearing: number
  transitionDuration?: number
  transitionInterpolator?: object
}

const WARD_GEOMS = ['merged', 'blocks', 'lots', 'boundary'] as const

// Zoom-dependent pan step: constant screen distance across zoom levels
const panStep = (zoom: number) => 0.01 * Math.pow(2, 12 - zoom)

const interpolators: Record<string, LinearInterpolator> = {}
const transition = (props: string[]) => {
  const key = props.join(',')
  interpolators[key] ??= new LinearInterpolator(props)
  return { transitionDuration: 60, transitionInterpolator: interpolators[key] }
}

// Continuous movement speeds (for press-and-hold)
// Override via URL params (e.g. ?panSpeed=8&rotateSpeed=15) for screencasts
const params = new URLSearchParams(window.location.search)
const PAN_SPEED = Number(params.get('panSpeed')) || 16
const ZOOM_SPEED = Number(params.get('zoomSpeed')) || 2.0
const ROTATE_SPEED = Number(params.get('rotateSpeed')) || 60
const PITCH_SPEED = Number(params.get('pitchSpeed')) || 60

const MOVEMENT_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '-', '=', 'Shift'])

type Props = {
  year: number
  setYear: (y: number) => void
  aggregateMode: string
  setAggregateMode: (m: string) => void
  hasPopulation: boolean
  metricMode: string
  setMetricMode: (m: string) => void
  settingsOpen: boolean
  setSettingsOpen: (v: boolean | ((v: boolean) => boolean)) => void
  setViewState: Dispatch<SetStateAction<ViewState>>
  maxHeight: number
  setMaxHeightRaw: (v: number | undefined) => void
  modeMaxHeight: number
  toggleTheme: () => void
  wardLabels: boolean
  setWardLabels: (v: boolean) => void
  wardGeom: string
  setWardGeom: (v: string) => void
  colorByYrBuilt: boolean
  switchColorBy: (cb: string) => void
}

export function useKeyboardShortcuts({
  year,
  setYear,
  aggregateMode,
  setAggregateMode,
  hasPopulation,
  metricMode,
  setMetricMode,
  settingsOpen,
  setSettingsOpen,
  setViewState,
  maxHeight,
  setMaxHeightRaw,
  modeMaxHeight,
  toggleTheme,
  wardLabels,
  setWardLabels,
  wardGeom,
  setWardGeom,
  colorByYrBuilt,
  switchColorBy,
}: Props) {
  const isWardMode = aggregateMode === 'ward'
  const isLotOrUnit = aggregateMode === 'lot' || aggregateMode === 'unit'
  const yearIdx = AVAILABLE_YEARS.indexOf(year)

  // Continuous movement for press-and-hold
  const activeMovements = useRef(new Set<string>())
  const rafRef = useRef(0)
  const lastTimeRef = useRef(0)

  const rafTick = useCallback((time: number) => {
    if (activeMovements.current.size === 0) {
      rafRef.current = 0
      lastTimeRef.current = 0
      return
    }
    const dt = lastTimeRef.current ? Math.min((time - lastTimeRef.current) / 1000, 0.05) : 1 / 60
    lastTimeRef.current = time
    if (dt > 0) {
      setViewState(v => {
        let { latitude, longitude, zoom, pitch, bearing } = v
        const p = panStep(zoom) * PAN_SPEED * dt
        const bearingRad = bearing * Math.PI / 180
        const cosB = Math.cos(bearingRad)
        const sinB = Math.sin(bearingRad)
        if (activeMovements.current.has('pan-left'))  { longitude -= p * cosB; latitude += p * sinB }
        if (activeMovements.current.has('pan-right')) { longitude += p * cosB; latitude -= p * sinB }
        if (activeMovements.current.has('pan-up'))    { longitude += p * sinB; latitude += p * cosB }
        if (activeMovements.current.has('pan-down'))  { longitude -= p * sinB; latitude -= p * cosB }
        if (activeMovements.current.has('zoom-in')) zoom = Math.min(24, zoom + ZOOM_SPEED * dt)
        if (activeMovements.current.has('zoom-out')) zoom = Math.max(0, zoom - ZOOM_SPEED * dt)
        if (activeMovements.current.has('pitch-up')) pitch = Math.min(85, pitch + PITCH_SPEED * dt)
        if (activeMovements.current.has('pitch-down')) pitch = Math.max(0, pitch - PITCH_SPEED * dt)
        if (activeMovements.current.has('rotate-cw')) bearing += ROTATE_SPEED * dt
        if (activeMovements.current.has('rotate-ccw')) bearing -= ROTATE_SPEED * dt
        return { latitude, longitude, zoom, pitch, bearing }
      })
    }
    rafRef.current = requestAnimationFrame(rafTick)
  }, [setViewState])

  const startMovement = useCallback((direction: string) => {
    activeMovements.current.add(direction)
    if (!rafRef.current) {
      lastTimeRef.current = 0
      rafRef.current = requestAnimationFrame(rafTick)
    }
  }, [rafTick])

  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent) => {
      if (MOVEMENT_KEYS.has(e.key)) {
        activeMovements.current.clear()
      }
    }
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Year navigation: [ and ] to avoid arrow-key conflict with viewport panning
  useAction('year-a', {
    label: 'Previous / Next year a',
    group: 'Navigation',
    defaultBindings: ['['],
    enabled: yearIdx > 0,
    handler: () => { if (yearIdx > 0) setYear(AVAILABLE_YEARS[yearIdx - 1]) },
    actionPair: { pairId: 'year', index: 0 },
  })
  useAction('year-b', {
    label: 'Previous / Next year b',
    group: 'Navigation',
    defaultBindings: [']'],
    enabled: yearIdx < AVAILABLE_YEARS.length - 1,
    handler: () => { if (yearIdx < AVAILABLE_YEARS.length - 1) setYear(AVAILABLE_YEARS[yearIdx + 1]) },
    actionPair: { pairId: 'year', index: 1 },
  })

  useAction('view:agg-a', {
    label: 'Block / Lot / Unit view a',
    group: 'Navigation',
    defaultBindings: ['b'],
    handler: () => setAggregateMode('block'),
    actionTriplet: { tripletId: 'view:agg', index: 0 },
  })
  useAction('view:agg-b', {
    label: 'Block / Lot / Unit view b',
    group: 'Navigation',
    defaultBindings: ['l'],
    handler: () => setAggregateMode('lot'),
    actionTriplet: { tripletId: 'view:agg', index: 1 },
  })
  useAction('view:agg-c', {
    label: 'Block / Lot / Unit view c',
    group: 'Navigation',
    defaultBindings: ['u'],
    handler: () => setAggregateMode('unit'),
    actionTriplet: { tripletId: 'view:agg', index: 2 },
  })

  useAction('theme:toggle', {
    label: 'Toggle theme',
    group: 'UI',
    defaultBindings: ['t'],
    handler: toggleTheme,
  })

  useAction('settings:toggle', {
    label: 'Toggle settings panel',
    group: 'UI',
    defaultBindings: ['s'],
    handler: () => setSettingsOpen((v: boolean) => !v),
  })

  useAction('view:flat', {
    label: 'Flat view (pitch 0)',
    group: 'UI',
    defaultBindings: ['f'],
    handler: () => setViewState(v => ({ ...v, pitch: 0, ...transition(['pitch']) })),
  })

  useAction('view:census-blocks', {
    label: 'Census block view',
    group: 'Navigation',
    defaultBindings: ['c'],
    handler: () => setAggregateMode('census-block'),
  })

  useAction('view:wards', {
    label: 'Ward view',
    group: 'Navigation',
    defaultBindings: ['w'],
    handler: () => setAggregateMode('ward'),
  })

  useAction('metric:toggle', {
    label: 'Toggle metric ($/sqft ↔ $/capita)',
    group: 'Navigation',
    defaultBindings: ['m'],
    enabled: hasPopulation,
    handler: () => setMetricMode(metricMode === 'per_sqft' ? 'per_capita' : 'per_sqft'),
  })

  useAction('view:3d', {
    label: '3D view (pitch 45)',
    group: 'UI',
    defaultBindings: ['d'],
    handler: () => setViewState(v => ({ ...v, pitch: 45, ...transition(['pitch']) })),
  })

  useAction('view:bearing', {
    label: 'Set bearing (degrees)',
    group: 'Viewport',
    defaultBindings: ['n', 'n \\f', '\\f n'],
    handler: (_e, captures) => {
      const deg = captures?.[0] ?? 0
      setViewState(v => ({ ...v, bearing: deg, ...transition(['bearing']) }))
    },
  })

  // Pitch: p N or N p → set absolute pitch; shift+up/down to nudge
  useAction('view:pitch', {
    label: 'Set pitch (degrees)',
    group: 'Viewport',
    defaultBindings: ['p \\d+', '\\d+ p'],
    handler: (_e, captures) => {
      const deg = Math.min(85, Math.max(0, captures?.[0] ?? 45))
      setViewState(v => ({ ...v, pitch: deg, ...transition(['pitch']) }))
    },
  })

  useAction('view:pitch-nudge-a', {
    label: 'Increase / Decrease pitch a',
    group: 'Viewport',
    defaultBindings: ['shift+arrowdown', '\\f shift+arrowdown'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const deg = captures?.[0]
      if (deg) {
        setViewState(v => ({ ...v, pitch: Math.min(85, v.pitch + deg) }))
      } else {
        startMovement('pitch-up')
      }
    },
    actionPair: { pairId: 'view:pitch-nudge', index: 0 },
  })
  useAction('view:pitch-nudge-b', {
    label: 'Increase / Decrease pitch b',
    group: 'Viewport',
    defaultBindings: ['shift+arrowup', '\\f shift+arrowup'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const deg = captures?.[0]
      if (deg) {
        setViewState(v => ({ ...v, pitch: Math.max(0, v.pitch - deg) }))
      } else {
        startMovement('pitch-down')
      }
    },
    actionPair: { pairId: 'view:pitch-nudge', index: 1 },
  })

  // Rotate: shift+left/right
  useAction('view:rotate-a', {
    label: 'Rotate CW / CCW a',
    group: 'Viewport',
    defaultBindings: ['shift+arrowleft', '\\f shift+arrowleft'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const deg = captures?.[0]
      if (deg) {
        setViewState(v => ({ ...v, bearing: v.bearing + deg }))
      } else {
        startMovement('rotate-cw')
      }
    },
    actionPair: { pairId: 'view:rotate', index: 0 },
  })
  useAction('view:rotate-b', {
    label: 'Rotate CW / CCW b',
    group: 'Viewport',
    defaultBindings: ['shift+arrowright', '\\f shift+arrowright'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const deg = captures?.[0]
      if (deg) {
        setViewState(v => ({ ...v, bearing: v.bearing - deg }))
      } else {
        startMovement('rotate-ccw')
      }
    },
    actionPair: { pairId: 'view:rotate', index: 1 },
  })

  // Pan: arrow keys (or N arrow for N discrete steps)
  useAction('view:pan-h-a', {
    label: 'Pan left / right a',
    group: 'Viewport',
    defaultBindings: ['arrowleft', '\\d+ arrowleft'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const n = captures?.[0]
      if (n) {
        setViewState(v => {
          const step = panStep(v.zoom) * n
          const rad = v.bearing * Math.PI / 180
          return { ...v, longitude: v.longitude - step * Math.cos(rad), latitude: v.latitude + step * Math.sin(rad) }
        })
      } else {
        startMovement('pan-left')
      }
    },
    actionPair: { pairId: 'view:pan-h', index: 0 },
  })
  useAction('view:pan-h-b', {
    label: 'Pan left / right b',
    group: 'Viewport',
    defaultBindings: ['arrowright', '\\d+ arrowright'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const n = captures?.[0]
      if (n) {
        setViewState(v => {
          const step = panStep(v.zoom) * n
          const rad = v.bearing * Math.PI / 180
          return { ...v, longitude: v.longitude + step * Math.cos(rad), latitude: v.latitude - step * Math.sin(rad) }
        })
      } else {
        startMovement('pan-right')
      }
    },
    actionPair: { pairId: 'view:pan-h', index: 1 },
  })

  useAction('view:pan-v-a', {
    label: 'Pan up / down a',
    group: 'Viewport',
    defaultBindings: ['arrowup', '\\d+ arrowup'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const n = captures?.[0]
      if (n) {
        setViewState(v => {
          const step = panStep(v.zoom) * n
          const rad = v.bearing * Math.PI / 180
          return { ...v, longitude: v.longitude + step * Math.sin(rad), latitude: v.latitude + step * Math.cos(rad) }
        })
      } else {
        startMovement('pan-up')
      }
    },
    actionPair: { pairId: 'view:pan-v', index: 0 },
  })
  useAction('view:pan-v-b', {
    label: 'Pan up / down b',
    group: 'Viewport',
    defaultBindings: ['arrowdown', '\\d+ arrowdown'],
    handler: (e, captures) => {
      if (e?.repeat) return
      const n = captures?.[0]
      if (n) {
        setViewState(v => {
          const step = panStep(v.zoom) * n
          const rad = v.bearing * Math.PI / 180
          return { ...v, longitude: v.longitude - step * Math.sin(rad), latitude: v.latitude - step * Math.cos(rad) }
        })
      } else {
        startMovement('pan-down')
      }
    },
    actionPair: { pairId: 'view:pan-v', index: 1 },
  })

  // Height: h N or N h → set max height to N km (converted to meters)
  useAction('view:height', {
    label: 'Set max height (km)',
    group: 'Viewport',
    defaultBindings: ['h \\f', '\\f h'],
    handler: (_e, captures) => {
      const km = captures?.[0] ?? Math.round(modeMaxHeight / 1000)
      const m = km * 1000
      setMaxHeightRaw(m === modeMaxHeight ? undefined : m)
    },
  })

  // Zoom: = to zoom in, - to zoom out
  useAction('view:zoom-a', {
    label: 'Zoom in / out a',
    group: 'Viewport',
    defaultBindings: ['='],
    handler: (e) => {
      if (e?.repeat) return
      startMovement('zoom-in')
    },
    actionPair: { pairId: 'view:zoom', index: 0 },
  })
  useAction('view:zoom-b', {
    label: 'Zoom in / out b',
    group: 'Viewport',
    defaultBindings: ['-'],
    handler: (e) => {
      if (e?.repeat) return
      startMovement('zoom-out')
    },
    actionPair: { pairId: 'view:zoom', index: 1 },
  })

  useAction('color:yr-built', {
    label: 'Toggle color by year built',
    group: 'UI',
    defaultBindings: ['y'],
    enabled: isLotOrUnit,
    handler: () => switchColorBy(colorByYrBuilt ? 'metric' : 'yr_built'),
  })

  useAction('ward:labels', {
    label: 'Toggle ward labels',
    group: 'Wards',
    defaultBindings: ['shift+l'],
    enabled: isWardMode,
    handler: () => setWardLabels(!wardLabels),
  })

  useAction('ward:geom', {
    label: 'Cycle ward geometry',
    group: 'Wards',
    defaultBindings: ['g'],
    enabled: isWardMode,
    handler: () => {
      const idx = WARD_GEOMS.indexOf(wardGeom as typeof WARD_GEOMS[number])
      setWardGeom(WARD_GEOMS[(idx + 1) % WARD_GEOMS.length])
    },
  })
}
