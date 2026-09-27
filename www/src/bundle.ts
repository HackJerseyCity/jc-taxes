import { resolve as dvcResolve } from 'virtual:dvc-data'
import type { ParcelFeature, ParcelProperties } from './types'

// Block / lot / unit views load one geometry file (fixed properties) and one
// all-years values file per view (`jct bundle`), instead of a full GeoJSON per
// year: switching years or playing every year then downloads nothing more.
// `yearFeatures` rebuilds a year's features with the same properties the
// per-year GeoJSON had (the pipeline's rounding for derived metrics), so the
// rest of the app is unchanged. Wards / census blocks keep per-year GeoJSON.
const SUFFIX: Record<string, string> = { block: 'blocks', lot: 'lots', unit: 'units' }

export const isBundled = (view: string) => view in SUFFIX

/** `values-{view}.bin` (see the format comment in `src/jc_taxes/bundle.py`). */
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

interface Bundle {
  geom: ParcelFeature[]
  values: Values
}

const bundles = new Map<string, Promise<Bundle>>()

export function loadBundle(view: string): Promise<Bundle> {
  let b = bundles.get(view)
  if (!b) {
    const get = (name: string) => fetch(dvcResolve(name)).then(r => {
      if (!r.ok) throw new Error(`${name}: ${r.status} ${r.statusText}`)
      return r
    })
    b = Promise.all([
      get(`geom-${SUFFIX[view]}.geojson`).then(r => r.json() as Promise<{ features: ParcelFeature[] }>),
      get(`values-${SUFFIX[view]}.bin`).then(r => r.arrayBuffer()).then(parseValues),
    ])
      .then(([geom, values]) => {
        if (geom.features.length !== values.count) {
          throw new Error(`${view}: ${geom.features.length} features vs ${values.count} values`)
        }
        return { geom: geom.features, values }
      })
    b.catch(() => bundles.delete(view))
    bundles.set(view, b)
  }
  return b
}

// `round(x, 2)` as the pipeline writes `paid_per_sqft` etc.
const round2 = (x: number) => Math.round(x * 100) / 100

export function yearFeatures({ geom, values }: Bundle, year: number): ParcelFeature[] {
  const yi = values.years.indexOf(year)
  if (yi < 0) return []
  const ny = values.years.length
  return geom.map((g, i) => {
    const k = i * ny + yi
    const paid = values.paid[k] / 100
    const billed = (values.paid[k] + values.billedMinusPaid[k]) / 100
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
