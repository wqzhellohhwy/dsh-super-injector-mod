# Changelog

本项目版本与仓库提交对应，格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **版本以 git tag 为准**：已发布 v0.3.1 / v0.3.3（GitHub Releases 资产）；未打 tag 的
> 小节为开发史（其内容随下一个发布一并交付）。

## 2026-10-25 22:41 — 0.4.0-mod.8 落地双缓存 CJS 清理与跨实例 API · 8e24196

## 跨实例 API（2026-10-17，未发布）

### 新增（让「元操控」能管到**别的实例**）

背景（用户需求）：元操控应分「本实例」与「其他实例」—— `dev_*` 全是进程内的
（`ctx.loader` / `ctx.tools`），管不到别的进程。补上 HTTP 通道：

- 新增 **`/super-injector/api`**（host 侧，仅当本实例有 HTTP 服务时挂载）：
  | 动作 | 说明 |
  |---|---|
  | `GET  /status?token=…` | `{ ok, pid, injected[], tokenFile }` |
  | `POST /reload` `{token, match, urlMatch?}` | 等价于 `dev_reload_package` |
  | `POST /inject` `{token, dir}` | 等价于 `dev_inject_plugin` |
  | `POST /uninject` `{token, match, self?}` | 等价于 `dev_uninject_plugin` |
- **鉴权**：per-instance token，首次启动生成并落在 registry 同目录
  （`…/super-injector/instances/<profile>/cross-instance-token.txt`，32 字符随机）；
  缺失或错误一律 **401**。DSH 的 webServer 本来就只绑回环。
- **装配**：用 `ctx.inject(['webServer'], …)` 建**子 fiber** —— headless / tui 没有 HTTP
  服务时这块自动跳过，主 fiber 照常加载（沿用 0.4.0-mod.4「不硬依赖 webServer」的原则）。
- 与既有 **watch 自动重载**（config `watches` + registry 注入项，1500ms 轮询产物指纹）
  配合，形成两条跨实例通道：**主动命令**（本 API）与 **改产物即生效**（watch）。

### 实测（临时 profile `meblk` 的 web 实例 19399，从 backup 实例发起）

| 动作 | 结果 |
|---|---|
| `GET /status`（带 token） | `{ ok:true, pid:14488, injected:[] }` |
| 无 token / 错 token | **401** ✓ |
| `POST /reload {match:"dsh-memory-evolve-mod"}` | `OK: 热重载完成（清缓存 69 模块，重建 1 fiber）` ✓ |
| `POST /reload {match:"dsh-cache-keepalive"}` | `OK: 热重载完成（清缓存 10 模块，重建 1 fiber）` + 渲染端模块图重组广播 ✓ |
| `POST /inject {dir:…lab-probe-plugin}` | `OK: 已注入（host ✓）` ✓ |
| 改该插件的 lib 产物 → 等 1.5s | **目标实例自动热重载**（`stats.json` 的 `reload.ok` 由 2 → 3）✓ |
| `POST /uninject {match:"lab-probe-plugin"}` | `OK: 卸载完成`（registry 清理 + junction 删除）✓ |

### agent 约定

- 跨实例操控：读目标实例的 `cross-instance-token.txt` → 打 `http://127.0.0.1:<port>/super-injector/api/*`。
- token 文件在**目标实例的 DSH_HOME** 下（临时 profile 若开了隔离 home，则在 `<profile>/.lab-home/.dsh/…`）。
- 本 API 只做 reload / inject / uninject / status，**不做任意代码求值**。

## [0.4.0-mod.7] — 2026-10-17（双缓存清理：自检 9/9）

### 修复⑦ 自重载/热重载「新代码不生效」：漏清 CJS `require.cache`

- **根因（实验证实）**：Node 24 下经 `import()` 加载的 CJS 模块**同时**进入
  ① ESM `loader.internal.loadCache` 与 ② CJS `require.cache` 两个缓存。
  原 `purgeCache` **只清 ①** → 重 import 仍返回旧模块。
  依据：`dsh-hmr/lib/index.js` L899-914 的官方注释明写「必须清两个缓存」。
- **实验对照**（同一模块、同一次改动）：
  | 操作 | 结果 |
  |---|---|
  | 只清 loadCache | `SENTINEL = GEN_A`（**仍旧**）❌ |
  | 双清 | `SENTINEL = GEN_B` ✅ |
- **同时证伪了 `?v=N` 方案**：另做实验确认「清 loadCache 后 import **确实重读磁盘**」
  （读到改动后的新值）——所以**不需要** URL query 缓存击穿，缺的就是 CJS 缓存那一半。
- **改法**：
  - `purgeCache()` 拆为两段：① ESM loadCache（原逻辑，保留 `Map.prototype.*.call`
    特例处理）② 新增 `purgeCjsCache()` —— 用 `createRequire(import.meta.url)` 取
    `require.cache`，按包目录前缀（规范化 `/`、小写）`Reflect.deleteProperty` 清除。
  - 自重载排程前（工具侧 purge 之后）**额外补一次** `purgeCjsCache(自身入口目录)`：
    注入器自身入口是 ESM，但依赖链可能夹带 CJS，且 rebuild 走 `tree.import(包名)`
    的解析路径可能与 entry URL 不同，按目录兜底清一遍。
  - 顶部新增 `import { createRequire } from 'node:module'`。
- **影响**：热重载与自重载**真正换到新代码**（此前 reborn 的 fiber 跑的是旧模块闭包）。

### 自检新增回归项（防复发）

- `dev_self_test` 增加 **`双缓存清理（自重载换代码）`**：临时目录写 CJS 模块 →
  import 取 `GEN_A` → 改盘为 `GEN_B` → `purgeCache(目录)` → 再 import，断言读到 `GEN_B`。
  将来若有人删掉 `purgeCjsCache`，该项立刻变红。
- **结果：`dev_self_test` PASS 9/9**（此前 8/8）。

### 遗留项 2 调查结论（不做改动）

- 曾尝试把 `dsh-cache-keepalive` 的旧 `build.sh`（0.4.0-mod.5 之前生成、
  只认 `packages/`）升级为新版脚本。**已回滚，未保留改动。**
- **原因**：该插件有自己的既有构建链与构建方式，**不适用**本模板：
  - `package.json` 为 `main: ./src/index.ts`（**源码直跑**），且带 `dsh.client` 半侧、
    `tests/`、`cli/` 目录——用 `dev_scaffold_plugin` 重生成会**冲掉 package.json**，禁用。
  - 其 `lib/` 产物里保留 `from './xxx.ts'` 形式的引用，说明其编译选项
    （`allowImportingTsExtensions`）与本模板不同；套用本模板会报
    `TS5097 / TS2339` 等**其自身源码**的类型错误（既有状态，非本次引入）。
  - 实测对照：旧脚本 `exit 1`（`cannot locate the dsh checkout`，栈都进不去）；
    新脚本能跑完探测+链接+tsc，但编译失败于该插件源码。
- **结论**：`dev_build_plugin` 走的是**插件目录里已有的** `scripts/build.sh`，
  对本插件不适用；不宜强行统一。

### 验收

- `dev_self_test` **PASS 9/9**。
- 全链路回归：`dev_scaffold_plugin` → `dev_build_plugin`（npm 布局）→
  `dev_inject_plugin`（工具可调用）→ `dev_uninject_plugin`（卸载干净）全通过。
- 自重载连续多次 `force:true` 均无 `reboot-failed`。
- 环境干净：无临时目录、无测试插件残留；`dsh-cache-keepalive` 已回滚至原状。

## [0.4.0-mod.6] — 2026-10-17（npm 布局构建链修复：自检 8/8 打通）

前置：0.4.0-mod.5 的修复需重启实例才生效（进程内 ESM 缓存）。重启后自检从
`PASS 0/1` → `PASS 1/2`，逐步暴露并修复下列 4 处。

### 修复③ 编译依赖路径错：npm 布局下 `cordis` / `cosmokit` / `schemastery` 是**作用域包**

- **现象**：`[FAIL] 测试插件构建 — missing .../node_modules/cordis`。
- **根因**：npm 式运行时安装里这三个是 `@deepseek-ai/<name>` **作用域包**，
  顶层 `node_modules/cordis` **不存在**（实测：`node_modules/@deepseek-ai/cordis` ✅）。
  0.4.0-mod.5 的 npm 分支误写为顶层路径。
- **改法**：`SCAFFOLD_BUILD_SH` 与自检内联 build.sh 的 npm 分支改为
  `$CHECKOUT/node_modules/@deepseek-ai/{cordis,cosmokit,schemastery}`；
  拆出 `SRC_CORDIS/SRC_COSMOKIT/SRC_SCHEMASTERY/SRC_TOOLS/SRC_LLM/SRC_SYSPROMPT`
  变量，src 布局仍取 `vendor/*` + `packages/*`。
- **附带**：npm 布局无 `.pnpm` 目录，`find .../.pnpm` 在 `set -e` 下返回非 0
  **静默终止脚本**（实测：链接完成后脚本直接死掉，tsc 从未执行）→ 用
  `if [ -d ... ]` 包裹 + `|| true` 兜住，并补扁平路径 `node_modules/@standard-schema/spec`。
- **附带**：自检内联 build.sh 漏 link `@types/node`，而 tsconfig 有 `"types":["node"]`
  → `error TS2688: Cannot find type definition file for 'node'`。已补。

### 修复④ `findTsc` 目录推导多了一层 `dirname`

- **现象**：`[FAIL] 测试插件构建 — tsc not found`。
- **根因**：`findTsc` 里 `pluginsRoot = dirname(dirname(resolve(here,'..')))` 多算一层，
  得到 `C:\Users\53518` 而非 `C:\Users\53518\dsh-plugins` → 扫 173 个无关目录，未命中。
- **改法**：`pluginRoot = resolve(here,'..')`；`pluginsRoot = dirname(pluginRoot)`。
- **背景**：本机 DSH 运行时**不带 tsc**，npm 安装也没有 `.bin/tsc`；
  实测有 3 个同级插件（`dsh-context-fold`/`dsh-projectless`/`dsh-tool-manager`）
  装了 `typescript@5.9.3`，故按「checkout → 自身 → 同级插件 → 全局」顺序复用。
  优先用 `node <...>/typescript/lib/tsc.js`（跨平台，不依赖 shell 解析 `.cmd`）。
  新增 `DSH_TSC` 环境变量由宿主预解析后传给 build.sh（自检 tmpDir 在
  `$DSH_HOME/super-injector/` 下，距插件目录很远，脚本内相对 glob 够不到）。

### 修复⑤ `SCAFFOLD_BUILD_SH` 模板被自家注释里的反引号提前截断

- **现象**：`dev_build_plugin` 报 `OK`，但插件目录**没有 `lib/`**，tgz 内只有
  `package.json` + `README.md`（无任何代码）。
- **根因**：模板注释写了 `` 必须 `|| true` 兜住 ``，**注释内的反引号终止了 TS 模板字符串**
  → 生成的 build.sh 截断在第 103 行，`@standard-schema` 链接与**整个 tsc 编译段全部丢失**。
  （`bash -n` 检测不出：截断后的脚本语法本身合法，且 `set -e` 静默退出 0。）
- **改法**：注释去掉反引号，改写为「必须用 || true 兜住」。
- **教训**：`SCAFFOLD_*` 模板内的注释**禁用反引号**（与 CSS 注释禁令同理）。

### 修复⑥ `eval` 执行 tsc 命令

- **现象**：`scripts/build.sh: line 130: "C:\Program: No such file or directory`
- **根因**：`$TSC` 是带引号的多词命令（`"node" "/path/tsc.js"`），直接 `$TSC -p`
  会按空格词分割后整体当作命令名。
- **改法**：改为 `eval "$TSC -p tsconfig.json"`。

### 验收（全部实测通过）

- **`dev_self_test` → `PASS 8/8`**（此前 0/1）：checkout 探测 / 测试插件构建 /
  注入 host✓ / 热重载 uid 385→386 / 自重载节流拒绝 / 预检拦截 / 预检后 lib 恢复 / 卸载即净。
- **`dev_build_plugin` 端到端**：`dev_scaffold_plugin` → `dev_build_plugin`
  → 产出 `lib/index.js`(2135B) + `lib/types/index.d.ts` + `lib/index.js.map`，
  tgz 含完整代码，模块可 import（`apply=function`）。
- **注入闭环**：`dev_inject_plugin` → 工具 `_dsh_external_scaffold_e2e_probe_hello`
  实际可调用并返回 → `dev_uninject_plugin` 卸载干净（工具从工具面消失，
  registry/junction/client 表全清）。
- **自重载**：连续多次 `force:true` 均**无 `reboot-failed`**，直接走 purge-stale-tools +
  client-meta-healed 正常收尾（0.4.0-mod.5 的修复①在主路径生效，不再走 touch patch 兜底）。
- **脚本语法**：两个内嵌 build.sh 抽离后 `bash -n` 均 exit 0；并各自在独立目录
  从零跑通至 `=== Build complete ===`。

### 已知未修

- **进程内 ESM 缓存**：注入器自重载无法在同一进程内加载自身新代码
  （Node 对同 URL 重复 `import()` 返回同一模块对象，仅 `?v=N` 可击穿）→ 改注入器本身
  仍需重启实例。详见 0.4.0-mod.5 小节。
- **既有旧插件不受益**：`dev_build_plugin` 用的是**插件目录里已存在的** `scripts/build.sh`。
  0.4.0-mod.5 之前生成的插件（如 `dsh-cache-keepalive`）仍带旧的「只认 packages/」脚本，
  需用 `dev_scaffold_plugin` 重新生成或手工同步脚本才能构建。

## [0.4.0-mod.5] — 2026-10-17（两个实测缺陷修复）

### 修复① 自重载主路径 100% 失败：`entry._dispose` 契约不存在

- **现象**：`dev_reload_package {packageName:"dsh-super-injector-mod", force:true}` 每次都
  以 `reboot-failed: Error: selfEntry 无官方 _dispose（loader 契约缺失）` 结束，
  随后由 `touch patch` 兜底（多绕约 7 秒）。
- **根因（源码实证）**：DSH ≥0.2.0-rc 的 loader **Entry 类没有 `_dispose` 方法**。
  `cordis-plugin-loader/lib/index.js` 的 Entry 字段表只有
  `loader / ctx / fiber / moduleNamespace / parent / options / subgroup / subtree / _initTask`；
  `dispose` 是 **Fiber** 的公开属性（`cordis/lib/index.js` L1075：
  `this.dispose = parent.fiber.effect(...)`）。`_dispose` 在该版本全库 **0 处**。
- **改法（`src/index.ts` 重启器）**：
  - 去掉硬性 `typeof entry._dispose !== 'function'` 前置断言。
  - 卸旧 fiber 改为优先级链：**`oldFiber.dispose()`**（官方 Fiber 契约，disposer 内部已做
    registry 清理 + `_setEpoch(INACTIVE)` + `_unload`）→ 退 `entry._dispose()`（旧版兼容）
    → 都没有才抛错（错误串改为「旧 fiber 无 dispose」）。
  - 卸完显式 `entry.fiber = null`，再建新 fiber 并重新关联（原逻辑保留）。
- **影响**：自重载走通主路径，不再依赖 `touch patch` 兜底（省约 7 秒 + 少一次全量重装配）。

### 修复② `detectCheckout` 过严：npm 式运行时安装上生产线全线不可用

- **现象**：`dev_self_test` 返回 `PASS 0/1`（`[FAIL] checkout 探测 — 无 DSH_CHECKOUT`），
  早退于 L3237 的 `if (!checkout) { return summarize(results) }`；
  `dev_build_plugin` / `dev_release_plugin` 同样直接报错。
- **根因**：原实现硬要求 `<root>/packages`（monorepo 源码树）。本机是 **npm 式运行时安装**
  （`C:\dsh-runtime\0.2.0-rc.2` 下只有 `node_modules/`，无 `packages/`），
  故探测必然失败。旁证：`dsh-cache-keepalive` 有 `build.sh`（引用 `packages/`）
  却无 `lib/`，正在源码直跑——同一个坑。
- **改法（`src/index.ts`）**：
  - `detectCheckout()` 同时认两种布局：**源码 checkout**（`packages/core/tools`）与
    **npm 运行时安装**（`node_modules/@deepseek-ai/dsh`）；返回值带 `::src` / `::npm` 后缀。
  - 新增 `splitCheckout()` 拆 `[纯路径, 布局]`，两处调用点（`dev_build_plugin`、`dev_self_test`）
    改为透传 `DSH_CHECKOUT`（纯路径）+ **`DSH_CHECKOUT_KIND`**（布局标记）。
  - **防误判**：判定"像 dsh 根"额外要求**不是插件目录**（有 `package.json` 且声明 `dsh`
    或包名以 `@dsh-external/` 开头则排除）。否则插件自己的 `node_modules/@deepseek-ai/dsh-tools`
    会把普通插件目录误判成 dsh 根（实测：曾误选 `C:\Users\53518\dsh-plugins\dsh-cache-keepalive`）。
  - **选对版本**：`C:\dsh-runtime` 下有多个版本时，先按 `process.execPath` 上溯定位当前
    运行实例，再退化为按 mtime 新→旧排序取最新（实测修正前会误选旧版 `0.1.0-rc.7`）。
  - `dev_self_test` 的早退分支改为：探测成功时**记录一条 PASS**（含布局标记），
    失败才记 FAIL。
- **`SCAFFOLD_BUILD_SH`（生成的脚手架 build.sh）与 `dev_self_test` 内联 build.sh** 同步改造：
  - 新增 `KIND` 判定；`src` 布局取 `vendor/*` + `packages/*`，
    `npm` 布局取 `node_modules/*`；
  - `link_pkg` 增加"目标不存在即报错退出"，避免静默建出悬空 junction；
  - `tsc` 缺失时退 `npx --no-install tsc`。
- **影响**：npm 式运行时安装上，`dev_build_plugin` / `dev_release_plugin` / `dev_self_test`
  与生成的脚手架**全部可用**。

### 发现 / 未修（需重启实例才生效）

- **进程内 ESM 缓存**：Node 对**同一 URL** 重复 `import()` 返回**同一模块对象**
  （实测 `m1 === m2` 为 true），只有带 query 的 URL（`?v=N`）才击穿。
  因此**注入器自重载无法在同一进程内加载自己的新代码**——reboot 由旧模块闭包执行，
  其内部逻辑已是旧版。本次两个修复已落盘并验证，但**当前 backup 实例仍运行旧代码**，
  需重启实例（或新起实例）才生效。
  > 后续可考虑：自重载时给入口 URL 附自增 `?v=N`（同 `dev_reload_preset` 的做法）。
  > 未在本版实施——riskiest 的点是 URL 与 `loadCache` key / entry URL 的匹配逻辑，
  > 需单独设计与回归。

### 验证

- 构建：`node scripts/build-esbuild.mjs` → `OK: lib/index.js`，自检项全过。
- 产物与源码工具名逐一对齐：**18 个**（无增删）。
- 两个内嵌 shell 脚本抽出后 `bash -n` 语法检查 **exit 0**。
- 新产物在**全新进程**中 `import` 成功：`name = dsh-super-injector-mod`，
  `apply = function`，`inject = ["loader","timer","tools","systemPrompt"]`。
- 磁盘产物特征串核验：5 条新串全在、2 条旧串全无。

## [0.4.0-mod.4] — 2026-10-17（文档一致性修正，同版本追加）

### 修正（文档与代码不一致：工具表缺 7 个、路径/版本过时）

审计基线：`src/index.ts` 实际注册 **18 个 `dev_*` 工具**（`safeRegister(defineTool(` 调用点
18 处：L1658/1689/1708/1720/1750/2646/2684/2700/2718/2748/2797/2836/2853/2915/3012/
3090/3158/3202），与 `lib/index.js` 18 个唯一 `dev_*` 名逐一对齐。
（此前 CHANGELOG 自称"19 个"、任务口径"22 个"均为多算。）

- **package.json:3** 版本 `0.4.0-mod.3` → **`0.4.0-mod.4`**（0.4.0-mod.4 的 webServer 惰性
  改动早已落地在源码 L500，版本号未跟进）。
- **package.json description**：
  - 删「等待纪律（阻塞等待 ≤30s）」——该段已删（见 0.4.0-mod.3），描述仍宣称。
  - 「清单持久化重启自动恢复」→ 补**按当前 profile 隔离**（L748-749）。
  - 补 0.4.0-mod.4 的 webServer 惰性获取条目。
- **README.md 工具全家桶表 10 行 → 18 行**，按四域重排（注入核心 6 / 自愈修复 3 /
  侧挂区 5 / 生产线+自检 4）。**补 7 个**：`dev_reload_preset`、`dev_heal_links`、
  `dev_fix_patch`、`dev_scaffold_plugin`、`dev_build_plugin`、`dev_release_plugin`、
  `dev_self_test`。
  > 修正前 README **正文**在教用 `dev_scaffold_plugin`/`dev_build_plugin`/`dev_release_plugin`，
  > 而同文件**工具表**一个都没列——表与正文自相矛盾。
- **README.md 版本** `0.4.0-mod.1` → `0.4.0-mod.4`；删已过时的「等待纪律」改动行。
- **README.md 路径修正**：registry `~/.dsh/super-injector/registry.json` →
  `$DSH_HOME/super-injector/instances/<当前 profile>/registry.json`（L108、L297）；
  junction `profiles/web/node_modules` → `<当前 profile 目录>/node_modules`（L295）。
- **README.md 自动 watch**：注明 1.5s 仅注入清单源默认值，`config.watches` 源为 30 秒；
  补「指纹变化先预检可加载，通过才重载」（L103）。
- **README.md 安装方式 A/B**：不再指向上游仓库/上游包名；`prepare` 说明由 tsdown 改为
  实际 `node scripts/prepare.mjs`（package.json:40）。
- **README.md 卸载**：补 `self: true` 自举卸载参数。
- **README.md 机制节**：补第 5 条操作串行锁（120s/180s 双闸门）。
- **INSTALL.md**：正文全篇由「上游原文」改为本修改版（包名/entry id/仓库/链接全量校正）；
  删不存在的 `scripts/install-injector.ps1` 引用（不在 package.json `files` 内，
  发布 tgz 中无此脚本）；修正重复的「## 5.」（→ 6/7/8/9 顺延）；
  `dev_self_test`「8 项」→「约 5-8 项，随环境浮动」。
- **docs/SPEC.md**：§4.1 操作矩阵补「操作串行」行（`withOpLock`，L657-658、696-727）；
  §5 铁律 7「首轮锚定」注明**本包自身不实现**，仅存在于脚手架模板注释（L188-201）。

### 验证

- 构建产物 `lib/index.js` 由 `scripts/build-esbuild.mjs` 重建。
- `dev_self_test` 全链路回归 + 热重载。

## [0.4.0-mod.4] — 2026-10-17（未发布）· 代码改动（webServer 惰性）

### 修复（`webServer` 硬依赖：headless / tui 里整个插件 pending，元操控工具全不下发）

- **问题（用户实测）**：host 主模块声明 `inject = ['loader','timer','tools','systemPrompt','webServer']`，
  而 headless / tui 这类 profile **没有 HTTP 服务** → cordis 判定依赖缺失 → 整个插件 `pending`，
  `dev_*` 一个都不注册。实测日志：`dsh-super-injector-mod: pending (waiting for service: webServer)`。
- **改法**：
  - `src/index.ts` 的主模块 `inject` 去掉 `'webServer'`（cordis 的 inject 只支持"必需服务"，没有 optional 形式）。
  - 新增 `webServerOf(ctx)`：`ctx.get('webServer') ?? null`（带 try/catch）—— 没 HTTP 服务时返回 null。
  - 两处读取路由表的地方（`clearRoutesByMatch` 热重载路由自愈、`dev_clear_routes` 工具）改用它；
    没有 webServer 时按"不可访问/无匹配"如实返回，不再抛错。
  - 类型声明 `webServer: any` → `webServer?: any`。
- **影响**：**headless / tui 实例现在也能用全部 `dev_*` 元操控工具**（实测 19 个全部注册）。
  代价：`dev_stage_*` 里挂的自定义代码若直接写 `ctx.webServer` 会报"cannot get required service"，
  改用 `ctx.get('webServer')`。
- 生效：需重载注入器或重启实例。

## [0.4.0-mod.3] — 2026-10-14（未发布）

### 变更（系统提示词：移除「等待纪律」段落）

- 应要求删除 `ctx.systemPrompt.section()` 注册文本末尾的
  `【等待纪律（2026-10-11 暴毙事故教训）】…`（原 `src/index.ts:3195` 同一字符串内）；
  前面关于 `dev_*` 工具的说明**保留**。
- 影响：系统提示词前缀变化 → KV 缓存失效一次（下一轮全量重算）。
- 生效：需重载注入器或重启实例。

### 修复（W1 / W2：会话永久卡死 与 watch 每 30 秒误报）

**W1 —— `withOpLock` 无限排队导致整个会话永久卡死**（`src/index.ts` 模块级）

- 现象（实测 2026-10-14 19:21:20，会话 `session-1f64b53f-92df-40b9-b3b6-37672218f2bf`）：
  `dev_reload_package {packageName:"dsh-cache-keepalive"}` 卡住 → 工具永不返回 →
  DSH 的 turn 永不结束 → 会话永久「运行中」、停止按钮无效 → 只能强杀实例。
  全库扫描（241 会话）另有 8 次同类现场，卡住工具 `dev_reload_package` 3、`pwsh` 2、
  `job_output` 2、`dev_inject_plugin` 1。
- 根因：`opChain = run.then(...)` 是**无限期**串行链。任何一步的 Promise 永不 settle
  （`reloadPackage` 内的 `await oldFiberEntry.dispose()` 是实测嫌疑点），后续
  inject / uninject / reload / install **全部无限排队**，而调用方（工具 execute）同步挂着。
- 改法：两道闸门 —— 等前一个操作 `OP_LOCK_WAIT_MS = 120_000`；单次操作
  `OP_LOCK_RUN_MS = 180_000`。超时即让链条解冻并审计
  （tag `op-lock-wait-timeout` / `op-lock-run-timeout`，写入 `instances/<profile>/self-heal.log`）。
- 取舍：放宽的是「无限等待」，不是「竞态保护」；正常操作（秒级）行为与原先完全一致。
- 接线：新增模块级审计出口 `opLockAudit`（`withOpLock` 定义在 `apply()` 之外，拿不到实例级
  `auditLog`），由 `apply()` 内 `opLockAudit = auditLog` 注入。

**W2 —— `watch-dangling` 对「源码直跑」插件每 30 秒误报**（`src/index.ts`）

- 现象：`C:\Users\53518\dsh-plugins\dsh-cache-keepalive` 自 `2026-10-14T02:37:59Z` 起，
  每 30 秒一条 `watch-dangling: 目录不可读，跳过自动重载（源被删/悬空 junction）`，
  日志被刷满，真假悬空无法区分。
- 根因：watch 指纹硬编码探 `<插件目录>/lib`；该插件无构建链
  （`package.json` 的 `main` 直指 `src/index.ts`）→ `readdirSync` 抛错 → 判为「目录不可读」。
- 改法：新增 `fingerprintTargetOf(pkgDir)` 三档回退 —— 有 `lib/` 用 `lib/` + `.js`（保持原语义）
  → 否则读 `package.json` 的 `main` 所在目录 + `[.ts,.mjs,.js]` → 再退到包根目录。
  `fingerprintOf(dir, { exts, skipNodeModules })` 支持自定义扩展名；**回退到包根目录时必须
  `skipNodeModules: true`**（否则会递归进 junction 指向的整个 dsh 运行时）。

**W3 —— 重载预检与入口解析硬编码 `lib/index.js`，源码直跑插件无法自动重载**（W2 的收尾）

- 现象：`self-heal.log` 成片
  `watch-precheck-blocked: 自动重载预检失败（新代码不可加载），保持旧代码: …dsh-cache-keepalive`
  （2026-10-15 00:13–00:16 十几条）→ 该插件的 **watch 自动重载被永久阻断**。
- 根因：W2 只修了**指纹探测**（不再误报「目录不可读」），但**预检与入口解析仍硬编码
  `<dir>/lib/index.js`**；而 dsh-cache-keepalive 无构建链（`main` 直指 `src/index.ts`）
  → `existsSync` 恒 false → `probeOk` 恒 false。
- 改法（4 处，**全部保持 `lib/index.js` 优先，只加 fallback**）：
  1. 新增 `entryFileOf(pkgDir)`：`lib/index.js` → 按 `package.json` 的 `main` 解析 → `null`；
  2. 新增 `ENTRY_FILE_RE = /\.(js|mjs|cjs|ts|mts|cts)$/`；
  3. **watch 预检** 改用 `entryFileOf(w.dir)`；
  4. **reloadPackage**：`entryUrl` 增加 `?? urls.find(u => ENTRY_FILE_RE.test(...))` 兜底；
     降级路径的 `candidates` 追加 `entryFileOf(<profileNodeModules>/<name>)` 与 `entryFileOf(urlMatch)`。
- 影响面：对**有 lib** 的插件行为**完全不变**（依旧优先 `lib/index.js`）。
- 产物：`lib/index.js` 416_989 → **417_829** 字节；备份 `lib/index.js.bak-20261015-0041`。

### 构建（依赖链接修复 —— 与本包代码无关，但阻断构建）

- 本包 `node_modules` 内全部构建依赖 junction 原指向
  `C:\repository\dsh-projectless\node_modules\...`，该目录已不存在
  （2026-10-13 迁移插件目录的遗留）→ `node scripts/build-esbuild.mjs` 报
  `Could not resolve "@deepseek-ai/dsh-tools"` 与 `"schemastery"`。
- 已清除全部悬空链接（`cmd /c rmdir`，只断链、不递归删除目标），重建为指向运行时：
  `C:\dsh-runtime\0.2.0-rc.2\node_modules\@deepseek-ai\{cordis,cosmokit,schemastery,dsh-tools,dsh-system-prompt,cordis-plugin-loader}`
  以及顶层同名 `cordis` / `cosmokit` / `schemastery` 链接。
- 构建命令：`node scripts/build-esbuild.mjs`（**不依赖 DSH_CHECKOUT**；`scripts/build.sh` 走 tsc 才需要）。
- 产物：`lib/index.js` 405_366 → **417_275** 字节；构建前已备份
  `lib/index.js.bak-20261014-2136`。

### 已知未修（交给外部手段）

- **工具取消不放弃**：DSH 的 `dsh-tool-call-timeout-policy` 先 `await next()` 再判超时、
  `dsh-tools` 明示 "Cancellation never abandons the body"、`dsh-agent-loop` 的
  `while (inFlight.size > 0)` 无 abort 退出条件 —— 这些在 DSH 本体，本包无法修。
  缓解方案为独立插件 `dsh-tool-watchdog`（挂 `tools/execute` 做真竞速，超时即解冻会话）。

## [0.4.0-mod.2] — 2026-10-12（未发布）

### 修复（profile 感知 —— 注入器跑在哪个实例，就只作用于哪个实例）

旧版把两个默认值写死成「web profile + 全局清单」，导致本包在**其他 profile 的实例里
注入功能整体失效**，且多个 profile 共用 `$DSH_HOME` 时互相串清单。现改为直接读 dsh 在
boot 阶段提供的 `profileContext` 服务（`{ name, dir, ... }`）：

- **`profileNodeModules` 默认值**：`profiles/web/node_modules` → **`<当前 profile 目录>/node_modules`**。
  旧行为下的实际故障：在 desktop / backup 实例里调 `dev_inject_plugin`，junction 被建到
  `profiles/web/node_modules`，**当前实例根本加载不到**，表现为返回 `host ✗`。
- **`registryFile` 默认值**：`$DSH_HOME/super-injector/registry.json` →
  **`$DSH_HOME/super-injector/instances/<当前 profile>/registry.json`**。
  旧行为下的实际故障：desktop 与 backup 共用 `$DSH_HOME`，两边读到同一份清单、
  **互相恢复对方注入的插件**（实测：backup 启动时读到 desktop 注入的包并报 `no-fiber`）。
- `self-heal.log` / `staging.json` / `stats.json` / `self-reload.json` 都由
  `dirname(registryFile)` 派生，**自动一并按 profile 隔离**，无需额外配置。
- `profileContext` **刻意不写进 `inject` 声明**：拿不到该服务时静默回退旧默认值，
  免得在没有它的宿主里让本插件卡在 `pending`。
- 显式配置 `profileNodeModules` / `registryFile` 的行为不变（**配置优先**）。

> ⚠️ **破坏性变更（仅影响未显式配置者）**：清单文件位置变了，旧的全局
> `$DSH_HOME/super-injector/registry.json` 不再被读取。需要迁移时，把其中条目手工并入
> `instances/<profile>/registry.json`，或对相关插件重新注入一次即可。

### 其它（仓库工具 `scripts/install-injector.ps1` 重写）

上游遗留的装配脚本有三个雷，已整体重写并实测：

- **写上游旧包名** `@dsh-external/dsh-super-injector` → 改为本修改版包名，并**校验包目录
  `package.json` 的 `name`**；指向上游原版或别的包时直接报错退出（防装错）。
- **`Remove-Item $linkDir -Recurse -Force` 作用在 junction 上** → 会跟随链接递归删除、
  毁掉源目录。改为只走 `rmdir` 断链；目标若是真实目录/文件则**报错拒删**。
- **`CommandLine -match '(web|--profile)'` 找进程后 `Stop-Process -Force`** → 会连带杀掉
  **所有** profile 的 dsh 实例（包括别的会话）。改为只匹配「dsh 入口 `bin.js` + 目标
  profile 名」，且先列出进程清单、确认后才停。
- 另修：`dsh --profile desktop` 根本起不来（Electron 独占管理）→ 脚本对 desktop **直接
  拒绝**并提示走 GUI；`Set-Content -Encoding UTF8` 在 PS 5.1 会写 BOM 污染 `package.json`
  → 改用 UTF-8 无 BOM 写入；重启默认关闭（须显式 `-Restart`）；日志重定向到文件
  （旧版 `RedirectStandardOutput` 后从不读取，管道写满会卡住子进程）。
- 脚本文件本身改为 **UTF-8 with BOM**：PS 5.1 对无 BOM 文件按 GBK 解析，原先的中文提示
  在 Windows PowerShell 下全是乱码。
- 新增 `-Uninstall`（对称卸载）与 `-PackageDir` / `-DshHome` 显式指定。

实测六项全过：desktop 守卫 / 装配 / 幂等 / 包名校验 / 真实目录防护（哨兵文件未被殃及）/
卸载。

## [0.4.0-mod.1] — 2026-10-12（未发布）

### 移除（插件管理职责与自带 UI 全部剥离）

- **删除自带 UI（client 半侧）**：`src/client/`、`lib/client.js`、`tsdown.config.ts`、
  `scripts/verify-client-load.mjs` 全部移除；`package.json` 不再声明 `dsh.client`、
  不再导出 `./client`、不再有 `build:client` / `verify:client` 脚本。
  **渲染端不再加载本插件任何代码**——历史上 `renderSlot is not a function` 界面报废、
  渲染进程 OOM、会话整片 hero 空态，都源自 client 半侧参与渲染端模块图，现从根上消除。
- **删除 host 侧 UI 后端**：`/super-injector/api` 整段（`GET /list`、`POST /uninject`、
  `POST /inject`、`POST /ingest`）移除。这是四个**无额外鉴权**的 HTTP 端点
  （`/ingest` 可凭一个路径新建 agent 会话），删除是安全收敛而非单纯瘦身。
- **删除 `dev_install_package`（装）**：写 profile `package.json` + `bundles` 的能力与官方
  `dsh-plugin-manager`（CLI / Web / agent 工具三通道）重复，且与本包「不碰 profile 配置」
  的自我定位矛盾。
- **`dev_uninject_plugin`（卸）瘦身**：**保留**（它是 `dev_inject_plugin` 的逆操作，而官方
  Plugin Manager 看不见未写进配置的注入项），但**去掉写 profile patch `disabled` 的动作**——
  不再改任何 profile 配置文件。代价：对手工装进 `bundles` 的插件，撤销不再自动阻断其
  bundle patch 自装配（那类插件请改用官方 plugin-manager 卸载）。
- **开关**：本包从来就没有 enable/disable 能力，此项归官方。

### 定位

自此本包只做一件事：**补上官方留白的那一格**——把**未写进 profile 配置**的插件包挂进
loader 树，配合热重载 / 侧挂区 / 生产线 / 自愈构成开发闭环。
装 / 卸 / 开关 / 配置落盘一律归官方 `dsh-plugin-manager`。

### 保留（未变更）

- 工具：`dev_inject_plugin` / `dev_injected_list` / `dev_uninject_plugin` /
  `dev_reload_package` / `dev_reload_preset` / `dev_clear_routes` / `dev_heal_links` /
  `dev_fix_patch` / `dev_plugin_status` / `dev_stage_*` ×5 / `dev_scaffold_plugin` /
  `dev_build_plugin` / `dev_release_plugin` / `dev_self_test`。
- 生产线仍支持生成带 client 的 `ui-panel` / `hybrid` 形态——那是**目标插件**的 UI，
  与本包自身是否带 UI 无关。
- 重启自动恢复（registry + `restore()`）、client 模块图重组广播（作用于**被注入插件**的
  UI 生效）、`dev_reload_package` 自伤护栏与 `force` 逃生门。

### 验证

- `node scripts/build-esbuild.mjs` 通过（仅构建 host 产物；断言 host 含包名、无 `-mod-mod` 双后缀）。
- `tsc -p tsconfig.json --noEmit`：除下述既有问题外 **0 错误**（临时屏蔽该既有行后实测 0 错误，
  证明本次删除未引入任何类型问题）。

### 已知的既有问题（本次未动）

- `src/index.ts` 的 `cleanupStaleEntries()` 中 `entry.parent.remove()` 返回 `void`，
  代码却按 Promise 处理（`p.then` / `p.catch`）。`tsc --noEmit` 因此报 4 条错误
  （TS1345 ×2 / TS2339 ×2）。**改动前即存在**，与本次无关，留待单独修复。

## [0.3.3] — 2026-08-15（已发布，git tag v0.3.3）

### 更新（高性能引导升级为 P1-P23 完整认知）

- **规范铁律 7 条 → 10 条**：新增「近距离信号原则」（所有行为引导必须在用户消息之后注入，远距离同指令衰减甚至反向——P13/P14/P20）、「弱域内路由」（模糊任务交模型自分类，按模型选 persona——P8/P11）、「单任务长链路三锚」（回顾+收敛+反跑题，完成率 0%→100%——P22/P23）
- **缓存原则强化**：system 前缀任何动态变化 = 全量缓存 miss（命中便宜 10 倍）；固定文本引导保持 92-94% 命中
- **高性能引导认知表**：首轮锚定 / 近距离引导 / 弱域内路由 / deep-guide / 单任务三锚 / plan-mode 保留——六机制落地方式与实测数字
- 参考链接更新：[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) v0.1.0（含论文与 P1-P23 全数据）

### 验证

- v0.3.3 为**实装发布**（含 lib 变更，非文档-only）：注入器自检 8/8 PASS（测试插件构建 /
  注入 host ✓ / 热重载 uid 变化 / 自重载节流 / 预检拦截 / lib 恢复 / 卸载即净 / patch 写入
  合法性），Windows 官方装配路径实测
- 历史说明：v0.3.1 之后至 v0.3.3 之前的提交（0.3.2 特性、0.3.3 文档、patch 去重）未单独打
  tag——v0.3.1 的 Release 资产含其中部分内容，完整内容随 v0.3.3 交付

### 修复（v0.3.3 实装：Windows 装配实测三 bug + 自包含打包）

- **writePatch/extractPatchBlocks 粘连 bug（patch 串位）**：条目块后的顶格注释被并入前一块，
  块间重写无换行 → 注释与下一 `- id:` 粘连成一行，`disabled: true` 错挂上一条目（实测：
  卸载自检插件后注入器行被禁用）。修复：每块保留行尾换行、顶格注释单独成块，块间 join 不再粘连
- **DSH_HOME 优先（homedir 错家）**：web 进程 homedir 与 DSH_HOME 不一致时（如服务账户/
  跨用户部署），registry/profileNodeModules/日志全错位，junction 建到错误 profile → loader
  找不到包。修复：`process.env.DSH_HOME || homedir()/.dsh` 统一路径（scaffold 模板同步）
- **自检 tmpDir 去硬编码**：移除自检临时目录的硬编码个人路径（盘符/用户名不再出现），改 DSH_HOME 下
  稳定目录；`reloadPackage` 磁盘降级改 import **realpath URL**（junction URL 会被 tsx 旧缓存
  命中，tmpDir 迁移后重载失效——实测 uid 不变）
- **findBash 拒绝 WSL**：Windows 装 WSL 时 System32\bash.exe 抢先 PATH 命中，构建必挂
  （"适用于 Linux 的 Windows 子系统没有已安装的分发版"）。修复：Git/PortableGit 路径优先，
  PATH 探测结果含 wsl 标记即拒绝
- **宿主自包含打包（issue #1 根治）**：tsdown 新增 host bundle，把 @deepseek-ai/dsh-tools /
  schemastery 等运行时依赖打进 lib/index.js——官方装配（`dsh plugin add <目录>`，link: 依赖
  不装 peers）不再出现 `Cannot find package '@deepseek-ai/dsh-tools'`，任何装配路径均可加载
- **杂物清理**：移除源码中的个人引用（engram 注释/默认匹配名）、`dev_reload_package` 描述
  不再带默认插件名；`Config` 显式标注（junction 依赖下 declaration 报 TS2742）
- 自检 8/8 PASS（含 patch 写入合法性 + 热重载 uid 变化）

## [0.3.2] — 2026-08-15

### 新增（高性能引导：首轮锚定 + 工具 schema 精简）

- **骨架模板自带高性能引导**：`dev_scaffold_plugin` 生成的 toolkit 骨架头部注释新增两条
  高性能铁律（工具 schema 精简——description 短句化、详解不进 schema；首轮锚定——工具面
  ≥5 时首轮只露核心 1-2 个、首个 `tool/call` 后恢复全部），`apply()` 末尾附**可启用的首轮
  锚定实现块**（`system-prompt/assemble` Waterfall 过滤器 + `agent.session.events` 持久化
  推导晋升，resume 安全，只裁剪本插件工具）
- **README 规范铁律 5 条 → 7 条**（新增「首轮锚定」「工具 schema 精简」），新增
  「高性能插件（首轮锚定 · 为什么 & 怎么做）」小节：原理、三步启用、session JSONL 验证法
- **SPEC 铁律 6 条 → 8 条**，新增第 6 节「性能引导契约」：事件契约（Waterfall 必须
  `await next()`、`agent` 判空、晋升从持久日志推导、工具执行失败也算晋升）、过滤边界
  （只裁剪本插件工具）、成本模型（首轮无缓存 prefill 全量计费、17.6 万字符实测、schema
  面 vs 文本内容的微探针证据）

### 参考与致谢

- 首轮锚定机制源自 **xiaobright** 的
  [`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard)
  （MIT，两阶段锚定 preset 与 `tool-bootstrap.mjs` 实现，Project2 实测 98/99）
- 原理分析与统计证据来自 **xiaobright** 的
  [`modeltest`](https://github.com/xiaobright/modeltest)（V4.1b，frozen：
  harness 对照分析 / 触发机制实验 / 轨迹统计）

### 验证

- tsc 编译通过；新骨架实测：`dev_scaffold_plugin` 生成文件含铁律注释与锚定块
- 运行副本（cloud-restore 云源自举）同步 `lib/` 后自重载，前后均 active

## [0.3.1] — 2026-08-14

### 修复（pixel-forge 事件根治——坏 client 挂死 HARNESS）

- **autoRestore 恢复前 client 校验**：坏 client 插件（缺 inject）恢复时**跳过 + 审计**（此前恢复路径无校验——坏插件在 registry → 新会话启动 → client apply 失败 → 整个 HARNESS "Failed to load plugins"——用户被迫手动修）
- **校验正则兼容单双引号**：用户手修的双引号 `inject = ["slots"]` 被误判为"缺 inject"的 bug
- **clientSkeletonProblems 公共化**：注入阻断 / 恢复跳过共用同一校验逻辑（一条防线两处生效）

### 新增

- 注入前 client 骨架校验升级（v0.3.0 并入）：同时检查编译产物 lib/client.js（只有 lib 无 src 不绕过）+ 缺 inject 阻断注入

### 验证

- 双引号 inject 假插件注入通过（不误判）
- 坏 client 假插件注入阻断
- 自检 8/8 无回归

## [0.2.6] — 2026-08-14

### 修复

- **watch 自动重载前预检**（用户反馈"太自由容易自杀"）：build 半途/改错导致的损坏 lib 不可加载时**拒绝自动重载**（旧代码继续运行）+ `watch-precheck-blocked` 审计——与手动自重载的预检拦截同一道防线。实测：music-forge 构建半途被拦一次，build 完成后正常注入
- **systemPrompt.context 重复注册容忍**：自重载 rebuild 不再因 `duplicate` 整体 failed（此前导致注入器死亡 + 自愈 3 连败）
- **恢复路径验证**：注入器 failed 后用 **touch patch（include.refresh 进程内重装配）复活**——免杀进程的"延迟重启"（实测 6 秒恢复 + 自检 8/8）

### 兼容

- **DSH 0.1.0-rc.6（正式开源版）验证通过**：注入器一行未改直接运行，自检 8/8；peerDeps 范围声明（`>=0.0.1-rc <2`）在 rc.5 → rc.6 升级中实证"升级不报废"

## [0.2.4] — 2026-08-13

### 修复

- **发布包可独立安装（实测验证）**：tgz 增加 `scripts/build.sh`（此前 `files: ['lib']` 未带构建脚本）——解压副本此前缺 node_modules 依赖链接，`dsh plugin add` 后 `ERR_MODULE_NOT_FOUND` 装不上。现在解压后 `DSH_CHECKOUT=<checkout> bash scripts/build.sh` 即可建依赖链接。**实测**：下载 v0.2.4 tgz → 解压 → 建依赖 → 重启 → 注入器从云端副本加载并工作（自举验证通过）
- **自重载降级匹配用 realpath**：缓存无匹配降级从磁盘加载后，按包名重新匹配会失败（副本目录如 `cloud-restore` 不含包名）——改 `realpathSync(lib)` 匹配 loadCache 真实 key（实测：云端副本自重载链路修复）

### 质量

- 云源自举实验：卸载本地注入器 → 下载 GitHub release 副本 → 装配 → 运行中注入器 = 云端版（entry URL 指向副本），工具/自检全部可用

## [0.1.0] — 2026-08-12

### 新增

- **超级模组注入器**：运行时注入任意本地 DSH 插件包（junction 链接 + `loader.create`，不碰 patch / package.json / bundles 列表、不重启进程），注入清单自动恢复（`~/.dsh/super-injector/registry.json`）
- **热重载全家桶**（融合 dsh-bundle-hmr）：`dev_reload_package` 整包重载（清缓存 → 重新 import → 重建 fiber，失败回滚保留旧代）、`dev_plugin_status` 装配清单、`dev_install_package` 双路径安装（profile package.json + junction + loader.create）
- **卸载器**：`dev_uninject_plugin` 卸 loader entry（fiber dispose 全清理）→ 清注入清单 → 删 junction，免重启；引导器自身受保护不可卸载
- **路由残留自愈**：`dev_clear_routes` 直捣 webserver 内部路由表（exact/prefixes/upgrades），按 path 前缀删除孤儿路由，插件热重载残留 `duplicate route` 免重启即可清除
- **强制登记守卫**：`reloadPackage` 重建失败若报 `duplicate / already registered` → 判定未登记裸注册 → 明确报错（要求插件把资源注册挂 `ctx.effect`）+ 自动清理残留路由
- **开发侧挂区（staging）**：测试/开发工具挂"后侧"不进 tools schema（缓存零污染），`dev_stage_call` 测试、`dev_stage_promote` 一键转正（唯一一次缓存刷新）、`dev_stage_demote` 撤回——杜绝开发期工具波动打穿 DeepSeek 前缀缓存

### 优化

- **注入缓存友好化**：注入文本固定 + order 9998 尾部化（参考官方 system prompt 设计），移除 llm/stream 动态旁路——system 前缀恒定，缓存命中不再受注入波动影响

### 修复

- `getOuterStack is not a function`：`registry.plugin` 第三参必须是函数（`() => []`），双路径修正
- 工具 schema 兜底 + `safeRegister` 冲突容忍（同名工具跳过注册而非崩溃）
- 注入防重改权威判断（`hasActiveEntry`）+ 失败残留清理

## [0.1.1] — 2026-08-13

### 修复

- `dev_stage_demote` 无法注销已转正工具：`dev_stage_promote` 注册改挂 `ctx.effect` 并保存 disposer，demote 时真正从正式工具集注销（此前只删 staging 条目，正式注册残留）
- `purgeCache` 防御：loader.internal 缺失时安全跳过（不再非空断言炸 inject 路径）
- registry 原子写（tmp + rename）：中断不残留半截 JSON 毒化自动恢复

### 优化

- `dev_inject_plugin` dir 参数必填 + 空值兜底报错
- `hasActiveEntry` fiber 状态魔数（2）改为语义常量（FIBER_NAMES 反查 'active'）
- 预防正式版：peerDeps 放宽（`@deepseek-ai/dsh-tools >=0.0.1-rc <2`、`cordis >=4.0.0-rc <5`）
- 文档：README 新增「生态定位：官方之下的运行时标准层」章节

## [0.2.3] — 2026-08-13

### 修复（外部测评 P0/P1 + 作死压力测试驱动）

- **自重载链路断裂根治（P0）**：缓存无匹配不再 INFO 退出——降级从磁盘 URL 直接加载（junction/urlMatch 目录的 lib/index.js），`loader.import` 重新解析磁盘填充缓存后继续重载流程。此前缓存丢失（并行 build/自检交错 purge）会让自重载/热重载直接失效，只能人工 touch/重启；现链路自愈（实测：清空缓存 → 自重载直接从磁盘加载成功，审计 `cache-miss-healed`）
- **watch 悬空抑制（压测③）**：目录消失/悬空 junction（源被删/改名）时，watch 不再盲目 reload（此前虚增 ✓ 且无审计）——跳过重载 + `watch-dangling` 审计一次（30s 节流防刷屏）
- **uninject 统计口径（压测②）**：无匹配 = no-op 幂等，既不计 ✓ 也不计 ✗（此前：早期计 ✗ 产生 9✗ 假失败；后改计 ✓ 高估成功）
- **注入错误区分（压测①）**：`目录不存在或不可访问` 与 `存在但无 package.json` 分开报错

### 新增

- **操作失败可审计**：stats.json 增加 `lastFailures`（最近 5 条失败：类型 + 时间戳 + 原因），`dev_plugin_status` 展示「最近失败」区——9✗ 假失败等历史可追溯
- `dev_uninject_plugin` 的 match 参数改为必填 + 空值守卫（此前空参 `match.includes` TypeError）

### 质量

- 作死/压力测试（subagent 极限场景）：连环自重载 / 坏语法自杀 / 注入不存在目录 / 重复注入幂等 / 卸载不存在插件 / 缺参守卫 / 注入后删源码（悬空 junction）/ 注入卸载循环 3 轮 / 连跑自检 2 次——**六条防线全部扛住，零崩溃零残留，11 步全 PASS**
- 修后自检 8/8 全绿 + 卸载 no-op 统计不再污染（31✓/9✗ 恒定）

## [0.2.2] — 2026-08-13

### 新增

- **INSTALL.md 傻瓜式安装手册**：Release 包 / git / 手动 patch 三方式 + 验证 + 10 行排查表 + 卸载回滚小节 + Windows（Git Bash/cmd 双语法）说明 + 版本号占位（`<版本>` 不写死）
- **`[injected]` 标记**：`dev_plugin_status` 对运行时注入的插件标注（与 bundle 装配区分，hash id 不再难认）
- **`dev_self_test` 热重载自包含**：重载自检插件自身（固定 specifier + 固定目录，缓存一致），不再依赖环境里的外部插件（如 engram）

### 优化

- `dev_self_test` 预期拒绝场景（节流/预检拦截）改 `[EXPECTED]` 前缀——计入 PASS，不再误导新手
- client 状态区分：无 client 声明 → `client 跳过（属预期）`；有声明注册失败 → 真 `✗` + 诊断指引
- `dev_uninject_plugin` 描述补"另写 profile patch disabled 条目（防 include.refresh 加回）"，与实测行为一致
- 引导提示词补一行从零体验路径（dev_plugin_status → dev_self_test → dev_scaffold_plugin → dev_build_plugin → dev_inject_plugin → dev_uninject_plugin）

### 修复

- 注入 junction 悬空重建：`existsSync` 对悬空 junction 返回 false（跟随目标）导致 symlink EEXIST——改 `lstatSync` 判断链接存在 + `rmSync` 删除重建
- `uninject` 幂等：已存在同名 disabled 条目时跳过（此前重复卸载会累积 patch 条目）
- 自检 patch 清理：列表存在时不再追加 `[]`（防双顶层值回归）

### 质量

- 零上下文 subagent 三轮评测闭环：9/10 → 9.5/10 → **10/10**（七条 polish 全部落地 + 8/8 回归连续通过）

## [0.2.1] — 2026-08-13

### 优化

- `dev_self_test` 预期拒绝场景改 `[EXPECTED]` 前缀（不误导新手）
- client 状态区分「无声明（预期跳过）」与「有声明注册失败（真 ✗ + 诊断指引）」
- 引导提示词补从零体验路径一行

## [0.2.0] — 2026-08-13

### 新增

- **插件生产线三件套**：
  - `dev_scaffold_plugin`：四种形态骨架（toolkit 工具包 / daemon-loop 守护循环(timer+LLM) / ui-panel UI 面板 / hybrid 混合）——peerDeps 范围声明、ctx.effect 规范、build.sh 模板（DSH_CHECKOUT 自动探测）
  - `dev_build_plugin`：探测 checkout → tsc + tsdown（client）+ npm pack → tgz
  - `dev_release_plugin`：gh release create + tag + tgz 附件 + notes 模板
- **`dev_self_test` 一键回归**：注入 → 热重载 → 自重载节流 → 预检拦截 → 卸载即净 → patch 合法性，8 项全自动、自恢复无污染
- **patch 写入守卫 `writePatch`**：统一 profile patch 写入（顶层 `[]` 兼容 + 幂等），杜绝 YAML 双顶层值
- **审计日志轮转**：self-heal.log 超 1MB 自动滚动（保留 2 代）
- **操作统计落盘**：`stats.json` 跨重启累计（dev_plugin_status 显示历史成功率）
- **官方 entry 仲裁**：幽灵 entry 压制官方（disabled）时自动清理恢复（kill-zombie 自动化）
- **README 插件开发指南**：「30 行写一个会思考的插件」+ 规范铁律 + 生态借鉴

### 优化

- watch 指纹轻量化：只扫 `.js`（跳过 .map/.d.ts，stat 开销省 50%+）
- 引导提示词：静态到头（order -90）动态到尾（消息尾）缓存原则注释化

### 修复

- junction 悬空检测（inject 复用悬空链接 → import ENOENT）
- `uninject` 幂等缺失（重复卸载累积 patch 条目）

## 2026-10-19 ptc-dispatch 时序复核（未发布，零代码改动）

### 结论：不可达，不加固代码

- `lib/index.js:5997` / `:6020` 写 `tool/ptc-dispatch` / `tool/ptc-dispatch-start`，是**内联**自
  `@deepseek-ai/dsh-tools` 的顶层工厂 `createRunCodeTool`（`lib:5794`）内部：`binding()`（`:5959`）返回的 async IIFE 体内，
  结算逻辑（`const settle`，`:5978`）与 `start()`（`:6019`）的方法体。唯一调用者是 `ToolRuntime.requirePtcTransport`（`:6940`），
  而产物内 `new ToolRuntime` **0 次**（`:6819` 仅声明；`requirePtcTransport` 只出现在 `:6939` 定义与 `:7134`
  死类内部）→ 整条链不可达、永不执行。
  插件自身只用宿主 `ctx.tools` 服务 + `defineTool`，产物导出仅 `Config/apply/inject/name`（`:10999`）。
- 该路径本身要求 open turn：`dsh-session-format-v3-to-v4/lib/index.js:652` `dispatch()` → `:571`
  `requireTurn()`，`this.turn===null` 抛 `<type> is outside an open turn`；`turn/end`（`:752-757`）置 `turn=null`。
- 上游真实路径（宿主 run_code）安全：两处 append 均在 `finally { runController.abort("run_code settled");
  await drainDispatches() }`（本产物 `lib:6092-6095`；上游 dsh-tools `lib/index.js:1427-1430`）内完成，
  tool result 之后才由外层落盘 → turn 仍开。

### 判据（未来防坑）

- 禁止在插件内 `new ToolRuntime` 或自建 PTC transport；若确需复用，只能从**工具执行期**（open turn + step 内）调用。
- `-start` 必须先于 `dispatch` 落盘（缺 start → `PTC dispatch has no unique start`，`:667`）；
  两者参数 `rootCallId/parentCallId/name/arguments` 必须一致（`:668-673`）。
- turn 外写这两个事件 = 会话 reload 时 SessionFormatError，故不写优于写错。

### 可选优化：build-esbuild 加 `external: ['@deepseek-ai/dsh-tools']` —— 已评估，不采纳

- 产物「除 `node:` 外全内联」是既有设计（任何装配路径可加载）。external 后运行期须从 profile 的
  `node_modules` 解析该包，peerDep 范围 `>=0.0.1-rc <2`，可能解析到与宿主进程不同版本的副本 →
  工具契约 / 会话事件格式漂移，且解析失败即**整插件加载失败**（比不可达死代码更危险）。
- 收益只有产物清洁度（约 1900 行），风险大于收益；死代码已在 `:5794` / `:6819` 处有判据兜住。
- 反例的另一半：**内联侧并非无风险**——内联副本与宿主之间同样漂移，且是**静默**的（宿主 v4 校验两次拒绝内联方
  写入的事件：`developer/message turn must be a non-negative safe integer`、`format v4 contains unknown event type`），
  比 external 的「整插件加载失败」更难发现。该风险由**构建期锁定 `@deepseek-ai/dsh-tools` 版本**承担。

### 实测（.tmp 脚本，未改产物）

- `assertReleasedV4Relationships`：`turn/start → dispatch-start + dispatch → turn/end` **通过**；
  `turn/end` 后再写 `dispatch-start` → `SessionFormatError: tool/ptc-dispatch-start is outside an open turn`。

## 未发布

- 见 [README.md](./README.md) 与仓库提交历史；验：`git -C . log -1 --format=%h`
