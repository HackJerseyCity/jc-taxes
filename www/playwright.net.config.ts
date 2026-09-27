import { defineConfig } from '@playwright/test'

// Download-size suite (`pnpm net`): loads real flows from a deployed site
// (`NET_BASE`, default prod) with a cold cache and records what each fetches.
// See `net/README.md`.
export default defineConfig({
  testDir: './net',
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.NET_BASE ?? 'https://jct.rbw.sh',
    viewport: { width: 1280, height: 800 },
  },
})
