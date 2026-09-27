import { useEffect, useState } from 'react'

// Owner/developer portfolios, surfaced via the `pf` URL param and
// command-palette actions (hidden-but-linkable). Each highlights a set of
// parcels on the map and reports their aggregate taxes paid.
//
// The portfolio definitions are data, not code: they're loaded at runtime from
// `portfolios.json` (DVC-tracked, served from R2). Membership is either:
//   - `blocks`:  whole-block developments — every parcel in these tax blocks.
//   - `parcels`: specific `"block-lot"` ids, exactly as they appear in the
//                GeoJSON `block`/`lot` properties. In block view a parcel's
//                whole block is highlighted (block view has no lot granularity).

export interface Portfolio {
  key: string
  label: string
  blocks?: string[]
  parcels?: string[]
  keywords?: string[]
  note?: string
}

// `null` while loading (callers gate `pf` rendering on it); `[]` if the fetch fails.
export function usePortfolios(): Portfolio[] | null {
  const [portfolios, setPortfolios] = useState<Portfolio[] | null>(null)
  useEffect(() => {
    let cancelled = false
    // Served from D1 by the `jct-edge` Worker (dev: proxied, see vite.config.ts).
    fetch('/api/portfolios')
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json() as Promise<{ portfolios: Portfolio[] }>
      })
      .then(({ portfolios: ps }) => { if (!cancelled) setPortfolios(ps) })
      .catch(e => {
        console.error('Failed to load portfolios:', e)
        if (!cancelled) setPortfolios([])
      })
    return () => { cancelled = true }
  }, [])
  return portfolios
}

export function findPortfolio(portfolios: Portfolio[], key: string | undefined | null): Portfolio | null {
  if (!key) return null
  return portfolios.find(p => p.key === key) ?? null
}

// A membership predicate for the active portfolio at the current view
// granularity. Block-granular views (block/ward/census-block) match on block;
// lot/unit views match a whole-block portfolio's blocks, else the specific
// `block-lot`.
// `parcels` entries are `block-lot` (whole lot) or `block-lot-qual` (one unit of
// a lot shared with other owners, e.g. a developer-held rental in a lot of sold
// condos). Unit entries match only in unit view (lot features carry no `qual`),
// so lot view undercounts rather than crediting other owners' units.
export function portfolioPredicate(
  p: Portfolio | null,
  blockGranular: boolean,
): ((block: string, lot: string, qual?: string) => boolean) | null {
  if (!p) return null
  const blocks = new Set(p.blocks ?? [])
  const parcels = new Set(p.parcels ?? [])
  const parcelBlocks = new Set([...parcels].map(id => id.split('-')[0]))
  if (blockGranular) {
    return (block: string) => blocks.has(block) || parcelBlocks.has(block)
  }
  return (block: string, lot: string, qual?: string) =>
    blocks.has(block) || parcels.has(`${block}-${lot}`) || (!!qual && parcels.has(`${block}-${lot}-${qual}`))
}
