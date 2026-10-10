# Windows x64 scaffold

ET-001 is a scaffold, not a game integration. Do not install the placeholder DLL in a game. No production schema, protocol, recorder, overlay, or CI exists yet.

## Toolchain

Use Node.js 24.19.0 and npm 11.17.0, pinned in `.node-version` and `package.json`. The checked-in npm lockfile records the installed dependency graph. Use Visual Studio 18 2026 Community with Desktop development with C++, MSVC 14.51.36231 (compiler 19.51.36260), Windows SDK 10.0.26100.0, and CMake 4.3.1-msvc1. These native tools were found in the current Windows environment at vendor paths; they were not initially on PATH.

If the network's trusted certificate authority is installed in Windows but missing from Node's bundled roots, use `$env:NODE_OPTIONS = '--use-system-ca'` for install/download commands. This environment needed that option after a TLS chain validation failure. Do not disable certificate verification. npm 11 requires install-script trust decisions: approve only the pinned `electron-winstaller@5.4.4` architecture-selection script after review; do not approve every dependency globally. The acceptance record must establish that clean `npm ci` prepares its maker files. Electron 44 uses an explicit `install-electron` binary; root `postinstall` invokes it to acquire the pinned Electron executable with package checksums.

The root `allowScripts` policy explicitly disables scripts only for `better-sqlite3@13.0.3`. With npm 11.17.0, clean `npm ci` otherwise synthesizes `node-gyp rebuild` from the package's `binding.gyp`: the lock metadata omits its actual `gypfile: false`, so npm's rebuild detection attempts an unnecessary source build. The pinned false policy preserves its bundled N-API prebuild without disabling other dependency scripts or root Electron bootstrap. Reinspect this npm/package behavior and repin the policy when upgrading; the package/runtime smoke remains required.

Run in a Developer PowerShell with Node/npm and CMake on PATH. The recovery hold below prohibits desktop/installer launches; use only build, static, Node-unit and console-fixture checks while it is active:

```powershell
npm ci
npm run build
npm run typecheck
npm test
npm run native:configure
npm run native:build
npm run native:test
npm run package
npm run make
```

The desktop production build uses Vite to compile four separate CommonJS entrypoints and the React renderer. Forge packages from the repository root so hoisted workspace production dependencies are included. The Squirrel maker identity is `ETS2TelemetryDesktop`; application data uses the separate `ETS2Telemetry` root.

After the owner lifts the runtime hold, the same Electron smoke can target the executable from a temporary working directory. This sequence is currently blocked, and additionally requires the explicit launch gate described below:

```powershell
$env:ETS2TELEMETRY_TEST_EXE = (Resolve-Path 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe').Path
npm run test:electron
Remove-Item Env:ETS2TELEMETRY_TEST_EXE
```

The probe exercises Electron main -> utilityProcess telemetry service -> dedicated worker -> better-sqlite3. It writes and reopens a uniquely named temporary SQLite database, then removes it during orderly shutdown. It never opens production history. The pinned better-sqlite3 13.0.3 uses node-addon-api and bundles a Windows x64 N-API prebuild; it has no install script and does not require a Node-version-specific rebuild. Forge's `rebuildConfig.ignoreModules` skips only `better-sqlite3`, preserving that binary; other native dependencies remain eligible for Electron rebuilding. An attempted unnecessary node-gyp rebuild failed because Python was unavailable. No successful SQLite rebuild is claimed. The Electron runtime smoke must verify the actual packaged native binary before this strategy is accepted. Node Vitest covers Node-safe lifecycle/path/logging modules and must not load Electron or native storage dependencies. `test:electron` packages first so native assets and compiled worker paths are prepared. ASAR explicitly unpacks compiled CommonJS entries and the complete better-sqlite3 module, including its JavaScript loader and native binaries. The package smoke must pass before this layout is accepted.

## Runtime paths and diagnostics

Resolve `%LOCALAPPDATA%` at runtime. The application root is `%LOCALAPPDATA%\ETS2Telemetry`; planned locations are `data\telemetry.sqlite`, `settings\`, `logs\`, `backups\`, and `plugins\` for project-owned plugin metadata. Binary installation has an independent Squirrel identity/root. The scaffold creates startup logs only, with a separate temporary SQLite probe. No production history, updater, migration, production backup, or uninstall deletion is implemented.

Normal diagnostics use stable error codes. Opt-in diagnostic runs retain bounded error details and child output; see the recovery procedure below for file limits, privacy and paths. Startup has a 15-second deadline; the storage probe has 10 seconds; orderly service stop allows 3 seconds before forced termination and 5 seconds before failed application exit. These application timers require a responsive event loop, so the external watchdog provides a separate deadline.

Squirrel lifecycle arguments are handled before service/window creation through `electron-squirrel-startup`. Actual upgrade, repair, uninstall, shortcut creation, and existing-history preservation still require an isolated installed-package test; unit argument tests or a portable executable do not establish them. Do not run installation/removal against existing owner paths without authorization.

## Official SDK acquisition

Download the official [SCS Telemetry SDK 1.15 archive](https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip) from the source linked in `concept.md`. Review and retain its license before use or redistribution. Do not assume archive 1.15 is a telemetry API or game version. ET-003 will pin archive checksum, included API versions, headers, and license treatment. ET-001 has no SDK dependency and does not vendor SDK files or expose SCS initialization exports.

## Sources

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron native module rebuilding](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [Forge auto unpack native modules](https://www.electronforge.io/config/plugins/auto-unpack-natives)
- [Forge Squirrel maker lifecycle](https://www.electronforge.io/config/makers/squirrel.windows)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)

Real-game compatibility, TruckersMP, latency, frame time, production upgrades, and a machine without development tools remain separate pending acceptance evidence.

## Packaged-startup recovery hold (October 11, 2026)

The owner currently prohibits launching Electron or `ETS2TelemetryDesktop.exe` after two host freezes. Build and inspect the package only. Do not run `dev`, `test:electron`, Playwright directly, the installer, or the watchdog with `-Launch` until the owner authorizes a runtime check. This hold also applies to the implementation coordinator. The root cause of the Windows-wide freeze remains unproven.

The recovery changes include physical unpacked service/worker paths, the entire `better-sqlite3` module outside ASAR, supervised shutdown deadlines armed before stop IPC, suppression of late readiness after shutdown, and bounded diagnostics. A physical worker must resolve its SQLite loader from the package itself, not accidentally from a development checkout. `npm run inspect:package` verifies this without importing the binding or launching Electron. It also verifies source fingerprints, compiled-file hashes, x64 native bytes, and exclusion of test traces. Static inspection does not establish packaged runtime compatibility.

Safe checks during this hold (Node/npm on PATH):

```powershell
npm run typecheck
npm test
./tests/watchdog/run.ps1 -NodePath (Get-Command node).Source
$env:NODE_OPTIONS = '--use-system-ca' # Required by this environment's certificate chain.
npm run package
npm run inspect:package
./scripts/diagnose-packaged.ps1 # Plan only; never starts the app without -Launch.
```

The watchdog tests run only small Node console fixtures. They check child exit codes and Windows argument quoting, timeout termination of a process tree, detached orphan cleanup, bounded stdout, captured stderr, termination after the watchdog process itself is killed, and preservation of an unrelated process. These tests never launch the packaged executable, Electron, SQLite, or a game. Evidence stays in a uniquely named temporary directory.

The launcher uses an independent PowerShell process and a Windows Job Object. It creates the target suspended, assigns it to the job, then resumes it; assignment failures terminate the suspended target. The job disallows breakaway and configures kill-on-close, at most 16 processes, 2 GiB total committed memory, and a 25% system CPU cap. A wall-clock deadline defaults to 30 seconds (allowed range 5-60). Timeout returns 124; children remaining after the main process exits are killed and return 125. The watchdog never terminates processes by name; cleanup uses owned process/job handles. It refuses to launch while an existing desktop instance is present.

A future authorized run must use a separate PowerShell invocation of `scripts/diagnose-packaged.ps1` with `-Launch` and `-ExpectedAsarSha256` matching the reviewed archive hash printed by the plan. Prefer an isolated Windows VM for the next runtime investigation. The job is containment, not a guarantee against a kernel, driver, or whole-host hang. Resource caps may change timing; record them with results. Playwright and `npm run dev` are additionally gated by `ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH=1`; do not set it during the hold. This variable is a workflow guard, not OS security.

Each watchdog run preserves `.local/diagnostics/watchdog-<uuid>/` with isolated TEMP/TMP, APPDATA/LOCALAPPDATA, explicit Chromium user/session profiles, launch/result metadata, owned PID, and separate stdout/stderr files capped at 1 MiB each. Streams continue draining after the cap. Application and service structured logs each retain a maximum 256 KiB plus one rotated file, and at most 2,000 records per process/run. Normal logs retain stable codes; explicit diagnostic mode also records bounded errors/stacks and child output. Detailed logs may contain local paths and should be reviewed before sharing. A log write error must not interrupt shutdown. The normal location is `%LOCALAPPDATA%\ETS2Telemetry\logs`, with service logs in its `service` subdirectory. No production telemetry database is created.

`apps/desktop/dist/build-evidence.json` records build-time source fingerprints. `.local/diagnostics/package-inspection.json` records the checked archive/executable/native SHA256 hashes and explicitly states `applicationLaunched: false`. Keep the complete `out/ETS2Telemetry Desktop-win32-x64` directory together; copying the EXE alone is not a usable distribution. Runtime smoke, actual SQLite loading in the packaged worker, installer lifecycle, clean-machine testing, independent review, and real games remain pending.

References: [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Electron ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Recovery validation, October 11, 2026

Source changes and build tools were checked without launching Electron, the packaged app, an installer, or a game:

- `npm run typecheck`: passed.
- `npm test`: 21 tests passed in four files.
- `./tests/watchdog/run.ps1`: passed all eight console-fixture assertions described above. C# compiled through PowerShell Add-Type; no additional compiler installation was needed.
- Vendor CMake Release build and CTest: passed, 1/1 placeholder native test.
- `npm run package`: passed using `NODE_OPTIONS=--use-system-ca`. The initial attempt without the system CA failed with `fetch failed`; it was not an application launch.
- `npm run inspect:package`: passed; seven compiled/evidence files match the build, source fingerprints match, the physical SQLite loader resolves within the package, and native PE bytes identify x64. The first inspector iteration needed platform-native ASAR separators. Its subsequent external-dependency failure exposed the incomplete unpack configuration and was fixed by unpacking all of better-sqlite3.
- `./scripts/diagnose-packaged.ps1`: dry-run plan passed with `launch: false`.

The Windows hang is not claimed fixed. No successful application/runtime outcome is inferred from these checks. No current-candidate clean install, installer/maker lifecycle, independent review, or actual game result is claimed; CI is not configured.
