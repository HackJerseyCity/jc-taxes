import { useEffect, useState } from 'react'
import { resolve as dvcResolve } from 'virtual:dvc-data'

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

export function usePortfolios(): Portfolio[] {
  const [portfolios, setPortfolios] = useState<Portfolio[]>([])
  useEffect(() => {
    let cancelled = false
    fetch(dvcResolve('portfolios.json'))
      .then(r => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`)
        return r.json() as Promise<Portfolio[]>
      })
      .then(ps => { if (!cancelled) setPortfolios(ps) })
      .catch(e => console.error('Failed to load portfolios:', e))
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
export function portfolioPredicate(
  p: Portfolio | null,
  blockGranular: boolean,
): ((block: string, lot: string) => boolean) | null {
  if (!p) return null
  const blocks = new Set(p.blocks ?? [])
  const parcels = new Set(p.parcels ?? [])
  const parcelBlocks = new Set([...parcels].map(id => id.slice(0, id.lastIndexOf('-'))))
  if (blockGranular) {
    return (block: string) => blocks.has(block) || parcelBlocks.has(block)
  }
  return (block: string, lot: string) => blocks.has(block) || parcels.has(`${block}-${lot}`)
}
