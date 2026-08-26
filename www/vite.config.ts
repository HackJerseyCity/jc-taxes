import { defineConfig } from 'vite'
import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import dvc from 'vite-plugin-dvc'

const allowedHosts = ['host.docker.internal', ...(process.env.VITE_ALLOWED_HOSTS?.split(',') ?? [])]

// Public base URL the DVC cache is served from. Unset → the plugin derives it
// from the DVC remote (currently AWS S3). Set to the R2 custom-domain cache
// root (e.g. `https://data.jct.rbw.sh/.dvc/cache`) to cut prod over to R2.
const dvcBaseUrl = process.env.VITE_DVC_BASE_URL || undefined

// GH Pages doesn't natively serve SPA routes — visiting /map directly would
// 404 without a fallback. Emit a copy of index.html as 404.html so any
// unknown path serves the SPA, which then routes client-side.
function ghPagesSpaFallback() {
  return {
    name: 'gh-pages-spa-fallback',
    apply: 'build' as const,
    async closeBundle() {
      const dist = resolve(__dirname, 'dist')
      await copyFile(resolve(dist, 'index.html'), resolve(dist, '404.html'))
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), dvc({ root: 'public', baseUrl: dvcBaseUrl }), ghPagesSpaFallback()],

  server: {
    port: 3201,  // JC area code
    host: true,
    allowedHosts,
  },

  preview: {
    port: 3201,
  }
})
