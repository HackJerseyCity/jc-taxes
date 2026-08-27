/** `files.jct.rbw.sh` — combined Worker.
 *
 * Serves the file-tree UI (static assets via the `ASSETS` binding) and the
 * file-tree HTTP protocol at `/api/files/*`, backed by the `jc-taxes` R2
 * bucket scoped to the friendly `data/` tree (published by `jct r2 publish`).
 *
 * Downloads go direct from R2 via `publicBaseUrl` (the bucket's public custom
 * domain `data.jct.rbw.sh`) — no S3 API token needed; the Worker only proxies
 * `list`/`get` (the latter powers in-browser parquet/csv/json rendering).
 */
import { R2Store } from '@rdub/file-tree/stores/r2'
import { createHandlers } from '@rdub/file-tree/server'

interface Env {
  R2: R2Bucket
  ASSETS: Fetcher
  CORS_ORIGIN?: string
}

const BASE_PATH = '/api/files'
const PUBLIC_BASE = 'https://data.jct.rbw.sh'

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith(BASE_PATH)) {
      const store = R2Store(env.R2, {
        prefixes: ['data/'],
        publicBaseUrl: PUBLIC_BASE,
      })
      const handlers = createHandlers(store, {
        basePath: BASE_PATH,
        corsOrigin: env.CORS_ORIGIN ?? '*',
      })
      const resp = await handlers.handle(request)
      if (resp) return resp
    }
    // Everything else → static assets (SPA fallback serves index.html for
    // client-side routes, per `not_found_handling: single-page-application`).
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
