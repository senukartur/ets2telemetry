# Windows x64 scaffold

The accepted scaffold now includes the v0 SDK adapter, native snapshot transport, telemetry service and game-window metadata. ET-008 adds a candidate [minimal overlay](minimal-overlay.md) and [closed-game manual plugin setup](manual-plugin-setup.md). Use only the maintained SDK DLL identified there; never install the historical placeholder DLL. Production history and durable event delivery remain unimplemented. Required real-game, display and performance acceptance remains pending. [Windows CI and bounded worker smokes](ci.md) provide controlled evidence, not game compatibility.

## Toolchain

Use Node.js 24.19.0 and npm 11.17.0, pinned in `.node-version` and `package.json`. The checked-in npm lockfile records the installed dependency graph. Use Visual Studio 18 2026 Community with Desktop development with C++, MSVC 14.51.36231 (compiler 19.51.36260), Windows SDK 10.0.26100.0, and CMake 4.3.1-msvc1. These native tools were found in the current Windows environment at vendor paths; they were not initially on PATH.

If the network's trusted certificate authority is installed in Windows but missing from Node's bundled roots, use `$env:NODE_OPTIONS = '--use-system-ca'` for install/download commands. This environment needed that option after a TLS chain validation failure. Do not disable certificate verification. npm 11 requires install-script trust decisions: approve only the pinned `electron-winstaller@5.4.4` architecture-selection script after review; do not approve every dependency globally. The acceptance record must establish that clean `npm ci` prepares its maker files. Electron 44 uses an explicit `install-electron` binary; root `postinstall` invokes it to acquire the pinned Electron executable with package checksums.

The root `allowScripts` policy explicitly disables scripts only for `better-sqlite3@13.0.3`. With npm 11.17.0, clean `npm ci` otherwise synthesizes `node-gyp rebuild` from the package's `binding.gyp`: the lock metadata omits its actual `gypfile: false`, so npm's rebuild detection attempts an unnecessary source build. The pinned false policy preserves its bundled N-API prebuild without disabling other dependency scripts or root Electron bootstrap. Reinspect this npm/package behavior and repin the policy when upgrading; the package/runtime smoke remains required.

Run in a Developer PowerShell with Node/npm and CMake on PATH. The owner lifted the application launch hold; native installer acceptance is recorded with bounded owned processes and preserved owner data; these build, static, Node-unit and console-fixture commands do not launch the application:

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

The desktop production build uses Vite to compile five separate CommonJS entrypoints (main, dashboard preload, overlay preload, telemetry service and storage worker) and the React renderer. Forge packages from the repository root so hoisted workspace production dependencies are included. The Squirrel maker identity is `ETS2TelemetryDesktop`; application data uses the separate `ETS2Telemetry` root.

The existing Electron smoke entrypoint targets a packaged executable from a temporary working directory and packages first. The sequence below is authorized on native Windows following the owner revocation of the application hold; it does not itself provide process containment. The coordinator also ran the existing packaged Playwright test on native Windows through the unchanged Job Object, without rebuilding the frozen artifact. The [packaged guest harness](../tests/vm/README.md) retains historical evidence and its guest identity guards. No desktop-launch environment opt-in is required for these native commands:

```powershell
$env:ETS2TELEMETRY_TEST_EXE = (Resolve-Path 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe').Path
npm run test:electron
Remove-Item Env:ETS2TELEMETRY_TEST_EXE
```

The probe exercises Electron main -> utilityProcess telemetry service -> dedicated worker -> better-sqlite3. It writes and reopens a uniquely named temporary SQLite database; its orderly shutdown path removes that directory. It never opens production history. The pinned better-sqlite3 13.0.3 uses node-addon-api and bundles a Windows x64 N-API prebuild; it has no install script and does not require a Node-version-specific rebuild. Forge's `rebuildConfig.ignoreModules` skips only `better-sqlite3`, preserving that binary; other native dependencies remain eligible for Electron rebuilding. An attempted unnecessary node-gyp rebuild failed because Python was unavailable. No successful SQLite rebuild is claimed. The earlier guest-tested package passed two guest Playwright launches with SQLite write/reopen readiness, renderer isolation, orderly application/service exit 0, probe removal and complete Job drain; installed lifecycle composite acceptance is recorded; final verifier/documentation review is recorded separately. Node Vitest covers Node-safe lifecycle/path/logging modules and must not load Electron or native storage dependencies. `test:electron` packages first so native assets and compiled worker paths are prepared. ASAR explicitly unpacks compiled CommonJS entries and the complete better-sqlite3 module, including its JavaScript loader and native binaries. See [the validation record](validation/et-001.md) for the exact tested artifact and limits.

## Linting

ET-023a adds ESLint for TypeScript and JavaScript in `apps/`, `packages/`, `tools/`, `tests/`, `scripts/` and root config files. Run from the repository root after `npm ci`:

```powershell
npm run lint:install
npm run lint
```

`lint:install` runs `npm ci --prefix tools/lint`, a separate lockfile that is not a root workspace. `lint` fails on any error or warning (`--max-warnings 0`). Linting does not build, launch Electron or touch native code. Pinned versions: ESLint 10.12.0, @eslint/js 10.0.1, typescript-eslint 8.71.1, eslint-plugin-react-hooks 7.1.1, globals 17.13.0, and the lint-only TypeScript 6.0.2 described below. Update them with `npm install --prefix tools/lint <package>@<version>`, which keeps exact pins through `tools/lint/.npmrc`.

**Why a separate TypeScript.** The project compiles and typechecks with TypeScript 7.0.2. TypeScript 7.0 ships no JavaScript compiler API: its `typescript` entry point exposes only version fields. typescript-eslint parses every TypeScript file through that API, so it cannot run on TypeScript 7 at all, with or without type information. typescript-eslint 8.71.1 declares `typescript >=4.8.4 <6.1.0`, and its maintainers [state](https://github.com/typescript-eslint/typescript-eslint/issues/12518) that TypeScript 7 support waits for a TypeScript 7 API ([tracking issue](https://github.com/typescript-eslint/typescript-eslint/issues/10940)); they recommend TypeScript 6 side by side. `tools/lint` therefore installs Microsoft's side-by-side package `@typescript/typescript6@6.0.2` under the name `typescript`. Its own lockfile guarantees that every lint package, including `ts-api-utils`, resolves that copy: as a root workspace, npm hoisted `ts-api-utils` beside the root TypeScript 7. The project TypeScript version is unchanged, and `npm run typecheck` still uses TypeScript 7.

Type-aware rules are enabled. They read the root `tsconfig.json` through TypeScript 6, so type information comes from the 6.0 checker rather than the 7.0 checker that gates typecheck; a rule could disagree with `tsc` where the two versions differ. Revisit this when typescript-eslint supports TypeScript 7.

The configuration lives in `tools/lint/config.mjs`, and the root `eslint.config.mjs` re-exports it. It uses `@eslint/js` recommended for all files, `typescript-eslint` `recommendedTypeChecked` for TypeScript (including `no-floating-promises` and `no-misused-promises`), and syntax-only rules for plain `.mjs`/`.cjs`/`.js` files, which are not part of a TypeScript project. Renderer code is every `apps/desktop/src/**/*.tsx` module; keep main, preload, service and worker entries as `.ts`, or extend `rendererFiles` in the config when that convention changes. React Hooks recommended rules apply to renderer code as errors, including the rules the preset marks as warnings. Renderer code may not import Node.js built-ins, `electron`, `better-sqlite3` or `electron-squirrel-startup`, and the sandboxed preload may not import Node.js built-ins. Generated and third-party output (`dist`, `out`, `node_modules`, `native/`, `.local`, `planning`, Playwright output, protocol fixtures) is ignored. Unused `eslint-disable` directives are errors.

Rule exceptions, each with its reason:

| Scope | Exception | Reason |
| --- | --- | --- |
| All files | `prefer-const` with `ignoreReadBeforeAssign` | A `let` read by an earlier closure and assigned later cannot become `const` without a temporal-dead-zone hazard |
| `tests/**` | `@typescript-eslint/no-unsafe-*` (argument, assignment, call, member access, return) off | Tests inspect untyped JSON reports from child processes and files; `expect` checks their shape at runtime, and casts would only silence the rules |
| `tests/**` | `@typescript-eslint/unbound-method` off | `expect(mock.method)` passes a mock as a value and never calls it with a lost `this` |
| `packages/contracts/src/protocol-v0.ts`, `scripts/package-integrity.mjs` | Inline `no-control-regex` | Both regular expressions deliberately reject control characters |

## UI components (shadcn/ui)

The main window uses [shadcn/ui](https://ui.shadcn.com/) with Tailwind CSS v4. shadcn/ui is not a runtime dependency: the CLI copies component source into `apps/desktop/src/components/ui`, where it is project code that is linted, typechecked and edited like any other module. The renderer bundle is built by Vite, so every UI package is a pinned dev dependency: tailwindcss and @tailwindcss/vite 4.3.3, tw-animate-css, radix-ui, class-variance-authority, lucide-react, cn (a Tailwind-aware class-name merge helper published by shadcn, MIT, repository shadcn-ui/cn, described as a drop-in replacement for clsx plus tailwind-merge; generated components import it directly and `apps/desktop/src/lib/utils.ts` re-exports it) and @fontsource-variable/geist. The CLI is not installed; run it through npx.

Add a component from the repository root:

```powershell
npx shadcn@4.21.4 add <component>
```

`components.json` holds the CLI configuration (`radix-nova` preset, stylesheet `apps/desktop/src/index.css`). Review `package.json` and `package-lock.json` after each add: the repository pins exact versions through `.npmrc`, and a component may bring new dependencies. Do not run `shadcn init`; the build has no `vite.config` file for it to edit. `index.css` contains the CLI's `shadcn/tailwind.css` inlined, which is what `shadcn eject` produces, so the CLI package stays out of the dependency tree. Re-inline the file when moving to a newer preset.

Components in use: `card` and `button` (ET-025) and `alert` (ET-011a, added with `npx shadcn@4.21.4 add alert`, which left `package.json` and `package-lock.json` unchanged). The dashboard's Exit button imports `button.tsx`, whose `radix-ui` import makes the renderer build print Vite `MODULE_LEVEL_DIRECTIVE` warnings about Radix's `"use client"` directives; they are harmless in a client-only bundle.

Constraints that are easy to break:

- **Path alias.** `tsconfig.json` maps `@/*` to `apps/desktop/src/*` and `scripts/build.mjs` repeats it as a Vite alias; keep the two in step. The shadcn documentation tells you to add `baseUrl`, but TypeScript 7.0 removed that option (error TS5102). Use `paths` alone.
- **Stylesheet typing.** `apps/desktop/src/css.d.ts` declares `*.css` modules. Without it, `import './index.css'` fails typecheck with TS2882.
- **Content Security Policy.** `index.html` allows only `'self'` sources and no `data:`. The renderer build therefore sets `assetsInlineLimit: 0`, so small fonts and images stay separate files. Do not load fonts or images from the network. `scripts/build.mjs` also fails the build if the emitted renderer page or stylesheet embeds a `data:` URI.
- **Lint.** Every `apps/desktop/src/**/*.tsx` file, including generated components, must pass the zero-warning ESLint run with the React Hooks rules in [Linting](#linting). Fix generated code that violates them in the component itself and note the change in the PR.
- **Overlay.** `index.css` sets `body` to an opaque background, which would defeat the transparent overlay window. The overlay needs its own entry page and stylesheet that imports Tailwind utilities without the shadcn base layer.

Verification recorded for this setup (no game or packaged-application run): `npm run typecheck`, `npm run lint`, `npm test` and `node scripts/build.mjs` pass. The built renderer was loaded from `file://` in Electron 44.7.0 (Chromium 152) with a sandboxed, context-isolated window and a stub bridge: the card rendered, the Geist latin subset loaded, and the console reported no errors or CSP violations. Windows CI (packaging and the packaged smoke) must still run on the PR head.

## PowerShell script analysis

ET-023b runs [PSScriptAnalyzer](https://learn.microsoft.com/en-us/powershell/utility-modules/psscriptanalyzer/overview) 1.25.0 over every Git-tracked `.ps1`, `.psm1` and `.psd1` file. Run from the repository root:

```powershell
npm run lint:ps
```

The command starts built-in Windows PowerShell 5.1 (`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass`, affecting that process only) with `scripts/Invoke-ScriptAnalysis.ps1`. Local checks and CI therefore use the same engine; most repository scripts target Windows PowerShell 5.1. The script resets the child's `PSModulePath` to the built-in Windows PowerShell locations, so a pwsh 7 parent such as the CI shell cannot redirect module autoloading. Git must be on PATH.

The module is not installed through PowerShellGet. On first use the script downloads `https://www.powershellgallery.com/api/v2/package/PSScriptAnalyzer/1.25.0` to ignored `.local/tools/psscriptanalyzer/`, compares its SHA512 with the PowerShell Gallery `PackageHash` pinned in the script, extracts it there and imports it by path. A hash mismatch fails before extraction, and an imported version other than 1.25.0 fails. Later runs re-verify the retained package and reuse the extraction; the extracted files themselves are trusted through a marker written after verified extraction, so delete `.local/tools/psscriptanalyzer/` if they may have been altered. CI always starts from a fresh runner. `.local/ci/psscriptanalyzer.json` records version, source, package hash, PowerShell version and counts; CI uploads it with the other evidence. To upgrade, change the version and hash in the script together after checking the gallery's published hash.

`PSScriptAnalyzerSettings.psd1` runs every default rule at every severity (Error, Warning, Information) except the exclusions below. Any finding fails the command. Exceptions, each with its reason:

| Scope | Exception | Reason |
| --- | --- | --- |
| All files | `PSUseApprovedVerbs`, `PSUseSingularNouns`, `PSUseShouldProcessForStateChangingFunctions` excluded | Naming and `-WhatIf` conventions for published cmdlets; every function here is a private script helper, and no module is exported |
| All files | `PSAvoidUsingPositionalParameters` excluded | Argument-style preference (200 findings); rewriting reviewed acceptance harnesses would not fix a defect |
| `tests/vm/Invoke-GuestInstallerAcceptance.ps1`, `tests/vm/Prepare-InstallerKit.ps1`, `tests/windows/Invoke-NativeInstallerAcceptance.ps1` | Script-level `PSAvoidUsingBrokenHashAlgorithms` suppression | Squirrel `RELEASES` entries identify packages by SHA1; SHA256 is also checked where a pin exists |
| `tests/vm/Assert-InstallerDriverProvenance.ps1` | Script-level `PSAvoidInvokingEmptyMembers` suppression | Before/After proof fields are selected from a fixed suffix list |
| `tests/vm/sibling-console-observer-fixture.ps1` | `PSReviewUnusedParameter` suppression for `ResultFile` | Callers pass the shared observer argument list; this fixture reports through `ReadyFile` |

Script-level suppressions cover the whole file, including future uses of the same rule there: the three Squirrel scripts include their top-level feed check, and `Assert-InstallerDriverProvenance.ps1` has a single function with plain parameters. Review new SHA1/MD5 or dynamic member access in these files deliberately; prefer a function-level attribute for new exceptions.

Findings fixed instead of excepted: a function that assigned the automatic `$args` and a loop that assigned the automatic `$matches` (renamed in `tests/vm/Assert-InstallerHelperProvenance.ps1`), unused `param($root)` in empty uninstall-residue setups, and a missing `OutputType` on `Assert-UninstallResidue`.

## Runtime paths and diagnostics

Resolve `%LOCALAPPDATA%` at runtime. The application root is `%LOCALAPPDATA%\ETS2Telemetry`; planned locations are `data\telemetry.sqlite`, `settings\`, `logs\`, `backups\`, and `plugins\` for project-owned plugin metadata. Opt-in CAP0 evidence captures use the separate `captures\` directory. Binary installation has an independent Squirrel identity/root. The scaffold creates startup logs only, with a separate temporary SQLite probe. No production history, updater, migration, production backup, or uninstall deletion is implemented.

Normal diagnostics use stable error codes. Opt-in diagnostic runs retain bounded error details and child output; see the recovery procedure below for file limits, privacy and paths. Startup has a 15-second deadline; the storage probe has 10 seconds; orderly service stop allows 3 seconds before forced termination and 5 seconds before failed application exit. These application timers require a responsive event loop, so the external watchdog provides a separate deadline.

Since ET-011a the application is single-instance and lives in the notification area. Closing the main window hides it to the tray; use the tray's or the dashboard's **Exit ETS2Telemetry** to stop it. A second launch writes no diagnostic log, starts no service, window or tray, exits 0 and brings the running dashboard forward; it is also the guaranteed way back if the tray icon does not appear. The instance lock is keyed by Electron's `userData` directory, so a development launch beside an installed copy only focuses the installed one; give it a separate absolute `ETS2TELEMETRY_PROFILE_DIR` to run both. See [the application lifecycle](app-lifecycle.md).

Squirrel lifecycle arguments are handled before service/window creation through electron-squirrel-startup. The [native ownership harness](../tests/windows/README.md) verified install, repair, local synthetic update, both installed worker/security smokes and uninstall with preserved owner files. Acceptance combines six normal operations with separately reviewed corrected Squirrel residue postconditions and exact test cleanup; the original failed wrapper report is retained. The synthetic installer version 0.1.1 retains application 0.1.0 bytes and does not test production migrations/releases. Uninstall retains the separate data root; optional owned-data deletion belongs to ET-018. Squirrel may leave its sealed helper binaries and .dead marker; the test reports that residue explicitly. Do not install/remove against pre-existing owner state through this fresh-install harness.

## CAP0 evidence capture (CAP-01a)

The [CAP0 contract](protocol/cap0.md) adds an opt-in, evidence-only capture path for owner-scheduled game sessions. It is off by default and has no renderer control. To request one capture interval, set the variables in the shell that launches the application, then select ETS2 or ATS:

```powershell
$env:ETS2TELEMETRY_CAPTURE = 'cap0'
$env:ETS2TELEMETRY_CAPTURE_MINUTES = '10'          # optional, 1-60; default 10
$env:ETS2TELEMETRY_CAPTURE_LABEL = 'ets2-sp-windowed' # optional manifest label
npm run dev
Remove-Item Env:ETS2TELEMETRY_CAPTURE, Env:ETS2TELEMETRY_CAPTURE_MINUTES, Env:ETS2TELEMETRY_CAPTURE_LABEL
```

The grant applies to the first verified ETS2/ATS selection of that launch only. Unit tests and the controlled chain below cover this activation path. The owner first used it through `npm run dev` in ETS2 single-player sessions on October 12, 2026; see [CAP-01a validation](validation/cap-01a.md#owner-game-sessions-october-12-2026). Packaged builds and the rest of the CAP-01 matrix have not exercised it. Raw output goes to `%LOCALAPPDATA%\ETS2Telemetry\captures\<captureSessionId>\` (`packets.ndjson` and `manifest.json`), never to `telemetry.sqlite`. Raw captures contain local identifiers and paths: never commit or upload them. Export a sanitized copy for review with `npm run capture:export -- <raw-capture-directory> <new-export-directory>`; the command builds `tools/capture-export` with Vite first.

Native checks run in `npm run native:test` as `capture-cap0-*` (CTest) and in the native client test's `capture*` cases. The optional cross-package chain needs the native plugin and client Release builds and runs the tests-only fake-SDK host (`native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe`), the test plugin DLL, the native broker and the TypeScript writer in isolated temporary directories:

```powershell
npm run native:configure
npm run native:build
npm run build
npm run test:cap0-chain
```

It is not part of `npm test` because CI runs Vitest before the native build; Windows CI runs it as a separate bounded step after the native build. It is controlled synthetic evidence, not a game session.

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

The owner lifted the Electron/application launch hold on October 11, 2026 after explicitly requesting a native Windows test. Direct `ETS2TelemetryDesktop.exe`, `dev`, `test:electron`, Playwright desktop checks and diagnostic `-Launch` are now authorized on the physical host, including coordinator work, without repeated permission for the old hold. The temporary desktop-launch environment gate has been removed from native entrypoints. The owner also removed the VM requirement; native installer acceptance is recorded with explicit ownership and preservation checks. This authorization is not evidence that the original Windows-wide freeze is fixed; its root cause remains unproven.

The owner separately authorized runtime checks inside a disposable Windows VM, with an inner process Job Object, an independent outer VM watchdog armed before boot, log export, VM shutdown and clean-snapshot restoration after every attempt. The earlier guest-tested package passed two isolated Playwright launches with readiness/security assertions, ordinary exit, probe cleanup and Job drain. Earlier forced-timeout startup observations concern a different artifact. Native installed composite acceptance is recorded below; longer stability remains unproven. See [the validation record](validation/et-001.md). The owner has separately lifted the application prohibition; these results do not establish that the original freeze is fixed.

The recovery changes include physical unpacked service/worker paths, the entire `better-sqlite3` module outside ASAR, supervised shutdown deadlines armed before stop IPC, suppression of late readiness after shutdown, and bounded diagnostics. A physical worker must resolve its SQLite loader from the package itself, not accidentally from a development checkout. `npm run inspect:package` verifies this without importing the binding or launching Electron. It also verifies source fingerprints, compiled-file hashes, x64 native bytes, and exclusion of test traces. All physical unpacked files must match the SHA256 integrity and size recorded in the ASAR header; links, reparse points, and extra unpacked files are rejected. Static inspection does not establish packaged runtime compatibility.

Build and non-desktop checks (Node/npm on PATH):

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

Guest runtime must use a reviewed wrapper that directly assigns its complete harness to the existing Job before execution: the [packaged lifecycle wrapper](../tests/vm/README.md), the separately reviewed [installed lifecycle wrapper](../tests/vm/installer.md), or the diagnostic `scripts/diagnose-packaged.ps1 -Launch` probe. Supply the reviewed manifest where applicable, `-ExpectedAsarSha256` and `-ExpectedPackageSha256`; recompute hashes and ASAR unpacked integrity before launching. A diagnostic timeout is not orderly-exit proof. The full package fingerprint covers the EXE, DLLs, resources and unpacked files, so ASAR alone is insufficient. The outer VM watchdog must already be armed with sufficient remaining budget; export evidence, confirm the VM off and restore the clean snapshot and any replaced read-only media afterward. The Job is containment, not a guarantee against a kernel, driver or whole-host hang. Record resource caps with results. Native Playwright and `npm run dev` no longer require `ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH`. The separate guest-only harness retains its own opt-in, identity and containment checks; do not run that harness on the host.

The Node inspector and PowerShell launcher share a canonical fingerprint: sort relative file names with ordinal comparison, normalize separators to `/`, append each name, NUL, its lowercase SHA256, and LF, then SHA256-hash that UTF-8 stream. This covers every package file. Header parsing is capped at 16 MiB, with at most 100,000 ASAR entries and 100,000 package entries (including directories), and depth 64. Do not modify or rebuild the package between inspection, transfer verification, and the authorized guest run.

If built-in Windows PowerShell blocks these local scripts under its execution policy, the authorized guest invocation may use `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script>` with the reviewed script path and arguments. This affects that process only; do not change machine/user execution policy. The inert package-integrity tests use the same process-local option and a child-only Windows PowerShell module path, preventing inherited PowerShell 7 module locations from hiding built-in commands. They require the expected rejection diagnostic, so an infrastructure failure cannot count as a corruption test passing.

Each watchdog run preserves `.local/diagnostics/watchdog-<uuid>/` with isolated TEMP/TMP, APPDATA/LOCALAPPDATA, explicit Chromium user/session profiles, launch/result metadata, owned PID, and separate stdout/stderr files capped at 1 MiB each. Streams continue draining after the cap. Application and service structured logs each retain a maximum 256 KiB plus one rotated file, and at most 2,000 records per process/run. Normal logs retain stable codes; explicit diagnostic mode also records bounded errors/stacks and child output. Detailed logs may contain local paths and should be reviewed before sharing. A log write error must not interrupt shutdown. The normal location is `%LOCALAPPDATA%\ETS2Telemetry\logs`, with service logs in its `service` subdirectory. No production telemetry database is created.

`apps/desktop/dist/build-evidence.json` records build-time source fingerprints. `.local/diagnostics/package-inspection.json` records the checked archive/executable/native SHA256 hashes, full `packageSha256`, physical-file verification counts, and explicitly states `applicationLaunched: false`. Keep the complete `out/ETS2Telemetry Desktop-win32-x64` directory together; copying the EXE alone is not a usable distribution. Historical guest Playwright evidence establishes packaged SQLite readiness, renderer security, orderly exit, cleanup and relaunch for the recorded frozen artifact only. Native installed composite acceptance is recorded separately; longer stability and real games remain pending.

References: [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Electron ASAR limitations](https://www.electronjs.org/docs/latest/tutorial/asar-archives).

## Historical guest recovery validation, October 11, 2026

At source `6cbf76f954b71daa15b652fbe2acbf746d3ca58e`, typecheck passed and Node unit checks passed: 30 tests in five files, 5.17 seconds. Earlier checks on the same frozen application inputs passed clean `npm ci`, Forge build/package/Squirrel maker creation, native Release build/CTest (1/1), all eight watchdog console assertions, and static package inspection. The inert diagnostic plan reported `launch: false`. No desktop or installer runtime was executed on the physical host.

At `43d3cc392ec7f6df88a79086536cfa0370716059`, coordinator typecheck and 102 Node tests in eight files passed in 5.71 seconds, including actual pure PowerShell proof-boundary cases. All 18 bounded installer-controller native controls passed and were independently reviewed. Retained guest installer failures include null and differing WMI image observations despite matching held native identity. The single-query native-authority correction passed source/library review and guest metadata binding, but terminal held-identity handling and fresh installed acceptance remain pending; commands and invariants belong in [the installer harness guide](../tests/vm/installer.md). No additional host runtime permission follows from these checks.

The then-frozen package passed two contained guest Playwright launches with renderer security, native worker probe, orderly main/service exit 0, temporary cleanup and complete Job drain. Evidence was exported; the VM was confirmed off and the clean snapshot, original read-only media and receipt restored. [The validation record](validation/et-001.md) distinguishes this exact package/source identity from earlier 30-second forced-timeout runs and retains failed orchestration/harness attempts. Install, repair and installed smoke passed in a subsequent contained guest run; update, upgraded smoke, uninstall and final-candidate review remain pending. One-hour stability, resolution of the physical-host freeze, production migrations, real games and CI are not established.

## Native installed scaffold acceptance

All six actual native operations completed with normal root/primary exits and naturally empty Jobs. Both installed smokes verified the real utilityProcess/SQLite worker, secure renderer, temporary cleanup and main/service/launcher exit 0. The first wrapper rejected vendor-owned uninstall residues; a separately reviewed strict predicate accepted only the exact .dead marker and sealed helpers, followed by exact owned cleanup. The original failure remains unchanged. Current artifact identities, preserved owner preimages, independent review and an unexplained earlier Playwright timeout are in [the validation record](validation/et-001.md). No further VM run is required. The complete installer cycle was not rerun solely to replace the incorrect assertion.

## ET-006a native client build

The ET-006a candidate extends npm run build to configure and compile the fixed native/telemetry-client Windows x64 executable with CMake/MSVC before bundling desktop source. Keep the documented CMake toolchain on PATH for desktop build/package/make commands. The generated native client and its source-bound receipt remain in ignored native/telemetry-client/build and .local/package-native; Forge copies the owned staged client directory to resources/telemetry-client. This does not install a game DLL or create real history. Exact runtime outcomes and remaining checks are recorded in docs/validation/et-006a.md.

## Main-window and overlay renderer styles

ET-008 preserves the ET-025 Tailwind v4/shadcn main-window theme. The renderer entry dispatches to separate dynamic view modules: only the dashboard imports `index.css` and shadcn Card; only the overlay imports `renderer.css`. Do not add the dashboard stylesheet to HTML or the shared entry because its base body background makes the transparent overlay opaque. Keep the existing `index.html?view=overlay` route and separate preload APIs. The emitted renderer test and bounded Windows runtime journeys check the generated assets and computed styles independently of real game visibility.

## Durable storage tests (ET-013)

ET-013 PR-1 adds the storage core in `packages/storage` ([storage](storage.md)). Run its suite from the repository root after `npm ci`:

```powershell
npm run test:storage
```

The command runs `node scripts/run-electron-node.mjs node_modules/vitest/vitest.mjs run --config vitest.storage.config.mts`. Vitest then runs inside the pinned Electron executable with `ELECTRON_RUN_AS_NODE=1`, so better-sqlite3 loads under the same runtime and module ABI as the telemetry service. The command prints the observed runtime and fails under any other one. Arguments after `--` reach Vitest, for example `npm run test:storage -- tests/storage/migrations.test.ts`. The suite writes only to temporary directories. The production history database, the `synthetic` directory and the storage size measurement arrive with ET-013 PR-2; until then no production history file is created.
