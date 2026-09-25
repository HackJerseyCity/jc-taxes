#!/usr/bin/env node
// Seed the D1 `portfolios` table from a `portfolios.json` (path or URL).
//
//   node scripts/seed-portfolios.mjs <portfolios.json | https://…> [--db jct] [--local] [--dry-run]
//
// Portfolio data (labels, parcel lists) is deliberately kept out of git: it
// lives in the DVC-tracked `www/public/portfolios.json` (→ R2). This script
// reads it at seed time, writes the upsert SQL to a temp file outside the repo,
// and runs `wrangler d1 execute` on it (schema applied first). Full replace:
// rows absent from the JSON are deleted.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const src = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--db')
if (!src) {
  console.error('usage: seed-portfolios.mjs <portfolios.json | URL> [--db jct] [--local] [--dry-run]')
  process.exit(1)
}
const db = opt('--db', 'jct')

const text = /^https?:\/\//.test(src)
  ? await (await fetch(src)).text()
  : readFileSync(src, 'utf8')
const portfolios = JSON.parse(text)
if (!Array.isArray(portfolios)) throw new Error('portfolios.json must be an array')

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const list = (v) => (Array.isArray(v) && v.length ? q(JSON.stringify(v)) : 'NULL')

const stmts = [readFileSync(resolve(here, '..', 'd1', 'schema.sql'), 'utf8')]
const keys = []
for (const p of portfolios) {
  if (!p.key || !p.label) throw new Error(`portfolio missing key/label: ${JSON.stringify(p).slice(0, 80)}`)
  keys.push(p.key)
  stmts.push(
    `INSERT INTO portfolios (key, label, note, blocks, parcels, keywords, updated_at) VALUES ` +
    `(${q(p.key)}, ${q(p.label)}, ${q(p.note)}, ${list(p.blocks)}, ${list(p.parcels)}, ${list(p.keywords)}, datetime('now')) ` +
    `ON CONFLICT(key) DO UPDATE SET label=excluded.label, note=excluded.note, blocks=excluded.blocks, ` +
    `parcels=excluded.parcels, keywords=excluded.keywords, updated_at=excluded.updated_at;`,
  )
}
stmts.push(`DELETE FROM portfolios WHERE key NOT IN (${keys.map(q).join(', ') || "''"});`)

const dir = mkdtempSync(join(tmpdir(), 'jct-seed-'))
const file = join(dir, 'seed.sql')
writeFileSync(file, stmts.join('\n') + '\n')
console.error(`${portfolios.length} portfolios → ${db} (${flag('--local') ? 'local' : 'remote'})`)
try {
  if (flag('--dry-run')) {
    console.error(`dry run; SQL at ${file} (${stmts.length} statements)`)
  } else {
    execFileSync('npx', ['wrangler', 'd1', 'execute', db, flag('--local') ? '--local' : '--remote', '--file', file, '-y'], {
      cwd: resolve(here, '..'), stdio: 'inherit',
    })
  }
} finally {
  if (!flag('--dry-run')) rmSync(dir, { recursive: true, force: true })
}
