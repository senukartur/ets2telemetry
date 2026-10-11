# Inert by default. Reads/copies archives and sources; never executes any binary or maker.
[CmdletBinding()]
param([switch]$Prepare,[string]$OutputDirectory,[Alias('UpgradeFeed')][string]$FixtureDirectory,[string]$InstallerOutput,
    [string]$ObserverBuildDirectory,[string]$ExpectedObserverAssemblySha256,
    [string]$ExpectedSetupSha256,[string]$ExpectedOriginalNugetSha256,
    [string]$ExpectedPackageSha256='ffd4227c69487d31b63b8f92f1de4205103ec68648d4c11e8336ad061015d69f',
    [string]$ExpectedAsarSha256='2356ed080cb8854e2358065b3a209632814ae0777951ed3d41d447dbc11d2790')
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
if(!$Prepare){[ordered]@{prepare=$false;applicationLaunched=$false;guestRoot='C:\ETS2ET001Acceptance';globalGuestSeconds=160;minimumOuterRemainingSeconds=185;action='Supply -Prepare, a fresh OutputDirectory, reviewed original Setup/NuGet hashes, clone-only 0.1.1 FixtureDirectory, and reviewed inert ObserverBuildDirectory/ExpectedObserverAssemblySha256. Seal source, compiler receipt and observer library; no observer compilation in its guest Job.'}|ConvertTo-Json;return}
foreach($hash in @($ExpectedSetupSha256,$ExpectedOriginalNugetSha256,$ExpectedPackageSha256,$ExpectedAsarSha256,$ExpectedObserverAssemblySha256)){if($hash -notmatch '^[a-fA-F0-9]{64}$'){throw 'Reviewed SHA256 values required.'}}
if(!$OutputDirectory -or ![IO.Path]::IsPathRooted($OutputDirectory) -or (Test-Path -LiteralPath $OutputDirectory)){throw 'A fresh absolute output directory is required.'}
$output=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\','/')
$observerBuild=(Resolve-Path -LiteralPath $ObserverBuildDirectory).Path
$observerAssembly=Join-Path $observerBuild 'InstallerJobView.dll';$observerReceipt=Join-Path $observerBuild 'build-receipt.json';$observerSource=Join-Path $PSScriptRoot 'InstallerJobView.cs'
foreach($filename in @($observerAssembly,$observerReceipt,(Join-Path $observerBuild 'InstallerJobView.cs'))){if((Get-Item -LiteralPath $filename).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Observer build inputs must be ordinary files.'}}
$build=Get-Content -LiteralPath $observerReceipt -Raw|ConvertFrom-Json
$sourceSha256=(Get-FileHash -LiteralPath $observerSource).Hash.ToLowerInvariant()
if($build.schemaVersion -ne 1 -or $build.kind -ne 'et001-installer-observer-build' -or $build.sourceSha256 -ne $sourceSha256 -or (Get-FileHash -LiteralPath (Join-Path $observerBuild 'InstallerJobView.cs')).Hash -ne $sourceSha256 -or $build.assemblySha256 -ne $ExpectedObserverAssemblySha256 -or (Get-FileHash -LiteralPath $observerAssembly).Hash -ne $ExpectedObserverAssemblySha256 -or $build.assemblyBytes -ne (Get-Item -LiteralPath $observerAssembly).Length -or $build.assemblyBytes -le 0 -or $build.assemblyBytes -gt 1048576 -or $build.compilerPath -ne 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' -or $build.compilerSha256 -ne '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' -or $build.compilerSignature -ne 'Valid Microsoft Corporation' -or !$build.compilerVersion -or $build.exitCode -ne 0 -or $build.assemblyLoaded -ne $false -or $build.nativeObserverInvoked -ne $false){throw 'Reviewed observer source/compiler/library build receipt mismatch.'}
$buildArguments=@('/nologo','/noconfig','/target:library','/platform:x64','/optimize+','/reference:System.dll','/reference:System.Core.dll','/reference:System.Management.dll',('/out:'+$observerAssembly),(Join-Path $observerBuild 'InstallerJobView.cs'))
if($build.compilerSignerSubject -notmatch '^CN=Microsoft Windows, O=Microsoft Corporation,' -or $build.elapsedMilliseconds -gt 30000){throw 'Unexpected compiler signature or build deadline.'}
if(@($build.arguments).Count -ne $buildArguments.Count){throw 'Unexpected observer compiler flags.'}
for($index=0;$index -lt $buildArguments.Count;$index++){if($build.arguments[$index] -cne $buildArguments[$index]){throw 'Unexpected observer compiler argument.'}}
$fixture=(Resolve-Path -LiteralPath $FixtureDirectory).Path
$maker=if($InstallerOutput){(Resolve-Path -LiteralPath $InstallerOutput).Path}else{Join-Path $repository 'out/make/squirrel.windows/x64'}
$setup=Join-Path $maker 'ETS2Telemetry Desktop-0.1.0 Setup.exe'
$original=Join-Path $maker 'ETS2TelemetryDesktop-0.1.0-full.nupkg'
if((Get-FileHash -LiteralPath $setup).Hash -ne $ExpectedSetupSha256 -or (Get-FileHash -LiteralPath $original).Hash -ne $ExpectedOriginalNugetSha256){throw 'Original maker preimage differs from reviewed hashes.'}
. (Join-Path $repository 'scripts/verify-package.ps1')
$package=Join-Path $repository 'out/ETS2Telemetry Desktop-win32-x64'
if((Test-PackageIntegrity -PackageDirectory $package).packageSha256 -ne $ExpectedPackageSha256 -or (Get-FileHash -LiteralPath (Join-Path $package 'resources/app.asar')).Hash -ne $ExpectedAsarSha256){throw 'Frozen portable preimage changed.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-NugetRuntime([string]$filename,[string]$version){
    $archive=[IO.Compression.ZipFile]::OpenRead($filename)
    $rows=[Collections.Generic.List[object]]::new();$names=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    try{
        $specs=@($archive.Entries|Where-Object {$_.FullName -match '^[^/]+\.nuspec$'})
        if($specs.Count -ne 1){throw 'Expected one top-level NuGet manifest.'}
        $reader=[IO.StreamReader]::new($specs[0].Open());try{[xml]$spec=$reader.ReadToEnd()}finally{$reader.Dispose()}
        if($spec.package.metadata.id -ne 'ETS2TelemetryDesktop' -or $spec.package.metadata.version -ne $version){throw 'Unexpected NuGet identity/version.'}
        foreach($entry in $archive.Entries){
            if(!$entry.FullName.StartsWith('lib/net45/',[StringComparison]::OrdinalIgnoreCase) -or $entry.FullName.EndsWith('/')){continue}
            $relative=$entry.FullName.Substring(10)
            if($relative -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or !$names.Add($relative)){throw 'Unsafe or duplicate NuGet runtime entry.'}
            $stream=$entry.Open();$digest=[Security.Cryptography.SHA256]::Create()
            try{$sha=[BitConverter]::ToString($digest.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$digest.Dispose()}
            $rows.Add([ordered]@{path=$relative;bytes=$entry.Length;sha256=$sha})
        }
        if($rows.Count -lt 100 -or $rows.Count -gt 10000){throw 'Unexpected NuGet runtime file count.'}
        return $rows.ToArray()
    }finally{$archive.Dispose()}
}
$runtime=@(Read-NugetRuntime $original '0.1.0')
$fixturePackage=Join-Path $fixture 'ETS2TelemetryDesktop-0.1.1-full.nupkg'
$next=@(Read-NugetRuntime $fixturePackage '0.1.1')
$map=@{};foreach($row in $runtime){$map[$row.path]=$row}
if($next.Count -ne $runtime.Count){throw 'Fixture runtime file set differs from original.'}
foreach($row in $next){$old=$map[$row.path];if(!$old -or $old.bytes -ne $row.bytes -or $old.sha256 -ne $row.sha256){throw ('Fixture changed runtime bytes: '+$row.path)}}
$omitted=[Collections.Generic.List[string]]::new()
foreach($item in Get-ChildItem -LiteralPath $package -Recurse -File){
    $relative=$item.FullName.Substring($package.Length+1).Replace('\','/')
    if(!$map.ContainsKey($relative)){$omitted.Add($relative);continue}
    if($map[$relative].bytes -ne $item.Length -or (Get-FileHash -LiteralPath $item.FullName).Hash -ne $map[$relative].sha256){throw ('Original NuGet changed frozen package bytes: '+$relative)}
}
if(@($omitted|Where-Object {$_ -notin @('LICENSES.chromium.html','version')}).Count){throw 'Unexpected maker omissions from frozen package.'}
foreach($path in @('ETS2TelemetryDesktop.exe','resources/app.asar')){if(!$map.ContainsKey($path)){throw ('Critical runtime preimage missing: '+$path)}}
$generated=@($runtime|Where-Object {!(Test-Path -LiteralPath (Join-Path $package $_.path))})
if(@($generated|Where-Object {$_.path -notin @('Squirrel.exe','ETS2TelemetryDesktop_ExecutionStub.exe')}).Count){throw 'Unexpected maker-generated runtime files.'}
$releaseText=(Get-Content -LiteralPath (Join-Path $fixture 'RELEASES') -Raw).Trim()
$releaseLines=@($releaseText -split '\r?\n'|Where-Object {$_})
if(!$releaseLines.Count){throw 'Fixture feed is empty.'}
$feedNames=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach($line in $releaseLines){
    if($line -notmatch '^([a-fA-F0-9]{40}) (ETS2TelemetryDesktop-0\.1\.[01]-full\.nupkg) ([0-9]+)$'){throw 'Fixture feed may contain only local full 0.1.0/0.1.1 packages.'}
    $sha1=$Matches[1];$name=$Matches[2];$bytes=[long]$Matches[3]
    if(!$feedNames.Add($name)){throw 'Duplicate feed entry.'}
    $item=Get-Item -LiteralPath (Join-Path $fixture $name)
    if($item.Length -ne $bytes -or (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA1).Hash -ne $sha1){throw 'Fixture RELEASES integrity mismatch.'}
    if($name -eq 'ETS2TelemetryDesktop-0.1.0-full.nupkg' -and (Get-FileHash -LiteralPath $item.FullName).Hash -ne $ExpectedOriginalNugetSha256){throw 'Feed original package preimage mismatch.'}
}
if(!$feedNames.Contains('ETS2TelemetryDesktop-0.1.1-full.nupkg')){throw 'Missing upgrade fixture feed entry.'}
$node=Join-Path $repository '.local/toolchain/node-v24.19.0-win-x64/node.exe'
$playwright=Join-Path $repository 'node_modules/playwright-core'
if((Get-Content -LiteralPath (Join-Path $playwright 'package.json') -Raw|ConvertFrom-Json).version -ne '1.64.0'){throw 'Pinned playwright-core required.'}
New-Item -ItemType Directory -Path $output|Out-Null
foreach($name in @('harness','tools','node_modules','installer','feed')){New-Item -ItemType Directory -Path (Join-Path $output $name)|Out-Null}
Copy-Item -LiteralPath $setup -Destination (Join-Path $output 'installer/Setup.exe')
Copy-Item -LiteralPath (Join-Path $fixture 'RELEASES') -Destination (Join-Path $output 'feed')
foreach($name in $feedNames){Copy-Item -LiteralPath (Join-Path $fixture $name) -Destination (Join-Path $output 'feed')}
Copy-Item -LiteralPath $node -Destination (Join-Path $output 'tools/node.exe')
Copy-Item -LiteralPath $playwright -Destination (Join-Path $output 'node_modules/playwright-core') -Recurse
foreach($name in @('Invoke-GuestInstallerAcceptance.ps1','installer-step.mjs','installer-root-proof.mjs','Observe-InstallerJob.ps1')){Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $output 'harness')}
Copy-Item -LiteralPath (Join-Path $repository 'scripts/watchdog/BoundedProcess.cs') -Destination (Join-Path $output 'tools')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -Destination (Join-Path $output 'tools')
Copy-Item -LiteralPath $observerAssembly -Destination (Join-Path $output 'tools/InstallerJobView.dll')
Copy-Item -LiteralPath $observerSource -Destination (Join-Path $output 'tools/InstallerJobView.cs')
Copy-Item -LiteralPath $observerReceipt -Destination (Join-Path $output 'tools/observer-build-receipt.json')
$files=@(Get-ChildItem -LiteralPath $output -Recurse -Force|ForEach-Object{if($_.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Kit reparse points prohibited.'};if(!$_.PSIsContainer){[ordered]@{path=$_.FullName.Substring($output.Length+1).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName).Hash.ToLowerInvariant()}}})
$manifest=[ordered]@{schemaVersion=1;kind='et001-installer';guestRoot='C:\ETS2ET001Acceptance';guestUuid='94674D56-D803-F4D5-9AAC-C4E91CFB475F';labId='9a047927-f94b-41cb-bda8-abcc7d0b76f1';nodeVersion='24.19.0';playwrightCoreVersion='1.64.0';controllerSourceSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs')).Hash.ToLowerInvariant();packageSha256=$ExpectedPackageSha256;asarSha256=$ExpectedAsarSha256;setupSha256=$ExpectedSetupSha256;originalNugetSha256=$ExpectedOriginalNugetSha256;fixtureNugetSha256=(Get-FileHash -LiteralPath $fixturePackage).Hash.ToLowerInvariant();applicationVersion='0.1.0';fixtureVersion='0.1.1';fixtureOnly=$true;runtimeFiles=$runtime;portableOmissions=$omitted.ToArray();generatedFiles=@($generated.path);files=$files;applicationLaunched=$false;preparedUtc=[datetime]::UtcNow.ToString('o')}
$manifest.observerSourceSha256=$sourceSha256
$manifest.observerAssemblySha256=$ExpectedObserverAssemblySha256.ToLowerInvariant()
$manifest.observerBuildReceiptSha256=(Get-FileHash -LiteralPath $observerReceipt).Hash.ToLowerInvariant()
$manifest|ConvertTo-Json -Depth 7|Set-Content -LiteralPath (Join-Path $output 'kit-manifest.json') -Encoding UTF8
[ordered]@{prepared=$true;applicationLaunched=$false;kit=$output;files=$files.Count;runtimeFiles=$runtime.Count;manifestSha256=(Get-FileHash -LiteralPath (Join-Path $output 'kit-manifest.json')).Hash.ToLowerInvariant();setupSha256=$ExpectedSetupSha256;fixtureNugetSha256=$manifest.fixtureNugetSha256}|ConvertTo-Json
