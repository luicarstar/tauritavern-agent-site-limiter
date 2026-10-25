$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $PSScriptRoot 'runtime\service.pid'
if (-not (Test-Path -LiteralPath $taskPidFile)) { Write-Output '没有本插件启动的服务记录。'; return }
$taskServicePid = [int](Get-Content -Raw -LiteralPath $taskPidFile)
$taskProcess = Get-Process -Id $taskServicePid -ErrorAction SilentlyContinue
if ($taskProcess -and $taskProcess.ProcessName -eq 'node') {
    # Verify ownership with the service's state token before stopping a recorded process.
    $taskState = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'runtime\state.json') | ConvertFrom-Json
    $taskHeaders = @{ 'x-tt-limiter-token' = $taskState.adminToken }
    $taskStatus = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $taskState.port + '/api/status') -Headers $taskHeaders -TimeoutSec 2
    if ($taskStatus.service -ne 'tt-agent-limiter' -or $taskStatus.pid -ne $taskServicePid) { throw '服务身份核验失败' }
    Stop-Process -Id $taskServicePid
    Write-Output '限流服务已停止。受控模型需恢复原模型后才能直接请求上游。'
}
