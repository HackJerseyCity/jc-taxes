import { resolve as dvcResolve } from 'virtual:dvc-data'
import type { ParcelFeature, ParcelProperties } from './types'

// Block / lot / unit views load one geometry file (fixed properties) per view
// and a small values file per year (`jct bundle`), instead of a full GeoJSON
// per year: a year change or playback frame downloads only that year's values
// (~0.13 MB for lots).
// `yearFeatures` rebuilds a year's features with the same properties the
// per-year GeoJSON had (the pipeline's rounding for derived metrics), so the
// rest of the app is unchanged. Wards / census blocks use small per-year JSON
// values that include each year's area (their shapes are trimmed to that year's
// tax-paying lots; the geometry file has the latest year's).
const SUFFIX: Record<string, string> = {
  block: 'blocks', lot: 'lots', unit: 'units', ward: 'wards', 'census-block': 'census-blocks',
}
const SMALL_VIEWS = new Set(['ward', 'census-block'])

/** `values-{view}-{year}.json` for wards / census blocks. */
interface SmallValues {
  count: number
  paid: number[]
  billed: number[]
  area_sqft: number[]
}

export const isBundled = (view: string) => view in SUFFIX

/** `values-{view}-{year}.bin` (see the format comment in `src/jc_taxes/bundle.py`). */
interface Values {
  years: number[]
  count: number
  /** Cents, `[feature][year]`. */
  paid: Int32Array | Float64Array
  billedMinusPaid: Int32Array | Float64Array
}

const HEAD = 24

function parseValues(buf: ArrayBuffer): Values {
  const head = new DataView(buf, 0, HEAD)
  const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4))
  const version = head.getUint32(4, true), elem = head.getUint32(8, true)
  if (magic !== 'JCTV' || version !== 1 || (elem !== 1 && elem !== 2)) {
    throw new Error(`values: bad header ${magic} v${version} elem ${elem}`)
  }
  const first = head.getUint32(12, true), nYears = head.getUint32(16, true), count = head.getUint32(20, true)
  const n = count * nYears
  const Arr = elem === 1 ? Int32Array : Float64Array
  if (buf.byteLength !== HEAD + 2 * n * Arr.BYTES_PER_ELEMENT) {
    throw new Error(`values: ${buf.byteLength} bytes, expected ${HEAD + 2 * n * Arr.BYTES_PER_ELEMENT}`)
  }
  return {
    years: Array.from({ length: nYears }, (_, i) => first + i),
    count,
    paid: new Arr(buf, HEAD, n),
    billedMinusPaid: new Arr(buf, HEAD + n * Arr.BYTES_PER_ELEMENT, n),
  }
}

const geoms = new Map<string, Promise<ParcelFeature[]>>()
const values = new Map<string, Promise<Values>>()
const smallValues = new Map<string, Promise<SmallValues>>()

function get(name: string): Promise<Response> {
  return fetch(dvcResolve(name)).then(r => {
    if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`)
    return r
  })
}

function memo<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key)
  if (!p) {
    p = load()
    p.catch(() => cache.delete(key))
    cache.set(key, p)
  }
  return p
}

export function loadGeom(view: string): Promise<ParcelFeature[]> {
  return memo(geoms, view, () =>
    get(`geom-${SUFFIX[view]}.geojson`).then(r => r.json() as Promise<{ features: ParcelFeature[] }>).then(g => g.features))
}

export function loadValues(view: string, year: number): Promise<Values> {
  return memo(values, `${view}|${year}`, () =>
    get(`values-${SUFFIX[view]}-${year}.bin`).then(r => r.arrayBuffer()).then(parseValues))
}

// `round(x, 2)` as the pipeline writes `paid_per_sqft` etc.
const round2 = (x: number) => Math.round(x * 100) / 100

function loadSmallValues(view: string, year: number): Promise<SmallValues> {
  return memo(smallValues, `${view}|${year}`, () =>
    get(`values-${SUFFIX[view]}-${year}.json`).then(r => r.json() as Promise<SmallValues>))
}

type AltShapes = Record<string, { lots?: ParcelFeature['geometry'], blocks?: ParcelFeature['geometry'] }>
const wardShapes = new Map<string, Promise<AltShapes>>()
/** Alternate ward shapes (Settings → ward geometry "lots" / "blocks"), fetched only when chosen. */
export function loadWardShapes(year: number): Promise<AltShapes> {
  return memo(wardShapes, String(year), () =>
    get(`ward-shapes-${year}.json`).then(r => r.json() as Promise<AltShapes>))
}

async function smallYearFeatures(view: string, year: number): Promise<ParcelFeature[]> {
  const [geom, v] = await Promise.all([loadGeom(view), loadSmallValues(view, year)])
  if (geom.length !== v.count) throw new Error(`${view} ${year}: ${geom.length} features vs ${v.count} values`)
  return geom.map((g, i) => {
    const paid = v.paid[i], billed = v.billed[i], area = v.area_sqft[i]
    const pop = g.properties.population ?? 0
    const properties: ParcelProperties = {
      ...g.properties,
      year,
      paid,
      billed,
      area_sqft: area,
      paid_per_sqft: area > 0 ? round2(paid / area) : 0,
      billed_per_sqft: area > 0 ? round2(billed / area) : 0,
      paid_per_capita: pop > 0 ? round2(paid / pop) : undefined,
      billed_per_capita: pop > 0 ? round2(billed / pop) : undefined,
    }
    return { type: 'Feature', geometry: g.geometry, properties }
  })
}

/** A year's features: the view's geometry with that year's amounts. */
export async function yearFeatures(view: string, year: number): Promise<ParcelFeature[]> {
  if (SMALL_VIEWS.has(view)) return smallYearFeatures(view, year)
  const [geom, v] = await Promise.all([loadGeom(view), loadValues(view, year)])
  if (geom.length !== v.count) throw new Error(`${view} ${year}: ${geom.length} features vs ${v.count} values`)
  const yi = v.years.indexOf(year)
  if (yi < 0) throw new Error(`${view}: values file lacks ${year}`)
  const ny = v.years.length
  return geom.map((g, i) => {
    const k = i * ny + yi
    const paid = v.paid[k] / 100
    const billed = (v.paid[k] + v.billedMinusPaid[k]) / 100
    const area = g.properties.area_sqft ?? 0
    const properties: ParcelProperties = {
      ...g.properties,
      year,
      paid,
      billed,
      paid_per_sqft: area > 0 ? round2(paid / area) : 0,
      billed_per_sqft: area > 0 ? round2(billed / area) : 0,
    }
    return { type: 'Feature', geometry: g.geometry, properties }
  })
}
