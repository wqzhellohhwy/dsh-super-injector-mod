#!/usr/bin/env node
/**
 * Self-contained build for git/path dependency installs (package.json `prepare`).
 *
 * npm/pnpm run `prepare` automatically when a `github:`/`git+` dependency is
 * installed. This script builds the self-contained `lib/` so a fetched repo
 * works without a source checkout.
 *
 * 【2026-10-12 0.4.0-mod.1】本包已移除 client 半侧（自带 UI），产物只有 host 的
 * `lib/index.js`；构建改用 `scripts/build-esbuild.mjs`（esbuild），不再依赖
 * tsdown，也不再需要 DSH_CHECKOUT。因此这里既不需要 tsdown，也不再校验
 * `lib/client.js`。
 *
 * Failing loudly on build errors is intentional: an install that ends with a
 * broken lib/ is worse than one that stops with a clear message.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// prepare.mjs lives in scripts/, so the package root is one level up.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REQUIRED = ['lib/index.js']

function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  return result.status
}

function verifyOutputs() {
  for (const file of REQUIRED) {
    if (!existsSync(join(ROOT, file))) {
      return false
    }
  }
  return true
}

function main() {
  if (verifyOutputs()) {
    console.log('[prepare] lib/ already built — skipping build')
    return 0
  }

  console.log('[prepare] building host bundle with esbuild (scripts/build-esbuild.mjs)')
  const status = run(process.execPath, [join(ROOT, 'scripts', 'build-esbuild.mjs')])

  if (status !== 0) {
    console.error('[prepare] build failed — the plugin cannot load without lib/index.js')
    console.error('[prepare] alternatives: (a) install from the Release tgz (prebuilt), or')
    console.error('[prepare] (b) run "npm run build:esbuild" in the package directory.')
    return status ?? 1
  }
  if (!verifyOutputs()) {
    console.error(`[prepare] build finished but ${REQUIRED.join(', ')} missing`)
    return 1
  }
  return 0
}

process.exit(main())
