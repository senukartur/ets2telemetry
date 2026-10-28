# Application lifecycle (ET-011a)

ET-011a makes ETS2Telemetry a notification-area (tray) application. Closing the main window no longer stops anything; only an explicit exit does. This page describes the desktop process lifecycle. The decisions behind it are C1–C17 in [concept.md](../concept.md#et-011-authorization--october-15-2026). Persistent settings and unit profiles are ET-011b; see [settings](settings.md).

For readers new to desktop development: the *main process* is Electron's Node.js process that owns windows, the tray icon and the telemetry service. A *renderer* is the sandboxed Chromium page of a window; it reaches main only through the narrow preload bridge. The *notification area* is the icon area at the right of the Windows taskbar, including its overflow flyout.

## Single instance

Only one ETS2Telemetry process tree runs per profile. On startup, main first handles Squirrel installer arguments, then applies the `ETS2TELEMETRY_PROFILE_DIR` override (an absolute diagnostic profile used by isolated tests), and only then asks Electron for the [single-instance lock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata). Electron keys the lock by the `userData` directory, so the override must come first.

- **Second launch.** When the lock is held, the new process calls `app.quit()` before it creates a log, registers any listener, starts the service or opens a window or tray icon, and exits with code 0. It writes no diagnostic log and starts no service, window or tray; only the diagnostic profile directory may be created when the override is set. If that override fails, the process requests no lock at all and exits 1 with `PROFILE_SETUP_FAILED`, so a misconfigured diagnostic launch never signals the running instance.
- **Running instance.** It receives Electron's `second-instance` event and ignores the second process's command line and working directory. Its additional data is read for one exact payload only (ET-018 PR-3): `{ets2telemetry: 'uninstall-exit'}`, a plain object with exactly that key and value, which the [Squirrel uninstall hook](#squirrel-events) sends. It runs the explicit exit with reason `uninstall` and logs `SECOND_INSTANCE` with `uninstall-exit`, or `ignored-exiting` when the exit already began; main deletes nothing for it. Every other payload, including one with an extra key, only shows the dashboard. Otherwise it logs `SECOND_INSTANCE` with a fixed `action`:

| State of the running instance | Action |
| --- | --- |
| Exiting | `ignored-exiting`: nothing reopens |
| Before first service readiness | `ignored-starting`: the dashboard appears on readiness anyway |
| Dashboard minimized | `restored`: restore, show and focus |
| Dashboard open | `focused`: show and focus |
| Dashboard closed to the tray | `created`: a new dashboard window |

Windows may refuse to move a window to the foreground when another application holds it; the taskbar button then flashes. That is an operating-system rule, not an error.

A development launch (`npm run dev`) and an installed copy share the same `productName`, and therefore the same `userData` and instance lock: the second one only focuses the first. To run both side by side, give the development launch its own absolute `ETS2TELEMETRY_PROFILE_DIR`.

## Squirrel events

Since ET-018 PR-3 (plan U2) `apps/desktop/src/squirrel-events.ts` replaces electron-squirrel-startup. Main parses the arguments first, before the diagnostic profile override, any log, the settings, plugin setup and the service (unpackaged, the first argument after the executable is the application path and is skipped). For any `--squirrel` argument main first turns off hardware acceleration and runs the GPU and the network service in the main process (`--in-process-gpu`, `NetworkServiceInProcess2`), so the event process starts no child process that could outlive it while Squirrel deletes the install folder; a normal launch is unchanged. Only exactly `--squirrel-<event> <version>` is an event; `--squirrel-firstrun` alone starts the application normally; any other argument that starts with `--squirrel` exits 4 and changes nothing.

| Event | What runs | Exit code |
| --- | --- | --- |
| `--squirrel-install`, `--squirrel-updated` | `Update.exe --createShortcut=<executable>` (a production install; a test install only when its test file sets `shortcuts: true`) and, at the same time, the [Installed apps icon](release.md#installed-apps-icon-et-045g) (ET-045g): the packaged `resources\icon\app.ico` is placed at `<install root>\app.ico`, and this product's uninstall entry gets `DisplayIcon = <install root>\app-<version>\ETS2TelemetryDesktop.exe,0` (two attempts of at most 2 s). Then, at the same time, this install's old "ETS2Telemetry Desktop" shortcuts are deleted beside the new ones, only after `--createShortcut` succeeded, only where the "Yukon Union Telemetry" one exists and only when they belong to this install (ET-045h, [shortcut migration](release.md#shortcut-migration-et-045h); at most 1 s), and a pending [uninstall deferral](uninstall.md#deferral) is cancelled, with the copied executor and its RunOnce registration (ET-018 PR-5). A failure of the shortcuts, the icon or the old-name step changes neither the other steps nor the exit code; at worst the hook takes 12 s (10 s shortcuts, then the larger of the 1 s old-name step and the 2 s disarm), as before. No data is written otherwise. | 0 |
| `--squirrel-obsolete` | Nothing; the previous version after an update quits. | 0 |
| `--squirrel-uninstall` | The [uninstall hook](uninstall.md#squirrel-uninstall-hook): the instance lock with the `uninstall-exit` payload, the engine within 8 s, the receipt. | 0, 3 or 4 |

electron-squirrel-startup was removed because its uninstall branch quits the process when `Update.exe --removeShortcut` closes, which would race the cleanup. A start of the installed application also cancels a pending deferral, with its RunOnce registration. Squirrel runs these hooks with 15 s (install, updated) and 10 s (obsolete, uninstall); see [installer testing](installer-testing.md#squirrel-behaviour-of-the-pinned-electron-winstaller).


## Start with Windows and background launch (ET-031)

ET-031 adds an optional Start with Windows capability:
- **Login item registration:** When enabled in an installed application, the login item registers Squirrel's `Update.exe` rather than the versioned executable path (`app-<version>\ETS2TelemetryDesktop.exe`):
  `Update.exe --processStart "ETS2TelemetryDesktop.exe" --process-start-args "--hidden"`
  Pointing to `Update.exe` ensures that when Squirrel updates the application to a newer version directory, the Windows Run entry remains valid and executes the updated executable.
- **Background launch via `--hidden`:** When launched with the `--hidden` command-line switch, Electron main initializes the telemetry service, tray icon, and transparent overlay as usual, but skips initial dashboard window creation (`createWindow()`). The application starts running quietly minimized to the notification area (system tray).
- **Subsequent launch:** A second launch of the application (or clicking the tray icon) detects the running instance and invokes `openDashboard()`, creating and focusing the dashboard window.
- **Uninstall deregistration:** When uninstalled (either via in-app uninstall handover or via Squirrel's `--squirrel-uninstall` hook), the login item is removed cleanly via `removeAutostartLoginItem()`, preventing orphaned autostart entries.

## Close to tray

Closing the dashboard window destroys that window and retires only its document state: its live subscription, its application-state subscription and its renderer epoch. The telemetry service, the upstream live channel, main's freshness clocks, the overlay and the tray stay as they are. The overlay keeps following the game while the main window is closed. A source request still in flight from the closed document is rejected when it completes. An active overlay edit mode (ET-012b) is cancelled without saving when the dashboard closes, is minimized or its document is retired, and when the exit begins; see [the minimal overlay](minimal-overlay.md#edit-mode-et-012b).

Reopening (tray icon click, the tray's **Open Yukon Union Telemetry**, or a second launch) creates a new window that subscribes again through the existing bridge; main reuses the single upstream channel. A service restart while the window is closed recreates no window and no second overlay: windows are created once, on first readiness.

The overlay window refuses close requests until the application exits. If creating the tray icon throws, main logs `TRAY_UNAVAILABLE` and closing the dashboard minimizes it instead. This fallback covers only a constructor that throws: on Windows, Electron does not throw or report it when the shell rejects the icon registration (`Shell_NotifyIcon`), so the application cannot detect a missing icon and the dashboard still closes to the tray. Launching ETS2Telemetry again is the guaranteed way back in every case, because the second launch reopens the dashboard. Whether the real icon appears is a manual check.

`window-all-closed` does nothing: the tray keeps the application running.

## Tray icon

The icon is created when Electron is ready, before the service starts, with the tooltip `Starting`. It has no fixed GUID. The bitmap is the application icon's small "road merge" mark with a status dot in its lower right corner, in 16, 20, 24 and 32 px representations for 100%, 125%, 150% and 200% display scaling ([application icon](design/ui-spec.md#3-tokens-type-and-icons)). `scripts/generate-app-icons.mjs` renders them into `apps/desktop/src/tray-icon-data.ts`, read by `apps/desktop/src/tray-icon.ts`. The dot's colour shows health: green when ready, amber while starting, restarting or exiting, red when the service has failed. Since October 22, 2026 the executable, Setup and the main window also carry the application icon (`resources/icon/app.ico`); it replaced the earlier plain coloured disc.

The context menu contains:

1. a disabled status line, for example `Service: ready · Storage self-test: verified`;
2. the disabled line `Recording: <short headline>` with the [recording status](#recording-on-the-dashboard-and-in-the-tray-et-015c-pr-4), for example `Recording: off in this version` in production or `Recording: on · synthetic test database` for a synthetic recording target (ET-015c PR-4);
3. **Open Yukon Union Telemetry**;
4. **Exit Yukon Union Telemetry**.

A left click opens the dashboard. The tooltip shows the service state and, when ready, the selected source and its status; it stays under the 127-character Windows limit and carries no readings, paths or identities. Tooltip, menu and icon are rebuilt only when they change, at most twice per second. There are no balloon notifications.

## Explicit exit

Every way to leave the application goes through one idempotent exit coordinator (`apps/desktop/src/app-lifecycle.ts`):

| Trigger | Reason logged |
| --- | --- |
| Tray **Exit Yukon Union Telemetry** | `tray` |
| Dashboard **Exit Yukon Union Telemetry** button (`exitApplication()`) | `renderer` |
| `app.quit()`, including Playwright's `close()` | `app-quit` (`before-quit` is prevented and redirected) |
| Windows sign-out or shutdown (`session-end` on any window) | `session-end` |
| The Squirrel uninstall hook's `uninstall-exit` payload (ET-018 PR-3) | `uninstall` |
| A started [in-app uninstall](#in-app-uninstall-et-018-pr-4) (ET-018 PR-4) | `uninstall` |
| An applied [in-app update](#in-app-updates-et-055) that restarts (ET-055 PR-6) | `update` |

The first request logs `APP_EXIT_REQUESTED` with its reason, sets the tray tooltip to `Exiting`, disables the menu, retires live subscriptions, hides the overlay and asks the supervisor to stop the service. Later requests do nothing. `query-session-end` is not prevented. After the supervisor finishes, the coordinator waits for pending idle work (an in-flight [settings](settings.md#saving) save, since ET-016 PR-5 the removal of an interrupted [trip export](journal-export.md#saving-a-trip-j16-j17)'s partial file, since ET-017 PR-6 the same for an interrupted [diagnostic bundle](plugin-setup.md#diagnostic-bundle) export, and, since ET-017 PR-4, the [plugin setup](plugin-setup.md#setup-run) run in flight, which the exit aborts and which ends with the removal of its temporary file, and its registry write of an exclusion change or folder choice; together at most 1000 ms from the request; new saves, exports and plugin setup requests are refused once the exit started), removes the tray icon so no ghost icon remains, writes its final log rows (the append in flight gets at most 300 ms, [diagnostics log](#diagnostics-log)) and calls `app.exit(code)`. The supervisor's existing bounds are unchanged: the service is killed after 3000 ms without a clean stop and the application exits after 5000 ms in any case. Main-internal fatal paths still exit 1 through the same final step. A fatal stop (for example renderer or overlay restart exhaustion, a load or configuration failure, or a service recovery timeout) marks the application exiting as soon as it starts, without logging an exit request: the tray shows `Exiting` with a disabled menu, live state is retired, the overlay may close and neither the tray nor a second launch reopens the dashboard during the stop window.

### Windows terminal session boundary — October 21, 2026

The supervised completion described above applies while Electron can keep its event loop running. The pinned
[Electron 44.7.0 native handler](https://github.com/electron/electron/blob/v44.7.0/shell/browser/native_window_views_win.cc#L383-L413)
notifies every window of confirmed `WM_ENDSESSION`, then immediately terminates main if Electron has not begun its own
quit. Our `before-quit` redirection deliberately prevents that separate quit path. Returning from a JavaScript
`session-end` callback therefore cannot await the supervisor or an asynchronous log append. This explains the real
October 21 sign-out's missing main rows despite the service's clean stop; its frozen evidence remains partial.

Confirmed `session-end` now enters synchronous terminal logging **before** requesting the same idempotent lifecycle
stop. It removes the tray synchronously and writes `WINDOWS_SESSION_END_HANDOFF` with `{completion: 'os-owned'}` before
returning to Electron. Duplicate notifications across dashboard/overlay do nothing. `query-session-end` is left inert:
Windows may cancel a query, so it must neither stop the service nor veto the user's session end.

If a synchronous lifecycle hook rejects, `WINDOWS_SESSION_END_REQUEST_REJECTED` records that failure. A `finally`
boundary still attempts tray disposal and writes the truthful OS handoff once; it does not claim that service stop
was requested or completed. A boundary regression injects a native tray rejection and duplicate window notifications.

The handoff marker records the native termination boundary, not a completed service flush or a supervisor-observed
exit. `SERVICE_EXIT` and `APP_EXIT` are written only if those events are actually observed. A full asynchronous
supervised completion cannot be guaranteed at this boundary without changing Windows shutdown policy; this fix does
not add a veto, delay, new native service or wider deadline. Real sign-out/restart acceptance still requires the owner
and separate service/storage evidence, not merely a zero exit code or absent processes. Both owner-run corrected
sessions passed on frozen runtime `15dab09`; see [the bound results](validation/et-011.md#actual-corrected-windows-sessions-and-code-gates).
The later exception-path guard has separate automated coverage and is not relabeled as part of that frozen artifact.

Terminal logging keeps the existing 256 KiB/2,000-record limits and fixed-code console fallback. It drains the queued
rows and writes later rows synchronously; an older append already in flight is not replayed and can land later or be
lost. A full log or unavailable/stalled disk remains an explicit diagnostic limit. The regular recording/telemetry
path remains asynchronous.

## In-app uninstall (ET-018 PR-4)

The Live tab's **Uninstall Yukon Union Telemetry** card calls the bridge method `uninstallApplication()` on the `app:uninstall` channel. Main accepts it only from the trusted dashboard's main frame (the overlay and any other sender are refused), only with zero arguments (preload refuses any argument before IPC, and main refuses again), and refuses it once the exit has begun. The answer is `{outcome: 'cancelled' | 'not-installed' | 'blocked' | 'interrupted' | 'started' | 'failed', code?, removed?, blocked?: [{targetId, reason}]}` with fixed codes and the plugin card's target ids, never a path. The steps before `started` are in [uninstall](uninstall.md#in-app-uninstall).

After `started`, main runs the exit in this order:

1. **The explicit exit** with reason `uninstall`, exactly as above: the service stops (its 2,500 ms stop sequence, the supervisor's 3,000 ms kill and 5,000 ms bounds unchanged), idle work settles, and plugin setup, already suspended, stays stopped. A **12 s failsafe** is armed when this exit begins; it ends the application with code 1 if the steps below have not reached the result dialog. Every other exit reason keeps the existing 5 s bound alone.
2. **The final log rows** (`log.finalize`, [diagnostics log](#diagnostics-log)): `SERVICE_EXIT`, `APP_EXIT` and the rows before them land first. After `finalize` every row is written synchronously, so no row can be in flight during the wipe.
3. **The data wipe** within what is left before the failsafe, less 1 s for the result dialog and the handover, and at most 5 s (`uninstallWipeBudget`): a slow exit shortens the wipe instead of letting the failsafe cut it. The allowlisted entries, then the install registry, then the intent and the empty data root. In a production install the log folder lies inside the data root, so from here on main writes **no** log row (`APP_UNINSTALL_FINISHED`, the failsafe's and the handover's rows are written only when the log folder lies outside the data root, as with `ETS2TELEMETRY_DIAGNOSTIC_DIR`); a row would recreate the folder.
4. **The failsafe is disarmed** and the **result dialog** shows what was removed and what remains: plugin files removed, files with the plugin's name that were not this application's, unknown entries kept in the data folder, entries that could not be deleted, and every `plugins.notes` entry as its fixed text. The dialog waits for the user, so it comes after the failsafe.
5. **The handover**: `<install root>\Update.exe --uninstall` is started detached, then `app.exit(0)`. Squirrel ends every process under the install root, runs the uninstall hook, which finds nothing left and, in a production install, removes the Roaming userData folder (O7), and removes the program files, the shortcuts and the registration. If Update.exe cannot be started, an error dialog asks the user to uninstall from Windows Settings, Apps. It says that the plugin and the data were removed only when the wipe listed no failure and removed the data root; otherwise it says that some local data remains and that the uninstall from Windows Settings removes the program files and finishes removing that data where it can, because its uninstall hook reads the intent the wipe left.

**If the wipe is short or the failsafe fires.** Entries a short wipe did not reach stay, with the intent `uninstall\pending.json`; the result dialog lists them as not deleted yet and says that the Windows uninstall starting now finishes removing them (only an entry that really failed is left for deletion by hand), and the uninstall hook that the handover starts finds the intent and finishes the wipe. If the failsafe fires (the exit itself took about 11 s or more, or one deletion hung), the application exits 1 with no handover: the plugins are already removed, the data is kept wholly or in part, and the intent stays. The next start of the installed application cancels that intent like a deferral ([uninstall](uninstall.md#deferral)), and its plugin setup installs the plugin again in every game folder it manages while that game is closed; the user can then uninstall again.

## In-app updates (ET-055)

ET-055 PR-6 (October 28, 2026) adds the update controller in main (`apps/desktop/src/updater/`), under decisions UP2, UP3 and UP6 to UP9 ([concept.md](../concept.md#et-055-in-app-updates-and-staging-channel--october-28-2026)). ET-055 PR-7 adds its user interface, described under "What the user sees" below. The feed and the signed manifest are in [releases](release.md#update-feed-et-055).

**When it checks.** Only an installed Squirrel build checks: an unpackaged run, a portable package (no Squirrel install layout, [uninstall roots](uninstall.md)) and an isolated launch (`ETS2TELEMETRY_PROFILE_DIR`, `ETS2TELEMETRY_DIAGNOSTIC_DIR`, `ETS2TELEMETRY_LIVE_SMOKE` or `ETS2TELEMETRY_SOURCE_KIND`, as in the [plugin setup mode gate](plugin-setup.md)) report `unsupported` and never fetch. The first check runs 15 s after the first readiness, then every 6 h, on an unreferenced timer; a manual check (`checkForUpdates()`) runs at once unless a check or an update runs or a check started less than 10 s ago. A check that fails stays silent: the view stays or becomes `idle` and only `lastCheck` says `failed` with its code. A supported start removes everything left in `<data root>\updates`.

**The click.** `updateApplication()` in `available`, `refused` or `failed`:

1. **Refusals (UP7).** `EXITING` once any exit began; `BUSY` while the in-app uninstall runs or this update's background check runs; then the running-game listing: `GAME_RUNNING` while `eurotrucks2.exe`, `amtrucks.exe` or any `truckersmp*` process runs, `GAME_CHECK_FAILED` when the listing fails (fail closed). The uninstall and the exit are checked again after the listing, so a click whose listing straddles the start of an uninstall is refused with `BUSY`. A refused click changes nothing on disk and the next click tries again.
2. **Download.** The nupkg goes to `<data root>\updates\<NuGet version>\<name>.partial` (at most 400 MiB, ended after 60 s without data and after 30 min in total), hashed while it is written and renamed to its name only when its size, SHA-256 and SHA-1 equal the signed manifest. A one-line `RELEASES` (upper-case SHA-1, name, size) beside it makes the folder a local Squirrel feed. `progress` is a whole percentage.
3. **Apply.** Just before it, the in-app uninstall is checked once more: if one started during the download, the download is removed, nothing is installed and the click ends `refused` with `BUSY`. Then `<install root>\Update.exe --update <that folder>` runs through `runFixedProgram` with fixed arguments, a 180 s deadline and a 16 MiB output bound. When either bound is reached, `runFixedProgram` **kills** `Update.exe` (`APPLY_TIMEOUT` for the deadline; the output bound and any other failure are `APPLY_FAILED`). The `updates` folder is removed afterwards, whatever the result.
4. **Restart.** The games are checked again. If a game or TruckersMP started meanwhile, or the listing fails, the state is `ready` ("restart to finish"): the next start runs the new version, and a click in `ready` restarts once no game runs. Otherwise the state is `restarting` and main requests the explicit exit with reason `update`.

**The update exit (UP8).** The reason `update` runs the unchanged exit coordinator: the service's stop sequence (intake, `recording-flush`, storage; 2,500 ms), the supervisor's 3,000 ms kill and 5,000 ms bounds, the idle work and the tray removal. In the final exit step, after the final log rows, main starts `<install root>\Update.exe --processStartAndWait <executable>` detached (it waits for this process to end, then starts the newest installed version; at most 2 s are allowed for it to spawn), logs `UPDATE_RESTART_STARTED` or `UPDATE_RESTART_FAILED` and exits. Only an exit requested with reason `update` starts it; a fatal stop or any other reason never does.

**An exit during an update.** The exit retires the controller: no new check or click, a check in flight is aborted, a download is aborted and its `.partial` and version folder are removed as part of the exit's idle work. The exit itself never interrupts or awaits a running `Update.exe --update`; when it finishes, nothing is restarted, and the next start runs whichever version Squirrel then has. Whether an apply that ends early can leave a partial `app-<version>` folder is ET-055 risk R1. It can end early through an exit or a power loss, and also through `runFixedProgram`'s own kill at the 180 s deadline (`APPLY_TIMEOUT`) or the 16 MiB output bound, so the hosted update lifecycle (PR-8) must observe a killed apply as well as an exit and a power loss.

**The in-app uninstall excludes the update (review round 1).** The two never overlap. The controller is `busy` while it downloads, installs or restarts; the [in-app uninstall](#in-app-uninstall-et-018-pr-4) is then refused with `{outcome: 'failed', code: 'UPDATE_IN_PROGRESS'}`, by main before the orchestrator runs and by the orchestrator before its confirmation and again after the dialog closes, so an update click during the dialog still wins before anything is removed. Conversely the click is refused with `BUSY` while an uninstall runs or is prepared, checked at the click, after the running-game listing and before `Update.exe`.

**Known gap: a Windows-initiated uninstall during the apply ([TD-025](technical-debt.md#td-025-a-windows-initiated-uninstall-during-an-in-app-updates-apply)).** An uninstall from Windows Settings or Control Panel does not ask the controller: the Squirrel hook's `uninstall-exit` payload makes main run `requestExit('uninstall')` directly. While the update is `installing`, that exit leaves the running `Update.exe --update` alone, so Squirrel's `--uninstall` can overlap it; whether Squirrel's own lock between `--update` and `--uninstall` serializes them is unverified. PR-6 changes no code for it, because the hook waits at most 6 s for the instance while an apply may take 180 s. The hosted update lifecycle (PR-8) must observe it together with the killed apply; if that shows harm, a follow-up blocks it.

**What the dashboard gets (UP9).** `AppState.application` (`version`, `channel`, `packaged`) and `AppState.update` (`state`, `available`, `progress`, `refusal`, `failure`, `lastCheck`) with fixed enums and versions only, never a URL, path or file name. Main validates both before it sends them: an invalid view is replaced by `unsupported` and logged as `UPDATE_VIEW_REJECTED`, and an invalid build version (never expected; the build resolver checks it) by the fixed version `0.0.0`, logged once as `APPLICATION_INFO_INVALID`. The dashboard preload validates them again and substitutes the same fallbacks, so the rest of the state (health, settings, plugins) still arrives; only a state that is not an object is dropped (push) or rejected (query). The two argument-free bridge methods use the channels `update:apply` and `update:check`, accepted only from the trusted dashboard's main frame (the overlay and any other sender are refused) and only with zero arguments; both answer with the update view. The `updates` folder belongs to the [uninstall](uninstall.md) data allowlist, and the diagnostic bundle reads none of it.

**What the user sees (ET-055 PR-7).** The sidebar shows an update control (`shell.sidebar.update`, UP10) under the recording indicator and the version line (`shell.sidebar.version`, UP11) under it; [the UI specification](design/ui-spec.md#4-application-shell) lists the exact EN/RU texts. The control is hidden while the view is `idle`, `checking` or `unsupported`, so a development run, a portable package and an installed build with nothing to install show only the version line ("Development build" unpackaged, "Version 0.1.1" packaged, plus a "Staging" badge in a staging build). In `available`, `refused`, `failed` and `ready` a click calls `updateApplication()`; while downloading, installing or restarting the button keeps focus but is `aria-disabled` and ignores clicks. Settings → About repeats the version line and has **Check for updates**, which calls `checkForUpdates()`. If the reply is `checking`, About waits beside the button until `lastCheck` reports a newer finished check, at most 30 s; any other reply means no check started (a check started within 10 s of the previous one, a click or an operation in flight), so About answers at once: a standing offer with its version, otherwise the latest finished check. In `ready` the button is busy with a note on finishing the installed update, and while an update runs it is busy. The answer stays until the next click. Where the launch never checks, the button is disabled with a note. Only the view and the application info drive these words; no URL, path or file name is shown.

## Service shutdown

The service stops through an ordered sequence (`apps/desktop/src/shutdown-sequence.ts`):

| Phase | Steps (budget) |
| --- | --- |
| `intake` | `ingestion` (1000 ms), `capture` (1000 ms), `v1-ingestion` (1000 ms; ends the protocol v1 source and waits for its broker, ET-006b; it never waits for storage, which is the `recording-flush` step's job) |
| `flush` | `recording-flush` (500 ms nominal, ET-015a PR-3; owner-approved unused-intake allocation since October 21, 2026, [below](#recording-flush-allocation-et-012-correction)): drops queued durable v1 work and waits for the one storage command in flight, so the database closes after it and no ACK is written after the source stopped. Since ET-015b PR-3 it then writes the pending one-second samples, at most 300 rows per plugin session in one `appendSamples` each, unless durable delivery has failed, and logs `V1_SAMPLES_EXIT {rows, losses, code}` once when rows or loss intervals were pending ([one-second samples](telemetry-service-v1.md#one-second-samples-et-015b)); rows still unwritten when the effective step deadline expires are lost, and the storage close still finishes the command in flight. With no recording target it has nothing to wait for |
| `storage` | `storage-probe` (1000 ms), `history-storage` (1000 ms nominal budget, closes the history database; ET-013 PR-2). 800 ms is the baseline close grace when earlier phases consume their full budgets; under ET-038 adaptive stop grace, unused budget from earlier stop phases (prompt intake and flush phases, typically <50 ms) cascades adaptively to history storage up to ~2,250 ms (with an expanded effective budget up to ~2,450 ms and a 200 ms termination reserve, plus one event-loop turn for answers that already arrived). It fails when the worker had not answered the close by then or had failed earlier in the session ([storage](storage.md#history-database-in-the-telemetry-service)) |

Steps of one phase run in parallel with their effective allocated budgets; nominal phase maxima govern registration, with the adaptive recording/history rules below and the existing verdict-turn scheduling limitation. Since October 18, 2026 the `timeout` verdict runs one turn after the budget (an immediate, after the next poll phase): a service thread stalled past the budget runs the due budget timer before it delivers I/O that arrived meanwhile, so a step result that was already waiting still counts, and a step that has not finished by then times out ([ET-013 validation](validation/et-013.md#history-close-grace-flake-october-18-2026)). Registration fails if the sum of phase maxima exceeds `SERVICE_STOP_BUDGET_MS` (2500 ms), which retains the nominal allocation before main's 3000 ms kill deadline. Since ET-015a PR-3 the maxima are 1000 (`intake`) + 500 (`flush`) + 1000 (`storage`) = 2500 ms, the whole budget; a further step must fit inside an existing phase maximum. In ET-038, the unused budget from prompt intake and flush execution cascades to the storage phase steps, allowing slow SQLite closes to finish cleanly without premature termination while retaining the nominal 2500 ms allocation and existing scheduling/floor limitations. Every step, successful ones included, logs `SHUTDOWN_STEP` with fixed `phase`, `name`, `outcome` (`ok`, `failed` or `timeout`) and `ms` facts; a failed or late step does not stop the sequence. The service then sends exactly one `{type: 'stopped', clean}` message and, after its final log rows are on disk ([diagnostics log](#diagnostics-log)), exits 0 when clean or 1 otherwise.

ET-011 allocation correction, October 22, 2026: recording flush can borrow only the unused registered intake maximum,
measured from actual elapsed monotonic time, and only within the remaining sequence budget after reserving the full
registered future storage maximum. Prompt intake permits up to 1500 ms flush, full intake leaves its nominal 500 ms,
and no registered intake means no borrowed allowance. Other flush steps keep their own budgets. History close then
uses the time actually remaining, so borrowed time is not spent twice. Registration still checks 1000 + 500 + 1000;
the 2500 ms sequence, 3000 ms main kill and 5000 ms application budgets and 200 ms termination reserve remain.
Nominal floors and the existing verdict-turn behavior remain; arbitrary host scheduling can exceed measured wall time.

## Service failures after readiness

Before the first readiness, a service failure report or start timeout still stops the application with exit code 1. After it, a failure report (for example a failed storage self-test), a restarted service's missed 15 s start deadline or an unexpected exit uses the existing supervised restart: 250 ms, then 1000 ms, at most two restarts per 60 s. A reported failure first terminates the current service; if it has not exited within 3000 ms, the failure becomes fatal. From the report on, main treats the service as not ready: it clears its status (`getStatus()` answers `null`), rejects source selection, closes the upstream channel and publishes a `restarting` state, without waiting for the exit. When restarts are exhausted, the application stays in the tray with a visible failed state until the user exits. Broader recovery belongs to ET-015 and ET-019.

## Health and the dashboard

Main owns `AppState` (`packages/contracts/src/app-state.ts`). Its `health` has only fixed values: `service` (`starting`, `ready`, `restarting`, `failed`, `stopping`), `storage` for the isolated self-test (`pending`, `verified`, `failed`), `recording` and `lastError` (`SERVICE_EXITED`, `SERVICE_RESTART_EXHAUSTED`, `STORAGE_FAILED`, `SERVICE_START_TIMEOUT`). A pure reducer (`apps/desktop/src/app-health.ts`) reports `ready` only after a new readiness, and an exit request is final.

Since ET-015c PR-3, `recording` is the [recording status](telemetry-service-v1.md#recording-status-et-015c) of the current service instead of the fixed `unavailable` (C9 is superseded for ET-015c only): `{state: 'disabled'}`, `{state: 'unknown'}`, or a state with its target, a fixed code, the committed loss counts and the current trip. The service posts it on its parent port, from its start until its orderly stop begins; production builds no recorder and reports `disabled`. Main's rules (G4, G5, G12):

- it starts as `unknown` and becomes `unknown` again whenever the service fails (a failure report or start timeout), exits, restarts, exhausts its restarts, or misses its liveness heartbeat deadline (ET-036); readiness never changes it, so a status the new service reported before its readiness stays;
- it accepts a report only from the current service, until that service fails, exits or restarts, and not while the application stops;
- a report that is not exactly `{type: 'recording', status}` with a valid status sets `unknown` and logs `RECORDING_STATUS_REJECTED {count}` at counts 1, 2, 4, 8, …; it is not fatal;
- the loss counts are totals since ETS2Telemetry started: main adds the last counts of every earlier service process to the current one's;
- the status reaches the dashboard through the existing `app:state` push and `app:get-state`, so a reloaded, recovered or reopened dashboard gets the current status when it subscribes, and the tray through its presenter. Closing or recovering the upstream live channel does not change it. No IPC channel, bridge method or preload code is added.

Since ET-015c PR-4 the dashboard and tray present the status; see [below](#recording-on-the-dashboard-and-in-the-tray-et-015c-pr-4). Since ET-011b, `AppState` also carries `settings`: the units per game, the [load state](settings.md#load-states), whether a change can be saved and the last save's refusal (`saveError`: `SETTINGS_WRITE_FAILED` or `SETTINGS_READ_ONLY`, cleared by the next successful save). Settings errors stay in that view and never replace or clear the service's `lastError`.

The preload bridge appends three methods after the original three: `getAppState()`, `subscribeAppState(listener)` (one listener per document; main pushes the full state on every change after the document subscribes) and `exitApplication()`. Every handler checks the sender and its main frame; the overlay has no access. The dashboard shows a status card with the service, storage self-test and recording state, a shadcn `Alert` while the service is failed or restarting, a permanent close-to-tray explanation and the Exit button. `getStatus()` answers `null` while the service is not ready instead of failing, so a dashboard opened during a restart or after restart exhaustion shows `Waiting for the telemetry service` and queries again whenever the pushed health enters `ready` (`apps/desktop/src/dashboard-startup.ts`). User-visible text lives in `apps/desktop/src/strings.ts`; there is no localization framework yet. ET-011b appends a seventh method, `setUnitProfile(game, profile)`, and a **Display units** card; see [settings](settings.md#dashboard-and-overlay). ET-012a appends `setOverlayLayout(layout)` and `setOverlaySections(sections)`, with the same trust checks, and an **Overlay** card; ET-012b appends the four overlay edit methods (see [settings](settings.md#overlay-placements-and-edit-mode-et-012b)); the overlay bridge is unchanged. ET-016 PR-3 appends five journal read methods after them: `listJournalTrips(query?)`, `getJournalTrip(tripUuid)`, `listJournalEvents(tripUuid, cursor?)`, `listJournalIntervals(tripUuid, cursor?)` and `listJournalSamples(tripUuid, cursor?)`. Each validates its arguments in the preload and again in main, which fixes the page size and routes the read to the current ready telemetry service; each resolves `{ok: true, value}` or `{ok: false, code}` with a fixed code, and an untrusted or invalid call rejects. Pending reads answer `SERVICE_UNAVAILABLE` when the service fails, exits or restarts, or the application exits. See [journal IPC](journal.md#ipc-methods-and-codes-j10-j11). Since ET-016 PR-4 the main window has two tabs, **Live** (the cards above, the default) and **Journal**, and only the Journal tab calls these methods; see [the Journal tab](journal.md#the-journal-tab-j12j14). ET-016 PR-5 appends the sixth journal method, `exportJournalTrip(tripUuid)` on `journal:export-trip`, with the same trust and argument checks: main reads the trip through the same routing, owns the Save dialog and the file writer, runs one export at a time, and answers `{outcome: 'saved'}` with row counts, `{outcome: 'cancelled'}` or a fixed code, never a path. An exit stops a running export as `EXPORT_INTERRUPTED` and waits within the idle budget above for its partial file's removal; see [the trip export format](journal-export.md).

Since ET-017 PR-4, `AppState` also carries `plugins`, the per-game [plugin setup](plugin-setup.md#ipc) state (`PluginSetupView`): the setup mode, the bundled plugin's version and hash prefix, whether a setup run is in progress and, per game, the exclusion, the discovery outcome, the manual folder state, at most four game folders named by source and ordinal, never by path, and the number of unlisted Steam folders. Main pushes it through the existing `app:state` push whenever it changes and returns it from `app:get-state`. The bridge appends five methods after `exportJournalTrip`: `retryPluginSetup()`, `choosePluginFolder(game)`, `setPluginGameExcluded(game, excluded)`, `showPluginFile()` and `openPluginFolder(targetId)`, on the channels `plugin:retry`, `plugin:choose-folder`, `plugin:set-excluded`, `plugin:show-file` and `plugin:open-folder`. Each accepts only the trusted dashboard main frame (the overlay is rejected), exact argument counts validated in the preload and again in main, and is refused once the exit has begun; main owns the folder dialog, parented to the dashboard, and the Explorer calls, and no answer carries a path. Plugin setup starts 2 s after Electron is ready on its own unreferenced timer and never delays the tray, the service or the windows. Since ET-017 PR-5 the Live tab shows it in the [Game plugin card](plugin-setup.md#the-game-plugin-card), right after the Application status card; the card calls these methods and shows their fixed answers as text. ET-017 PR-6 appends P16's sixth channel as `exportDiagnostics()` on `diagnostics:export`: no argument is forwarded or accepted, only the trusted dashboard main frame is served, and main owns the Save dialog, parented to the dashboard, builds the redacted [diagnostic bundle](plugin-setup.md#diagnostic-bundle) and writes it like a trip export. It answers `{outcome: 'saved'}`, `{outcome: 'cancelled'}` or a fixed refusal or failure code, never a path, and `EXPORT_INTERRUPTED` once the exit has begun. The card also shows the [connection diagnosis](plugin-setup.md#connection-diagnosis), computed in the renderer from `AppState` and the live update.

### Telemetry service liveness heartbeat and hung process detection (ET-036)

The telemetry service posts an unreferenced 1,000 ms periodic heartbeat (`{type: 'heartbeat'}`) to main on its parent port (`HEARTBEAT_INTERVAL_MS = 1000`). Main supervises process liveness using `ServiceHeartbeatMonitor` (`apps/desktop/src/service-heartbeat.ts`) with an initial 15,000 ms startup deadline (`STARTUP_TIMEOUT_MS = 15000`) transitioning to a 5,000 ms steady-state deadline (`HEARTBEAT_TIMEOUT_MS = 5000`) upon the first received message:

- **Liveness signal and startup slack:** Before the first message from the child is received, the monitor allows 15,000 ms to absorb cold start and module load latency. Upon receipt of the first message, it transitions to the 5,000 ms steady-state deadline. Any message received from the active child on the parent port (`heartbeat`, `recording`, `ready`, `journal`, etc.) proves event-loop liveness and resets the timer. `{type: 'heartbeat'}` is recognized as a benign liveness message and never triggers `SERVICE_INVALID_MESSAGE`.
- **Timeout reaction:** If no message arrives for the active deadline (15 s during startup, 5 s steady-state), main logs `SERVICE_HEARTBEAT_TIMEOUT` (and in the opt-in timeline), marks recording health as `{state: 'unknown'}` via `updateHealth({type: 'recording', status: {state: 'unknown'}})` (updating the dashboard via `app:state` and tray to `Recording: not known`), and invalidates live freshness to `stale` (`reason: 'Telemetry service heartbeat missed; current interval is unknown'`).
- **Supervision rationale (no auto-restart):** Main deliberately does NOT terminate or restart a hung service automatically. Terminating the process abruptly via `child.kill()` (`TerminateProcess`) severs in-flight SQLite storage transactions and risks database lock or corruption. Furthermore, transient system-wide CPU starvation would burn the 2-restarts-in-60-seconds budget and permanently fail the application (`SERVICE_RESTART_EXHAUSTED`). Marking the status `unknown` and live state `stale` alerts the user honestly while preserving in-flight data and allowing inspection or DevTools debugging.
- **Resumption:** If a timed-out service recovers and emits a message, main logs `SERVICE_HEARTBEAT_RESUMED` (and in timeline). The last valid recording status prior to timeout is automatically restored (unless previously rejected or cleared by service exit/restart).
- **Stop and exit cleanup:** The heartbeat timer in the service is cleared in orderly `stop()` and in probe-failure exit (`exitAfterHistory`), ensuring no timer prevents utilityProcess exit. Main stops the monitor on service exit, failure, or application shutdown.
- **Diagnostic freeze seam:** Under `ETS2TELEMETRY_LIVE_SMOKE === '1'`, the command `{type: 'diagnostic-freeze', ms?: number}` causes the service to synchronously block its event loop via `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms ?? 10000)` to simulate a frozen or held process without CPU spin.

### Recording on the dashboard and in the tray (ET-015c PR-4)

A pure builder, `apps/desktop/src/recording-status-text.ts`, turns `AppState.health.recording` into fixed English text from `apps/desktop/src/strings.ts` (G8). It never derives the status itself, and every state and code has its own text, so a new one fails to compile until it has a text. The **Application status** card's Recording row shows the headline (`health-recording`), with these fixed meanings:

| State | Headline |
| --- | --- |
| `disabled` | Off: this version does not record game history |
| `unknown` | Not known: the telemetry service is not running or has not reported a valid status |
| `opening` | Opening the database |
| `waiting` | Waiting for the recorded source to connect |
| `recording` | Recording |
| `paused` | Game paused; recording continues when it resumes |
| `interrupted` | Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap |
| `retrying` | Retrying: *cause*. Nothing is acknowledged until storage commits; events while reconnecting are recorded as a gap |
| `stopped` | Stopped: *cause*. Restart ETS2Telemetry after fixing it |
| `live-only` | Not recording this game session: the database is behind the plugin (restored database); recording resumes with the next game session |
| `not-recorded-source` | Not recording the selected source |

The cause is a fixed phrase per recording code, for example `the disk is full` for `DISK_FULL` or `no permission to write the database` for `PERMISSION_DENIED`; a missing code reads as `an internal error occurred`. No path or error text is shown. Below the headline the row shows:

- the detail (`health-recording-detail`): `Synthetic test database (never game history)` or `Replay test database (never game history)` for a test target, then the current trip: `Current trip is partial`, `Current trip is recorded completely so far` or `The current trip's completeness is not known yet`, with `waiting for its delivery outcome` or `checking a loaded save` for those phases, or `The current job is not tracked as a trip: it started before recording, or a recording gap ended its trip` (since ET-016 PR-7 a job that started before recording opens a partial trip once the replayed events have drained);
- the losses (`health-recording-losses`), only when a total is non-zero: the title `Gaps recorded since Yukon Union Telemetry started` and one line per non-zero counter (lost events, event loss intervals, intervals without a connection, one-second sample loss intervals, restored-database intervals, dropped one-second samples). With a restored-database loss a note says the totals may be an upper bound, since a telemetry service restart in the same game session counts it again ([TD-004](technical-debt.md#td-004-restore-loss-counted-once-in-the-live-loss-totals)); the database itself is correct. Totals start again with each application start. `unknown` carries no totals, although main keeps them, so the loss lines are hidden while the status is `unknown` and reappear, with the earlier service processes' counts included, when a service reports again; after the supervisor's restarts are exhausted they stay hidden until the application restarts ([TD-005](technical-debt.md#td-005-loss-totals-hidden-while-the-recording-status-is-unknown)).

For `retrying`, `stopped` and `live-only` a shadcn `Alert` titled **Recording problem** follows the list (`health-recording-alert`; destructive except for `retrying`) and says that live telemetry and the overlay keep working. The status card's prototype notice (`prototype-notice`) follows the state: `No trip recording or durable history` while disabled, a not-known notice while unknown, `Only a test database is recorded, never game history` for a test target, and a notice that game history recording is new for the history target. Before main's first push the row shows a dash.

The sidebar's recording indicator (`shell.sidebar.recording`) shows a coloured dot and a one- or two-word label, for example `Recording`, `Paused`, `Connection lost` or `Error, retrying`, with a `Test` badge for a test target and an info icon. The dot's colour follows the state (green recording; orange paused, waiting or opening; red interrupted, retrying or stopped; grey otherwise), and its animation shows activity: a ring spreads while the recorder is active, faster while the connection or storage fails, a paused dot breathes, and a stopped, disabled, unknown or not-recorded state stays still. Hovering or focusing it opens a tooltip with the same headline, detail, alert and loss lines as the Recording row. The dot pulses only while the dashboard window has focus, so a focused game never pays for its repaints; reduced motion stops the animation. Runtime smokes other than the UI shards stop the dot's animation ([CI](ci.md#recording-dot-animation-in-runtime-smokes)).

The tray's second status line is `Recording: ` and the short form of the headline, for example `off in this version`, `not known`, `on`, `connection lost` or `retrying, the disk is full`, followed by ` · synthetic test database` or ` · replay test database` for a test target; it is cut at 127 characters like the tooltip, and the tooltip does not carry it. The overlay and both preloads are unchanged.


## Diagnostics log

### Source selection (ET-011 closeout)

Main logs `SOURCE_SELECTED` only after a validated source command was successfully dispatched to the
current telemetry service. Its only facts are the validated `source` enum and `origin`: `startup`
for the first successful initial dispatch, `user` for a successful dashboard request, or `restore`
when a replacement service receives the retained committed selection. A repeated successful request
for the same source still gets a selected row. Replacing a successfully dispatched source with a
different one first logs `SOURCE_SELECTION_RETIRED` for the previous source, with the same origin.
No initial source is retired before its first successful dispatch.

Rejected input, an untrusted or replaced dashboard, rate limiting, an obsolete pending request,
service retirement, shutdown or a throwing dispatch produces no successful selection or retirement
row. A pending request does not replace the retained committed source. These rows describe dispatch,
not a service acknowledgement, a connection, a CAP0 grant or recording. Their facts contain no paths,
arguments, broker/peer data, process identity or telemetry; the existing log bounds still apply.

Main and the telemetry service each write `startup.jsonl` with `createDiagnostics` ([diagnostics.ts](../apps/desktop/src/diagnostics.ts)): main in `%LOCALAPPDATA%\ETS2Telemetry\logs` and the service in its `service` subdirectory, or both under `ETS2TELEMETRY_DIAGNOSTIC_DIR` in isolated runs. A record is one JSON line with the time, the PID, a fixed event code and optional fixed facts; the error detail is included only in diagnostic-directory mode. Each log holds at most 256 KiB and 2,000 records per process; when a process starts with a file within 8 KiB of the limit, the file is renamed to `startup.jsonl.1`, replacing the previous one.

**Asynchronous writes (October 18, 2026).** Logging never waits for the disk. A synchronous append once blocked a process's main thread for 1,184 ms on the development host, which can delay the service's shutdown verdicts past their budgets (found during the history close grace investigation, PR #114). The writer works as follows:

- **Queue.** `log()` formats the record, counts it against both bounds and queues it.
- **Writes.** One `fs.promises.appendFile` at a time writes everything queued, in logging order. The write runs on libuv's thread pool, and only one pool thread can be busy with this log at a time. Each batch opens the file for appending, writes and closes it, as the earlier synchronous append did. Lines therefore stay whole, and another process may append to the same file.
- **Memory.** Queued records count against the 256 KiB and 2,000-record bounds, so a stalled disk can hold at most 256 KiB in memory and nothing new has to be dropped. Records beyond the bounds are refused when they are logged, as before.
- **Write failures.** A failed write marks the log unavailable. That batch, the rest of the queue and every later record then go to the console as `[ETS2Telemetry] <EVENT>`, in order, as after a failed synchronous append. Creation and rotation at startup stay synchronous, once per process.
- **Why not a worker thread.** A worker that owns the file would add a second V8 isolate to each process and a message channel. Its final drain would still need a bounded wait, so it gives no stronger exit guarantee than the thread-pool write.

**Final write (October 18, 2026).** A process does not exit on a timer that races its asynchronous appends. Dispatch run 39094511631 showed why: on a 4-processor runner under the 25% Job CPU cap, the development scaffold smoke lost the service's last `SHUTDOWN_STEP` and its `SERVICE_REPORT {type: 'stopped'}`. The service had waited a fixed 150 ms for appends that had not finished and then exited cleanly. Two calls now write the last rows:

- `log.settle(timeoutMs)` gives the append in flight, if any, up to `timeoutMs` to finish. It then writes everything still queued with one synchronous append, at most the 256 KiB the bounds counted, so the queued rows are on disk when it resolves. Later records are written asynchronously again.
- `log.finalize(timeoutMs)` does the same, but no asynchronous append starts once it is called, and every record logged after it resolved is written synchronously at once. Main's late rows, such as the timeline's `DASHBOARD_WINDOW_CLOSED` during `app.exit`, therefore land too.

No row is written twice. Only a batch that is still in flight when the wait ends can land after the synchronously written rows, or be lost if the process exits first.

| Point | Call | Wait for the append in flight | Rows covered | Why it fits |
| --- | --- | --- | --- | --- |
| Service exit after `stop` | `finalize` | The time left before main's 3,000 ms kill deadline, measured from when the service received `stop`, less a 300 ms reserve (`SERVICE_EXIT_RESERVE_MS`, `stopTimeLeftMs`); 0 once that time has passed | The final `SHUTDOWN_STEP` and `SERVICE_REPORT` rows, before `process.exit` | See the stop margin below |
| Service exit after a failed probe | `finalize` | `SERVICE_EXIT_FLUSH_MS`, 150 ms | The rows before `process.exit` after the history close | No `stop` deadline runs on this path |
| Service failure report | `settle` | `SERVICE_REPORT_SETTLE_MS`, 500 ms | The `SERVICE_REPORT` row and earlier rows, before a `{type: 'failed'}` report (a probe failure, or `INVALID_SOURCE_COMMAND` for a rejected selection) is posted | After readiness main logs the report and kills the service at once. The report reaches main at most 500 ms later, and only while an append is in flight; other messages posted meanwhile are not held |
| Main exit | `finalize` | `MAIN_EXIT_FLUSH_MS`, 300 ms | `SERVICE_EXIT`, `APP_EXIT` and later rows, before `app.exit(code)` | The exiting instance still holds the single-instance lock, so a launch in this window only signals it and ends without opening a window; the wait is short for that |
| Diagnostic bundle | `flush` | `BUNDLE_FLUSH_MS`, 250 ms | Main's own rows, before `readDiagnosticLogs` reads the logs | The service's rows are read as they are on disk |

**Stop margin.** Main's 3,000 ms kill deadline starts when it posts `stop`, slightly before the service receives it. The service's stop sequence allocates nominally 2,500 ms, with event-loop turns for `timeout` verdicts and the existing history-close floors; arbitrary late scheduling can exceed that nominal point ([service shutdown](#service-shutdown)). The final write's wait ends at most 2,700 ms after `stop` arrived, which leaves the 300 ms reserve for the `stop` message delivery, the synchronous append of the queue and the process exit. An ordinary stop takes tens of milliseconds, so the append in flight may take up to about 2.7 s. A stop that used its whole 2,500 ms budget leaves it about 200 ms. A stop that overran the 2,700 ms point waits 0 ms: the queue is written at once and the service exits. A batch still in flight then may land after the queued rows or be lost, as above, which loses less than a kill before the synchronous write.

**Crash path.** The service handles `uncaughtException` and `unhandledRejection` itself, and the error detail is logged only in diagnostic-directory mode:
- **Uncaught exception.** It logs one fixed `SERVICE_UNCAUGHT` row, writes the whole queue with one synchronous append (`drainSync`, at most the 256 KiB the bounds counted) and exits 1, as an uncaught exception did before.
- **Unhandled rejection.** It logs one fixed `SERVICE_UNHANDLED_REJECTION` row, drains the queue the same way and keeps running. Without a handler, an Electron 44.7.0 utilityProcess only printed `UnhandledPromiseRejectionWarning` and kept running: on October 18, 2026, a scratch utilityProcess that rejected a promise still answered 1 s later. The handler keeps that behaviour.
- **In-flight batch.** A batch that the asynchronous writer already has in flight may land after the drained rows, or be lost when the process exits first, because `process.exit` does not wait for thread-pool work. Nothing is written twice. On these paths the file can therefore be out of order or miss that batch. That is accepted, because the drained rows would otherwise be lost.

Main keeps its existing handlers, which run the orderly exit.

With an idle disk the final write takes a few milliseconds. Not covered:
- An append still in flight when its wait ends can land after the synchronously written rows or be lost. A disk that is stalled even for the synchronous append delays the exit until main's kill deadline.
- A killed process, or a crash in main, loses the records queued behind the write in flight; before, every completed `log()` call was already on disk.

The runtime smokes read the logs after the application exited, except three reads while it runs: the recording journey's first-connection and service-restart status rows, and the delayed-commit retirement row of the telemetry smoke. They now poll for the row instead of reading once. Every other read during a run asserts that a row is absent or counts rows logged long before the read, so a row still being written cannot make it fail.

## Isolated smoke diagnostics

Only when `ETS2TELEMETRY_LIVE_SMOKE=1` and absolute diagnostic and profile directories are configured, exactly like the existing service-exit diagnostic, main also listens for three app events that tests emit from Playwright's main-process evaluation:

- `ets2telemetry:diagnostic-tray-action` with `open` or `exit` calls the same handlers as the tray menu;
- `ets2telemetry:diagnostic-lifecycle-state` returns read-only facts (started, exiting, service PID, tray, dashboard, overlay, upstream, health and, since ET-011b, the settings view);
- `ets2telemetry:diagnostic-uninstall-dialogs` with `uninstall` or `cancel` (ET-018 PR-4) makes main answer the in-app uninstall's confirmation with that choice and its result dialog with OK, without showing either. It logs `DIAGNOSTIC_UNINSTALL_DIALOGS`, then `DIAGNOSTIC_UNINSTALL_DIALOG` for each dialog it answered. The installer lifecycle's [in-app scenarios](installer-testing.md#in-app-uninstall-scenarios) use it.

With an explicit diagnostic directory (`ETS2TELEMETRY_DIAGNOSTIC_DIR`), the opt-in timeline also logs `RECORDING_STATUS` whenever `health.recording` changes (ET-015c PR-4), with flat fixed facts: `state`, and for a reported state `target`, `code`, the six loss totals, `tripPhase`, `tripCompleteness` and `untrackedJob`. The recording journey reads these rows to prove states shorter than any poll; default logs never contain them.

Neither is reachable from a renderer. See [CI](ci.md#et-011a-tray-lifecycle-smoke) for the smoke that uses them and [ET-011 validation](validation/et-011.md) for evidence and pending manual checks.

## Recording flush allocation (ET-012 correction)

The owner-approved October 21, 2026 correction supersedes the fixed effective recording deadline in R14/H11. The registered recording budget remains 500 ms. At flush entry, B=2500, I=max registered intake budgets, S=max registered storage budgets, f=recording nominal budget and e=elapsed monotonic milliseconds from sequence start. Only `recording-flush` in the flush phase receives `f + max(0, min(I-e, B-e-S-f))`; invalid/nonfinite/negative elapsed grants nothing, and an empty intake has no spare allocation. With production maxima 1000/500/1000, intake of 0/300/1000 ms permits flush of 1500/1200/500 ms. Other names and phases keep their nominal budgets. Parallel steps share maxima.

Storage still recomputes actual remaining stop time after flush. For example a prompt intake and 829 ms flush leave 1671 ms effective history budget and 1471 ms grace. No borrowed time is spent twice. ET-038 retains its 1000 ms history budget floor, 800 ms grace floor and 200 ms termination reserve. The existing verdict turn can accept I/O delivered before the verdict; failures/timeouts stay sticky. Floors and delayed scheduling can exceed the nominal wall-clock point: this is not an absolute physical-time guarantee. Main's supervision limits are unchanged.

The source closes before flushing, no ACK follows source stop, and storage closes after the final write. Deterministic unit and real temporary-worker/pipe evidence is in [ET-012e](validation/et-012e.md); it proves tolerance of an injected delay, not the cause of the prior flaky runtime result.

## Autostart reconciliation and provisional settings

Startup login reconciliation uses the initial-load authority described in [settings](settings.md#startup-autostart-authority), independently of overlay visibility or unit fallbacks. Unknown settings query registration only. The load-only late callback may supersede held discovery and reconcile once; ordinary settings saves do not. Valid trusted explicit requests retire startup first, and exit is rechecked after discovery and durable persistence. Tests mock every login-item port; portable runtime journeys remain not-installed and cannot activate Windows login registration.

A valid installed explicit autostart request synchronously queries and publishes actual login registration before awaiting persistence. If that save fails, the committed preference and registration remain unchanged, and the observed status is still truthful even though startup reconciliation has been retired. No asynchronous failure handler restores a captured status over a newer result. Registration mutation still occurs only after successful persistence and an exit check. Concurrent discovery caches a local candidate only while no verified target exists, so a late negative discovery cannot erase an already verified installed target.
