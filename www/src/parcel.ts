import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

// Per-parcel details fetched on demand (`/api/parcel`, D1) instead of shipping
// with every parcel's geometry: currently the owner history, run-length by
// year (`[[firstYear, owner], …]`), for the lot / unit views.

type OwnerRuns = [number, string][]

/** The hovered / selected parcel's owner in `year`; waits for the pointer to
 *  rest (`delayMs`) so sweeping across the map doesn't fire a request per parcel. */
export function useParcelOwner(view: string, id: string | null, year: number, delayMs = 150): string | null {
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
    queryFn: async (): Promise<OwnerRuns> => {
      const r = await fetch(`/api/parcel?view=${view}&id=${encodeURIComponent(settled!)}`)
      if (!r.ok) throw new Error(`parcel: ${r.status} ${r.statusText}`)
      return (await r.json()).owners
    },
  })
  if (!enabled || settled !== id || !q.data) return null
  let owner: string | null = null
  for (const [from, name] of q.data) {
    if (from <= year) owner = name
  }
  return owner
}
