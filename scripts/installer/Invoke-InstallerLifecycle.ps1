[CmdletBinding()]
param(
    # Reports the steps and launches nothing.
    [switch]$Plan,
    # An owner-requested local run (plan O6): skips the GitHub-hosted runner signal; the fact-based guards still apply.
    # Agents never pass it. The test install then skips the shortcuts, and the run leaves no uninstall key behind.
    [switch]$AllowLocal,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosA = @('scaffold'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosB = @('scaffold','plugin','telemetry')
)
# ET-018 PR-1 (REG-013, REG-017; plan U10-U13): the installer lifecycle in a marked test root R. Install A, installed smokes
# and a data launch that migrates a seeded synthetic version 1 database, repair (Setup A again), update to the local
# fixture feed B, installed smokes and a data launch on B, then a read of the upgraded database with the installed runtime.
# ET-018 PR-3 then runs the Windows-initiated uninstall scenarios: (1) the exact registered UninstallString with a decoy
# LOCALAPPDATA while the application runs, after its plugin setup installed the plugin into a fake ETS2 folder: complete;
# (2) a reinstall, a plugin launch and the same uninstall while the fake game host runs: deferred, with the
# deferred-cleanup executor registered under this run's own test RunOnce key; PR-5 then runs the registered command as
# Windows would at sign-in while the host still runs: still deferred, registered again; (3) a reinstall over (2), which
# cancels the deferral and its registration, a launch that adopts the plugin, and a final uninstall while the host runs
# again, deferred; PR-5 then stops the host and runs the registered command: complete. ET-018 PR-4 adds the
# in-app scenarios on a fresh install, answered through the smoke-only dialog seam: (5) the uninstall button while the fake
# game host runs: blocked, nothing changes and the application stays installed; (4) the button again: the plugin and the
# data root are removed, the application exits and hands over to Update.exe --uninstall, and the residue check follows.
# Squirrel's binary root is redirected with SQUIRREL_TEMP = R\LocalAppData, and every child process gets LOCALAPPDATA,
# APPDATA and TEMP inside R. R is deleted at the end, and any HKCU uninstall key that still points into R. It runs on a
# GitHub-hosted runner, or locally only with -AllowLocal on the owner's explicit request (docs/installer-testing.md).
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
# The versioned Setup name of forge.config.cjs (ET-018 PR-6); release-identity.test.ts checks that the two agree.
$setup = Join-Path $checkout 'out/make/squirrel.windows/x64/ETS2Telemetry-Setup-0.1.0.exe'
$planSteps = @('signal','facts','guard-plan','create-run-root','guard-ready','build-fixture-0.1.1','seed','install-0.1.0','installed-smokes-0.1.0',
    'data-launch-0.1.0','verify-0.1.0','repair-0.1.0','update-0.1.1','installed-smokes-0.1.1','data-launch-0.1.1','verify-0.1.1','games',
    'windows-uninstall-complete-running','install-0.1.0-again','plugin-launch-installed','windows-uninstall-deferred-game','run-once-blocked-game',
    'reinstall-0.1.0-over-deferral','plugin-launch-adopted','windows-uninstall-final-deferred','run-once-complete',
    'install-0.1.0-for-app','plugin-launch-for-app','app-uninstall-blocked-game','app-uninstall-verify-blocked-game',
    'app-uninstall-complete','app-uninstall-verify-complete','cleanup')
if ($Plan) {
    [ordered]@{run=$false; steps=$planSteps; scenariosA=$ScenariosA; scenariosB=$ScenariosB; setup=$setup; uninstall='windows-initiated and in-app, in R only';
        localRuns='only with -AllowLocal on an explicit owner request'; applicationLaunched=$false} | ConvertTo-Json
    return
}
# The CI signal comes first, before any registry, process or file-system read. installer-guard.mjs repeats it.
$hosted = $env:GITHUB_ACTIONS -ceq 'true' -and $env:RUNNER_ENVIRONMENT -ceq 'github-hosted'
if (!$hosted -and !$AllowLocal) {
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
# ET-018 PR-5: this run's own RunOnce key; the test install registers its deferred-cleanup executor here, never under the
# real RunOnce key. The whole key is deleted at the end.
$testKey = 'Software\ETS2Telemetry-Test-' + $id
$runOnceKey = 'HKCU\' + $testKey + '\RunOnce'
New-Item -ItemType Directory -Path $evidence | Out-Null
$configFile = Join-Path $evidence 'config.json'
[ordered]@{runRoot=$runRoot; evidence=$evidence; setup=$setup; stepBudgetMs=55000; allowLocal=[bool]$AllowLocal; runOnceKey=$runOnceKey} | ConvertTo-Json |
    Set-Content -LiteralPath $configFile -Encoding utf8
$report = [ordered]@{passed=$false; failure=$null; startedUtc=[datetime]::UtcNow.ToString('o'); scenariosA=$ScenariosA; scenariosB=$ScenariosB; steps=@();
    uninstallRun=$false; runRootRemoved=$false; registrationRemoved=$false; shortcuts=$hosted; uninstalls=@()}
$clock = [Diagnostics.Stopwatch]::StartNew()

$registryViews = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
function Read-RegistrationView([Microsoft.Win32.RegistryView]$View) {
    # The HKCU uninstall key Squirrel writes, in one registry view; only read here.
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $View)
    try {
        $key = $hive.OpenSubKey($uninstallKey, $false)
        if (!$key) { return $null }
        try { return [ordered]@{installLocation=$key.GetValue('InstallLocation'); displayVersion=$key.GetValue('DisplayVersion'); uninstallString=$key.GetValue('UninstallString')} }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Read-Registration {
    foreach ($view in $registryViews) { $row = Read-RegistrationView $view; if ($row) { return $row } }
    return $null
}
function Get-FactJson {
    # Machine facts for the guards. They travel in an environment variable of one driver command and are never written to
    # a file: the evidence is uploaded publicly on CI. The driver records only factsEvidence() (booleans and counts).
    # Known folders through Windows (Environment.GetFolderPath ignores the LOCALAPPDATA and APPDATA variables).
    $real = [ordered]@{localAppData=[Environment]::GetFolderPath('LocalApplicationData'); roamingAppData=[Environment]::GetFolderPath('ApplicationData')}
    $steamPath = $null; $libraryFolders = $null; $libraryFoldersState = 'absent'
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Default)
    try {
        # Read only: the Valve key is never written or enumerated beyond this value.
        $valve = $hive.OpenSubKey('Software\Valve\Steam', $false)
        if ($valve) { try { $steamPath = [string]$valve.GetValue('SteamPath') } finally { $valve.Dispose() } }
    } finally { $hive.Dispose() }
    if ($steamPath) {
        $steamPath = [IO.Path]::GetFullPath($steamPath.Replace('/', '\'))
        $vdf = Join-Path $steamPath 'steamapps\libraryfolders.vdf'
        # A list that exists but is larger than 16 KiB or unreadable refuses the run: it could hide the library R lies in.
        if (Test-Path -LiteralPath $vdf -PathType Leaf) {
            $libraryFoldersState = 'unreadable'
            try { if ((Get-Item -LiteralPath $vdf).Length -le 16384) { $libraryFolders = Get-Content -LiteralPath $vdf -Raw; $libraryFoldersState = 'read' } } catch { $libraryFolders = $null }
        }
    }
    $registration = Read-Registration
    $facts = [ordered]@{real=$real; realBinaryRootExists=(Test-Path -LiteralPath (Join-Path $real.localAppData 'ETS2TelemetryDesktop')); registrationExists=($null -ne $registration);
        registration=$registration; steamPath=$steamPath; libraryFolders=$libraryFolders; libraryFoldersState=$libraryFoldersState;
        processes=@(Get-Process | ForEach-Object { $_.ProcessName + '.exe' } | Sort-Object -Unique)}
    $json = $facts | ConvertTo-Json -Depth 4 -Compress
    if ($json.Length -gt 32000) { throw 'FACTS_TOO_LARGE: the machine facts do not fit one environment variable.' }
    return $json
}
function Invoke-Driver([string]$Command, [string[]]$Arguments, [int]$TimeoutMs) {
    # Every driver command runs as the root of its own BoundedProcess Job: 16 processes, 2 GiB, 25% CPU, kill on close.
    $label = $Command + $(if ($Arguments.Count) { '-' + $Arguments[0] } else { '' })
    $started = $clock.Elapsed.TotalSeconds
    # Fresh facts for this command only; the driver removes the variable from its own environment at once.
    $env:ETS2TELEMETRY_INSTALLER_FACTS = Get-FactJson
    try {
        $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node, [string[]](@($driver, $Command, $configFile) + $Arguments),
            $evidence, (Join-Path $evidence ('job-' + $label)), $TimeoutMs)
    } finally { Remove-Item Env:ETS2TELEMETRY_INSTALLER_FACTS -ErrorAction SilentlyContinue }
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
    Invoke-Driver 'installed' @($Label) 30000
    $registration = Read-Registration
    if ($registration.displayVersion -cne $Version) { throw ('Registered version differs after ' + $Label) }
    $executable = Join-Path $binaryRoot ('app-' + $Version + '\ETS2TelemetryDesktop.exe')
    if (!(Test-Path -LiteralPath $executable -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $binaryRoot 'Update.exe') -PathType Leaf)) { throw ('Installed files missing after ' + $Label) }
    return $executable
}

$shortcutFolders = @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))
function Get-ProductLinkCount {
    # Shortcuts (.lnk) on the Desktop and in the Start menu whose target lies in R's binary root; read only, counted only.
    $shell = New-Object -ComObject WScript.Shell
    $count = 0
    try {
        foreach ($folder in $shortcutFolders) {
            if (!$folder -or !(Test-Path -LiteralPath $folder)) { continue }
            foreach ($item in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue)) {
                $link = $shell.CreateShortcut($item.FullName)
                try { if ($link.TargetPath -and [IO.Path]::GetFullPath($link.TargetPath).StartsWith($binaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { $count++ } }
                finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
            }
        }
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    return $count
}
function Assert-ProductLinks([string]$Label, [bool]$Installed) {
    # A test install creates shortcuts only on a GitHub-hosted runner (its test file says so), and an uninstall removes them.
    $count = Get-ProductLinkCount
    $script:report.steps += ,[ordered]@{step=('shortcuts-' + $Label); productLinks=$count}
    if ($Installed -and $hosted) { if ($count -lt 1) { throw ('Product shortcuts missing after ' + $Label) } }
    elseif ($count -ne 0) { throw ('PRODUCT_SHORTCUT_UNEXPECTED after ' + $Label + ': ' + $count) }
}
function Get-VendorHelper([string]$Version) {
    # Squirrel's helper of the installed version, before an uninstall: the only executable its residue may keep.
    $file = Join-Path $binaryRoot ('app-' + $Version + '\squirrel.exe')
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw ('Vendor helper missing in app-' + $Version) }
    return [ordered]@{sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash; bytes=(Get-Item -LiteralPath $file).Length}
}
function Get-BinaryRootListing($Helper) {
    # Every entry left in the binary root by relative name, with its kind, size and whether its bytes are Squirrel's helper
    # or its one-space .dead marker; at most 257 entries (the check refuses more than 256). Written to the evidence
    # before any residue assertion.
    $rows = [Collections.Generic.List[object]]::new()
    if (!(Test-Path -LiteralPath $binaryRoot -PathType Container)) { return ,$rows.ToArray() }
    foreach ($item in @(Get-ChildItem -LiteralPath $binaryRoot -Recurse -Force | Select-Object -First 257)) {
        $relative = $item.FullName.Substring($binaryRoot.Length + 1).Replace('\', '/')
        $reparse = [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
        if ($item.PSIsContainer) { $rows.Add([ordered]@{relative=$relative; kind='directory'; reparse=$reparse}); continue }
        $isHelper = $false; $isMarker = $false
        if (!$reparse -and $item.Length -eq $Helper.bytes) { $isHelper = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash -eq $Helper.sha256 }
        if (!$reparse -and $item.Length -eq 1) {
            $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
            try { $isMarker = $stream.ReadByte() -eq 32 } finally { $stream.Dispose() }
        }
        $rows.Add([ordered]@{relative=$relative; kind='file'; bytes=$item.Length; reparse=$reparse; vendorHelper=$isHelper; deadMarker=$isMarker})
    }
    return ,$rows.ToArray()
}
function Assert-Uninstalled([string]$Label, $Helper) {
    # After a Windows-initiated uninstall: no registration, no product shortcut, and the binary root holds only Squirrel's
    # residue (TD-013): the listing goes to the evidence first, then the driver's residue command applies
    # checkUninstallResidue (installer-guard.mjs; docs/installer-testing.md, "Binary root residue"), which also tolerates
    # and reports Electron runtime files left in an app- folder and fails anything of this application by name.
    if ($null -ne (Read-Registration)) { throw ('UNINSTALL_REGISTRATION_REMAINS after ' + $Label) }
    Assert-ProductLinks $Label $false
    $listing = Get-BinaryRootListing $Helper
    ConvertTo-Json -InputObject $listing -Depth 3 | Set-Content -LiteralPath (Join-Path $evidence ('residue-listing-' + $Label + '.json')) -Encoding utf8
    if (!(Test-Path -LiteralPath $binaryRoot -PathType Container)) { throw ('UNINSTALL_ROOT_OR_MARKER_MISSING after ' + $Label) }
    # The rule itself is checkUninstallResidue in installer-guard.mjs (unit-tested), run by the driver's residue command.
    Invoke-Driver 'residue' @($Label) 30000
    $result = (Get-Content -LiteralPath (Join-Path $evidence ('residue-' + $Label + '.json')) -Raw | ConvertFrom-Json).result
    $script:report.uninstalls += ,[ordered]@{label=$Label; registrationRemoved=$true; residueEntries=$listing.Count; vendorFiles=$result.vendorFiles;
        toleratedRuntimeResidue=@($result.toleratedRuntimeResidue); toleratedRuntimeResidueCount=$result.toleratedRuntimeResidueCount}
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
    & $node $driver signal @(if ($AllowLocal) { '--allow-local' })
    if ($LASTEXITCODE -ne 0) { throw 'LOCAL_RUN_REFUSED: the guard module refused the run signal.' }
    Invoke-Driver 'guard' @('plan') 30000
    $guarded = $true
    foreach ($folder in @($runRoot, $base, (Join-Path $runRoot 'temp'), (Join-Path $runRoot 'AppData'), (Join-Path $runRoot 'profile'), (Join-Path $runRoot 'cwd'),
        (Join-Path $runRoot 'diagnostics'), (Join-Path $runRoot 'exports'), (Join-Path $runRoot 'fixture'))) { New-Item -ItemType Directory -Path $folder | Out-Null }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-plugin-test-root.marker'), "Test root of the ETS2Telemetry installer lifecycle.`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-install-test.json'), (([ordered]@{format='ets2telemetry.install-test'; version=1;
        profileDir=(Join-Path $runRoot 'profile'); runOnceKey=$runOnceKey; shortcuts=$hosted}) | ConvertTo-Json), $utf8)
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
    Assert-ProductLinks 'install-0.1.0' $true
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

    # ET-018 PR-3: the Windows-initiated uninstall scenarios (docs/installer-testing.md, "Uninstall scenarios").
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    Invoke-Driver 'games' @() 30000
    $helper = Get-VendorHelper '0.1.1'
    $report.uninstallRun = $true
    Invoke-Driver 'windows-uninstall' @('complete-running', $executableB, 'complete') 60000
    Assert-Uninstalled 'complete-running' $helper

    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-again-0.1.0'
    Invoke-Driver 'step' @('install-again-0.1.0', $setup, '--silent') 60000
    $executableA = Assert-Installed 'install-again-0.1.0' '0.1.0'
    Assert-ProductLinks 'install-again-0.1.0' $true
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    Invoke-Driver 'plugin-launch' @('installed', $executableA, 'installed') 60000
    $helper = Get-VendorHelper '0.1.0'
    Invoke-Driver 'windows-uninstall' @('deferred-game', '-', 'deferred') 60000
    Assert-Uninstalled 'deferred-game' $helper
    # PR-5: the next sign-in while the game still runs: the executor keeps everything and registers itself again.
    Invoke-Driver 'run-once' @('blocked-game', 'blocked') 60000

    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\reinstall-0.1.0'
    Invoke-Driver 'step' @('reinstall-0.1.0', $setup, '--silent') 60000
    $executableA = Assert-Installed 'reinstall-0.1.0' '0.1.0'
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    Invoke-Driver 'plugin-launch' @('adopted', $executableA, 'adopted') 60000
    $helper = Get-VendorHelper '0.1.0'
    # PR-5: the final Windows-initiated uninstall defers while the fake game runs; once it has stopped, the registered
    # executor finishes the cleanup as it would at the next sign-in.
    Invoke-Driver 'windows-uninstall' @('final', '-', 'deferred') 60000
    Assert-Uninstalled 'final' $helper
    Invoke-Driver 'run-once' @('final', 'complete') 60000

    # ET-018 PR-4: the in-app uninstall scenarios (docs/installer-testing.md, "In-app uninstall scenarios").
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-for-app-0.1.0'
    Invoke-Driver 'step' @('install-for-app-0.1.0', $setup, '--silent') 60000
    $executableA = Assert-Installed 'install-for-app-0.1.0' '0.1.0'
    Assert-ProductLinks 'install-for-app-0.1.0' $true
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    # Each command gets its own Job of at most 60 s (BoundedProcess): the plugin is installed first, so each in-app run only
    # starts the application; the run records, its verify command asserts.
    Invoke-Driver 'plugin-launch' @('for-app', $executableA, 'installed') 60000
    Invoke-Driver 'app-uninstall' @('blocked-game', $executableA, 'blocked') 60000
    Invoke-Driver 'app-uninstall-verify' @('blocked-game') 30000
    $null = Assert-Installed 'after-app-blocked' '0.1.0'
    Assert-ProductLinks 'after-app-blocked' $true
    $helper = Get-VendorHelper '0.1.0'
    Invoke-Driver 'app-uninstall' @('complete-app', $executableA, 'complete') 60000
    Invoke-Driver 'app-uninstall-verify' @('complete-app') 30000
    Assert-Uninstalled 'complete-app' $helper
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
        # One InstallLocation per registry view, '-' where the view has no key. The driver deletes R without following links
        # and decides for each view whether its key points into R; only those keys are deleted, and only on a hosted runner.
        $locations = @($registryViews | ForEach-Object {
            $row = Read-RegistrationView $_
            if ($row -and $row.installLocation) { [string]$row.installLocation } else { '-' }
        })
        $line = & $node $driver cleanup $configFile @locations | Select-Object -Last 1
        try {
            $cleanup = $line | ConvertFrom-Json
            $report.runRootRemoved = [bool]$cleanup.passed
            $owned = @($cleanup.ownsRegistration)
            if ($owned.Count -ne $registryViews.Count) { throw 'Cleanup returned no decision per registry view.' }
            # On a hosted runner or an owner-requested local run; a key is deleted only when it points into R.
            if ($hosted -or $AllowLocal) {
                for ($index = 0; $index -lt $registryViews.Count; $index++) {
                    if ($owned[$index] -ne $true) { continue }
                    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryViews[$index])
                    try { $hive.DeleteSubKeyTree($uninstallKey, $false) } finally { $hive.Dispose() }
                }
            }
            $report.registrationRemoved = ($null -eq (Read-Registration))
        } catch { $report.cleanupFailure = $_.Exception.Message }
        # This run's own test RunOnce key (PR-5); its name holds the run id, so it is never another key.
        try {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey, $false)
            $report.runOnceKeyRemoved = ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKey))
        } catch { $report.runOnceKeyFailure = $_.Exception.Message }
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
