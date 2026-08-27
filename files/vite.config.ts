import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const allowedHosts = process.env.VITE_ALLOWED_HOSTS?.split(',') ?? []

export default defineConfig({
  plugins: [react()],
  // `@rdub/file-tree` ships its own copies of these; without deduping, the
  // build ends up with two React / Router instances (invalid-hook-call,
  // "useLocation outside <Router>"). Bites the prod build specifically.
  resolve: {
    dedupe: ['react', 'react-dom', 'react-router-dom'],
  },
  server: {
    port: 3202,
    host: true,
    allowedHosts,
    // `pnpm dev` (Vite HMR) proxies the API to a locally-running
    // `pnpm dev:worker` (`wrangler dev` on :3204).
    proxy: {
      '/api/files': 'http://localhost:3204',
    },
  },
  preview: {
    port: 3202,
  },
})
