import type { ParcelFeature, ParcelProperties } from './types'

// Geographic focus (`rg` param): `ward:E` or `hood:Hamilton Park`. Features carry
// `ward` / `hood` properties (tagged in the pipeline by representative point).
export type RegionKind = 'ward' | 'hood'
export interface Region { kind: RegionKind; name: string }

export const WARDS = ['A', 'B', 'C', 'D', 'E', 'F']

export function parseRegion(s: string | null | undefined): Region | null {
  if (!s) return null
  const i = s.indexOf(':')
  if (i < 0) return null
  const kind = s.slice(0, i), name = s.slice(i + 1)
  if ((kind !== 'ward' && kind !== 'hood') || !name) return null
  return { kind, name }
}

export const regionKey = (r: Region) => `${r.kind}:${r.name}`

export const regionLabel = (r: Region) => r.kind === 'ward' ? `Ward ${r.name}` : r.name

export function regionTest(r: Region, p: ParcelProperties): boolean {
  return p[r.kind] === r.name
}

// Sorted distinct neighborhood names present in a feature set.
export function hoodsOf(features: ParcelFeature[] | null | undefined): string[] {
  const s = new Set<string>()
  for (const f of features ?? []) {
    const h = f.properties?.hood
    if (h) s.add(h)
  }
  return [...s].sort()
}

// [[minLng, minLat], [maxLng, maxLat]] over the features' outer rings.
export function boundsOf(features: ParcelFeature[]): [[number, number], [number, number]] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const f of features) {
    const g = f.geometry
    if (!g) continue
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map(p => p[0])
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x0 === Infinity ? null : [[x0, y0], [x1, y1]]
}
