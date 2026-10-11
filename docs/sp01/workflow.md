# Build and safely exercise SP-01

Use the pinned root dependencies and Windows x64 MSVC/CMake toolchain from [setup](../setup.md). Run these commands from the repository root in Developer PowerShell with Node 24.19.0/npm 11.17.0 and CMake on PATH. `NODE_OPTIONS=--use-system-ca` was needed for this host's trusted Windows certificate chain; never disable TLS validation.

```powershell
$env:NODE_OPTIONS = '--use-system-ca'
npm ci
$spSdk = ./experiments/sp01/Get-Sdk.ps1
cmake -S experiments/sp01 -B experiments/sp01/build -A x64 "-DSCS_SDK_ROOT=$spSdk"
cmake --build experiments/sp01/build --config Release
node node_modules/typescript/bin/tsc -p experiments/sp01/app/tsconfig.json
node experiments/sp01/build-app.mjs
./experiments/sp01/run-checks.ps1 -NodePath (Get-Command node).Source -CMakeBin (Split-Path (Get-Command cmake).Source) -OutputDirectory "$PWD/.local/sp01-check-<unique-run>"
```

The downloader verifies SDK archive 1.15 against SHA256 `77504F14D2AC1405BA70EE3A97351662ADBB39C0CF9D3A085423F01D37BC28EC`; API headers report 1.01. The SDK license is retained at `experiments/sp01/SCS-SDK-LICENSE.txt`. Preserve the license with distributed spike artifacts. A checksum mismatch stops the script for investigation. Build/cache/output files are ignored; no application/native production code or root manifests are modified. The DLL is `experiments/sp01/build/Release/ets2telemetry_sp01.dll`.

## Synthetic desktop smoke

Only the coordinator launches the reviewed smoke under `scripts/watchdog/BoundedProcess.cs`, with at most 16 processes, 2 GiB job committed memory, 25% CPU, kill-on-close and a 45-second external deadline. Pass absolute paths, the current Windows SID, and frozen candidate commit. The smoke creates a new output directory, isolated TEMP/TMP/APPDATA/LOCALAPPDATA/cwd/profile, an eight-second native synthetic source, and Electron. It retains failure receipts, logs and trace, checks actual natural fixture/app exits and utility service stop, and does not claim game focus/click-through compatibility. Reruns require new output directories; preserve failed results.

```powershell
Add-Type -Path "$PWD/scripts/watchdog/BoundedProcess.cs"
$spSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$spCandidate = git rev-parse HEAD
$spResult = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run(
  (Get-Command node).Source,
  [string[]]@("$PWD/experiments/sp01/tests/electron-smoke.mjs", "$PWD/.local/sp01-electron-<unique-run>", $spSid, $spCandidate),
  "$PWD", "$PWD/.local/sp01-electron-job-<unique-run>", 45000)
if ($spResult -ne 0) { throw "Smoke failed: preserve the receipt and job logs" }
```

## Game DLL installation/removal

The coordinator must coordinate a concrete session before any game-file changes. The initial implementation stage did not install or launch games; the later owner-coordinated [G01 session](sessions/sp01-g01.md) installed and removed only the two project files. The game and TruckersMP must be closed before changing the DLL. Never use broad process kills or remove other plugins. Use a separate game test profile where practical; this spike never writes telemetry history.

1. Inspect the selected absolute game root and exact `bin\win_x64` executable, including version. Reject reparse-point roots/plugin paths, unexpected executable names, and unresolved paths. Check all `eurotrucks2` and `amtrucks` processes are absent; if discovery fails or either is running, stop. Keep the games closed throughout the operation.
2. Hash the frozen built DLL. Inspect the exact destination `bin\win_x64\plugins\ets2telemetry_sp01.dll`. If it already exists without a matching prior project install receipt, **stop**; never overwrite unknown data. Inventory unrelated DLL names/hashes read-only.
3. Create only the missing `plugins` directory. Copy only `ets2telemetry_sp01.dll` and the project-named `ets2telemetry_sp01.SCS-SDK-LICENSE.txt` from the retained SDK license. Reject preexisting unknown license files as well. Verify copied hashes against the source. Save an ignored local receipt containing absolute targets, source/installed SHA256, candidate, executable/version, timestamp and prior absence. Do not alter other DLLs.
4. Launch the selected game manually through its intended client. Keep app and game at the same ordinary privilege level. Run the [checklist](game-checklist.md). DLL load messages are written through the SDK into the game's own log; the plugin creates no extra log file.
5. After both games/client close, remove only the two exact receipt-owned files if their hashes still match the receipt. Any mismatch or locked file stops removal for investigation. Leave the plugins directory and unrelated files intact. Verify the two project files are absent and unrelated preimages remain identical. Preserve the receipt/evidence; do not delete game directories.

For a manually coordinated app session, use an isolated absolute profile and one selected endpoint:

```powershell
$spSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$spRunAsNodePresent = Test-Path Env:ELECTRON_RUN_AS_NODE
$spRunAsNodeValue = $env:ELECTRON_RUN_AS_NODE
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  if (Test-Path Env:ELECTRON_RUN_AS_NODE) { throw 'Electron run-as-node environment remains present' }
  & ./node_modules/electron/dist/electron.exe ./experiments/sp01/app/main.cjs --game=eut2 "--sid=$spSid" "--profile=$PWD/.local/sp01-game-profile-<unique-session>"
} finally {
  if ($spRunAsNodePresent) {
    [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $spRunAsNodeValue, 'Process')
  } else {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
}
```

Select `--game=ats` for ATS. The overlay starts hidden; use the tray's **Exit SP-01** action for full exit. There is no main recording window in this speed/fuel experiment. The command is a manual session entrypoint, not authorization to run it automatically. Bound the app using the coordinator's reviewed owned-process launcher and isolated environment; actual game sessions need a separately agreed duration rather than silently raising the automated smoke deadline.

On PowerShell 7.6.5, `SetEnvironmentVariable(name, $null, 'Process')` left `ELECTRON_RUN_AS_NODE` present with an empty value. The first G01 app launch consequently ran as Node and failed before game launch. Explicit environment-provider removal, absence assertion and restoration of original presence/value passed inert absent/empty/value checks; the corrected reviewed manual launcher used that sequence. Preserve failed receipts. This finding does not explain the earlier ET-001 host freeze or Playwright timeouts. The G01 evidence reader also needed a reviewed narrow read-only exception for the standard OneDrive Documents game-log alias; this does not relax installation/removal reparse guards or authorize arbitrary alias traversal.
