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
#   plays through the TypeScript engine, and asserts the same outcome, code and kept or removed files, once in each build
#   channel (ET-055 UP12): every scene uses its channel's names, with the executor stamped for that channel as the build
#   stamps it (scripts/uninstall-executor.mjs), and the other channel's plugin file is never touched;
# - runs each case as Windows runs a RunOnce entry: the registered value is read, checked, deleted, then started; a
#   deferred case must register itself again with the same command and count attempt 2;
# - adds the executor's own cases: a complete run removes a value that is still there, the 10th attempt stops with
#   README.txt and no registration, and no intent, an installed application, an invalid intent or a folder outside a
#   test root change nothing, and neither does an executor of the other channel or the other channel's installation.
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
# Each channel's names (apps/desktop/src/channel.ts and the executor's own table); New-Scene selects the RunOnce value of
# the executor it copies.
$names = @{
    production = @{dataRoot = 'ETS2Telemetry'; valueName = 'ETS2TelemetryUninstall'; pluginFile = 'ets2telemetry-plugin.dll'; installRoot = 'ETS2TelemetryDesktop'
        executable = 'ETS2TelemetryDesktop.exe'; receiptPrefix = 'ETS2Telemetry-deferred-cleanup-'; other = 'staging'}
    staging = @{dataRoot = 'ETS2TelemetryStaging'; valueName = 'ETS2TelemetryStagingUninstall'; pluginFile = 'ets2telemetry-plugin-staging.dll'; installRoot = 'ETS2TelemetryDesktopStaging'
        executable = 'ETS2TelemetryDesktopStaging.exe'; receiptPrefix = 'ETS2TelemetryStaging-deferred-cleanup-'; other = 'production'}
}
$valueName = $names.production.valueName
$utf8 = New-Object Text.UTF8Encoding($false)
$utc = '2026-10-18T09:00:00.000Z'
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
function Get-ExecutorCopy([string]$Channel) {
    # The executor as the build packages it for $Channel: the tracked script with its single $Channel line stamped.
    $file = Join-Path $WorkDirectory ('executor-' + $Channel + '.ps1')
    if (!(Test-Path -LiteralPath $file)) {
        $text = [IO.File]::ReadAllText($executor)
        $pattern = '(?m)^\$Channel = ''production''(?=\r?$)'
        if ([regex]::Matches($text, $pattern).Count -ne 1) { throw 'The executor has no single $Channel line.' }
        [IO.File]::WriteAllText($file, [regex]::Replace($text, $pattern, ('$$Channel = ''' + $Channel + '''')), $utf8)
    }
    return $file
}

function New-Scene([string]$Name, $Case, [int]$Attempts, [string]$Parent = $WorkDirectory, [string]$Channel = 'production', [string]$ExecutorChannel = $Channel) {
    # The same scene as uninstall-deferred-cases.test.ts: R with the marker and the test file, the data root, the game folder.
    # $Channel names the data root and the plugin; $ExecutorChannel the executor copied into it and its RunOnce value.
    $n = $names[$Channel]
    $script:valueName = $names[$ExecutorChannel].valueName
    $tempName = $n.pluginFile + '.00112233445566aa.tmp'
    $root = Join-Path $Parent $Name
    $base = Join-Path $root 'LocalAppData'; $dataRoot = Join-Path $base $n.dataRoot
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
    $dll = Join-Path $dllDirectory $n.pluginFile; $temp = Join-Path $plugins $tempName; $unrelated = Join-Path $plugins 'other-plugin.dll'
    $otherDll = Join-Path $plugins $names[$n.other].pluginFile
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
        # The other channel's plugin, with a hash this channel installed: still never this channel's file to remove.
        if ($flags['otherChannel']) { Write-Text $otherDll $table.contents.owned }
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
    Copy-Item -LiteralPath (Get-ExecutorCopy $ExecutorChannel) -Destination (Join-Path $dataRoot 'uninstall\Complete-ETS2TelemetryUninstall.ps1')
    return @{root = $root; base = $base; dataRoot = $dataRoot; dll = $dll; temp = $temp; plugins = $plugins; unrelated = $unrelated; sentinel = $sentinel
        otherDll = $otherDll; receiptPrefix = $names[$ExecutorChannel].receiptPrefix; channel = $Channel; command = (Get-ExpectedCommand $dataRoot)}
}
function Get-ExpectedCommand([string]$DataRoot) {
    # executorCommand in executor.ts, written out by hand: the absolute, quoted powershell.exe while the command fits 260
    # characters, otherwise the PATH form.
    $script = '"' + (Join-Path $DataRoot 'uninstall\Complete-ETS2TelemetryUninstall.ps1') + '"'
    $absolute = '"' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $script
    if ($absolute.Length -le 260) { return $absolute }
    return 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $script
}

function Invoke-Executor($Scene, [string]$Running, [bool]$AsRunOnce, [string]$Extra = '') {
    # As Windows runs a RunOnce entry: the value is read and checked, deleted, then started. -TestRunningImages replaces
    # the real process list (the executor honors it only in a test root). TEMP points into the scene for the receipt.
    $value = Get-Value
    if ($value -cne $Scene.command) { throw ('Registered command differs: ' + $value) }
    if ($AsRunOnce) { Remove-Value }
    $match = [regex]::Match($value, '^(?:"[A-Za-z]:\\[^"]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"|powershell\.exe) -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "([^"]+)"$')
    if (!$match.Success) { throw 'Registered command has an unexpected form.' }
    $start = New-Object Diagnostics.ProcessStartInfo($shell)
    $start.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $match.Groups[1].Value + '" -TestRunningImages ' + $Running + $Extra
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $start.EnvironmentVariables['TEMP'] = Join-Path $Scene.root 'temp'; $start.EnvironmentVariables['TMP'] = Join-Path $Scene.root 'temp'
    $process = [Diagnostics.Process]::Start($start)
    try { if (!$process.WaitForExit(60000)) { $process.Kill(); throw 'EXECUTOR_TIMEOUT' } ; $code = $process.ExitCode } finally { $process.Dispose() }
    $receipts = @(Get-ChildItem -LiteralPath (Join-Path $Scene.root 'temp') -Filter ($Scene.receiptPrefix + '*.json'))
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
$shortRoot = $null
New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
# The real Roaming userData of this user is only looked at, never changed: a test root must not touch it (O7, review of
# PR #123). Its existence and modification time are compared at the end.
$realRoaming = @('ETS2Telemetry Desktop', 'ETS2Telemetry Desktop Staging' | ForEach-Object { Join-Path ([Environment]::GetFolderPath('ApplicationData')) $_ })
function Get-RealRoamingState {
    return (@($realRoaming | ForEach-Object { if (Test-Path -LiteralPath $_) { 'present ' + (Get-Item -LiteralPath $_ -Force).LastWriteTimeUtc.Ticks } else { 'absent' } }) -join '; ')
}
$realRoamingBefore = Get-RealRoamingState
try {
    # The shared table, each case started as RunOnce starts it, in each channel.
    foreach ($channel in @('production', 'staging')) {
    $index = 0
    foreach ($case in $table.cases) {
        $index++
        $scene = New-Scene ($channel.Substring(0, 1) + $index) $case 1 $WorkDirectory $channel
        Set-Value $scene.command
        $running = if (@($case.running).Count) { @($case.running) -join ',' } else { 'none' }
        # `lateEntry`: the script creates that allowlisted entry after the registry step (test root only), as the TypeScript
        # test's file system does.
        $late = if ($case.PSObject.Properties.Name -contains 'data' -and $case.data.PSObject.Properties.Name -contains 'lateEntry') { ' -TestLateEntry ' + $case.data.lateEntry } else { '' }
        $run = Invoke-Executor $scene $running $true $late
        $expect = $case.expect
        $observed = [ordered]@{outcome = $run.receipt.outcome; code = $run.receipt.code; dll = (Get-State $scene.dll); dataRoot = (Get-DataRootEntries $scene.dataRoot)}
        $wanted = [ordered]@{outcome = $expect.outcome; code = $expect.code; dll = $expect.dll; dataRoot = $expect.dataRoot}
        foreach ($optional in @('temp', 'pluginsDirectory', 'unrelated', 'sentinel', 'otherChannelDll')) {
            if ($expect.PSObject.Properties.Name -contains $optional) {
                $wanted[$optional] = $expect.$optional
                $observed[$optional] = Get-State $(switch ($optional) { 'temp' { $scene.temp } 'pluginsDirectory' { $scene.plugins } 'unrelated' { $scene.unrelated } 'sentinel' { $scene.sentinel } 'otherChannelDll' { $scene.otherDll } })
            }
        }
        Assert-Equal $wanted $observed ('Case ' + $channel + ' ' + $case.id)
        if ($case.folder.PSObject.Properties.Name -contains 'otherChannel' -and [IO.File]::ReadAllText($scene.otherDll) -cne $table.contents.owned) { throw ('Case ' + $case.id + ': the other channel''s plugin changed') }
        if ($expect.dll -eq 'present' -and $case.folder.dll -ne 'none' -and [IO.File]::ReadAllText($scene.dll) -cne $table.contents.($case.folder.dll)) { throw ('Case ' + $case.id + ': the kept file changed') }
        if ($expect.outcome -eq 'deferred') {
            # Blocked: the executor registered itself again with the same command and counted attempt 2.
            Assert-Equal $scene.command (Get-Value) ('Case ' + $case.id + ' registration')
            Assert-Equal 2 (Get-Attempts $scene.dataRoot) ('Case ' + $case.id + ' attempts')
            Assert-Equal @('Complete-ETS2TelemetryUninstall.ps1', 'README.txt', 'pending.json') (Get-Names (Join-Path $scene.dataRoot 'uninstall')) ('Case ' + $case.id + ' uninstall folder')
            if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('attempt 2 of 10')) { throw ('Case ' + $case.id + ': README without the attempt') }
            Assert-Equal @('registered', 3, 'not-run') @($run.receipt.runOnce, $run.exitCode, $run.receipt.roaming) ('Case ' + $case.id + ' receipt')
        } else {
            if ($null -ne (Get-Value)) { throw ('Case ' + $case.id + ': the registration remains') }
            # A complete run in a test root without a stand-in Roaming folder touches none.
            Assert-Equal @('removed', 0, 'not-applicable') @($run.receipt.runOnce, $run.exitCode, $run.receipt.roaming) ('Case ' + $case.id + ' receipt')
        }
        Remove-Value
        $rows.Add([ordered]@{case = $case.id; channel = $channel; outcome = $run.receipt.outcome; code = $run.receipt.code; passed = $true})
    }
    }
    $script:valueName = $names.production.valueName

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

    # The application was installed again: nothing is removed. In each channel only its own installation counts: the other
    # channel's install root beside it does not stop the cleanup (ET-055 UP14).
    foreach ($channel in @('production', 'staging')) {
        $n = $names[$channel]; $other = $names[$n.other]
        $scene = New-Scene ('installed-' + $channel) $owned 1 $WorkDirectory $channel
        Write-Text (Join-Path $scene.base ($n.installRoot + '\app-0.1.0\' + $n.executable)) 'placeholder executable, never run'
        $before = Get-DataRootEntries $scene.dataRoot
        Set-Value $scene.command
        $run = Invoke-Executor $scene 'none' $true
        Assert-Equal @('not-needed', 'APP_INSTALLED', 'present') @($run.receipt.outcome, $run.receipt.code, (Get-State $scene.dll)) ('application-installed ' + $channel)
        Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) ('application-installed data root ' + $channel)
        $rows.Add([ordered]@{case = 'application-installed'; channel = $channel; passed = $true})

        $scene = New-Scene ('other-installed-' + $channel) $owned 1 $WorkDirectory $channel
        $otherExecutable = Join-Path $scene.base ($other.installRoot + '\app-0.1.0\' + $other.executable)
        Write-Text $otherExecutable 'placeholder executable, never run'
        Set-Value $scene.command
        $run = Invoke-Executor $scene 'none' $true
        Assert-Equal @('complete', $null, 'absent', 'present') @($run.receipt.outcome, $run.receipt.code, (Get-State $scene.dll), (Get-State $otherExecutable)) ('other-channel-installed ' + $channel)
        $rows.Add([ordered]@{case = 'other-channel-installed'; channel = $channel; passed = $true})

        # An executor of the other channel in this channel's data root refuses (its own data root name differs): nothing
        # is removed and the registration it was started from stays for its owner to replace.
        $scene = New-Scene ('foreign-executor-' + $channel) $owned 1 $WorkDirectory $channel $n.other
        $before = Get-DataRootEntries $scene.dataRoot
        Set-Value $scene.command
        $run = Invoke-Executor $scene 'none' $false
        Assert-Equal @('refused', 'LAYOUT_INVALID', 4, $scene.command, 'present') @($run.receipt.outcome, $run.receipt.code, $run.exitCode, (Get-Value), (Get-State $scene.dll)) ('other-channel-executor ' + $channel)
        Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) ('other-channel-executor data root ' + $channel)
        Remove-Value
        $rows.Add([ordered]@{case = 'other-channel-executor'; channel = $channel; passed = $true})
    }
    $script:valueName = $names.production.valueName

    # An invalid intent is never trusted: nothing is removed and the script does not register again.
    $scene = New-Scene 'invalid' $owned 1
    Write-Text (Join-Path $scene.dataRoot 'uninstall\pending.json') '{"format":"ets2telemetry.uninstall-pending","version":1}'
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true
    Assert-Equal @('refused', 'INTENT_INVALID', $null, 'present') @($run.receipt.outcome, $run.receipt.code, (Get-Value), (Get-State $scene.dll)) 'invalid-intent'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'invalid-intent data root'
    if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('does not run again')) { throw 'invalid-intent: README without the stop' }
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

    # An unexpected error before the attempt is counted and registered: nothing runs again and nothing is removed, and
    # README.txt says the cleanup stopped (review of PR-5).
    $scene = New-Scene 'fault1' $owned 1
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true ' -TestFailAt start'
    Assert-Equal @('refused', 'EXECUTOR_FAILED', 4, $null, 'present', 1, $true) @($run.receipt.outcome, $run.receipt.code, $run.exitCode, (Get-Value), (Get-State $scene.dll),
        (Get-Attempts $scene.dataRoot), $run.receipt.readme) 'fault-before-registration'
    if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('does not run again')) { throw 'fault-before-registration: README without the stop' }
    $rows.Add([ordered]@{case = 'fault-before-registration'; passed = $true})

    # An unexpected error right after: the attempt is counted and the script registered again, so the next sign-in tries
    # again, and README.txt says so.
    $scene = New-Scene 'fault2' $owned 1
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true ' -TestFailAt registered'
    Assert-Equal @('refused', 'EXECUTOR_FAILED', $scene.command, 'present', 2, $true) @($run.receipt.outcome, $run.receipt.code, (Get-Value), (Get-State $scene.dll),
        (Get-Attempts $scene.dataRoot), $run.receipt.readme) 'fault-after-registration'
    if (![IO.File]::ReadAllText((Join-Path $scene.dataRoot 'uninstall\README.txt')).Contains('tries again at your next Windows sign-in (attempt 2 of 10')) { throw 'fault-after-registration: README without the retry' }
    # The next sign-in, with nothing in the way, completes.
    $run = Invoke-Executor $scene 'none' $true
    Assert-Equal @('complete', 3, $null, 'absent') @($run.receipt.outcome, $run.receipt.attempts, (Get-Value), (Get-State $scene.dataRoot)) 'fault-after-registration retry'
    $rows.Add([ordered]@{case = 'fault-after-registration'; passed = $true})

    # The intent's 128 KiB bound (review of PR-5): an intent just below it and an install registry with 16 more folders,
    # all blocked. The rewrite keeps every folder of the intent and drops the registry's from the end, so the next
    # sign-in still reads it.
    $scene = New-Scene 'bound' $blockedCase 1
    $games = Join-Path $scene.root 'G'
    $pad = 184 - $games.Length - 5
    $rootOf = { param([string]$Prefix, [int]$Index) Join-Path $games ($Prefix + $Index.ToString('00') + '-' + ('x' * $pad)) }
    $tempOf = { param([string]$Root, [string]$Seed) Join-Path $Root ('bin\win_x64\plugins\ets2telemetry-plugin.dll.' + (Get-Sha $Seed).Substring(0, 16) + '.tmp') }
    $document = [ordered]@{format = 'ets2telemetry.uninstall-pending'; version = 1; phase = 'deferred'; startedUtc = $utc; attempts = 1; known = @(Get-Sha $table.contents.known)
        folders = [Collections.Generic.List[object]]::new()}
    $limit = 131072 - 50
    for ($index = 0; $index -lt 31; $index++) {
        $root = & $rootOf 'o' $index
        $hashes = @(0..16 | ForEach-Object { Get-Sha ('own-' + $index + '-' + $_) })
        $temps = [Collections.Generic.List[string]]::new(); foreach ($slot in 0..15) { $temps.Add((& $tempOf $root ('t-' + $index + '-' + $slot))) }
        $folder = [ordered]@{game = 'ets2'; root = $root; hashes = $hashes; temps = $temps; createdPluginsDirectory = $false}
        $document.folders.Add($folder)
        while ($utf8.GetByteCount((ConvertTo-Json1 $document)) -gt $limit -and $temps.Count) { $temps.RemoveAt($temps.Count - 1) }
        if ($utf8.GetByteCount((ConvertTo-Json1 $document)) -gt $limit) { $document.folders.RemoveAt($document.folders.Count - 1); break }
        if ($temps.Count -lt 16) { break }
    }
    $own = $document.folders.Count
    Write-Text (Join-Path $scene.dataRoot 'uninstall\pending.json') ((ConvertTo-Json1 $document) + "`n")
    $installs = @(0..15 | ForEach-Object { [ordered]@{game = 'ets2'; root = (& $rootOf 'r' $_); source = 'steam'; sha256 = (Get-Sha ('reg-' + $_)); appVersion = '0.1.0'
        installedUtc = $utc; createdPluginsDirectory = $false} })
    $pending = @(0..15 | ForEach-Object { $root = & $rootOf 'r' $_; [ordered]@{op = 'install'; game = 'ets2'; root = $root; source = 'steam'; temp = (& $tempOf $root ('rt-' + $_))
        fromSha256 = $null; toSha256 = (Get-Sha ('regto-' + $_)); appVersion = '0.1.0'; createdPluginsDirectory = $false; startedUtc = $utc} })
    Write-Text (Join-Path $scene.dataRoot 'plugins\setup.json') ((ConvertTo-Json1 ([ordered]@{format = 'ets2telemetry.plugin-setup'; version = 1
        games = [ordered]@{ets2 = [ordered]@{excluded = $false; manualRoot = $null}; ats = [ordered]@{excluded = $false; manualRoot = $null}}
        installs = $installs; pending = $pending; failures = @()})) + "`n")
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'eurotrucks2.exe' $true
    $intentFile = Join-Path $scene.dataRoot 'uninstall\pending.json'
    $rewritten = [IO.File]::ReadAllText($intentFile) | ConvertFrom-Json
    $ownKept = @($rewritten.folders | Where-Object { [IO.Path]::GetFileName($_.root).StartsWith('o') }).Count
    Assert-Equal @('deferred', 2, $true, $own, $true) @($run.receipt.outcome, $rewritten.attempts, ((Get-Item -LiteralPath $intentFile).Length -le 131072), $ownKept,
        (@($rewritten.folders).Count -lt [Math]::Min(32, $own + 16))) 'intent-bound'
    $run = Invoke-Executor $scene 'eurotrucks2.exe' $true
    Assert-Equal @('deferred', 'GAME_RUNNING', 3) @($run.receipt.outcome, $run.receipt.code, $run.receipt.attempts) 'intent-bound next sign-in'
    Remove-Value
    $rows.Add([ordered]@{case = 'intent-bound'; own = $own; passed = $true})

    # The absolute powershell.exe form, in a scene short enough for it: the temporary folder's paths are too long for
    # that form within 260 characters, so this scene lives in a fresh folder at the system drive's root.
    $shortRoot = Join-Path ($env:SystemDrive + '\') ('etd' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $shortRoot | Out-Null
    $scene = New-Scene 'a' $blockedCase 1 $shortRoot
    if (!$scene.command.StartsWith('"' + $env:SystemRoot + '\System32\WindowsPowerShell\v1.0\powershell.exe" ', [StringComparison]::Ordinal)) { throw 'absolute-form: the scene path is too long' }
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'eurotrucks2.exe' $true
    Assert-Equal @('deferred', 'registered', $scene.command) @($run.receipt.outcome, $run.receipt.runOnce, (Get-Value)) 'absolute-form'
    Remove-Value
    $rows.Add([ordered]@{case = 'absolute-form'; passed = $true})

    # O7 at the next sign-in (review of PR #123): a complete production run removes Electron's Roaming userData. A test
    # root proves the removal on a stand-in inside it: the folder goes, a junction inside it and a junction as the folder
    # itself are removed, never entered, and their targets stay.
    $scene = New-Scene 'roam' $owned 1
    $stand = Join-Path $scene.root 'Roaming\ETS2Telemetry Desktop'
    Write-Text (Join-Path $stand 'Local State') "{}`n"
    Write-Text (Join-Path $stand 'Cache\data_0') "cache`n"
    $outside = Join-Path $scene.root 'outside-roaming'
    Write-Text (Join-Path $outside 'sentinel.txt') "outside the Roaming folder`n"
    New-Item -ItemType Junction -Path (Join-Path $stand 'linked') -Target $outside | Out-Null
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true (' -TestRoamingFolder "' + $stand + '"')
    Assert-Equal @('complete', 'removed', 'absent', 'present') @($run.receipt.outcome, $run.receipt.roaming, (Get-State $stand), (Get-State (Join-Path $outside 'sentinel.txt'))) 'roaming-stand-in'
    $rows.Add([ordered]@{case = 'roaming-stand-in'; passed = $true})

    $scene = New-Scene 'roamlink' $owned 1
    $stand = Join-Path $scene.root 'Roaming\ETS2Telemetry Desktop'
    $outside = Join-Path $scene.root 'outside-roaming'
    Write-Text (Join-Path $outside 'sentinel.txt') "outside the Roaming folder`n"
    New-Item -ItemType Directory -Path (Split-Path $stand) | Out-Null
    New-Item -ItemType Junction -Path $stand -Target $outside | Out-Null
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true (' -TestRoamingFolder "' + $stand + '"')
    Assert-Equal @('complete', 'removed', 'absent', 'present') @($run.receipt.outcome, $run.receipt.roaming, (Get-State $stand), (Get-State (Join-Path $outside 'sentinel.txt'))) 'roaming-junction'
    $rows.Add([ordered]@{case = 'roaming-junction'; passed = $true})

    $scene = New-Scene 'roamnone' $owned 1
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true (' -TestRoamingFolder "' + (Join-Path $scene.root 'Roaming\ETS2Telemetry Desktop') + '"')
    Assert-Equal @('complete', 'absent') @($run.receipt.outcome, $run.receipt.roaming) 'roaming-absent'
    $rows.Add([ordered]@{case = 'roaming-absent'; passed = $true})

    # A stand-in outside the test root (here a folder beside it in the work folder) is refused, and nothing changes.
    $scene = New-Scene 'roamout' $owned 1
    $beside = Join-Path $WorkDirectory 'beside\ETS2Telemetry Desktop'
    Write-Text (Join-Path $beside 'Local State') "{}`n"
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true (' -TestRoamingFolder "' + $beside + '"')
    Assert-Equal @('refused', 'TEST_PARAMETER_REFUSED', 'not-run', 'present', 'present') @($run.receipt.outcome, $run.receipt.code, $run.receipt.roaming, (Get-State $beside),
        (Get-State $scene.dll)) 'roaming-outside-refused'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'roaming-outside-refused data root'
    $rows.Add([ordered]@{case = 'roaming-outside-refused'; passed = $true})

    # A stand-in spelled inside the test root but reached through a junction that leads out of it is refused as well
    # (delta review of PR #123): nothing is emptied behind the junction.
    $scene = New-Scene 'roamj' $owned 1
    $target = Join-Path $WorkDirectory 'roamj-target'
    Write-Text (Join-Path $target 'ETS2Telemetry Desktop\Local State') "{}`n"
    New-Item -ItemType Junction -Path (Join-Path $scene.root 'j') -Target $target | Out-Null
    $before = Get-DataRootEntries $scene.dataRoot
    Set-Value $scene.command
    $run = Invoke-Executor $scene 'none' $true (' -TestRoamingFolder "' + (Join-Path $scene.root 'j\ETS2Telemetry Desktop') + '"')
    Assert-Equal @('refused', 'TEST_PARAMETER_REFUSED', 'not-run', 'present', 'present') @($run.receipt.outcome, $run.receipt.code, $run.receipt.roaming,
        (Get-State (Join-Path $target 'ETS2Telemetry Desktop\Local State')), (Get-State $scene.dll)) 'roaming-junction-outside-refused'
    Assert-Equal $before (Get-DataRootEntries $scene.dataRoot) 'roaming-junction-outside-refused data root'
    $rows.Add([ordered]@{case = 'roaming-junction-outside-refused'; passed = $true})
} finally {
    # Read-only fixtures are made writable again so the scenes can be removed; then the scenes and this run's test key go.
    foreach ($folder in @($WorkDirectory, $shortRoot)) {
        if (!$folder -or !(Test-Path -LiteralPath $folder)) { continue }
        # Junctions are removed first and never entered; their targets lie in the same folder too.
        Get-ChildItem -LiteralPath $folder -Recurse -Force -Directory -Attributes ReparsePoint -ErrorAction SilentlyContinue | ForEach-Object { [IO.Directory]::Delete($_.FullName, $false) }
        Get-ChildItem -LiteralPath $folder -Recurse -Force -File -ErrorAction SilentlyContinue | Where-Object { $_.IsReadOnly } | ForEach-Object { $_.IsReadOnly = $false }
        Remove-Item -LiteralPath $folder -Recurse -Force
    }
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKeyRoot, $false)
}
if ($null -ne [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKeyRoot)) { throw 'The test key remains.' }
if ((Get-RealRoamingState) -cne $realRoamingBefore) { throw 'The real Roaming userData changed.' }
Write-Output ('DEFERRED_CLEANUP_PASS ' + $rows.Count)
