import { useQuery } from '@tanstack/react-query'

// Per view × focus × year totals and height-scale maxima, computed by the
// pipeline into D1 and served by the `jct-edge` Worker (`/api/summary`). The
// client uses these instead of loading other years (or scanning features) to
// show totals, the sparkline and a cross-year height scale.

export type SummaryMetric = 'per_sqft' | 'total' | 'per_capita'
type Maxima = Record<SummaryMetric, number | null>

export interface SummaryYear {
  year: number
  count: number
  /** Paid, or billed for billed-basis years (the app's `amountOf`). */
  amount: number
  paid: number
  billed: number
  max: Maxima
}

export interface Summary {
  view: string
  focus: string
  years: SummaryYear[]
  /** Max over all years, per metric. */
  max: Maxima
}

/**
 * Summary key for the current focus: '' (citywide), `pf:<key>`, or the region
 * key (`ward:E` / `hood:<name>`). A portfolio AND a region together isn't
 * precomputed: `null`, and callers compute from loaded features.
 */
export function summaryFocus(portfolio: string | null | undefined, region: string | null | undefined): string | null {
  if (portfolio && region) return null
  if (portfolio) return `pf:${portfolio}`
  return region || ''
}

export function useSummary(view: string, focus: string | null) {
  return useQuery({
    queryKey: ['summary', view, focus],
    enabled: focus != null,
    staleTime: 5 * 60_000,
    // The map holds its first render on this (to avoid a rescale); fail fast to
    // the client-side fallback rather than retrying for seconds.
    retry: 1,
    retryDelay: 300,
    queryFn: async (): Promise<Summary> => {
      const r = await fetch(`/api/summary?view=${encodeURIComponent(view)}&focus=${encodeURIComponent(focus ?? '')}`)
      if (!r.ok) throw new Error(`summary: ${r.status} ${r.statusText}`)
      return r.json()
    },
  })
}
