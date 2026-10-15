# Application lifecycle (ET-011a)

ET-011a makes ETS2Telemetry a notification-area (tray) application. Closing the main window no longer stops anything; only an explicit exit does. This page describes the desktop process lifecycle. The decisions behind it are C1–C17 in [concept.md](../concept.md#et-011-authorization--october-15-2026). Persistent settings and unit profiles are ET-011b and are not part of this package.

For readers new to desktop development: the *main process* is Electron's Node.js process that owns windows, the tray icon and the telemetry service. A *renderer* is the sandboxed Chromium page of a window; it reaches main only through the narrow preload bridge. The *notification area* is the icon area at the right of the Windows taskbar, including its overflow flyout.

## Single instance

Only one ETS2Telemetry process tree runs per profile. On startup, main first handles Squirrel installer arguments, then applies the `ETS2TELEMETRY_PROFILE_DIR` override (an absolute diagnostic profile used by isolated tests), and only then asks Electron for the [single-instance lock](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata). Electron keys the lock by the `userData` directory, so the override must come first.

- **Second launch.** When the lock is held, the new process calls `app.quit()` before it creates a log, registers any listener, starts the service or opens a window or tray icon, and exits with code 0. It writes no diagnostic log and starts no service, window or tray; only the diagnostic profile directory may be created when the override is set. If that override fails, the process requests no lock at all and exits 1 with `PROFILE_SETUP_FAILED`, so a misconfigured diagnostic launch never signals the running instance.
- **Running instance.** It receives Electron's `second-instance` event and ignores the second process's command line, working directory and additional data. It logs `SECOND_INSTANCE` with a fixed `action`:

| State of the running instance | Action |
| --- | --- |
| Exiting | `ignored-exiting`: nothing reopens |
| Before first service readiness | `ignored-starting`: the dashboard appears on readiness anyway |
| Dashboard minimized | `restored`: restore, show and focus |
| Dashboard open | `focused`: show and focus |
| Dashboard closed to the tray | `created`: a new dashboard window |

Windows may refuse to move a window to the foreground when another application holds it; the taskbar button then flashes. That is an operating-system rule, not an error.

A development launch (`npm run dev`) and an installed copy share the same `productName`, and therefore the same `userData` and instance lock: the second one only focuses the first. To run both side by side, give the development launch its own absolute `ETS2TELEMETRY_PROFILE_DIR`.

## Close to tray

Closing the dashboard window destroys that window and retires only its document state: its live subscription, its application-state subscription and its renderer epoch. The telemetry service, the upstream live channel, main's freshness clocks, the overlay and the tray stay as they are. The overlay keeps following the game while the main window is closed. A source request still in flight from the closed document is rejected when it completes.

Reopening (tray icon click, the tray's **Open ETS2Telemetry**, or a second launch) creates a new window that subscribes again through the existing bridge; main reuses the single upstream channel. A service restart while the window is closed recreates no window and no second overlay: windows are created once, on first readiness.

The overlay window refuses close requests until the application exits. If creating the tray icon throws, main logs `TRAY_UNAVAILABLE` and closing the dashboard minimizes it instead. This fallback covers only a constructor that throws: on Windows, Electron does not throw or report it when the shell rejects the icon registration (`Shell_NotifyIcon`), so the application cannot detect a missing icon and the dashboard still closes to the tray. Launching ETS2Telemetry again is the guaranteed way back in every case, because the second launch reopens the dashboard. Whether the real icon appears is a manual check.

`window-all-closed` does nothing: the tray keeps the application running.

## Tray icon

The icon is created when Electron is ready, before the service starts, with the tooltip `Starting`. It has no fixed GUID. The bitmap is generated at runtime (`apps/desktop/src/tray-icon.ts`): a filled disc in 16, 20, 24 and 32 px representations for 100%, 125%, 150% and 200% display scaling. Its colour shows health: green when ready, amber while starting, restarting or exiting, red when the service has failed.

The context menu contains:

1. a disabled status line, for example `Service: ready · Storage self-test: verified`;
2. the disabled line `Recording: not available in this version`;
3. **Open ETS2Telemetry**;
4. **Exit ETS2Telemetry**.

A left click opens the dashboard. The tooltip shows the service state and, when ready, the selected source and its status; it stays under the 127-character Windows limit and carries no readings, paths or identities. Tooltip, menu and icon are rebuilt only when they change, at most twice per second. There are no balloon notifications.

## Explicit exit

Every way to leave the application goes through one idempotent exit coordinator (`apps/desktop/src/app-lifecycle.ts`):

| Trigger | Reason logged |
| --- | --- |
| Tray **Exit ETS2Telemetry** | `tray` |
| Dashboard **Exit ETS2Telemetry** button (`exitApplication()`) | `renderer` |
| `app.quit()`, including Playwright's `close()` | `app-quit` (`before-quit` is prevented and redirected) |
| Windows sign-out or shutdown (`session-end` on any window) | `session-end` |

The first request logs `APP_EXIT_REQUESTED` with its reason, sets the tray tooltip to `Exiting`, disables the menu, retires live subscriptions, hides the overlay and asks the supervisor to stop the service. Later requests do nothing. `query-session-end` is not prevented. After the supervisor finishes, the coordinator waits for pending idle work (ET-011b's in-flight settings write, at most 1000 ms from the request), removes the tray icon so no ghost icon remains, and calls `app.exit(code)`. The supervisor's existing bounds are unchanged: the service is killed after 3000 ms without a clean stop and the application exits after 5000 ms in any case. Main-internal fatal paths still exit 1 through the same final step.

## Service shutdown

The service stops through an ordered sequence (`apps/desktop/src/shutdown-sequence.ts`):

| Phase | Steps (budget) |
| --- | --- |
| `intake` | `ingestion` (1000 ms), `capture` (1000 ms) |
| `flush` | none yet; ET-015 adds recording flush |
| `storage` | `storage-probe` (1000 ms); ET-013 adds closing history storage |

Steps of one phase run in parallel; each is bounded by its own budget, so a phase takes at most its largest budget. Registration fails if the sum of phase maxima exceeds `SERVICE_STOP_BUDGET_MS` (2500 ms), which keeps the sequence inside main's 3000 ms kill deadline. Every step, successful ones included, logs `SHUTDOWN_STEP` with fixed `phase`, `name`, `outcome` (`ok`, `failed` or `timeout`) and `ms` facts; a failed or late step does not stop the sequence. The service then sends exactly one `{type: 'stopped', clean}` message and exits 0 when clean or 1 otherwise.

## Service failures after readiness

Before the first readiness, a service failure report or start timeout still stops the application with exit code 1. After it, a failure report (for example a failed storage self-test), a restarted service's missed 15 s start deadline or an unexpected exit uses the existing supervised restart: 250 ms, then 1000 ms, at most two restarts per 60 s. A reported failure first terminates the current service; if it has not exited within 3000 ms, the failure becomes fatal. When restarts are exhausted, the application stays in the tray with a visible failed state until the user exits. Broader recovery belongs to ET-015 and ET-019.

## Health and the dashboard

Main owns `AppState` (`packages/contracts/src/app-state.ts`). Its `health` has only fixed values: `service` (`starting`, `ready`, `restarting`, `failed`, `stopping`), `storage` for the isolated self-test (`pending`, `verified`, `failed`), `recording` (always `unavailable` in this version) and `lastError` (`SERVICE_EXITED`, `SERVICE_RESTART_EXHAUSTED`, `STORAGE_FAILED`, `SERVICE_START_TIMEOUT`, and the ET-011b settings codes). A pure reducer (`apps/desktop/src/app-health.ts`) reports `ready` only after a new readiness, and an exit request is final.

The preload bridge appends three methods after the original three: `getAppState()`, `subscribeAppState(listener)` (one listener per document; main pushes the full state on every change after the document subscribes) and `exitApplication()`. Every handler checks the sender and its main frame; the overlay has no access. The dashboard shows a status card with the service, storage self-test and recording state, a shadcn `Alert` while the service is failed or restarting, a permanent close-to-tray explanation and the Exit button. `getStatus()` answers `null` while the service is not ready instead of failing, so a dashboard opened during a restart or after restart exhaustion shows `Waiting for the telemetry service` and queries again whenever the pushed health enters `ready` (`apps/desktop/src/dashboard-startup.ts`). User-visible text lives in `apps/desktop/src/strings.ts`; there is no localization framework yet.

## Isolated smoke diagnostics

Only when `ETS2TELEMETRY_LIVE_SMOKE=1` and absolute diagnostic and profile directories are configured, exactly like the existing service-exit diagnostic, main also listens for two app events that tests emit from Playwright's main-process evaluation:

- `ets2telemetry:diagnostic-tray-action` with `open` or `exit` calls the same handlers as the tray menu;
- `ets2telemetry:diagnostic-lifecycle-state` returns read-only facts (started, exiting, service PID, tray, dashboard, overlay, upstream, health).

Neither is reachable from a renderer. See [CI](ci.md#et-011a-tray-lifecycle-smoke) for the smoke that uses them and [ET-011 validation](validation/et-011.md) for evidence and pending manual checks.
