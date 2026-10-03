#Requires -Version 5.1
<#
    Vesktop Chat Exporter - installer

    同梱の vencordFiles（VesktopChatExporter を組み込んだ Vencord ビルド）を
    Vesktop の Vencord 読み込みフォルダーへコピーします。

    使い方:
        powershell -ExecutionPolicy Bypass -File install.ps1
        powershell -ExecutionPolicy Bypass -File install.ps1 -UserDataDir "C:\path\to\vesktop"
#>
[CmdletBinding()]
param(
    [string]$UserDataDir,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Write-Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Write-Note($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m)       { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SourceDir = Join-Path $ScriptDir "vencordFiles"

$required = @(
    "vencordDesktopMain.js",
    "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js",
    "vencordDesktopRenderer.css"
)

if (-not (Test-Path -LiteralPath $SourceDir)) {
    Fail "同梱の vencordFiles フォルダーが見つかりません: $SourceDir"
}
foreach ($f in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $f))) {
        Fail "必要なファイルがありません: $f"
    }
}

function Resolve-VesktopUserData {
    param([string]$Explicit)

    if ($Explicit) { return $Explicit }
    if ($env:VENCORD_USER_DATA_DIR) { return $env:VENCORD_USER_DATA_DIR }

    $candidates = @()
    if ($env:APPDATA)      { $candidates += (Join-Path $env:APPDATA "vesktop") }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "vesktop\Data") }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\Vesktop\Data") }

    foreach ($c in $candidates) {
        if ((Test-Path -LiteralPath (Join-Path $c "sessionData")) -or
            (Test-Path -LiteralPath (Join-Path $c "settings.json"))) {
            return $c
        }
    }

    # Vesktop を一度も起動していない場合でも標準パスへ入れる
    if ($env:APPDATA) { return (Join-Path $env:APPDATA "vesktop") }
    return $null
}

$dataDir = Resolve-VesktopUserData -Explicit $UserDataDir
if (-not $dataDir) {
    Fail "Vesktop のデータフォルダーを特定できませんでした。-UserDataDir で指定してください。"
}

$sessionDataDir = Join-Path $dataDir "sessionData"
$vencordDir     = Join-Path $sessionDataDir "vencordFiles"

Write-Info "Vesktop データフォルダー : $dataDir"
Write-Info "Vencord 出力先           : $vencordDir"

if (-not (Test-Path -LiteralPath $sessionDataDir)) {
    New-Item -ItemType Directory -Force -Path $sessionDataDir | Out-Null
}

$running = Get-Process -Name "vesktop" -ErrorAction SilentlyContinue
if ($running) {
    Write-Note "Vesktop が起動中です。インストール後に必ず再起動してください。"
}

# 既存の Vencord ファイルを一度だけバックアップ
if (Test-Path -LiteralPath $vencordDir) {
    $stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = Join-Path $sessionDataDir "vencordFiles.bak-$stamp"
    Write-Info "既存ファイルをバックアップ: $backup"
    Copy-Item -Recurse -Force -LiteralPath $vencordDir -Destination $backup
} else {
    New-Item -ItemType Directory -Force -Path $vencordDir | Out-Null
}

Copy-Item -Path (Join-Path $SourceDir "*") -Destination $vencordDir -Recurse -Force

# Vesktop は package.json の存在も確認する
$pkg = Join-Path $vencordDir "package.json"
if (-not (Test-Path -LiteralPath $pkg)) {
    Set-Content -LiteralPath $pkg -Value "{}" -NoNewline -Encoding Ascii
}

Write-Ok "インストール完了"
Write-Host ""
Write-Host "次の手順:" -ForegroundColor White
Write-Host "  1. Vesktop を完全に終了し、起動し直す"
Write-Host "  2. 設定 -> Vencord -> Plugins で 'VesktopChatExporter' を有効化"
Write-Host "  3. サーバーを右クリック -> '全チャンネルのログを保存（TXT + HTML）'"
Write-Host ""
Write-Note "Vesktop を更新した場合や --repair を実行した場合は、公式 Vencord に戻るため再インストールが必要です。"
