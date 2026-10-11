#!/usr/bin/env node
/**
 * 客户端产物真实加载验证 —— 在模拟的 DSH ModuleLoader 环境中执行 lib/client.js。
 *
 * 为何需要：产物「构建成功」不等于「能被 DSH 加载」。
 * 已踩过的两类事故都只在**加载期**暴露，构建期一切正常：
 *   1) 缺 module/exports 声明 → `module is not defined` → 桌面版启动失败（白屏）
 *   2) 缺 `return module.exports` → factory 返回 undefined → apply/inject 丢失
 *      → 插件静默不生效（不报错，最难查）
 *
 * 本脚本断言：能注册正确的 id、factory 能执行、导出含 apply。
 *
 * 用法：node scripts/verify-client-load.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(ROOT, 'lib/client.js')

if (!existsSync(FILE)) {
  console.error(`verify-client-load: 找不到 ${FILE}（先构建）`)
  process.exit(1)
}
const src = readFileSync(FILE, 'utf8')

// externals 的最小桩：只要求 factory 能跑通，不校验运行时行为
const stubs = {
  'react': {
    createElement: () => ({}), useState: () => [null, () => {}], useEffect: () => {},
    useRef: () => ({ current: null }), useCallback: (f) => f, useMemo: (f) => f(),
  },
  'react/jsx-runtime': { jsx: () => ({}), jsxs: () => ({}), Fragment: {} },
  'react-dom': {},
  'react-dom/client': {},
  'cordis': {},
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-runtime/client': {},
}

const loaded = []
let captured = null
const sandbox = {
  window: {
    __ModuleLoader__: { load(entry) { loaded.push(entry && entry.id); captured = entry } },
  },
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  document: {
    createElement: () => ({ setAttribute() {}, append() {}, appendChild() {}, style: {}, classList: { add() {}, remove() {} } }),
    querySelector: () => null,
    head: { appendChild() {} },
    body: { appendChild() {} },
  },
  process: { env: { NODE_ENV: 'production' } },
}

let ok = true
const fail = (m) => { ok = false; console.log(`  ✗ ${m}`) }
const pass = (m) => console.log(`  ✓ ${m}`)

try {
  vm.runInContext(src, vm.createContext(sandbox), { filename: 'client.js' })
} catch (e) {
  fail(`脚本执行抛错: ${e.message}`)
}

if (loaded.length !== 1) fail(`应恰好注册 1 个模块，实际 ${loaded.length}`)
else pass(`注册 id = ${loaded[0]}`)
if (loaded[0] && !loaded[0].endsWith('dsh-super-injector-mod')) fail('注册 id 不是本修改版包名')

if (!captured || typeof captured.factory !== 'function') {
  fail('未捕获到 factory')
} else {
  try {
    const exportsObj = captured.factory((name) => {
      if (name in stubs) return stubs[name]
      throw new Error(`未声明的 external 依赖: ${name}`)
    })
    if (!exportsObj) {
      fail('factory 返回 undefined —— 缺 `return module.exports`，导出会全部丢失')
    } else if (typeof exportsObj.apply !== 'function') {
      fail(`导出不含 apply 函数（实际键: ${Object.keys(exportsObj).join(', ') || '(空)'}）`)
    } else {
      pass(`factory 执行成功，导出键 = ${Object.keys(exportsObj).join(', ')}`)
    }
  } catch (e) {
    fail(`factory 执行抛错: ${e.message}`)
  }
}

console.log(ok ? '\n✓ client bundle 可被 DSH ModuleLoader 正常加载' : '\n✗ client bundle 验证失败')
process.exit(ok ? 0 : 1)
