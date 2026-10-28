[CmdletBinding()]
param(
    # Reports the steps and launches nothing.
    [switch]$Plan,
    # An owner-requested local run (plan O6): skips the GitHub-hosted runner signal; the fact-based guards still apply.
    # Agents never pass it. The test install then skips the shortcuts, and the run leaves no uninstall key behind.
    [switch]$AllowLocal,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosA = @('scaffold'),
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','plugin')][string[]]$ScenariosB = @('scaffold','plugin','telemetry'),
    # ET-055 PR-5: `lifecycle` installs the channel of the build that was made; `side-by-side` installs that production
    # build and a staging Setup into the same run root (GitHub-hosted runners only, since it installs production).
    [ValidateSet('lifecycle','side-by-side')][string]$Scenario = 'lifecycle',
    # The side-by-side scenario's staging input: the folder scripts/installer/side-by-side-input.mjs created in Windows CI.
    [string]$StagingInput
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
# ET-045g checks the Installed apps icon after every install, repair and update: DisplayIcon names icon 0 of the installed
# version's executable, and the binary root's app.ico has the tracked icon's bytes; before the update it plants the
# Electron-icon state of an install made before the fix, which the update must replace, and it compares the shell's
# pixels of both icons after the install and the update.
# ET-045h checks the product name after every install, repair and update: the registration's DisplayName and Publisher,
# one HKCU Uninstall entry pointing into R and the installed executable's version resource; on a hosted runner, exactly one
# "Yukon Union Telemetry" shortcut on the Desktop and one in the Start menu's company folder, and no "ETS2Telemetry
# Desktop" one. It plants the old names of an install made before ET-045h (L1 before the update: an owned Start menu
# shortcut, a foreign Desktop decoy and the old DisplayName and Publisher; L2 before a Setup over an uninstalled root:
# owned orphans in both locations; L3 before a Windows-initiated uninstall: an owned Start menu shortcut), which the
# hooks must remove while the decoy stays byte-identical.
# Squirrel's binary root is redirected with SQUIRREL_TEMP = R\LocalAppData, and every child process gets LOCALAPPDATA,
# APPDATA and TEMP inside R. R is deleted at the end, and any HKCU uninstall key that still points into R. It runs on a
# GitHub-hosted runner, or locally only with -AllowLocal on the owner's explicit request (docs/installer-testing.md).
# ET-055 PR-5 (REG-017, REG-019; UP12, UP19): every name that differs between the build channels (the binary root and
# Uninstall key, the data root, the executable, the display names, the AUMID, the plugin file, the RunOnce value, the
# receipts and the versions) comes from the build that was made and from installer-guard.mjs (`versions` command), never
# from a production literal here. The labels keep the production versions A (0.1.0) and B (0.1.1) as names; the installed
# versions are the build's (0.1.0-stg000000 and 0.1.1-stg000000 in staging). Use-Channel selects the channel whose
# install root, key, names and driver config the helpers below work on. -Scenario side-by-side installs the production
# build and a staging Setup into one run root and checks that each channel's install, launch, uninstall and deferred
# cleanup leaves the other's alone ("Side-by-side scenario" in docs/installer-testing.md); it runs on a hosted runner only.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$planSteps = @('signal','facts','guard-plan','create-run-root','guard-ready','build-fixture-0.1.1','seed','install-0.1.0','icon-identity-install-0.1.0','installed-smokes-0.1.0',
    'data-launch-0.1.0','verify-0.1.0','repair-0.1.0',
    'legacy-icon-before-update-0.1.1','legacy-display-icon-before-update-0.1.1','legacy-names-before-update-0.1.1','update-0.1.1','icon-identity-update-0.1.1',
    'legacy-names-update-0.1.1','installed-smokes-0.1.1','data-launch-0.1.1','verify-0.1.1','games',
    'legacy-names-before-complete-running','windows-uninstall-complete-running','legacy-names-complete-running',
    'legacy-names-before-install-again-0.1.0','install-0.1.0-again','legacy-names-install-again-0.1.0','plugin-launch-installed','windows-uninstall-deferred-game','run-once-blocked-game',
    'reinstall-0.1.0-over-deferral','plugin-launch-adopted','windows-uninstall-final-deferred','run-once-complete',
    'install-0.1.0-for-app','plugin-launch-for-app','app-uninstall-blocked-game','app-uninstall-verify-blocked-game',
    'app-uninstall-complete','app-uninstall-verify-complete','cleanup')
$sideBySideSteps = @('signal','facts','verify-staging-input','guard-plan','create-run-root','guard-ready','games','install-production','install-staging','production-beside-staging',
    'run-values-planted','side-by-side-launch','windows-uninstall-production-beside-staging','staging-after-production-uninstall','reinstall-production',
    'plugin-launch-production-again','run-once-planted-production','channel-state-before-staging-uninstall','windows-uninstall-staging-deferred','run-once-staging-complete',
    'channel-compare-production','production-after-staging-uninstall','windows-uninstall-production-final','cleanup')
if ($Plan) {
    [ordered]@{run=$false; scenario=$Scenario; steps=$(if ($Scenario -eq 'side-by-side') { $sideBySideSteps } else { $planSteps }); scenariosA=$ScenariosA; scenariosB=$ScenariosB;
        setup='the Setup of the build named by apps/desktop/dist/build-evidence.json'; sideBySideStaging='the staging Setup of -StagingInput (side-by-side-input.mjs)';
        setupChannels='production on a GitHub-hosted runner only; staging on a hosted runner or under -AllowLocal'; uninstall='windows-initiated and in-app, in R only';
        localRuns='only with -AllowLocal on an explicit owner request, and only with a staging Setup'; applicationLaunched=$false} | ConvertTo-Json
    return
}
if ($Scenario -eq 'side-by-side' -and !$StagingInput) { throw 'SIDE_BY_SIDE_INPUT_MISSING: -Scenario side-by-side needs -StagingInput.' }
if ($Scenario -ne 'side-by-side' -and $StagingInput) { throw 'STAGING_INPUT_UNEXPECTED: -StagingInput is given only with -Scenario side-by-side.' }
# The CI signal comes first, before any registry, process or file-system read. installer-guard.mjs repeats it.
$hosted = $env:GITHUB_ACTIONS -ceq 'true' -and $env:RUNNER_ENVIRONMENT -ceq 'github-hosted'
if (!$hosted -and !$AllowLocal) {
    throw 'LOCAL_RUN_REFUSED: the installer lifecycle runs only on a GitHub-hosted runner; dispatch Windows CI instead (docs/installer-testing.md).'
}
$node = (Get-Command node -ErrorAction Stop).Source
$driver = Join-Path $PSScriptRoot 'installer-lifecycle.mjs'
# ET-055 PR-4 (UP13): the Setup is the one of the build that was made (scripts/build-channel.mjs --built), with the versioned
# name of forge.config.cjs (ET-018 PR-6). Outside a GitHub-hosted runner only a staging Setup may be installed, never the
# production identity of the owner's installed application; a production Setup runs on a hosted runner only, and so does
# the side-by-side scenario. installer-guard.mjs (checkSetupChannel) repeats the rule. ET-055 PR-5: the staging lifecycle
# runs with the staging build's own install root, names and versions.
$builtText = & $node (Join-Path $checkout 'scripts/build-channel.mjs') --built
if ($LASTEXITCODE -ne 0) { throw 'Build evidence unavailable: run npm run make first.' }
$built = ($builtText -join "`n") | ConvertFrom-Json
if ($built.channel -ceq 'production' -and !$hosted) {
    throw 'LOCAL_PRODUCTION_REFUSED: a local run installs only a staging Setup; production runs on a GitHub-hosted runner (docs/installer-testing.md).'
}
if ($built.channel -cnotin @('production', 'staging')) { throw 'Build evidence names no known channel.' }
$setup = Join-Path $checkout ('out/make/squirrel.windows/x64/' + $built.setup)
if (!(Test-Path -LiteralPath $setup -PathType Leaf)) { throw 'Squirrel Setup.exe missing: run npm run make first.' }
# The channels this run installs, each with its Setup and application version: the build's own, and for the side-by-side
# scenario the production build of this checkout and the verified staging input beside it.
$channelBuilds = [ordered]@{}
$channelBuilds[[string]$built.channel] = [ordered]@{setup=$setup; appVersion=[string]$built.version}
if ($Scenario -eq 'side-by-side') {
    if (!$hosted -or $AllowLocal) { throw 'SIDE_BY_SIDE_HOSTED_ONLY: the side-by-side scenario installs production and runs on a GitHub-hosted runner only.' }
    if ($built.channel -cne 'production') { throw 'SIDE_BY_SIDE_NEEDS_PRODUCTION_BUILD: the checkout must hold the production build beside the staging input.' }
    # Checked before anything else: a staging build of this checkout, its Setup with the recorded bytes.
    $inputText = & $node (Join-Path $PSScriptRoot 'side-by-side-input.mjs') verify ([IO.Path]::GetFullPath($StagingInput))
    if ($LASTEXITCODE -ne 0) { throw 'SIDE_BY_SIDE_INPUT_REFUSED: the staging input failed its check (side-by-side-input.mjs verify).' }
    $stagingInput = ($inputText -join "`n") | ConvertFrom-Json
    $channelBuilds['staging'] = [ordered]@{setup=[string]$stagingInput.setupPath; appVersion=[string]$stagingInput.build.version}
}
# Each channel's identity and versions from installer-guard.mjs (lifecycleIdentity, lifecycleVersions).
$identities = @{}
foreach ($name in @($channelBuilds.Keys)) {
    $line = & $node (Join-Path $PSScriptRoot 'installer-lifecycle.mjs') versions $name $channelBuilds[$name].appVersion | Select-Object -Last 1
    $planLine = $line | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $planLine.passed -ne $true) { throw ('LIFECYCLE_VERSIONS_REFUSED for ' + $name) }
    $channelBuilds[$name].versions = $planLine.plan.versions
    foreach ($identity in @($planLine.plan.identities)) { $identities[[string]$identity.channel] = $identity }
}
$runChannels = @($channelBuilds.Keys)
# Compiled before the environment changes below: Windows PowerShell's Add-Type needs the real TEMP.
if (-not ('ETS2Telemetry.Diagnostics.BoundedProcess' -as [type])) { Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs') }
# ET-045g: the pixels the Windows shell draws for icon 0 of a file at its large and small sizes (ExtractIconEx); it only
# reads the file. No System.Drawing, so Windows PowerShell 5.1 and PowerShell 7 compile it alike.
if (-not ('ETS2Telemetry.Diagnostics.ShellIconPixels' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace ETS2Telemetry.Diagnostics {
  public sealed class IconPixels { public int Width; public int Height; public byte[] Pixels; }
  public static class ShellIconPixels {
    [StructLayout(LayoutKind.Sequential)] struct IconInfo { public int IsIcon; public int HotspotX; public int HotspotY; public IntPtr Mask; public IntPtr Color; }
    [StructLayout(LayoutKind.Sequential)] struct Bitmap { public int Type; public int Width; public int Height; public int WidthBytes; public ushort Planes; public ushort BitsPixel; public IntPtr Bits; }
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfoHeader {
      public uint Size; public int Width; public int Height; public ushort Planes; public ushort BitCount; public uint Compression; public uint SizeImage;
      public int XPelsPerMeter; public int YPelsPerMeter; public uint ClrUsed; public uint ClrImportant;
    }
    // Room for the three colour masks GetDIBits may write after the header.
    [StructLayout(LayoutKind.Sequential)] struct BitmapInfo { public BitmapInfoHeader Header; public uint Mask0; public uint Mask1; public uint Mask2; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern uint ExtractIconExW(string file, int index, IntPtr[] large, IntPtr[] small, uint icons);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern int GetObjectW(IntPtr handle, int size, out Bitmap bitmap);
    [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint start, uint lines, byte[] bits, ref BitmapInfo info, uint usage);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

    // The large and the small icon 0 of `file`, as top-down 32-bit pixels; every handle is released.
    public static IconPixels[] Read(string file) {
      IntPtr[] large = new IntPtr[1], small = new IntPtr[1];
      ExtractIconExW(file, 0, large, small, 1);
      try {
        if (large[0] == IntPtr.Zero || small[0] == IntPtr.Zero) throw new InvalidOperationException("ICON_NOT_EXTRACTED");
        return new IconPixels[] { Pixels(large[0]), Pixels(small[0]) };
      } finally {
        if (large[0] != IntPtr.Zero) DestroyIcon(large[0]);
        if (small[0] != IntPtr.Zero) DestroyIcon(small[0]);
      }
    }
    static IconPixels Pixels(IntPtr icon) {
      IconInfo info;
      if (!GetIconInfo(icon, out info)) throw new InvalidOperationException("ICON_INFO_FAILED");
      try {
        if (info.Color == IntPtr.Zero) throw new InvalidOperationException("ICON_WITHOUT_COLOR");
        Bitmap bitmap;
        if (GetObjectW(info.Color, Marshal.SizeOf(typeof(Bitmap)), out bitmap) == 0 || bitmap.Width < 1 || bitmap.Height < 1 || bitmap.Width > 512 || bitmap.Height > 512)
          throw new InvalidOperationException("ICON_BITMAP_INVALID");
        BitmapInfo header = new BitmapInfo();
        header.Header.Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader));
        header.Header.Width = bitmap.Width; header.Header.Height = -bitmap.Height; header.Header.Planes = 1; header.Header.BitCount = 32;
        byte[] bits = new byte[bitmap.Width * bitmap.Height * 4];
        IntPtr dc = GetDC(IntPtr.Zero);
        try { if (GetDIBits(dc, info.Color, 0, (uint)bitmap.Height, bits, ref header, 0) != bitmap.Height) throw new InvalidOperationException("ICON_PIXELS_UNREAD"); }
        finally { ReleaseDC(IntPtr.Zero, dc); }
        IconPixels result = new IconPixels();
        result.Width = bitmap.Width; result.Height = bitmap.Height; result.Pixels = bits;
        return result;
      } finally {
        if (info.Color != IntPtr.Zero) DeleteObject(info.Color);
        if (info.Mask != IntPtr.Zero) DeleteObject(info.Mask);
      }
    }
  }
}
'@
}

$id = [guid]::NewGuid().ToString('N')
$evidence = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('installer-' + $id + '-evidence')
# R lives in the runner's temporary folder on CI, which is never uploaded; without one, beside the evidence.
$runParent = if ($env:RUNNER_TEMP) { [IO.Path]::GetFullPath($env:RUNNER_TEMP) } else { [IO.Path]::GetFullPath($OutputRoot) }
$runRoot = Join-Path $runParent ('installer-' + $id)
$base = Join-Path $runRoot 'LocalAppData'
# ET-018 PR-5: this run's own RunOnce key; the test install registers its deferred-cleanup executor here, never under the
# real RunOnce key. The whole key is deleted at the end. Both channels' values (ETS2TelemetryUninstall,
# ETS2TelemetryStagingUninstall) live in it.
$testKey = 'Software\ETS2Telemetry-Test-' + $id
$runOnceKey = 'HKCU\' + $testKey + '\RunOnce'
New-Item -ItemType Directory -Path $evidence | Out-Null
# One driver config per channel: config.json for the lifecycle, config-<channel>.json for each side-by-side channel, which
# names the other as its peer and gives each channel its own profile (so neither hands over to the other's instance lock).
$configs = @{}
foreach ($name in $runChannels) {
    $configs[$name] = if ($Scenario -eq 'side-by-side') { Join-Path $evidence ('config-' + $name + '.json') } else { Join-Path $evidence 'config.json' }
}
foreach ($name in $runChannels) {
    $record = [ordered]@{runRoot=$runRoot; evidence=$evidence; setup=$channelBuilds[$name].setup; stepBudgetMs=55000; allowLocal=[bool]$AllowLocal; runOnceKey=$runOnceKey;
        channel=$name; channels=$runChannels; appVersion=$channelBuilds[$name].appVersion}
    if ($Scenario -eq 'side-by-side') {
        $peers = [ordered]@{}
        foreach ($other in $runChannels) { if ($other -cne $name) { $peers[$other] = $configs[$other] } }
        $record.peers = $peers
        $record.profileDir = Join-Path $runRoot ('profile-' + $name)
    }
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configs[$name] -Encoding utf8
}
$report = [ordered]@{passed=$false; failure=$null; scenario=$Scenario; channels=$runChannels; startedUtc=[datetime]::UtcNow.ToString('o'); scenariosA=$ScenariosA; scenariosB=$ScenariosB;
    steps=@(); uninstallRun=$false; runRootRemoved=$false; registrationRemoved=$false; shortcuts=$hosted; uninstalls=@()}
$clock = [Diagnostics.Stopwatch]::StartNew()

$uninstallParent = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
# The channel the helpers below work on: its identity, binary root, HKCU Uninstall key and driver config.
$activeChannel = $null; $product = $null; $binaryRoot = $null; $uninstallKey = $null; $configFile = $null
function Use-Channel([string]$Channel) {
    if (!$script:identities.ContainsKey($Channel)) { throw ('CHANNEL_UNKNOWN: ' + $Channel) }
    $script:activeChannel = $Channel
    $script:product = $script:identities[$Channel]
    $script:binaryRoot = Join-Path $base $script:product.productRoot
    $script:uninstallKey = $uninstallParent + '\' + $script:product.productRoot
    $script:configFile = $script:configs[$Channel]
}
Use-Channel $runChannels[0]

$registryViews = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
function Read-RegistrationView([Microsoft.Win32.RegistryView]$View, [string]$Key = $script:uninstallKey) {
    # The HKCU uninstall key Squirrel writes, in one registry view; only read here. ET-045g adds DisplayIcon, which the
    # driver's installed command reduces to its shape (classifyRegistrationIcon); the value itself never reaches the evidence.
    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $View)
    try {
        $key = $hive.OpenSubKey($Key, $false)
        if (!$key) { return $null }
        try { return [ordered]@{installLocation=$key.GetValue('InstallLocation'); displayVersion=$key.GetValue('DisplayVersion'); uninstallString=$key.GetValue('UninstallString');
            displayIcon=$key.GetValue('DisplayIcon'); displayName=$key.GetValue('DisplayName'); publisher=$key.GetValue('Publisher')} }
        finally { $key.Dispose() }
    } finally { $hive.Dispose() }
}
function Read-Registration([string]$Key = $script:uninstallKey) {
    foreach ($view in $registryViews) { $row = Read-RegistrationView $view $Key; if ($row) { return $row } }
    return $null
}
function Read-UninstallEntries {
    # ET-045h: every HKCU Uninstall subkey, per registry view, whose InstallLocation names a folder inside R: one install
    # must keep one entry (checkUninstallEntries). Read only, at most 1024 subkeys per view; the rows travel only in the
    # facts variable.
    $rows = @()
    foreach ($view in $registryViews) {
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
        try {
            $parent = $hive.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
            if (!$parent) { continue }
            try {
                foreach ($name in @($parent.GetSubKeyNames() | Select-Object -First 1024)) {
                    $key = $parent.OpenSubKey($name, $false)
                    if (!$key) { continue }
                    try { $location = [string]$key.GetValue('InstallLocation') } finally { $key.Dispose() }
                    if ($location -and $location.StartsWith($runRoot, [StringComparison]::OrdinalIgnoreCase)) {
                        $rows += ,[ordered]@{view=[string]$view; name=$name; installLocation=$location}
                    }
                }
            } finally { $parent.Dispose() }
        } finally { $hive.Dispose() }
    }
    return ,$rows
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
    # ET-055 PR-5: both channels' real binary roots and HKCU uninstall keys, for the preflight of the run's channels, and
    # the active channel's as `registration`, `realBinaryRootExists` and `registrationExists` for the command at hand.
    $realBinaryRoots = [ordered]@{}; $registrations = [ordered]@{}
    foreach ($identity in $script:identities.Values) {
        $realBinaryRoots[[string]$identity.channel] = Test-Path -LiteralPath (Join-Path $real.localAppData $identity.productRoot)
        $registrations[[string]$identity.channel] = Read-Registration ($uninstallParent + '\' + $identity.productRoot)
    }
    $registration = $registrations[$script:activeChannel]
    $facts = [ordered]@{real=$real; channel=$script:activeChannel; realBinaryRootExists=$realBinaryRoots[$script:activeChannel]; registrationExists=($null -ne $registration);
        registration=$registration; realBinaryRoots=$realBinaryRoots; registrations=$registrations; uninstallEntries=(Read-UninstallEntries); steamPath=$steamPath;
        libraryFolders=$libraryFolders; libraryFoldersState=$libraryFoldersState; processes=@(Get-Process | ForEach-Object { $_.ProcessName + '.exe' } | Sort-Object -Unique)}
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
    # The registration and the binary root must lie in R; otherwise abort at once, with no uninstall. The driver also
    # records icon-<label>.json (ET-045g): the DisplayIcon shape and the hash of the binary root's app.ico. ET-045h: it also
    # checks the DisplayName, the Publisher and the one Uninstall entry in R, and version-info the installed executable's
    # version resource, which names the shortcuts.
    Invoke-Driver 'installed' @($Label, $Version) 30000
    Invoke-Driver 'version-info' @($Label, $Version) 30000
    $registration = Read-Registration
    if ($registration.displayVersion -cne $Version) { throw ('Registered version differs after ' + $Label) }
    $executable = Join-Path $binaryRoot ('app-' + $Version + '\' + $product.executable)
    if (!(Test-Path -LiteralPath $executable -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $binaryRoot 'Update.exe') -PathType Leaf)) { throw ('Installed files missing after ' + $Label) }
    return $executable
}
function Get-IconDigest([string]$File) {
    # The large and small shell icon 0 of one file: their sizes and the SHA-256 of their pixels, never the file's path.
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return ,@([ETS2Telemetry.Diagnostics.ShellIconPixels]::Read($File) | ForEach-Object {
            [ordered]@{width=$_.Width; height=$_.Height; sha256=([BitConverter]::ToString($sha.ComputeHash([byte[]]$_.Pixels)).Replace('-', '').ToLowerInvariant())}
        })
    } finally { $sha.Dispose() }
}
function Assert-IconIdentity([string]$Label, [string]$Version) {
    # ET-045g: what the shell draws for icon 0 of the installed executable (DisplayIcon) and of the binary root's app.ico
    # must be the same pixels at the large and the small shell size. icon-identity-<label>.json keeps sizes and hashes only.
    $started = $clock.Elapsed.TotalSeconds
    $executable = Get-IconDigest (Join-Path $binaryRoot ('app-' + $Version + '\' + $product.executable))
    $rootIcon = Get-IconDigest (Join-Path $binaryRoot 'app.ico')
    $equal = $executable.Count -eq 2 -and $rootIcon.Count -eq 2
    for ($index = 0; $equal -and $index -lt 2; $index++) {
        $equal = $executable[$index].width -eq $rootIcon[$index].width -and $executable[$index].height -eq $rootIcon[$index].height -and
            $executable[$index].sha256 -ceq $rootIcon[$index].sha256
    }
    $record = [ordered]@{label=$Label; version=$Version; sizes=@('large','small'); executable=$executable; rootIcon=$rootIcon; equal=$equal}
    ConvertTo-Json -InputObject $record -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence ('icon-identity-' + $Label + '.json')) -Encoding utf8
    $script:report.steps += ,[ordered]@{step=('icon-identity-' + $Label); equal=$equal; seconds=[math]::Round($clock.Elapsed.TotalSeconds - $started, 1)}
    if (!$equal) { throw ('ICON_IDENTITY_DIFFERS after ' + $Label) }
}
function Set-LegacyIcon([string]$Label) {
    # ET-045g: the state an install made before the fix keeps until its next update: Squirrel's downloaded Electron icon at
    # the binary root's app.ico and DisplayIcon pointing at it. The driver plants the file after checkInstalled and decides
    # per registry view whether the key points into R (ownsRegistration); only those keys get the value. The update that
    # follows must replace both (Assert-Installed).
    $locations = @($registryViews | ForEach-Object {
        $row = Read-RegistrationView $_
        if ($row -and $row.installLocation) { [string]$row.installLocation } else { '-' }
    })
    Invoke-Driver 'legacy-icon' (@($Label) + $locations) 30000
    $result = (Get-Content -LiteralPath (Join-Path $evidence ('legacy-icon-' + $Label + '.json')) -Raw | ConvertFrom-Json).result
    $owned = @($result.ownsRegistration)
    if ($owned.Count -ne $registryViews.Count) { throw 'legacy-icon returned no decision per registry view.' }
    $planted = Join-Path $binaryRoot 'app.ico'
    $set = 0
    for ($index = 0; $index -lt $registryViews.Count; $index++) {
        if ($owned[$index] -ne $true) { continue }
        $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryViews[$index])
        try {
            $key = $hive.OpenSubKey($uninstallKey, $true)
            if ($key) { try { $key.SetValue('DisplayIcon', $planted, [Microsoft.Win32.RegistryValueKind]::String); $set++ } finally { $key.Dispose() } }
        } finally { $hive.Dispose() }
    }
    $script:report.steps += ,[ordered]@{step=('legacy-display-icon-' + $Label); viewsSet=$set}
    if ($set -lt 1 -or (Read-Registration).displayIcon -cne $planted) { throw ('LEGACY_ICON_NOT_PLANTED before ' + $Label) }
}

$shortcutFolders = [ordered]@{desktop=[Environment]::GetFolderPath('DesktopDirectory'); 'start-menu'=[Environment]::GetFolderPath('Programs')}
function Find-ProductLinkFiles([string]$Root = $binaryRoot) {
    # Shortcuts (.lnk) on the Desktop and in the Start menu whose target lies in the active channel's binary root in R (or
    # `Root`); read only. Each row keeps the file for this session only; the evidence gets the location, the folder relative
    # to it and the name (Get-ProductLinks).
    $shell = New-Object -ComObject WScript.Shell
    $rows = @()
    try {
        foreach ($location in $shortcutFolders.Keys) {
            $folder = $shortcutFolders[$location]
            if (!$folder -or !(Test-Path -LiteralPath $folder)) { continue }
            foreach ($item in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File -ErrorAction SilentlyContinue)) {
                $link = $shell.CreateShortcut($item.FullName)
                try { $target = $link.TargetPath } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
                if (!$target -or ![IO.Path]::GetFullPath($target).StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { continue }
                $relative = $item.DirectoryName.Substring([IO.Path]::GetFullPath($folder).TrimEnd('\').Length).TrimStart('\')
                $rows += ,[ordered]@{file=$item.FullName; location=$location; folder=$relative; name=[IO.Path]::GetFileNameWithoutExtension($item.Name)}
            }
        }
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    return ,$rows
}
function Get-ProductLinks {
    # ET-045h: names only, as `<location>|<folder>|<name>` for the driver's links command.
    # Find-ProductLinkFiles returns its rows as one array; the assignment unwraps it before the pipeline.
    $files = Find-ProductLinkFiles
    return ,@($files | ForEach-Object { $_.location + '|' + $_.folder + '|' + $_.name })
}
function Get-LinkAumid([string]$File) {
    # ET-055 PR-5: the shortcut's System.AppUserModel.ID, which Squirrel sets to com.squirrel.<id>.<exe>, through the
    # shell's property system; read only. An empty string when the shell reports none.
    $shellApplication = New-Object -ComObject Shell.Application
    try {
        $folder = $shellApplication.Namespace([IO.Path]::GetDirectoryName($File))
        if ($null -eq $folder) { return '' }
        $item = $folder.ParseName([IO.Path]::GetFileName($File))
        if ($null -eq $item) { return '' }
        return [string]$item.ExtendedProperty('System.AppUserModel.ID')
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellApplication) | Out-Null }
}
$linkFolders = $null
function Assert-ProductLinks([string]$Label, [bool]$Installed, [switch]$WithAumid) {
    # A test install creates shortcuts only on a GitHub-hosted runner (its test file says so), and an uninstall removes them.
    # ET-045h: an install leaves exactly one shortcut of the channel's display name on the Desktop and one in the Start
    # menu's company folder, and none of an old name (checkProductLinks). The first time, the folders of those two are kept
    # for Set-LegacyNames, so the old names go where Squirrel itself put the shortcuts. ET-055 PR-5: -WithAumid also passes
    # each current-name shortcut's AUMID, which must be the channel's own (checkShortcutIdentities).
    $rows = Get-ProductLinks
    $expectation = if ($Installed -and $hosted) { 'installed' } else { 'none' }
    $script:report.steps += ,[ordered]@{step=('shortcuts-' + $Label); productLinks=$rows.Count; expectation=$expectation}
    $identityRows = @()
    if ($WithAumid -and $expectation -eq 'installed') {
        foreach ($row in (Find-ProductLinkFiles)) {
            if ($row.name -cne $product.displayName) { continue }
            $aumid = Get-LinkAumid $row.file
            # The AUMID is a fixed name, never a path; the evidence keeps it so that a mismatch can be read at once.
            $script:report.steps += ,[ordered]@{step=('shortcut-aumid-' + $Label); channel=$activeChannel; location=$row.location; aumid=$aumid; expected=$product.appUserModelId}
            if (!$aumid) {
                throw ('SIDE_BY_SIDE_AUMID_UNREADABLE after ' + $Label + ': the shell returned no System.AppUserModel.ID for the ' + $activeChannel + ' ' + $row.location +
                    ' shortcut (Shell.Application ExtendedProperty); expected ' + $product.appUserModelId)
            }
            $identityRows += ,($row.location + '|' + $row.name + '|' + $aumid)
        }
        $identityRows = @('--aumid') + $identityRows
    }
    Invoke-Driver 'links' (@($Label, $expectation) + $rows + $identityRows) 30000
    if ($expectation -eq 'installed' -and $null -eq $script:linkFolders) {
        $folders = @{}
        # [IO.Path]::GetDirectoryName, not Split-Path: -LiteralPath and -Parent are in different parameter sets (hosted run 40134013831).
        foreach ($row in (Find-ProductLinkFiles)) { if ($row.name -ceq $product.displayName) { $folders[$row.location] = [IO.Path]::GetDirectoryName($row.file) } }
        if ($folders.Count -ne 2) { throw ('PRODUCT_SHORTCUT_FOLDERS_UNKNOWN after ' + $Label) }
        $script:linkFolders = $folders
    }
}
# ET-045h: the old-name shortcuts this run planted: the file, its SHA-256 and whether the hook must remove it (owned) or
# keep it byte-identical (decoy). The finally block deletes any that is left with the bytes it was planted with.
$plantedLinks = [Collections.Generic.List[object]]::new()
function New-PlantedLink([string]$File, [string]$Target, [string]$WorkingDirectory, [string]$Kind, [string]$Label) {
    if (Test-Path -LiteralPath $File) { throw ('PLANT_TARGET_EXISTS before ' + $Label) }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($File)
        try { $link.TargetPath = $Target; $link.WorkingDirectory = $WorkingDirectory; $link.Save() }
        finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) | Out-Null }
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
    if (!(Test-Path -LiteralPath $File -PathType Leaf)) { throw ('PLANT_FAILED before ' + $Label) }
    $script:plantedLinks.Add([ordered]@{file=$File; sha256=(Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash; kind=$Kind; label=$Label})
}
function Set-LegacyNames([string]$Label, [string]$Mode, [string]$Version) {
    # ET-045h: the state an install made before ET-045h leaves behind (hosted only: only there does the test install manage
    # shortcuts). `update` (L1): an owned "ETS2Telemetry Desktop" shortcut in the Start menu folder, a foreign decoy of that
    # name on the Desktop (its target lies outside the binary root) and the old DisplayName and Publisher, only in the
    # registry views whose key the driver says points into R. `orphans` (L2): owned old-name shortcuts in both folders after
    # an uninstall. `uninstall` (L3): an owned old-name shortcut in the Start menu folder. Owned ones target Squirrel's stub.
    if (!$hosted) { throw ('LEGACY_NAMES_HOSTED_ONLY before ' + $Label) }
    if ($null -eq $script:linkFolders) { throw ('LEGACY_NAMES_FOLDERS_UNKNOWN before ' + $Label) }
    if (@($product.legacyDisplayNames).Count -lt 1) { throw ('LEGACY_NAMES_CHANNEL_HAS_NONE before ' + $Label) }
    $stub = Join-Path $binaryRoot $product.executable
    $workingDirectory = Join-Path $binaryRoot ('app-' + $Version)
    $oldName = [string]@($product.legacyDisplayNames)[0]
    $old = $oldName + '.lnk'
    $startMenu = Join-Path $script:linkFolders['start-menu'] $old
    $desktop = Join-Path $script:linkFolders['desktop'] $old
    $registryViewsSet = 0
    switch ($Mode) {
        'update' {
            New-PlantedLink $startMenu $stub $workingDirectory 'owned' $Label
            New-PlantedLink $desktop (Join-Path $runRoot ('decoy-target\' + $product.executable)) (Join-Path $runRoot 'decoy-target') 'decoy' $Label
            $locations = @($registryViews | ForEach-Object {
                $row = Read-RegistrationView $_
                if ($row -and $row.installLocation) { [string]$row.installLocation } else { '-' }
            })
            Invoke-Driver 'legacy-names' (@($Label) + $locations) 30000
            $owned = @((Get-Content -LiteralPath (Join-Path $evidence ('legacy-names-' + $Label + '.json')) -Raw | ConvertFrom-Json).result.ownsRegistration)
            if ($owned.Count -ne $registryViews.Count) { throw 'legacy-names returned no decision per registry view.' }
            for ($index = 0; $index -lt $registryViews.Count; $index++) {
                if ($owned[$index] -ne $true) { continue }
                $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryViews[$index])
                try {
                    $key = $hive.OpenSubKey($uninstallKey, $true)
                    if ($key) {
                        try {
                            $key.SetValue('DisplayName', $oldName, [Microsoft.Win32.RegistryValueKind]::String)
                            $key.SetValue('Publisher', 'ETS2Telemetry contributors', [Microsoft.Win32.RegistryValueKind]::String)
                            $registryViewsSet++
                        } finally { $key.Dispose() }
                    }
                } finally { $hive.Dispose() }
            }
            $registration = Read-Registration
            if ($registryViewsSet -lt 1 -or $registration.displayName -cne $oldName -or $registration.publisher -cne 'ETS2Telemetry contributors') {
                throw ('LEGACY_NAMES_NOT_PLANTED before ' + $Label)
            }
        }
        'orphans' { New-PlantedLink $desktop $stub $workingDirectory 'owned' $Label; New-PlantedLink $startMenu $stub $workingDirectory 'owned' $Label }
        'uninstall' { New-PlantedLink $startMenu $stub $workingDirectory 'owned' $Label }
        default { throw ('LEGACY_NAMES_MODE_INVALID: ' + $Mode) }
    }
    $script:report.steps += ,[ordered]@{step=('legacy-names-' + $Label); mode=$Mode; plantedLinks=@($script:plantedLinks | Where-Object { $_.label -ceq $Label }).Count;
        registryViewsSet=$registryViewsSet}
}
function Assert-LegacyNames([string]$Label, [string]$Planted) {
    # ET-045h: after the step that follows Set-LegacyNames $Planted, every owned old-name shortcut is gone and the decoy is
    # byte-identical; the decoy is then deleted. The current-name shortcuts are Assert-ProductLinks's part.
    $removed = 0; $kept = 0
    foreach ($row in @($script:plantedLinks | Where-Object { $_.label -ceq $Planted })) {
        $present = Test-Path -LiteralPath $row.file -PathType Leaf
        if ($row.kind -ceq 'owned') {
            if ($present) { throw ('LEGACY_SHORTCUT_NOT_REMOVED after ' + $Label) }
            $removed++
        } else {
            if (!$present -or (Get-FileHash -LiteralPath $row.file -Algorithm SHA256).Hash -cne $row.sha256) { throw ('FOREIGN_SHORTCUT_CHANGED after ' + $Label) }
            Remove-Item -LiteralPath $row.file
            $kept++
        }
        [void]$script:plantedLinks.Remove($row)
    }
    $script:report.steps += ,[ordered]@{step=('legacy-names-' + $Label); ownedRemoved=$removed; decoysKept=$kept}
}
function Remove-PlantedLinks {
    # ET-045h, in the finally block: an old-name shortcut this run planted and a hook did not remove is deleted, but only
    # with its planted bytes; a changed or foreign file stays. A failure is recorded and never stops the cleanup.
    foreach ($row in @($script:plantedLinks)) {
        try {
            if ((Test-Path -LiteralPath $row.file -PathType Leaf) -and (Get-FileHash -LiteralPath $row.file -Algorithm SHA256).Hash -ceq $row.sha256) { Remove-Item -LiteralPath $row.file }
        } catch { $script:report.plantedLinkCleanupFailure = $_.Exception.Message }
    }
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

# --- ET-055 PR-5: both channels side by side in one run root (docs/installer-testing.md, "Side-by-side scenario") ------

$runKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
# The autostart values this run planted: the value name (the channel's AUMID, which Electron uses as the Run value name)
# and the data. The finally block deletes each one that still holds its planted data.
$plantedRunValues = [Collections.Generic.List[object]]::new()
function Get-RunValue([string]$Channel) {
    # The channel's HKCU Run value (named by its AUMID), or $null; read only.
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKey, $false)
    if (!$key) { return $null }
    try { return $key.GetValue([string]$identities[$Channel].appUserModelId) } finally { $key.Dispose() }
}
function Set-PlantedRunValue([string]$Channel) {
    # Hosted side-by-side runs only: plants the channel's autostart value under its own name (the AUMID) in the shape
    # Electron writes, pointing at the channel's Update.exe in R, so that the other channel's install, launch and uninstall
    # can be shown to leave it alone. A trailing marker argument keeps it from matching the application's own login item,
    # which the application's startup reconciliation would otherwise remove (autostart off). Refuses an existing value.
    if (!$hosted -or $Scenario -ne 'side-by-side') { throw ('RUN_VALUE_PLANT_HOSTED_ONLY for ' + $Channel) }
    if ($null -ne (Get-RunValue $Channel)) { throw ('RUN_VALUE_EXISTS for ' + $Channel) }
    $identity = $identities[$Channel]
    $data = '"' + (Join-Path (Join-Path $base $identity.productRoot) 'Update.exe') + '" --processStart "' + $identity.executable +
        '" --process-start-args "--hidden" --installer-lifecycle-planted'
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($runKey)
    try { $key.SetValue([string]$identity.appUserModelId, $data, [Microsoft.Win32.RegistryValueKind]::String) } finally { $key.Dispose() }
    $script:plantedRunValues.Add([ordered]@{name=[string]$identity.appUserModelId; data=$data})
    if ((Get-RunValue $Channel) -cne $data) { throw ('RUN_VALUE_NOT_PLANTED for ' + $Channel + ': the HKCU Run value ' + $identity.appUserModelId + ' does not read back as written') }
    $script:report.steps += ,[ordered]@{step=('run-value-planted-' + $Channel)}
}
function Assert-PlantedRunValuesKept([string]$Label) {
    # After a step in which only applications ran (no uninstall): every planted value still holds its planted data. If an
    # application's own startup removed its value, the marker argument did not keep it apart from the application's login
    # item: Electron's login-item query then does not compare the whole command, and the Run value checks need another plan.
    foreach ($row in @($script:plantedRunValues)) {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKey, $false)
        $value = $null
        if ($key) { try { $value = $key.GetValue($row.name) } finally { $key.Dispose() } }
        if ($value -cne $row.data) {
            throw ('RUN_VALUE_MARKER_IGNORED after ' + $Label + ': the planted HKCU Run value ' + $row.name + ' is ' + $(if ($null -eq $value) { 'gone' } else { 'changed' }) +
                ' although only applications ran; the application''s startup reconciliation (autostart off) treated the marked value as its own login item')
        }
    }
    $script:report.steps += ,[ordered]@{step=('run-values-kept-' + $Label); values=$script:plantedRunValues.Count}
}
function Remove-PlantedRunValues {
    # In the finally block: a planted autostart value that still holds its planted data is deleted; any other stays.
    foreach ($row in @($script:plantedRunValues)) {
        try {
            $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($runKey, $true)
            if ($key) { try { if ($key.GetValue($row.name) -ceq $row.data) { $key.DeleteValue($row.name, $false) } } finally { $key.Dispose() } }
        } catch { $script:report.runValueCleanupFailure = $_.Exception.Message }
    }
}
function Get-TextDigest([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Get-ChannelRegistryState([string]$Channel) {
    # What the other channel's actions must leave alone of this channel beyond its files (the driver's channel-state): the
    # HKCU Uninstall key's values per registry view, the channel's shortcuts with their bytes and AUMIDs, and its Run value.
    # Paths are hashed, so the JSON carries names, hashes and counts only.
    $identity = $identities[$Channel]
    $key = $uninstallParent + '\' + $identity.productRoot
    $views = @($registryViews | ForEach-Object {
        $row = Read-RegistrationView $_ $key
        if ($row) { Get-TextDigest ($row | ConvertTo-Json -Compress) } else { 'absent' }
    })
    # Find-ProductLinkFiles returns its rows as one array; the assignment unwraps it before the pipeline.
    $files = Find-ProductLinkFiles (Join-Path $base $identity.productRoot)
    $links = @($files | ForEach-Object {
        $_.location + '|' + $_.folder + '|' + $_.name + '|' + (Get-FileHash -LiteralPath $_.file -Algorithm SHA256).Hash + '|' + (Get-LinkAumid $_.file)
    } | Sort-Object)
    $run = Get-RunValue $Channel
    return ([ordered]@{channel=$Channel; uninstallViews=$views; links=$links; runValue=$(if ($null -eq $run) { 'absent' } else { Get-TextDigest ([string]$run) })} |
        ConvertTo-Json -Compress -Depth 3)
}
function Assert-ChannelRegistryUnchanged([string]$Channel, [string]$Before, [string]$Label) {
    # Compared part by part, so that the failure names what changed: the Uninstall key, the shortcuts or the Run value.
    $after = Get-ChannelRegistryState $Channel
    $was = $Before | ConvertFrom-Json; $now = $after | ConvertFrom-Json
    $changed = @(foreach ($part in @('uninstallViews', 'links', 'runValue')) {
        if (($was.$part | ConvertTo-Json -Compress) -cne ($now.$part | ConvertTo-Json -Compress)) { $part }
    })
    $script:report.steps += ,[ordered]@{step=('registry-state-' + $Label); channel=$Channel; unchanged=($changed.Count -eq 0); changed=$changed; before=$was; after=$now}
    if ($changed -contains 'uninstallViews') { throw ('OTHER_CHANNEL_UNINSTALL_ENTRY_CHANGED after ' + $Label + ': the ' + $Channel + ' HKCU Uninstall key changed') }
    if ($changed -contains 'links') { throw ('OTHER_CHANNEL_SHORTCUTS_CHANGED after ' + $Label + ': a ' + $Channel + ' shortcut (bytes or AUMID) changed, appeared or vanished') }
    if ($changed -contains 'runValue') {
        throw ('OTHER_CHANNEL_RUN_VALUE_CHANGED after ' + $Label + ': the planted ' + $Channel + ' Run value is ' + $now.runValue + ' (was ' + $was.runValue + '); the other ' +
            'channel''s uninstall removed or rewrote a login item that is not its own, or the ' + $Channel + ' application beside it removed its marked value at startup')
    }
}
function Invoke-SideBySide {
    # Both channels in one run root R (REG-017, REG-019): production from this checkout's build, staging from the verified
    # input. Each check names the channel it judges; Use-Channel selects the binary root, key, names and driver config.
    $setupProduction = $channelBuilds['production'].setup
    $setupStaging = $channelBuilds['staging'].setup
    $versionProduction = [string]$channelBuilds['production'].versions.a.installed
    $versionStaging = [string]$channelBuilds['staging'].versions.a.installed
    $script:report.setupSha256 = [ordered]@{production=(Get-FileHash -LiteralPath $setupProduction -Algorithm SHA256).Hash;
        staging=(Get-FileHash -LiteralPath $setupStaging -Algorithm SHA256).Hash}
    Use-Channel 'production'
    Invoke-Driver 'games' @() 30000

    # Both installs into one SQUIRREL_TEMP: separate binary roots, Uninstall keys, shortcuts (names and AUMIDs) and, once
    # they launch, data roots. Each Assert-Installed also sees the other channel's own Uninstall entry beside its own.
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\sbs-install-production'
    Invoke-Driver 'step' @('sbs-install-production', $setupProduction, '--silent') 60000
    $executableProduction = Assert-Installed 'sbs-install-production' $versionProduction
    Assert-ProductLinks 'sbs-install-production' $true -WithAumid
    Use-Channel 'staging'
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\sbs-install-staging'
    Invoke-Driver 'step' @('sbs-install-staging', $setupStaging, '--silent') 60000
    $executableStaging = Assert-Installed 'sbs-install-staging' $versionStaging
    Assert-IconIdentity 'sbs-install-staging' $versionStaging
    Assert-ProductLinks 'sbs-install-staging' $true -WithAumid
    Use-Channel 'production'
    $null = Assert-Installed 'sbs-production-beside-staging' $versionProduction
    Assert-ProductLinks 'sbs-production-beside-staging' $true -WithAumid
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    # Each channel's autostart value, named by its own AUMID.
    Set-PlantedRunValue 'production'
    Set-PlantedRunValue 'staging'

    # Both applications at once; each plugin setup installs only its own DLL into the fake ETS2 folder.
    Invoke-Driver 'side-by-side-launch' @('both-running', $executableProduction, $executableStaging) 60000
    # Both applications ran their startup autostart reconciliation; the marked values must have survived it.
    Assert-PlantedRunValuesKept 'both-running'

    # Production's Windows-initiated uninstall while the staging application runs: staging keeps running, and its
    # plugin, registration, shortcuts and Run value stay as they were.
    $stagingBefore = Get-ChannelRegistryState 'staging'
    $helper = Get-VendorHelper $versionProduction
    $script:report.uninstallRun = $true
    Invoke-Driver 'windows-uninstall' @('production-beside-staging', '-', 'complete', '--beside', $executableStaging) 60000
    Assert-Uninstalled 'production-beside-staging' $helper
    Assert-ChannelRegistryUnchanged 'staging' $stagingBefore 'production-beside-staging'
    Use-Channel 'staging'
    $null = Assert-Installed 'sbs-staging-after-production-uninstall' $versionStaging
    Assert-ProductLinks 'sbs-staging-after-production-uninstall' $true -WithAumid

    # Production again, with its plugin and autostart value.
    Use-Channel 'production'
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\sbs-reinstall-production'
    Invoke-Driver 'step' @('sbs-reinstall-production', $setupProduction, '--silent') 60000
    $executableProduction = Assert-Installed 'sbs-reinstall-production' $versionProduction
    Assert-ProductLinks 'sbs-reinstall-production' $true -WithAumid
    $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
    Invoke-Driver 'plugin-launch' @('sbs-production-again', $executableProduction, 'installed') 60000
    if ($null -eq (Get-RunValue 'production')) { Set-PlantedRunValue 'production' }

    # Staging's uninstall while the fake game runs (deferred, its executor registered), then its executor at the next
    # sign-in: production's data root, plugin, RunOnce value, registration, shortcuts and Run value stay as they were.
    Invoke-Driver 'plant-run-once' @('before-staging-uninstall') 30000
    Invoke-Driver 'channel-state' @('before-staging-uninstall') 30000
    $productionBefore = Get-ChannelRegistryState 'production'
    Use-Channel 'staging'
    $helper = Get-VendorHelper $versionStaging
    Invoke-Driver 'windows-uninstall' @('staging-deferred', '-', 'deferred') 60000
    Assert-Uninstalled 'staging-deferred' $helper
    Invoke-Driver 'run-once' @('staging-complete', 'complete') 60000
    Use-Channel 'production'
    Invoke-Driver 'channel-state' @('after-staging-uninstall') 30000
    Invoke-Driver 'channel-compare' @('before-staging-uninstall', 'after-staging-uninstall') 30000
    Assert-ChannelRegistryUnchanged 'production' $productionBefore 'staging-uninstall'
    $null = Assert-Installed 'sbs-production-after-staging-uninstall' $versionProduction
    Assert-ProductLinks 'sbs-production-after-staging-uninstall' $true -WithAumid

    # The end: production's own uninstall, so nothing of either channel is left installed.
    Invoke-Driver 'plant-run-once' @('before-staging-uninstall', 'remove') 30000
    $helper = Get-VendorHelper $versionProduction
    Invoke-Driver 'windows-uninstall' @('production-final', $executableProduction, 'complete') 60000
    Assert-Uninstalled 'production-final' $helper
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
    # One --channel per Setup the run installs; the driver refuses a production Setup outside a hosted runner.
    $signalArguments = @($runChannels | ForEach-Object { '--channel'; $_ })
    & $node $driver signal @signalArguments @(if ($AllowLocal) { '--allow-local' })
    if ($LASTEXITCODE -ne 0) { throw 'LOCAL_RUN_REFUSED: the guard module refused the run signal or the Setup channel.' }
    Invoke-Driver 'guard' @('plan') 30000
    $guarded = $true
    foreach ($folder in @($runRoot, $base, (Join-Path $runRoot 'temp'), (Join-Path $runRoot 'AppData'), (Join-Path $runRoot 'profile'), (Join-Path $runRoot 'cwd'),
        (Join-Path $runRoot 'diagnostics'), (Join-Path $runRoot 'exports'), (Join-Path $runRoot 'fixture'))) { New-Item -ItemType Directory -Path $folder | Out-Null }
    $utf8 = [Text.UTF8Encoding]::new($false)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-plugin-test-root.marker'), "Test root of the ETS2Telemetry installer lifecycle.`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $runRoot 'ets2telemetry-install-test.json'), (([ordered]@{format='ets2telemetry.install-test'; version=1;
        profileDir=(Join-Path $runRoot 'profile'); runOnceKey=$runOnceKey; shortcuts=$hosted}) | ConvertTo-Json), $utf8)
    Invoke-Driver 'guard' @('ready') 30000

    if ($Scenario -eq 'lifecycle') {
        # The installed (NuGet) versions A and B of the build's channel (lifecycleVersions); only a channel with names
        # before ET-045h (production) gets the legacy-name plants, and only a hosted install manages shortcuts.
        $versionA = [string]$channelBuilds[$activeChannel].versions.a.installed
        $versionB = [string]$channelBuilds[$activeChannel].versions.b.installed
        $legacyNames = $hosted -and @($product.legacyDisplayNames).Count -gt 0
        # Installer version B from a temporary copy of the packaged folder (a build step; it runs no installer).
        $started = $clock.Elapsed.TotalSeconds
        # forge.config.cjs, which the fixture reads, resolves the channel of the build that was made (ET-055 PR-5).
        $savedChannel = $env:ETS2TELEMETRY_BUILD_CHANNEL
        $env:ETS2TELEMETRY_BUILD_CHANNEL = $built.channel
        try { & $node (Join-Path $PSScriptRoot 'build-upgrade-fixture.mjs') (Join-Path $runRoot 'fixture') (Join-Path $evidence 'upgrade-fixture.json') }
        finally { $env:ETS2TELEMETRY_BUILD_CHANNEL = $savedChannel }
        if ($LASTEXITCODE -ne 0) { throw 'Upgrade fixture build failed.' }
        $report.steps += ,[ordered]@{step='build-fixture-0.1.1'; exitCode=0; seconds=[math]::Round($clock.Elapsed.TotalSeconds - $started, 1)}
        $report.setupSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash

        Invoke-Driver 'seed' @() 30000
        Invoke-Driver 'snapshot' @('seed') 30000

        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-0.1.0'
        Invoke-Driver 'step' @('install-0.1.0', $setup, '--silent') 60000
        $executableA = Assert-Installed 'install-0.1.0' $versionA
        Assert-IconIdentity 'install-0.1.0' $versionA
        Assert-ProductLinks 'install-0.1.0' $true
        Invoke-Driver 'snapshot' @('install-0.1.0') 30000
        Invoke-Driver 'compare' @('seed', 'install-0.1.0') 30000

        Invoke-InstalledSmoke $executableA $ScenariosA '0.1.0'
        Invoke-Driver 'launch' @('0.1.0', $executableA, '1') 60000
        Invoke-Driver 'verify' @('0.1.0', $executableA) 30000
        Invoke-Driver 'snapshot' @('launch-0.1.0') 30000

        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\repair-0.1.0'
        Invoke-Driver 'step' @('repair-0.1.0', $setup, '--silent') 60000
        $null = Assert-Installed 'repair-0.1.0' $versionA
        Assert-ProductLinks 'repair-0.1.0' $true
        Invoke-Driver 'snapshot' @('repair-0.1.0') 30000
        Invoke-Driver 'compare' @('launch-0.1.0', 'repair-0.1.0') 30000
        # ET-045g: an install made before the fix, which the update must give the product icon.
        Set-LegacyIcon 'before-update-0.1.1'
        # ET-045h L1: the old names of an install made before ET-045h; Update.exe --update runs --squirrel-updated.
        if ($legacyNames) { Set-LegacyNames 'before-update-0.1.1' 'update' $versionA }

        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\update-0.1.1'
        Invoke-Driver 'step' @('update-0.1.1', (Join-Path $binaryRoot 'Update.exe'), '--update', (Join-Path $runRoot 'fixture\feed')) 60000
        $executableB = Assert-Installed 'update-0.1.1' $versionB
        Assert-IconIdentity 'update-0.1.1' $versionB
        if ($legacyNames) { Assert-LegacyNames 'update-0.1.1' 'before-update-0.1.1' }
        Assert-ProductLinks 'update-0.1.1' $true
        Invoke-Driver 'snapshot' @('update-0.1.1') 30000
        Invoke-Driver 'compare' @('repair-0.1.0', 'update-0.1.1') 30000

        Invoke-InstalledSmoke $executableB $ScenariosB '0.1.1'
        Invoke-Driver 'launch' @('0.1.1', $executableB, 'none') 60000
        Invoke-Driver 'verify' @('0.1.1', $executableB) 30000

        # ET-018 PR-3: the Windows-initiated uninstall scenarios (docs/installer-testing.md, "Uninstall scenarios").
        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
        Invoke-Driver 'games' @() 30000
        $helper = Get-VendorHelper $versionB
        $report.uninstallRun = $true
        # ET-045h L3: an owned old-name shortcut, which the uninstall hook removes after --removeShortcut.
        if ($legacyNames) { Set-LegacyNames 'before-complete-running' 'uninstall' $versionB }
        Invoke-Driver 'windows-uninstall' @('complete-running', $executableB, 'complete') 60000
        Assert-Uninstalled 'complete-running' $helper
        if ($legacyNames) { Assert-LegacyNames 'complete-running' 'before-complete-running' }

        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-again-0.1.0'
        # ET-045h L2: owned old-name orphans in both folders; a Setup over the uninstalled root runs --squirrel-install.
        if ($legacyNames) { Set-LegacyNames 'before-install-again-0.1.0' 'orphans' $versionA }
        Invoke-Driver 'step' @('install-again-0.1.0', $setup, '--silent') 60000
        $executableA = Assert-Installed 'install-again-0.1.0' $versionA
        if ($legacyNames) { Assert-LegacyNames 'install-again-0.1.0' 'before-install-again-0.1.0' }
        Assert-ProductLinks 'install-again-0.1.0' $true
        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
        Invoke-Driver 'plugin-launch' @('installed', $executableA, 'installed') 60000
        $helper = Get-VendorHelper $versionA
        Invoke-Driver 'windows-uninstall' @('deferred-game', '-', 'deferred') 60000
        Assert-Uninstalled 'deferred-game' $helper
        # PR-5: the next sign-in while the game still runs: the executor keeps everything and registers itself again.
        Invoke-Driver 'run-once' @('blocked-game', 'blocked') 60000

        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\reinstall-0.1.0'
        Invoke-Driver 'step' @('reinstall-0.1.0', $setup, '--silent') 60000
        $executableA = Assert-Installed 'reinstall-0.1.0' $versionA
        Assert-ProductLinks 'reinstall-0.1.0' $true
        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
        Invoke-Driver 'plugin-launch' @('adopted', $executableA, 'adopted') 60000
        $helper = Get-VendorHelper $versionA
        # PR-5: the final Windows-initiated uninstall defers while the fake game runs; once it has stopped, the registered
        # executor finishes the cleanup as it would at the next sign-in.
        Invoke-Driver 'windows-uninstall' @('final', '-', 'deferred') 60000
        Assert-Uninstalled 'final' $helper
        Invoke-Driver 'run-once' @('final', 'complete') 60000

        # ET-018 PR-4: the in-app uninstall scenarios (docs/installer-testing.md, "In-app uninstall scenarios").
        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = Join-Path $runRoot 'diagnostics\install-for-app-0.1.0'
        Invoke-Driver 'step' @('install-for-app-0.1.0', $setup, '--silent') 60000
        $executableA = Assert-Installed 'install-for-app-0.1.0' $versionA
        Assert-ProductLinks 'install-for-app-0.1.0' $true
        $env:ETS2TELEMETRY_DIAGNOSTIC_DIR = $null
        # Each command gets its own Job of at most 60 s (BoundedProcess): the plugin is installed first, so each in-app run only
        # starts the application; the run records, its verify command asserts.
        Invoke-Driver 'plugin-launch' @('for-app', $executableA, 'installed') 60000
        Invoke-Driver 'app-uninstall' @('blocked-game', $executableA, 'blocked') 60000
        Invoke-Driver 'app-uninstall-verify' @('blocked-game') 30000
        $null = Assert-Installed 'after-app-blocked' $versionA
        Assert-ProductLinks 'after-app-blocked' $true
        $helper = Get-VendorHelper $versionA
        Invoke-Driver 'app-uninstall' @('complete-app', $executableA, 'complete') 60000
        Invoke-Driver 'app-uninstall-verify' @('complete-app') 30000
        Assert-Uninstalled 'complete-app' $helper
    } else {
        Invoke-SideBySide
    }
    $report.passed = $true
} catch {
    $report.failure = $_.Exception.Message
} finally {
    Remove-PlantedLinks
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
        # One InstallLocation per registry view and run channel (channel by channel, '-' where the view has no key). The
        # driver deletes R without following links and decides for each entry whether its key points into R; only those
        # keys are deleted, only the run channels' keys are read, and only on a hosted runner or an owner-requested run.
        $keys = @($runChannels | ForEach-Object { $uninstallParent + '\' + $identities[$_].productRoot })
        $locations = @(foreach ($key in $keys) {
            foreach ($view in $registryViews) {
                $row = Read-RegistrationView $view $key
                if ($row -and $row.installLocation) { [string]$row.installLocation } else { '-' }
            }
        })
        $line = & $node $driver cleanup $configFile @locations | Select-Object -Last 1
        try {
            $cleanup = $line | ConvertFrom-Json
            $report.runRootRemoved = [bool]$cleanup.passed
            $owned = @($cleanup.ownsRegistration)
            if ($owned.Count -ne $registryViews.Count * $keys.Count) { throw 'Cleanup returned no decision per registry view and channel.' }
            # On a hosted runner or an owner-requested local run; a key is deleted only when it points into R.
            if ($hosted -or $AllowLocal) {
                for ($index = 0; $index -lt $owned.Count; $index++) {
                    if ($owned[$index] -ne $true) { continue }
                    $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryViews[$index % $registryViews.Count])
                    try { $hive.DeleteSubKeyTree($keys[[math]::Floor($index / $registryViews.Count)], $false) } finally { $hive.Dispose() }
                }
            }
            $report.registrationRemoved = @($keys | Where-Object { $null -ne (Read-Registration $_) }).Count -eq 0
        } catch { $report.cleanupFailure = $_.Exception.Message }
        # ET-055 PR-5: the autostart values the side-by-side scenario planted, while they still hold the planted data.
        Remove-PlantedRunValues
        # This run's own test RunOnce key (PR-5); its name holds the run id, so it is never another key.
        try {
            [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($testKey, $false)
            $report.runOnceKeyRemoved = ($null -eq [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($testKey))
        } catch { $report.runOnceKeyFailure = $_.Exception.Message }
        # The real binary root of every run channel must still be absent: a run that reached one is a failure whatever else
        # passed. A channel the run did not install is not judged (the owner's production copy beside a local staging run).
        $report.realBinaryRootAbsent = @($runChannels | Where-Object {
            Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $identities[$_].productRoot)
        }).Count -eq 0
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
