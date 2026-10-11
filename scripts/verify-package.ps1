# Read package bytes only. This verifier never launches Electron or loads SQLite.
function Test-PackageIntegrity {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$PackageDirectory)
    $packageRoot = (Resolve-Path -LiteralPath $PackageDirectory -ErrorAction Stop).Path.TrimEnd('\', '/')
    $relativeFiles = [Collections.Generic.List[string]]::new()
    $treeBounds = @{ Entries=0 }
    function Read-PackageTree([string]$directory, [int]$depth) {
        if ($depth -gt 64) { throw 'Package directory depth exceeds the verification bound.' }
        foreach ($item in Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop) {
            if (++$treeBounds.Entries -gt 100000) { throw 'Package entry count exceeds the verification bound.' }
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package reparse points are not allowed.' }
            if ($item.PSIsContainer) { Read-PackageTree $item.FullName ($depth + 1) }
            else {
                if ($relativeFiles.Count -ge 100000) { throw 'Package file count exceeds the verification bound.' }
                $relativeFiles.Add($item.FullName.Substring($packageRoot.Length + 1).Replace('\', '/'))
            }
        }
    }
    if ((Get-Item -LiteralPath $packageRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Package reparse points are not allowed.' }
    Read-PackageTree $packageRoot 0
    $relativeFiles.Sort([StringComparer]::Ordinal)
    $archive = Join-Path $packageRoot 'resources/app.asar'
    $stream = [IO.File]::OpenRead($archive)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt32() -ne 4) { throw 'Invalid ASAR size pickle.' }
        $headerSize = $reader.ReadUInt32()
        if ($headerSize -lt 8 -or $headerSize -gt 16777216 -or $headerSize -gt ($stream.Length - 8)) { throw 'Invalid or oversized ASAR header.' }
        $headerBytes = $reader.ReadBytes([int]$headerSize)
        $payloadSize = [BitConverter]::ToUInt32($headerBytes, 0)
        $jsonSize = [BitConverter]::ToUInt32($headerBytes, 4)
        if ($payloadSize -ne ($headerSize - 4) -or $jsonSize -gt ($payloadSize - 4) -or $headerSize -ne (8 + [Math]::Ceiling($jsonSize / 4.0) * 4)) { throw 'Invalid ASAR header pickle.' }
        $header = [Text.UTF8Encoding]::new($false, $true).GetString($headerBytes, 8, [int]$jsonSize) | ConvertFrom-Json
    } finally { $reader.Dispose(); $stream.Dispose() }
    $expectedUnpacked = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $bounds = @{ Entries=0 }
    function Read-AsarTree($node, [string]$relative, [int]$depth) {
        $bounds.Entries++
        if ($depth -gt 64 -or $bounds.Entries -gt 100000) { throw 'ASAR entry bounds exceeded.' }
        if ($null -eq $node -or $node -isnot [pscustomobject]) { throw 'Invalid ASAR entry.' }
        if ($node.PSObject.Properties['link']) { throw 'ASAR links are not allowed.' }
        if ($node.PSObject.Properties['files']) {
            if ($null -eq $node.files -or $node.files -isnot [pscustomobject]) { throw 'Invalid ASAR directory.' }
            foreach ($property in $node.files.PSObject.Properties) {
                $name = $property.Name
                if (!$name -or $name -eq '.' -or $name -eq '..' -or $name -match '[<>:"/\\|?*\x00-\x1f]') { throw 'Invalid ASAR path segment.' }
                $childRelative = if ($relative) { "$relative/$name" } else { $name }
                Read-AsarTree $property.Value $childRelative ($depth + 1)
            }
        } elseif ($node.unpacked -eq $true) {
            if (!$expectedUnpacked.Add($relative)) { throw 'Duplicate unpacked ASAR path.' }
            if ($node.integrity.algorithm -ne 'SHA256' -or $node.integrity.hash -notmatch '^[0-9a-fA-F]{64}$') { throw "Missing SHA256 integrity for unpacked file: $relative" }
            $physical = Join-Path $packageRoot "resources/app.asar.unpacked/$relative"
            $item = Get-Item -LiteralPath $physical -ErrorAction Stop
            if ($item.PSIsContainer -or $item.Length -ne $node.size) { throw "Unpacked file size mismatch: $relative" }
            if ((Get-FileHash -LiteralPath $physical -Algorithm SHA256).Hash -ne $node.integrity.hash) { throw "Unpacked file integrity mismatch: $relative" }
        }
    }
    Read-AsarTree $header '' 0
    if ($expectedUnpacked.Count -eq 0) { throw 'No unpacked package entries found.' }
    foreach ($relative in $relativeFiles) {
        $prefix = 'resources/app.asar.unpacked/'
        if ($relative.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and !$expectedUnpacked.Contains($relative.Substring($prefix.Length))) { throw "Unexpected unpacked file: $relative" }
    }
    $digest = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($relative in $relativeFiles) {
            $fileHash = (Get-FileHash -LiteralPath (Join-Path $packageRoot $relative) -Algorithm SHA256).Hash.ToLowerInvariant()
            $bytes = [Text.Encoding]::UTF8.GetBytes($relative + [char]0 + $fileHash + "`n")
            $null = $digest.TransformBlock($bytes, 0, $bytes.Length, $bytes, 0)
        }
        $null = $digest.TransformFinalBlock([byte[]]@(), 0, 0)
        $packageHash = [BitConverter]::ToString($digest.Hash).Replace('-', '').ToLowerInvariant()
    } finally { $digest.Dispose() }
    [pscustomobject]@{ packageSha256=$packageHash; unpackedFilesVerified=$expectedUnpacked.Count; packageFilesVerified=$relativeFiles.Count }
}
