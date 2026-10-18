# Installer testing in a test root

ET-018 PR-1 (October 18, 2026) checks the Squirrel installer's install, repair and update paths, and the preservation of local data across them, inside a marked test root. It covers REG-017 check 1 and part of REG-013 ([plan](validation/et-018.md), decisions U10 to U13). ET-018 PR-3 adds the Windows-initiated uninstall scenarios ([below](#uninstall-scenarios)), PR-4 the in-app uninstall scenarios and PR-5 the deferred cleanup at the next sign-in, run from the registered command.

**Agents never run it on a personal machine.** It refuses to start outside a GitHub-hosted runner unless `-AllowLocal` is given, which only an explicit owner request allows (see [Local runs](#local-runs)). Run it through a Windows CI dispatch.

## Why the ET-001 harness is retired

`tests/windows/Invoke-NativeInstallerAcceptance.ps1` and `tests/windows/native-installer-step.ps1` installed into the real `%LOCALAPPDATA%\ETS2TelemetryDesktop`, seeded the real `%LOCALAPPDATA%\ETS2Telemetry` and called `--squirrel-uninstall` and `Update.exe --uninstall` directly. Once ET-018's uninstall hook removes the data root, a run would delete the user's real history. Since PR-1 both scripts throw `RETIRED_ET018_REAL_ROOTS` for `-Run`; without `-Run` they still print their plan and launch nothing. Their bodies stay unchanged as the record of the ET-001 procedure, and [ET-001 validation](validation/et-001.md) is unchanged.

## Files

| File | Role |
| --- | --- |
| `scripts/installer/Invoke-InstallerLifecycle.ps1` | The harness: CI signal, facts, guards, run root, environment, the ordered steps, evidence and cleanup. `-Plan` prints the steps and launches nothing. |
| `scripts/installer/installer-lifecycle.mjs` | The Node driver. Each command that starts a process runs as the root of its own `scripts/watchdog/BoundedProcess.cs` Job (60 s at most, 16 processes, 2 GiB, 25% CPU, kill on close). |
| `scripts/installer/installer-guard.mjs` (types in `installer-guard.d.mts`) | Pure guards and root checks; `tests/unit/installer-guard.test.ts` tests them. |
| `scripts/installer/build-upgrade-fixture.mjs` | Builds installer version B, the local update feed. |
| `scripts/installer/read-upgraded-history.cjs` | Reads the upgraded database with the installed Electron and better-sqlite3. |

## Run root

The run root R is `$env:RUNNER_TEMP\installer-<32 hex>` on CI; without a runner temporary folder it would be `.local\ci\installer-<32 hex>`. R holds two marker files before anything else runs: the ET-017 marker `ets2telemetry-plugin-test-root.marker` and `ets2telemetry-install-test.json` (plan U3):

```json
{"format": "ets2telemetry.install-test", "version": 1, "profileDir": "<R>\\profile", "runOnceKey": "HKCU\\Software\\ETS2Telemetry-Test-<run id>\\RunOnce", "shortcuts": <true on a GitHub-hosted runner, otherwise false>}
```

Every path in that file lies inside R. Since PR-5 `runOnceKey` names this run's own key, `HKCU\Software\ETS2Telemetry-Test-<the run's 32 hex id>\RunOnce`: the test install registers its deferred-cleanup executor there, never under the real RunOnce key ([uninstall](uninstall.md#deferred-cleanup-at-the-next-sign-in)). The harness also writes it to `config.json`, the driver reads and deletes only that key's one value through `reg.exe`, and the cleanup deletes the whole `HKCU\Software\ETS2Telemetry-Test-<id>` key. Since PR-3 the application's Squirrel handler reads it ([uninstall](uninstall.md#roots)): its uninstall hook cleans only this test root and uses `profileDir` as userData for the single-instance lock, and its install and updated hooks create shortcuts only when `shortcuts` is true, which the harness writes only on a GitHub-hosted runner.

| Path | Use |
| --- | --- |
| `R\LocalAppData` (B) | `SQUIRREL_TEMP`, created before Setup runs, and the `LOCALAPPDATA` of every child process |
| `B\ETS2TelemetryDesktop` | Squirrel's binary root: Setup extracts `Update.exe` into `%SQUIRREL_TEMP%\SquirrelTemp`, and Update.exe takes the parent of its own folder as its LocalAppData |
| `B\ETS2Telemetry` | The application's data root, seeded below |
| `R\temp`, `R\AppData`, `R\profile`, `R\cwd`, `R\diagnostics` | `TEMP`/`TMP`, `APPDATA`, `ETS2TELEMETRY_PROFILE_DIR`, the working directory and the per-step `ETS2TELEMETRY_DIAGNOSTIC_DIR` |
| `R\exports` | A trip export the user saved outside the data root |
| `R\Steam`, `R\LibraryA` | PR-3: the fake Steam root and library with a fake ETS2 folder, created after the PR-1 upgrade checks |
| `R\decoy` | PR-3: the `LOCALAPPDATA` of the Windows-initiated uninstall, with sentinel `ETS2Telemetry` and `ETS2TelemetryDesktop` folders |
| `R\fake-game` | PR-3: the transport folder of the fake game host |
| `R\fixture` | The copied application folder (deleted after the build) and the feed of version B |

`ETS2TELEMETRY_PLUGIN_SETUP_ROOT` is R, so plugin setup runs in its test-root mode with its registry at `R\LocalAppData\ETS2Telemetry\plugins\setup.json`, which is the seeded registry of the data root. R has no `Steam` folder during the PR-1 steps, so discovery finds nothing; PR-3's `games` step creates one. From the guards on, the harness process sets these variables for itself and every child, and removes every other `ETS2TELEMETRY_` variable it might have inherited; no child receives the real `LOCALAPPDATA`. An application launch also gets `installedEnvironment` (below), which drops Node, npm, Electron and inherited `ETS2TELEMETRY_` variables.

## Guards

All guards fail closed with a fixed code and never name a path. The harness order is:

1. **CI signal.** `GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`, checked first in PowerShell, again by `checkRunSignal` and once more by the driver's `step` and `windows-uninstall` commands before they start an installer or the uninstall, before any registry, process or file-system read. Code `LOCAL_RUN_REFUSED`. `-AllowLocal` skips the signal (an owner-requested local run only); the fact-based guards below still apply. **This signal is advisory:** it reads environment variables, which anyone can set, so it stops an accidental local run but does not prove the machine is a runner. The protection on a personal machine is the fact-based guard below: an existing real binary root or registration, a run root or any run path inside the real data, binary or Roaming root or a Steam library, and a running product or game all refuse the run, whatever the environment says.
2. **Facts.** The real LocalAppData and Roaming folders come from `Environment.GetFolderPath`, which Windows resolves through the known-folder API and never from the `LOCALAPPDATA` or `APPDATA` variables. The HKCU `Valve\Steam` `SteamPath` value and its `libraryfolders.vdf` (at most 16 KiB; a larger or unreadable list refuses the run with `STEAM_LIBRARIES_UNREADABLE`) are only read. The HKCU uninstall key `ETS2TelemetryDesktop` is read in both registry views. The process list is read before each driver command. **The facts are never written to a file:** the harness passes them to one driver command in the `ETS2TELEMETRY_INSTALLER_FACTS` environment variable, the driver removes it from its own environment at once, so no installer or launch inherits it, and the evidence keeps only `factsEvidence()`: booleans, counts, the matched product and game image names and a registered version of fixed form, never a path, the library list or another process name. `tests/unit/installer-guard.test.ts` runs the driver's guard on such facts and checks its evidence.
3. **Preflight (`checkRunPlan`)**, before R exists and again once its markers are written. It refuses:
   - a run root that is not an absolute drive path named `installer-<32 lower-case hex>`, or is a drive root (`RUN_ROOT_INVALID`);
   - any path of the run (R, every layout path, the evidence folder, a decoy and its data and binary roots) whose raw path or real location lies inside the real `%LOCALAPPDATA%\ETS2Telemetry`, `%LOCALAPPDATA%\ETS2TelemetryDesktop` or `%APPDATA%\ETS2Telemetry Desktop` (`PATH_IN_REAL_ROOT`) or inside a Steam library (`PATH_IN_STEAM_LIBRARY`). The real location is the realpath of the nearest existing ancestor, so a junction anywhere above is followed;
   - a run root whose deletion would reach a protected folder or the real LocalAppData or Roaming folder (`RUN_ROOT_CONTAINS_PROTECTED`);
   - a decoy `LOCALAPPDATA` equal to the real one, also through a junction (`DECOY_IS_REAL_ROOT`; the decoy `R\decoy` is used by PR-3);
   - an existing real `%LOCALAPPDATA%\ETS2TelemetryDesktop` (`REAL_INSTALL_PRESENT`) or HKCU registration (`REGISTRATION_PRESENT`), also when unknown;
   - a running `ETS2TelemetryDesktop.exe`, `eurotrucks2.exe`, `amtrucks.exe` or `truckersmp*` process (`PROCESS_RUNNING`), or an unreadable process list;
   - once R exists, a missing marker (`MARKER_MISSING`) or an installer test file with another format, version or key set, a path outside R or a RunOnce key outside `HKCU\Software\ETS2Telemetry-Test-<32 hex>\RunOnce` (`INSTALL_TEST_INVALID`).
4. **After each install, repair and update (`checkInstalled`).** The registration's `InstallLocation` and the binary root must both be exactly `B\ETS2TelemetryDesktop`, by raw and real location, the real binary root must still be absent, and the registered `UninstallString` must run `B\ETS2TelemetryDesktop\Update.exe`. Otherwise the run aborts at once and never uninstalls (`INSTALL_OUTSIDE_RUN_ROOT`, `REGISTRATION_MISSING`). If `SQUIRREL_TEMP` were not honored, Setup would install into the known-folder LocalAppData; this check then stops the run before any later step, and the final check reports `REAL_INSTALL_PRESENT`.
5. **Before each launch and installer step (`checkLaunchEnvironment`).** `LOCALAPPDATA`, `APPDATA`, `TEMP`, `TMP`, the profile and the diagnostic folder lie inside R, `LOCALAPPDATA` is not inside the real LocalAppData, and `ETS2TELEMETRY_PLUGIN_SETUP` is absent.
6. **Before each Windows-initiated uninstall (PR-3).** `parseUninstallString` accepts only the quoted `B\ETS2TelemetryDesktop\Update.exe` with `--uninstall` (and Squirrel's optional `-s`), read from the registration (`UNINSTALL_STRING_INVALID`, `UNINSTALL_STRING_OUTSIDE_RUN_ROOT`). `uninstallEnvironment` sets `LOCALAPPDATA` to the decoy, which must lie inside R and not be or contain the real LocalAppData (`DECOY_OUTSIDE_RUN_ROOT`, `DECOY_IS_REAL_ROOT`), keeps `APPDATA`, `TEMP`, `TMP` and `SQUIRREL_TEMP` inside R, and drops every `ETS2TELEMETRY_` variable.

## Steps

| Step | What it checks |
| --- | --- |
| Build fixture B | `build-upgrade-fixture.mjs` copies `out/ETS2Telemetry Desktop-win32-x64` into `R\fixture\app` and runs the pinned electron-winstaller on the copy with the Forge maker's options, read from `forge.config.cjs` since ET-018 PR-6, and installer version `0.1.1`; its Setup is `ETS2Telemetry-Setup-0.1.1.exe`, which the harness never runs. electron-winstaller writes into its input, so the packaged folder is never handed over itself, and its executable hash is checked after. The application bytes stay 0.1.0. The feed must hold one RELEASES entry for `ETS2TelemetryDesktop-0.1.1-full.nupkg`. This builds files only. |
| Seed | `B\ETS2Telemetry\synthetic\upgrade.sqlite`: a copy of `tests/fixtures/storage/schema-v1-representative.sqlite`, whose hash must match `manifest.txt` before and after the copy (the fixture is never written). `settings\settings.json`: format 2 with `us-customary` ETS2 units and the HUD layout. `plugins\setup.json`: both games excluded, nothing installed. `R\exports\trip-export.json`. |
| Install A | `ETS2Telemetry-Setup-0.1.0.exe --silent` from the make output (the versioned name of `forge.config.cjs` since ET-018 PR-6; `release-identity.test.ts` checks that the harness names it). The `step` command waits until no process image under R is left, because Squirrel's `--updateSelf` helper outlives its parent. |
| Installed smokes on A | `Invoke-RuntimeSmoke.ps1 -Mode installed -Executable B\ETS2TelemetryDesktop\app-0.1.0\ETS2TelemetryDesktop.exe`, `scaffold` by default (`-ScenariosA`). Each smoke has its own isolated output and LOCALAPPDATA. |
| Data launch on A | The installed application with `LOCALAPPDATA=B`, `ETS2TELEMETRY_RECORDING=synthetic:upgrade` and the test-root plugin setup. It must open the database with `{schemaVersion: 2, created: false, migratedFrom: 1}`, load the settings as `{state: loaded, migratedFrom: 2}` without a save or quarantine, run plugin setup in `test-root` mode with no action, log no failure event and exit 0. |
| Verify A | `read-upgraded-history.cjs` under the installed `ETS2TelemetryDesktop.exe` with `ELECTRON_RUN_AS_NODE=1` reads copies of the database and its backups. The binding it loaded must be the installed `better-sqlite3\prebuilds\win32-x64.node`. |
| Repair | Setup A again. |
| Update to B | `B\ETS2TelemetryDesktop\Update.exe --update R\fixture\feed`. The registration must then report 0.1.1. |
| Installed smokes on B | `scaffold`, `plugin` and `telemetry` by default (`-ScenariosB`) against `app-0.1.1`. |
| Data launch and verify on B | The database opens with `migratedFrom: null` and reads the same as on A. |
| PR-3 scenarios | See [Uninstall scenarios](#uninstall-scenarios). |
| PR-4 scenarios | See [In-app uninstall scenarios](#in-app-uninstall-scenarios). |
| Cleanup | Squirrel logs and the application diagnostics are copied into the evidence; R is deleted without following links; on CI or an owner-requested local run, an HKCU uninstall key left by a failed scenario is deleted in each registry view whose own InstallLocation points into R; this run's `HKCU\Software\ETS2Telemetry-Test-<id>` key is deleted (PR-5). The real binary root must still be absent. |

The synthetic recording target is used because the representative version 1 fixture has the purpose `synthetic`; the history path `data\telemetry.sqlite` refuses any other purpose, and a history-purpose copy would mean editing the fixture. The migration, the verified backup and the manifest follow the same `openConnection` path as history ([storage](storage.md)). No production history database may be created.

This proves the shared migration and backup path (`openConnection` with its verified pre-migration backup and manifest) in the installed runtime with its installed better-sqlite3. It does not prove the history-target wiring end to end: the default selection of `data\telemetry.sqlite`, the `history` purpose and the history backups folder `backups`. That wiring is unit-tested only: `tests/unit/history-storage.test.ts` ("opens the production history database under LOCALAPPDATA without waiting for it", "keeps history mode unchanged with an explicit history target"), `tests/unit/recording-policy.test.ts` ("opens history with no durable selection when the variable is unset or empty") and `tests/storage/migrations.test.ts`, which refuses the synthetic fixture under the history purpose with `PURPOSE_MISMATCH`; the runtime smokes also create a new history database at `data\telemetry.sqlite`, without a migration. The owner's first real upgrade of version 1 history remains the end-to-end check.

### What is asserted

- **No data write on any hook.** The data root and the export folder are hashed after the seed and after each Squirrel step; install A must equal the seed, repair must equal the state after the data launch on A, and the update must equal the repair. A link or junction in either tree fails the snapshot.
- **Byte identity.** The settings, the plugin registry and the export keep the seeded bytes through every launch and step.
- **History.** The database read with the installed runtime equals a hand-written expectation in `installer-lifecycle.mjs`: user version 2, the application id, integrity `ok`, no foreign key violation, the database UUID and purpose, `schema_migrations` with `0002-journal` naming the backup and its hash, the session, the five events, the trip with `opened_by = 'event'` and fuel used `not-observed`, the job configuration's `event` source and the row counts. Exactly one backup and its manifest exist: format `ets2telemetry-backup-1`, version 1, reason `pre-migration`, file hash and size equal to the manifest, and the backup itself at version 1 with integrity `ok` and the version 1 row counts. The database is closed without `-wal`, `-shm` or `-journal` files.
- **Installed launches.** `executableMatches`, `cwdOutsideInstall`, `minimalPath` and `developmentVariablesAbsent` of the installed smoke receipts (below).
- **Shortcuts.** After each install, the Desktop and Start menu shortcuts that point into R's binary root are counted: at least one on a GitHub-hosted runner, none elsewhere (the test file says `shortcuts: false` there); after each uninstall none.

## Uninstall scenarios

ET-018 PR-3 (plan U6, U7, U12) runs three Windows-initiated uninstalls after the PR-1 checks. Each runs the **exact registered UninstallString** as Windows Settings would, through the driver's `windows-uninstall` command, with `LOCALAPPDATA=R\decoy` and no `ETS2TELEMETRY_` variable: the uninstall hook must take its roots from the install location inside R (test-root mode) and leave the decoy byte-identical.

| Step | What it checks |
| --- | --- |
| Games | `R\Steam` with a library list naming `R\LibraryA`, a fake ETS2 folder there with `eurotrucks2.exe` (a text file), an unrelated `other-plugin.dll` and a `readme.txt` in its plugins folder; the plugin registry now manages ETS2 and excludes ATS; the decoy with sentinel files. |
| (1) Complete while the application runs | The installed 0.1.1 application starts with the test-root plugin setup, which installs the bundled plugin into the fake ETS2 folder; then the UninstallString runs. Expected: the instance has exited, the DLL is removed, the unrelated DLL and text, the game file and the export are unchanged, the data root is gone, the receipt in `R\temp` says `complete` with one plugin removed and `mode: test-root`, and the decoy is unchanged. The harness then checks that the registration and the product shortcuts are gone and that the binary root holds only Squirrel's residue (TD-013, [below](#binary-root-residue)). |
| (2) Deferred while the game runs | Setup A installs again, a plugin launch installs the plugin, and the tests-only fake SDK host `native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe` runs with the isolated test plugin DLL and a transport folder in R (the production DLL is never loaded: it would write `transport\` into the real LocalAppData). Expected: the receipt says `deferred` with `GAME_RUNNING`, `readme: true` and `executor: registered`, the DLL is unchanged, the data root holds only `plugins` and `uninstall` with `pending.json`, `README.txt` and the executor `Complete-ETS2TelemetryUninstall.ps1` (byte-identical to the tracked script), the test RunOnce value is exactly the executor command for R's data root, and the decoy is unchanged; registration, shortcuts and residue as in (1). |
| (2) at the next sign-in, still blocked (PR-5) | The driver's `run-once blocked-game`: as Windows does at sign-in, it reads the value, checks that it is exactly the executor command inside R, deletes it, and starts the command (System32 `powershell.exe` with the parsed arguments, `LOCALAPPDATA` the decoy, `TEMP` inside R) while the fake game host runs again. Expected: the executor's path-free receipt says `deferred`, `GAME_RUNNING`, attempt 2, `runOnce: registered`; the intent counts 2; the value is back with the same command; the DLL, `plugins` and `uninstall`, the unrelated files, the export and the decoy are unchanged. |
| (3) Reinstall over (2) | Setup A again: its install hook cancels the deferral, so `uninstall\pending.json`, `README.txt`, the copied executor and the test RunOnce value are gone before the next launch, whose plugin setup adopts the DLL without rewriting it (same bytes and modification time). A final Windows-initiated uninstall then runs while the fake game host runs, and defers as in (2). |
| (3) at the next sign-in, complete (PR-5) | The driver's `run-once final` with the fake game host stopped. Expected: the receipt says `complete`, one plugin removed, the data root removed and `runOnce: removed`; the DLL, the data root (with the executor itself) and the value are gone; the unrelated files, the export and the decoy are unchanged; the executor exits 0. |

Squirrel ends every process whose image lies under its root before it runs the uninstall hook (`UpdateManager.FullUninstall` calls `KillAllExecutablesBelongingToPackage` at the pinned commit `eef37460ae`), so in scenario (1) the receipt's `instance` is `none` or `exited`, and both are accepted; the evidence records which. A complete uninstall also asserts `executor: removed` and no test RunOnce value: the hook registers the executor before its first deletion and removes it last. Until PR-5, scenario (3)'s final uninstall completed while the application ran, as (1) does; it now defers so that the executor's complete run is observed in an installed layout, and (1) keeps the running-application case. The run root makes the script's path 126 characters, too long for the absolute `powershell.exe` form within 260 characters, so the lifecycle's installs register the PATH form `powershell.exe ...` ([uninstall](uninstall.md#deferred-cleanup-at-the-next-sign-in)); the driver computes the expected command with the same rule, and the absolute form is checked by the unit tests and `Test-DeferredCleanup.ps1`. The hook's own lock request (U6) matters for an instance that runs from another location with the same userData. The scenarios add about two to three minutes to the step; their first hosted observation is the PR-3 dispatch.

### Binary root residue

At the pinned commit `eef37460ae`, `FullUninstall` deletes the binary root with `DeleteDirectoryOrJustGiveUp`, which leaves every file it cannot delete (Update.exe itself runs the uninstall), and then always writes the one-space `.dead` marker; `cleanDeadVersions` marks an `app-` folder it could not delete with its own `.dead`. After each uninstall the harness first writes `residue-listing-<label>.json` to the evidence: every entry left in the binary root by relative name, with its kind, size and whether its bytes are the installed Squirrel helper or a one-space marker (at most 257 entries; no machine path). Then the driver's `residue` command applies `checkUninstallResidue` (`installer-guard.mjs`, unit-tested in `installer-guard.test.ts`) and writes `residue-<label>.json`. It allows:

- `app-<version>` folders;
- `Update.exe` and `app-<version>\squirrel.exe`, each with the bytes of the installed version's `squirrel.exe`, read before the uninstall;
- the root `.dead` (required) and `app-<version>\.dead`, each one space;
- at most 256 entries.

It **tolerates and reports** Electron runtime files left in an `app-<version>` folder: a file at its top level, or its `locales` folder and a file in it, whose name is a file of this checkout's `node_modules/electron/dist` (its top-level files except `electron.exe`, and the files of its `locales` folder; never the `resources` folder). Squirrel's `DeleteDirectoryOrJustGiveUp` does not retry a file that something holds for a moment while the folder is deleted, and the hosted runs left `v8_context_snapshot.bin` once with no process of this application alive (the receipt's `otherProcesses` was 0), so such a file is cosmetic vendor residue ([TD-013](technical-debt.md#td-013-squirrel-vendor-residue-in-the-binary-root)). The tolerated names appear as `toleratedRuntimeResidue` in `residue-<label>.json` and in `lifecycle-result.json`.

Anything else fails with its relative name: the product's executable `ETS2TelemetryDesktop.exe`, `electron.exe`, `resources` and everything below it (`app.asar`, `app.asar.unpacked`, the native client and the plugin bundle), a runtime name anywhere else, an unknown file or locale, any other folder (`UNINSTALL_UNEXPECTED_DIRECTORY`), a link (`UNINSTALL_REPARSE_POINT`), a changed helper or an invalid marker. The rule follows ET-001's `Assert-UninstallResidue.ps1`, which accepts one fixed version and no runtime file.

**The decoy check** (`checkDecoyUnchanged` in `installer-guard.mjs`). Windows creates its own folders under whatever `LOCALAPPDATA` a process runs with: the first hosted run saw `Microsoft\`, `Microsoft\Windows\` and `Microsoft\Windows\Caches\` appear in the decoy during the uninstall, created by the shell or Update.exe, not by this application. The check therefore requires:

- every entry the decoy held before, among them the `ETS2Telemetry` and `ETS2TelemetryDesktop` sentinel subtrees, still present and byte-identical (`DECOY_ENTRY_REMOVED`, `DECOY_ENTRY_CHANGED`);
- no new entry with a component named `ETS2Telemetry*`, anywhere (`DECOY_PRODUCT_ENTRY_ADDED`);
- any other new entry only below the top-level `Microsoft` folder, the one documented allowance (`DECOY_ENTRY_ADDED` for anything else, also a top-level file).

The evidence records the number of allowed new entries as `decoyOsEntries`. The driver also writes `windows-uninstall-<label>-observed.json` (the receipt, the data root's entry names and the plugin's state) before its assertions, so a failing run still shows what the uninstall did.

`windows-uninstall` checks that the plugin is installed only once the application or the fake game runs, right before the UninstallString: in (1) it is the launch itself that installs the plugin. `windows-uninstall ... --rehearse` runs everything up to the UninstallString, which it parses but never starts; it exists for a local check of the driver against a fake installed layout, and the harness never passes it.

## In-app uninstall scenarios

ET-018 PR-4 (plan U8) runs two in-app uninstalls after the PR-3 scenarios, through the driver's `app-uninstall` command. Setup A installs again, and each launch starts the installed application with the test-root plugin setup and the diagnostic gate: `ETS2TELEMETRY_LIVE_SMOKE=1`, a profile folder and a diagnostic folder, all in R. The driver then emits the app event `ets2telemetry:diagnostic-uninstall-dialogs` with `uninstall` through Playwright's main-process evaluation, which makes main answer its confirmation with **Uninstall** and its result dialog with **OK** without showing them, and presses the dashboard's **Uninstall ETS2Telemetry…** button as a user would. No renderer can reach the event, and a launch without the gate never registers it ([app lifecycle](app-lifecycle.md#in-app-uninstall-et-018-pr-4)).

| Step | What it checks |
| --- | --- |
| Install for the app | Setup A again (the PR-3 scenarios ended with an uninstall); registration and shortcuts as after install A. A `plugin-launch` then installs the plugin into the fake ETS2 folder, as in PR-3's scenario (2), so the in-app runs below only start the application. |
| (5) Blocked while the game runs | The launch finds the plugin installed; then the fake SDK host `eurotrucks2.exe` starts (as in PR-3's scenario (2)), and the button is pressed. Expected: the card shows the blocked line and one blocked folder, with no path; main logs `APP_UNINSTALL` `{outcome: blocked, code: GAME_RUNNING}` and answers only the confirmation; the DLL keeps its bytes and modification time; the data root is unchanged by `checkDataRootUnchanged` (`installer-guard.mjs`, unit-tested): `data\`, `data\telemetry.sqlite`, `plugins\` and `plugins\setup.json` exist before and after, every entry keeps its kind, size and hash and none appears or disappears, except that the history database's SQLite sidecars (`-wal`, `-shm`, `-journal` in `data\`) are left out and the database itself is compared by presence, because the state before is taken while the application runs and the state after once its orderly close checkpointed the WAL away (hosted run 39125478842 failed on exactly that); no `uninstall\pending.json` exists; the unrelated files and the export are unchanged; no uninstall receipt appears; the application exits 0 when closed. The harness then checks that the registration and the files of 0.1.0 are still there. |
| (4) Complete through the app | A second launch, and the button again. Expected: the application exits by itself; every process under R ends within the run's 55 s budget (the explicit exit, the wipe, Update.exe and Squirrel's hook); `APP_UNINSTALL` `{outcome: started}` and `APP_UNINSTALL_FINISHED` `{removed: 1, rootRemoved: true, failed: 0}` are logged; main answered both dialogs; the DLL and the data root are gone; the unrelated files and the export are unchanged; Squirrel's hook wrote one receipt in `R\temp` with `complete`, code `null`, `test-root` and no plugin removed, because the application had already removed it. The harness then checks the registration, the shortcuts and the binary root residue as after the PR-3 uninstalls. |

**Two commands per scenario.** `BoundedProcess` refuses a Job timeout above 60 s, so each scenario is two driver commands, each in its own Job. `app-uninstall` (60 s Job) starts the application, presses the button and, for (4), waits for the application's exit and then until every process under R has ended. Update.exe is started detached by the application but stays in this command's Job, which would end it when the command exits, so this wait belongs to this command. Every wait in it is cut to what is left of its own 55 s budget (`APP_UNINSTALL_RUN_BUDGET_MS`). It writes `app-uninstall-<label>-observed.json` (the states before the click and, for (5), after it; the exit; the drain) and asserts nothing about the outcome. `app-uninstall-verify` (30 s Job) then reads that record, the logged rows, the files and the receipts, writes `app-uninstall-<label>-verified.json` and asserts the expectations above. `installer-guard.test.ts` ("harness Job bounds") fails when any `Invoke-Driver` call of the harness passes a timeout above the cap that `BoundedProcess.cs` enforces, or when the run budget leaves less than 5 s below it. The application's exit code in (4) is recorded but not asserted: Squirrel ends every process under its root before its hook runs, and it may end the application in the moment between the handover and `app.exit(0)`. The dialog rows and the finished row prove the order instead. The two scenarios add about two minutes to the step.

## Installed runtime smokes

`./scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode installed -Executable <binary root>\app-<version>\ETS2TelemetryDesktop.exe -Scenario <scenario>` runs an existing scenario against an installed copy (U11). The executable must sit in an installed layout, `ETS2TelemetryDesktop\app-<semver>\ETS2TelemetryDesktop.exe` beside the binary root's `Update.exe`. The launch gets PATH `%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\WindowsPowerShell\v1.0`, no `NODE_*`, `npm_*`, `ELECTRON_*` or inherited `ETS2TELEMETRY_*` variable, and the run's own working directory, which is unrelated to the install. The driver asserts that the application ran that executable, packaged, with that PATH and working directory, and records `installed` in its receipt; `RuntimeReceipt.ps1` requires these facts for mode `installed` and refuses a packaged receipt in their place. In an installed copy the `scaffold` smoke reads the uninstall card's warning but never presses its button, which would open the confirmation; the receipt then records `notInstalledShown: null`, and `RuntimeReceipt.ps1` refuses `true` for mode `installed`. A real clean machine without development tools stays a manual check.

## Squirrel behaviour of the pinned electron-winstaller

`package-lock.json` pins electron-winstaller 5.4.4. Its vendored binaries were read, not run, on October 18, 2026:

| File | Version metadata | SHA-256 |
| --- | --- | --- |
| `vendor/Squirrel.exe` (installed as `Update.exe`) | file 2.0.1.1, product `2.0.1+eef37460ae` | `76359CD4B0349A83337B941332AD042C90351C2BB0A4628307740324C97984CC` |
| `vendor/Setup.exe` | file and product 1.9.1.0 | `1E47EB606DAD4C5C1568CFB8F4E970E1051BA5806AEDB1FF3256284A8280D83B` |

`Setup.exe` contains the UTF-16 strings `SQUIRREL_TEMP` and `SquirrelTemp`; `Squirrel.exe` contains `SQUIRREL_TEMP`, `uninstalling anyways` and the four `--squirrel-*` hook arguments. The behaviour the plan assumes is in the source of the pinned commit [`eef37460ae`](https://github.com/Squirrel/Squirrel.Windows/tree/eef37460ae):

- `src/Setup/UpdateRunner.cpp`: `SQUIRREL_TEMP` is used when it exists, is writable and is not a UNC path; otherwise the known-folder LocalAppData (`SHGetFolderPath(CSIDL_LOCAL_APPDATA)`); `\SquirrelTemp` is appended in every case, and Update.exe runs as `Update.exe --install .` from there.
- `src/Squirrel/UpdateManager.cs`: `GetLocalAppDataDirectory` returns the parent of Update.exe's folder, so the binary root follows `SQUIRREL_TEMP`.
- `src/Squirrel/Utility.cs`: `GetTempDirectory` also prefers `SQUIRREL_TEMP`; `DeleteDirectoryOrJustGiveUp` swallows a failed delete.
- `src/Squirrel/UpdateManager.ApplyReleases.cs`: the install and updated hooks get `CancelAfter(15 * 1000)`, the obsolete and uninstall hooks `CancelAfter(10 * 1000)`; a failed uninstall hook logs "Failed to run pre-uninstall hooks, uninstalling anyways"; full uninstall deletes the root and writes `.dead`.

The version string ties the vendored `Squirrel.exe` to that commit; the binary was not decompiled, so the hook timeouts are taken from the source, and the CI run is their first observation in this repository.

## Local runs

Without `-AllowLocal` the harness refuses every local run. `-AllowLocal` (plan O6) is for an explicit owner request only; agents never pass it. Until PR-3 it refused as well (`LOCAL_RUN_UNAVAILABLE_UNTIL_PR3`), because electron-squirrel-startup's install and update hooks created real Desktop and Start menu shortcuts whatever the test root said. Since PR-3 the application's own handler skips them for a test install whose test file says `shortcuts: false`, which the harness writes off a hosted runner, and the uninstall scenarios remove the registration they create; the cleanup deletes a key that a failed scenario left, when it points into R. Every launch, hook and the uninstall get `APPDATA` inside R and the test file's profile as userData, so no hook writes the real Roaming `ETS2Telemetry Desktop` folder. A local run still needs the fake game host and the test plugin DLL from `npm run native:build`. `-Plan` is safe everywhere.

Agents run the lifecycle only through a dispatch:

```powershell
gh workflow run windows-ci.yml --ref <task-branch> -f extended=false
gh run list --workflow windows-ci.yml --branch <task-branch> --limit 1
```

## CI

The first hosted run passed on October 18, 2026: dispatch run [39087647383](https://github.com/senukartur/ets2telemetry/actions/runs/39087647383) at `fbdd34c`, step 2 min 10 s ([ET-018 validation](validation/et-018.md#hosted-run)).

The scaffold job runs the step **Installer lifecycle in a test root** right after **Forge maker and static native package inspection**, on pushes to `main` and on dispatch only, like the maker that builds its Setup.exe; its limit is 8 minutes ([ci](ci.md#et-018-installer-lifecycle)). The evidence folder `.local/ci/installer-<id>-evidence` is part of the uploaded `.local/ci`; R lives in the runner's temporary folder and is never uploaded.

On a hosted runner the install and updated hooks create the product's Desktop and Start menu shortcuts and each uninstall removes them; the scenarios assert both. The registration is removed by the last uninstall; a key left by a failed scenario is deleted in each registry view whose InstallLocation points into R. The runner is discarded after the job.

## Evidence

`.local/ci/installer-<id>-evidence` holds `config.json` (the run layout only), one JSON file per driver command (`guard-plan.json`, `seed.json`, `snapshot-<label>.json`, `compare-<before>-<after>.json`, `step-<label>.json` with the program's output, `launch-<label>.json`, `verify-<label>.json`, `history-<label>.json`, PR-3's `games.json`, `plugin-launch-<label>.json`, `windows-uninstall-<label>.json` and `windows-uninstall-<label>-observed.json` with the receipt, PR-5's `run-once-<label>.json` and `run-once-<label>-observed.json` with the executor's receipt, `residue-listing-<label>.json` and `residue-<label>.json` with the tolerated runtime files, `cleanup.json`), the Job folders `job-<label>`, the installed smoke runs `installed-<guid>`, `upgrade-fixture.json`, `run-root\` (Squirrel logs and application diagnostics) and `lifecycle-result.json` with each step's exit code and seconds.

## Limits

- The deferred cleanup's `run-once` steps start the registered command as Windows would; a real sign-in, its timing, the message box (shown only in production) and an antivirus reaction to a RunOnce PowerShell command stay manual checks.
- The install, updated and obsolete hooks write no data, which the snapshots show; only an install or update that finds a deferral removes its intent and README.
- A real clean machine, SmartScreen, Smart App Control, real shortcuts, the real game folders and the owner's first real upgrade of version 1 history stay manual checks ([ET-018 validation](validation/et-018.md)).
