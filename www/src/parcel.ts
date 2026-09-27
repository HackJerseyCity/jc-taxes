import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ParcelProperties } from './types'

// Per-parcel details fetched on demand (`/api/parcel`, D1) instead of shipping
// with every parcel's geometry (lot / unit views): address, building info, and
// owner history run-length by year (`[[firstYear, owner], …]`).

interface ParcelDetails {
  addr: string | null
  bldg_desc: string | null
  stories: number | null
  units: number | null
  bldg_sqft: number | null
  lng: number
  lat: number
  owners: [number, string][]
}

/**
 * Details for the hovered / selected parcel as `ParcelProperties` fields
 * (owner resolved for `year`), to merge into the tooltip. Waits for the pointer
 * to rest (`delayMs`) so sweeping across the map doesn't fire a request per
 * parcel; `{}` until loaded or for views without details.
 */
export function useParcelDetails(view: string, id: string | null, year: number, delayMs = 120): Partial<ParcelProperties> {
  const [settled, setSettled] = useState(id)
  useEffect(() => {
    const t = setTimeout(() => setSettled(id), delayMs)
    return () => clearTimeout(t)
  }, [id, delayMs])
  const enabled = !!settled && (view === 'lot' || view === 'unit')
  const q = useQuery({
    queryKey: ['parcel', view, settled],
    enabled,
    staleTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<ParcelDetails> => {
      const r = await fetch(`/api/parcel?view=${view}&id=${encodeURIComponent(settled!)}`)
      if (!r.ok) throw new Error(`parcel: ${r.status} ${r.statusText}`)
      return r.json()
    },
  })
  const d = q.data
  if (!enabled || settled !== id || !d) return {}
  let owner: string | undefined
  for (const [from, name] of d.owners) {
    if (from <= year) owner = name
  }
  const out: Partial<ParcelProperties> = { owner }
  if (d.addr) out.addr = d.addr
  if (d.bldg_desc) out.bldg_desc = d.bldg_desc
  if (d.stories) out.stories = d.stories
  if (d.units) out.units = d.units
  if (d.bldg_sqft) out.bldg_sqft = d.bldg_sqft
  return out
}
