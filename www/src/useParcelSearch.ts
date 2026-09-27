import { useCallback } from 'react'
import { useOmnibarEndpoint } from 'use-kbd'
import type { ParcelProperties, ParcelFeature } from './types'

export interface AddressHit {
  /** Lot id (`block-lot`). */
  id: string
  addr: string
  lng: number
  lat: number
}

type Props = {
  data: ParcelFeature[] | null
  onSelect: (feature: ParcelFeature) => void
  /** Address search (`/api/search`, D1 FTS over lot addresses, which aren't in the loaded geometry). */
  onAddress: (hit: AddressHit) => void
}

export function useParcelSearch({ data, onSelect, onAddress }: Props) {
  const filter = useCallback(
    (query: string, pagination: { offset: number; limit: number }) => {
      if (!data) return { entries: [], total: 0, hasMore: false }

      const searchText = (f: ParcelFeature) => {
        const p = f.properties
        if (!p) return ''
        return [
          p.addr || '',
          p.streets || '',
          p.geoid || '',
          p.ward ? `ward ${p.ward}` : '',
          p.council_person || '',
          `${p.block || ''}-${p.lot || ''}${p.qual ? `-${p.qual}` : ''}`,
          p.block || '',
        ].join(' ').toLowerCase()
      }

      let filtered: ParcelFeature[]
      if (!query.trim()) {
        // No query: show top parcels by $/sqft
        filtered = [...data].sort(
          (a, b) => (b.properties?.paid_per_sqft ?? 0) - (a.properties?.paid_per_sqft ?? 0)
        )
      } else {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
        filtered = data.filter((f) => {
          const text = searchText(f)
          return tokens.every(t => text.includes(t))
        }).sort((a, b) => {
          // Score by how many tokens prefix-match a word boundary
          const text = (f: ParcelFeature) => searchText(f)
          const words = (t: string) => t.split(/[\s/,.-]+/)
          const prefixHits = (f: ParcelFeature) =>
            tokens.reduce((s, t) => s + (words(text(f)).some(w => w.startsWith(t)) ? 1 : 0), 0)
          const diff = prefixHits(b) - prefixHits(a)
          if (diff !== 0) return diff
          return (b.properties?.paid_per_sqft ?? 0) - (a.properties?.paid_per_sqft ?? 0)
        })
      }

      const total = filtered.length
      const paginated = filtered.slice(pagination.offset, pagination.offset + pagination.limit)

      return {
        entries: paginated.map((f) => {
          const p = f.properties!
          const label = getLabel(p)
          const description = getDescription(p)
          const id = p.geoid || (p.ward && !p.block ? `ward-${p.ward}` : `${p.block || ''}-${p.lot || ''}${p.qual ? `-${p.qual}` : ''}`)
          return {
            id: `parcel:${id}`,
            label,
            description,
            group: 'Parcels',
            handler: () => onSelect(f),
          }
        }),
        total,
        hasMore: pagination.offset + paginated.length < total,
      }
    },
    [data, onSelect],
  )

  useOmnibarEndpoint('addresses', {
    fetch: async (query, signal, pagination) => {
      const r = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${pagination.offset + pagination.limit}`, { signal })
      if (!r.ok) return { entries: [], total: 0, hasMore: false }
      const hits: AddressHit[] = (await r.json()).results
      const page = hits.slice(pagination.offset)
      return {
        entries: page.map(h => ({
          id: `address:${h.id}`,
          label: h.addr,
          description: `Lot ${h.id}`,
          group: 'Addresses',
          handler: () => onAddress(h),
        })),
        total: hits.length,
        hasMore: false,
      }
    },
    group: 'Addresses',
    priority: 110,
    pageSize: 8,
    minQueryLength: 2,
  })

  useOmnibarEndpoint('parcels', {
    filter,
    group: 'Parcels',
    priority: 100,
    pageSize: 10,
    pagination: 'scroll',
    minQueryLength: 0,
    enabled: !!data,
  })
}

function getLabel(p: ParcelProperties): string {
  if (p.ward && !p.block) {
    return `Ward ${p.ward}${p.council_person ? ` (${p.council_person})` : ''}`
  }
  if (p.geoid) return `Census Block ${p.geoid}`
  const blq = `${p.block || ''}${p.lot ? `-${p.lot}` : ''}${p.qual ? `-${p.qual}` : ''}`
  return p.addr || p.streets || `Block ${blq}`
}

function getDescription(p: ParcelProperties): string {
  const parts: string[] = []
  if (p.geoid && p.ward) parts.push(`Ward ${p.ward}`)
  if (p.block) {
    const blq = `${p.block}${p.lot ? `-${p.lot}` : ''}${p.qual ? `-${p.qual}` : ''}`
    parts.push(blq)
  }
  if (p.population !== undefined) parts.push(`pop ${p.population.toLocaleString()}`)
  if (p.paid) parts.push(`$${p.paid.toLocaleString()}`)
  if (p.paid_per_sqft) parts.push(`$${p.paid_per_sqft.toFixed(2)}/sqft`)
  if (p.paid_per_capita !== undefined && p.paid_per_capita !== null) {
    parts.push(`$${p.paid_per_capita.toLocaleString()}/capita`)
  }
  return parts.filter(Boolean).join(' · ')
}
