param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $taskRoot 'dist' }
$taskOutput = [IO.Path]::GetFullPath($OutputDirectory)
$taskPackage = Get-Content -Raw -LiteralPath (Join-Path $taskRoot 'package.json') | ConvertFrom-Json
$taskStageParent = Join-Path $taskOutput ('stage-' + [Guid]::NewGuid().ToString('N'))
$taskStage = Join-Path $taskStageParent 'tauritavern-agent-site-limiter'
New-Item -ItemType Directory -Force -Path $taskStage | Out-Null
$taskAllowed = @(
    'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json', 'package-lock.json',
    '安装插件.ps1', '启动限流服务.ps1', '停止限流服务.ps1', '启动TT与限流.ps1',
    'extension/manifest.json', 'extension/site-index.js', 'extension/site-router.js',
    'extension/model.js', 'extension/style.css', 'extension/client-config.example.json',
    'service/install.mjs', 'service/server.mjs', 'service/limiter.mjs',
    'docs/ARCHITECTURE.md', 'docs/DEVELOPMENT.md'
)
foreach ($taskRelative in $taskAllowed) {
    $taskSource = Join-Path $taskRoot $taskRelative
    if (-not (Test-Path -LiteralPath $taskSource -PathType Leaf)) { throw ('Missing release file: ' + $taskRelative) }
    $taskTarget = Join-Path $taskStage $taskRelative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $taskTarget) | Out-Null
    Copy-Item -LiteralPath $taskSource -Destination $taskTarget
}
$taskArchive = Join-Path $taskOutput ('tauritavern-agent-site-limiter-' + $taskPackage.version + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $taskArchive) { Remove-Item -LiteralPath $taskArchive }
[IO.Compression.ZipFile]::CreateFromDirectory($taskStageParent, $taskArchive)
$taskHash = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $taskOutput 'SHA256SUMS.txt'), $taskHash + '  ' + [IO.Path]::GetFileName($taskArchive) + "`n", [Text.UTF8Encoding]::new($false))
Write-Output $taskArchive
Write-Output ('SHA256 ' + $taskHash)
