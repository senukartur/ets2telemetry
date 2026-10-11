# Plan by default. Explicit -Build compiles a reviewed library; never loads or invokes it.
[CmdletBinding()]
param([switch]$Build,[string]$OutputDirectory,
    [string]$ExpectedCompilerSha256='46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00')
$ErrorActionPreference='Stop'
$compiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(!$Build){[ordered]@{build=$false;assemblyLoaded=$false;nativeObserverInvoked=$false;compiler=$compiler;expectedCompilerSha256=$ExpectedCompilerSha256;compilerSeconds=30;action='Review exact source, compiler provenance and flags; root supplies -Build and a fresh absolute OutputDirectory.'}|ConvertTo-Json;return}
if($ExpectedCompilerSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $compiler).Hash -ne $ExpectedCompilerSha256){throw 'Reviewed fixed compiler preimage required.'}
$signature=Get-AuthenticodeSignature -LiteralPath $compiler
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Windows, O=Microsoft Corporation,'){throw 'Valid Microsoft compiler signature required.'}
if(!$OutputDirectory -or ![IO.Path]::IsPathRooted($OutputDirectory) -or $OutputDirectory -match '["\r\n]' -or (Test-Path -LiteralPath $OutputDirectory)){throw 'Fresh absolute output directory required.'}
$output=[IO.Path]::GetFullPath($OutputDirectory)
$source=Join-Path $PSScriptRoot 'InstallerJobView.cs'
$sourceSha256=(Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant()
New-Item -ItemType Directory -Path $output|Out-Null
$sourceCopy=Join-Path $output 'InstallerJobView.cs';$assembly=Join-Path $output 'InstallerJobView.dll'
Copy-Item -LiteralPath $source -Destination $sourceCopy
if((Get-FileHash -LiteralPath $sourceCopy).Hash -ne $sourceSha256){throw 'Compiler source copy changed.'}
$arguments=@('/nologo','/noconfig','/target:library','/platform:x64','/optimize+','/reference:System.dll','/reference:System.Core.dll','/reference:System.Management.dll',('/out:'+$assembly),$sourceCopy)
$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$compiler;$start.WorkingDirectory=$output;$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
$start.Arguments=($arguments|ForEach-Object {'"'+$_+'"'}) -join ' '
$process=[Diagnostics.Process]::new();$process.StartInfo=$start;$clock=[Diagnostics.Stopwatch]::StartNew();$started=$false
try{
    if(!$process.Start()){throw 'Compiler did not start.'}
    $started=$true
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    if(!$process.WaitForExit(28000)){throw 'Inert compiler deadline exceeded.'}
    if(!$stdout.Wait([math]::Max(0,30000-[int]$clock.ElapsedMilliseconds)) -or !$stderr.Wait([math]::Max(0,30000-[int]$clock.ElapsedMilliseconds))){throw 'Compiler diagnostic streams exceeded deadline.'}
    if($stdout.Result.Length -gt 65536 -or $stderr.Result.Length -gt 65536){throw 'Compiler diagnostic retention bound exceeded.'}
    $stdout.Result|Set-Content -LiteralPath (Join-Path $output 'compiler-stdout.log') -Encoding UTF8
    $stderr.Result|Set-Content -LiteralPath (Join-Path $output 'compiler-stderr.log') -Encoding UTF8
    if($process.ExitCode -ne 0){throw ('Compiler failed: '+$process.ExitCode)}
    if((Get-FileHash -LiteralPath $source).Hash -ne $sourceSha256 -or (Get-FileHash -LiteralPath $sourceCopy).Hash -ne $sourceSha256 -or (Get-FileHash -LiteralPath $compiler).Hash -ne $ExpectedCompilerSha256){throw 'Compiler/source preimage changed during build.'}
    $item=Get-Item -LiteralPath $assembly
    if($item.Length -le 0 -or $item.Length -gt 1048576){throw 'Observer library size outside reviewed bound.'}
    $receipt=[ordered]@{schemaVersion=1;kind='et001-installer-observer-build';sourceSha256=$sourceSha256;assemblySha256=(Get-FileHash -LiteralPath $assembly).Hash.ToLowerInvariant();assemblyBytes=$item.Length;compilerPath=$compiler;compilerSha256=$ExpectedCompilerSha256.ToLowerInvariant();compilerVersion=(Get-Item -LiteralPath $compiler).VersionInfo.FileVersion;compilerSignature='Valid Microsoft Corporation';compilerSignerSubject=$signature.SignerCertificate.Subject;arguments=$arguments;exitCode=$process.ExitCode;elapsedMilliseconds=$clock.ElapsedMilliseconds;assemblyLoaded=$false;nativeObserverInvoked=$false;builtUtc=[datetime]::UtcNow.ToString('o')}
    $receipt|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $output 'build-receipt.json') -Encoding UTF8
    $receipt|ConvertTo-Json -Depth 4
}finally{
    if($started -and !$process.HasExited){$process.Kill();$null=$process.WaitForExit([math]::Max(0,30000-[int]$clock.ElapsedMilliseconds))}
    $process.Dispose()
}
