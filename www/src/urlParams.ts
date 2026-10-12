import { stringParam, type Param } from 'use-prms'

// Compact URL params. Canonical keys/values are short (`a=l`, `m=t`, `y=25`,
// `p=newport`, `w=e`, `n=hp`); the original long forms (`agg=lot`, `mt=total`,
// `y=2025`, `pf=…`, `rg=…`) are still read, and rewritten to the short form on
// load (`useUrlAlias`).

const invert = <K extends string, V extends string>(m: Record<K, V>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<V, K>

export const AGG_CODES = { block: 'b', lot: 'l', unit: 'u', 'census-block': 'c', ward: 'w' } as const
export const METRIC_CODES = { per_sqft: 's', total: 't', per_capita: 'c' } as const
const AGG_BY_CODE = invert(AGG_CODES)
const METRIC_BY_CODE = invert(METRIC_CODES)

/** Short-code param: `code ↔ value`, `dflt` omitted from the URL. */
function codeParam(codes: Record<string, string>, byCode: Record<string, string>, dflt: string): Param<string | undefined> {
  return {
    encode: (v) => v == null || v === dflt ? undefined : codes[v] ?? v,
    decode: (s) => s == null ? undefined : byCode[s] ?? (s in codes ? s : undefined),
  }
}
/** Long-form legacy param (read-only alias): value as-is. */
const legacyParam: Param<string | undefined> = stringParam()

export const aggAlias = {
  keys: ['a', 'agg'] as const,
  params: { a: codeParam(AGG_CODES, AGG_BY_CODE, 'block'), agg: legacyParam },
  merge: ({ a, agg }: Record<string, string | undefined>) => a ?? agg,
}
export const metricAlias = {
  keys: ['m', 'mt'] as const,
  params: { m: codeParam(METRIC_CODES, METRIC_BY_CODE, 'per_sqft'), mt: legacyParam },
  merge: ({ m, mt }: Record<string, string | undefined>) => m ?? mt,
}
export const portfolioAlias = {
  keys: ['p', 'pf'] as const,
  params: { p: stringParam(), pf: legacyParam },
  merge: ({ p, pf }: Record<string, string | undefined>) => p ?? pf,
}

/** Year: 2-digit in the URL (`25`, or fractional `17.326` for a paused
 * mid-transition frame); 4-digit values still decode. */
export function yearParam(dflt: number): Param<number> {
  return {
    decode: (s) => {
      if (s == null) return dflt
      const n = parseFloat(s)
      if (isNaN(n)) return dflt
      return n < 100 ? 2000 + n : n
    },
    encode: (v) => {
      if (v === dflt) return undefined
      const short = v - 2000
      return Number.isInteger(short) ? String(short) : short.toFixed(3).replace(/\.?0+$/, '')
    },
  }
}

/** Built-since year (`bs=21`): 2-digit from 2000 like `y`, 4-digit before;
 *  absent = off. */
export const builtSinceParam: Param<number | undefined> = {
  decode: (s) => {
    if (s == null || s === '') return undefined
    const n = parseInt(s, 10)
    if (isNaN(n)) return undefined
    return n < 100 ? 2000 + n : n
  },
  encode: (v) => v == null ? undefined : v >= 2000 && v < 2100 ? String(v - 2000).padStart(2, '0') : String(v),
}

/** Ward (`w=e`): lowercase letter in the URL, `A`–`F` internally. */
export const wardParam: Param<string> = {
  encode: (v) => v ? v.toLowerCase() : undefined,
  decode: (s) => s && /^[a-f]$/i.test(s) ? s.toUpperCase() : '',
}

// Neighborhood slugs (`n=hp`). Hand-picked, stable, and matching local usage
// where one exists (HPNA → `hp`, VVNA → `vv`, VNA → `v`, HCNA → `hc`); a
// trailing `na` ("…NA" = neighborhood association) is also accepted, as is the
// full name (case-insensitive, spaces or dashes).
export const HOOD_SLUGS: Record<string, string> = {
  'Bates': 'ba',
  'Bayside': 'bs',
  'Bergen Hill': 'bh',
  'Canal Crossing': 'cc',
  'Country Village': 'cv',
  'Exchange Place': 'ep',
  'Greenville Yards': 'gy',
  'Gregory Park': 'gp',
  'Hackensack': 'hk',
  'Hamilton Park': 'hp',
  'Harbor Place': 'hpl',
  'Harborside': 'hs',
  'Harsimus Cove': 'hc',
  'Hoboken Yards': 'hy',
  'Hudson City': 'hdc',
  'Jackson Hill': 'jh',
  'Journal Square': 'jsq',
  'LSP Industrial': 'lspi',
  'Lafayette': 'lf',
  'Lafayette Industrial': 'lfi',
  'Liberty Harbor': 'lh',
  'Liberty State Park': 'lsp',
  'Lincoln Park': 'lp',
  'Marion': 'mr',
  'Meadowlands': 'ml',
  'Metroplaza': 'mp',
  'Mill Creek': 'mc',
  'Mount Pleasant': 'mtp',
  'Newport': 'np',
  'Our Lady of Mercy': 'olm',
  'Palisade': 'pa',
  'Palus Hook': 'ph',
  'Port Liberte': 'pl',
  'Powerhouse': 'pw',
  'Reservoir': 'rv',
  'Society Hill': 'sh',
  'South Greenville': 'sg',
  'Sparrow Hill': 'sph',
  'St. Aedens': 'sa',
  'St. Pete': 'stp',
  'St.Joes': 'sj',
  'State College': 'sc',
  'The Island': 'ti',
  'Van Leer': 'vl',
  'Van Vorst Park': 'vv',
  'Village': 'v',
  'Washington Village': 'wv',
  'Waverly': 'wa',
  'West End': 'we',
  'West Side': 'wsd',
  'Western Slope': 'ws',
}
const HOOD_BY_SLUG = invert(HOOD_SLUGS)
const nameKey = (s: string) => s.toLowerCase().replace(/[\s.\-+]+/g, '')
const HOOD_BY_NAME = Object.fromEntries(Object.keys(HOOD_SLUGS).map(n => [nameKey(n), n]))

export function hoodFromSlug(s: string | undefined): string {
  if (!s) return ''
  const k = s.toLowerCase()
  return HOOD_BY_SLUG[k]
    ?? (k.endsWith('na') ? HOOD_BY_SLUG[k.slice(0, -2)] : undefined)
    ?? HOOD_BY_NAME[nameKey(s)]
    ?? ''
}

/** Neighborhood (`n=hp`): slug in the URL, display name internally. */
export const hoodParam: Param<string> = {
  encode: (v) => v ? HOOD_SLUGS[v] ?? v : undefined,
  decode: (s) => hoodFromSlug(s),
}
