param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$PackageDirectory,
    [string]$ExpectedPackageSha256,
    [switch]$BaselineMissingAudit
)
$ErrorActionPreference = 'Stop'
function Write-NewJsonReceipt {
    param([string]$Path, [object]$Value)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 8) + "`n")
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
# ET-055 PR-4: the package folder and executable of the build that was made (scripts/build-channel.mjs --built), staging on
# pull requests and production on main pushes.
$builtText = & (Get-Command node -ErrorAction Stop).Source (Join-Path $checkout 'scripts/build-channel.mjs') --built
if ($LASTEXITCODE -ne 0) { throw 'Build evidence unavailable: run npm run package first.' }
$built = ($builtText -join "`n") | ConvertFrom-Json
# Locals, not the [string] parameter itself (tests/windows/Test-HarnessVariables.ps1).
$packageSource = if ($PackageDirectory) { $PackageDirectory } else { Join-Path $checkout $built.packageDirectory }
$resolvedPackage = (Resolve-Path -LiteralPath $packageSource).Path
if (!$ExpectedPackageSha256 -or $ExpectedPackageSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'An expected frozen package SHA-256 is required.' }
$output = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('session-end-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
$config = @{ checkout = $checkout; output = $output; packageDirectory = $resolvedPackage; expectedPackageSha256 = $ExpectedPackageSha256;
    executable = (Join-Path $resolvedPackage $built.executable); baselineMissingAudit = [bool]$BaselineMissingAudit }
foreach ($name in @('temp', 'appdata', 'localappdata', 'profile', 'diagnostics')) {
    $config[$name] = Join-Path $output $name
    New-Item -ItemType Directory -Path $config[$name] | Out-Null
}
$config.commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
$config.harnessHashes = @{}
foreach ($relative in @('scripts/ci/Invoke-SessionEndSmoke.ps1', 'scripts/ci/session-end-smoke.mjs', 'scripts/ci/session-end-observation.mjs', 'scripts/ci/SessionEndSender.cs', 'scripts/ci/exit-observation.mjs', 'scripts/package-integrity.mjs', 'scripts/watchdog/BoundedProcess.cs')) {
    $config.harnessHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $checkout $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
}
$config.sender = Join-Path $output 'SessionEndSender.exe'
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /platform:x64 /out:$($config.sender) (Join-Path $PSScriptRoot 'SessionEndSender.cs')
if ($LASTEXITCODE -ne 0) { throw 'Owned-window sender compilation failed.' }
$config.senderSha256 = (Get-FileHash -LiteralPath $config.sender -Algorithm SHA256).Hash.ToLowerInvariant()
$configFile = Join-Path $output 'config.json'
Write-NewJsonReceipt -Path $configFile -Value $config
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
$node = (Get-Command node -ErrorAction Stop).Source
$code = $null; $jobError = $null; $resultError = $null; $result = $null
try {
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node, [string[]]@((Join-Path $PSScriptRoot 'session-end-smoke.mjs'), $configFile), $checkout, (Join-Path $output 'job'), 60000, $true)
} catch { $jobError = $_.Exception.Message }
finally {
    $resultPath = Join-Path $output 'result.json'
    $resultPresent = Test-Path -LiteralPath $resultPath
    if ($resultPresent) {
        try { $result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json }
        catch { $resultError = $_.Exception.Message }
    } else { $resultError = 'Driver result.json is missing; never infer a passing check.' }
    $productPassed = $null -ne $result -and $result.passed -is [bool] -and $result.passed
    $reproduced = $null -ne $result -and $result.reproducedLogLoss -is [bool] -and $result.reproducedLogLoss
    $validResult = $null -eq $jobError -and $null -eq $resultError -and $code -eq 0
    $accepted = $validResult -and (($BaselineMissingAudit -and $reproduced) -or (!$BaselineMissingAudit -and $productPassed))
    Write-NewJsonReceipt -Path (Join-Path $output 'receipt.json') -Value ([ordered]@{
        jobExitCode = $code; jobError = $jobError; resultPresent = $resultPresent; resultReadError = $resultError
        limits = '60 s; 16 processes; 2 GiB; 25% CPU; kill-on-close'; baseline = [bool]$BaselineMissingAudit
        passed = $validResult -and $productPassed -and !$BaselineMissingAudit; reproducedLogLoss = $reproduced
        harnessHashes = $config.harnessHashes; senderSha256 = $config.senderSha256; harnessCommit = $config.commit
    })
}
Write-Output "Session-end evidence: $output"
if (!$accepted) { throw 'Session-end native-message check failed; preserve its evidence.' }
