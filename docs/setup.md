# Windows x64 scaffold

ET-001 is a scaffold, not a game integration. Do not install the placeholder DLL in a game. No production schema, protocol, recorder, overlay, or CI exists yet.

## Toolchain

Use Node.js 24.19.0 and npm 11.17.0, pinned in `.node-version` and `package.json`. The checked-in npm lockfile records the installed dependency graph. Use Visual Studio 18 2026 Community with Desktop development with C++, MSVC 14.51.36231 (compiler 19.51.36260), Windows SDK 10.0.26100.0, and CMake 4.3.1-msvc1. These native tools were found in the current Windows environment at vendor paths; they were not initially on PATH.

If the network's trusted certificate authority is installed in Windows but missing from Node's bundled roots, use `$env:NODE_OPTIONS = '--use-system-ca'` for install/download commands. This environment needed that option after a TLS chain validation failure. Do not disable certificate verification. npm 11 requires install-script trust decisions: approve only the pinned `electron-winstaller@5.4.4` architecture-selection script after review; do not approve every dependency globally. The acceptance record must establish that clean `npm ci` prepares its maker files. Electron 44 uses an explicit `install-electron` binary; root `postinstall` invokes it to acquire the pinned Electron executable with package checksums.

The root `allowScripts` policy explicitly disables scripts only for `better-sqlite3@13.0.3`. With npm 11.17.0, clean `npm ci` otherwise synthesizes `node-gyp rebuild` from the package's `binding.gyp`: the lock metadata omits its actual `gypfile: false`, so npm's rebuild detection attempts an unnecessary source build. The pinned false policy preserves its bundled N-API prebuild without disabling other dependency scripts or root Electron bootstrap. Reinspect this npm/package behavior and repin the policy when upgrading; the package/runtime smoke remains required.

Run in a Developer PowerShell with Node/npm and CMake on PATH. The recovery hold below prohibits desktop/installer launches on the physical host; these build, static, Node-unit and console-fixture commands do not launch the application:

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

The existing Electron smoke entrypoint targets a packaged executable from a temporary working directory and packages first. The sequence below is prohibited on the physical host and does not itself provide containment. Current acceptance instead uses the reviewed self-contained [packaged guest harness](../tests/vm/README.md), directly owned by the existing Job Object, inside the authorized disposable VM with the independent outer watchdog. Setting a launch gate alone is not authorization:

```powershell
$env:ETS2TELEMETRY_TEST_EXE = (Resolve-Path 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe').Path
npm run test:electron
Remove-Item Env:ETS2TELEMETRY_TEST_EXE
```

The probe exercises Electron main -> utilityProcess telemetry service -> dedicated worker -> better-sqlite3. It writes and reopens a uniquely named temporary SQLite database; its orderly shutdown path removes that directory. It never opens production history. The pinned better-sqlite3 13.0.3 uses node-addon-api and bundles a Windows x64 N-API prebuild; it has no install script and does not require a Node-version-specific rebuild. Forge's `rebuildConfig.ignoreModules` skips only `better-sqlite3`, preserving that binary; other native dependencies remain eligible for Electron rebuilding. An attempted unnecessary node-gyp rebuild failed because Python was unavailable. No successful SQLite rebuild is claimed. The current frozen package passed two guest Playwright launches with SQLite write/reopen readiness, renderer isolation, orderly application/service exit 0, probe removal and complete Job drain; installed lifecycle and final-candidate review remain pending. Node Vitest covers Node-safe lifecycle/path/logging modules and must not load Electron or native storage dependencies. `test:electron` packages first so native assets and compiled worker paths are prepared. ASAR explicitly unpacks compiled CommonJS entries and the complete better-sqlite3 module, including its JavaScript loader and native binaries. See [the validation record](validation/et-001.md) for the exact tested artifact and limits.

## Runtime paths and diagnostics

Resolve `%LOCALAPPDATA%` at runtime. The application root is `%LOCALAPPDATA%\ETS2Telemetry`; planned locations are `data\telemetry.sqlite`, `settings\`, `logs\`, `backups\`, and `plugins\` for project-owned plugin metadata. Binary installation has an independent Squirrel identity/root. The scaffold creates startup logs only, with a separate temporary SQLite probe. No production history, updater, migration, production backup, or uninstall deletion is implemented.

Normal diagnostics use stable error codes. Opt-in diagnostic runs retain bounded error details and child output; see the recovery procedure below for file limits, privacy and paths. Startup has a 15-second deadline; the storage probe has 10 seconds; orderly service stop allows 3 seconds before forced termination and 5 seconds before failed application exit. These application timers require a responsive event loop, so the external watchdog provides a separate deadline.

Squirrel lifecycle arguments are handled before service/window creation through `electron-squirrel-startup`. Actual install/repair/update/uninstall, shortcuts/registration and synthetic SQLite/settings/logs/backups/plugin-metadata preservation are being checked separately with the [guest installer harness](../tests/vm/installer.md); their runtime result remains pending. Its synthetic NuGet 0.1.1 fixture contains unchanged application 0.1.0 bytes and is not a release, production updater or migration. Squirrel preserves the separate data root during uninstall; optional owned-data deletion is deferred to ET-018. Do not run installation/removal against existing owner paths without authorization.

## Official SDK acquisition

Download the official [SCS Telemetry SDK 1.15 archive](https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip) from the source linked in `concept.md`. Review and retain its license before use or redistribution. Do not assume archive 1.15 is a telemetry API or game version. ET-003 will pin archive checksum, included API versions, headers, and license treatment. ET-001 has no SDK dependency and does not vendor SDK files or expose SCS initialization exports.

## Sources

- [Electron utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron native module rebuilding](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [Forge auto unpack native modules](https://www.electronforge.io/config/plugins/auto-unpack-natives)
- [Forge Squirrel maker lifecycle](https://www.electronforge.io/config/makers/squirrel.windows)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)

Real-game compatibility, TruckersMP, latency, frame time, production upgrades and migrations remain pending feature evidence. The current portable package ran in a disposable guest without an installed development toolchain; portable Node/Playwright were acceptance drivers. Installed-package acceptance in that environment remains pending.

## Packaged-startup recovery hold (October 11, 2026)

After two host freezes, the owner prohibits launching Electron, `ETS2TelemetryDesktop.exe`, or the installer on the physical host. Host work is limited to building, inspecting, and the safe checks below. Do not run `dev`, `test:electron`, Playwright directly, an installer, or the watchdog with `-Launch` on the physical host. This constraint also applies to the implementation coordinator. The root cause of the Windows-wide freeze remains unproven.

The owner separately authorized runtime checks inside a disposable Windows VM, with an inner process Job Object, an independent outer VM watchdog armed before boot, log export, VM shutdown and clean-snapshot restoration after every attempt. The current frozen package passed two isolated Playwright launches with readiness/security assertions, ordinary exit, probe cleanup and Job drain. Earlier forced-timeout startup observations concern a different artifact. Installed lifecycle, longer stability and final-candidate review remain pending. See [the validation record](validation/et-001.md). These results do not lift the physical-host prohibition or establish the original freeze fixed.

The recovery changes include physical unpacked service/worker paths, the entire `better-sqlite3` module outside ASAR, supervised shutdown deadlines armed before stop IPC, suppression of late readiness after shutdown, and bounded diagnostics. A physical worker must resolve its SQLite loader from the package itself, not accidentally from a development checkout. `npm run inspect:package` verifies this without importing the binding or launching Electron. It also verifies source fingerprints, compiled-file hashes, x64 native bytes, and exclusion of test traces. All physical unpacked files must match the SHA256 integrity and size recorded in the ASAR header; links, reparse points, and extra unpacked files are rejected. Static inspection does not establish packaged runtime compatibility.

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

Guest runtime must use a reviewed wrapper that directly assigns its complete harness to the existing Job before execution: the [packaged lifecycle wrapper](../tests/vm/README.md), the separately reviewed [installed lifecycle wrapper](../tests/vm/installer.md), or the diagnostic `scripts/diagnose-packaged.ps1 -Launch` probe. Supply the reviewed manifest where applicable, `-ExpectedAsarSha256` and `-ExpectedPackageSha256`; recompute hashes and ASAR unpacked integrity before launching. A diagnostic timeout is not orderly-exit proof. The full package fingerprint covers the EXE, DLLs, resources and unpacked files, so ASAR alone is insufficient. The outer VM watchdog must already be armed with sufficient remaining budget; export evidence, confirm the VM off and restore the clean snapshot and any replaced read-only media afterward. The Job is containment, not a guarantee against a kernel, driver or whole-host hang. Record resource caps with results. Playwright and `npm run dev` are additionally gated by `ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH=1`; never set it on the physical host during this hold. This variable is a workflow guard, not OS security.

The Node inspector and PowerShell launcher share a canonical fingerprint: sort relative file names with ordinal comparison, normalize separators to `/`, append each name, NUL, its lowercase SHA256, and LF, then SHA256-hash that UTF-8 stream. This covers every package file. Header parsing is capped at 16 MiB, with at most 100,000 ASAR entries and 100,000 package entries (including directories), and depth 64. Do not modify or rebuild the package between inspection, transfer verification, and the authorized guest run.

If built-in Windows PowerShell blocks these local scripts under its execution policy, the authorized guest invocation may use `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>` with the reviewed script path and arguments. This affects that process only; do not change machine/user execution policy. The inert package-integrity tests use the same process-local option and a child-only Windows PowerShell module path, preventing inherited PowerShell 7 module locations from hiding built-in commands. They require the expected rejection diagnostic, so an infrastructure failure cannot count as a corruption test passing.

Each watchdog run preserves `.local/diagnostics/watchdog-<uuid>/` with isolated TEMP/TMP, APPDATA/LOCALAPPDATA, explicit Chromium user/session profiles, launch/result metadata, owned PID, and separate stdout/stderr files capped at 1 MiB each. Streams continue draining after the cap. Application and service structured logs each retain a maximum 256 KiB plus one rotated file, and at most 2,000 records per process/run. Normal logs retain stable codes; explicit diagnostic mode also records bounded errors/stacks and child output. Detailed logs may contain local paths and should be reviewed before sharing. A log write error must not interrupt shutdown. The normal location is `%LOCALAPPDATA%\ETS2Telemetry\logs`, with service logs in its `service` subdirectory. No production telemetry database is created.

`apps/desktop/dist/build-evidence.json` records build-time source fingerprints. `.local/diagnostics/package-inspection.json` records the checked archive/executable/native SHA256 hashes, full `packageSha256`, physical-file verification counts, and explicitly states `applicationLaunched: false`. Keep the complete `out/ETS2Telemetry Desktop-win32-x64` directory together; copying the EXE alone is not a usable distribution. Current guest Playwright evidence establishes packaged SQLite readiness, renderer security, orderly exit, cleanup and relaunch for the recorded frozen artifact only. Installed lifecycle, final-candidate independent review, longer stability and real games remain pending.

References: [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Electron ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Recovery validation, October 11, 2026

At source `6cbf76f954b71daa15b652fbe2acbf746d3ca58e`, typecheck passed and Node unit checks passed: 30 tests in five files, 5.17 seconds. Earlier checks on the same frozen application inputs passed clean `npm ci`, Forge build/package/Squirrel maker creation, native Release build/CTest (1/1), all eight watchdog console assertions, and static package inspection. The inert diagnostic plan reported `launch: false`. No desktop or installer runtime was executed on the physical host.

The current frozen package then passed two contained guest Playwright launches with renderer security, native worker probe, orderly main/service exit 0, temporary cleanup and complete Job drain. Evidence was exported; the VM was confirmed off and the clean snapshot, original read-only media and receipt restored. [The validation record](validation/et-001.md) distinguishes this exact package/source identity from earlier 30-second forced-timeout runs and retains failed orchestration/harness attempts. Installed lifecycle and final-candidate review remain pending. One-hour stability, resolution of the physical-host freeze, production migrations, real games and CI are not established.
