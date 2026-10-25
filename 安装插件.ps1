param([string]$DataRoot = (Join-Path $env:APPDATA 'com.tauritavern.client\data'))
$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
& $taskNode (Join-Path $PSScriptRoot 'service\install.mjs') $DataRoot
if ($LASTEXITCODE -ne 0) { throw '插件安装失败' }
$taskStateFile = Join-Path $PSScriptRoot 'runtime\state.json'
$taskState = Get-Content -Raw -LiteralPath $taskStateFile | ConvertFrom-Json
$taskExisting = $null
try { $taskExisting = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $taskState.port + '/api/status') -Headers @{ 'x-tt-limiter-token' = $taskState.adminToken } -TimeoutSec 2 } catch { }
if ($taskExisting -and $taskExisting.version -ne '0.2.0') {
    if ($taskExisting.active -gt 0 -or $taskExisting.queued -gt 0) { throw '限流服务仍有请求，请等待请求结束后再安装升级。' }
    & (Join-Path $PSScriptRoot '停止限流服务.ps1')
    Start-Sleep -Milliseconds 200
}
& (Join-Path $PSScriptRoot '启动限流服务.ps1')
