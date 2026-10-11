param([string]$CacheDirectory = (Join-Path $PSScriptRoot '../../.local/sp01-sdk'))
$ErrorActionPreference = 'Stop'
$spCache = [System.IO.Path]::GetFullPath($CacheDirectory)
New-Item -ItemType Directory -Path $spCache -Force | Out-Null
$spArchive = Join-Path $spCache 'scs_sdk_1_15.zip'
if (!(Test-Path -LiteralPath $spArchive)) {
  Invoke-WebRequest -Uri 'https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip' -OutFile $spArchive
}
$spHash = (Get-FileHash -LiteralPath $spArchive -Algorithm SHA256).Hash
if ($spHash -ne '77504F14D2AC1405BA70EE3A97351662ADBB39C0CF9D3A085423F01D37BC28EC') {
  throw "SDK archive checksum mismatch: $spHash. Preserve the file and investigate the official source."
}
$spExtract = Join-Path $spCache 'extracted'
Expand-Archive -LiteralPath $spArchive -DestinationPath $spExtract -Force
Write-Output $spExtract
