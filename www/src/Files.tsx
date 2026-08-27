import { useMemo, type ReactNode } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'
import type { Store } from '@rdub/file-tree/stores'
import type { PersistedState } from '@rdub/file-tree/react'
import { renderMarkdown } from '@rdub/file-tree/renderers/markdown'
import { ParquetViewer, type ParquetCellCtx } from '@rdub/file-tree/renderers/parquet'
import { renderJsonTree } from '@rdub/file-tree/renderers/json'
import { CsvViewer } from '@rdub/file-tree/renderers/csv'
import { renderCode } from '@rdub/file-tree/renderers/code'
import { useUrlPersistedState } from '@rdub/file-tree/url-state'

// The R2 listing API is served by the `jct-files` Worker — GitHub Pages can't
// serve `/api/files`. This is cross-origin from jct.rbw.sh (the Worker's CORS
// is `*`). When the site moves to CF Pages, set VITE_FILES_API=/api/files so
// the app serves it same-origin and the standalone Worker can retire.
const FILES_API = import.meta.env.VITE_FILES_API ?? 'https://jct-files.rbw.sh/api/files'

// ── Per-project parquet cell customization ──────────────────────────────
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

const CURRENCY_COLS = new Set([
  'Billed', 'Paid', 'Sale Price',
  'Taxes 1', 'Taxes 2', 'Taxes 3', 'Taxes 4',
  'land_assmnt', 'bldg_assmnt', 'total_assmnt',
])

// (Block, Lot) → the map's dissolved-lot select id. Qualifier is dropped: the
// lot view merges a lot's units into one polygon.
function parcelSel(row: Record<string, unknown>): string | null {
  const { Block: block, Lot: lot } = row
  if (block == null || lot == null || String(lot).trim() === '') return null
  return `${String(block).trim()}-${String(lot).trim()}`
}

function renderCell({ column, value, row, defaultNode }: ParquetCellCtx): ReactNode {
  if (CURRENCY_COLS.has(column.name) && typeof value === 'number') {
    return usd.format(value)
  }
  // FK link: a parcel's address → that parcel focused on the map. Same-origin
  // now (the map is this app's `/` route), so a relative `/?sel=…` link.
  if (column.name === 'Property Location') {
    const sel = parcelSel(row)
    if (sel) {
      return (
        <a href={`/?sel=${encodeURIComponent(sel)}&agg=lot`} target="_blank" rel="noreferrer" title={`View ${sel} on the map`}>
          {defaultNode}
        </a>
      )
    }
  }
  return defaultNode
}

function TaxParquetViewer(props: { store: Store; path: string; usePersistedState?: PersistedState }) {
  return <ParquetViewer {...props} renderCell={renderCell} />
}

export default function Files() {
  const store = useMemo(() => HttpStore(FILES_API), [])
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '1.5em' }}>
      <FileTree
        store={store}
        routeBase="/files"
        rootPrefix="data/"
        title="Jersey City property-tax data"
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
