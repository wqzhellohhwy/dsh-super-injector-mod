#Requires -Version 5.1
<#
.SYNOPSIS
  把 @dsh-external/dsh-super-injector-mod 装配到指定 dsh profile（幂等，可卸载）。

.DESCRIPTION
  做三件事：
    1. 建 junction：profiles\<profile>\node_modules\@dsh-external\dsh-super-injector-mod -> 包目录
    2. 写 profiles\<profile>\package.json：dependencies 加 link + dsh.profile.bundles 加包名
    3. （可选 -Restart）重启该 profile 的实例

  为什么还需要这个脚本：官方 dsh-plugin-manager 走 pnpm，而 desktop profile 由 Electron
  独占管理、命令行 `dsh --profile desktop ...` 会被拒绝。本脚本只处理「本地 link 包 +
  bundle 装配」这条 CLI 覆盖不便的路径；其余装卸场景请优先用官方通道。

  安全设计（每条都对应一个踩过的坑）：
    · 校验包目录 package.json 的 name 必须是本修改版包名——防误装上游原版。
      上游 @dsh-external/dsh-super-injector 带 client 半侧，会打乱渲染端模块图。
    · 删链接只用 rmdir（只断链、不递归跟随）；目标若是真实目录则直接报错拒删，
      绝不 Remove-Item -Recurse——那会顺着 junction 把源目录一起删掉。
    · 重启只匹配「dsh 入口 bin.js + 目标 profile 名」的 node 进程，绝不波及其他 profile
      （旧版用 CommandLine -match '(web|--profile)' 会连带杀掉所有 dsh 实例）。
    · 写 JSON 用 UTF-8 无 BOM——PS 5.1 的 -Encoding UTF8 会写 BOM，污染 package.json。
    · 默认不重启（自动停进程风险太高）；要重启须显式 -Restart，且列出进程清单等确认。

.PARAMETER Profile
  目标 profile 名，默认 web。desktop 会被拒绝——它由 Electron 独占，请用 GUI 插件页。

.PARAMETER PackageDir
  包目录（须含 package.json）。省略时按脚本位置自动推导，并校验包名。

.PARAMETER DshHome
  DSH_HOME。省略时取环境变量 DSH_HOME，再退回 ~/.dsh。

.PARAMETER Restart
  装配后重启该 profile 的实例（会停掉正在跑的同 profile 进程）。

.PARAMETER Uninstall
  反向操作：解除 junction + 从 package.json 移除依赖与 bundle 条目。

.PARAMETER Yes
  跳过 -Restart 前的确认。

.EXAMPLE
  .\install-injector.ps1 -Profile backup
  装配到 backup，不重启（手动重启后生效）。

.EXAMPLE
  .\install-injector.ps1 -Profile backup -Restart
  装配到 backup 并重启它（会先列出要停的进程并要确认）。

.EXAMPLE
  .\install-injector.ps1 -Profile backup -Uninstall
  从 backup 卸载。
#>
[CmdletBinding()]
param(
  [string]$Profile = 'web',
  [string]$PackageDir = '',
  [string]$DshHome = '',
  [switch]$Restart,
  [switch]$Uninstall,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$pkgName      = '@dsh-external/dsh-super-injector-mod'
$pkgShort     = 'dsh-super-injector-mod'
$upstreamName = '@dsh-external/dsh-super-injector'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Test-PackageDir([string]$dir) {
  if (-not $dir) { return $false }
  $pj = Join-Path $dir 'package.json'
  if (-not (Test-Path -LiteralPath $pj)) { return $false }
  try { $m = Get-Content -LiteralPath $pj -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
  return ($m.name -eq $pkgName)
}

# 只断链，绝不递归跟随。目标不是链接（真实目录/文件）时直接报错拒删。
function Remove-LinkSafely([string]$Path) {
  $it = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $it) { return $false }
  if (-not $it.LinkType) {
    $kind = if ($it.PSIsContainer) { '目录' } else { '文件' }
    Say "❌ $Path 是真实的$kind，不是链接。" 'Red'
    Say '   拒绝删除——它可能是误建的副本，递归删除会连同里面的东西一起毁掉。' 'Red'
    Say '   请人工确认后自行处理。' 'Yellow'
    exit 1
  }
  & cmd.exe /c "rmdir `"$Path`"" | Out-Null
  return (-not (Test-Path -LiteralPath $Path))
}

# UTF-8 无 BOM 写 JSON（PS 5.1 的 -Encoding UTF8 会带 BOM）
function Save-JsonFile([string]$Path, $Object) {
  $json = $Object | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText($Path, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# ── 0. desktop 守卫 ───────────────────────────────────────────────────────
if ($Profile -eq 'desktop') {
  Say ''
  Say '❌ desktop profile 不能用本脚本。' 'Red'
  Say '   desktop 由 Electron 应用独占管理：命令行 `dsh --profile desktop ...` 会被拒绝'
  Say '   （profile "desktop" is managed exclusively by the Electron application）。'
  Say '   本脚本既装配不了它，也重启不了它。' 
  Say '   ➜ 请改用 GUI 的插件管理页安装/卸载。' 'Yellow'
  exit 1
}

# ── 1. 定位 DSH 与 profile ───────────────────────────────────────────────
if (-not $DshHome) {
  $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profilePkg)) {
  Say "❌ profile 不存在: $profileDir" 'Red'
  exit 1
}
$linkDir = Join-Path $profileDir "node_modules\@dsh-external\$pkgShort"

# ── 2. 定位包目录（校验包名，防装错）──────────────────────────────────────
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$parent = Split-Path -Parent $here
$grand  = Split-Path -Parent $parent

if ($PackageDir) {
  $PackageDir = (Resolve-Path -LiteralPath $PackageDir).Path
  if (-not (Test-PackageDir $PackageDir)) {
    $actual = '(读不到)'
    try { $actual = (Get-Content -LiteralPath (Join-Path $PackageDir 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).name } catch { }
    Say "❌ 包名不匹配：期望 $pkgName，实际 '$actual'" 'Red'
    if ($actual -eq $upstreamName) { Say '   这是上游原版（带 client 半侧），不是本修改版。' 'Yellow' }
    exit 1
  }
} else {
  $cands = @(
    (Join-Path $parent 'injector'),                       # 套件布局：<suite>\scripts -> <suite>\injector
    (Join-Path $parent $pkgShort),                        # 同级的一级目录
    (Join-Path $grand  $pkgShort),                        # 再上一级（dsh-plugins 一级）
    (Join-Path $here   'injector'),
    $here
  ) | Select-Object -Unique
  foreach ($c in $cands) {
    if (Test-PackageDir $c) { $PackageDir = (Resolve-Path -LiteralPath $c).Path; break }
  }
  if (-not $PackageDir) {
    Say "❌ 找不到包目录（需含 package.json 且 name = $pkgName）" 'Red'
    Say '   已尝试：' 
    $cands | ForEach-Object { Say "     $_" 'DarkGray' }
    Say '   ➜ 请用 -PackageDir 显式指定。' 'Yellow'
    exit 1
  }
}

Say ''
Say "== $pkgName 装配 ==" 'Cyan'
Say "   包目录 : $PackageDir"
Say "   profile: $Profile ($profileDir)"
Say ''

$pkg = Get-Content -LiteralPath $profilePkg -Raw -Encoding UTF8 | ConvertFrom-Json

# ── 3. 卸载 ──────────────────────────────────────────────────────────────
if ($Uninstall) {
  $changed = $false

  if (Test-Path -LiteralPath $linkDir) {
    if (Remove-LinkSafely $linkDir) { Say '  [1/2] junction 已解除（源目录未受影响）' 'Green' }
  } else {
    Say '  [1/2] junction 本就不存在（跳过）' 'DarkGray'
  }

  if ($pkg.dependencies -and ($pkg.dependencies.PSObject.Properties.Name -contains $pkgName)) {
    $pkg.dependencies.PSObject.Properties.Remove($pkgName)
    $changed = $true
  }
  if ($pkg.dsh -and $pkg.dsh.profile -and $pkg.dsh.profile.bundles) {
    $before = @($pkg.dsh.profile.bundles)
    $kept = @($before | Where-Object { $_ -ne $pkgName })
    if ($kept.Count -ne $before.Count) { $pkg.dsh.profile.bundles = $kept; $changed = $true }
  }

  if ($changed) {
    Save-JsonFile $profilePkg $pkg
    Say '  [2/2] package.json 已移除依赖与 bundle 条目' 'Green'
  } else {
    Say '  [2/2] package.json 本就没有本包（跳过）' 'DarkGray'
  }

  Say ''
  Say '✅ 已卸载。重启该 profile 实例后生效。' 'Green'
  exit 0
}

# ── 4. 装配：junction ────────────────────────────────────────────────────
if (Test-Path -LiteralPath $linkDir) {
  $cur = Get-Item -LiteralPath $linkDir -Force
  $targets = @($cur.Target)
  if ($cur.LinkType -and ($targets -contains $PackageDir)) {
    Say '  [1/3] junction 已存在且指向正确（跳过）' 'Green'
  } else {
    Say "  [1/3] junction 已存在但指向 $($targets -join ',')（重建）" 'Yellow'
    if (Remove-LinkSafely $linkDir) {
      New-Item -ItemType Junction -Path $linkDir -Target $PackageDir | Out-Null
      Say '  [1/3] junction 已重建' 'Green'
    }
  }
} else {
  New-Item -ItemType Directory -Path (Split-Path -Parent $linkDir) -Force | Out-Null
  New-Item -ItemType Junction -Path $linkDir -Target $PackageDir | Out-Null
  Say '  [1/3] junction 已创建' 'Green'
}

# ── 5. 装配：package.json ────────────────────────────────────────────────
$changed = $false

if (-not $pkg.dependencies) {
  $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
}
$spec    = "link:$($PackageDir -replace '\\', '/')"
$curSpec = ''
$prop    = $pkg.dependencies.PSObject.Properties[$pkgName]
if ($prop) { $curSpec = [string]$prop.Value }
if ($curSpec -ne $spec) {
  $pkg.dependencies | Add-Member -NotePropertyName $pkgName -NotePropertyValue $spec -Force
  $changed = $true
}

if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }
if (-not (@($pkg.dsh.profile.bundles) -contains $pkgName)) {
  $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles) + $pkgName
  $changed = $true
}

if ($changed) {
  Save-JsonFile $profilePkg $pkg
  Say '  [2/3] package.json 已更新（link + bundles）' 'Green'
} else {
  Say '  [2/3] package.json 已配置（幂等跳过）' 'Green'
}

# ── 6. 重启（可选，安全版）───────────────────────────────────────────────
Say ''
if (-not $Restart) {
  Say '✅ 装配完成（未重启）。' 'Green'
  Say "   ➜ 手动重启 $Profile 实例后，dev_* 工具生效。" 'Cyan'
  Say '   要自动重启就加 -Restart（会停掉该 profile 正在跑的实例）。' 'DarkGray'
  exit 0
}

Say "  [3/3] 重启 $Profile 实例..." 'Yellow'

# 只匹配「dsh 入口 bin.js + 目标 profile 名」，绝不波及其他 profile
$profPat = '(^|\s)(--profile\s+)?' + [regex]::Escape($Profile) + '(\s|$)'
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $cl = $_.CommandLine
    if (-not $cl) { return $false }
    if ($cl -notmatch 'dsh[\\/](lib[\\/])?bin\.js') { return $false }
    return ($cl -match $profPat)
  })

if ($targets.Count -eq 0) {
  Say "   没有找到正在运行的 $Profile 实例（跳过重启）" 'DarkGray'
  exit 0
}

Say "   将停止以下 $($targets.Count) 个进程（只含 $Profile）：" 'Yellow'
foreach ($t in $targets) {
  $c = $t.CommandLine
  if ($c.Length -gt 140) { $c = $c.Substring(0, 140) + '…' }
  Say ("     PID {0}  {1}" -f $t.ProcessId, $c) 'DarkGray'
}
if (-not $Yes) {
  $ans = Read-Host '   确认停止并重启？(y/N)'
  if ($ans -notmatch '^\s*[yY]') {
    Say '   已取消（装配已完成，可稍后手动重启）。' 'Yellow'
    exit 0
  }
}

foreach ($t in $targets) {
  Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  Say "     已停止 PID $($t.ProcessId)" 'DarkGray'
}
Start-Sleep -Milliseconds 900

$binJs = $null
foreach ($ad in (@($env:APPDATA, (Join-Path $env:USERPROFILE 'AppData\Roaming')) | Select-Object -Unique)) {
  $c = Join-Path $ad 'npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
  if (Test-Path -LiteralPath $c) { $binJs = $c; break }
}
if (-not $binJs) {
  Say '   ⚠️ 找不到 dsh 入口 lib\bin.js，请手动启动该 profile 实例。' 'Yellow'
  exit 0
}
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'node' }

$logOut = Join-Path $DshHome "injector-restart-$Profile.log"
$logErr = Join-Path $DshHome "injector-restart-$Profile.err.log"
$proc = Start-Process -FilePath $nodeExe -ArgumentList @($binJs, '--profile', $Profile) `
  -WorkingDirectory $profileDir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $logOut -RedirectStandardError $logErr

Say ''
Say "✅ 已重启：PID $($proc.Id)  (profile=$Profile)" 'Green'
Say "   日志: $logOut" 'Gray'
Say "         $logErr" 'Gray'
