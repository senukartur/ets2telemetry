[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
# CI-only portable acquisition; no MSI, global installation or owner PATH change.
if ($env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP -or !$env:GITHUB_PATH) {
    throw 'Pinned CMake setup requires an ephemeral GitHub Actions runner.'
}
$version = '4.3.1'
$name = 'cmake-4.3.1-windows-x86_64.zip'
$url = 'https://github.com/Kitware/CMake/releases/download/v4.3.1/' + $name
$expected = '03a610be931546474e46a442d171ef10532f4fc847de9cf76b7a8065bbef6a23'
$directory = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('ets2-cmake-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
$archive = Join-Path $directory $name
Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 60
$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -cne $expected) { throw "CMake archive checksum mismatch: expected $expected; actual $actual" }
Expand-Archive -LiteralPath $archive -DestinationPath $directory
$bin = Join-Path $directory 'cmake-4.3.1-windows-x86_64/bin'
$executable = Join-Path $bin 'cmake.exe'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Verified CMake archive lacks the pinned executable.' }
$observed = @(& $executable --version)
if ($LASTEXITCODE -ne 0 -or $observed.Count -eq 0 -or $observed[0] -cne "cmake version $version") {
    throw 'Verified CMake executable version does not match the pin.'
}
$env:PATH = $bin + [IO.Path]::PathSeparator + $env:PATH
$bin | Out-File -LiteralPath $env:GITHUB_PATH -Encoding utf8 -Append
$evidence = Join-Path $PSScriptRoot '../../.local/ci'
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
@{version=$version; platform='windows-x86_64'; source=$url; archiveSha256=$actual;
  executable=$executable; observedVersion=$observed; acquiredUtc=[datetime]::UtcNow.ToString('o')} |
  ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence 'cmake-toolchain.json') -Encoding utf8
$observed | Write-Output
