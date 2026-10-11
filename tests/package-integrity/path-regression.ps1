[CmdletBinding()]
param([Parameter(Mandatory)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/verify-package.ps1')
# Pure cases reproduce different root/FullName spellings without relying on an
# NTFS volume's optional 8.3 generation. The expected package identity is fixed.
$relative = @()
foreach ($fullName in @('C:\Users\RUNNER~1\AppData\Local\Temp\package\resources\app.asar',
    'C:\Users\runneradmin\AppData\Local\Temp\package\resources\app.asar')) {
    $relative += Get-PackageEntryRelativeName 'resources' ([pscustomobject]@{Name='app.asar'; FullName=$fullName})
}
if ($relative.Count -ne 2 -or @($relative | Where-Object { $_ -cne 'resources/app.asar' }).Count) { throw 'Path spelling changed relative identity.' }
$rejections = @()
foreach ($name in @('.', '..', '../outside', 'nested\outside', 'nested/outside', '')) {
    $rejected = $false
    try { Get-PackageEntryRelativeName '' ([pscustomobject]@{Name=$name}) | Out-Null }
    catch { if ($_.Exception.Message -cne 'Invalid package path segment.') { throw }; $rejected=$true }
    if (!$rejected) { throw 'Traversal/path separator was accepted.' }
    $rejections += $name
}
$rejected = $false
try { Get-PackageEntryRelativeName 'resources/../outside' ([pscustomobject]@{Name='app.asar'}) | Out-Null }
catch { if ($_.Exception.Message -cne 'Invalid package parent path.') { throw }; $rejected=$true }
if (!$rejected) { throw 'Parent traversal was accepted.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IntegrityShortPath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern uint GetShortPathName(string input, StringBuilder output, uint length);
}
'@
$buffer = [Text.StringBuilder]::new(32768)
$length = [IntegrityShortPath]::GetShortPathName($PackageDirectory, $buffer, [uint32]$buffer.Capacity)
if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot inspect actual Windows short path.' }
$alias = $buffer.ToString()
$actualAliasAvailable = $alias -ine $PackageDirectory
$normal = Test-PackageIntegrity $PackageDirectory
$short = Test-PackageIntegrity $alias
if ($normal.packageSha256 -cne $short.packageSha256) { throw 'Actual short path changed package fingerprint.' }
# Modify only inert owned fixture bytes and require rejection through both spellings.
$physical = Join-Path $PackageDirectory 'resources/app.asar.unpacked/apps/desktop/dist/telemetry-service.cjs'
$bytes = [IO.File]::ReadAllBytes($physical); $bytes[0] = $bytes[0] -bxor 1
[IO.File]::WriteAllBytes($physical, $bytes)
$tamperRejections = 0
foreach ($spelling in @($PackageDirectory, $alias)) {
    try { Test-PackageIntegrity $spelling | Out-Null; throw 'Tampered fixture accepted.' }
    catch { if ($_.Exception.Message -notlike 'Unpacked file integrity mismatch:*') { throw }; $tamperRejections++ }
}
@{relativeNames=$relative; invalidNamesRejected=$rejections.Count; parentTraversalRejected=$rejected;
  actualAliasAvailable=$actualAliasAvailable; alias=$alias; fingerprint=$normal; aliasFingerprint=$short;
  tamperRejections=$tamperRejections} | ConvertTo-Json -Depth 5 -Compress
