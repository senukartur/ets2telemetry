[CmdletBinding()]
param(
    # Test root only: a comma-separated list of the image names the running-game check sees instead of the real process
    # list ('none' for an empty list), so tests never depend on what runs on the machine. A production run refuses it.
    [string]$TestRunningImages,
    # Test root only: an unexpected error at the step 'start' (before the attempt is counted and registered) or
    # 'registered' (right after), to prove what an error leaves behind. A production run refuses it.
    [ValidateSet('start', 'registered')][string]$TestFailAt,
    # Test root only: an allowlisted entry that appears after the registry step, as a writer would leave it, so the shared
    # case table can check that the last step removes it. A production run refuses it.
    [ValidateSet('data', 'backups', 'settings', 'logs', 'synthetic', 'captures', 'transport')][string]$TestLateEntry,
    # Test root only: a folder inside the test root that stands in for Electron's Roaming userData, so the removal a
    # production run makes can be tested; without it a test root never removes anything there. A production run refuses it.
    [string]$TestRoamingFolder
)
# The deferred-cleanup executor of an ETS2Telemetry uninstall (ET-018 PR-5; plan U7, owner decision O3; docs/uninstall.md,
# "Deferred cleanup at the next sign-in"). When the uninstall could not finish (a game or TruckersMP ran, a file was
# locked), the uninstall copied this script into <data root>\uninstall\ and registered it under HKCU RunOnce before it
# deleted anything. Windows runs it once at the next sign-in, after removing the RunOnce value. It runs the uninstall
# contract again from uninstall\pending.json, with the same rules as the application's engine
# (apps/desktop/src/uninstall/), which tests/fixtures/uninstall/deferred-cases.json checks for both:
#
# - The folders come from the script's own location: <base>\ETS2Telemetry\uninstall. A test root (the base is named
#   LocalAppData and its parent holds the ET-017 marker and a valid ets2telemetry-install-test.json) uses only the RunOnce
#   key that test file names; production requires the base to be the known-folder LocalAppData. Anything else changes
#   nothing.
# - Nothing is cleaned without a valid intent. The intent counts attempts: right after it is read, it is rewritten with
#   attempt + 1 and, while fewer than 10 attempts were made, the script registers itself again, before anything else.
#   An unexpected error after that is retried at the next sign-in; an error before it stops the cleanup, and README.txt
#   says so.
# - Nothing is cleaned while the application is installed again (its executable exists).
# - While neither the game nor a TruckersMP client runs, a folder's plugin is removed only while its SHA-256 is a hash this
#   application installed; an unrecognized, read-only or linked file stays. A temporary file of the installer and a
#   plugins folder this application created and left empty go too.
# - Only the allowlisted top-level entries of the data root are removed, never through a link, never clearing a
#   read-only attribute; plugins\ and uninstall\ go last, and only when every folder is clean, then the empty root.
# - A complete run removes the RunOnce value. A run still blocked after the 10th attempt stops, removes it and leaves
#   README.txt with the manual steps. The intent it rewrites stays within 32 folders and 128 KiB.
# - A complete production run also removes Electron's Roaming userData %APPDATA%\ETS2Telemetry Desktop, best effort (O7).
# - One receipt with fixed codes and counts, never a path, goes to %TEMP%; a production run shows one summary message box.
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$ExecutorName = 'Complete-ETS2TelemetryUninstall.ps1'
$ValueName = 'ETS2TelemetryUninstall'
$ProductionSubKey = 'Software\Microsoft\Windows\CurrentVersion\RunOnce'
$TestKeyPattern = '^HKCU\\Software\\ETS2Telemetry-Test-[0-9a-f]{32}\\RunOnce$'
$MaxAttempts = 10
$MaxCommand = 260
$Allowlist = @('data', 'backups', 'settings', 'logs', 'synthetic', 'plugins', 'captures', 'transport', 'uninstall')
$HashPattern = '^[0-9a-f]{64}$'
$TempPattern = '^ets2telemetry-plugin\.dll\.[0-9a-f]{16}\.tmp$'
$UtcPattern = '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
$PluginFile = 'ets2telemetry-plugin.dll'
$GameExecutables = @{ets2 = 'eurotrucks2.exe'; ats = 'amtrucks.exe'}
$RetryDelays = @(20, 40, 60, 80, 100)
$Utf8 = New-Object Text.UTF8Encoding($false)
$Clock = [Diagnostics.Stopwatch]::StartNew()

$Result = [ordered]@{
    format = 'ets2telemetry.deferred-cleanup-receipt'; version = 1; createdUtc = $null; mode = $null; outcome = 'refused'; code = $null; attempts = $null
    plugins = [ordered]@{removed = 0; absent = 0; unrecognized = 0; notes = @(); blocked = @()}
    data = [ordered]@{removed = 0; kept = 0; failed = @(); rootRemoved = $false}
    roaming = 'not-run'; runOnce = 'not-run'; readme = $false; messageBox = 'not-shown'; elapsedMs = 0
}

# --- Small helpers --------------------------------------------------------------------------------------------------

function Get-InnerException($ErrorRecord) {
    $exception = $ErrorRecord.Exception
    while ($exception -is [Management.Automation.MethodInvocationException] -and $null -ne $exception.InnerException) { $exception = $exception.InnerException }
    return $exception
}
function Get-ErrorKind($ErrorRecord) {
    # missing (ENOENT), locked (a sharing or lock violation: EBUSY), denied (EPERM/EACCES) or io.
    $exception = Get-InnerException $ErrorRecord
    if ($exception -is [IO.FileNotFoundException] -or $exception -is [IO.DirectoryNotFoundException]) { return 'missing' }
    if ($exception -is [UnauthorizedAccessException]) { return 'denied' }
    $code = $exception.HResult -band 0xFFFF
    if ($code -eq 2 -or $code -eq 3) { return 'missing' }
    if ($code -eq 32 -or $code -eq 33) { return 'locked' }
    if ($code -eq 5) { return 'denied' }
    return 'io'
}
function Get-BlockReason([string]$Kind, [string]$Context) {
    # blockReasonFor in plugin-installer.ts: reading or replacing the target maps a sharing lock to TARGET_LOCKED, and
    # replacing it maps a denied delete (a mapped DLL) to TARGET_LOCKED as well.
    if ($Kind -eq 'locked' -and $Context -ne 'default') { return 'TARGET_LOCKED' }
    if ($Kind -eq 'denied' -and $Context -eq 'target-replace') { return 'TARGET_LOCKED' }
    if ($Kind -eq 'denied') { return 'PERMISSION_DENIED' }
    return 'IO_ERROR'
}
function Get-WipeFailure([string]$Kind) {
    if ($Kind -eq 'locked') { return 'TARGET_LOCKED' }
    if ($Kind -eq 'denied') { return 'PERMISSION_DENIED' }
    return 'IO_ERROR'
}
function Get-Kind([string]$Path) {
    # The entry itself, never following a link: missing, link (a symbolic link or junction), directory, file or error.
    try { $attributes = [IO.File]::GetAttributes($Path) } catch {
        if ((Get-ErrorKind $_) -eq 'missing') { return 'missing' }
        return 'error'
    }
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) { return 'link' }
    if ($attributes -band [IO.FileAttributes]::Directory) { return 'directory' }
    return 'file'
}
function Get-FollowedKind([string]$Path) {
    # The entry with a final link followed: directory, other or missing (a link to a missing target is missing).
    $kind = Get-Kind $Path
    if ($kind -eq 'directory') { return 'directory' }
    if ($kind -eq 'file') { return 'other' }
    if ($kind -eq 'link') {
        if ([IO.Directory]::Exists($Path)) { return 'directory' }
        if ([IO.File]::Exists($Path)) { return 'other' }
        return 'missing'
    }
    return $kind
}
function Get-Normal([string]$Path) { return $Path.TrimEnd('\').ToLowerInvariant() }
function Test-SamePath([string]$Left, [string]$Right) { return (Get-Normal $Left) -ceq (Get-Normal $Right) }
function Test-Inside([string]$Child, [string]$Parent) { return (Get-Normal $Child).StartsWith((Get-Normal $Parent) + '\', [StringComparison]::Ordinal) }
function Test-DrivePath($Value) {
    if ($Value -isnot [string] -or $Value.Length -lt 3 -or $Value.Length -gt 4096) { return $false }
    if ($Value -notmatch '^[A-Za-z]:\\' -or $Value.Substring(2) -match '[:*?"<>|\x00-\x1f]' -or $Value -match '^[A-Za-z]:\\*$') { return $false }
    try { return [IO.Path]::GetFullPath($Value) -ceq $Value } catch { return $false }
}
function Get-PluginsDirectory([string]$Root) { return [IO.Path]::Combine($Root, 'bin', 'win_x64', 'plugins') }
function Get-PropertyNames($Value) { return @($Value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object) -join ',' }
function Test-Object($Value) { return $Value -is [Management.Automation.PSCustomObject] }
function Test-Hash($Value) { return $Value -is [string] -and $Value -cmatch $HashPattern }

function Write-AtomicText([string]$Directory, [string]$Name, [string]$Text) {
    # A synced temporary file of the application's own pattern (<name>.<pid>.<uuid>.tmp), then a replace or a move.
    $target = Join-Path $Directory $Name
    $temporary = Join-Path $Directory ($Name + '.' + $PID + '.' + [guid]::NewGuid().ToString() + '.tmp')
    $bytes = $Utf8.GetBytes($Text)
    $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    try {
        if ((Get-Kind $target) -eq 'file') { [IO.File]::Replace($temporary, $target, [NullString]::Value) } else { [IO.File]::Move($temporary, $target) }
    } catch {
        [IO.File]::Delete($temporary)
        throw
    }
}
function ConvertTo-JsonText($Value) {
    # A small JSON writer: Windows PowerShell 5.1's ConvertTo-Json unwraps one-element arrays in some positions.
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long]) { return [string]$Value }
    if ($Value -is [string]) {
        $builder = New-Object Text.StringBuilder
        [void]$builder.Append('"')
        foreach ($character in $Value.ToCharArray()) {
            $code = [int]$character
            if ($character -eq '"') { [void]$builder.Append('\"') }
            elseif ($character -eq '\') { [void]$builder.Append('\\') }
            # Only control characters are escaped, as JSON.stringify does, so a rewritten intent is never longer in UTF-8
            # than the application's own two-space document of the same content.
            elseif ($code -lt 32) { [void]$builder.Append('\u' + $code.ToString('x4')) }
            else { [void]$builder.Append($character) }
        }
        [void]$builder.Append('"')
        return $builder.ToString()
    }
    if ($Value -is [Collections.IDictionary]) {
        $parts = @(foreach ($key in $Value.Keys) { (ConvertTo-JsonText ([string]$key)) + ':' + (ConvertTo-JsonText $Value[$key]) })
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [Collections.IEnumerable]) {
        $parts = @(foreach ($item in $Value) { ConvertTo-JsonText $item })
        return '[' + ($parts -join ',') + ']'
    }
    throw 'JSON_VALUE_UNSUPPORTED'
}

# --- Roots and mode -------------------------------------------------------------------------------------------------

function Resolve-Roots {
    # <base>\ETS2Telemetry\uninstall\<this script>; no link anywhere in base, data root or uninstall folder.
    $uninstall = [IO.Path]::GetFullPath($PSScriptRoot)
    $dataRoot = [IO.Path]::GetDirectoryName($uninstall)
    if ($null -eq $dataRoot -or [IO.Path]::GetFileName($uninstall) -ne 'uninstall' -or [IO.Path]::GetFileName($dataRoot) -ne 'ETS2Telemetry') { return @{code = 'LAYOUT_INVALID'} }
    $base = [IO.Path]::GetDirectoryName($dataRoot)
    if ($null -eq $base -or !(Test-DrivePath $base)) { return @{code = 'LAYOUT_INVALID'} }
    if ((Get-Kind $dataRoot) -eq 'link' -or (Get-Kind $uninstall) -eq 'link') { return @{code = 'DATA_ROOT_LINKED'} }
    if ((Get-Kind $base) -ne 'directory' -or (Get-Kind $dataRoot) -ne 'directory' -or (Get-Kind $uninstall) -ne 'directory') { return @{code = 'LAYOUT_INVALID'} }
    $roots = @{code = $null; base = $base; dataRoot = $dataRoot; uninstall = $uninstall; mode = $null; testRoot = $null; subKey = $null}
    if ([IO.Path]::GetFileName($base) -eq 'LocalAppData') {
        $testRoot = [IO.Path]::GetDirectoryName($base)
        $marker = Get-Kind (Join-Path $testRoot 'ets2telemetry-plugin-test-root.marker')
        $testFile = Join-Path $testRoot 'ets2telemetry-install-test.json'
        $testKind = Get-Kind $testFile
        if ($marker -ne 'missing' -or $testKind -ne 'missing') {
            if ($marker -ne 'file' -or $testKind -ne 'file' -or (New-Object IO.FileInfo($testFile)).Length -gt 16384) { return @{code = 'TEST_ROOT_INVALID'} }
            try { $test = [IO.File]::ReadAllText($testFile, $Utf8) | ConvertFrom-Json } catch { return @{code = 'TEST_ROOT_INVALID'} }
            if (!(Test-Object $test) -or (Get-PropertyNames $test) -cne 'format,profileDir,runOnceKey,shortcuts,version') { return @{code = 'TEST_ROOT_INVALID'} }
            if ($test.format -cne 'ets2telemetry.install-test' -or $test.version -ne 1 -or $test.version -isnot [int] -or $test.shortcuts -isnot [bool]) { return @{code = 'TEST_ROOT_INVALID'} }
            if (!(Test-DrivePath $test.profileDir) -or !(Test-Inside $test.profileDir $testRoot)) { return @{code = 'TEST_ROOT_INVALID'} }
            if ($null -ne $test.runOnceKey -and ($test.runOnceKey -isnot [string] -or $test.runOnceKey -cnotmatch $TestKeyPattern)) { return @{code = 'TEST_ROOT_INVALID'} }
            $roots.mode = 'test-root'; $roots.testRoot = $testRoot
            if ($null -ne $test.runOnceKey) { $roots.subKey = $test.runOnceKey.Substring(5) }
            return $roots
        }
    }
    # Production: the base must be this user's known-folder LocalAppData (never the LOCALAPPDATA variable).
    $known = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrEmpty($known) -or !(Test-SamePath ([IO.Path]::GetFullPath($known)) $base)) { return @{code = 'ROOT_MISMATCH'} }
    $roots.mode = 'production'; $roots.subKey = $ProductionSubKey
    return $roots
}
function Get-ExecutorCommand([string]$DataRoot) {
    # executorCommand in executor.ts: the absolute, quoted powershell.exe under %SystemRoot% when the command fits 260
    # characters, otherwise the PATH form, otherwise nothing ($null).
    $windows = $env:SystemRoot
    if ($null -eq $windows -or $windows -notmatch '^[A-Za-z]:\\[^\\/:*?"<>|]+(\\[^\\/:*?"<>|]+)*$') { $windows = 'C:\Windows' }
    $script = '"' + [IO.Path]::Combine($DataRoot, 'uninstall', $ExecutorName) + '"'
    foreach ($program in @(('"' + [IO.Path]::Combine($windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') + '"'), 'powershell.exe')) {
        $command = $program + ' -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $script
        if ($command.Length -le $MaxCommand) { return $command }
    }
    return $null
}
function Set-Registration($Roots) {
    if ($null -eq $Roots.subKey) { return 'not-applicable' }
    $command = Get-ExecutorCommand $Roots.dataRoot
    if ($null -eq $command) { return 'failed' }
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($Roots.subKey)
        try { $key.SetValue($ValueName, $command, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
        return 'registered'
    } catch { return 'failed' }
}
function Remove-Registration($Roots) {
    if ($null -eq $Roots.subKey) { return 'not-applicable' }
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($Roots.subKey, $true)
        if ($null -eq $key) { return 'removed' }
        try { $key.DeleteValue($ValueName, $false) } finally { $key.Dispose() }
        return 'removed'
    } catch { return 'failed' }
}

# --- The intent and the install registry ----------------------------------------------------------------------------

function Test-Folder($Folder) {
    if (!(Test-Object $Folder) -or (Get-PropertyNames $Folder) -cne 'createdPluginsDirectory,game,hashes,root,temps') { return $false }
    if (($Folder.game -cne 'ets2' -and $Folder.game -cne 'ats') -or !(Test-DrivePath $Folder.root) -or $Folder.createdPluginsDirectory -isnot [bool]) { return $false }
    $hashes = @($Folder.hashes); $temps = @($Folder.temps)
    if ($Folder.hashes -isnot [Array] -or $hashes.Count -gt 17 -or @($hashes | Where-Object { !(Test-Hash $_) }).Count) { return $false }
    if ($Folder.temps -isnot [Array] -or $temps.Count -gt 16) { return $false }
    foreach ($temp in $temps) { if (!(Test-TempFile $temp $Folder.root)) { return $false } }
    return $true
}
function Test-TempFile($Temp, [string]$Root) {
    return (Test-DrivePath $Temp) -and [IO.Path]::GetFileName($Temp) -cmatch $TempPattern -and (Test-SamePath ([IO.Path]::GetDirectoryName($Temp)) (Get-PluginsDirectory $Root))
}
function Read-Intent([string]$Uninstall) {
    # Strict, as pending-record.ts parses it: absent, invalid, or the record.
    $file = Join-Path $Uninstall 'pending.json'
    $kind = Get-Kind $file
    if ($kind -eq 'missing') { return @{state = 'absent'} }
    if ($kind -ne 'file' -or (New-Object IO.FileInfo($file)).Length -gt 131072) { return @{state = 'invalid'} }
    try { $record = [IO.File]::ReadAllText($file, (New-Object Text.UTF8Encoding($false, $true))) | ConvertFrom-Json } catch { return @{state = 'invalid'} }
    if (!(Test-Object $record) -or (Get-PropertyNames $record) -cne 'attempts,folders,format,known,phase,startedUtc,version') { return @{state = 'invalid'} }
    if ($record.format -cne 'ets2telemetry.uninstall-pending' -or $record.version -isnot [int] -or $record.version -ne 1) { return @{state = 'invalid'} }
    if (($record.phase -cne 'plugins' -and $record.phase -cne 'deferred') -or $record.startedUtc -isnot [string] -or $record.startedUtc -cnotmatch $UtcPattern) { return @{state = 'invalid'} }
    if ($record.attempts -isnot [int] -or $record.attempts -lt 1) { return @{state = 'invalid'} }
    $known = @($record.known); $folders = @($record.folders)
    if ($record.known -isnot [Array] -or $known.Count -gt 257 -or @($known | Where-Object { !(Test-Hash $_) }).Count) { return @{state = 'invalid'} }
    if ($record.folders -isnot [Array] -or $folders.Count -gt 32) { return @{state = 'invalid'} }
    foreach ($folder in $folders) { if (!(Test-Folder $folder)) { return @{state = 'invalid'} } }
    for ($index = 0; $index -lt $folders.Count; $index++) {
        for ($other = 0; $other -lt $index; $other++) {
            if ($folders[$other].game -ceq $folders[$index].game -and (Test-SamePath $folders[$other].root $folders[$index].root)) { return @{state = 'invalid'} }
        }
    }
    return @{state = 'present'; record = $record; known = [string[]]$known; folders = $folders}
}
function ConvertTo-IntentText($Record, [int]$Attempts, $Folders, [string[]]$Known) {
    $document = [ordered]@{format = 'ets2telemetry.uninstall-pending'; version = 1; phase = 'deferred'; startedUtc = [string]$Record.startedUtc; attempts = $Attempts
        known = @($Known); folders = @(foreach ($folder in $Folders) {
            [ordered]@{game = $folder.game; root = $folder.root; hashes = @($folder.hashes | Select-Object -First 17); temps = @($folder.temps | Select-Object -First 16)
                createdPluginsDirectory = [bool]$folder.createdPluginsDirectory}
        })}
    return (ConvertTo-JsonText $document) + "`n"
}
function ConvertTo-BoundedIntentText($Record, [int]$Attempts, $Folders, [string[]]$Known) {
    # recordable in engine.ts: at most 32 folders and 128 KiB, or the next Read-Intent would refuse the intent. $Folders
    # come with the intent's own folders first, so the folders only the install registry names drop from the end first.
    $kept = @($Folders | Select-Object -First 32)
    for (;;) {
        $text = ConvertTo-IntentText $Record $Attempts $kept $Known
        if ($Utf8.GetByteCount($text) -le 131072 -or $kept.Count -eq 0) { return $text }
        $kept = @($kept | Select-Object -First ($kept.Count - 1))
    }
}
function Sort-OwnFirst($Folders, $Own) {
    # intentFolders in plugin-cleanup.ts: the folders the intent itself names first, then the registry's, each in order.
    $isOwn = { param($folder) @($Own | Where-Object { $_.game -ceq $folder.game -and (Test-SamePath $_.root $folder.root) }).Count -gt 0 }
    return @(@($Folders | Where-Object { & $isOwn $_ }) + @($Folders | Where-Object { !(& $isOwn $_) }))
}
function Read-Registry([string]$DataRoot) {
    # The install registry plugins\setup.json: state ok with its folders, or a problem code. A registry that is not a valid
    # v1 document names no folder and keeps plugins\, as in the engine.
    $directory = Join-Path $DataRoot 'plugins'
    $file = Join-Path $directory 'setup.json'
    $directoryKind = Get-Kind $directory
    if ($directoryKind -eq 'missing') { return @{problem = $null; folders = @()} }
    if ($directoryKind -ne 'directory') { return @{problem = 'REGISTRY_UNREADABLE'; folders = @()} }
    $kind = Get-Kind $file
    if ($kind -eq 'missing') { return @{problem = $null; folders = @()} }
    if ($kind -ne 'file') { return @{problem = 'REGISTRY_UNREADABLE'; folders = @()} }
    try { $bytes = [IO.File]::ReadAllBytes($file) } catch { return @{problem = 'REGISTRY_UNREADABLE'; folders = @()} }
    $prefix = [Text.Encoding]::UTF8.GetString($bytes, 0, [Math]::Min(4096, $bytes.Length))
    $newer = [regex]::Match($prefix.TrimStart([char]0xFEFF), '^\s*\{\s*"format"\s*:\s*"ets2telemetry\.plugin-setup"\s*,\s*"version"\s*:\s*(\d{1,9})\s*[,}]')
    if ($bytes.Length -gt 262144) {
        if ($newer.Success -and [int]$newer.Groups[1].Value -gt 1) { return @{problem = 'REGISTRY_NEWER'; folders = @()} }
        return @{problem = 'REGISTRY_INVALID'; folders = @()}
    }
    try { $document = (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
    if (!(Test-Object $document) -or $document.PSObject.Properties.Name -notcontains 'format' -or $document.format -cne 'ets2telemetry.plugin-setup') { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
    if ($document.PSObject.Properties.Name -contains 'version' -and $document.version -is [int] -and $document.version -gt 1) { return @{problem = 'REGISTRY_NEWER'; folders = @()} }
    if ($document.PSObject.Properties.Name -notcontains 'version' -or $document.version -isnot [int] -or $document.version -ne 1) { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
    if ((Get-PropertyNames $document) -cne 'failures,format,games,installs,pending,version' -or !(Test-Object $document.games) -or (Get-PropertyNames $document.games) -cne 'ats,ets2') { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
    $folders = @()
    $installs = @($document.installs); $pending = @($document.pending); $failures = @($document.failures)
    if ($document.installs -isnot [Array] -or $installs.Count -gt 16 -or $document.pending -isnot [Array] -or $pending.Count -gt 16 -or $document.failures -isnot [Array] -or $failures.Count -gt 16) { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
    foreach ($record in $installs) {
        if (!(Test-Object $record) -or (Get-PropertyNames $record) -cne 'appVersion,createdPluginsDirectory,game,installedUtc,root,sha256,source') { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
        if (($record.game -cne 'ets2' -and $record.game -cne 'ats') -or !(Test-DrivePath $record.root) -or !(Test-Hash $record.sha256) -or $record.createdPluginsDirectory -isnot [bool]) { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
        $folders += ,@{game = $record.game; root = $record.root; hashes = @($record.sha256); temps = @(); createdPluginsDirectory = $record.createdPluginsDirectory}
    }
    foreach ($intent in $pending) {
        if (!(Test-Object $intent) -or (Get-PropertyNames $intent) -cne 'appVersion,createdPluginsDirectory,fromSha256,game,op,root,source,startedUtc,temp,toSha256') { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
        if (($intent.game -cne 'ets2' -and $intent.game -cne 'ats') -or !(Test-DrivePath $intent.root) -or $intent.createdPluginsDirectory -isnot [bool]) { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
        if ($intent.op -ceq 'remove') { continue }
        if (($intent.op -cne 'install' -and $intent.op -cne 'update') -or !(Test-Hash $intent.toSha256) -or !(Test-TempFile $intent.temp $intent.root)) { return @{problem = 'REGISTRY_INVALID'; folders = @()} }
        $folders += ,@{game = $intent.game; root = $intent.root; hashes = @($intent.toSha256); temps = @($intent.temp); createdPluginsDirectory = $intent.createdPluginsDirectory}
    }
    foreach ($failure in $failures) { if (!(Test-Object $failure) -or (Get-PropertyNames $failure) -cne 'code,game,root,step,utc') { return @{problem = 'REGISTRY_INVALID'; folders = @()} } }
    return @{problem = $null; folders = $folders}
}
function Merge-Folders($Lists) {
    # cleanupFolders in plugin-cleanup.ts: each game folder once, with every hash and temporary file named for it.
    $merged = New-Object Collections.Generic.List[object]
    foreach ($list in $Lists) {
        foreach ($folder in $list) {
            $found = $null
            foreach ($candidate in $merged) { if ($candidate.game -ceq $folder.game -and (Test-SamePath $candidate.root $folder.root)) { $found = $candidate; break } }
            if ($null -eq $found) {
                $found = @{game = [string]$folder.game; root = [string]$folder.root; hashes = New-Object Collections.Generic.List[string]; temps = New-Object Collections.Generic.List[string]; createdPluginsDirectory = $false}
                $merged.Add($found)
            }
            foreach ($hash in @($folder.hashes)) { if (!$found.hashes.Contains([string]$hash)) { $found.hashes.Add([string]$hash) } }
            foreach ($temp in @($folder.temps)) { if (!$found.temps.Contains([string]$temp)) { $found.temps.Add([string]$temp) } }
            $found.createdPluginsDirectory = $found.createdPluginsDirectory -or [bool]$folder.createdPluginsDirectory
        }
    }
    return ,$merged.ToArray()
}

# --- Running games --------------------------------------------------------------------------------------------------

function Get-Running {
    # game-processes.ts: image names only, case-insensitively; a TruckersMP client blocks both games. A failed listing is
    # null, and then no game folder is touched.
    if ($script:UseTestImages) { $names = @($script:TestImages) } else {
        try { $names = @(Get-Process -ErrorAction Stop | ForEach-Object { $_.ProcessName.ToLowerInvariant() + '.exe' }) } catch { return $null }
    }
    return @{ets2 = $names -contains 'eurotrucks2.exe'; ats = $names -contains 'amtrucks.exe'; client = @($names | Where-Object { $_.StartsWith('truckersmp', [StringComparison]::Ordinal) }).Count -gt 0}
}
function Get-Blocking([string]$Game, $Running) {
    if ($Running[$Game]) { return 'GAME_RUNNING' }
    if ($Running.client) { return 'CLIENT_RUNNING' }
    return $null
}

# --- One game folder (plugin-cleanup.ts and validateGameLayout in steam-discovery.ts) -------------------------------

function Get-PluginHash([string]$Path) {
    $kind = Get-Kind $Path
    if ($kind -eq 'missing') { return @{kind = 'missing'} }
    if ($kind -eq 'error') { return @{kind = 'error'; reason = 'IO_ERROR'} }
    if ($kind -ne 'file') { return @{kind = 'not-file'} }
    $info = New-Object IO.FileInfo($Path)
    if ($info.Length -gt 16MB) { return @{kind = 'too-large'} }
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]'ReadWrite, Delete') } catch {
        return @{kind = 'error'; reason = (Get-BlockReason (Get-ErrorKind $_) 'target-read')}
    }
    try {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $digest = $sha.ComputeHash($stream) } finally { $sha.Dispose() }
    } catch { return @{kind = 'error'; reason = (Get-BlockReason (Get-ErrorKind $_) 'target-read')} } finally { $stream.Dispose() }
    $hex = -join ($digest | ForEach-Object { $_.ToString('x2') })
    return @{kind = 'ok'; sha256 = $hex; readOnly = [bool]($info.Attributes -band [IO.FileAttributes]::ReadOnly)}
}
function Remove-PluginFile([string]$Path) {
    # An EBUSY-like sharing violation is retried after 20, 40, 60, 80 and 100 ms; a denied delete is TARGET_LOCKED at once.
    for ($attempt = 0; ; $attempt++) {
        try { [IO.File]::Delete($Path); return $null } catch {
            $kind = Get-ErrorKind $_
            if ($kind -eq 'missing') { return $null }
            if ($kind -ne 'locked' -or $attempt -ge $RetryDelays.Count) { return (Get-BlockReason $kind 'target-replace') }
            Start-Sleep -Milliseconds $RetryDelays[$attempt]
        }
    }
}
function Remove-EmptyPluginsDirectory([string]$Directory) {
    if ((Get-Kind $Directory) -ne 'directory') { return }
    try { if (@([IO.Directory]::GetFileSystemEntries($Directory)).Count -eq 0) { [IO.Directory]::Delete($Directory, $false) } } catch { $null = $_ }
}
function Clear-Plugins($Folder, $Known, [string]$Plugins, [string]$Target, [bool]$PluginsExists, [bool]$TargetExists) {
    # Step 2: the exact temporary files of pending intents, when they are regular files.
    foreach ($temp in $Folder.temps) {
        if ([IO.Path]::GetFileName($temp) -cnotmatch $TempPattern -or !(Test-SamePath ([IO.Path]::GetDirectoryName($temp)) $Plugins)) { continue }
        $tempKind = Get-Kind $temp
        if ($tempKind -eq 'error') { return @{status = 'blocked'; reason = 'IO_ERROR'} }
        if ($tempKind -ne 'file') { continue }
        try { [IO.File]::Delete($temp) } catch {
            $kind = Get-ErrorKind $_
            if ($kind -ne 'missing') { return @{status = 'blocked'; reason = (Get-BlockReason $kind 'target-replace')} }
        }
    }
    # Step 3: the DLL, only while its hash is one this application installed and it is not read-only.
    $status = 'absent'
    if ($TargetExists) {
        $hashed = Get-PluginHash $Target
        if ($hashed.kind -eq 'error') { return @{status = 'blocked'; reason = $hashed.reason} }
        if ($hashed.kind -ne 'ok') { if ($hashed.kind -ne 'missing') { $status = 'unrecognized' } }
        elseif (!$Folder.hashes.Contains($hashed.sha256) -and $Known -notcontains $hashed.sha256) { $status = 'unrecognized' }
        elseif ($hashed.readOnly) { return @{status = 'blocked'; reason = 'READ_ONLY_FILE'} }
        else {
            $failure = Remove-PluginFile $Target
            if ($null -ne $failure) { return @{status = 'blocked'; reason = $failure} }
            $status = 'removed'
        }
    }
    # Step 4: the plugins folder only when this application created it and it is now empty.
    if ($Folder.createdPluginsDirectory -and $PluginsExists) { Remove-EmptyPluginsDirectory $Plugins }
    return @{status = $status}
}
function Test-RootGone([string]$Root) {
    if ((Get-Kind $Root) -ne 'missing') { return $false }
    $parent = [IO.Path]::GetDirectoryName($Root)
    if ($null -eq $parent -or $parent -eq $Root) { return $false }
    return (Get-Kind $parent) -eq 'directory'
}
function Clear-NotGameFolder($Folder, $Known) {
    $root = $Folder.root
    $rootKind = Get-FollowedKind $root
    if ($rootKind -eq 'error') { return @{status = 'blocked'; reason = 'IO_ERROR'} }
    if ($rootKind -eq 'missing') { if (Test-RootGone $root) { return @{status = 'absent'; note = 'GAME_FOLDER_GONE'} } else { return @{status = 'blocked'; reason = 'FOLDER_UNAVAILABLE'} } }
    if ($rootKind -ne 'directory') { return @{status = 'absent'; note = 'LAYOUT_NOT_PLAIN'} }
    $bin = Join-Path $root 'bin'; $win64 = Join-Path $bin 'win_x64'; $plugins = Join-Path $win64 'plugins'; $target = Join-Path $plugins $PluginFile
    $kinds = @((Get-Kind $bin), (Get-Kind $win64), (Get-Kind $plugins))
    if ($kinds -contains 'error') { return @{status = 'blocked'; reason = 'IO_ERROR'} }
    if ($kinds -contains 'missing') { return @{status = 'absent'; note = 'PLUGINS_FOLDER_ABSENT'} }
    if (@($kinds | Where-Object { $_ -ne 'directory' }).Count) { return @{status = 'absent'; note = 'LAYOUT_NOT_PLAIN'} }
    $targetKind = Get-Kind $target
    if ($targetKind -eq 'error') { return @{status = 'blocked'; reason = 'IO_ERROR'} }
    $outcome = Clear-Plugins $Folder $Known $plugins $target $true ($targetKind -ne 'missing')
    if ($outcome.status -eq 'blocked') { return $outcome }
    return @{status = $outcome.status; note = 'GAME_EXECUTABLE_MISSING'}
}
function Clear-Folder($Folder, $Known, $Running) {
    $blocking = Get-Blocking $Folder.game $Running
    if ($null -ne $blocking) { return @{status = 'blocked'; reason = $blocking} }
    $root = $Folder.root
    # validateGameLayout: the root followed, then bin, bin\win_x64 and plugins never followed.
    if ((Get-FollowedKind $root) -ne 'directory') { return Clear-NotGameFolder $Folder $Known }
    $bin = Join-Path $root 'bin'; $win64 = Join-Path $bin 'win_x64'; $executable = Join-Path $win64 $GameExecutables[$Folder.game]
    $plugins = Join-Path $win64 'plugins'; $target = Join-Path $plugins $PluginFile
    foreach ($step in @($bin, $win64)) {
        $kind = Get-Kind $step
        if ($kind -eq 'link') {
            # Linked only when the game executable is reachable through it; otherwise not a game folder.
            if ([IO.File]::Exists($executable)) { return @{status = 'blocked'; reason = 'LINKED_FOLDER'} }
            return Clear-NotGameFolder $Folder $Known
        }
        if ($kind -ne 'directory') { return Clear-NotGameFolder $Folder $Known }
    }
    if ((Get-Kind $executable) -ne 'file') { return Clear-NotGameFolder $Folder $Known }
    $pluginsKind = Get-Kind $plugins
    if ($pluginsKind -eq 'missing') { return Clear-Plugins $Folder $Known $plugins $target $false $false }
    if ($pluginsKind -eq 'link') { return @{status = 'blocked'; reason = 'LINKED_FOLDER'} }
    if ($pluginsKind -ne 'directory') { return @{status = 'blocked'; reason = 'UNRECOGNIZED_FILE'} }
    $targetKind = Get-Kind $target
    if ($targetKind -eq 'missing') { return Clear-Plugins $Folder $Known $plugins $target $true $false }
    if ($targetKind -ne 'file') { return @{status = 'blocked'; reason = 'UNRECOGNIZED_FILE'} }
    return Clear-Plugins $Folder $Known $plugins $target $true $true
}
function Test-Confined([string]$Root, [string]$TestRoot) {
    # Test root: a folder must lie inside it, and so must the target of any link on the way down from it (the ET-017
    # confinement, confineToRoot in mode.ts).
    if (!(Test-Inside $Root $TestRoot)) { return $false }
    $current = $Root
    while (!(Test-SamePath $current $TestRoot)) {
        if ((Get-Kind $current) -eq 'link') {
            $target = @((Get-Item -LiteralPath $current -Force).Target) | Select-Object -First 1
            if ($null -eq $target -or !(Test-DrivePath ([string]$target)) -or !(Test-Inside ([string]$target) $TestRoot)) { return $false }
        }
        $current = [IO.Path]::GetDirectoryName($current)
        if ($null -eq $current) { return $false }
    }
    return $true
}

# --- The data wipe (data-wipe.ts) -----------------------------------------------------------------------------------

function Remove-Tree([string]$Path) {
    $kind = Get-Kind $Path
    if ($kind -eq 'missing') { return $null }
    if ($kind -eq 'error') { return 'IO_ERROR' }
    if ($kind -eq 'link') {
        # A symbolic link or junction is removed itself, never entered.
        try {
            if ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::Directory) { [IO.Directory]::Delete($Path, $false) } else { [IO.File]::Delete($Path) }
            return $null
        } catch { $errorKind = Get-ErrorKind $_; if ($errorKind -eq 'missing') { return $null } else { return (Get-WipeFailure $errorKind) } }
    }
    if ($kind -eq 'directory') {
        try { $names = [string[]][IO.Directory]::GetFileSystemEntries($Path) } catch { $errorKind = Get-ErrorKind $_; if ($errorKind -eq 'missing') { return $null } else { return (Get-WipeFailure $errorKind) } }
        [Array]::Sort($names, [StringComparer]::Ordinal)
        $first = $null
        foreach ($name in $names) { $failure = Remove-Tree $name; if ($null -eq $first) { $first = $failure } }
        if ($null -ne $first) { return $first }
        try { [IO.Directory]::Delete($Path, $false); return $null } catch { $errorKind = Get-ErrorKind $_; if ($errorKind -eq 'missing') { return $null } else { return (Get-WipeFailure $errorKind) } }
    }
    # A read-only file stays and is reported; the attribute is never cleared.
    if ([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReadOnly) { return 'READ_ONLY_FILE' }
    try { [IO.File]::Delete($Path); return $null } catch { $errorKind = Get-ErrorKind $_; if ($errorKind -eq 'missing') { return $null } else { return (Get-WipeFailure $errorKind) } }
}
function Clear-DataRoot([string]$DataRoot, [string[]]$Keep, [bool]$RemoveRoot) {
    $report = @{removed = 0; kept = 0; failed = @(); rootRemoved = $false}
    try { $names = [string[]][IO.Directory]::GetFileSystemEntries($DataRoot) } catch {
        if ((Get-ErrorKind $_) -eq 'missing') { $report.rootRemoved = $true; return $report }
        $report.failed = @([ordered]@{entry = 'data'; code = (Get-WipeFailure (Get-ErrorKind $_))}); return $report
    }
    [Array]::Sort($names, [StringComparer]::Ordinal)
    foreach ($name in $names) {
        $leaf = [IO.Path]::GetFileName($name).ToLowerInvariant()
        if ($Allowlist -notcontains $leaf) { $report.kept++; continue }
        if ($Keep -contains $leaf) { continue }
        $failure = Remove-Tree $name
        if ($null -ne $failure) { $report.failed += ,([ordered]@{entry = $leaf; code = $failure}) } else { $report.removed++ }
    }
    if ($RemoveRoot -and !$report.failed.Count) {
        try { if (@([IO.Directory]::GetFileSystemEntries($DataRoot)).Count -eq 0) { [IO.Directory]::Delete($DataRoot, $false); $report.rootRemoved = $true } } catch {
            $report.rootRemoved = (Get-ErrorKind $_) -eq 'missing'
        }
    }
    return $report
}
function Clear-Everything([string]$DataRoot, [bool]$PluginsClean) {
    # Everything but plugins and uninstall; then, only when the plugin folders are clean and nothing failed, plugins,
    # then uninstall (with this script and the intent), then the empty data root.
    $first = Clear-DataRoot $DataRoot @('plugins', 'uninstall') $false
    if (!$PluginsClean -or $first.failed.Count) { return $first }
    $registry = Clear-DataRoot $DataRoot @($Allowlist | Where-Object { $_ -ne 'plugins' }) $false
    if ($registry.failed.Count) { return @{removed = $first.removed + $registry.removed; kept = $first.kept; failed = $registry.failed; rootRemoved = $false} }
    if ($null -ne $script:LateEntry) {
        # Test root only (-TestLateEntry): an allowlisted entry a writer left behind after the registry step.
        $late = Join-Path $DataRoot $script:LateEntry
        [void][IO.Directory]::CreateDirectory($late)
        [IO.File]::WriteAllText((Join-Path $late 'late.jsonl'), "written after the registry step`n", $Utf8)
    }
    # The last step removes every allowlisted entry still there (keep nothing), then the empty root, as wipeEverything in
    # engine.ts does after clean earlier steps.
    $intent = Clear-DataRoot $DataRoot @() $true
    return @{removed = $first.removed + $registry.removed + $intent.removed; kept = $first.kept; failed = $intent.failed; rootRemoved = $intent.rootRemoved}
}

# --- README and the message box -------------------------------------------------------------------------------------

function Get-ReasonText([string]$Code) {
    switch ($Code) {
        'GAME_RUNNING' { return 'a game was running' }
        'CLIENT_RUNNING' { return 'TruckersMP was running' }
        'TARGET_LOCKED' { return 'a plugin file was in use' }
        'READ_ONLY_FILE' { return 'a file is read-only' }
        'LINKED_FOLDER' { return 'a game folder is linked to another location' }
        'RUNNING_CHECK_FAILED' { return 'the running games could not be checked' }
        default { return 'a file could not be removed (' + $Code + ')' }
    }
}
function Write-Readme([string]$Uninstall, [string]$DataRoot, $Folders, [string[]]$Known, [string]$Code, [int]$Attempts, [string]$Mode) {
    # $Mode: 'deferred' (registered for the next sign-in), 'stopped' (the 10th attempt), 'failed-retry' (an unexpected
    # error after this attempt was counted and registered) or 'failed-stopped' (an error before that: nothing runs again).
    $hashes = [Collections.Generic.SortedSet[string]]::new([StringComparer]::Ordinal)
    foreach ($hash in $Known) { [void]$hashes.Add($hash) }
    foreach ($folder in $Folders) { foreach ($hash in $folder.hashes) { [void]$hashes.Add([string]$hash) } }
    $lines = New-Object Collections.Generic.List[string]
    $lines.Add('ETS2Telemetry was uninstalled, but its cleanup could not finish.'); $lines.Add('Reason: ' + $Code); $lines.Add('')
    switch ($Mode) {
        'stopped' { $lines.Add('ETS2Telemetry tried ' + $Attempts + ' times and stopped trying at sign-in. Finish the cleanup with the steps below.') }
        'failed-retry' {
            $lines.Add('An unexpected error stopped this cleanup attempt. ETS2Telemetry tries again at your next Windows sign-in (attempt ' + $Attempts + ' of ' + $MaxAttempts + ' was made).')
            $lines.Add('You only need the steps below if that does not happen.')
        }
        'failed-stopped' { $lines.Add('An unexpected error stopped the automatic cleanup, and it does not run again. Finish the cleanup with the steps below.') }
        default {
            $lines.Add('ETS2Telemetry tries again at your next Windows sign-in, once the games are closed (attempt ' + $Attempts + ' of ' + $MaxAttempts + ' was made).')
            $lines.Add('You only need the steps below if that does not happen.')
        }
    }
    $lines.Add(''); $lines.Add('Close Euro Truck Simulator 2, American Truck Simulator and TruckersMP first.'); $lines.Add('')
    if (@($Folders).Count) {
        $lines.Add("Remove the ETS2Telemetry plugin from these game folders, but only when the file's SHA-256 is one of the hashes below:")
        foreach ($folder in $Folders) { $lines.Add('  ' + $folder.game + ': ' + (Join-Path (Get-PluginsDirectory $folder.root) $PluginFile)) }
        $lines.Add(''); $lines.Add('Check a file with: Get-FileHash -Algorithm SHA256 "<file>"'); $lines.Add(''); $lines.Add("Hashes of this application's plugin:")
        foreach ($hash in $hashes) { $lines.Add('  ' + $hash) }
        $lines.Add('')
    }
    $lines.Add('Then delete the folders "plugins" and "uninstall" in ' + $DataRoot + '.')
    $lines.Add('If that folder holds anything else, it is not a file ETS2Telemetry knows: check it first, and delete the folder only when nothing you need is left.')
    $lines.Add(''); $lines.Add('Reinstalling ETS2Telemetry instead cancels this cleanup and keeps the plugin in use.'); $lines.Add('')
    Write-AtomicText $Uninstall 'README.txt' ($lines -join "`r`n")
}
function Write-FailureReadme([string]$Uninstall, [string]$DataRoot, [string]$Code, [bool]$Retry, $Attempts) {
    # README.txt when a run ends without finishing: says whether the next sign-in tries again ($Retry: this attempt was
    # counted and registered) or that the cleanup stopped. With a readable intent it lists the folders and hashes; without
    # one, the notice goes above the README an earlier run wrote, which already lists them.
    $intent = @{state = 'invalid'}
    try { $intent = Read-Intent $Uninstall } catch { $null = $_ }
    $mode = if ($Retry) { 'failed-retry' } else { 'failed-stopped' }
    if ($intent.state -eq 'present') {
        $count = if ($null -ne $Attempts) { [int]$Attempts } else { [int]$intent.record.attempts }
        Write-Readme $Uninstall $DataRoot $intent.folders $intent.known $Code $count $mode
        return
    }
    $notice = 'Reason: ' + $Code + "`r`n" + 'The automatic cleanup of ETS2Telemetry stopped, and it does not run again. Finish the cleanup with the steps below.'
    $readme = Join-Path $Uninstall 'README.txt'
    $earlier = ''
    if ((Get-Kind $readme) -eq 'file' -and (New-Object IO.FileInfo($readme)).Length -le 65536) { $earlier = [IO.File]::ReadAllText($readme, $Utf8) }
    if ($earlier.StartsWith($notice, [StringComparison]::Ordinal)) { return }
    if ($earlier.Length) { Write-AtomicText $Uninstall 'README.txt' ($notice + "`r`n`r`n" + $earlier); return }
    Write-Readme $Uninstall $DataRoot @() @() $Code 0 'failed-stopped'
}
function Show-Summary($Roots) {
    # One message box, production only: a test run never shows a window that could block it.
    if ($Roots.mode -ne 'production') { $script:Result.messageBox = 'suppressed'; return }
    $text = switch ($script:Result.outcome) {
        'complete' { 'ETS2Telemetry finished removing its game plugin and its local data.' }
        'deferred' { 'ETS2Telemetry could not finish removing its game plugin yet: ' + (Get-ReasonText $script:Result.code) + '. It tries again at your next sign-in (attempt ' + $script:Result.attempts + ' of ' + $MaxAttempts + ').' }
        'stopped' { 'ETS2Telemetry stopped trying to remove its game plugin after ' + $script:Result.attempts + ' attempts: ' + (Get-ReasonText $script:Result.code) + '. README.txt in ' + $Roots.uninstall + ' lists the steps to finish by hand.' }
        'refused' { if ($script:Result.readme) { 'ETS2Telemetry could not finish removing its game plugin and its local data (' + $script:Result.code + '). README.txt in ' + $Roots.uninstall + ' says what happens next and how to finish by hand.' } else { $null } }
        default { $null }
    }
    if ($null -eq $text) { return }
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = if ($script:Result.outcome -eq 'complete') { [Windows.Forms.MessageBoxIcon]::Information } else { [Windows.Forms.MessageBoxIcon]::Warning }
        [void][Windows.Forms.MessageBox]::Show($text, 'ETS2Telemetry uninstall', [Windows.Forms.MessageBoxButtons]::OK, $icon)
        $script:Result.messageBox = 'shown'
    } catch { $script:Result.messageBox = 'failed' }
}
function Write-Receipt {
    # %TEMP%\ETS2Telemetry-deferred-cleanup-<utc>.json, created new; fixed codes and counts only, never a path.
    try {
        $now = [DateTime]::UtcNow
        $script:Result.createdUtc = $now.ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture)
        $script:Result.elapsedMs = [int]$Clock.ElapsedMilliseconds
        $name = 'ETS2Telemetry-deferred-cleanup-' + $now.ToString('yyyyMMddTHHmmssfffZ', [Globalization.CultureInfo]::InvariantCulture) + '.json'
        $bytes = $Utf8.GetBytes((ConvertTo-JsonText $script:Result) + "`n")
        $stream = New-Object IO.FileStream((Join-Path ([IO.Path]::GetTempPath()) $name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } catch { $null = $_ }
}


# --- The run --------------------------------------------------------------------------------------------------------

$script:UseTestImages = $false
$script:TestImages = @()
$script:FailAt = $null
$script:LateEntry = $null
$script:TestRoaming = $null

function Remove-RoamingUserData($Roots) {
    # Owner decision O7, as the Squirrel hook does after its own complete run: Electron's Roaming userData
    # %APPDATA%\ETS2Telemetry Desktop is removed best effort, in production only. The folder comes from the known folder
    # ApplicationData (never the APPDATA variable) and this exact name; a link or junction there is removed itself, never
    # entered (Remove-Tree), and a read-only or locked file stays. A test root touches no Roaming folder at all: only the
    # folder -TestRoamingFolder names inside the test root, or nothing ('not-applicable').
    if ($Roots.mode -eq 'production') {
        $appData = [Environment]::GetFolderPath('ApplicationData')
        if ([string]::IsNullOrEmpty($appData)) { return 'failed' }
        $folder = Join-Path $appData 'ETS2Telemetry Desktop'
    } elseif ($null -ne $script:TestRoaming) { $folder = $script:TestRoaming } else { return 'not-applicable' }
    $kind = Get-Kind $folder
    if ($kind -eq 'missing') { return 'absent' }
    if ($kind -ne 'directory' -and $kind -ne 'link') { return 'failed' }
    try { $failure = Remove-Tree $folder } catch { return 'failed' }
    if ($null -eq $failure -and (Get-Kind $folder) -eq 'missing') { return 'removed' }
    return 'failed'
}

function Invoke-TestFault([string]$Step) {
    # Test root only (-TestFailAt): an unexpected error at this step, to prove what an error leaves behind.
    if ($script:FailAt -ceq $Step) { throw ('TEST_FAULT ' + $Step) }
}

function Invoke-Cleanup($Roots) {
    # Everything after the roots; the outcome goes to $script:Result.
    $state = $script:Result
    Invoke-TestFault 'start'
    # The intent first: an error while reading it is never trusted either.
    $intent = @{state = 'invalid'}
    try { $intent = Read-Intent $Roots.uninstall } catch { $null = $_ }
    if ($intent.state -eq 'absent') { $state.outcome = 'not-needed'; $state.code = 'NO_INTENT'; $state.runOnce = Remove-Registration $Roots; return }
    if ($intent.state -ne 'present') {
        $state.code = 'INTENT_INVALID'; $state.runOnce = Remove-Registration $Roots
        try { Write-FailureReadme $Roots.uninstall $Roots.dataRoot $state.code $false $null; $state.readme = $true } catch { $state.readme = $false }
        return
    }

    # Right away, before anything else can fail: the intent counts this attempt, then, below the limit, the script
    # registers itself again (Windows removed the value before starting it). From here on any error, and any kill, is
    # followed by another attempt at the next sign-in, and every attempt is counted, so at most 10 are ever made.
    $attempts = [int]$intent.record.attempts + 1
    $state.attempts = $attempts
    try { Write-AtomicText $Roots.uninstall 'pending.json' (ConvertTo-BoundedIntentText $intent.record $attempts $intent.folders $intent.known) } catch {
        $state.code = 'INTENT_FAILED'; $state.runOnce = Remove-Registration $Roots
        try { Write-FailureReadme $Roots.uninstall $Roots.dataRoot $state.code $false $null; $state.readme = $true } catch { $state.readme = $false }
        return
    }
    if ($attempts -lt $MaxAttempts) { $state.runOnce = Set-Registration $Roots }
    Invoke-TestFault 'registered'

    # The application was installed again: its own start or install hook cancels the deferral; nothing to do here.
    $installRoot = Join-Path $Roots.base 'ETS2TelemetryDesktop'
    $installed = @(if ((Get-Kind $installRoot) -eq 'directory') {
        Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*' -ErrorAction SilentlyContinue |
            Where-Object { (Get-Kind (Join-Path $_.FullName 'ETS2TelemetryDesktop.exe')) -eq 'file' }
    })
    if ($installed.Count) { $state.outcome = 'not-needed'; $state.code = 'APP_INSTALLED'; $state.runOnce = Remove-Registration $Roots; return }

    # The folders: the install registry's (when it is a valid v1 document) merged with the intent's.
    $registry = Read-Registry $Roots.dataRoot
    $folders = if ($null -eq $registry.problem) { Merge-Folders @($registry.folders, $intent.folders) } else { Merge-Folders @(, $intent.folders) }
    $running = if (@($folders).Count) { Get-Running } else { @{ets2 = $false; ats = $false; client = $false} }
    $blocked = New-Object Collections.Generic.List[object]
    foreach ($folder in $folders) {
        if ($null -eq $running) { $blocked.Add(@{folder = $folder; reason = 'RUNNING_CHECK_FAILED'}); continue }
        if ($Roots.mode -eq 'test-root' -and !(Test-Confined $folder.root $Roots.testRoot)) { $blocked.Add(@{folder = $folder; reason = 'FOLDER_UNAVAILABLE'}); continue }
        $outcome = Clear-Folder $folder $intent.known $running
        if ($outcome.status -eq 'blocked') { $blocked.Add(@{folder = $folder; reason = $outcome.reason}); continue }
        $state.plugins[$outcome.status] = $state.plugins[$outcome.status] + 1
        if ($outcome.ContainsKey('note')) { $state.plugins.notes += ,([ordered]@{game = $folder.game; note = $outcome.note}) }
    }
    $state.plugins.blocked = @(foreach ($entry in $blocked) { [ordered]@{game = $entry.folder.game; reason = $entry.reason} })
    $pluginsClean = $blocked.Count -eq 0 -and $null -eq $registry.problem

    # The data: everything but plugins and uninstall; plugins and uninstall only when every folder is clean.
    $data = Clear-Everything $Roots.dataRoot $pluginsClean
    $state.data = [ordered]@{removed = $data.removed; kept = $data.kept; failed = @($data.failed); rootRemoved = [bool]$data.rootRemoved}
    if ($pluginsClean -and !$data.failed.Count) {
        # Complete: Electron's Roaming userData best effort (O7, production only), then unregister last, with the data
        # root, this script and the intent already gone.
        $state.outcome = 'complete'; $state.code = $null
        $state.roaming = Remove-RoamingUserData $Roots
        $state.runOnce = Remove-Registration $Roots
        return
    }
    $state.code = if ($blocked.Count) { $blocked[0].reason } elseif ($null -ne $registry.problem) { $registry.problem } else { 'DATA_ENTRY_BLOCKED' }
    # The intent keeps only what is left, its own folders first and within its bounds; after the 10th attempt the script
    # stops and leaves README.txt.
    $left = Sort-OwnFirst @(foreach ($entry in $blocked) { $entry.folder }) $intent.folders
    try { Write-AtomicText $Roots.uninstall 'pending.json' (ConvertTo-BoundedIntentText $intent.record $attempts $left $intent.known) } catch { $null = $_ }
    $stopped = $attempts -ge $MaxAttempts
    if ($stopped) { $state.outcome = 'stopped'; $state.runOnce = Remove-Registration $Roots } else { $state.outcome = 'deferred' }
    $mode = if ($stopped) { 'stopped' } else { 'deferred' }
    try { Write-Readme $Roots.uninstall $Roots.dataRoot @($left) $intent.known $state.code $attempts $mode; $state.readme = $true } catch { $state.readme = $false }
}

$roots = $null
$testParameter = $PSBoundParameters.ContainsKey('TestRunningImages') -or $PSBoundParameters.ContainsKey('TestFailAt') -or $PSBoundParameters.ContainsKey('TestLateEntry') -or
    $PSBoundParameters.ContainsKey('TestRoamingFolder')
try {
    $roots = Resolve-Roots
    if ($null -ne $roots.code) { $Result.code = $roots.code }
    elseif ($testParameter -and $roots.mode -ne 'test-root') { $Result.mode = $roots.mode; $Result.code = 'TEST_PARAMETER_REFUSED' }
    elseif ($PSBoundParameters.ContainsKey('TestRoamingFolder') -and (!(Test-DrivePath $TestRoamingFolder) -or !(Test-Inside $TestRoamingFolder $roots.testRoot))) {
        # The stand-in Roaming folder must lie inside the test root, so a test can never remove a real one.
        $Result.mode = $roots.mode; $Result.code = 'TEST_PARAMETER_REFUSED'
    }
    else {
        $Result.mode = $roots.mode
        if ($PSBoundParameters.ContainsKey('TestRunningImages')) {
            $script:UseTestImages = $true
            $script:TestImages = @(if ($TestRunningImages -cne 'none') { $TestRunningImages.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } })
        }
        if ($PSBoundParameters.ContainsKey('TestFailAt')) { $script:FailAt = $TestFailAt }
        if ($PSBoundParameters.ContainsKey('TestLateEntry')) { $script:LateEntry = $TestLateEntry }
        if ($PSBoundParameters.ContainsKey('TestRoamingFolder')) { $script:TestRoaming = $TestRoamingFolder }
        Invoke-Cleanup $roots
    }
} catch {
    # An unexpected error. Once the attempt was counted and the script registered itself again, the next sign-in tries
    # again; before that, nothing runs again. README.txt says which, and how to finish by hand. The README goes only into
    # a folder the roots accepted, or, when the roots themselves failed, into this script's own plain uninstall folder.
    $Result.outcome = 'refused'; $Result.code = 'EXECUTOR_FAILED'
    $retry = $Result.runOnce -eq 'registered'
    $uninstallFolder = if ($null -ne $roots -and $null -eq $roots.code) { $roots.uninstall } elseif ($null -eq $roots -and [IO.Path]::GetFileName($PSScriptRoot) -eq 'uninstall' -and (Get-Kind $PSScriptRoot) -eq 'directory') { $PSScriptRoot } else { $null }
    if ($null -ne $uninstallFolder) {
        try { Write-FailureReadme $uninstallFolder ([IO.Path]::GetDirectoryName($uninstallFolder)) $Result.code $retry $Result.attempts; $Result.readme = $true } catch { $Result.readme = $false }
    }
} finally {
    if ($null -ne $roots -and $null -eq $roots.code -and $Result.code -cne 'TEST_PARAMETER_REFUSED') { Show-Summary $roots }
    Write-Receipt
}
$exitCode = switch ($Result.outcome) { 'complete' { 0 } 'not-needed' { 0 } 'refused' { 4 } default { 3 } }
exit $exitCode
