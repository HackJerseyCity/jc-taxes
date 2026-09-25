// Before deploying, remove from `www/dist` everything that came from a
// git-ignored file in `www/public` — i.e. make `dist` match what a clean CI
// checkout would build. Locally `www/public` holds DVC-checked-out data
// (`taxes-*.geojson`, `county/`, `parcels.geojson`, `portfolios.json`, …) that
// the app fetches from R2 via `dvcResolve`; Vite copies it into `dist`, where it
// would exceed the Workers 25 MiB per-asset limit and needn't be served anyway.
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('../../', import.meta.url).pathname
const pub = join(root, 'www/public')
const dist = join(root, 'www/dist')
const ignored = execFileSync(
  'git',
  ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', 'www/public'],
  { cwd: root, encoding: 'utf8' },
).split('\n').filter(Boolean)
let n = 0
for (const p of ignored) {
  const target = join(dist, relative(pub, join(root, p)))
  if (existsSync(target)) { rmSync(target, { recursive: true, force: true }); n++ }
}
console.log(`pruned ${n} git-ignored www/public outputs from www/dist`)
