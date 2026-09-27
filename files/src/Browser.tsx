import { useMemo, type ReactNode } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'
import type { Store } from '@rdub/file-tree'
import type { PersistedState } from '@rdub/file-tree/react'
import { renderMarkdown } from '@rdub/file-tree/renderers/markdown'
import { ParquetViewer, type ParquetCellCtx } from '@rdub/file-tree/renderers/parquet'
import { renderJsonTree } from '@rdub/file-tree/renderers/json'
import { CsvViewer } from '@rdub/file-tree/renderers/csv'
import { renderCode } from '@rdub/file-tree/renderers/code'
import { useUrlPersistedState } from '@rdub/file-tree/url-state'

// Same-origin: the Worker serves both this UI and `/api/files/*`.
const API_BASE = '/api/files'
const MAP = 'https://jct.rbw.sh'

// ── Per-project parquet cell customization ──────────────────────────────
// `renderCell` keys off `column.name`, so one function customizes the right
// columns across every file (payments / taxes / enriched) without branching
// on path. Two things demonstrated: currency formatting and an FK link.

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

// Dollar-valued columns across the tax-record parquets. Formatting here also
// hides the float-representation noise in the source (13480.6199999 → $13,480.62).
const CURRENCY_COLS = new Set([
  'Billed', 'Paid', 'Sale Price',
  'Taxes 1', 'Taxes 2', 'Taxes 3', 'Taxes 4',
  'land_assmnt', 'bldg_assmnt', 'total_assmnt',
])

// (Block, Lot) → the map's dissolved-lot select id (`?sel=<block>-<lot>&agg=lot`).
// Qualifier is intentionally dropped: the lot view merges a lot's units into one
// polygon, so every record resolves to its physical parcel regardless of unit.
function parcelSel(row: Record<string, unknown>): string | null {
  const { Block: block, Lot: lot } = row
  if (block == null || lot == null || String(lot).trim() === '') return null
  return `${String(block).trim()}-${String(lot).trim()}`
}

function renderCell({ column, value, row, defaultNode }: ParquetCellCtx): ReactNode {
  if (CURRENCY_COLS.has(column.name) && typeof value === 'number') {
    return usd.format(value)
  }
  // FK link: a parcel's address → that parcel focused on the map.
  if (column.name === 'Property Location') {
    const sel = parcelSel(row)
    if (sel) {
      return (
        <a
          href={`${MAP}/?sel=${encodeURIComponent(sel)}&agg=lot`}
          target="_blank"
          rel="noreferrer"
          title={`View ${sel} on the map`}
        >
          {defaultNode}
        </a>
      )
    }
  }
  return defaultNode
}

// FileTree's `parquetRenderer` only receives `{ store, path, usePersistedState }`,
// so per-project options are bound by wrapping `ParquetViewer`. (`path` is here
// too, for cases that need to branch the customization by file.)
function TaxParquetViewer(props: { store: Store; path: string; usePersistedState?: PersistedState }) {
  return <ParquetViewer {...props} renderCell={renderCell} />
}

export function Browser() {
  const store = useMemo(() => HttpStore(API_BASE), [])
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5em' }}>
      <FileTree
        store={store}
        routeBase="/"
        // The published tree lives under `data/`; pin the UI into it so the
        // root listing shows `geojson/` + `modiv/` directly.
        rootPrefix="data/"
        title="Jersey City property-tax data"
        titleHref="https://jct.rbw.sh/"
        home={{ href: 'https://jct.rbw.sh/', label: 'jct.rbw.sh' }}
        markdownRenderer={renderMarkdown}
        parquetRenderer={TaxParquetViewer}
        jsonRenderer={renderJsonTree}
        csvRenderer={CsvViewer}
        codeRenderer={renderCode}
        usePersistedState={useUrlPersistedState}
      />
    </div>
  )
}
