#!/usr/bin/env node
/**
 * 无 tsdown 环境下的产物构建（esbuild 版）——本修改版自用。
 *
 * 背景：上游官方构建走 `bash scripts/build.sh`（需 DSH_CHECKOUT 检出）
 * 与 `tsdown`（host ESM 自包含 + client CJS + ModuleLoader 壳）。
 * 本机没有 tsdown，改用 esbuild 重建 lib/。
 *
 * 【2026-10-12 0.4.0-mod.1】本包已移除 client 半侧（设置页插件管理 UI）：
 * 装卸/开关交给官方 dsh-plugin-manager，本包不再声明 dsh.client。
 * 故此处**只构建 host 产物** lib/index.js。
 *
 * ⚠️ 若将来恢复自带 UI，必须先补回三处硬契约（历史事故见 git 与 CHANGELOG）：
 *   ① factory 体内声明 module/exports —— 否则 `module is not defined`，
 *      桌面版启动即失败、主界面白屏；
 *   ② 尾部 `return module.exports;` —— 否则 factory 返回 undefined，
 *      apply/inject 全部静默丢失（不报错，最难查）；
 *   ③ charset: 'utf8' —— 否则中文被转义成 \uXXXX。
 *   另需恢复 package.json 的 `dsh.client` 声明与 `exports["./client"]`；
 *   两者与 lib/client.js **同生同死**——只恢复其中一个会命中 dev_plugin_status
 *   的「必崩项」检查（声明了 dsh.client 却没有 lib/client.js）。
 *
 * 用法：node scripts/build-esbuild.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// esbuild 解析：先本包 node_modules，再回退到常见宿主位置
function resolveEsbuild() {
  const cands = [
    join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
    'C:/repository/dsh-projectless/node_modules/esbuild/lib/main.js',
    'C:/Users/53518/dsh-plugins/dsh-mcp-manager/node_modules/esbuild/lib/main.js',
    'C:/Users/53518/dsh-plugins/历史插件归档/dsh-session-id-稳定版/node_modules/esbuild/lib/main.js',
  ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}
const esbuildPath = resolveEsbuild()
if (!esbuildPath) {
  console.error('build-esbuild: 找不到 esbuild。请在本包安装 esbuild，或修改 resolveEsbuild() 的候选路径。')
  process.exit(1)
}
const { build } = await import(pathToFileURL(esbuildPath).href)

// ── host：ESM + 自包含（除 node: 内置外全内联，任何装配路径可加载）──
const host = await build({
  entryPoints: [join(ROOT, 'src/index.ts')],
  outfile: join(ROOT, 'lib/index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  minify: false,
  sourcemap: true,
  charset: 'utf8',
  external: ['node:*'],
  logLevel: 'warning',
  absWorkingDir: ROOT,
  // 裸名 → 生态作用域包：本包无自带 node_modules，宿主只有 @deepseek-ai/* 的
  // 作用域形态（npm 式布局），裸 `cordis` / `schemastery` 无法直接解析。
  alias: {
    cordis: 'C:/Users/53518/dsh-plugins/node_modules/@deepseek-ai/cordis/lib/index.js',
    schemastery: 'C:/Users/53518/dsh-plugins/node_modules/@deepseek-ai/schemastery/lib/index.mjs',
  },
})
if (host.errors.length) {
  console.error('HOST BUILD FAILED')
  for (const e of host.errors) console.error(e.text, e.location)
  process.exit(1)
}

// ── 产物自检（把踩过的坑变成断言）──
let ok = true
const hostSrc = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')

const checks = [
  ['host 含包名', hostSrc.includes('@dsh-external/dsh-super-injector-mod')],
  ['无双重后缀 -mod-mod', !hostSrc.includes('-mod-mod')],
]
for (const [desc, pass] of checks) {
  if (!pass) ok = false
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`)
}
if (!ok) {
  console.error('FAIL: 产物自检未通过')
  process.exit(1)
}
console.log(`\nOK: lib/index.js (${hostSrc.length})`)

// client 产物已废弃：残留只会造成「以为还有 UI」的误判
if (existsSync(join(ROOT, 'lib', 'client.js'))) {
  console.log('提示：lib/client.js 仍存在，但本包已不声明 dsh.client（不会被加载）——可直接删除。')
}
console.log('提示：产物结构正确不代表语义正确，建议再跑一次真实注入验证。')
