#Requires -Version 5.1
<#
    Vesktop Chat Exporter - maintenance build script

    Vencord を取得し、VesktopChatExporter を組み込んでビルドし、
    Release に同梱する vencordFiles を生成します。

    前提:
      - git
      - Node.js 22 以上
      - pnpm（corepack enable pnpm もしくは npm i -g pnpm）

    例:
      powershell -ExecutionPolicy Bypass -File scripts\build-vencord.ps1
      powershell -ExecutionPolicy Bypass -File scripts\build-vencord.ps1 -VencordRef v1.15.9
#>
[CmdletBinding()]
param(
    [string]$VencordRef = "v1.15.9",
    [string]$BuildDir   = ".build-vencord",
    [string]$OutputDir  = "release\vencordFiles"
)

$ErrorActionPreference = "Stop"

function Need($cmd, $hint) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        throw "'$cmd' が見つかりません。$hint"
    }
}

Need git "git をインストールしてください。"
Need node "Node.js 22 以上をインストールしてください。"
Need pnpm "corepack enable pnpm を実行するか、npm i -g pnpm で導入してください。"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuildPath = Join-Path $RepoRoot $BuildDir
$PluginSrc = Join-Path $RepoRoot "src\plugins\vesktopChatExporter"
$Out = Join-Path $RepoRoot $OutputDir

Write-Host "[*] Vencord を取得: $VencordRef" -ForegroundColor Cyan
if (-not (Test-Path (Join-Path $BuildPath ".git"))) {
    git clone --depth 1 --branch $VencordRef https://github.com/Vendicated/Vencord.git $BuildPath
} else {
    git -C $BuildPath fetch --depth 1 origin $VencordRef
    git -C $BuildPath checkout $VencordRef
}

$UserPluginDir = Join-Path $BuildPath "src\userplugins\vesktopChatExporter"
Write-Host "[*] プラグインを配置: $UserPluginDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $UserPluginDir | Out-Null
Copy-Item -Force (Join-Path $PluginSrc "index.tsx") $UserPluginDir
Copy-Item -Force (Join-Path $PluginSrc "native.ts") $UserPluginDir

Write-Host "[*] 依存関係を導入" -ForegroundColor Cyan
Push-Location $BuildPath
try {
    pnpm install --frozen-lockfile
    Write-Host "[*] ビルド" -ForegroundColor Cyan
    pnpm build
} finally {
    Pop-Location
}

Write-Host "[*] vencordFiles を生成: $Out" -ForegroundColor Cyan
if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$dist = Join-Path $BuildPath "dist"
$files = @(
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
)
foreach ($f in $files) {
    Copy-Item -Force (Join-Path $dist $f) (Join-Path $Out $f)
}
Set-Content -LiteralPath (Join-Path $Out "package.json") -Value "{}" -NoNewline -Encoding Ascii

Write-Host "[+] 完了: $Out" -ForegroundColor Green
Write-Host "    installer フォルダーと合わせて zip にしてください。"
