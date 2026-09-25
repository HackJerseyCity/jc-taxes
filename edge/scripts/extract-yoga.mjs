#!/usr/bin/env node
// Write satori's Yoga wasm to `generated/yoga.wasm` for the standalone build.
//
// Workers can't compile wasm from bytes at runtime, so we use
// `satori/standalone` + a wrangler-bundled (precompiled) module. The
// `yoga.wasm` satori publishes is corrupted (bytes run through a UTF-8
// decode: `ef bf bd` replacement chars), so recover the intact binary from the
// base64 copy inlined in satori's default build — same version, same glue.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const satoriDir = dirname(require.resolve('satori/package.json'))
const src = readFileSync(resolve(satoriDir, 'dist/index.js'), 'utf8')
const matches = src.match(/AGFzbQ[A-Za-z0-9+/=]{1000,}/g) ?? []
if (matches.length !== 1) {
  console.error(`expected 1 inlined wasm in satori/dist/index.js, found ${matches.length}`)
  process.exit(1)
}
const wasm = Buffer.from(matches[0], 'base64')
const outDir = resolve(here, '..', 'generated')
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'yoga.wasm'), wasm)
console.error(`wrote generated/yoga.wasm (${wasm.length} bytes)`)
