# Copies reviewed bytes only. This script never launches Node, Electron, an installer, or a VM.
[CmdletBinding()]
param(
    [switch]$Prepare,
    [string]$OutputDirectory,
    [string]$ExpectedPackageSha256 = 'ffd4227c69487d31b63b8f92f1de4205103ec68648d4c11e8336ad061015d69f',
    [string]$ExpectedAsarSha256 = '2356ed080cb8854e2358065b3a209632814ae0777951ed3d41d447dbc11d2790',
    [switch]$IncludeInstaller
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if (!$Prepare) {
    [ordered]@{prepare=$false;applicationLaunched=$false;repository=$repository;guestRoot='C:\ETS2ET001Acceptance';packageSha256=$ExpectedPackageSha256;asarSha256=$ExpectedAsarSha256;action='Use -Prepare -OutputDirectory <new empty absolute directory> to copy and hash the acceptance kit.'} | ConvertTo-Json
    return
}
if (!$OutputDirectory -or ![IO.Path]::IsPathRooted($OutputDirectory)) { throw 'A new absolute output directory is required.' }
$output = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\', '/')
if (Test-Path -LiteralPath $output) { throw 'Output already exists; preserve it and choose a fresh path.' }
$package = Join-Path $repository 'out/ETS2Telemetry Desktop-win32-x64'
$node = Join-Path $repository '.local/toolchain/node-v24.19.0-win-x64/node.exe'
$playwright = Join-Path $repository 'node_modules/playwright-core'
$playwrightMetadata = Get-Content -LiteralPath (Join-Path $playwright 'package.json') -Raw | ConvertFrom-Json
if ($playwrightMetadata.version -ne '1.64.0') { throw 'Expected playwright-core 1.64.0.' }
if (!(Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Pinned portable Node is missing.' }
. (Join-Path $repository 'scripts/verify-package.ps1')
$integrity = Test-PackageIntegrity -PackageDirectory $package
if ($integrity.packageSha256 -ne $ExpectedPackageSha256 -or (Get-FileHash -LiteralPath (Join-Path $package 'resources/app.asar')).Hash -ne $ExpectedAsarSha256) { throw 'Source package differs from the reviewed frozen artifact.' }
New-Item -ItemType Directory -Path $output | Out-Null
foreach ($directory in @('harness', 'tools', 'node_modules')) { New-Item -ItemType Directory -Path (Join-Path $output $directory) | Out-Null }
Copy-Item -LiteralPath $package -Destination (Join-Path $output 'package') -Recurse
Copy-Item -LiteralPath $node -Destination (Join-Path $output 'tools/node.exe')
Copy-Item -LiteralPath $playwright -Destination (Join-Path $output 'node_modules/playwright-core') -Recurse
foreach ($name in @('Invoke-GuestAcceptance.ps1', 'packaged-lifecycle.mjs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $output 'harness') }
Copy-Item -LiteralPath (Join-Path $repository 'scripts/verify-package.ps1') -Destination (Join-Path $output 'tools')
Copy-Item -LiteralPath (Join-Path $repository 'scripts/watchdog/BoundedProcess.cs') -Destination (Join-Path $output 'tools')
if ($IncludeInstaller) { Copy-Item -LiteralPath (Join-Path $repository 'out/make/squirrel.windows/x64') -Destination (Join-Path $output 'installer') -Recurse }
$copiedIntegrity = Test-PackageIntegrity -PackageDirectory (Join-Path $output 'package')
if ($copiedIntegrity.packageSha256 -ne $ExpectedPackageSha256) { throw 'Copied package fingerprint mismatch.' }
$files = [Collections.Generic.List[object]]::new()
$relativeNames = [Collections.Generic.List[string]]::new()
foreach ($item in Get-ChildItem -LiteralPath $output -Recurse -Force) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Kit reparse points are prohibited.' }
    if (!$item.PSIsContainer) { $relativeNames.Add($item.FullName.Substring($output.Length + 1).Replace('\', '/')) }
}
$relativeNames.Sort([StringComparer]::Ordinal)
foreach ($name in $relativeNames) {
    $item = Get-Item -LiteralPath (Join-Path $output $name)
    $files.Add([ordered]@{path=$name;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName).Hash.ToLowerInvariant()})
}
$manifest = [ordered]@{
    schemaVersion=1;preparedUtc=[datetime]::UtcNow.ToString('o');guestRoot='C:\ETS2ET001Acceptance'
    guestUuid='94674D56-D803-F4D5-9AAC-C4E91CFB475F';labId='9a047927-f94b-41cb-bda8-abcc7d0b76f1'
    nodeVersion='24.19.0';playwrightCoreVersion='1.64.0';packageSha256=$ExpectedPackageSha256;asarSha256=$ExpectedAsarSha256
    executableSha256=(Get-FileHash -LiteralPath (Join-Path $output 'package/ETS2TelemetryDesktop.exe')).Hash.ToLowerInvariant()
    installerIncluded=[bool]$IncludeInstaller;files=$files.ToArray();applicationLaunched=$false
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'kit-manifest.json') -Encoding UTF8
[ordered]@{prepared=$true;applicationLaunched=$false;kit=$output;files=$files.Count;manifestSha256=(Get-FileHash -LiteralPath (Join-Path $output 'kit-manifest.json')).Hash.ToLowerInvariant();packageSha256=$copiedIntegrity.packageSha256;asarSha256=$ExpectedAsarSha256} | ConvertTo-Json
