[CmdletBinding()]
param(
    # A fresh absolute folder for the scenes; by default a new folder in %TEMP%. It is deleted afterwards.
    [string]$WorkDirectory = (Join-Path ([IO.Path]::GetTempPath()) ('ets2tdc-' + [guid]::NewGuid().ToString('N').Substring(0, 12)))
)
# ET-018 PR-5 (REG-017; plan U7, owner decision O3): the deferred-cleanup executor resources/uninstall/
# Complete-ETS2TelemetryUninstall.ps1 on temporary scenes only. Every scene is a test root (the ET-017 marker and an
# ets2telemetry-install-test.json naming this run's own RunOnce key HKCU\Software\ETS2Telemetry-Test-<32 hex>\RunOnce),
# so the executor never reads the real known folders and never writes the real RunOnce key. The run:
#
# - plays every case of tests/fixtures/uninstall/deferred-cases.json, which tests/unit/uninstall-deferred-cases.test.ts
#   plays through the TypeScript engine, and asserts the same outcome, code and kept or removed files;
# - runs each case as Windows runs a RunOnce entry: the registered value is read, checked, deleted, then started; a
#   deferred case must register itself again with the same command and count attempt 2;
# - adds the executor's own cases: a complete run removes a value that is still there, the 10th attempt stops with
#   README.txt and no registration, and no intent, an installed application, an invalid intent or a folder outside a
#   test root change nothing.
#
# It removes its scenes and its test key at the end. No installer, game or application process is started.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$executor = Join-Path $checkout 'resources/uninstall/Complete-ETS2TelemetryUninstall.ps1'
$table = [IO.File]::ReadAllText((Join-Path $checkout 'tests/fixtures/uninstall/deferred-cases.json')) | ConvertFrom-Json
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$runId = [guid]::NewGuid().ToString('N')
$testKeyRoot = 'Software\ETS2Telemetry-Test-' + $runId
$runOnceKey = 'HKCU\' + $testKeyRoot + '\RunOnce'
$valueName = 'ETS2TelemetryUninstall'
$utf8 = New-Object Text.UTF8Encoding($false)
$utc = '2026-10-18T09:00:00.000Z'
$tempName = 'ets2telemetry-plugin.dll.00112233445566aa.tmp'
if (![IO.Path]::IsPathRooted($WorkDirectory) -or (Test-Path -LiteralPath $WorkDirectory)) { throw 'A fresh absolute work directory is required.' }
$known = [Environment]::GetFolderPath('LocalApplicationData')
if ($WorkDirectory.StartsWith((Join-Path $known 'ETS2Telemetry'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The work directory may not lie in the real data root.' }

function Get-Sha([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return -join ($sha.ComputeHash($utf8.GetBytes($Text)) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }
}
function Write-Text([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Path)) -Force | Out-Null
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Get-State([string]$Path) { if (Test-Path -LiteralPath $Path) { return 'present' } else { return 'absent' } }
function Get-Value {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKeyRoot + '\RunOnce', $false)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue($valueName) } finally { $key.Dispose() }
}
function Set-Value([string]$Command) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($testKeyRoot + '\RunOnce')
    try { $key.SetValue($valueName, $Command, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
}
function Remove-Value {
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKeyRoot + '\RunOnce', $true)
    if ($null -ne $key) { try { $key.DeleteValue($valueName, $false) } finally { $key.Dispose() } }
}
function ConvertTo-Json1($Value) { return ConvertTo-Json -InputObject $Value -Depth 6 -Compress }

function New-Scene([string]$Name, $Case, [int]$Attempts) {
    # The same scene as uninstall-deferred-cases.test.ts: R with the marker and the test file, the data root, the game folder.
    $root = Join-Path $WorkDirectory $Name
    $base = Join-Path $root 'LocalAppData'; $dataRoot = Join-Path $base 'ETS2Telemetry'
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    Write-Text (Join-Path $root 'ets2telemetry-plugin-test-root.marker') "deferred-cleanup cases`n"
    Write-Text (Join-Path $root 'ets2telemetry-install-test.json') (ConvertTo-Json1 ([ordered]@{format = 'ets2telemetry.install-test'; version = 1
        profileDir = (Join-Path $root 'profile'); runOnceKey = $runOnceKey; shortcuts = $false}))
    Write-Text (Join-Path $root 'temp\.keep') ''
    $folder = $Case.folder
    $games = Join-Path $root ('Games\' + $Case.id)
    $gameRoot = Join-Path $games $(if ($folder.game -eq 'ets2') { 'Euro Truck Simulator 2' } else { 'American Truck Simulator' })
    $win64 = Join-Path $gameRoot 'bin\win_x64'; $plugins = Join-Path $win64 'plugins'
    $dllDirectory = if ($folder.layout -eq 'plugins-link') { Join-Path $games 'elsewhere' } else { $plugins }
    $dll = Join-Path $dllDirectory 'ets2telemetry-plugin.dll'; $temp = Join-Path $plugins $tempName; $unrelated = Join-Path $plugins 'other-plugin.dll'
    $flags = @{}; foreach ($property in $folder.PSObject.Properties) { $flags[$property.Name] = $property.Value }
    New-Item -ItemType Directory -Path $games -Force | Out-Null
    if ($folder.layout -ne 'gone') {
        New-Item -ItemType Directory -Path $win64 -Force | Out-Null
        if ($folder.layout -ne 'no-executable') { Write-Text (Join-Path $win64 $(if ($folder.game -eq 'ets2') { 'eurotrucks2.exe' } else { 'amtrucks.exe' })) "fake game executable`n" }
        if ($folder.layout -eq 'plugins-link') {
            New-Item -ItemType Directory -Path $dllDirectory -Force | Out-Null
            New-Item -ItemType Junction -Path $plugins -Target $dllDirectory | Out-Null
        } else { New-Item -ItemType Directory -Path $plugins -Force | Out-Null }
        if ($folder.dll -ne 'none') { Write-Text $dll $table.contents.($folder.dll) }
        if ($flags['readOnly']) { (Get-Item -LiteralPath $dll).IsReadOnly = $true }
        if ($flags['temp']) { Write-Text $temp "an interrupted install`n" }
        if ($flags['unrelated']) { Write-Text $unrelated "another tool`n" }
    }
    $created = [bool]$flags['created']
    Write-Text (Join-Path $dataRoot 'plugins\setup.json') ((ConvertTo-Json1 ([ordered]@{format = 'ets2telemetry.plugin-setup'; version = 1
        games = [ordered]@{ets2 = [ordered]@{excluded = $false; manualRoot = $null}; ats = [ordered]@{excluded = $false; manualRoot = $null}}
        installs = @([ordered]@{game = $folder.game; root = $gameRoot; source = 'steam'; sha256 = (Get-Sha $table.contents.owned); appVersion = '0.1.0'; installedUtc = $utc
            createdPluginsDirectory = $created}); pending = @(); failures = @()})) + "`n")
    $temps = @(if ($flags['temp']) { $temp })
    $intent = '{"format":"ets2telemetry.uninstall-pending","version":1,"phase":"deferred","startedUtc":"' + $utc + '","attempts":' + $Attempts + ',"known":["' +
        (Get-Sha $table.contents.known) + '"],"folders":[{"game":"' + $folder.game + '","root":' + (ConvertTo-Json1 $gameRoot) + ',"hashes":["' + (Get-Sha $table.contents.owned) +
        '"],"temps":' + $(if ($temps.Count) { '[' + (ConvertTo-Json1 $temps[0]) + ']' } else { '[]' }) + ',"createdPluginsDirectory":' + $(if ($created) { 'true' } else { 'false' }) + '}]}'
    Write-Text (Join-Path $dataRoot 'uninstall\pending.json') ($intent + "`n")
    foreach ($entry in @(@('data', 'telemetry.sqlite'), @('settings', 'settings.json'), @('logs', 'startup.jsonl'))) {
        Write-Text (Join-Path $dataRoot ($entry[0] + '\' + $entry[1])) ('synthetic ' + $entry[0] + "`n")
    }
    $sentinel = Join-Path $root 'outside\sentinel.txt'
    $data = @{}; if ($Case.PSObject.Properties.Name -contains 'data') { foreach ($property in $Case.data.PSObject.Properties) { $data[$property.Name] = $property.Value } }
    if ($data['unknownEntry']) { Write-Text (Join-Path $dataRoot 'notes\mine.txt') "the user's own file`n" }
    if ($data['readOnlyEntry']) { $locked = Join-Path $dataRoot 'logs\locked.jsonl'; Write-Text $locked "read-only log`n"; (Get-Item -LiteralPath $locked).IsReadOnly = $true }
    if ($data['logsJunction']) { Write-Text $sentinel "outside the data root`n"; New-Item -ItemType Junction -Path (Join-Path $dataRoot 'logs\linked') -Target (Split-Path $sentinel) | Out-Null }
    Copy-Item -LiteralPath $executor -Destination (Join-Path $dataRoot 'uninstall\Complete-ETS2TelemetryUninstall.ps1')
    $command = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $dataRoot 'uninstall\Complete-ETS2TelemetryUninstall.ps1') + '"'
    return @{root = $root; base = $base; dataRoot = $dataRoot; dll = $dll; temp = $temp; plugins = $plugins; unrelated = $unrelated; sentinel = $sentinel; command = $command}
}

function Invoke-Executor($Scene, [string]$Running, [bool]$AsRunOnce) {
    # As Windows runs a RunOnce entry: the value is read and checked, deleted, then started. -TestRunningImages replaces
    # the real process list (the executor honors it only in a test root). TEMP points into the scene for the receipt.
    $value = Get-Value
    if ($value -cne $Scene.command) { throw ('Registered command differs: ' + $value) }
    if ($AsRunOnce) { Remove-Value }
    $match = [regex]::Match($value, '^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "([^"]+)"$')
    if (!$match.Success) { throw 'Registered command has an unexpected form.' }
    $start = New-Object Diagnostics.ProcessStartInfo($shell)
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $match.Groups[1].Value + '" -TestRunningImages ' + $Running
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.EnvironmentVariables['TEMP'] = Join-Path $Scene.root 'temp'; $start.EnvironmentVariables['TMP'] = Join-Path $Scene.root 'temp'
    $process = [Diagnostics.Process]::Start($start)
    try { if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'EXECUTOR_TIMEOUT' } ; $code = $process.ExitCode } finally { $process.Dispose() }
    $receipts = @(Get-ChildItem -LiteralPath (Join-Path $Scene.root 'temp') -Filter 'ETS2Telemetry-deferred-cleanup-*.json')
    if ($receipts.Count -ne 1) { throw ('Expected one receipt, found ' + $receipts.Count) }
    $text = [IO.File]::ReadAllText($receipts[0].FullName)
    if ($text -match '[A-Za-z]:\\\\' -or $text -match '\\\\\\\\') { throw 'The receipt names a path.' }
    Remove-Item -LiteralPath $receipts[0].FullName
    return @{exitCode = $code; receipt = ($text | ConvertFrom-Json)}
}
function Get-Names([string]$Directory) {
    # The entry names in ordinal order, as the TypeScript test sorts them; one array even for a single name.
    $names = [string[]]@(Get-ChildItem -LiteralPath $Directory -Force | ForEach-Object { $_.Name })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    return ,$names
}
function Get-DataRootEntries([string]$DataRoot) {
    if (!(Test-Path -LiteralPath $DataRoot)) { return $null }
    return ,(Get-Names $DataRoot)
}
function Get-Attempts([string]$DataRoot) { return ([IO.File]::ReadAllText((Join-Path $DataRoot 'uninstall\pending.json')) | ConvertFrom-Json).attempts }
function Assert-Equal($Expected, $Actual, [string]$What) {
    $left = ConvertTo-Json1 $Expected; $right = ConvertTo-Json1 $Actual
    if ($left -cne $right) { throw ($What + ': expected ' + $left + ', actual ' + $right) }
}

$rows = [Collections.Generic.List[object]]::new()
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
try {
    # The shared table, each case started as RunOnce starts it.
    $index = 0
    foreach ($case in $table.cases) {
        $index++
        $scene = New-Scene ('c' + $index) $case 1
        Set-Value $scene.command
        $running = if (@($case.running).Count) { @($case.running) -join ',' } else { 'none' }
        $run = Invoke-Executor $scene $running $true
        $expect = $case.expect
        $observed = [ordered]@{outcome = $run.receipt.outcome; code = $run.receipt.code; dll = (Get-State $scene.dll); dataRoot = (Get-DataRootEntries $scene.dataRoot)}
        $wanted = [ordered]@{outcome = $expect.outcome; code = $expect.code; dll = $expect.dll; dataRoot = $expect.dataRoot}
        foreach ($optional in @('temp', 'pluginsDirectory', 'unrelated', 'sentinel')) {
            if ($expect.PSObject.Properties.Name -contains $optional) {
                $wanted[$optional] = $expect.$optional
                $observed[$optional] = Get-State $(switch ($optional) { 'temp' { $scene.temp } 'pluginsDirectory' { $scene.plugins } 'unrelated' { $scene.unrelated } 'sentinel' { $scene.sentinel } })
            }
        }
        Assert-Equal $wanted $observed ('Case ' + $case.id)
        if ($expect.dll -eq 'present' -and $case.folder.dll -ne 'none' -and [IO.File]::ReadAllText($scene.dll) -cne $table.contents.($case.folder.dll)) { throw ('Case ' + $case.id + ': the kept file changed') }
        if ($expect.outcome -eq 'deferred') {
            # Blocked: the executor registered itself again with the same command and counted attempt 2.
            Assert-Equal $scene.command (Get-Value) ('Case ' + $case.id + ' registration')
            Assert-Equal 2 (Get-Attempts $scene.dataRoot) ('Case ' + $case.id + ' attempts')
            Assert-Equal @('Complete-ETS2TelemetryUninstall.ps1', 'README.txt', 'pending.json') (Get-Names (Join-Path $scene.dataRoot 'uninstall')) ('Case ' + $case.id + ' uninstall folder')
            if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('attempt 2 of 10')) { throw ('Case ' + $case.id + ': README without the attempt') }
            Assert-Equal @('registered', 3) @($run.receipt.runOnce, $run.exitCode) ('Case ' + $case.id + ' receipt')
        } else {
            if ($null -ne (Get-Value)) { throw ('Case ' + $case.id + ': the registration remains') }
            Assert-Equal @('removed', 0) @($run.receipt.runOnce, $run.exitCode) ('Case ' + $case.id + ' receipt')
        }
        Remove-Value
        $rows.Add([ordered]@{case = $case.id; outcome = $run.receipt.outcome; code = $run.receipt.code; passed = $true})
    }

    $owned = $table.cases | Where-Object { $_.id -eq 'owned-removed' } | Select-Object -First 1
    $blockedCase = $table.cases | Where-Object { $_.id -eq 'game-running' } | Select-Object -First 1

    # A complete run removes its own value even when it is still registered (a run that Windows did not start).
    $scene = New-Scene 'own' $owned 1
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $false
    Assert-Equal @('complete', 'removed', $null) @($run.receipt.outcome, $run.receipt.runOnce, (Get-Value)) 'own-value-removed'
    $rows.Add([ordered]@{case = 'own-value-removed'; passed = $true})

    # The 10th attempt: still blocked, so it stops, leaves README.txt and does not register again.
    $scene = New-Scene 'tenth' $blockedCase 9
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'eurotrucks2.exe' $true
    Assert-Equal @('stopped', 'GAME_RUNNING', 10, $null, 'present') @($run.receipt.outcome, $run.receipt.code, $run.receipt.attempts, (Get-Value), (Get-State $scene.dll)) 'tenth-attempt-stops'
    Assert-Equal 10 (Get-Attempts $scene.dataRoot) 'tenth-attempt-stops attempts'
    if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('stopped trying')) { throw 'tenth-attempt-stops: README without the stop' }
    $rows.Add([ordered]@{case = 'tenth-attempt-stops'; passed = $true})

    # The 9th attempt is still below the limit: it registers again and counts 9.
    $scene = New-Scene 'ninth' $blockedCase 8
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'eurotrucks2.exe' $true
    Assert-Equal @('deferred', 9, $scene.command) @($run.receipt.outcome, $run.receipt.attempts, (Get-Value)) 'ninth-attempt-registers'
    Remove-Value
    $rows.Add([ordered]@{case = 'ninth-attempt-registers'; passed = $true})

    # No intent: nothing is removed, the value goes.
    $scene = New-Scene 'nointent' $owned 1
    Remove-Item -LiteralPath (Join-Path $scene.dataRoot 'uninstall\pending.json')
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $false
    Assert-Equal @('not-needed', 'NO_INTENT', $null, 'present') @($run.receipt.outcome, $run.receipt.code, (Get-Value), (Get-State $scene.dll)) 'no-intent'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'no-intent data root'
    $rows.Add([ordered]@{case = 'no-intent'; passed = $true})

    # The application was installed again: nothing is removed.
    $scene = New-Scene 'installed' $owned 1
    Write-Text (Join-Path $scene.base 'ETS2TelemetryDesktop\app-0.1.0\ETS2TelemetryDesktop.exe') 'placeholder executable, never run'
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true
    Assert-Equal @('not-needed', 'APP_INSTALLED', 'present') @($run.receipt.outcome, $run.receipt.code, (Get-State $scene.dll)) 'application-installed'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'application-installed data root'
    $rows.Add([ordered]@{case = 'application-installed'; passed = $true})

    # An invalid intent is never trusted: nothing is removed and the script does not register again.
    $scene = New-Scene 'invalid' $owned 1
    Write-Text (Join-Path $scene.dataRoot 'uninstall\pending.json') '{"format":"ets2telemetry.uninstall-pending","version":1}'
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true
    Assert-Equal @('refused', 'INTENT_INVALID', $null, 'present') @($run.receipt.outcome, $run.receipt.code, (Get-Value), (Get-State $scene.dll)) 'invalid-intent'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'invalid-intent data root'
    $rows.Add([ordered]@{case = 'invalid-intent'; passed = $true})

    # Without the test root's marker the base must be the real known-folder LocalAppData; a temporary base is refused, and
    # neither the real nor the test RunOnce key is touched.
    $scene = New-Scene 'notest' $owned 1
    Remove-Item -LiteralPath (Join-Path $scene.root 'ets2telemetry-plugin-test-root.marker'), (Join-Path $scene.root 'ets2telemetry-install-test.json')
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $false
    Assert-Equal @('refused', 'ROOT_MISMATCH', $scene.command, 'present') @($run.receipt.outcome, $run.receipt.code, (Get-Value), (Get-State $scene.dll)) 'not-a-test-root'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'not-a-test-root data root'
    Remove-Value
    $rows.Add([ordered]@{case = 'not-a-test-root'; passed = $true})
} finally {
    # Read-only fixtures are made writable again so the scenes can be removed; then the scenes and this run's test key go.
    if (Test-Path -LiteralPath $WorkDirectory) {
        # Junctions are removed first and never entered; their targets lie in the work folder too.
        Get-ChildItem -LiteralPath $WorkDirectory -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { [IO.Directory]::Delete($_.FullName, $false) }
        Get-ChildItem -LiteralPath $WorkDirectory -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.IsReadOnly } | ForEach-Object { $_.IsReadOnly = $false }
        Remove-Item -LiteralPath $WorkDirectory -Recurse -Force
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKeyRoot, $false)
}
if ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKeyRoot)) { throw 'The test key remains.' }
Write-Output ('DEFERRED_CLEANUP_PASS ' + $rows.Count)
