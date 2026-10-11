[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/verify-package.ps1')
Test-PackageIntegrity -PackageDirectory $PackageDirectory | ConvertTo-Json -Compress
