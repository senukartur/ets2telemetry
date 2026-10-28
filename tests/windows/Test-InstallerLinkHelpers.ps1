[CmdletBinding()]
param(
    # The harness whose helper functions are loaded; nothing else of it runs.
    [Parameter(Mandatory = $true)][string]$Harness,
    # A fresh temporary folder that the caller owns and deletes; every shortcut is created inside it.
    [Parameter(Mandatory = $true)][string]$Root
)
# ET-045h (fix round 1, hosted run 40134013831): the installer lifecycle's shortcut helpers run here at runtime, under
# whichever PowerShell starts this script, so a cmdlet or parameter-set error that `-Plan` cannot reach fails a unit test
# instead of the hosted job. The functions are taken from the harness's own AST and run against fake Desktop and Start
# menu folders inside $Root. Invoke-Driver is replaced by a recorder; no installer, registry write or real folder is used.
# Read-UninstallEntries only reads HKCU, and with a run root inside $Root it finds nothing.
$ErrorActionPreference = 'Stop'
# A local, not the [string] parameter itself (tests/windows/Test-HarnessVariables.ps1).
$rootFolder = [IO.Path]::GetFullPath($Root)
if (!(Test-Path -LiteralPath $rootFolder -PathType Container) -or (Get-ChildItem -LiteralPath $rootFolder -Force | Select-Object -First 1)) { throw 'ROOT_NOT_EMPTY' }

$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Harness, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'HARNESS_PARSE_FAILED' }
$wanted = @('Find-ProductLinkFiles', 'Get-ProductLinks', 'Assert-ProductLinks', 'New-PlantedLink', 'Set-LegacyNames', 'Assert-LegacyNames', 'Remove-PlantedLinks', 'Close-Disposable',
    'Read-UninstallEntries')
$definitions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true))
if ($definitions.Count -ne $wanted.Count) { throw 'HARNESS_FUNCTIONS_MISSING' }
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }

# The script state the helpers read, as the harness sets it.
$runRoot = Join-Path $rootFolder 'installer-run'
$binaryRoot = Join-Path $runRoot 'LocalAppData\ETS2TelemetryDesktop'
$desktopFolder = Join-Path $rootFolder 'Desktop'
$programsFolder = Join-Path $rootFolder 'Programs'
$companyFolder = Join-Path $programsFolder 'Artur Sianiuk'
foreach ($folder in @($binaryRoot, $desktopFolder, $companyFolder)) { New-Item -ItemType Directory -Path $folder | Out-Null }
$script:shortcutFolders = [ordered]@{desktop = $desktopFolder; 'start-menu' = $programsFolder}
$script:hosted = $true
# ET-055 PR-5: the active channel's names, as Use-Channel sets them from installer-guard.mjs (production here).
$script:product = [pscustomobject]@{displayName = 'Yukon Union Telemetry'; executable = 'ETS2TelemetryDesktop.exe'; legacyDisplayNames = @('ETS2Telemetry Desktop')}
$linkFolders = $null
$plantedLinks = [Collections.Generic.List[object]]::new()
$report = [ordered]@{steps = @()}
$script:registryViews = @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)
$driverCalls = [Collections.Generic.List[object]]::new()
function Invoke-Driver([string]$Command, [string[]]$Arguments, [int]$TimeoutMs) { $driverCalls.Add([ordered]@{command = $Command; arguments = @($Arguments); timeoutMs = $TimeoutMs}) }

$result = [ordered]@{powershell = $PSVersionTable.PSVersion.ToString(); edition = [string]$PSVersionTable.PSEdition}
function Get-Refusal([scriptblock]$Work) { try { & $Work; return 'ACCEPTED' } catch { return $_.Exception.Message } }

# Squirrel's two new-name shortcuts, as the install hook creates them (planted with the harness's own helper, then
# forgotten so the cleanup does not count them).
$stub = Join-Path $binaryRoot 'ETS2TelemetryDesktop.exe'
New-PlantedLink (Join-Path $desktopFolder 'Yukon Union Telemetry.lnk') $stub (Join-Path $binaryRoot 'app-0.1.0') 'owned' 'squirrel'
New-PlantedLink (Join-Path $companyFolder 'Yukon Union Telemetry.lnk') $stub (Join-Path $binaryRoot 'app-0.1.0') 'owned' 'squirrel'
$plantedLinks.Clear()
# A link that points elsewhere is no product link.
New-PlantedLink (Join-Path $desktopFolder 'Other.lnk') (Join-Path $rootFolder 'other\other.exe') $rootFolder 'decoy' 'other'
$plantedLinks.Clear()

$result.rowsInstalled = Get-ProductLinks
Assert-ProductLinks 'install-0.1.0' $true
$result.linkFolders = [ordered]@{desktop = $linkFolders['desktop']; startMenu = $linkFolders['start-menu']}
$result.linksCall = $driverCalls[0]

# L2: owned orphans in both folders; the hook removes them, then Assert-LegacyNames accepts.
Set-LegacyNames 'before-install-again-0.1.0' 'orphans' '0.1.0'
$result.rowsWithOrphans = Get-ProductLinks
$result.plantExists = Get-Refusal { Set-LegacyNames 'again' 'orphans' '0.1.0' }
$plantedLinks.RemoveAll([Predicate[object]]{ param($row) $row.label -ceq 'again' }) | Out-Null
$result.notRemoved = Get-Refusal { Assert-LegacyNames 'install-again-0.1.0' 'before-install-again-0.1.0' }
foreach ($row in @($plantedLinks)) { Remove-Item -LiteralPath $row.file }
$result.orphansRemoved = Get-Refusal { Assert-LegacyNames 'install-again-0.1.0' 'before-install-again-0.1.0' }
$result.plantedAfterAssert = $plantedLinks.Count

# A decoy must stay byte-identical; it is deleted by Assert-LegacyNames, a changed one is refused.
New-PlantedLink (Join-Path $desktopFolder 'ETS2Telemetry Desktop.lnk') (Join-Path $runRoot 'decoy-target\ETS2TelemetryDesktop.exe') $runRoot 'decoy' 'decoy-kept'
$result.decoyKept = Get-Refusal { Assert-LegacyNames 'decoy' 'decoy-kept' }
$result.decoyDeleted = !(Test-Path -LiteralPath (Join-Path $desktopFolder 'ETS2Telemetry Desktop.lnk'))
New-PlantedLink (Join-Path $desktopFolder 'ETS2Telemetry Desktop.lnk') (Join-Path $runRoot 'decoy-target\ETS2TelemetryDesktop.exe') $runRoot 'decoy' 'decoy-changed'
[IO.File]::AppendAllText((Join-Path $desktopFolder 'ETS2Telemetry Desktop.lnk'), 'changed')
$result.decoyChanged = Get-Refusal { Assert-LegacyNames 'decoy' 'decoy-changed' }

# L3 and the final cleanup: a planted file with its bytes goes, a changed one stays.
Set-LegacyNames 'before-complete-running' 'uninstall' '0.1.1'
Remove-PlantedLinks
$result.cleanupRemovedPlanted = !(Test-Path -LiteralPath (Join-Path $companyFolder 'ETS2Telemetry Desktop.lnk'))
$result.cleanupKeptChanged = Test-Path -LiteralPath (Join-Path $desktopFolder 'ETS2Telemetry Desktop.lnk')
$result.cleanupFailure = $report['plantedLinkCleanupFailure']

$result.hostedOnly = Get-Refusal { $script:hosted = $false; Set-LegacyNames 'local' 'orphans' '0.1.0' }
$result.uninstallEntries = Read-UninstallEntries
$result.steps = @($report.steps | ForEach-Object { [string]$_.step })
$result | ConvertTo-Json -Depth 6 -Compress
