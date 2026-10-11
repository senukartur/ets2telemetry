[CmdletBinding()]
param()
# Runs pinned PSScriptAnalyzer over every Git-tracked PowerShell file. See docs/setup.md#powershell-script-analysis.
# A pwsh 7 parent may export module locations that break Windows PowerShell 5.1 autoloading; use only the built-in ones.
$env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$version = '1.25.0'
# PowerShell Gallery PackageHash (SHA512, base64) for PSScriptAnalyzer 1.25.0.
$expected = '5/tXMmLmBLqymRSuYpIdJLl8L4i1GbQSd7QD72zhY/FLfRs23HNEmmjlrlqNlQKJGxDCZBMf0YE63ym/ExwWYw=='
$source = "https://www.powershellgallery.com/api/v2/package/PSScriptAnalyzer/$version"
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $root '.local\tools\psscriptanalyzer'
$package = Join-Path $tools "psscriptanalyzer.$version.nupkg"
$module = Join-Path $tools $version
$marker = Join-Path $module '.verified-package-sha512'

function Get-PackageHash([string]$Path) {
    $sha = [Security.Cryptography.SHA512]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [Convert]::ToBase64String($sha.ComputeHash($stream)) } finally { $stream.Dispose(); $sha.Dispose() }
}

New-Item -ItemType Directory -Path $tools -Force | Out-Null
if (!(Test-Path -LiteralPath $package -PathType Leaf) -or (Get-PackageHash $package) -cne $expected) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $download = "$package.download"
    Invoke-WebRequest -Uri $source -OutFile $download -UseBasicParsing -TimeoutSec 60
    $actual = Get-PackageHash $download
    if ($actual -cne $expected) { Remove-Item -LiteralPath $download; throw "PSScriptAnalyzer package hash mismatch: expected $expected; actual $actual" }
    Move-Item -LiteralPath $download -Destination $package -Force
}
if (!(Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-Content -LiteralPath $marker -Raw).Trim() -cne $expected) {
    if (Test-Path -LiteralPath $module) { Remove-Item -LiteralPath $module -Recurse -Force }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($package, $module)
    Set-Content -LiteralPath $marker -Value $expected -Encoding ascii
}
Import-Module -Name (Join-Path $module 'PSScriptAnalyzer.psd1') -Force
$loaded = Get-Module -Name PSScriptAnalyzer
if (@($loaded).Count -ne 1 -or $loaded.Version -ne [version]$version) { throw "Expected PSScriptAnalyzer $version, loaded $($loaded.Version)." }

$files = @(& git -C $root ls-files -- '*.ps1' '*.psm1' '*.psd1')
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'Could not list tracked PowerShell files.' }
$settings = Join-Path $root 'PSScriptAnalyzerSettings.psd1'
$findings = @(foreach ($file in $files) { Invoke-ScriptAnalyzer -Path (Join-Path $root $file) -Settings $settings })
$findings | Sort-Object ScriptPath, Line | ForEach-Object {
    '{0}:{1}:{2} {3} {4} {5}' -f $_.ScriptPath.Substring($root.Length + 1), $_.Line, $_.Column, $_.Severity, $_.RuleName, $_.Message
}
$evidence = Join-Path $root '.local\ci'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
@{version=$version; source=$source; packageSha512=$expected; powershell=$PSVersionTable.PSVersion.ToString();
  files=$files.Count; findings=$findings.Count; observedUtc=[datetime]::UtcNow.ToString('o')} |
  ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'psscriptanalyzer.json') -Encoding utf8
"PSScriptAnalyzer $version on Windows PowerShell $($PSVersionTable.PSVersion): $($files.Count) files, $($findings.Count) findings."
if ($findings.Count -ne 0) { exit 1 }
