[CmdletBinding()]
param(
    # Reports the steps and launches nothing.
    [switch]$Plan,
    # An owner-requested local run (plan O6). It refuses until ET-018 PR-3 replaces electron-squirrel-startup, whose
    # install and update hooks create real Desktop and Start menu shortcuts.
    [switch]$AllowLocal,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosA = @('scaffold'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosB = @('scaffold','plugin','telemetry')
)
# ET-018 PR-1 (REG-013, REG-017; plan U10-U13): the installer lifecycle in a marked test root R. Install A, installed smokes
# and a data launch that migrates a seeded synthetic version 1 database, repair (Setup A again), update to the local
# fixture feed B, installed smokes and a data launch on B, then a read of the upgraded database with the installed runtime.
# Squirrel's binary root is redirected with SQUIRREL_TEMP = R\LocalAppData, and every child process gets LOCALAPPDATA,
# APPDATA and TEMP inside R. Nothing uninstalls in PR-1; R is deleted at the end and, on CI, the HKCU uninstall key that
# points into R. It runs only on a GitHub-hosted runner (docs/installer-testing.md); never run it on a personal machine.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$setup = Join-Path $checkout 'out/make/squirrel.windows/x64/ETS2Telemetry Desktop-0.1.0 Setup.exe'
$planSteps = @('signal','facts','guard-plan','create-run-root','guard-ready','build-fixture-0.1.1','seed','install-0.1.0','installed-smokes-0.1.0',
    'data-launch-0.1.0','verify-0.1.0','repair-0.1.0','update-0.1.1','installed-smokes-0.1.1','data-launch-0.1.1','verify-0.1.1','cleanup')
if ($Plan) {
    [ordered]@{run=$false; steps=$planSteps; scenariosA=$ScenariosA; scenariosB=$ScenariosB; setup=$setup; uninstall=$false;
        localRuns='refused until ET-018 PR-3'; applicationLaunched=$false} | ConvertTo-Json
    return
}
# The CI signal comes first, before any registry, process or file-system read. installer-guard.mjs repeats it.
if ($AllowLocal) { throw 'LOCAL_RUN_UNAVAILABLE_UNTIL_PR3: electron-squirrel-startup would create real shortcuts; see docs/installer-testing.md.' }
if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'LOCAL_RUN_REFUSED: the installer lifecycle runs only on a GitHub-hosted runner; dispatch Windows CI instead (docs/installer-testing.md).'
}
$node = (Get-Command node -ErrorAction Stop).Source
$driver = Join-Path $PSScriptRoot 'installer-lifecycle.mjs'
if (!(Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Squirrel Setup.exe missing: run npm run make first.' }
# Compiled before the environment changes below: Windows PowerShell's Add-Type needs the real TEMP.
if (-not ('ETS2Telemetry.Diagnostics.BoundedProcess' -as [type])) { Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs') }

$id = [guid]::NewGuid().ToString('N')
$evidence = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('installer-' + $id + '-evidence')
# R lives in the runner's temporary folder on CI, which is never uploaded; without one, beside the evidence.
$runParent = if ($env:RUNNER_TEMP) { [IO.Path]::GetFullPath($env:RUNNER_TEMP) } else { [IO.Path]::GetFullPath($OutputRoot) }
$runRoot = Join-Path $runParent ('installer-' + $id)
$base = Join-Path $runRoot 'LocalAppData'
$binaryRoot = Join-Path $base 'ETS2TelemetryDesktop'
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\ETS2TelemetryDesktop'
New-Item -ItemType Directory -Path $evidence | Out-Null
$configFile = Join-Path $evidence 'config.json'
$factsFile = Join-Path $evidence 'facts.json'
[ordered]@{runRoot=$runRoot; evidence=$evidence; setup=$setup; factsFile=$factsFile; stepBudgetMs=55000} | ConvertTo-Json |
    Set-Content -LiteralPath $configFile -Encoding utf8
$report = [ordered]@{passed=$false; failure=$null; startedUtc=[datetime]::UtcNow.ToString('o'); scenariosA=$ScenariosA; scenariosB=$ScenariosB; steps=@();
    uninstallRun=$false; runRootRemoved=$false; registrationRemoved=$false}
$clock = [Diagnostics.Stopwatch]::StartNew()

function Read-Registration {
    # The HKCU uninstall key Squirrel writes; read in both registry views, never written here.
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            $key = $hive.OpenSubKey($uninstallKey, $false)
            if ($key) {
                try { return [ordered]@{installLocation=$key.GetValue('InstallLocation'); displayVersion=$key.GetValue('DisplayVersion'); uninstallString=$key.GetValue('UninstallString')} }
                finally { $key.Dispose() }
            }
        } finally { $hive.Dispose() }
    }
    return $null
}
function Write-Fact {
    # Known folders through Windows (Environment.GetFolderPath ignores the LOCALAPPDATA and APPDATA variables).
    $real = [ordered]@{localAppData=[Environment]::GetFolderPath('LocalApplicationData'); roamingAppData=[Environment]::GetFolderPath('ApplicationData')}
    $steamPath = $null; $libraryFolders = $null
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default)
    try {
        # Read only: the Valve key is never written or enumerated beyond this value.
        $valve = $hive.OpenSubKey('Software\Valve\Steam', $false)
        if ($valve) { try { $steamPath = [string]$valve.GetValue('SteamPath') } finally { $valve.Dispose() } }
    } finally { $hive.Dispose() }
    if ($steamPath) {
        $steamPath = [IO.Path]::GetFullPath($steamPath.Replace('/', '\'))
        $vdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
        if ((Test-Path -LiteralPath $vdf -PathType Leaf) -and (Get-Item -LiteralPath $vdf).Length -le 1048576) { $libraryFolders = Get-Content -LiteralPath $vdf -Raw }
    }
    $registration = Read-Registration
    [ordered]@{real=$real; realBinaryRootExists=(Test-Path -LiteralPath (Join-Path $real.localAppData 'ETS2TelemetryDesktop')); registrationExists=($null -ne $registration);
        registration=$registration; steamPath=$steamPath; libraryFolders=$libraryFolders; processes=@(Get-Process | ForEach-Object { $_.ProcessName + '.exe' })} |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $factsFile -Encoding utf8
}
function Invoke-Driver([string]$Command, [string[]]$Arguments, [int]$TimeoutMs) {
    # Every driver command runs as the root of its own BoundedProcess Job: 16 processes, 2 GiB, 25% CPU, kill on close.
    $label = $Command + $(if ($Arguments.Count) { '-' + $Arguments[0] } else { '' })
    $started = $clock.Elapsed.TotalSeconds
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node, [string[]](@($driver, $Command, $configFile) + $Arguments),
        $evidence, (Join-Path $evidence ('job-' + $label)), $TimeoutMs)
    $script:report.steps += ,[ordered]@{step=$label; exitCode=$code; seconds=[math]::Round($clock.Elapsed.TotalSeconds - $started, 1)}
    if ($code -ne 0) { throw ('Installer lifecycle step failed: ' + $label + ', Job exit ' + $code + '; evidence: ' + $evidence) }
}
function Invoke-InstalledSmoke([string]$Executable, [string[]]$Scenarios, [string]$Version) {
    # A separate shell, so the smoke's own Job and Add-Type stay independent of this session.
    $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    foreach ($scenario in $Scenarios) {
        $started = $clock.Elapsed.TotalSeconds
        & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $checkout 'scripts/ci/Invoke-RuntimeSmoke.ps1') -Mode installed -Executable $Executable `
            -Scenario $scenario -OutputRoot $evidence
        $code = $LASTEXITCODE
        $script:report.steps += ,[ordered]@{step=('installed-smoke-' + $scenario + '-' + $Version); exitCode=$code; seconds=[math]::Round($clock.Elapsed.TotalSeconds - $started, 1)}
        if ($code -ne 0) { throw ('Installed ' + $scenario + ' smoke failed on ' + $Version + '; evidence: ' + $evidence) }
    }
}
function Assert-Installed([string]$Label, [string]$Version) {
    # The registration and the binary root must lie in R; otherwise abort at once, with no uninstall.
    Write-Fact
    Invoke-Driver 'installed' @($Label) 30000
    $registration = Read-Registration
    if ($registration.displayVersion -cne $Version) { throw ('Registered version differs after ' + $Label) }
    $executable = Join-Path $binaryRoot ('app-' + $Version + '\ETS2TelemetryDesktop.exe')
    if (!(Test-Path -LiteralPath $executable -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $binaryRoot 'Update.exe') -PathType Leaf)) { throw ('Installed files missing after ' + $Label) }
    return $executable
}

$saved = @{}
$guarded = $false
# Before the first child process starts, the environment names only R (its folders are created after the preflight), so
# no child, not even a guard, receives the real LOCALAPPDATA, APPDATA or TEMP: LOCALAPPDATA and SQUIRREL_TEMP are
# R\LocalAppData. Every other ETS2TELEMETRY_ variable that could change a launch is removed. The finally block restores them.
foreach ($name in @('LOCALAPPDATA','SQUIRREL_TEMP','TEMP','TMP','APPDATA','ETS2TELEMETRY_PROFILE_DIR','ETS2TELEMETRY_DIAGNOSTIC_DIR','ETS2TELEMETRY_PLUGIN_SETUP_ROOT',
    'ETS2TELEMETRY_PLUGIN_SETUP','ETS2TELEMETRY_RECORDING','ETS2TELEMETRY_LIVE_SMOKE','ETS2TELEMETRY_SOURCE_KIND','ETS2TELEMETRY_SOURCE_PIPE','ETS2TELEMETRY_SOURCE_PIPE_V1',
    'ETS2TELEMETRY_CAPTURE')) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$env:LOCALAPPDATA = $base; $env:SQUIRREL_TEMP = $base
$env:TEMP = Join-Path $runRoot 'temp'; $env:TMP = $env:TEMP; $env:APPDATA = Join-Path $runRoot 'AppData'
$env:ETS2TELEMETRY_PROFILE_DIR = Join-Path $runRoot 'profile'; $env:ETS2TELEMETRY_PLUGIN_SETUP_ROOT = $runRoot
try {
    & $node $driver signal
    if ($LASTEXITCODE -ne 0) { throw 'LOCAL_RUN_REFUSED: the guard module refused the run signal.' }
    Write-Fact
    Invoke-Driver 'guard' @('plan') 30000
    $guarded = $true
    foreach ($folder in @($runRoot, $base, (Join-Path $runRoot 'temp'), (Join-Path $runRoot 'AppData'), (Join-Path $runRoot 'profile'), (Join-Path $runRoot 'cwd'),
        (Join-Path $runRoot 'diagnostics'), (Join-Path $runRoot 'exports'), (Join-Path $runRoot 'fixture'))) { New-Item -ItemType Directory -Path $folder | Out-Null }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-plugin-test-root.marker'), "Test root of the ETS2Telemetry installer lifecycle.`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-install-test.json'), (([ordered]@{format='ets2telemetry.install-test'; version=1;
        profileDir=(Join-Path $runRoot 'profile'); runOnceKey=$null; shortcuts=$true}) | ConvertTo-Json), $utf8)
    Invoke-Driver 'guard' @('ready') 30000

    # Installer version B from a temporary copy of the packaged folder (a build step; it runs no installer).
    $started = $clock.Elapsed.TotalSeconds
    & $node (Join-Path $PSScriptRoot 'build-upgrade-fixture.mjs') (Join-Path $runRoot 'fixture') (Join-Path $evidence 'upgrade-fixture.json')
    if ($LASTEXITCODE -ne 0) { throw 'Upgrade fixture build failed.' }
    $report.steps += ,[ordered]@{step='build-fixture-0.1.1'; exitCode=0; seconds=[math]::Round($clock.Elapsed.TotalSeconds - $started, 1)}
    $report.setupSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash

    Invoke-Driver 'seed' @() 30000
    Invoke-Driver 'snapshot' @('seed') 30000

    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-0.1.0'
    Invoke-Driver 'step' @('install-0.1.0', $setup, '--silent') 60000
    $executableA = Assert-Installed 'install-0.1.0' '0.1.0'
    Invoke-Driver 'snapshot' @('install-0.1.0') 30000
    Invoke-Driver 'compare' @('seed', 'install-0.1.0') 30000

    Invoke-InstalledSmoke $executableA $ScenariosA '0.1.0'
    Invoke-Driver 'launch' @('0.1.0', $executableA, '1') 60000
    Invoke-Driver 'verify' @('0.1.0', $executableA) 30000
    Invoke-Driver 'snapshot' @('launch-0.1.0') 30000

    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\repair-0.1.0'
    Invoke-Driver 'step' @('repair-0.1.0', $setup, '--silent') 60000
    $null = Assert-Installed 'repair-0.1.0' '0.1.0'
    Invoke-Driver 'snapshot' @('repair-0.1.0') 30000
    Invoke-Driver 'compare' @('launch-0.1.0', 'repair-0.1.0') 30000

    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\update-0.1.1'
    Invoke-Driver 'step' @('update-0.1.1', (Join-Path $binaryRoot 'Update.exe'), '--update', (Join-Path $runRoot 'fixture\feed')) 60000
    $executableB = Assert-Installed 'update-0.1.1' '0.1.1'
    Invoke-Driver 'snapshot' @('update-0.1.1') 30000
    Invoke-Driver 'compare' @('repair-0.1.0', 'update-0.1.1') 30000

    Invoke-InstalledSmoke $executableB $ScenariosB '0.1.1'
    Invoke-Driver 'launch' @('0.1.1', $executableB, 'none') 60000
    Invoke-Driver 'verify' @('0.1.1', $executableB) 30000
    $report.passed = $true
} catch {
    $report.failure = $_.Exception.Message
} finally {
    if ($guarded) {
        # Keep the Squirrel logs and the application diagnostics before R is deleted; binaries and databases stay out of the upload.
        try {
            $kept = Join-Path $evidence 'run-root'
            New-Item -ItemType Directory -Path $kept -Force | Out-Null
            $index = 0
            if (Test-Path -LiteralPath $base) {
                foreach ($log in @(Get-ChildItem -LiteralPath $base -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | Select-Object -First 32)) {
                    if ($log.Length -le 4194304) { Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $kept ('squirrel-' + $index + '-' + $log.Name)); $index++ }
                }
            }
            $diagnostics = Join-Path $runRoot 'diagnostics'
            if (Test-Path -LiteralPath $diagnostics) { Copy-Item -LiteralPath $diagnostics -Destination (Join-Path $kept 'diagnostics') -Recurse }
        } catch { $report.evidenceFailure = $_.Exception.Message }
        $registration = Read-Registration
        $location = if ($registration -and $registration.installLocation) { [string]$registration.installLocation } else { '' }
        # The driver deletes R without following links and decides whether the uninstall key points into R.
        $line = & $node $driver cleanup $configFile $location | Select-Object -Last 1
        try {
            $cleanup = $line | ConvertFrom-Json
            $report.runRootRemoved = [bool]$cleanup.passed
            if ($cleanup.ownsRegistration -eq $true -and $env:GITHUB_ACTIONS -ceq 'true' -and $env:RUNNER_ENVIRONMENT -ceq 'github-hosted') {
                foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
                    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
                    try { $hive.DeleteSubKeyTree($uninstallKey, $false) } finally { $hive.Dispose() }
                }
                $report.registrationRemoved = ($null -eq (Read-Registration))
            }
        } catch { $report.cleanupFailure = $_.Exception.Message }
        # The real binary root must still be absent: a run that reached it is a failure whatever else passed.
        $realBinaryRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ETS2TelemetryDesktop'
        $report.realBinaryRootAbsent = !(Test-Path -LiteralPath $realBinaryRoot)
        if (!$report.realBinaryRootAbsent) { $report.passed = $false; $report.failure = 'REAL_INSTALL_PRESENT after the run' }
    }
    # Restored only after the cleanup, which also runs with the run root's environment.
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    $report.elapsedSeconds = [math]::Round($clock.Elapsed.TotalSeconds, 1)
    $report.finishedUtc = [datetime]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $evidence 'lifecycle-result.json') -Encoding utf8
}
Write-Output ('Installer lifecycle evidence: ' + $evidence)
if (!$report.passed -or !$report.runRootRemoved) { throw ('Installer lifecycle failed: ' + $report.failure + '; evidence: ' + $evidence) }
