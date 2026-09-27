import { defineConfig } from '@playwright/test'

// `PW_PORT`: test a build (`CI=1`) alongside a running dev server on 3201.
const port = Number(process.env.PW_PORT ?? 3201)

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${port}`,
  },
  webServer: {
    command: process.env.CI ? `pnpm preview --port ${port} --strictPort` : 'pnpm dev',
    port,
    reuseExistingServer: !process.env.CI,
  },
})
