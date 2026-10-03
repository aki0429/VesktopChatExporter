#Requires -Version 5.1
<#
    Vesktop Chat Exporter - uninstaller

    インストール時に作成したバックアップ（vencordFiles.bak-*）を復元します。
    バックアップが無い場合は vencordFiles を削除し、次回起動時に
    Vesktop が公式 Vencord を再ダウンロードできる状態に戻します。
#>
[CmdletBinding()]
param(
    [string]$UserDataDir
)

$ErrorActionPreference = "Stop"

function Write-Info($m) { Write-Host "[*] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Fail($m)       { Write-Host "[x] $m" -ForegroundColor Red; exit 1 }

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
            (Test-Path -LiteralPath (Join-Path $c "settings.json"))) { return $c }
    }
    if ($env:APPDATA) { return (Join-Path $env:APPDATA "vesktop") }
    return $null
}

$dataDir = Resolve-VesktopUserData -Explicit $UserDataDir
if (-not $dataDir) { Fail "Vesktop のデータフォルダーを特定できませんでした。" }

$sessionDataDir = Join-Path $dataDir "sessionData"
$vencordDir     = Join-Path $sessionDataDir "vencordFiles"

$running = Get-Process -Name "vesktop" -ErrorAction SilentlyContinue
if ($running) { Write-Host "[!] Vesktop が起動中です。終了してから実行してください。" -ForegroundColor Yellow }

$backups = @()
if (Test-Path -LiteralPath $sessionDataDir) {
    $backups = Get-ChildItem -LiteralPath $sessionDataDir -Directory -Filter "vencordFiles.bak-*" -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
}

if ($backups.Count -gt 0) {
    $latest = $backups[0]
    Write-Info "バックアップを復元します: $($latest.FullName)"
    if (Test-Path -LiteralPath $vencordDir) { Remove-Item -Recurse -Force -LiteralPath $vencordDir }
    Copy-Item -Recurse -Force -LiteralPath $latest.FullName -Destination $vencordDir
    Write-Ok "復元完了: $vencordDir"
} elseif (Test-Path -LiteralPath $vencordDir) {
    Write-Info "バックアップが無いため vencordFiles を削除します（次回起動時に公式 Vencord を再取得）。"
    Remove-Item -Recurse -Force -LiteralPath $vencordDir
    Write-Ok "削除完了"
} else {
    Write-Ok "インストールされていません。"
}

Write-Host ""
Write-Host "Vesktop を再起動してください。" -ForegroundColor White
