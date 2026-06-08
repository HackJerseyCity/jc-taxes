import { defineConfig } from 'vite'
import { copyFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import dvc from 'vite-plugin-dvc'

const allowedHosts = ['host.docker.internal', ...(process.env.VITE_ALLOWED_HOSTS?.split(',') ?? [])]

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
  plugins: [react(), dvc({ root: 'public' }), ghPagesSpaFallback()],

  server: {
    port: 3201,  // JC area code
    host: true,
    allowedHosts,
  },

  preview: {
    port: 3201,
  }
})
