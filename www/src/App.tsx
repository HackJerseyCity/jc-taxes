import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Map } from 'react-map-gl/maplibre'
import DeckGL from '@deck.gl/react'
import { WebMercatorViewport, FlyToInterpolator, LinearInterpolator } from '@deck.gl/core'
import { GeoJsonLayer } from '@deck.gl/layers'
import { useUrlState, intParam, stringParam } from 'use-prms'
import type { Param } from 'use-prms'
import { useHotkeysContext } from 'use-kbd'
import { resolve as dvcResolve } from 'virtual:dvc-data'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useKeyboardShortcuts, type ViewState } from './useKeyboardShortcuts'
import { useTouchPitch } from './useTouchPitch'
import { useParcelSearch } from './useParcelSearch'
import { useTheme } from './ThemeContext'
import GradientEditor, {
  type ScaleType,
  type ColorStop,
  interpolateColor,
} from './GradientEditor'
import type { ParcelProperties, ParcelFeature } from './types'

// Responsive default views: interpolated by viewport width
const VIEW_BREAKPOINTS: { width: number, view: ViewState }[] = [
  { width: 390,  view: { latitude: 40.6960, longitude: -74.0641, zoom: 11.5, pitch: 45, bearing: -16 } }, // phone
  { width: 820,  view: { latitude: 40.7197, longitude: -74.0506, zoom: 12.0, pitch: 45, bearing: 0 } },   // iPad
  { width: 1180, view: { latitude: 40.7153, longitude: -74.0605, zoom: 12.6, pitch: 48, bearing: -16 } }, // iPad Pro landscape
  { width: 1440, view: { latitude: 40.7177, longitude: -74.0695, zoom: 12.8, pitch: 54, bearing: -10 } }, // desktop
]

function getDefaultView(width: number): ViewState {
  if (width <= VIEW_BREAKPOINTS[0].width) return VIEW_BREAKPOINTS[0].view
  if (width >= VIEW_BREAKPOINTS[VIEW_BREAKPOINTS.length - 1].width) return VIEW_BREAKPOINTS[VIEW_BREAKPOINTS.length - 1].view
  for (let i = 0; i < VIEW_BREAKPOINTS.length - 1; i++) {
    const lo = VIEW_BREAKPOINTS[i], hi = VIEW_BREAKPOINTS[i + 1]
    if (width >= lo.width && width <= hi.width) {
      const t = (width - lo.width) / (hi.width - lo.width)
      return {
        latitude: lo.view.latitude + t * (hi.view.latitude - lo.view.latitude),
        longitude: lo.view.longitude + t * (hi.view.longitude - lo.view.longitude),
        zoom: lo.view.zoom + t * (hi.view.zoom - lo.view.zoom),
        pitch: lo.view.pitch + t * (hi.view.pitch - lo.view.pitch),
        bearing: lo.view.bearing + t * (hi.view.bearing - lo.view.bearing),
      }
    }
  }
  return VIEW_BREAKPOINTS[VIEW_BREAKPOINTS.length - 1].view
}

const DEFAULT_VIEW = getDefaultView(window.innerWidth)

function encodeView(v: ViewState): string {
  const parts = [
    v.latitude.toFixed(4),
    v.longitude.toFixed(4),
    v.zoom.toFixed(1),
    String(Math.round(v.pitch)),
    String(Math.round(v.bearing)),
  ]
  let result = parts[0]
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i].startsWith('-')) result += ' '
    result += parts[i]
  }
  return result
}

const viewParam: Param<ViewState> = {
  encode: encodeView,
  decode: (s: string | undefined) => {
    if (!s) return DEFAULT_VIEW
    const matches = s.match(/-?\d+\.?\d*/g)
    if (!matches || matches.length < 5) return DEFAULT_VIEW
    const nums = matches.map(Number)
    if (nums.some(isNaN)) return DEFAULT_VIEW
    return {
      latitude: nums[0],
      longitude: nums[1],
      zoom: nums[2],
      pitch: nums[3],
      bearing: nums[4],
    }
  },
}

const AVAILABLE_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]
const AGGREGATE_MODES = ['block', 'lot', 'unit', 'census-block', 'ward'] as const
type AggregateMode = typeof AGGREGATE_MODES[number]
const SUFFIX_MAP: Record<string, string> = {
  unit: '-units',
  block: '-blocks',
  lot: '-lots',
  'census-block': '-census-blocks',
  ward: '-wards',
}
type MetricMode = 'per_sqft' | 'per_capita'

// Per-mode defaults for color max and max height (meters)
function getModeKey(agg: string, metric: string): string {
  if (agg === 'census-block' || agg === 'ward') return `${agg}:${metric}`
  return agg
}
// Per-mode color stops: values positioned to differentiate actual data distribution
// per_sqft: data skewed near zero → stops at ~1-7% of max
// per_capita: data more spread → stops at ~25-75% of max
type ModeConfig = {
  max: number
  maxHeight: number
  scale?: ScaleType
  stops?: { dark: ColorStop[], light: ColorStop[] }
}
const MODE_DEFAULTS: Record<string, ModeConfig> = {
  'block':                  { max: 300,   maxHeight: 4500 },
  'lot':                    { max: 300,   maxHeight: 4500 },
  'unit':                   { max: 300,   maxHeight: 4500 },
  'census-block:per_sqft':  { max: 20, maxHeight: 2000, stops: {
    dark:  [{ value: 0, color: [96, 96, 96] }, { value: 1.5, color: [255, 0, 0] }, { value: 4, color: [255, 217, 26] }, { value: 12, color: [0, 255, 0] }],
    light: [{ value: 0, color: [255, 255, 255] }, { value: 1.5, color: [255, 71, 71] }, { value: 4, color: [230, 190, 0] }, { value: 12, color: [0, 214, 0] }],
  }},
  'census-block:per_capita':{ max: 15000, maxHeight: 4500, scale: 'sqrt', stops: {
    dark:  [{ value: 0, color: [96, 96, 96] }, { value: 3000, color: [255, 0, 0] }, { value: 5500, color: [255, 217, 26] }, { value: 10000, color: [0, 255, 0] }],
    light: [{ value: 0, color: [255, 255, 255] }, { value: 3000, color: [255, 71, 71] }, { value: 5500, color: [230, 190, 0] }, { value: 10000, color: [0, 214, 0] }],
  }},
  'ward:per_sqft':          { max: 10, maxHeight: 5500, scale: 'linear', stops: {
    dark:  [{ value: 0, color: [96, 96, 96] }, { value: 4.9, color: [255, 0, 0] }, { value: 6.5, color: [255, 217, 26] }, { value: 8.6, color: [0, 255, 0] }],
    light: [{ value: 0, color: [255, 255, 255] }, { value: 4.9, color: [255, 71, 71] }, { value: 6.5, color: [230, 190, 0] }, { value: 8.6, color: [0, 214, 0] }],
  }},
  'ward:per_capita':        { max: 9000, maxHeight: 5400, scale: 'sqrt', stops: {
    dark:  [{ value: 0, color: [96, 96, 96] }, { value: 1273.7, color: [255, 0, 0] }, { value: 3500, color: [255, 217, 26] }, { value: 6834.5, color: [0, 255, 0] }],
    light: [{ value: 0, color: [255, 255, 255] }, { value: 1273.7, color: [255, 71, 71] }, { value: 3500, color: [230, 190, 0] }, { value: 6834.5, color: [0, 214, 0] }],
  }},
}
const SS_PREFIX = 'jc-taxes:'

function ssSave(key: string, field: string, value: string) {
  sessionStorage.setItem(`${SS_PREFIX}${key}:${field}`, value)
}
function ssLoad(key: string, field: string): string | null {
  return sessionStorage.getItem(`${SS_PREFIX}${key}:${field}`)
}

const LOADING_COLOR: [number, number, number, number] = [128, 128, 128, 60]
const HOVER_COLOR: [number, number, number, number] = [255, 255, 100, 220]
const SELECTED_COLOR: [number, number, number, number] = [100, 200, 255, 230]
const SELECTED_HOVER_COLOR: [number, number, number, number] = [160, 230, 255, 240]

const optScaleParam: Param<ScaleType | undefined> = {
  decode: (s: string | undefined) => (s as ScaleType) ?? undefined,
  encode: (v: ScaleType | undefined) => v == null ? undefined as unknown as string : v,
}

const boolParam: Param<boolean> = {
  decode: (s: string | undefined) => s !== '0',
  encode: (v: boolean) => v ? undefined as unknown as string : '0',
}

const optNumParam: Param<number | undefined> = {
  decode: (s: string | undefined) => {
    if (s == null) return undefined
    const n = Number(s)
    return isNaN(n) ? undefined : n
  },
  encode: (v: number | undefined) => v == null ? undefined as unknown as string : String(v),
}

export default function App() {
  const kbdCtx = useHotkeysContext()
  const [data, setData] = useState<ParcelFeature[] | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hovered, setHovered] = useState<ParcelProperties | null>(null)
  const suppressHoverRef = useRef(false)
  const [webglError, setWebglError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useUrlState('sel', stringParam())
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(() => window.innerWidth > 768)

  // URL-persisted state (mh is optional; absent = use mode default)
  const [year, setYear] = useUrlState('y', intParam(2025))
  const [maxHeightRaw, setMaxHeightRaw] = useUrlState('mh', optNumParam)
  const [aggregateMode, setAggregateModeRaw] = useUrlState('agg', stringParam('block'))
  const [colorScaleRaw, setColorScaleRaw] = useUrlState('scale', optScaleParam)
  const [metricMode, setMetricModeRaw] = useUrlState('metric', stringParam('per_sqft'))
  const [wardGeom, setWardGeom] = useUrlState('wg', stringParam('merged'))
  const [wardLabels, setWardLabels] = useUrlState('wl', boolParam)
  const [extruded, setExtruded] = useUrlState('3d', boolParam)

  const hasPopulation = aggregateMode === 'census-block' || aggregateMode === 'ward'
  const modeKey = getModeKey(aggregateMode, metricMode)
  const modeConf = MODE_DEFAULTS[modeKey] ?? MODE_DEFAULTS['block']

  // Derived: maxVal is always the mode default (no longer user-facing)
  const maxVal = modeConf.max
  // Effective max height: URL value if explicitly set, else mode default
  const maxHeight = maxHeightRaw ?? modeConf.maxHeight
  // Height scale: tallest bar = maxHeight. Derived from actual data max.
  const dataMax = useMemo(() => {
    if (!data || data.length === 0) return modeConf.max
    const field = metricMode === 'per_capita' ? 'paid_per_capita' : 'paid_per_sqft'
    let mx = 0
    for (const f of data) mx = Math.max(mx, f.properties?.[field] ?? 0)
    return mx || modeConf.max
  }, [data, metricMode, modeConf.max])
  const heightScale = maxHeight / dataMax
  // Freeze height scale while loading to prevent stale data rendered with new-mode elevation
  const stableHeightScaleRef = useRef(heightScale)
  if (!loading) stableHeightScaleRef.current = heightScale
  // Effective color scale: URL value if explicitly set, else mode default
  const colorScale = colorScaleRaw ?? modeConf.scale ?? 'log'

  // Color stops: use custom (from URL `c`) → mode-specific → theme defaults
  const { actualTheme, toggleTheme, colorStops: themeStops, hasCustomStops, setColorStops, resetColorStops: resetColorStopsRaw } = useTheme()
  const modeStops = useMemo(() => {
    if (modeConf.stops) return actualTheme === 'light' ? modeConf.stops.light : modeConf.stops.dark
    return null
  }, [modeConf, actualTheme])
  const colorStops = hasCustomStops ? themeStops : (modeStops ?? themeStops)

  // Reset: clear custom stops from URL; mode stops or theme defaults will apply
  const resetColorStops = useCallback(() => {
    resetColorStopsRaw()
  }, [resetColorStopsRaw])

  // Mode-aware switching: save customizations to SS, clear URL params for new mode
  const switchToMode = useCallback((newAgg: string, newMetric: string) => {
    const oldKey = getModeKey(aggregateMode, metricMode)
    // Save current customizations to SS (only if user changed from default)
    if (maxHeightRaw != null) ssSave(oldKey, 'mh', String(maxHeight))
    if (colorScaleRaw != null) ssSave(oldKey, 'scale', colorScaleRaw)

    // Reset metric to per_sqft for non-census modes
    const effectiveMetric = (newAgg === 'census-block' || newAgg === 'ward') ? newMetric : 'per_sqft'
    const newKey = getModeKey(newAgg, effectiveMetric)

    // Restore from SS if user previously customized this mode, else clear (use defaults)
    const savedMh = ssLoad(newKey, 'mh')
    setMaxHeightRaw(savedMh ? Number(savedMh) : undefined)
    const savedScale = ssLoad(newKey, 'scale')
    setColorScaleRaw((savedScale as ScaleType) ?? undefined)

    // Clear custom color stops; mode stops or theme defaults will apply
    if (hasCustomStops) resetColorStopsRaw()
  }, [aggregateMode, metricMode, maxHeight, maxHeightRaw, colorScaleRaw, hasCustomStops, resetColorStopsRaw])

  const setAggregateMode = useCallback((newAgg: string) => {
    if (newAgg === aggregateMode) return
    setLoading(true)
    const newMetric = (newAgg === 'census-block' || newAgg === 'ward') ? metricMode : 'per_sqft'
    switchToMode(newAgg, newMetric)
    setAggregateModeRaw(newAgg)
    if (!(newAgg === 'census-block' || newAgg === 'ward') && metricMode === 'per_capita') {
      setMetricModeRaw('per_sqft')
    }
  }, [aggregateMode, switchToMode, metricMode])

  const setMetricMode = useCallback((newMetric: string) => {
    switchToMode(aggregateMode, newMetric)
    setMetricModeRaw(newMetric)
  }, [switchToMode, aggregateMode])

  // URL is source of truth for initial load; local state for smooth rendering
  const [urlView, setUrlView] = useUrlState('v', viewParam)
  const [viewState, setViewState] = useState<ViewState>(urlView)
  // Expose setViewState for external tools (e.g. scrns screencast automation)
  useEffect(() => {
    (window as any).__setViewState = (partial: Partial<ViewState>) => {
      setViewState(v => ({ ...v, ...partial }))
    }
    return () => { delete (window as any).__setViewState }
  }, [])
  // Debounce URL writes whenever viewState changes (from any source).
  // Skip while omnibar is open: the synthetic popstate from replaceState
  // races with use-kbd's history pushState and can close the omnibar.
  const setUrlViewRef = useRef(setUrlView)
  setUrlViewRef.current = setUrlView
  const omnibarOpenRef = useRef(false)
  omnibarOpenRef.current = !!kbdCtx?.isOmnibarOpen
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!omnibarOpenRef.current) setUrlViewRef.current(viewState)
    }, 300)
    return () => clearTimeout(timer)
  }, [viewState])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    year, setYear,
    aggregateMode, setAggregateMode,
    hasPopulation, metricMode, setMetricMode,
    settingsOpen, setSettingsOpen,
    setViewState,
    maxHeight, setMaxHeightRaw,
    modeMaxHeight: modeConf.maxHeight,
    toggleTheme,
    wardLabels, setWardLabels,
    wardGeom, setWardGeom,
  })

  // Two-finger pitch gesture for mobile (deck.gl's built-in multipan is broken)
  const isPitchingRef = useTouchPitch({ setViewState, maxPitch: 85 })

  // Omnibar search over parcels
  const onParcelSelect = useCallback((f: ParcelFeature) => {
    setSelectedId(getFeatureId(f))
    // Pan to the selected parcel
    if (f.geometry) {
      const coords = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]
      const lngs = coords.map(c => c[0])
      const lats = coords.map(c => c[1])
      const centerLng = (Math.min(...lngs) + Math.max(...lngs)) / 2
      const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2
      setViewState(v => ({
        ...v,
        longitude: centerLng,
        latitude: centerLat,
        zoom: Math.max(v.zoom, 15),
        transitionDuration: 500,
        transitionInterpolator: new FlyToInterpolator(),
      }))
    }
  }, [])
  useParcelSearch({ data, onSelect: onParcelSelect })

  useEffect(() => {
    setLoading(true)
    const suffix = SUFFIX_MAP[aggregateMode] ?? '-lots'
    fetch(dvcResolve(`taxes-${year}${suffix}.geojson`))
      .then((r) => r.json())
      .then((geojson) => {
        setData(geojson.features)
        setLoading(false)
      })
      .catch((e) => {
        console.error('Failed to load parcels:', e)
        setLoading(false)
      })
  }, [year, aggregateMode])

  // For ward mode: swap geometry based on wardGeom setting
  const effectiveData = useMemo(() => {
    if (!data || aggregateMode !== 'ward' || wardGeom === 'merged') return data
    const prop = wardGeom === 'lots' ? 'lots' : wardGeom === 'blocks' ? 'blocks' : wardGeom === 'boundary' ? 'boundary' : null
    if (!prop) return data
    return data.map(f => {
      const alt = f.properties?.[prop as keyof typeof f.properties]
      if (!alt) return f
      return { ...f, geometry: alt as ParcelFeature['geometry'] }
    })
  }, [data, aggregateMode, wardGeom])

  // Ward label info: stable text/metadata (doesn't depend on viewState)
  type WardLabelInfo = { ward: string; text: string; metricVal: number; rings: number[][][] }
  const wardLabelInfo = useMemo((): WardLabelInfo[] => {
    if (!data || aggregateMode !== 'ward' || !wardLabels) return []
    return data.map(f => {
      const p = f.properties
      if (!p?.ward) return null
      const metricVal = metricMode === 'per_capita' ? (p.paid_per_capita ?? 0) : (p.paid_per_sqft ?? 0)
      const rings = f.geometry.type === 'Polygon' ? [f.geometry.coordinates[0]] : f.geometry.coordinates.map(p => p[0])
      const lines = [`Ward ${p.ward}`]
      if (p.population) lines.push(`Pop: ${p.population.toLocaleString()}`)
      if (p.paid) lines.push(`Paid: $${(p.paid / 1e6).toFixed(1)}M`)
      if (p.paid_per_sqft) lines.push(`$${p.paid_per_sqft.toFixed(2)}/sqft`)
      if (p.paid_per_capita) lines.push(`$${p.paid_per_capita.toLocaleString()}/capita`)
      return { ward: p.ward, text: lines.join('\n'), metricVal, rings }
    }).filter((x): x is WardLabelInfo => x !== null)
  }, [data, aggregateMode, wardLabels, metricMode])

  // Screen-space label positions via offscreen rasterization.
  // Projects each ward's extruded 3D geometry (top face, base face, side quads)
  // to screen space, rasterizes with unique colors per ward using painter's algorithm
  // (depth-sorted back-to-front for occlusion), then reads back pixels to find
  // each ward's visible-pixel centroid.
  type WardScreenLabel = { x: number; y: number; text: string; ward: string }
  const wardScreenLabels = useMemo((): WardScreenLabel[] => {
    if (wardLabelInfo.length === 0) return []
    const viewport = new WebMercatorViewport({
      width: window.innerWidth,
      height: window.innerHeight,
      ...viewState,
    })
    const SCALE = 4
    const W = Math.ceil(window.innerWidth / SCALE)
    const H = Math.ceil(window.innerHeight / SCALE)

    // Build depth-sorted faces for painter's algorithm
    type Face = { wardIdx: number; pts: [number, number][]; depth: number }
    const faces: Face[] = []

    for (let wi = 0; wi < wardLabelInfo.length; wi++) {
      const { metricVal, rings } = wardLabelInfo[wi]
      const elev = metricVal * heightScale

      for (const ring of rings) {
        const n = ring.length
        if (n < 3) continue

        // Project all vertices at ground and top elevation
        const base: { x: number; y: number; z: number }[] = []
        const top: { x: number; y: number; z: number }[] = []
        let valid = true
        for (const [lng, lat] of ring) {
          const pb = viewport.project([lng, lat, 0])
          const pt = viewport.project([lng, lat, elev])
          if (!isFinite(pb[0]) || !isFinite(pt[0])) { valid = false; break }
          base.push({ x: pb[0] / SCALE, y: pb[1] / SCALE, z: pb[2] ?? 0 })
          top.push({ x: pt[0] / SCALE, y: pt[1] / SCALE, z: pt[2] ?? 0 })
        }
        if (!valid) continue

        // Top face
        faces.push({
          wardIdx: wi,
          pts: top.map(p => [p.x, p.y] as [number, number]),
          depth: top.reduce((s, p) => s + p.z, 0) / n,
        })
        // Base face
        faces.push({
          wardIdx: wi,
          pts: base.map(p => [p.x, p.y] as [number, number]),
          depth: base.reduce((s, p) => s + p.z, 0) / n,
        })
        // Side quads
        for (let i = 0; i < n - 1; i++) {
          faces.push({
            wardIdx: wi,
            pts: [
              [base[i].x, base[i].y],
              [base[i + 1].x, base[i + 1].y],
              [top[i + 1].x, top[i + 1].y],
              [top[i].x, top[i].y],
            ],
            depth: (base[i].z + base[i + 1].z + top[i + 1].z + top[i].z) / 4,
          })
        }
      }
    }

    // Painter's algorithm: draw further faces first (larger depth)
    faces.sort((a, b) => b.depth - a.depth)

    // Rasterize to offscreen canvas with unique color per ward
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, W, H)

    for (const face of faces) {
      ctx.fillStyle = `rgb(${face.wardIdx + 1},0,0)`
      ctx.beginPath()
      ctx.moveTo(face.pts[0][0], face.pts[0][1])
      for (let i = 1; i < face.pts.length; i++) {
        ctx.lineTo(face.pts[i][0], face.pts[i][1])
      }
      ctx.closePath()
      ctx.fill()
    }

    // Read back pixels into a ward-index grid
    const imgData = ctx.getImageData(0, 0, W, H)
    const pixels = imgData.data
    const grid = new Int8Array(W * H).fill(-1)
    for (let i = 0; i < W * H; i++) {
      const r = pixels[i * 4]
      if (r >= 1 && r <= wardLabelInfo.length) grid[i] = r - 1
    }

    // Connected component analysis: BFS to find largest cluster per ward
    const visited = new Uint8Array(W * H)
    type Cluster = { sx: number; sy: number; n: number }
    const bestCluster: (Cluster | null)[] = wardLabelInfo.map(() => null)
    const DIRS = [1, -1, W, -W]

    for (let i = 0; i < W * H; i++) {
      if (grid[i] < 0 || visited[i]) continue
      const wi = grid[i]
      let sx = 0, sy = 0, n = 0
      const queue = [i]
      visited[i] = 1
      let head = 0
      while (head < queue.length) {
        const cur = queue[head++]
        const row = (cur / W) | 0, col = cur % W
        sx += col * SCALE
        sy += row * SCALE
        n++
        for (const d of DIRS) {
          const ni = cur + d
          // Bounds check: skip if wrapping row or out of range
          if (ni < 0 || ni >= W * H || visited[ni] || grid[ni] !== wi) continue
          if (Math.abs(d) === 1 && ((cur / W) | 0) !== ((ni / W) | 0)) continue
          visited[ni] = 1
          queue.push(ni)
        }
      }
      const prev = bestCluster[wi]
      if (!prev || n > prev.n) bestCluster[wi] = { sx, sy, n }
    }

    // Initial label positions from largest cluster centroids
    const labels: WardScreenLabel[] = []
    for (let wi = 0; wi < wardLabelInfo.length; wi++) {
      const c = bestCluster[wi]
      if (!c || c.n === 0) continue
      labels.push({
        x: c.sx / c.n,
        y: c.sy / c.n,
        text: wardLabelInfo[wi].text,
        ward: wardLabelInfo[wi].ward,
      })
    }

    // Collision avoidance: iteratively push overlapping labels apart
    const labelW = (text: string) => {
      const lines = text.split('\n')
      return Math.max(...lines.map(l => l.length)) * 8.5 + 16
    }
    const labelH = (text: string) => text.split('\n').length * 17 + 8
    const VW = window.innerWidth, VH = window.innerHeight
    const PAD = 8

    // Center of mass for outward bias when labels coincide
    const comX = labels.length > 0 ? labels.reduce((s, l) => s + l.x, 0) / labels.length : 0
    const comY = labels.length > 0 ? labels.reduce((s, l) => s + l.y, 0) / labels.length : 0

    for (let iter = 0; iter < 50; iter++) {
      let maxOverlap = 0
      for (let i = 0; i < labels.length; i++) {
        const wi = labelW(labels[i].text), hi = labelH(labels[i].text)
        for (let j = i + 1; j < labels.length; j++) {
          const wj = labelW(labels[j].text), hj = labelH(labels[j].text)
          const overlapX = (wi + wj) / 2 + PAD - Math.abs(labels[i].x - labels[j].x)
          const overlapY = (hi + hj) / 2 + PAD - Math.abs(labels[i].y - labels[j].y)
          if (overlapX <= 0 || overlapY <= 0) continue
          maxOverlap = Math.max(maxOverlap, Math.min(overlapX, overlapY))

          // Push apart along smaller overlap axis (resolves fastest)
          if (overlapX < overlapY) {
            const sign = labels[i].x <= labels[j].x ? -1 : 1
            labels[i].x += sign * overlapX * 0.55
            labels[j].x -= sign * overlapX * 0.55
          } else {
            const sign = labels[i].y <= labels[j].y ? -1 : 1
            labels[i].y += sign * overlapY * 0.55
            labels[j].y -= sign * overlapY * 0.55
          }
        }
      }

      // Clamp labels to viewport
      for (const label of labels) {
        const hw = labelW(label.text) / 2, hh = labelH(label.text) / 2
        label.x = Math.max(hw + 4, Math.min(VW - hw - 4, label.x))
        label.y = Math.max(hh + 4, Math.min(VH - hh - 4, label.y))
      }

      if (maxOverlap < 1) break
    }

    return labels
  }, [wardLabelInfo, viewState, heightScale])

  const getFeatureId = useCallback((f: ParcelFeature) => {
    const p = f.properties
    if (p?.geoid) return p.geoid
    if (p?.ward && !p?.block) return `ward-${p.ward}`
    return `${p?.block || ''}-${p?.lot || ''}-${p?.qual || ''}`.replace(/-+$/, '')
  }, [])

  const selected = useMemo(() => {
    if (!selectedId || !data) return null
    const feature = data.find(f => getFeatureId(f) === selectedId)
    return feature?.properties ?? null
  }, [selectedId, data, getFeatureId])

  const mapStyle = actualTheme === 'dark'
    ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
    : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

  const fillAlpha = actualTheme === 'dark' ? 180 : 220
  const lineColor: [number, number, number, number] = actualTheme === 'dark'
    ? [100, 100, 100, 100]
    : [60, 60, 60, 160]

  const getMetricValue = useCallback((f: ParcelFeature): number => {
    const p = f.properties
    if (metricMode === 'per_capita') return p?.paid_per_capita ?? 0
    return p?.paid_per_sqft ?? 0
  }, [metricMode])

  const staleData = loading && data
  const getFillColor = useCallback((f: ParcelFeature): [number, number, number, number] => {
    if (staleData) return LOADING_COLOR
    const id = getFeatureId(f)
    if (id === selectedId) return id === hoveredId ? SELECTED_HOVER_COLOR : SELECTED_COLOR
    if (id === hoveredId) return HOVER_COLOR

    return interpolateColor(getMetricValue(f), colorStops, maxVal, colorScale, fillAlpha)
  }, [staleData, colorStops, colorScale, maxVal, hoveredId, selectedId, getFeatureId, fillAlpha, getMetricValue])

  const layers = [
    new GeoJsonLayer<ParcelFeature>({
      id: 'parcels',
      data: effectiveData ?? [],
      filled: true,
      extruded,
      wireframe: extruded,
      getFillColor,
      getElevation: extruded ? (f) => getMetricValue(f) * stableHeightScaleRef.current : 0,
      getLineColor: lineColor,
      lineWidthMinPixels: 1,
      pickable: true,
      onHover: ({ object }) => {
        if (suppressHoverRef.current) return
        if (object) {
          setHoveredId(getFeatureId(object))
          setHovered(object.properties ?? null)
        } else {
          setHoveredId(null)
          setHovered(null)
        }
      },
      onClick: ({ object }) => {
        if (object) {
          const id = getFeatureId(object)
          setSelectedId(id === selectedIdRef.current ? undefined : id)
          suppressHoverRef.current = true
          setHoveredId(null)
          setHovered(null)
          setTimeout(() => { suppressHoverRef.current = false }, 100)
          return true
        }
      },
      updateTriggers: {
        getFillColor: [year, maxVal, colorStops, colorScale, hoveredId, selectedId, aggregateMode, actualTheme, metricMode, staleData],
        getElevation: [year, stableHeightScaleRef.current, aggregateMode, metricMode],
        getLineColor: [actualTheme],
      },
    }),
  ]

  const inputStyle = {
    background: 'var(--input-bg)',
    color: 'var(--text-primary)',
    border: '1px solid var(--input-border)',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 14,
  }

  return (
    <div style={{ width: '100vw', height: '100vh', WebkitTouchCallout: 'none' }} onContextMenu={e => e.preventDefault()}>
      <DeckGL
        viewState={viewState}
        onViewStateChange={({ viewState: vs }) => {
          if (isPitchingRef.current) return
          const { latitude, longitude, zoom, pitch, bearing, transitionDuration, transitionInterpolator } = vs as ViewState
          setViewState({ latitude, longitude, zoom, pitch, bearing, transitionDuration, transitionInterpolator })
        }}
        onClick={({ object }) => {
          if (!object && !kbdCtx?.isOmnibarOpen) {
            setSelectedId(undefined)
            suppressHoverRef.current = true
            setHoveredId(null)
            setHovered(null)
            setTimeout(() => { suppressHoverRef.current = false }, 100)
          }
          if (window.innerWidth <= 768) setSettingsOpen(false)
        }}
        onError={(error: Error) => {
          console.error('DeckGL error:', error)
          setWebglError(error.message)
        }}
        controller={{ maxPitch: 85, touchRotate: true }}
        layers={layers}
        deviceProps={{ type: 'webgl' }}
      >
        <Map
          mapStyle={mapStyle}
          maxPitch={85}
        />
      </DeckGL>

      {/* Controls */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          zIndex: 1,
          background: 'var(--panel-bg)',
          color: 'var(--text-primary)',
          borderRadius: 4,
          fontSize: 14,
          minWidth: settingsOpen ? 240 : undefined,
          maxWidth: '90vw',
        }}
      >
        <div
          onClick={() => setSettingsOpen(v => !v)}
          style={{
            padding: '8px 15px',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            userSelect: 'none',
          }}
        >
          <span style={{ fontWeight: 'bold' }}>Settings</span>
          <span style={{ fontSize: 10 }}>{settingsOpen ? '\u25B2' : '\u25BC'}</span>
        </div>
        {settingsOpen && (
          <div style={{ padding: '0 15px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label>
              Tax Year:{' '}
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                style={inputStyle}
              >
                {AVAILABLE_YEARS.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 4 }}>
              <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--text-secondary)' }}>Color Gradient</div>
              <GradientEditor
                stops={colorStops}
                setStops={setColorStops}
                scale={colorScale}
                setScale={(s) => setColorScaleRaw(s === (modeConf.scale ?? 'log') ? undefined : s)}
                max={modeConf.max}
                onReset={hasCustomStops ? resetColorStops : undefined}
                metricLabel={metricMode === 'per_capita' ? '/capita' : '/sqft'}
              />
            </div>
            <label>
              View:{' '}
              <select
                value={aggregateMode}
                onChange={(e) => setAggregateMode(e.target.value as AggregateMode)}
                style={inputStyle}
              >
                <option value="ward">Wards</option>
                <option value="census-block">Census Blocks</option>
                <option value="block">Blocks</option>
                <option value="lot">Lots (dissolved)</option>
                <option value="unit">Units (individual)</option>
              </select>
            </label>
            {hasPopulation && (
              <label>
                Metric:{' '}
                <select
                  value={metricMode}
                  onChange={(e) => setMetricMode(e.target.value as MetricMode)}
                  style={inputStyle}
                >
                  <option value="per_sqft">$/sqft</option>
                  <option value="per_capita">$/capita</option>
                </select>
              </label>
            )}
            {aggregateMode === 'ward' && (<>
              <label>
                Geometry:{' '}
                <select
                  value={wardGeom}
                  onChange={(e) => setWardGeom(e.target.value)}
                  style={inputStyle}
                >
                  <option value="merged">Merged</option>
                  <option value="blocks">Tax blocks</option>
                  <option value="lots">Tax lots</option>
                  <option value="boundary">Full boundary</option>
                </select>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={wardLabels}
                  onChange={(e) => setWardLabels(e.target.checked)}
                />
                Ward labels
              </label>
            </>)}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={extruded}
                onChange={(e) => setExtruded(e.target.checked)}
              />
              3D
            </label>
            {extruded && <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Max height:{' '}
              <input
                type="number"
                value={Math.round(maxHeight / 100) / 10}
                onChange={(e) => {
                  const km = Number(e.target.value)
                  if (!km || km <= 0) return
                  const m = Math.round(km * 1000)
                  setMaxHeightRaw(m === modeConf.maxHeight ? undefined : m)
                }}
                style={{ ...inputStyle, width: 60 }}
                min={0.1}
                step={0.5}
              />
              <span>km</span>
              {maxHeightRaw !== undefined && (
                <button
                  onClick={() => setMaxHeightRaw(undefined)}
                  title="Reset to default"
                  style={{ ...inputStyle, cursor: 'pointer', padding: '2px 6px', fontSize: 14 }}
                >
                  ↺
                </button>
              )}
            </label>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Pitch: {Math.round(viewState.pitch)}°
              <input
                type="range"
                min={0}
                max={85}
                value={viewState.pitch}
                onChange={(e) => setViewState(v => ({ ...v, pitch: Number(e.target.value) }))}
                style={{ width: 80 }}
              />
            </label>
          </div>
        )}
      </div>

      {/* Hover/selected tooltip */}
      {(hovered || selected) && (() => {
        const info = hovered ?? selected!
        const isCensus = !!info.geoid || (!!info.ward && !info.block)
        const sqftActive = metricMode === 'per_sqft'
        return (
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: 10,
              zIndex: 1,
              background: 'var(--panel-bg)',
              color: 'var(--text-primary)',
              padding: '10px 15px',
              borderRadius: 4,
              fontSize: 14,
              maxWidth: 300,
            }}
          >
            {isCensus ? (
              <>
                {info.ward && !info.block && (
                  <div><strong>Ward {info.ward}{info.council_person ? ` (${info.council_person})` : ''}</strong></div>
                )}
                {info.geoid && (
                  <div><strong>Census Block {info.geoid}</strong></div>
                )}
                {info.geoid && info.ward && <div>Ward {info.ward}</div>}
                {info.population !== undefined && (
                  <div>Population: {info.population.toLocaleString()}</div>
                )}
              </>
            ) : (
              <>
                {info.addr && <div><strong>{info.addr}</strong></div>}
                {info.streets && !info.addr && <div><strong>{info.streets}</strong></div>}
                <div>Block{info.lot ? ': ' : ' '}{info.block}{info.lot ? `-${info.lot}` : ''}{info.qual ? `-${info.qual}` : ''}</div>
                {info.owner && <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{info.owner}</div>}
              </>
            )}
            {info.area_sqft !== undefined && info.area_sqft > 0 && (
              <div>Area: {info.area_sqft.toLocaleString()} sqft</div>
            )}
            {info.paid !== undefined && info.paid > 0 && (
              <div>Paid ({year}): ${info.paid.toLocaleString()}</div>
            )}
            {info.paid_per_sqft !== undefined && info.paid_per_sqft > 0 && (
              <div style={{ color: sqftActive ? 'var(--text-accent)' : undefined }}>
                ${info.paid_per_sqft.toFixed(2)}/sqft
              </div>
            )}
            {info.paid_per_capita !== undefined && info.paid_per_capita > 0 && (
              <div style={{ color: !sqftActive ? 'var(--text-accent)' : undefined }}>
                ${info.paid_per_capita.toLocaleString()}/capita
              </div>
            )}
          </div>
        )
      })()}

      {webglError && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          background: 'rgba(0,0,0,0.9)', color: '#ff6b6b', padding: '20px 30px',
          borderRadius: 8, fontSize: 16, maxWidth: '80vw', zIndex: 9999, textAlign: 'center',
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: 8 }}>WebGL Error</div>
          <div style={{ fontSize: 14, color: '#ccc' }}>{webglError}</div>
        </div>
      )}

      {/* Ward labels (HTML overlay, pure screen-space) */}
      {wardScreenLabels.map(label => (
        <div
          key={label.ward}
          style={{
            position: 'absolute',
            left: label.x,
            top: label.y,
            transform: 'translate(-50%, -50%)',
            color: actualTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: 700,
            fontSize: 14,
            textAlign: 'center',
            whiteSpace: 'pre-line',
            textShadow: actualTheme === 'dark'
              ? '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.6)'
              : '0 0 4px rgba(255,255,255,0.9), 0 0 8px rgba(255,255,255,0.6)',
            pointerEvents: 'none',
          }}
        >
          {label.text}
        </div>
      ))}

      {/* Compass rose */}
      <div
        onClick={() => setViewState(v => ({
          ...v,
          bearing: 0,
          transitionDuration: 300,
          transitionInterpolator: new LinearInterpolator(['bearing']),
        }))}
        style={{
          position: 'absolute',
          bottom: 50,
          left: 10,
          width: 40,
          height: 40,
          cursor: viewState.bearing !== 0 ? 'pointer' : undefined,
          zIndex: 1,
          opacity: viewState.bearing === 0 ? 0.3 : 0.85,
        }}
        title={viewState.bearing !== 0 ? `Bearing: ${Math.round(viewState.bearing)}° — Click to reset` : 'North up'}
      >
        <svg viewBox="0 0 40 40" style={{ transform: `rotate(${-viewState.bearing}deg)` }}>
          <circle cx="20" cy="20" r="18" fill="var(--panel-bg)" stroke="var(--text-secondary)" strokeWidth="1" opacity="0.6" />
          <polygon points="20,4 23.5,19 20,16 16.5,19" fill="#e53935" />
          <polygon points="20,36 23.5,21 20,24 16.5,21" fill="var(--text-secondary)" opacity="0.4" />
          <text x="20" y="3.5" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#e53935">N</text>
        </svg>
      </div>

      {/* Status bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 10,
          left: 10,
          background: 'var(--panel-bg)',
          color: 'var(--text-primary)',
          padding: '8px 12px',
          borderRadius: 4,
          fontSize: 12,
        }}
      >
        {loading ? 'Loading...' : `${data?.length.toLocaleString()} parcels`}
      </div>
    </div>
  )
}
