import { useMemo } from 'react'
import { FileTree } from '@rdub/file-tree/react'
import { HttpStore } from '@rdub/file-tree/stores/http'
import { renderMarkdown } from '@rdub/file-tree/renderers/markdown'
import { ParquetViewer } from '@rdub/file-tree/renderers/parquet'
import { renderJsonTree } from '@rdub/file-tree/renderers/json'
import { CsvViewer } from '@rdub/file-tree/renderers/csv'
import { renderCode } from '@rdub/file-tree/renderers/code'
import { useUrlPersistedState } from '@rdub/file-tree/url-state'

// Same-origin: the Worker serves both this UI and `/api/files/*`.
const API_BASE = '/api/files'

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
        markdownRenderer={renderMarkdown}
        parquetRenderer={ParquetViewer}
        jsonRenderer={renderJsonTree}
        csvRenderer={CsvViewer}
        codeRenderer={renderCode}
        usePersistedState={useUrlPersistedState}
      />
    </div>
  )
}
