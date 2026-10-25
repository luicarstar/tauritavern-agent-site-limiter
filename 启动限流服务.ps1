$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskStateFile = Join-Path $PSScriptRoot 'runtime\state.json'
if (-not (Test-Path -LiteralPath $taskStateFile)) { throw '请先运行安装插件.ps1' }
$taskState = Get-Content -Raw -LiteralPath $taskStateFile | ConvertFrom-Json
$taskServiceUrl = 'http://127.0.0.1:' + $taskState.port
try {
    $taskHealth = Invoke-RestMethod -Uri ($taskServiceUrl + '/api/status') -Headers @{ 'x-tt-limiter-token' = $taskState.adminToken } -TimeoutSec 2
    if ($taskHealth.service -ne 'tt-agent-limiter') { throw '端口被其他服务占用' }
    if ($taskHealth.version -ne '0.2.0') { throw '请运行安装插件.ps1 升级已有服务' }
    Write-Output 'TT Agent 限流服务已运行。'
    return
} catch {
    $taskProbe = [System.Net.Sockets.TcpClient]::new()
    try {
        $taskProbe.Connect('127.0.0.1', [int]$taskState.port)
        throw '限流端口已被占用，且服务健康检查未通过。'
    } catch [System.Net.Sockets.SocketException] {
        # No listener: start our service below.
    } finally { $taskProbe.Dispose() }
}
$taskRuntime = Join-Path $PSScriptRoot 'runtime'
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(
    ('"' + (Join-Path $PSScriptRoot 'service\server.mjs') + '"'), ('"' + $taskStateFile + '"')
) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskRuntime 'service.log') -RedirectStandardError (Join-Path $taskRuntime 'service-error.log')
Start-Sleep -Milliseconds 500
$taskProcess.Refresh()
if ($taskProcess.HasExited) { throw '限流服务启动失败，请查看 runtime\service-error.log' }
$taskHealth = Invoke-RestMethod -Uri ($taskServiceUrl + '/health') -TimeoutSec 3
if ($taskHealth.service -ne 'tt-agent-limiter') { throw '限流服务验证失败' }
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskRuntime 'service.pid')
Write-Output ('TT Agent 限流服务已启动，PID ' + $taskProcess.Id)
