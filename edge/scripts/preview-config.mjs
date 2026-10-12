import { readFileSync, writeFileSync } from 'node:fs'
import ts from 'typescript'
import { pathToFileURL } from 'node:url'

export function previewConfig(base, number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid PR number')
  const dev = base.env.dev
  // Explicit allowlist: no production routes, secrets, build commands or triggers.
  return {
    name: `jct-pr-${number}`,
    main: 'preview-build/worker.js',
    find_additional_modules: true,
    account_id: base.account_id,
    compatibility_date: base.compatibility_date,
    compatibility_flags: base.compatibility_flags,
    workers_dev: true,
    assets: base.assets,
    r2_buckets: dev.r2_buckets,
    d1_databases: dev.d1_databases,
    rules: base.rules,
    observability: base.observability,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8'))
  if (parsed.error) throw new Error('Invalid Wrangler configuration')
  writeFileSync('preview.json', JSON.stringify(previewConfig(parsed.config, Number(process.env.PR_NUMBER)), null, 2) + '\n')
}
