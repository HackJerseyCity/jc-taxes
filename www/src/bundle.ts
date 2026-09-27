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

interface Values {
  years: number[]
  count: number
  /** Integer cents, `[year][feature]`. */
  paid: number[][]
  billed_minus_paid: number[][]
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
      return r.json()
    })
    b = Promise.all([get(`geom-${SUFFIX[view]}.geojson`), get(`values-${SUFFIX[view]}.json`)])
      .then(([geom, values]: [{ features: ParcelFeature[] }, Values]) => {
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
  const paidY = values.paid[yi], deltaY = values.billed_minus_paid[yi]
  return geom.map((g, i) => {
    const paid = paidY[i] / 100
    const billed = (paidY[i] + deltaY[i]) / 100
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
