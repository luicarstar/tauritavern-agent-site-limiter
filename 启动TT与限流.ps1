param([string]$TauriTavernExe = '')
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot '启动限流服务.ps1')
if (Get-Process -Name tauritavern -ErrorAction SilentlyContinue) { return }
if (-not $TauriTavernExe -or -not (Test-Path -LiteralPath $TauriTavernExe -PathType Leaf)) {
    throw '限流服务已启动。请自行打开 TT，或用 -TauriTavernExe 参数指定 tauritavern.exe 的完整路径。'
}
Start-Process -FilePath $TauriTavernExe
