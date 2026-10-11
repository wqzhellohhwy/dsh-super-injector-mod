#!/usr/bin/env node
/**
 * 无 tsdown 环境下的产物构建（esbuild 版）——本修改版自用。
 *
 * 背景：上游官方构建走 `bash scripts/build.sh`（需 DSH_CHECKOUT 检出）
 * 与 `tsdown`（host ESM 自包含 + client CJS + ModuleLoader 壳）。
 * 本机没有 tsdown，改用 esbuild 重建 lib/，产物形态与上游**逐项对齐**。
 *
 * ⚠️⚠️ client 产物的三个致命细节（都已踩过坑，务必保留）⚠️⚠️
 *
 *  1) **必须声明 module/exports**
 *     DSH 的 `window.__ModuleLoader__.load({ factory: (require) => {...} })`
 *     **只提供 require**，不注入 CommonJS 的 module/exports。缺声明时报
 *     `module is not defined` → 桌面版启动失败、主界面白屏。
 *     （注：esbuild **没有** rollup/tsdown 的 `intro` 选项，只能用 banner 合并。）
 *
 *  2) **尾部必须 `return module.exports;`**
 *     esbuild 的 cjs 输出把导出赋给 `module.exports`；而 ModuleLoader 取的是
 *     **factory 的返回值**。不 return 则 factory 返回 undefined，
 *     apply/inject 全部丢失，插件**静默不生效**（不报错，更难查）。
 *
 *  3) **charset: 'utf8'**
 *     否则 esbuild 把中文转义成 \uXXXX，日志可读性下降且与上游产物形态不符。
 *
 * 上游 client 产物实测结构（本脚本严格复刻）：
 *   window.__ModuleLoader__.load({
 *     id: "<pkg>",
 *     factory: (require) => {
 *       var module = { exports: {} };
 *       var exports = module.exports;
 *       Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
 *       ...代码...
 *       return module.exports;
 *     }
 *   });
 *
 * 用法：node scripts/build-esbuild.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN_ID = '@dsh-external/dsh-super-injector-mod'

// esbuild 解析：先本包 node_modules，再回退到常见宿主位置
function resolveEsbuild() {
  const cands = [
    join(ROOT, 'node_modules', 'esbuild', 'lib', 'main.js'),
    'C:/repository/dsh-projectless/node_modules/esbuild/lib/main.js',
    'C:/Users/53518/dsh-plugins/dsh-mcp-manager/node_modules/esbuild/lib/main.js',
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

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

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
})
if (host.errors.length) {
  console.error('HOST BUILD FAILED')
  for (const e of host.errors) console.error(e.text, e.location)
  process.exit(1)
}

// ── client：CJS + ModuleLoader 壳（见文件头三个致命细节）──
const client = await build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  minify: false,
  sourcemap: true,
  charset: 'utf8',
  external: CLIENT_EXTERNALS,
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  banner: {
    js: 'window.__ModuleLoader__.load({\n'
      + '\tid: ' + JSON.stringify(PLUGIN_ID) + ',\n'
      + '\tfactory: (require) => {\n'
      + '\t\tvar module = { exports: {} };\n'
      + '\t\tvar exports = module.exports;\n'
      + '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
  },
  footer: { js: '\t\treturn module.exports;\n\t}\n});' },
  logLevel: 'warning',
  absWorkingDir: ROOT,
})
if (client.errors.length) {
  console.error('CLIENT BUILD FAILED')
  for (const e of client.errors) console.error(e.text, e.location)
  process.exit(1)
}

// ── 产物自检（把踩过的坑变成断言）──
let ok = true
const hostSrc = readFileSync(join(ROOT, 'lib/index.js'), 'utf8')
const clientSrc = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')

const checks = [
  ['host 含包名', hostSrc.includes(PLUGIN_ID)],
  ['client 含包名', clientSrc.includes(PLUGIN_ID)],
  ['client intro: var module', /var module = \{ exports: \{\} \};/.test(clientSrc)],
  ['client intro: var exports', /var exports = module\.exports;/.test(clientSrc)],
  ['client intro: toStringTag', /Object\.defineProperty\(exports, Symbol\.toStringTag/.test(clientSrc)],
  ['client footer: return module.exports', /return module\.exports;/.test(clientSrc)],
  ['无双重后缀 -mod-mod', !hostSrc.includes('-mod-mod') && !clientSrc.includes('-mod-mod')],
]
for (const [desc, pass] of checks) {
  if (!pass) ok = false
  console.log(`  ${pass ? '✓' : '✗'} ${desc}`)
}
if (!ok) {
  console.error('FAIL: 产物自检未通过')
  process.exit(1)
}
console.log(`\nOK: lib/index.js (${hostSrc.length}) + lib/client.js (${clientSrc.length})`)
console.log('提示：产物结构正确不代表语义正确，建议再跑一次真实加载验证。')
