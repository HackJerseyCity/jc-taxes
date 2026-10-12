import { useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { Map as MaplibreMap, type MapRef } from 'react-map-gl/maplibre'
import DeckGL, { type DeckGLRef } from '@deck.gl/react'
import { WebMercatorViewport, FlyToInterpolator, LinearInterpolator } from '@deck.gl/core'
import { ColumnLayer, GeoJsonLayer } from '@deck.gl/layers'
import { useUrlAlias, useUrlState, stringParam, viewStateParam } from 'use-prms'
import { useQuery } from '@tanstack/react-query'
import { useHotkeysContext } from 'use-kbd'
import { MdFolderOpen, MdSettings } from 'react-icons/md'
import AppSpeedDial from './AppSpeedDial'
import { resolve as dvcResolve } from 'virtual:dvc-data'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useKeyboardShortcuts, type ViewState } from './useKeyboardShortcuts'
import { AVAILABLE_YEARS, DEFAULT_YEAR, YEAR_MAX } from './years'
import { summaryFocus, useSummary, type SummaryMetric } from './summary'
import { isBundled, loadWardShapes, yearFeatures } from './bundle'
import { useParcelDetails } from './parcel'
import { findPortfolio, portfolioPredicate, usePortfolios } from './portfolios'
import { fit3d } from './fit3d'
import FocusPicker, { type FocusOption } from './FocusPicker'
import { HOOD_SLUGS, aggAlias, builtSinceParam, hoodParam, metricAlias, portfolioAlias, wardParam, yearParam } from './urlParams'
import { ASSESSED_YEAR, BUILT_SINCE_MIN, builtSinceStats, builtSinceTest, pct } from './builtSince'
import { WARDS, boundsOf, hoodsOf, parseRegion, regionLabel, regionTest } from './regions'
import { useTouchPitch } from './useTouchPitch'
import { useParcelSearch, type AddressHit } from './useParcelSearch'
import { useTheme } from './theme'
import GradientEditor from './GradientEditor'
import {
  type ScaleType,
  type ColorStop,
  interpolateColor,
  encodeStops,
  decodeStops,
} from './gradient'
import type { ParcelProperties, ParcelFeature, ParcelFeatureLike } from './types'
import { getLotNote } from './notes'
import DistributionChart from './DistributionChart'
import Tooltip from './Tooltip'

// Hooks exposed on `window` for scrns automation (screencasts step the year /
// nudge the viewport from outside React).
declare global {
  interface Window {
    __setViewState?: (partial: Partial<ViewState>) => void
    __setYear?: (v: number) => void
  }
}

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

const viewParam = viewStateParam({
  default: DEFAULT_VIEW,
  signDelim: true,
  zoomDecimals: 1,
})


// Float-aware ?y param: accepts integer years for normal use and fractional
// values (e.g. ?y=2020.5) for deterministic mid-animation states. Adjacent
// integer years' data is interpolated per-feature in getElevation/getFillColor.
// Odometer-style year display for animation captures. Digits that differ
// between floor(year) and ceil(year) are stacked vertically inside a clipped
// column and scrolled up by `year - floor(year)`, so the fractional part
// shows up as a half-rolled digit. Unchanged digits render as plain glyphs.
function RollingYear({ year, fontSize = 56 }: { year: number, fontSize?: number }) {
  const yFloor = Math.floor(year)
  const yCeil = Math.ceil(year)
  const t = yFloor === yCeil ? 0 : year - yFloor
  const from = String(yFloor).padStart(4, '0').split('')
  const to = String(yCeil).padStart(4, '0').split('')
  const digitStyle = {
    display: 'inline-block',
    height: '1em',
    lineHeight: '1em',
    width: '0.62em',
    textAlign: 'center' as const,
    fontVariantNumeric: 'tabular-nums' as const,
  }
  return (
    <span style={{ display: 'inline-flex', fontSize, fontWeight: 700, lineHeight: 1 }}>
      {from.map((f, i) => {
        const c = to[i]
        if (f === c) return <span key={i} style={digitStyle}>{f}</span>
        return (
          <span key={i} style={{ ...digitStyle, overflow: 'hidden', verticalAlign: 'top' }}>
            {/* Strip is 2em tall (two 1em digits stacked). translateY % is
                relative to the strip's own height, so -50% moves it by
                exactly one digit-height — `from` slides out the top as
                `to` slides in from the bottom. -100% would overshoot. */}
            <span style={{ display: 'block', transform: `translateY(${-t * 50}%)` }}>
              <span style={{ ...digitStyle, display: 'block' }}>{f}</span>
              <span style={{ ...digitStyle, display: 'block' }}>{c}</span>
            </span>
          </span>
        )
      })}
    </span>
  )
}

const SCRUB_W = 190
// [singular, plural] feature noun per aggregation level.
const AGG_NOUN: Record<string, [string, string]> = {
  'block': ['block', 'blocks'], 'lot': ['lot', 'lots'], 'unit': ['unit', 'units'],
  'census-block': ['census block', 'census blocks'], 'ward': ['ward', 'wards'],
}
// Native range thumbs sit inset by ~their radius at each end; the sparkline's
// x-axis uses the same inset so each year's point lines up with its thumb spot.
const THUMB_INSET = 8

// Per-year totals drawn behind the transport scrubber: an area sparkline with a
// dot per year and a marker at the current (fractional) year. Tapping the track
// already scrubs, so the chart doubles as a year picker.
function YearSparkline({ totals, year, width, height }: { totals: [number, number][], year: number, width: number, height: number }) {
  const y0 = totals[0][0], y1 = totals[totals.length - 1][0]
  const max = Math.max(...totals.map(([, v]) => v)) || 1
  const x = (yr: number) => THUMB_INSET + (yr - y0) / (y1 - y0) * (width - 2 * THUMB_INSET)
  const y = (v: number) => height - 3 - v / max * (height - 8)
  const line = totals.map(([yr, v], i) => `${i ? 'L' : 'M'}${x(yr).toFixed(1)},${y(v).toFixed(1)}`).join('')
  const area = `${line}L${x(y1).toFixed(1)},${height}L${x(y0).toFixed(1)},${height}Z`
  const i = Math.min(Math.max(Math.floor(year - y0), 0), totals.length - 2)
  const t = Math.min(Math.max(year - totals[i][0], 0), 1)
  const cur = totals[i][1] + (totals[i + 1][1] - totals[i][1]) * t
  return (
    <svg width={width} height={height} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden>
      <path d={area} fill="var(--text-accent)" opacity={0.18} />
      <path d={line} fill="none" stroke="var(--text-accent)" strokeWidth={1.5} opacity={0.8} />
      {totals.map(([yr, v]) => <circle key={yr} cx={x(yr)} cy={y(v)} r={1.6} fill="var(--text-accent)" opacity={0.8} />)}
      <line x1={x(year)} x2={x(year)} y1={0} y2={height} stroke="var(--text-primary)" strokeWidth={1} opacity={0.35} />
      <circle cx={x(year)} cy={y(cur)} r={3} fill="var(--text-primary)" />
    </svg>
  )
}

// Inline title picker: the visible label (current option text + ▼, dotted
// underline) sizes the control; a transparent native <select> overlays it, so
// the width tracks the current value rather than the longest option, while
// tapping still opens the native (mobile-friendly) picker.
function InlineSelect({ value, label, onChange, options, title, fontSize, fontWeight = 600, ariaLabel }: {
  value: string | number
  label: ReactNode
  onChange: (v: string) => void
  options: ReactNode
  title: string
  fontSize?: number
  fontWeight?: number
  ariaLabel?: string
}) {
  return (
    <span
      style={{
        position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '0.25em',
        pointerEvents: 'auto', fontSize, fontWeight, cursor: 'pointer',
        borderBottom: '1px dotted rgba(255,255,255,0.7)', whiteSpace: 'nowrap',
        maxWidth: '62vw',
      }}
      title={title}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ fontSize: '0.55em', opacity: 0.85 }}>{'▼'}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel ?? title}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          opacity: 0, cursor: 'pointer', fontSize: 16, margin: 0, padding: 0,
        }}
      >
        {options}
      </select>
    </span>
  )
}

// Interactive year control for the title subtitle: prev/next steppers flank a
// native <select> styled to read as inline title text; it's the app's primary
// year control. Steps within `years`; the select snaps to the nearest integer so it
// tracks fractional-year animation/playback without falling back.
function YearControl({ year, setYear, years, onPlay, big }: { year: number, setYear: (y: number) => void, years: number[], onPlay?: () => void, big?: boolean }) {
  const cur = Math.round(year)
  const idx = years.indexOf(cur)
  const go = (d: number) => { const i = idx + d; if (i >= 0 && i < years.length) setYear(years[i]) }
  const bs = big ? 34 : 24
  const btn = (onClick: () => void, disabled: boolean, glyph: string, label: string, fontSize = big ? 22 : 15) => (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{
        pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.35)',
        color: 'white',
        border: '1px solid rgba(255,255,255,0.35)',
        borderRadius: 5,
        width: bs, height: bs, lineHeight: `${bs - 2}px`, padding: 0,
        fontSize, fontWeight: 700, cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.3 : 0.9,
        fontFamily: 'inherit',
      }}
    >{glyph}</button>
  )
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, verticalAlign: 'middle' }}>
      {btn(() => go(-1), idx <= 0, '‹', 'Previous year')}
      <InlineSelect
        value={cur}
        label={big ? <RollingYear year={year} fontSize={46} /> : cur}
        onChange={(v) => setYear(Number(v))}
        title="Change tax year"
        fontSize={big ? 46 : 20}
        fontWeight={700}
        options={years.map((y) => <option key={y} value={y} style={{ color: '#111' }}>{y}</option>)}
      />
      {btn(() => go(1), idx >= years.length - 1, '›', 'Next year')}
      {onPlay && btn(onPlay, false, '▶', 'Play through years', 11)}
    </span>
  )
}

// Status-bar summary tooltip. `usd` is the exact dollar amount (commas, no
// cents) for cross-checking against official figures; `abbr` is a compact form.
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`
const abbr = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` :
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` :
  n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${Math.round(n)}`
type Summary = {
  count: number, paid: number, billed: number, area: number, withPaid: number, yr: number,
  // Present only when a focus is active: the unfiltered totals for context.
  city?: { count: number, paid: number },
}
function SummaryStats({ s, aggLabel }: { s: Summary, aggLabel: string }) {
  const collected = s.billed > 0 ? (s.paid / s.billed) * 100 : null
  const row = (label: string, value: string, sub?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
      <span style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {value}{sub && <span style={{ color: 'var(--text-secondary)' }}> {sub}</span>}
      </span>
    </div>
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 230 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        {s.yr} · {s.count.toLocaleString()} {aggLabel}{s.city && ' highlighted'}
      </div>
      {row('Total paid', usd(s.paid), `(${abbr(s.paid)})`)}
      {s.billed > 0 && row('Total billed', usd(s.billed), `(${abbr(s.billed)})`)}
      {collected != null && row('Collected', `${collected.toFixed(2)}%`)}
      {row('With tax > 0', `${s.withPaid.toLocaleString()} / ${s.count.toLocaleString()}`)}
      {s.area > 0 && row('Total area', `${abbr(s.area).replace('$', '')} sqft`)}
      {s.city && row('Citywide paid', abbr(s.city.paid), `· ${s.city.count.toLocaleString()} ${aggLabel}`)}
      <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 4, fontWeight: 400 }}>
        Sum over the current view; totals vary by view (coverage).
      </div>
    </div>
  )
}

// Stable across the file: used by both the accessor closures and the data cache.
function featureIdOf(f: ParcelFeatureLike): string {
  const p = f.properties
  if (p?.geoid) return p.geoid
  if (p?.ward && !p?.block) return `ward-${p.ward}`
  return `${p?.block || ''}-${p?.lot || ''}-${p?.qual || ''}`.replace(/-+$/, '')
}
type Ring = number[][]

// Signed area × 2 (shoelace). Sign encodes winding; callers use |area|.
function ringArea2(ring: Ring): number {
  let a = 0
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return a
}

function ringCentroid(ring: Ring): [number, number] {
  let cx = 0, cy = 0, a2 = 0
  for (let i = 0, n = ring.length - 1; i < n; i++) {
    const [x0, y0] = ring[i], [x1, y1] = ring[i + 1]
    const cross = x0 * y1 - x1 * y0
    a2 += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  if (a2 === 0) return [ring[0][0], ring[0][1]]
  return [cx / (3 * a2), cy / (3 * a2)]
}

// Ray casting: is (x, y) inside `ring`?
function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// Where to stand a parcel's column. The area-weighted centroid is the natural
// anchor but it escapes the parcel for L / C / U-shaped blocks and for the
// disjoint multi-parts a ward can have — which put columns in the middle of the
// Hackensack. So: take the largest ring, and if its centroid falls outside,
// slide to the midpoint of the widest interior span on the centroid's latitude
// (the standard label-point heuristic — always inside, and visually central).
function columnAnchorOf(geom: ParcelFeature['geometry']): [number, number] {
  const rings: Ring[] = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map(p => p[0])
  let ring = rings[0]
  if (!ring?.length) return [0, 0]
  for (const r of rings) {
    if (r.length > 2 && Math.abs(ringArea2(r)) > Math.abs(ringArea2(ring))) ring = r
  }

  const [cx, cy] = ringCentroid(ring)
  if (pointInRing(cx, cy, ring)) return [cx, cy]

  // Collect edge crossings along y = cy, then take the widest inside span.
  const xs: number[] = []
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if ((yi > cy) !== (yj > cy)) xs.push(((xj - xi) * (cy - yi)) / (yj - yi) + xi)
  }
  xs.sort((a, b) => a - b)
  let bestX = cx, bestSpan = -1
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const span = xs[i + 1] - xs[i]
    if (span > bestSpan) { bestSpan = span; bestX = (xs[i] + xs[i + 1]) / 2 }
  }
  return [bestX, cy]
}

type AggregateMode = 'block' | 'lot' | 'unit' | 'census-block' | 'ward'
const SUFFIX_MAP: Record<string, string> = {
  unit: '-units',
  block: '-blocks',
  lot: '-lots',
  'census-block': '-census-blocks',
  ward: '-wards',
}
type MetricMode = 'per_sqft' | 'per_capita' | 'total'

// Per-mode defaults for color max and max height (meters)
function getModeKey(agg: string, metric: string): string {
  // `total` needs its own config at every aggregation: block totals are ~50x
  // lot totals, so color stops / heights can't be shared with the /sqft modes.
  if (metric === 'total') return `${agg}:total`
  if (agg === 'census-block' || agg === 'ward') return `${agg}:${metric}`
  return agg
}
// Which feature property each metric reads.
const METRIC_FIELDS = {
  per_sqft: 'paid_per_sqft',
  per_capita: 'paid_per_capita',
  total: 'paid',
} as const
function metricField(metric: string): 'paid_per_sqft' | 'paid_per_capita' | 'paid' {
  return METRIC_FIELDS[metric as MetricMode] ?? 'paid_per_sqft'
}
// Years whose payments are still coming in (final-quarter bills not yet due):
// shown by amount BILLED, with a caveat, rather than a misleadingly low paid.
const BILLED_YEARS = new Set([2026])
const YEAR_TWEEN_MS = 450
interface YearTween { from: number, to: number, t: number, fromMax: number }
const isBilledYear = (y: number | undefined) => y != null && BILLED_YEARS.has(Math.round(y))
const BILLED_FIELDS = { paid_per_sqft: 'billed_per_sqft', paid_per_capita: 'billed_per_capita', paid: 'billed' } as const
/** The displayed metric for a feature: paid, or billed for `BILLED_YEARS`. */
function metricValue(p: ParcelProperties | null | undefined, metric: string): number {
  if (!p) return 0
  const f = metricField(metric)
  return (isBilledYear(p.year) ? p[BILLED_FIELDS[f]] : p[f]) ?? 0
}
/** Dollar amount for totals: paid, or billed for `BILLED_YEARS`. */
const amountOf = (p: ParcelProperties | null | undefined): number =>
  (isBilledYear(p?.year) ? p?.billed : p?.paid) ?? 0
// `per_capita` needs population data (census-block / ward only); `per_sqft` and
// `total` are available at every aggregation.
function effectiveMetricFor(agg: string, metric: string): string {
  if (metric === 'per_capita' && agg !== 'census-block' && agg !== 'ward') return 'per_sqft'
  return metric
}
// Per-mode color stops: values positioned to differentiate actual data distribution
// per_sqft: data skewed near zero → stops at ~1-7% of max
// per_capita: data more spread → stops at ~25-75% of max
type ModeConfig = {
  min?: number
  max: number
  maxHeight: number
  scale?: ScaleType
  // `total` metric only: radius (meters) of the uniform-footprint columns.
  columnRadius?: number
  stops?: { dark: ColorStop[], light: ColorStop[] }
}

// Shared 4-stop theme ramps (neutral → red → yellow → green). Total-$ modes
// reuse them at wildly different values, so build stops from a value quadruple.
const RAMP_DARK: [number, number, number][] = [[96, 96, 96], [255, 0, 0], [255, 217, 26], [0, 255, 0]]
const RAMP_LIGHT: [number, number, number][] = [[255, 255, 255], [255, 71, 71], [230, 190, 0], [0, 214, 0]]
function stopsAt(values: [number, number, number, number]): { dark: ColorStop[], light: ColorStop[] } {
  return {
    dark: values.map((value, i) => ({ value, color: RAMP_DARK[i] })),
    light: values.map((value, i) => ({ value, color: RAMP_LIGHT[i] })),
  }
}

const MODE_DEFAULTS: Record<string, ModeConfig> = {
  'block':                  { max: 300,   maxHeight: 4500 },
  'lot':                    { max: 300,   maxHeight: 4500 },
  'unit':                   { max: 300,   maxHeight: 900 },
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
  // Total-$ modes. Height is linear and unclamped so bar height is literally
  // proportional to dollars — `maxHeight` is therefore what the single tallest
  // feature gets. It's set tall on purpose: the story of this metric is *how
  // far* the handful of downtown towers out-pay everything else, so the top
  // bars should soar while the (brutally skewed — 2025: median block $525k, top
  // block $80.8M) long tail stays near-flat; the log color ramp does the
  // discriminating down there. `columnRadius` is ~a third of the typical
  // inter-feature spacing at each level.
  'block:total':            { max: 20e6,  maxHeight: 7000, scale: 'log',    columnRadius: 45,  stops: stopsAt([0, 250e3, 1e6, 6e6]) },
  'lot:total':              { max: 2e6,   maxHeight: 7000, scale: 'log',    columnRadius: 12,  stops: stopsAt([0, 10e3, 50e3, 800e3]) },
  'unit:total':             { max: 1e6,   maxHeight: 5000, scale: 'log',    columnRadius: 6,   stops: stopsAt([0, 8e3, 30e3, 300e3]) },
  'census-block:total':     { max: 20e6,  maxHeight: 7000, scale: 'log',    columnRadius: 40,  stops: stopsAt([0, 250e3, 1e6, 6e6]) },
  'ward:total':             { max: 450e6, maxHeight: 6500, scale: 'linear', columnRadius: 400, stops: stopsAt([0, 100e6, 200e6, 400e6]) },
}
const YR_UNKNOWN_COLOR: [number, number, number] = [110, 110, 118]
const YR_BUILT_CONFIG: ModeConfig = {
  min: 1870, max: 2025, maxHeight: 4500, scale: 'linear',
  stops: {
    dark:  [{ value: 1870, color: [160, 80, 230] }, { value: 1910, color: [255, 0, 0] }, { value: 1960, color: [255, 217, 26] }, { value: 2025, color: [0, 255, 0] }],
    light: [{ value: 1870, color: [140, 60, 210] }, { value: 1910, color: [255, 71, 71] }, { value: 1960, color: [230, 190, 0] }, { value: 2025, color: [0, 214, 0] }],
  },
}

const SS_PREFIX = 'jc-taxes:'

function ssSave(key: string, field: string, value: string) {
  sessionStorage.setItem(`${SS_PREFIX}${key}:${field}`, value)
}
function ssLoad(key: string, field: string): string | null {
  return sessionStorage.getItem(`${SS_PREFIX}${key}:${field}`)
}

const LOADING_COLOR: [number, number, number, number] = [128, 128, 128, 60]
// Parcels outside the active portfolio are dimmed to near-background so the
// portfolio set pops (members keep their normal metric color).
const PORTFOLIO_DIM: [number, number, number] = [90, 95, 105]
// Minimum camera pitch when fitting to a focus (portfolio / region).
const FOCUS_PITCH = 54
// Min footprint for a feature to set the per-area height auto-fit (see `scalesHeight`).
const MIN_SCALE_AREA_SQFT = 500
// Hover / selection use a blue family that sits outside the red→yellow→green
// $ gradient, so a highlighted parcel never reads as a data value. Hover is the
// palest, selected the most saturated, selected+hover in between.
const HOVER_COLOR: [number, number, number, number] = [190, 235, 255, 230]
const SELECTED_COLOR: [number, number, number, number] = [100, 200, 255, 230]
const SELECTED_HOVER_COLOR: [number, number, number, number] = [145, 218, 255, 235]

const optScaleParam: Param<ScaleType | undefined> = {
  decode: (s: string | undefined) => (s as ScaleType) ?? undefined,
  encode: (v: ScaleType | undefined) => v == null ? undefined as unknown as string : v,
}

const boolParam: Param<boolean> = {
  decode: (s: string | undefined) => s !== '0',
  encode: (v: boolean) => v ? undefined as unknown as string : '0',
}

// Default-false boolean (opposite of `boolParam`, which defaults true when
// absent), e.g. the player's `play` flag, so a bare URL is paused.
const flagParam: Param<boolean> = {
  decode: (s: string | undefined) => s === '1',
  encode: (v: boolean) => v ? '1' : undefined as unknown as string,
}

// Playback speed presets (tax-years advanced per real second). Stored raw in
// `?pspeed`; the transport labels them relative to NORMAL (1×).
const PLAY_SPEEDS = [0.75, 1.5, 3] as const
const PLAY_SPEED_DEFAULT = 1.5
const playSpeedLabel = (s: number) => {
  const rel = s / PLAY_SPEED_DEFAULT
  return `${rel < 1 ? rel.toFixed(1).replace(/\.0$/, '') : String(Math.round(rel))}×`
}

const optNumParam: Param<number | undefined> = {
  decode: (s: string | undefined) => {
    if (s == null) return undefined
    const n = Number(s)
    return isNaN(n) ? undefined : n
  },
  encode: (v: number | undefined) => v == null ? undefined as unknown as string : String(v),
}

export default function MapView() {
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
  const [settingsOpenUrl] = useUrlState('so', boolParam)
  const [settingsOpen, setSettingsOpen] = useState(() => settingsOpenUrl && window.innerWidth > 768)

  // URL-persisted state (mh is optional; absent = use mode default)
  const [urlYear, setUrlYear] = useUrlState('y', yearParam(DEFAULT_YEAR))
  // Transient (uncommitted) year used while the animation player is running or
  // the scrubber is being dragged. It overrides `urlYear` for rendering without
  // writing to the URL at 60fps (which history.replaceState throttles). When it
  // clears, the URL year is authoritative again.
  const [playing, setPlaying] = useUrlState('play', flagParam)
  // Autoplay link (`play=1`) parked at the last year: start on the first year
  // from the very first frame, instead of showing the end year then jumping.
  const [playYear, setPlayYear] = useState<number | null>(
    () => playing && urlYear >= DEFAULT_YEAR ? AVAILABLE_YEARS[0] : null,
  )
  const year = playYear ?? urlYear
  const playYearRef = useRef(playYear)
  playYearRef.current = playYear
  // Animation player: URL-linkable play flag (auto-resumes on load) + speed.
  const [playSpeedRaw, setPlaySpeed] = useUrlState('pspeed', optNumParam)
  const playSpeed = playSpeedRaw ?? PLAY_SPEED_DEFAULT
  // The transport bar is summoned by playing (title ▶ button, space, `?play=1`)
  // and stays up while paused / scrubbing until dismissed with its ×.
  const [transportOpen, setTransportOpen] = useState(!!playing)
  useEffect(() => { if (playing) setTransportOpen(true) }, [playing])
  // Picking a year explicitly (dropdown / stepper / keyboard / search) commits
  // to the URL and cancels any in-flight playback or scrub.
  const setYear = useCallback((y: number) => {
    setPlaying(false)
    setPlayYear(null)
    setUrlYear(y)
  }, [setPlaying, setUrlYear])
  // Discrete year changes from the UI (j/k, stepper, dropdown, omnibar) tween
  // bars from the old year's values to the new one's: the URL commits at once,
  // and `yearTween.t` (0→1, eased) lerps each feature between the two years'
  // cached values (see `getMetricValue`) and the height scale between the two
  // years' fits (see `tweenedMax`). The clock holds at t=0 until the target
  // year is loaded. A new step mid-tween starts from the previous target.
  const [yearTween, setYearTween] = useState<YearTween | null>(null)
  const yearTweenRef = useRef(yearTween)
  yearTweenRef.current = yearTween
  const tweenedMaxRef = useRef(0)
  const goToYear = useCallback((y: number) => {
    const from = yearTweenRef.current?.to ?? urlYear
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (playing || playYearRef.current != null || y === from || reduce) {
      setYearTween(null)
      setYear(y)
      return
    }
    setYearTween({ from, to: y, t: 0, fromMax: tweenedMaxRef.current })
    setUrlYear(y)
  }, [playing, urlYear, setYear, setUrlYear])
  const togglePlay = useCallback(() => {
    if (playing) {
      // Pausing: freeze the current animated year into the URL so the paused
      // view is shareable (the `play` flag also flips off below).
      if (playYearRef.current != null) setUrlYear(playYearRef.current)
      setPlayYear(null)
      setPlaying(false)
    } else {
      setPlaying(true)
    }
  }, [playing, setPlaying, setUrlYear])
  // Scrubbing updates the transient year locally (smooth, no URL writes); the
  // final value is committed to the URL on pointer release.
  const onScrub = useCallback((v: number) => {
    if (playing) setPlaying(false)
    setPlayYear(v)
  }, [playing, setPlaying])
  const commitScrub = useCallback(() => {
    if (playYearRef.current == null) return
    setUrlYear(playYearRef.current)
    setPlayYear(null)
  }, [setUrlYear])
  // Closing the player snaps to the nearest whole year (a paused-but-open
  // player keeps the fractional frame, for sharing mid-transition views).
  const closeTransport = useCallback(() => {
    const y = playYearRef.current ?? urlYear
    setPlaying(false)
    setPlayYear(null)
    setUrlYear(Math.round(y))
    setTransportOpen(false)
  }, [urlYear, setPlaying, setUrlYear])
  const cycleSpeed = useCallback(() => {
    const i = PLAY_SPEEDS.indexOf(playSpeed as typeof PLAY_SPEEDS[number])
    const next = PLAY_SPEEDS[(i + 1) % PLAY_SPEEDS.length]
    setPlaySpeed(next === PLAY_SPEED_DEFAULT ? undefined : next)
  }, [playSpeed, setPlaySpeed])
  const [maxHeightRaw, setMaxHeightRaw] = useUrlState('mh', optNumParam)
  const [aggRaw, setAggregateModeRaw] = useUrlAlias(aggAlias)
  const aggregateMode = aggRaw ?? 'block'
  const [portfolioRaw, setPortfolioRaw] = useUrlAlias(portfolioAlias)
  const portfolio = portfolioRaw ?? ''
  const setPortfolio = useCallback((v: string) => setPortfolioRaw(v || undefined), [setPortfolioRaw])
  const portfoliosOrNull = usePortfolios()
  const portfolios = useMemo(() => portfoliosOrNull ?? [], [portfoliosOrNull])
  // Region focus: `w=e` (ward) or `n=hp` (neighborhood slug); legacy
  // `rg=ward:E` / `rg=hood:Name` is migrated on load. Internally one string,
  // `ward:E` / `hood:Name` (see `regions.ts`).
  const [wardSel, setWardSel] = useUrlState('w', wardParam)
  const [hoodSel, setHoodSel] = useUrlState('n', hoodParam)
  const [legacyRegion, setLegacyRegion] = useUrlState('rg', stringParam(''))
  const region = wardSel ? `ward:${wardSel}` : hoodSel ? `hood:${hoodSel}` : ''
  const setRegion = useCallback((v: string) => {
    const r = parseRegion(v)
    setWardSel(r?.kind === 'ward' ? r.name : '')
    setHoodSel(r?.kind === 'hood' ? r.name : '')
  }, [setWardSel, setHoodSel])
  useEffect(() => {
    if (!legacyRegion) return
    setLegacyRegion('')
    setRegion(legacyRegion)
  }, [legacyRegion, setLegacyRegion, setRegion])
  const [pfDimRaw, setPfDim] = useUrlState('pfd', optNumParam)
  const pfDim = Number(pfDimRaw ?? 0)
  const [colorScaleRaw, setColorScaleRaw] = useUrlState('scale', optScaleParam)
  const [metricRaw, setMetricModeRaw] = useUrlAlias(metricAlias)
  const metricMode = metricRaw ?? 'per_sqft'
  const [wardGeom, setWardGeom] = useUrlState('wg', stringParam('merged'))
  const [wardLabels, setWardLabels] = useUrlState('wl', boolParam)
  const [extruded, setExtruded] = useUrlState('3d', boolParam)
  const [colorBy, setColorBy] = useUrlState('cb', stringParam('metric'))
  // "Built since" (`bs=21`): lot / unit views only, like color-by-year-built.
  const [builtSinceRaw, setBuiltSince] = useUrlState('bs', builtSinceParam)
  const builtSince = (aggregateMode === 'lot' || aggregateMode === 'unit') ? builtSinceRaw : undefined
  const [percentileRaw, setPercentileRaw] = useUrlState('pct', optNumParam)
  // Heights scale to one max across all years by default (so growth over time
  // shows); `hy` fits each year to its own tallest bar instead.
  const [perYearScale, setPerYearScale] = useUrlState('hy', flagParam)
  const [columnRadiusRaw, setColumnRadiusRaw] = useUrlState('cr', optNumParam)
  const [settingsPos, setSettingsPos] = useUrlState('sp', stringParam('tr'))
  const posRight = settingsPos.endsWith('r')
  const posBottom = settingsPos.startsWith('b')
  const [titleMode] = useUrlState('ti', stringParam(''))
  const showTitle = titleMode !== '0' && titleMode !== 'off'
  // `clean=1`: no controls (settings, speed dial, compass), for OG map captures.
  const [clean] = useUrlState('clean', flagParam)
  // Animation: ?animYr=2018-2025[:secsPerYear] cycles year forward, dwelling at each.
  // Year is parked at `from` on mount; ticking begins on `scrns:capture-start`
  // (for recordings, so frame 0 = `from` with no fresh-fetch spinner) or after
  // a short browser-session delay otherwise.
  // ?animYr=FROM-TO[:secsPerYear]
  //   - With `:dwell`: browser auto-plays after a 6s settle (preSleep-safe);
  //     `scrns:capture-start` event preempts the timer for real-time recordings.
  //   - Without `:dwell`: just parks year at FROM and triggers the preload
  //     effect (so scrns `animate` actions can step `window.__setYear`
  //     per-frame against a fully-warm cache).
  const [animYr] = useUrlState('animYr', stringParam(''))
  useEffect(() => {
    if (!animYr) return
    const m = animYr.match(/^(\d{4})-(\d{4})(?::(\d+(?:\.\d+)?))?$/)
    if (!m) return
    const [, fromS, toS, dwellS] = m
    const from = Number(fromS), to = Number(toS)
    setYear(from)
    if (dwellS == null) return  // preload-only mode (scrns animate uses this)
    const dwell = Number(dwellS) * 1000
    let id: ReturnType<typeof setInterval> | undefined
    let started = false
    const start = () => {
      if (started) return
      started = true
      let yr = from
      id = setInterval(() => {
        yr = yr + 1
        if (yr > to) { clearInterval(id); id = undefined; return }
        setYear(yr)
      }, dwell)
    }
    const autoStartId = setTimeout(start, 6000)
    const onCaptureStart = () => { clearTimeout(autoStartId); start() }
    document.addEventListener('scrns:capture-start', onCaptureStart)
    return () => {
      clearTimeout(autoStartId)
      document.removeEventListener('scrns:capture-start', onCaptureStart)
      if (id) clearInterval(id)
    }
  }, [animYr]) // eslint-disable-line react-hooks/exhaustive-deps

  const hasPopulation = aggregateMode === 'census-block' || aggregateMode === 'ward'
  // Total-$ mode: bars share one footprint (height ∝ dollars) instead of
  // extruding each polygon, so area doesn't smuggle itself into bar volume.
  const isTotal = metricMode === 'total'
  const modeKey = getModeKey(aggregateMode, metricMode)
  const modeConf = MODE_DEFAULTS[modeKey] ?? MODE_DEFAULTS['block']

  // Derived: maxVal is always the mode default (no longer user-facing)
  const maxVal = modeConf.max
  // Effective max height: URL value if explicitly set, else mode default
  const percentile = percentileRaw
  const modeColumnRadius = modeConf.columnRadius ?? 30
  // Guard `?cr=0` / negatives from the URL: a zero radius renders nothing, which
  // reads as a broken map rather than a bad param.
  const columnRadius = columnRadiusRaw != null && columnRadiusRaw > 0 ? columnRadiusRaw : modeColumnRadius
  const metricLabel = metricMode === 'per_capita' ? '/capita' : isTotal ? '' : '/sqft'
  // Total dollars span 5+ orders of magnitude, so gradient/histogram/percentile
  // readouts get compact ($1.2M) formatting instead of raw 2-decimal dollars.
  const fmtMetric = useCallback(
    (v: number) => isTotal ? abbr(v) : `$${v.toFixed(2)}`,
    [isTotal],
  )
  // Active developer/owner portfolio (`pf` param): a membership test at the
  // current view granularity, used to dim non-members and to aggregate stats.
  const activePortfolio = useMemo(() => findPortfolio(portfolios, portfolio), [portfolios, portfolio])
  const portfolioTest = useMemo(() => {
    const blockGranular = aggregateMode === 'block' || aggregateMode === 'ward' || aggregateMode === 'census-block'
    return portfolioPredicate(activePortfolio, blockGranular)
  }, [activePortfolio, aggregateMode])
  // Focus = portfolio ∧ region (`rg`: ward / neighborhood). Non-members are
  // faded (or hidden at `pfd=0`); stats + height auto-fit cover members only.
  const activeRegion = useMemo(() => parseRegion(region), [region])
  const regionFocusTest = useMemo(() => {
    if (!portfolioTest && !activeRegion) return null
    return (p: ParcelProperties | null | undefined): boolean => {
      if (!p) return false
      if (portfolioTest && !portfolioTest(String(p.block ?? ''), String(p.lot ?? ''), p.qual)) return false
      return !activeRegion || regionTest(activeRegion, p)
    }
  }, [portfolioTest, activeRegion])
  // Third focus term: built since N (`bs`).
  const focusTest = useMemo(() => {
    if (!builtSince) return regionFocusTest
    const built = builtSinceTest(builtSince)
    return (p: ParcelProperties | null | undefined): boolean =>
      built(p) && (!regionFocusTest || regionFocusTest(p))
  }, [regionFocusTest, builtSince])
  // Server-side totals / maxima for this view × focus (null for a portfolio ∧
  // region combo, which falls back to computing from loaded features).
  // Nothing to ask for until a `pf` param's portfolio list has loaded (else a
  // throwaway citywide request goes out first).
  // A built-since filter isn't precomputed either: client-side, like portfolio ∧ region.
  const summaryKey = builtSince || (portfolio && portfoliosOrNull === null)
    ? null
    : summaryFocus(activePortfolio ? portfolio : null, activeRegion ? region : null)
  const summaryQ = useSummary(String(aggregateMode), summaryKey)
  const serverSummary = summaryQ.data ?? null
  // With a focus, heights auto-fit to its members; cap the tallest bar at the
  // focus set's ground extent (bbox diagonal) so a neighborhood of rowhouses
  // doesn't become 4.5 km spikes. An explicit `mh` always wins.
  const focusExtentM = useMemo(() => {
    if (!focusTest || !data) return null
    const b = boundsOf(data.filter(f => focusTest(f.properties)))
    if (!b) return null
    const [[x0, y0], [x1, y1]] = b
    const mPerDeg = 111_320
    return Math.hypot((x1 - x0) * mPerDeg * Math.cos((y0 + y1) / 2 * Math.PI / 180), (y1 - y0) * mPerDeg)
  }, [focusTest, data])
  const maxHeight = maxHeightRaw ?? (
    focusExtentM != null ? Math.min(modeConf.maxHeight, Math.max(300, focusExtentM)) : modeConf.maxHeight
  )
  const pickerLabel = [activePortfolio?.label, activeRegion && regionLabel(activeRegion)].filter(Boolean).join(' · ')
  const builtSinceLabel = builtSince ? `Built since ${builtSince}` : ''
  const focusLabel = [pickerLabel, builtSinceLabel].filter(Boolean).join(' · ')
  // Features that set the auto-fit height scale: portfolio members only (when
  // one is active, so its buildings fill the vertical range), and — for
  // per-area metrics — not slivers, whose tiny (often coastline-clipped) area
  // yields absurd $/sqft (e.g. a 1 sqft remnant at $20k/sqft) that would
  // flatten every other bar. Excluded outliers are clamped to `maxHeight`.
  const scalesHeight = useCallback((p: ParcelProperties | null | undefined): boolean => {
    if (!p) return false
    if (metricMode === 'per_sqft' && Number(p.area_sqft ?? 0) < MIN_SCALE_AREA_SQFT) return false
    return !focusTest || focusTest(p)
  }, [metricMode, focusTest])
  const sortedVals = useMemo(() => {
    if (!data || data.length === 0) return []
    const vals: number[] = []
    for (const f of data) {
      if (!scalesHeight(f.properties)) continue
      const v = metricValue(f.properties, metricMode)
      if (v > 0) vals.push(v)
    }
    vals.sort((a, b) => a - b)
    return vals
  }, [data, metricMode, scalesHeight])
  // Set by the preload effect once all `animYr` years are fetched; max metric
  // value across every loaded year (per-feature). Falls back to `modeConf.max`
  // before the preload settles.
  const [crossYearMax, setCrossYearMax] = useState<number | null>(null)
  // All years fetched (and `crossYearMax` computed); playback holds on its
  // first frame until then, instead of animating through not-yet-loaded years.
  const [yearsReady, setYearsReady] = useState(false)
  const [yearsLoaded, setYearsLoaded] = useState(0)
  const yearsReadyRef = useRef(yearsReady)
  yearsReadyRef.current = yearsReady
  const dataMax = useMemo(() => {
    // scrns `animYr` captures need a stable scale from frame 0: the client-side
    // cross-year max once preloaded, else the mode default.
    if (animYr) return crossYearMax ?? modeConf.max
    // Animating (playback, open transport, fractional year): always one scale
    // for all years, or every integer boundary would visibly rescale all bars.
    const animating = playing || transportOpen || !Number.isInteger(year)
    // Server maxima (`/api/summary`, over this focus's members with the same
    // sliver rule as `scalesHeight`): all years by default, per year with `hy`.
    // The height clamp (`pct`) is a percentile of the loaded year, so it and a
    // portfolio ∧ region focus (no summary) fit client-side below.
    if (serverSummary && percentile == null) {
      const m = metricMode as SummaryMetric
      const v = !!perYearScale && !animating
        ? serverSummary.years.find(y => y.year === Math.round(year))?.max[m]
        : serverSummary.max[m]
      if (v) return v
    }
    if (crossYearMax != null && animating) return crossYearMax
    if (sortedVals.length === 0) return modeConf.max
    if (percentile != null) {
      return sortedVals[Math.floor(sortedVals.length * percentile / 100)] || modeConf.max
    }
    return sortedVals[sortedVals.length - 1] || modeConf.max
  }, [sortedVals, modeConf.max, percentile, year, animYr, playing, transportOpen, crossYearMax, serverSummary, perYearScale, metricMode])
  const percentilePrice = useMemo(() => {
    if (percentile == null || sortedVals.length === 0) return null
    return sortedVals[Math.floor(sortedVals.length * percentile / 100)]
  }, [percentile, sortedVals])
  const summaryAggLabel = ({
    'block': 'blocks', 'lot': 'lots', 'unit': 'units',
    'census-block': 'census blocks', 'ward': 'wards',
  } as Record<string, string>)[aggregateMode] ?? aggregateMode
  // Mid-tween, `dataMax` already reflects the target year once its data has
  // swapped in (before that, t=0), so lerping from the start fit lands exactly
  // on the target fit.
  const tweenedMax = yearTween ? yearTween.fromMax + (dataMax - yearTween.fromMax) * yearTween.t : dataMax
  tweenedMaxRef.current = tweenedMax
  const heightScale = maxHeight / tweenedMax
  // Freeze height scale while loading to prevent stale data rendered with new-mode elevation
  const stableHeightScaleRef = useRef(heightScale)
  if (!loading) stableHeightScaleRef.current = heightScale
  // Polygons are only extruded in per-area/per-capita 3D: total-$ mode keeps
  // them flat and puts the height on uniform columns instead.
  const polysExtruded = extruded && !isTotal
  // Effective color scale: URL value if explicitly set, else mode default (overridden by yr_built config)
  const colorByYrBuilt = colorBy === 'yr_built' && (aggregateMode === 'lot' || aggregateMode === 'unit')
  const colorConf = colorByYrBuilt ? YR_BUILT_CONFIG : modeConf
  const colorMin = colorConf.min ?? 0
  const colorMax = colorConf.max
  const colorScale = colorScaleRaw ?? colorConf.scale ?? 'log'

  // Color stops: use custom (from URL `c`) → mode-specific → theme defaults
  const { actualTheme, toggleTheme, colorStops: themeStops, hasCustomStops, setColorStops, resetColorStops: resetColorStopsRaw } = useTheme()
  const modeStops = useMemo(() => {
    if (colorConf.stops) return actualTheme === 'light' ? colorConf.stops.light : colorConf.stops.dark
    return null
  }, [colorConf, actualTheme])
  const colorStops = hasCustomStops ? themeStops : (modeStops ?? themeStops)

  // Reset: clear custom stops from URL; mode stops or theme defaults will apply
  const resetColorStops = useCallback(() => {
    resetColorStopsRaw()
  }, [resetColorStopsRaw])

  // Color-by switching: save/restore custom stops + scale to/from SS when toggling yr_built
  const switchColorBy = useCallback((newCb: string) => {
    const oldCb = colorBy
    if (oldCb === newCb) return
    // Save current custom stops + scale to SS under cb:{mode}
    if (hasCustomStops) ssSave(`cb:${oldCb}`, 'c', encodeStops(colorStops))
    if (colorScaleRaw != null) ssSave(`cb:${oldCb}`, 'scale', colorScaleRaw)
    // Clear URL (defaults for new mode will apply)
    resetColorStopsRaw()
    setColorScaleRaw(undefined)
    // Restore new mode's customizations from SS
    const savedC = ssLoad(`cb:${newCb}`, 'c')
    if (savedC) { const stops = decodeStops(savedC); if (stops) setColorStops(stops) }
    const savedScale = ssLoad(`cb:${newCb}`, 'scale')
    setColorScaleRaw(savedScale ? savedScale as ScaleType : undefined)
    setColorBy(newCb)
  }, [colorBy, hasCustomStops, colorStops, colorScaleRaw, resetColorStopsRaw, setColorStops, setColorScaleRaw, setColorBy])

  // Mode-aware switching: save customizations to SS, clear URL params for new mode
  const switchToMode = useCallback((newAgg: string, newMetric: string) => {
    const oldKey = getModeKey(aggregateMode, metricMode)
    // Save current customizations to SS (only if user changed from default)
    if (maxHeightRaw != null) ssSave(oldKey, 'mh', String(maxHeight))
    if (colorScaleRaw != null) ssSave(oldKey, 'scale', colorScaleRaw)
    if (percentileRaw != null) ssSave(oldKey, 'pct', String(percentileRaw))
    if (columnRadiusRaw != null) ssSave(oldKey, 'cr', String(columnRadiusRaw))

    // per_capita needs population data; per_sqft / total work everywhere
    const effectiveMetric = effectiveMetricFor(newAgg, newMetric)
    const newKey = getModeKey(newAgg, effectiveMetric)

    // Restore from SS if user previously customized this mode, else clear (use defaults)
    const savedMh = ssLoad(newKey, 'mh')
    setMaxHeightRaw(savedMh ? Number(savedMh) : undefined)
    const savedScale = ssLoad(newKey, 'scale')
    setColorScaleRaw((savedScale as ScaleType) ?? undefined)
    const savedPct = ssLoad(newKey, 'pct')
    // Total-$ mode must NOT clamp by default: clamping flattens every block
    // above the cutoff to the same height, so the $80.8M block and the $19.3M
    // block would render identically — exactly the comparison the mode exists
    // for. Height stays linear and unclamped; the log color ramp is what keeps
    // the (much smaller) typical blocks distinguishable.
    const defaultPct = (newAgg === 'unit' && effectiveMetric !== 'total') ? 99 : undefined
    setPercentileRaw(savedPct ? Number(savedPct) : defaultPct)
    const savedCr = ssLoad(newKey, 'cr')
    setColumnRadiusRaw(savedCr ? Number(savedCr) : undefined)

    // Clear custom color stops; mode stops or theme defaults will apply
    if (hasCustomStops) resetColorStopsRaw()
  }, [aggregateMode, metricMode, maxHeight, maxHeightRaw, colorScaleRaw, percentileRaw, columnRadiusRaw, hasCustomStops, resetColorStopsRaw, setColorScaleRaw, setColumnRadiusRaw, setMaxHeightRaw, setPercentileRaw])

  const setAggregateMode = useCallback((newAgg: string) => {
    if (newAgg === aggregateMode) return
    setLoading(true)
    // Reset color-by when leaving lot/unit (saves yr_built gradient to SS first)
    if (colorBy === 'yr_built' && newAgg !== 'lot' && newAgg !== 'unit') {
      switchColorBy('metric')
    }
    if (builtSinceRaw && newAgg !== 'lot' && newAgg !== 'unit') setBuiltSince(undefined)
    const newMetric = effectiveMetricFor(newAgg, metricMode)
    switchToMode(newAgg, newMetric)
    setAggregateModeRaw(newAgg)
    if (newMetric !== metricMode) setMetricModeRaw(newMetric)
  }, [aggregateMode, switchToMode, metricMode, colorBy, switchColorBy, builtSinceRaw, setBuiltSince, setAggregateModeRaw, setMetricModeRaw])

  const setMetricMode = useCallback((newMetric: string) => {
    switchToMode(aggregateMode, newMetric)
    setMetricModeRaw(newMetric)
  }, [switchToMode, aggregateMode, setMetricModeRaw])

  // URL is source of truth for initial load; local state for smooth rendering
  const [urlView_, setUrlView] = useUrlState('v', viewParam)
  const urlView = urlView_ ?? DEFAULT_VIEW
  const [viewState, setViewState] = useState<ViewState>(urlView)
  // Expose setViewState for external tools (e.g. scrns screencast automation)
  useEffect(() => {
    window.__setViewState = (partial: Partial<ViewState>) => {
      setViewState(v => ({ ...v, ...partial }))
    }
    return () => { delete window.__setViewState }
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

  // Browser-zoom / DPR robustness. On ⌘+ / ⌘- (and monitor moves) the device
  // pixel ratio and CSS viewport change. luma.gl only resizes deck's drawing
  // buffer inside its ResizeObserver handler, which can throw on the
  // `device.limits` race (swallowed in main.tsx) — leaving a stale buffer (and
  // a squashed / partly blank map) until a manual refresh; `deck.redraw()`
  // alone doesn't resize it. So on any DPR change (resolution media query) or
  // window resize we: resize maplibre, compare deck's canvas backing store to
  // its CSS size × DPR and force `setDrawingBufferSize` if it's stale, then
  // redraw. Re-checked next frame and after 150ms so a late throw can't strand
  // it. When luma already did its job this is a no-op beyond a redraw.
  const deckRef = useRef<DeckGLRef>(null)
  const mapRef = useRef<MapRef>(null)
  useEffect(() => {
    let mql: MediaQueryList | null = null
    const nudge = () => {
      try { mapRef.current?.getMap().resize() } catch { /* map not ready */ }
      const deck = deckRef.current?.deck
      const cc = deck?.device?.canvasContext
      const canvas = cc?.canvas
      if (cc && canvas instanceof HTMLCanvasElement && canvas.clientWidth > 0) {
        const dpr = window.devicePixelRatio || 1
        const w = Math.round(canvas.clientWidth * dpr)
        const h = Math.round(canvas.clientHeight * dpr)
        // ±2px slack: luma sizes from `device-pixel-content-box`, which can
        // round differently from clientWidth × DPR.
        if (Math.abs(canvas.width - w) > 2 || Math.abs(canvas.height - h) > 2) {
          cc.setDrawingBufferSize(w, h)
        }
      }
      try { deck?.redraw('dpr-resize') } catch { /* deck not ready */ }
    }
    const scheduleNudge = () => {
      nudge()
      requestAnimationFrame(nudge)
      window.setTimeout(nudge, 150)
    }
    const onDprChange = () => { scheduleNudge(); subscribe() }
    const subscribe = () => {
      mql?.removeEventListener('change', onDprChange)
      // Matches only at the current DPR; unmatches (fires `change`) when DPR moves.
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onDprChange)
    }
    subscribe()
    window.addEventListener('resize', scheduleNudge)
    return () => {
      window.removeEventListener('resize', scheduleNudge)
      mql?.removeEventListener('change', onDprChange)
    }
  }, [])

  // Neighborhoods present in the loaded features (for omnibar region actions).
  const hoods = useMemo(() => hoodsOf(data), [data])
  const focusOptions = useMemo((): FocusOption[] => [
    { value: '', label: 'Citywide', keywords: ['all', 'city', 'clear'] },
    ...portfolios.map(p => ({ value: `pf:${p.key}`, label: p.label, group: 'Developers', keywords: [p.key, ...(p.keywords ?? [])] })),
    ...WARDS.map(w => ({ value: `rg:ward:${w}`, label: `Ward ${w}`, group: 'Wards' })),
    ...hoods.map(h => {
      const slug = HOOD_SLUGS[h]
      return { value: `rg:hood:${h}`, label: h, group: 'Neighborhoods', keywords: slug ? [slug, `${slug}na`] : [] }
    }),
  ], [portfolios, hoods])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    year, setYear: goToYear,
    aggregateMode, setAggregateMode,
    hasPopulation, metricMode, setMetricMode,
    setSettingsOpen,
    setViewState,
    setMaxHeightRaw,
    modeMaxHeight: modeConf.maxHeight,
    toggleTheme,
    wardLabels, setWardLabels,
    wardGeom, setWardGeom,
    colorByYrBuilt, switchColorBy,
    settingsPos, setSettingsPos,
    extruded, setExtruded,
    portfolios, setPortfolio,
    hoods, setRegion,
    playing, togglePlay,
  })

  // Two-finger pitch gesture for mobile (deck.gl's built-in multipan is broken)
  const isPitchingRef = useTouchPitch({ setViewState, maxPitch: 85 })

  // Omnibar search over parcels
  const onParcelSelect = useCallback((f: ParcelFeature) => {
    setSelectedId(featureIdOf(f))
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
  }, [setSelectedId, setViewState])
  // An address hit (lot-level, from the server): show it in lot view.
  const onAddress = useCallback((hit: AddressHit) => {
    if (aggregateMode !== 'lot') setAggregateMode('lot')
    setSelectedId(hit.id)
    setViewState(v => ({
      ...v,
      longitude: hit.lng,
      latitude: hit.lat,
      zoom: Math.max(v.zoom, 16),
      transitionDuration: 500,
      transitionInterpolator: new FlyToInterpolator(),
    }))
  }, [aggregateMode, setAggregateMode, setSelectedId, setViewState])
  useParcelSearch({ data, onSelect: onParcelSelect, onAddress })

  // Per-(agg, year) feature cache + id maps. Populated lazily on year/agg
  // changes; preloaded eagerly when ?animYr is set (so frame-by-frame
  // scrns recordings never re-fetch mid-animation and never flash a spinner).
  const yearCacheRef = useRef<Map<string, ParcelFeature[]>>(new Map())
  const yearIdMapsRef = useRef<Map<string, Map<string, ParcelFeature>>>(new Map())
  const cacheKey = useCallback((agg: string, yr: number) => `${agg}|${yr}`, [])
  // In flight, so a year requested again before it lands (e.g. the start year
  // by the playback preload) shares one download.
  const yearPendingRef = useRef<Map<string, Promise<ParcelFeature[]>>>(new Map())
  const fetchYear = useCallback((agg: string, yr: number): Promise<ParcelFeature[]> => {
    const key = cacheKey(agg, yr)
    const cached = yearCacheRef.current.get(key)
    if (cached) return Promise.resolve(cached)
    const pending = yearPendingRef.current.get(key)
    if (pending) return pending
    const p = (async () => {
      let features: ParcelFeature[]
      if (isBundled(agg)) {
        features = await yearFeatures(agg, yr)
      } else {
        const suffix = SUFFIX_MAP[agg] ?? '-lots'
        const geojson = await fetch(dvcResolve(`taxes-${yr}${suffix}.geojson`)).then(r => r.json())
        features = geojson.features
      }
      yearCacheRef.current.set(key, features)
      const idMap = new Map<string, ParcelFeature>()
      features.forEach(f => idMap.set(featureIdOf(f), f))
      yearIdMapsRef.current.set(key, idMap)
      return features
    })().finally(() => yearPendingRef.current.delete(key))
    yearPendingRef.current.set(key, p)
    return p
  }, [cacheKey])

  // Track whether the in-flight fetch is a year-only change (smooth transition,
  // keep showing stale bars) vs. an aggregation change (gray out — geometry differs).
  const prevAggRef = useRef(aggregateMode)
  const yearOnlyChangeRef = useRef(false)
  // Only re-run on integer boundary crossings (or agg switch), not on every
  // sub-year tick. The interpolation accessor reads ceil-year features straight
  // from `yearIdMapsRef`, so a sub-year change needs no data/state update —
  // forcing one would re-run this effect ~30x/sec during recordings and trip
  // deck.gl's WebGL context init race on some browsers.
  const yearFloor = Math.floor(year)
  const yearCeil = Math.ceil(year)
  useEffect(() => {
    const aggChanged = prevAggRef.current !== aggregateMode
    yearOnlyChangeRef.current = !aggChanged
    prevAggRef.current = aggregateMode
    const needed = yearFloor === yearCeil ? [yearFloor] : [yearFloor, yearCeil]
    const ensureLoaded = () => Promise.all(needed.map(y => fetchYear(aggregateMode, y)))
    // Fractional mode (recording / animation): if we already have `data` for
    // this agg, keep it as-is — the interpolation accessor reads adjacent
    // years from the cache by id, so swapping `data` at integer boundaries
    // would only introduce a one-frame flicker before the new data settles.
    if (yearFloor !== yearCeil && data && !aggChanged) {
      ensureLoaded().catch(() => {})
      setLoading(false)
      return
    }
    const allCached = needed.every(y => yearCacheRef.current.has(cacheKey(aggregateMode, y)))
    if (allCached) {
      setData(yearCacheRef.current.get(cacheKey(aggregateMode, yearFloor)) ?? null)
      setLoading(false)
      yearOnlyChangeRef.current = false
      return
    }
    setLoading(true)
    ensureLoaded()
      .then(() => {
        setData(yearCacheRef.current.get(cacheKey(aggregateMode, yearFloor)) ?? null)
        setLoading(false)
        yearOnlyChangeRef.current = false
      })
      .catch((e) => {
        console.error('Failed to load parcels:', e)
        setLoading(false)
        yearOnlyChangeRef.current = false
      })
  }, [yearFloor, yearCeil, aggregateMode, fetchYear, cacheKey, data])

  // Preload all years when ?animYr is set, so every frame of the recording
  // is served from cache and no spinner ever appears mid-animation. After all
  // fetches resolve, compute the global per-feature max across every loaded
  // year so the height scale is stable AND large enough to fit the tallest
  // bar of any year — without this, ward mode (where `modeConf.max=10` is a
  // color clamp but Ward E reaches ~$21/sqft in recent years) overshoots
  // `maxHeight` by ~2x and runs off the top of the viewport.
  // (`crossYearMax` state is declared earlier in the file so `dataMax` can read it.)
  const preloadAll = !!animYr || !!playing || transportOpen
  useEffect(() => {
    setCrossYearMax(null)
    setYearsReady(false)
    if (!preloadAll) return
    let cancelled = false
    let loaded = 0
    setYearsLoaded(0)
    Promise.all(AVAILABLE_YEARS.map(y => fetchYear(aggregateMode, y).catch(() => null).then(r => {
      if (!cancelled) setYearsLoaded(++loaded)
      return r
    })))
      .then(() => {
        if (cancelled) return
        let m = 0
        for (const y of AVAILABLE_YEARS) {
          const features = yearCacheRef.current.get(cacheKey(aggregateMode, y))
          if (!features) continue
          for (const f of features) {
            if (!scalesHeight(f.properties)) continue
            const v = metricValue(f.properties, metricMode)
            if (v > m) m = v
          }
        }
        // Settle before starting the clock: let the GC from parsing every
        // year's GeoJSON (tens of MB in lot view) run, so the first animated
        // years don't stutter. The scale and readiness flip together, so the
        // player's rescale coincides with its jump to the start year.
        const idle = (cb: () => void) => 'requestIdleCallback' in window
          ? window.requestIdleCallback(cb, { timeout: 1500 })
          : setTimeout(cb, 500)
        requestAnimationFrame(() => idle(() => {
          if (cancelled) return
          setCrossYearMax(m || null)
          setYearsReady(true)
        }))
      })
    return () => { cancelled = true }
  }, [preloadAll, aggregateMode, metricMode, fetchYear, cacheKey, scalesHeight])

  // In-app animation player. When `playing`, a rAF loop advances a fractional
  // year (`playYear`) in real time, which drives the existing per-feature
  // interpolation in getMetricValue / getBarElevation / getFillColor. All years
  // are already preloaded (effect above), so no spinner appears mid-animation.
  // The loop writes only local state — the URL isn't touched until playback ends
  // or the user commits — so 60fps ticks don't hit history.replaceState limits.
  const yearRef = useRef(year)
  yearRef.current = year
  useEffect(() => {
    if (!playing) return
    const first = AVAILABLE_YEARS[0]
    const last = YEAR_MAX
    // Start from the current year, but restart from the first year if we're
    // parked at (or past) the default latest-complete year, so pressing play on
    // the landing view plays the whole history.
    let pos = yearRef.current
    if (pos >= DEFAULT_YEAR) pos = first
    let raf = 0
    let prev: number | null = null
    let started = false
    const tick = (t: number) => {
      // Buffering: hold the current view (year + scale) until every year is
      // loaded, then jump to the start year in the same frame the cross-year
      // scale applies.
      if (!yearsReadyRef.current) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (!started) {
        started = true
        setPlayYear(pos)
        prev = null
      }
      if (prev != null) {
        const dt = Math.min((t - prev) / 1000, 0.1)
        pos += dt * playSpeed
        if (pos >= last) {
          setPlayYear(null)
          setUrlYear(last)
          setPlaying(false)
          return
        }
        setPlayYear(pos)
      }
      prev = t
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, playSpeed, setPlaying, setUrlYear])

  const tweenFrom = yearTween?.from, tweenTo = yearTween?.to
  useEffect(() => {
    if (tweenFrom == null || tweenTo == null) return
    let raf = 0
    let start: number | null = null
    const tick = (now: number) => {
      const loaded = [tweenFrom, tweenTo].every(y => yearIdMapsRef.current.has(cacheKey(aggregateMode, y)))
      if (loaded) {
        start ??= now
        const u = Math.min(1, (now - start) / YEAR_TWEEN_MS)
        if (u >= 1) { setYearTween(null); return }
        const t = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2
        setYearTween(tw => tw && { ...tw, t })
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tweenFrom, tweenTo, aggregateMode, cacheKey])
  // Switching view / metric mid-tween: just land on the target.
  useEffect(() => { setYearTween(null) }, [aggregateMode, metricMode])

  // Expose imperative year setter for scrns `animate` actions (per-frame
  // fractional-year stepping). Uses the raw URL setter so it neither cancels
  // nor is cancelled by the in-app player. Matches the `window.__setViewState`
  // pattern used by `cast.gif`.
  useEffect(() => {
    window.__setYear = setUrlYear
  }, [setUrlYear])


  // Default unit mode to p99 on initial load (but not unit + total-$; see
  // the clamp note in `switchToMode`)
  useEffect(() => {
    if (aggregateMode === 'unit' && metricMode !== 'total' && percentileRaw == null) {
      setPercentileRaw(99)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // For ward mode: swap geometry based on wardGeom setting. `boundary` ships
  // with the ward geometry; the "lots" / "blocks" shapes are big, so they're a
  // separate per-year file fetched only when chosen (merged shape until then).
  const altWardShapes = wardGeom === 'lots' || wardGeom === 'blocks'
  const shapesYear = Math.round(year)
  const wardShapesQ = useQuery({
    queryKey: ['ward-shapes', shapesYear],
    enabled: aggregateMode === 'ward' && altWardShapes,
    staleTime: Infinity,
    queryFn: () => loadWardShapes(shapesYear),
  })
  const effectiveData = useMemo(() => {
    if (!data || aggregateMode !== 'ward' || wardGeom === 'merged') return data
    return data.map(f => {
      const w = f.properties?.ward
      const alt = wardGeom === 'boundary'
        ? f.properties?.boundary
        : altWardShapes && w ? wardShapesQ.data?.[w]?.[wardGeom as 'lots' | 'blocks'] : undefined
      if (!alt) return f
      return { ...f, geometry: alt as ParcelFeature['geometry'] }
    })
  }, [data, aggregateMode, wardGeom, altWardShapes, wardShapesQ.data])

  // Ward label info: stable text/metadata (doesn't depend on viewState)
  type WardLabelInfo = { ward: string; text: string; metricVal: number; rings: number[][][] }
  const wardLabelInfo = useMemo((): WardLabelInfo[] => {
    if (!data || aggregateMode !== 'ward' || !wardLabels) return []
    return data.map(f => {
      const p = f.properties
      if (!p?.ward) return null
      const metricVal = metricValue(p, metricMode)
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
      // Match what the layer actually draws: flat polygons in 2D and in
      // total-$ mode (where the height lives on the columns instead).
      const elev = polysExtruded ? metricVal * heightScale : 0

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
  }, [wardLabelInfo, viewState, heightScale, polysExtruded])

  const getFeatureId = useCallback((f: ParcelFeatureLike) => {
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

  const metricOf = useCallback((f: ParcelFeatureLike): number => {
    return metricValue(f.properties, metricMode)
  }, [metricMode])

  // Per-feature metric at the (possibly fractional) `year`. For integer years
  // this is just the feature's stored value. For fractional years we look up
  // BOTH the floor and ceil years' values for this feature ID via the cache —
  // never reading the metric off `f.properties` directly. This decouples the
  // interpolation from whatever year `data` happens to be, so a year-boundary
  // setData swap can't briefly snap bars to the prior floor's values.
  //
  // The (floor, ceil) value pair is memoized per feature object for the current
  // (agg, floor, ceil, metric) bracket, so a playback frame is just a lerp per
  // accessor call instead of an id-string build + two Map lookups (which made
  // lot/unit views drop well below 60fps while playing). Pairs are only cached
  // once both years' id maps are loaded, so an early frame can't pin a 0.
  const isFractionalYear = !Number.isInteger(year)
  const pairCacheRef = useRef<{ key: string, pairs: WeakMap<object, [number, number]> }>({ key: '', pairs: new WeakMap() })
  const getMetricValue = useCallback((f: ParcelFeatureLike): number => {
    let yFloor: number, yCeil: number, t: number
    if (yearTween) {
      ({ from: yFloor, to: yCeil, t } = yearTween)
    } else if (isFractionalYear) {
      yFloor = Math.floor(year)
      yCeil = Math.ceil(year)
      t = year - yFloor
    } else {
      return metricOf(f)
    }
    const bracket = `${aggregateMode}|${yFloor}|${yCeil}|${metricMode}`
    if (pairCacheRef.current.key !== bracket) pairCacheRef.current = { key: bracket, pairs: new WeakMap() }
    const { pairs } = pairCacheRef.current
    let pair = pairs.get(f)
    if (!pair) {
      const floorMap = yearIdMapsRef.current.get(cacheKey(aggregateMode, yFloor))
      const ceilMap = yearIdMapsRef.current.get(cacheKey(aggregateMode, yCeil))
      const id = featureIdOf(f)
      const f0 = floorMap?.get(id), f1 = ceilMap?.get(id)
      pair = [f0 ? metricOf(f0) : 0, f1 ? metricOf(f1) : 0]
      if (floorMap && ceilMap) pairs.set(f, pair)
    }
    return pair[0] + (pair[1] - pair[0]) * t
  }, [metricOf, isFractionalYear, year, yearTween, aggregateMode, metricMode, cacheKey])


  // Gray-out only when geometry actually changes (agg switch). Year-only changes
  // keep the prior bars visible and let deck.gl transitions tween to the new year.
  const staleData = loading && data && !yearOnlyChangeRef.current
  // In total-$ 3D the columns carry the metric, so the footprints behind them
  // are dimmed to stay readable as context rather than competing for attention.
  const polyAlpha = isTotal && extruded ? Math.round(fillAlpha * 0.3) : fillAlpha
  // Features for the displayed (rounded) year. During playback `data` stays the
  // start year's set (the interpolation reads other years from the cache), so
  // totals must come from the per-year cache or they'd freeze at the start year.
  const yearRounded = Math.round(year)
  const parcelDetails = useParcelDetails(String(aggregateMode), selectedId ?? hoveredId, yearRounded)
  const displayData = useMemo(
    () => yearCacheRef.current.get(cacheKey(aggregateMode, yearRounded)) ?? data,
    [data, aggregateMode, yearRounded, cacheKey],
  )
  // Summary stats for the current view + displayed year (status-bar tooltip).
  // Keyed on the rounded year so fractional playback frames don't re-scan every
  // feature.
  const summary = useMemo(() => {
    if (!displayData || displayData.length === 0) return null
    // With a focus (portfolio / region / built-since) the tooltip describes the
    // lit set, matching the chip it hangs off; citywide totals ride along.
    let count = 0, paid = 0, billed = 0, area = 0, withPaid = 0, cityPaid = 0
    for (const f of displayData) {
      const p = f.properties
      if (p?.paid) cityPaid += p.paid
      if (focusTest && !focusTest(p)) continue
      count++
      if (p?.paid) { paid += p.paid; withPaid++ }
      if (p?.billed) billed += p.billed
      if (p?.area_sqft) area += p.area_sqft
    }
    const yr = displayData[0]?.properties?.year ?? yearRounded
    const city = focusTest ? { count: displayData.length, paid: cityPaid } : undefined
    return { count, paid, billed, area, withPaid, yr, city }
  }, [displayData, yearRounded, focusTest])
  const portfolioStats = useMemo(() => {
    if (!focusTest || !displayData) return null
    let count = 0, paid = 0
    for (const f of displayData) {
      const p = f.properties
      if (focusTest(p)) { count++; paid += amountOf(p) }
    }
    return { count, paid }
  }, [focusTest, displayData])
  const builtStats = useMemo(() => {
    if (!builtSince || !displayData) return null
    return builtSinceStats(displayData, builtSince, amountOf, regionFocusTest)
  }, [builtSince, displayData, regionFocusTest])

  // Per-year total (focus members, else all) for the transport sparkline: from
  // the server summary; without one (portfolio ∧ region), once the player has
  // preloaded every year.
  const yearTotals = useMemo((): [number, number][] | null => {
    if (serverSummary) return serverSummary.years.map(y => [y.year, y.amount])
    if (!yearsReady) return null
    const out: [number, number][] = []
    for (const y of AVAILABLE_YEARS) {
      const features = yearCacheRef.current.get(cacheKey(aggregateMode, y))
      if (!features) return null
      let paid = 0
      for (const f of features) {
        if (!focusTest || focusTest(f.properties)) paid += amountOf(f.properties)
      }
      out.push([y, paid])
    }
    return out
  }, [serverSummary, yearsReady, aggregateMode, cacheKey, focusTest])

  const colorOf = useCallback((f: ParcelFeatureLike, alpha: number): [number, number, number, number] => {
    if (staleData) return LOADING_COLOR
    const id = getFeatureId(f)
    if (id === selectedId) return id === hoveredId ? SELECTED_HOVER_COLOR : SELECTED_COLOR
    if (id === hoveredId) return HOVER_COLOR
    if (focusTest) {
      if (!focusTest(f.properties)) {
        return [...PORTFOLIO_DIM, Math.round(alpha * pfDim)]
      }
    }

    if (colorByYrBuilt) {
      const yr = f.properties?.yr_built
      // No recorded year: neutral grey (the gradient's oldest end is purple, so
      // grey unambiguously means "unknown", not "old").
      if (!yr) return [...YR_UNKNOWN_COLOR, Math.round(alpha * 0.6)]
      return interpolateColor(yr, colorStops, colorMax, colorScale, alpha, colorMin)
    }
    return interpolateColor(getMetricValue(f), colorStops, maxVal, colorScale, alpha)
  }, [staleData, colorStops, colorScale, maxVal, hoveredId, selectedId, getFeatureId, getMetricValue, colorByYrBuilt, colorMax, colorMin, focusTest, pfDim])
  const getFillColor = useCallback((f: ParcelFeatureLike) => colorOf(f, polyAlpha), [colorOf, polyAlpha])
  const getColumnColor = useCallback((f: ParcelFeatureLike) => colorOf(f, fillAlpha), [colorOf, fillAlpha])

  const getBarElevation = useCallback((f: ParcelFeatureLike): number => {
    return Math.min(getMetricValue(f) * stableHeightScaleRef.current, maxHeight)
  }, [getMetricValue, maxHeight])

  // Column anchors: cached per feature object (features are shared from the
  // per-(agg, year) cache, so this is computed once per parcel per geometry).
  const anchorCache = useRef(new WeakMap<ParcelFeature, [number, number]>())
  const getColumnPosition = useCallback((f: ParcelFeature): [number, number] => {
    const cached = anchorCache.current.get(f)
    if (cached) return cached
    const c = columnAnchorOf(f.geometry)
    anchorCache.current.set(f, c)
    return c
  }, [])

  const onFeatureHover = useCallback(({ object }: { object?: ParcelFeatureLike }) => {
    if (suppressHoverRef.current) return
    if (object) {
      setHoveredId(getFeatureId(object))
      setHovered(object.properties ?? null)
    } else {
      setHoveredId(null)
      setHovered(null)
    }
  }, [getFeatureId])
  const onFeatureClick = useCallback(({ object }: { object?: ParcelFeatureLike }) => {
    if (!object) return false
    const id = getFeatureId(object)
    setSelectedId(id === selectedIdRef.current ? undefined : id)
    suppressHoverRef.current = true
    setHoveredId(null)
    setHovered(null)
    setTimeout(() => { suppressHoverRef.current = false }, 100)
    return true
  }, [getFeatureId, setSelectedId])

  // With a portfolio active, non-members are drawn translucent. If they also
  // wrote depth, whether a faded tower in front hid a highlighted member behind
  // it would depend on draw order (often fully occluding it). So split into two
  // layers: faded non-members first with depth writes off (luma.gl v9
  // `depthWriteEnabled`), then members with normal depth — members are never
  // hidden by faded geometry. Both stay pickable with the same id scheme, so
  // hover / select work across them. Without a portfolio: one layer, as before.
  // Fly to the focus set when the user picks a new portfolio / region (skipped
  // for the focus present at load, so a shared link's camera is kept).
  // A focus in the URL without a camera (`v`) gets a focus-fit initial view,
  // applied (without animation) before anything renders.
  const urlHadViewRef = useRef(new URLSearchParams(window.location.search).has('v'))
  const [initialFitDone, setInitialFitDone] = useState(() => urlHadViewRef.current || !(portfolio || region))
  const fitFocusRef = useRef<string | null>(null)
  const titleRef = useRef<HTMLDivElement>(null)
  const focusKey = `${portfolio}|${region}`
  useEffect(() => {
    if (!displayData?.length) return
    if (portfolio && portfoliosOrNull === null) return
    // Bar heights scale to the summary's max: fit once it's in.
    if (summaryQ.isLoading) return
    const initial = fitFocusRef.current === null
    if (!initial && fitFocusRef.current === focusKey) return
    fitFocusRef.current = focusKey
    if (initial && urlHadViewRef.current) { setInitialFitDone(true); return }
    const all = focusTest ? displayData.filter(f => focusTest(f.properties)) : []
    // Frame members with a bar; zero-tax parcels (bay / river lots) would
    // stretch the fit over water.
    const nonzero = all.filter(f => getBarElevation(f) > 0)
    const members = nonzero.length ? nonzero : all
    const bounds = boundsOf(members)
    if (bounds) {
      const extrudedNow = polysExtruded || (isTotal && extruded)
      // Large focuses (wards) let rare outlier bars run off the top, so one
      // tower doesn't shrink the rest.
      const hs = members.map(f => getBarElevation(f))
      const sorted = [...hs].sort((a, b) => a - b)
      const cap = hs.length >= 20 ? 1.5 * sorted[Math.floor(0.95 * (sorted.length - 1))] : Infinity
      const tops: [number, number, number][] = extrudedNow
        ? members.map((f, i) => {
          const b = boundsOf([f])!
          return [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2, Math.min(hs[i], cap)]
        })
        : []
      setViewState(v => {
        const width = window.innerWidth, height = window.innerHeight
        // Fit the extruded box (footprint × tallest bar) into the screen area
        // left free by the title / chip overlay and the bottom controls.
        // `clean` captures have no overlays: fill the whole image.
        const pad = clean ? 12 : Math.min(40, width / 12)
        const top = clean ? pad : (titleRef.current?.getBoundingClientRect().bottom ?? 120) + 12
        const frame = { left: pad, right: width - pad, top, bottom: height - (clean ? pad : 70) }
        const pitch = Math.max(Number(v.pitch), FOCUS_PITCH)
        const cam = fit3d(bounds, tops, { pitch, bearing: Number(v.bearing) }, { width, height }, frame)
        return {
          ...v, ...cam,
          ...(initial
            ? { transitionDuration: 0 }
            : { transitionDuration: 800, transitionInterpolator: new FlyToInterpolator() }),
        }
      })
    }
    setInitialFitDone(true)
  }, [focusKey, focusTest, displayData, setViewState, portfolio, portfoliosOrNull, getBarElevation, polysExtruded, isTotal, extruded, clean, summaryQ.isLoading])

  const [memberData, fadedData] = useMemo((): [ParcelFeature[], ParcelFeature[]] => {
    const all = effectiveData ?? []
    if (!focusTest) return [all, []]
    const members: ParcelFeature[] = [], faded: ParcelFeature[] = []
    for (const f of all) {
      const p = f.properties
      ;(focusTest(p) ? members : faded).push(f)
    }
    // Faded at 0%: non-members are hidden outright (not drawn, not pickable).
    return [members, pfDim > 0 ? faded : []]
  }, [effectiveData, focusTest, pfDim])
  const FADED_PARAMS = { depthWriteEnabled: false }
  const fillColorTriggers = [year, yearTween?.t, maxVal, colorStops, colorScale, hoveredId, selectedId, aggregateMode, actualTheme, metricMode, staleData, colorBy, colorMin, colorMax, portfolio, region, pfDim]
  const elevationTriggers = [year, yearTween?.t, stableHeightScaleRef.current, aggregateMode, metricMode, maxHeight]
  const parcelLayer = (id: string, layerData: ParcelFeature[], faded: boolean) => new GeoJsonLayer<ParcelProperties>({
    id,
    data: layerData,
    filled: true,
    extruded: polysExtruded,
    wireframe: polysExtruded,
    getFillColor,
    getElevation: polysExtruded ? getBarElevation : 0,
    // No deck.gl tweens — both browser-time year flips and scrns fractional
    // sweeps rely on per-feature interpolation in getMetricValue (instant).
    // Toggling transitions shape per render triggered a luma.gl WebGL init
    // race that blanked the canvas on subsequent frames.
    transitions: undefined,
    getLineColor: lineColor,
    lineWidthMinPixels: 1,
    pickable: true,
    onHover: onFeatureHover,
    onClick: onFeatureClick,
    ...(faded && { parameters: FADED_PARAMS }),
    updateTriggers: {
      getFillColor: [...fillColorTriggers, polyAlpha],
      getElevation: elevationTriggers,
      getLineColor: [actualTheme],
    },
  })
  // Total-$ 3D: one uniform footprint per parcel, height ∝ dollars paid.
  // Extruding the polygons themselves would make bar *volume* ∝ dollars ×
  // area, so a big cheap lot could out-loom a small expensive one.
  const columnLayer = (id: string, layerData: ParcelFeature[], faded: boolean) => new ColumnLayer<ParcelFeature>({
    id,
    data: layerData,
    diskResolution: 12,
    radius: columnRadius,
    radiusUnits: 'meters',
    extruded: true,
    filled: true,
    stroked: false,
    pickable: true,
    getPosition: getColumnPosition,
    getFillColor: getColumnColor,
    getElevation: getBarElevation,
    transitions: undefined,
    onHover: onFeatureHover,
    onClick: onFeatureClick,
    ...(faded && { parameters: FADED_PARAMS }),
    updateTriggers: {
      getPosition: [aggregateMode, wardGeom],
      getFillColor: fillColorTriggers,
      getElevation: elevationTriggers,
    },
  })
  const showColumns = isTotal && extruded
  // Hold rendering (spinner) until the first frame would be the intended one:
  // portfolio list loaded (for `pf`) and focus camera fitted. An autoplay link
  // still renders its start year right away; only the play clock waits for the
  // remaining years (spinner + n/11 in the transport), since buffering every
  // year can take a while on a slow connection.
  const holdRender = (!!portfolio && portfoliosOrNull === null) || !initialFitDone || summaryQ.isLoading
  const layers = holdRender ? [] : [
    ...(fadedData.length ? [parcelLayer('parcels-faded', fadedData, true)] : []),
    ...(showColumns && fadedData.length ? [columnLayer('total-columns-faded', fadedData, true)] : []),
    parcelLayer('parcels', memberData, false),
    ...(showColumns ? [columnLayer('total-columns', memberData, false)] : []),
  ]

  const inputStyle = {
    background: 'var(--input-bg)',
    color: 'var(--text-primary)',
    border: '1px solid var(--input-border)',
    borderRadius: 4,
    padding: '4px 8px',
    fontSize: 14,
  }

  const settingsPanel = (
    <div
      style={{
        background: 'var(--panel-bg)',
        color: 'var(--text-primary)',
        borderRadius: 4,
        fontSize: 14,
        minWidth: settingsOpen ? 240 : undefined,
        maxWidth: '90vw',
      }}
    >
      {/* Collapsed: a gear icon only (keeps clear of the centered title);
          expanded: "Settings" header with a collapse caret. */}
      <div
        onClick={() => setSettingsOpen(v => !v)}
        role="button"
        aria-label={settingsOpen ? 'Collapse settings' : 'Settings'}
        title={settingsOpen ? 'Collapse settings (s)' : 'Settings (s)'}
        style={{
          padding: settingsOpen ? '8px 15px' : 8,
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
          userSelect: 'none',
        }}
      >
        <MdSettings size={settingsOpen ? 16 : 22} style={{ opacity: 0.9 }} />
        {!!settingsOpen && <>
          <span style={{ fontWeight: 'bold', flex: 1 }}>Settings</span>
          <span style={{ fontSize: 10 }}>{'\u25B2'}</span>
        </>}
      </div>
      {settingsOpen && (
        <div style={{ padding: '0 15px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: 'var(--text-secondary)' }}>Color Gradient</div>
            <GradientEditor
              stops={colorStops}
              setStops={setColorStops}
              scale={colorScale}
              setScale={(s) => setColorScaleRaw(s === (colorConf.scale ?? 'log') ? undefined : s)}
              max={colorMax}
              min={colorMin}
              prefix={colorByYrBuilt ? '' : '$'}
              onReset={hasCustomStops ? resetColorStops : undefined}
              metricLabel={colorByYrBuilt ? '' : metricLabel}
              format={isTotal && !colorByYrBuilt ? abbr : undefined}
            />
            <details style={{ marginTop: 4 }}>
              <summary style={{ fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                Distribution
              </summary>
              <DistributionChart
                values={sortedVals}
                percentile={percentile}
                max={dataMax}
                prefix={colorByYrBuilt ? '' : '$'}
                metricLabel={colorByYrBuilt ? '' : metricLabel}
                format={isTotal && !colorByYrBuilt ? abbr : undefined}
                binScale={isTotal && !colorByYrBuilt ? 'log' : 'linear'}
              />
            </details>
          </div>
          {(aggregateMode === 'lot' || aggregateMode === 'unit') && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={colorByYrBuilt}
                onChange={(e) => switchColorBy(e.target.checked ? 'yr_built' : 'metric')}
              />
              Color by year built
            </label>
          )}
          {(aggregateMode === 'lot' || aggregateMode === 'unit') && (
            <label title="Light parcels built in or after a year; dim the rest">
              Built since:{' '}
              <select
                aria-label="Built since"
                value={builtSince ?? ''}
                onChange={(e) => setBuiltSince(e.target.value ? Number(e.target.value) : undefined)}
                style={inputStyle}
              >
                <option value="">Off</option>
                {Array.from({ length: YEAR_MAX - BUILT_SINCE_MIN + 1 }, (_, i) => YEAR_MAX - i).map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
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
          {extruded && isTotal && <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              Bar radius:{' '}
              <input
                type="number"
                value={columnRadius}
                onChange={(e) => {
                  const m = Number(e.target.value)
                  if (!m || m <= 0) return
                  setColumnRadiusRaw(m === modeColumnRadius ? undefined : m)
                }}
                style={{ ...inputStyle, width: 60 }}
                min={1}
                step={5}
              />
              <span>m</span>
              {columnRadiusRaw !== undefined && (
                <button
                  onClick={() => setColumnRadiusRaw(undefined)}
                  title="Reset to default"
                  style={{ ...inputStyle, cursor: 'pointer', padding: '2px 6px', fontSize: 14 }}
                >
                  ↺
                </button>
              )}
            </label>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: -4 }}>
              Every bar has the same footprint, so height alone tracks total $.
            </div>
          </>}
          {extruded && <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="Off: one height scale across all years, so growth over time shows. On: each year's tallest bar fills the max height.">
              <input
                type="checkbox"
                checked={!!perYearScale}
                onChange={(e) => setPerYearScale(e.target.checked)}
              />
              Scale heights per year
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={percentile != null}
                onChange={(e) => setPercentileRaw(e.target.checked ? 99 : undefined)}
              />
              Height clamp
            </label>
            {percentile != null && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input
                  type="number"
                  value={percentile}
                  min={50}
                  max={100}
                  step={1}
                  onChange={(e) => setPercentileRaw(Number(e.target.value))}
                  style={{ ...inputStyle, width: 50 }}
                />
                <span>th percentile</span>
                {percentilePrice != null && (
                  <span style={{ color: 'var(--text-secondary)' }}>
                    = {fmtMetric(percentilePrice)}{metricLabel}
                  </span>
                )}
              </div>
            )}
          </>}
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
          {focusTest && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }} title="Opacity of parcels outside the active portfolio">
              Faded: {Math.round(pfDim * 100)}%
              <input
                type="range"
                min={0}
                max={0.6}
                step={0.02}
                value={pfDim}
                onChange={(e) => setPfDim(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div style={{ width: '100vw', height: '100vh', WebkitTouchCallout: 'none' }} onContextMenu={e => e.preventDefault()} {...(!loading && { 'data-loaded': aggregateMode })}>
      <DeckGL
        ref={deckRef}
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
        <MaplibreMap
          ref={mapRef}
          mapStyle={mapStyle}
          maxPitch={85}
          attributionControl={false}
        />
      </DeckGL>
      {(loading || holdRender) && (
        <div className="loading-overlay">
          <div className="loading-spinner" />
        </div>
      )}

      {/* Plot title — top-center. The tax year is a live control in the
          subtitle (‹ year ›), the primary way to change years. When a portfolio (`pf`) is active its label +
          aggregate total fold in as a chip right under the subtitle, with a ✕
          to clear. In animation context (?animYr) the year becomes a big
          odometer readout instead of the interactive control. */}
      {showTitle && (() => {
        const aggLabel = AGG_NOUN[String(aggregateMode)]?.[0] ?? String(aggregateMode)
        const headline = colorByYrBuilt ? 'Jersey City Parcels' : 'Jersey City Property Taxes'
        const subPrefix = colorByYrBuilt
          ? 'Colored by year built'
          : isTotal
            ? `Total paid · by ${aggLabel}`
            : `${isBilledYear(year) ? 'Billed' : 'Paid'} per ${metricMode === 'per_capita' ? 'capita' : 'sq ft'} · by ${aggLabel}`
        const isAnim = !!animYr
        const titleStyle = {
          position: 'absolute' as const,
          top: 10,
          left: '50%',
          transform: 'translateX(-50%)',
          textAlign: 'center' as const,
          color: 'white',
          textShadow: '0 1px 2px rgba(0,0,0,0.85), 0 0 6px rgba(0,0,0,0.6)',
          pointerEvents: 'none' as const,
          fontFamily: 'Inter, sans-serif',
          zIndex: 1,
          maxWidth: 'calc(100% - 20px)',
        }
        // Focus picker + totals chip: [Citywide / portfolio / ward / hood ▾] · $ · count.
        // Totals track the displayed (rounded) year, so they move with playback.
        const billedYr = isBilledYear(year)
        const serverYear = serverSummary?.years.find(y => y.year === yearRounded)
        const chipStats = serverYear ? { count: serverYear.count, paid: serverYear.amount }
          : focusTest ? portfolioStats
          : summary && { count: summary.count, paid: billedYr ? summary.billed : summary.paid }
        const noun = chipStats?.count === 1 ? AGG_NOUN[String(aggregateMode)]?.[0] : AGG_NOUN[String(aggregateMode)]?.[1]
        const focusValue = portfolio ? `pf:${portfolio}` : region ? `rg:${region}` : ''
        const onFocus = (v: string) => {
          if (v.startsWith('pf:')) { setRegion(''); setPortfolio(v.slice(3)) }
          else if (v.startsWith('rg:')) { setPortfolio(''); setRegion(v.slice(3)) }
          else { setPortfolio(''); setRegion('') }
        }
        const opt = (value: string, label: string) => <option key={value} value={value} style={{ color: '#111' }}>{label}</option>
        const big = transportOpen
        const statsChip = (
          <div style={{ marginTop: big ? 0 : 8, textAlign: 'center' }}>
            <span
              style={{
                pointerEvents: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap',
                maxWidth: '92vw',
                background: 'rgba(0,0,0,0.72)', color: 'white', padding: '5px 8px 5px 12px',
                borderRadius: 999, fontSize: big ? 19 : 15, fontFamily: 'Inter, sans-serif',
                border: '1px solid rgba(255,255,255,0.25)', textShadow: 'none',
              }}
            >
              <FocusPicker
                value={focusValue}
                label={pickerLabel || 'Citywide'}
                options={focusOptions}
                onChange={onFocus}
              />
              {builtSince && (
                <button
                  data-testid="built-since-label"
                  onClick={() => setBuiltSince(undefined)}
                  title="Clear built-since filter"
                  aria-label="Clear built-since filter"
                  style={{
                    pointerEvents: 'auto', cursor: 'pointer', opacity: 0.9,
                    background: 'none', border: 'none', color: 'inherit',
                    font: 'inherit', padding: 0,
                  }}
                >· built since {builtSince} ✕</button>
              )}
              {chipStats && (
                <Tooltip content={summary ? <SummaryStats s={summary} aggLabel={summaryAggLabel} /> : null}>
                  <span data-testid="totals-chip" style={{ opacity: 0.9, fontVariantNumeric: 'tabular-nums', cursor: 'help' }}>
                    {abbr(chipStats.paid)}
                    {builtStats && ` (${pct(builtStats.amount, builtStats.amountAll)} of ${builtStats.scoped ? 'focus' : 'citywide'} ${billedYr ? 'billed' : 'paid'})`}
                    {' · '}{chipStats.count.toLocaleString()} {noun}
                  </span>
                </Tooltip>
              )}
              {(portfolio || region) && (
                <button
                  onClick={() => { setPortfolio(''); setRegion(''); setBuiltSince(undefined) }}
                  title="Clear highlight"
                  aria-label="Clear highlight"
                  style={{
                    pointerEvents: 'auto', cursor: 'pointer',
                    background: 'rgba(255,255,255,0.15)', color: 'white',
                    border: 'none', borderRadius: 999, width: 20, height: 20,
                    lineHeight: '18px', padding: 0, fontSize: 12, fontWeight: 700,
                    fontFamily: 'inherit',
                  }}
                >✕</button>
              )}
            </span>
            {builtStats && (
              <div
                data-testid="built-since-stats"
                style={{
                  marginTop: 4, fontSize: big ? 15 : 12, opacity: 0.95, fontVariantNumeric: 'tabular-nums',
                  display: 'inline-block', background: 'rgba(0,0,0,0.6)', color: 'white',
                  padding: '2px 10px', borderRadius: 8, textShadow: 'none', whiteSpace: 'normal',
                }}
              >
                {/* Assessed value is a single fixed MOD-IV year; only show it when
                    that year is in view, so a 2026 figure isn't printed beside a
                    different year's paid/billed total. */}
                {yearRounded === ASSESSED_YEAR && (<>
                  {ASSESSED_YEAR} taxable assessed {abbr(builtStats.av)} ({pct(builtStats.av, builtStats.avAll)} of {builtStats.scoped ? 'focus' : 'citywide'} assessed)
                  {builtStats.avExempt > 0 && ` · exempt / PILOT ${abbr(builtStats.avExempt)}`}
                  {' · '}
                </>)}
                {builtStats.unknown.toLocaleString()} {AGG_NOUN[String(aggregateMode)]?.[builtStats.unknown === 1 ? 0 : 1]} with no year built (excluded)
              </div>
            )}
          </div>
        )
        if (isAnim) {
          return (
            <div ref={titleRef} style={titleStyle}>
              <div style={{ fontSize: 14, fontWeight: 500, opacity: 0.85, marginBottom: 2 }}>{headline}</div>
              <RollingYear year={year} />
              <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{subPrefix}</div>
              {focusLabel && statsChip}
            </div>
          )
        }
        return (
          <div ref={titleRef} style={titleStyle}>
            <div style={{ fontSize: 'clamp(16px, 4.2vw, 20px)', fontWeight: 600, lineHeight: 1.2 }}>{headline}</div>
            <div style={{ fontSize: 16, marginTop: 6, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '4px 8px' }}>
              {colorByYrBuilt ? <span>Colored by year built</span> : (
                <InlineSelect
                  value={String(metricMode)}
                  label={`${billedYr ? (isTotal ? 'Total billed' : 'Billed') : (isTotal ? 'Total paid' : 'Paid')}${isTotal ? '' : ` per ${metricMode === 'per_capita' ? 'capita' : 'sq ft'}`}`}
                  onChange={(v) => setMetricMode(v as MetricMode)}
                  title="Metric"
                  options={<>
                    {opt('per_sqft', 'Paid per sq ft')}
                    {opt('total', 'Total paid')}
                    {hasPopulation && opt('per_capita', 'Paid per capita')}
                  </>}
                />
              )}
              <span>
                by{' '}
                <InlineSelect
                  value={String(aggregateMode)}
                  label={aggLabel}
                  onChange={(v) => setAggregateMode(v as AggregateMode)}
                  title="View (aggregation level)"
                  options={<>
                    {opt('ward', 'ward')}
                    {opt('census-block', 'census block')}
                    {opt('block', 'block')}
                    {opt('lot', 'lot')}
                    {opt('unit', 'unit')}
                  </>}
                />
              </span>
              {!big && <YearControl year={year} setYear={goToYear} years={AVAILABLE_YEARS} onPlay={togglePlay} />}
            </div>
            {big ? (
              // Player open: the year becomes a big rolling readout (still the
              // picker), with the totals chip enlarged beside it.
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: '6px 14px' }}>
                <YearControl year={year} setYear={goToYear} years={AVAILABLE_YEARS} big />
                {statsChip}
              </div>
            ) : statsChip}
            {billedYr && summary && (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9, textShadow: 'inherit' }}>
                {Math.round(year)}: amounts billed (final quarter due Nov 1) · citywide paid so far {abbr(summary.paid)} ({Math.round(summary.paid / Math.max(summary.billed, 1) * 100)}% of billed)
              </div>
            )}
          </div>
        )
      })()}

      {/* Animation transport (bottom-center): play/pause + year scrubber +
          speed. Advances `year` fractionally via requestAnimationFrame and
          drives the existing per-feature interpolation. Hidden in the scrns
          `?animYr` capture context, which owns the year itself. */}
      {!animYr && transportOpen && (
        <div
          style={{
            position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
            zIndex: 2, display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--panel-bg)', color: 'var(--text-primary)',
            padding: '6px 10px 6px 6px', borderRadius: 999,
            border: '1px solid var(--input-border)', boxShadow: '0 2px 8px var(--shadow)',
          }}
        >
          <button
            onClick={togglePlay}
            aria-label={playing ? 'Pause animation' : 'Play animation'}
            title={playing ? 'Pause (space)' : 'Play through years (space)'}
            style={{
              width: 30, height: 30, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: 'var(--text-accent)', color: 'white', fontSize: 13,
              display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
              lineHeight: 1,
            }}
          >
            {playing && !yearsReady
              ? <span className="play-buffering" />
              : playing ? '❚❚' : '▶'}
          </button>
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', width: SCRUB_W, height: 30 }}>
            {yearTotals && <YearSparkline totals={yearTotals} year={year} width={SCRUB_W} height={30} />}
            <input
              type="range"
              min={AVAILABLE_YEARS[0]}
              max={YEAR_MAX}
              step={0.01}
              value={year}
              onChange={(e) => onScrub(Number(e.target.value))}
              onPointerUp={commitScrub}
              onKeyUp={commitScrub}
              aria-label="Tax year scrubber"
              title="Drag to scrub through years"
              className="year-scrub"
              style={{ position: 'relative', width: SCRUB_W, height: 30, margin: 0 }}
            />
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, minWidth: 40, textAlign: 'center' }}>
            {playing && !yearsReady
              ? <span style={{ fontSize: 11, fontWeight: 600, opacity: 0.8 }} title="Loading all years before playing">
                  {yearsLoaded}/{AVAILABLE_YEARS.length}
                </span>
              : Math.round(year)}
          </span>
          <button
            onClick={cycleSpeed}
            title="Playback speed"
            aria-label="Cycle playback speed"
            style={{
              minWidth: 34, height: 24, borderRadius: 12, cursor: 'pointer',
              background: 'var(--input-bg)', color: 'var(--text-primary)',
              border: '1px solid var(--input-border)', fontSize: 12, fontWeight: 600, padding: '0 6px',
            }}
          >
            {playSpeedLabel(playSpeed)}
          </button>
          <button
            onClick={closeTransport}
            title="Close player"
            aria-label="Close player"
            style={{
              width: 24, height: 24, borderRadius: '50%', cursor: 'pointer', padding: 0,
              background: 'transparent', color: 'var(--text-secondary)',
              border: 'none', fontSize: 16, lineHeight: 1,
            }}
          >
            {'×'}
          </button>
        </div>
      )}

      {/* Settings panel (when at top) */}
      {!posBottom && (
        <div style={{
          position: 'absolute',
          top: 10,
          right: posRight ? 10 : undefined,
          left: posRight ? undefined : 10,
          zIndex: 1,
        }}>
          {!clean && settingsPanel}
        </div>
      )}

      {/* Bottom bar: settings (when at bottom) + SpeedDial + attribution */}
      <div style={{
        position: 'absolute',
        bottom: 10,
        right: posRight ? 10 : undefined,
        left: posRight ? undefined : 10,
        display: 'flex',
        flexDirection: posRight ? 'row-reverse' : 'row',
        alignItems: 'flex-end',
        gap: 10,
        zIndex: 1,
      }}>
        {posBottom && !clean && settingsPanel}
        {!clean && <AppSpeedDial
          className="speed-dial-inline"
          extraActions={[
            { key: 'data', label: 'Browse the data', icon: <MdFolderOpen />, href: '/files' },
          ]}
        />}
        <div style={{ fontSize: 10, color: 'var(--text-secondary)', whiteSpace: 'nowrap', padding: '2px 4px' }}>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>© OpenStreetMap</a>
          {' '}
          <a href="https://carto.com/about-carto/" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>© CARTO</a>
        </div>
      </div>

      {/* Hover/selected tooltip */}
      {(hovered || selected) && (() => {
        const info = { ...(selected ?? hovered!), ...parcelDetails }
        const isCensus = !!info.geoid || (!!info.ward && !info.block)
        const sqftActive = metricMode === 'per_sqft'
        const capitaActive = metricMode === 'per_capita'
        const hasBuilding = !!(info.stories || info.units || info.yr_built || info.bldg_sqft)
        // Compute centroid for map links
        const activeId = selected ? selectedId : hoveredId
        const feature = activeId && data ? data.find(f => getFeatureId(f) === activeId) : null
        let centroid: [number, number] | null = null
        if (feature?.geometry) {
          const coords = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry.coordinates[0][0]
          const lngs = coords.map(c => c[0])
          const lats = coords.map(c => c[1])
          centroid = [(Math.min(...lats) + Math.max(...lats)) / 2, (Math.min(...lngs) + Math.max(...lngs)) / 2]
        }
        const linkStyle = { color: 'var(--text-secondary)', fontSize: 12, textDecoration: 'none' }
        return (
          <div
            style={{
              position: 'absolute',
              top: 10,
              left: posRight ? 10 : undefined,
              right: posRight ? undefined : 10,
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
            {hasBuilding && (() => {
              const items: { text: string, highlight?: boolean }[] = [
                info.stories ? { text: `${info.stories % 1 ? info.stories : Math.round(info.stories)} stories` } : null,
                info.units ? { text: `${info.units} unit${info.units > 1 ? 's' : ''}` } : null,
                info.yr_built ? { text: `built ${info.yr_built}`, highlight: colorByYrBuilt } : null,
                info.bldg_sqft ? { text: `${info.bldg_sqft.toLocaleString()} sqft (bldg)` } : null,
              ].filter((x): x is { text: string, highlight?: boolean } => x !== null)
              return (
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                  {items.map((item, i) => (
                    <span key={i}>
                      {i > 0 && ' · '}
                      <span style={item.highlight ? { color: 'var(--text-accent)' } : undefined}>{item.text}</span>
                    </span>
                  ))}
                </div>
              )
            })()}
            {(() => {
              const note = getLotNote(info.block, info.lot)
              return note ? (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, padding: '3px 6px', background: 'var(--input-bg)', borderRadius: 3, lineHeight: 1.3 }}>
                  {note}
                </div>
              ) : null
            })()}
            {info.area_sqft !== undefined && info.area_sqft > 0 && (
              info.unit_sqft ? (
                <div>Unit: {info.unit_sqft.toLocaleString()} sqft</div>
              ) : (
                <div>Area: {info.area_sqft.toLocaleString()} sqft</div>
              )
            )}
            {info.paid !== undefined && info.paid > 0 && (
              <div style={{ color: isTotal && !colorByYrBuilt ? 'var(--text-accent)' : undefined }}>
                Paid ({year}): ${info.paid.toLocaleString()}
              </div>
            )}
            {info.unit_sqft && info.paid ? (<>
              <div style={{ color: sqftActive ? 'var(--text-accent)' : undefined }}>
                ${(info.paid / info.unit_sqft).toFixed(2)}/sqft
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                <Tooltip content={<>
                  Bar height uses taxes per parcel polygon area
                  ({info.area_sqft?.toLocaleString()} sqft),
                  not unit interior area ({info.unit_sqft.toLocaleString()} sqft).
                  Parcel polygons are GIS subdivisions of the lot
                  and don't reflect actual unit size.
                </>}>
                  <span style={{ borderBottom: '1px dotted var(--text-secondary)', cursor: 'help' }}>
                    ${info.paid_per_sqft?.toFixed(2)}/sqft parcel
                  </span>
                </Tooltip>
              </div>
            </>) : info.paid_per_sqft !== undefined && info.paid_per_sqft > 0 && (
              <div style={{ color: sqftActive ? 'var(--text-accent)' : undefined }}>
                ${info.paid_per_sqft.toFixed(2)}/sqft
              </div>
            )}
            {info.paid_per_capita !== undefined && info.paid_per_capita > 0 && (
              <div style={{ color: capitaActive ? 'var(--text-accent)' : undefined }}>
                ${info.paid_per_capita.toLocaleString()}/capita
              </div>
            )}
            {centroid && (() => {
              const addr = info.addr || info.streets
              const query = addr ? encodeURIComponent(`${addr}, Jersey City, NJ`) : null
              return (
                <div style={{ marginTop: 4, display: 'flex', gap: 8 }}>
                  <a
                    href={query
                      ? `https://www.google.com/maps/search/${query}/@${centroid[0]},${centroid[1]},19z`
                      : `https://www.google.com/maps/@${centroid[0]},${centroid[1]},19z`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={linkStyle}
                    title="Google Maps"
                  >Maps</a>
                  <a
                    href={query
                      ? `https://earth.google.com/web/search/${query}/@${centroid[0]},${centroid[1]},0a,200d,35y,0h,45t`
                      : `https://earth.google.com/web/@${centroid[0]},${centroid[1]},0a,200d,35y,0h,45t`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={linkStyle}
                    title="Google Earth"
                  >Earth</a>
                </div>
              )
            })()}
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
          left: posRight ? 10 : undefined,
          right: posRight ? undefined : 10,
          width: 40,
          height: 40,
          cursor: viewState.bearing !== 0 ? 'pointer' : undefined,
          zIndex: 1,
          opacity: viewState.bearing === 0 ? 0.3 : 0.85,
          ...(clean ? { display: 'none' } : {}),
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
    </div>
  )
}
