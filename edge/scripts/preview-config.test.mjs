import { test } from 'node:test'
import { deepStrictEqual, throws } from 'node:assert'
import { previewConfig } from './preview-config.mjs'

test('only trusted dev resources and explicitly allowed config reach the preview', () => {
  const base = {
    account_id: 'account', compatibility_date: '2025-04-01',
    compatibility_flags: ['nodejs_compat'], assets: { directory: '../www/dist' },
    rules: [], observability: { enabled: true },
    routes: ['production.example/*'], build: { command: 'unsafe' },
    d1_databases: [{ database_name: 'prod' }],
    env: { dev: { r2_buckets: [{ bucket_name: 'data' }], d1_databases: [{ database_name: 'dev' }] } },
  }
  deepStrictEqual(previewConfig(base, 2), {
    name: 'jct-pr-2', main: 'preview-build/worker.js', find_additional_modules: true, account_id: 'account',
    compatibility_date: '2025-04-01', compatibility_flags: ['nodejs_compat'],
    workers_dev: true, assets: { directory: '../www/dist' },
    r2_buckets: [{ bucket_name: 'data' }], d1_databases: [{ database_name: 'dev' }],
    rules: [], observability: { enabled: true },
  })
})

test('invalid preview identifiers are rejected', () => {
  for (const n of [0, -1, NaN, 2.5]) throws(() => previewConfig({}, n), { message: 'Invalid PR number' })
})
