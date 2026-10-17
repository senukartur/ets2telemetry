# Application lifecycle (ET-011a)

ET-011a makes ETS2Telemetry a notification-area (tray) application. Closing the main window no longer stops anything; only an explicit exit does. This page describes the desktop process lifecycle. The decisions behind it are C1–C17 in [concept.md](../concept.md#et-011-authorization--october-15-2026). Persistent settings and unit profiles are ET-011b; see [settings](settings.md).

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

Closing the dashboard window destroys that window and retires only its document state: its live subscription, its application-state subscription and its renderer epoch. The telemetry service, the upstream live channel, main's freshness clocks, the overlay and the tray stay as they are. The overlay keeps following the game while the main window is closed. A source request still in flight from the closed document is rejected when it completes. An active overlay edit mode (ET-012b) is cancelled without saving when the dashboard closes, is minimized or its document is retired, and when the exit begins; see [the minimal overlay](minimal-overlay.md#edit-mode-et-012b).

Reopening (tray icon click, the tray's **Open ETS2Telemetry**, or a second launch) creates a new window that subscribes again through the existing bridge; main reuses the single upstream channel. A service restart while the window is closed recreates no window and no second overlay: windows are created once, on first readiness.

The overlay window refuses close requests until the application exits. If creating the tray icon throws, main logs `TRAY_UNAVAILABLE` and closing the dashboard minimizes it instead. This fallback covers only a constructor that throws: on Windows, Electron does not throw or report it when the shell rejects the icon registration (`Shell_NotifyIcon`), so the application cannot detect a missing icon and the dashboard still closes to the tray. Launching ETS2Telemetry again is the guaranteed way back in every case, because the second launch reopens the dashboard. Whether the real icon appears is a manual check.

`window-all-closed` does nothing: the tray keeps the application running.

## Tray icon

The icon is created when Electron is ready, before the service starts, with the tooltip `Starting`. It has no fixed GUID. The bitmap is generated at runtime (`apps/desktop/src/tray-icon.ts`): a filled disc in 16, 20, 24 and 32 px representations for 100%, 125%, 150% and 200% display scaling. Its colour shows health: green when ready, amber while starting, restarting or exiting, red when the service has failed.

The context menu contains:

1. a disabled status line, for example `Service: ready · Storage self-test: verified`;
2. the disabled line `Recording: <short headline>` with the [recording status](#recording-on-the-dashboard-and-in-the-tray-et-015c-pr-4), for example `Recording: off in this version` in production or `Recording: on · synthetic test database` for a synthetic recording target (ET-015c PR-4);
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

The first request logs `APP_EXIT_REQUESTED` with its reason, sets the tray tooltip to `Exiting`, disables the menu, retires live subscriptions, hides the overlay and asks the supervisor to stop the service. Later requests do nothing. `query-session-end` is not prevented. After the supervisor finishes, the coordinator waits for pending idle work (an in-flight [settings](settings.md#saving) save and, since ET-016 PR-5, the removal of an interrupted [trip export](journal-export.md#saving-a-trip-j16-j17)'s partial file, together at most 1000 ms from the request; new saves and exports are refused once the exit started), removes the tray icon so no ghost icon remains, and calls `app.exit(code)`. The supervisor's existing bounds are unchanged: the service is killed after 3000 ms without a clean stop and the application exits after 5000 ms in any case. Main-internal fatal paths still exit 1 through the same final step. A fatal stop (for example renderer or overlay restart exhaustion, a load or configuration failure, or a service recovery timeout) marks the application exiting as soon as it starts, without logging an exit request: the tray shows `Exiting` with a disabled menu, live state is retired, the overlay may close and neither the tray nor a second launch reopens the dashboard during the stop window.

## Service shutdown

The service stops through an ordered sequence (`apps/desktop/src/shutdown-sequence.ts`):

| Phase | Steps (budget) |
| --- | --- |
| `intake` | `ingestion` (1000 ms), `capture` (1000 ms), `v1-ingestion` (1000 ms; ends the protocol v1 source and waits for its broker, ET-006b; it never waits for storage, which is the `recording-flush` step's job) |
| `flush` | `recording-flush` (500 ms, ET-015a PR-3): drops queued durable v1 work and waits for the one storage command in flight, so the database closes after it and no ACK is written after the source stopped. Since ET-015b PR-3 it then writes the pending one-second samples, at most 300 rows per plugin session in one `appendSamples` each, unless durable delivery has failed, and logs `V1_SAMPLES_EXIT {rows, losses, code}` once when rows or loss intervals were pending ([one-second samples](telemetry-service-v1.md#one-second-samples-et-015b)); rows still unwritten when the 500 ms step expires are lost, and the storage close still finishes the command in flight. With no recording target it has nothing to wait for |
| `storage` | `storage-probe` (1000 ms), `history-storage` (1000 ms, closes the history database; ET-013 PR-2) |

Steps of one phase run in parallel; each is bounded by its own budget, so a phase takes at most its largest budget. Registration fails if the sum of phase maxima exceeds `SERVICE_STOP_BUDGET_MS` (2500 ms), which keeps the sequence inside main's 3000 ms kill deadline. Since ET-015a PR-3 the maxima are 1000 (`intake`) + 500 (`flush`) + 1000 (`storage`) = 2500 ms, the whole budget; a further step must fit inside an existing phase maximum. Every step, successful ones included, logs `SHUTDOWN_STEP` with fixed `phase`, `name`, `outcome` (`ok`, `failed` or `timeout`) and `ms` facts; a failed or late step does not stop the sequence. The service then sends exactly one `{type: 'stopped', clean}` message and exits 0 when clean or 1 otherwise.

## Service failures after readiness

Before the first readiness, a service failure report or start timeout still stops the application with exit code 1. After it, a failure report (for example a failed storage self-test), a restarted service's missed 15 s start deadline or an unexpected exit uses the existing supervised restart: 250 ms, then 1000 ms, at most two restarts per 60 s. A reported failure first terminates the current service; if it has not exited within 3000 ms, the failure becomes fatal. From the report on, main treats the service as not ready: it clears its status (`getStatus()` answers `null`), rejects source selection, closes the upstream channel and publishes a `restarting` state, without waiting for the exit. When restarts are exhausted, the application stays in the tray with a visible failed state until the user exits. Broader recovery belongs to ET-015 and ET-019.

## Health and the dashboard

Main owns `AppState` (`packages/contracts/src/app-state.ts`). Its `health` has only fixed values: `service` (`starting`, `ready`, `restarting`, `failed`, `stopping`), `storage` for the isolated self-test (`pending`, `verified`, `failed`), `recording` and `lastError` (`SERVICE_EXITED`, `SERVICE_RESTART_EXHAUSTED`, `STORAGE_FAILED`, `SERVICE_START_TIMEOUT`). A pure reducer (`apps/desktop/src/app-health.ts`) reports `ready` only after a new readiness, and an exit request is final.

Since ET-015c PR-3, `recording` is the [recording status](telemetry-service-v1.md#recording-status-et-015c) of the current service instead of the fixed `unavailable` (C9 is superseded for ET-015c only): `{state: 'disabled'}`, `{state: 'unknown'}`, or a state with its target, a fixed code, the committed loss counts and the current trip. The service posts it on its parent port, from its start until its orderly stop begins; production builds no recorder and reports `disabled`. Main's rules (G4, G5, G12):

- it starts as `unknown` and becomes `unknown` again whenever the service fails (a failure report or start timeout), exits, restarts or exhausts its restarts; readiness never changes it, so a status the new service reported before its readiness stays;
- it accepts a report only from the current service, until that service fails, exits or restarts, and not while the application stops;
- a report that is not exactly `{type: 'recording', status}` with a valid status sets `unknown` and logs `RECORDING_STATUS_REJECTED {count}` at counts 1, 2, 4, 8, …; it is not fatal;
- the loss counts are totals since ETS2Telemetry started: main adds the last counts of every earlier service process to the current one's;
- the status reaches the dashboard through the existing `app:state` push and `app:get-state`, so a reloaded, recovered or reopened dashboard gets the current status when it subscribes, and the tray through its presenter. Closing or recovering the upstream live channel does not change it. No IPC channel, bridge method or preload code is added.

Since ET-015c PR-4 the dashboard and tray present the status; see [below](#recording-on-the-dashboard-and-in-the-tray-et-015c-pr-4). Since ET-011b, `AppState` also carries `settings`: the units per game, the [load state](settings.md#load-states), whether a change can be saved and the last save's refusal (`saveError`: `SETTINGS_WRITE_FAILED` or `SETTINGS_READ_ONLY`, cleared by the next successful save). Settings errors stay in that view and never replace or clear the service's `lastError`.

The preload bridge appends three methods after the original three: `getAppState()`, `subscribeAppState(listener)` (one listener per document; main pushes the full state on every change after the document subscribes) and `exitApplication()`. Every handler checks the sender and its main frame; the overlay has no access. The dashboard shows a status card with the service, storage self-test and recording state, a shadcn `Alert` while the service is failed or restarting, a permanent close-to-tray explanation and the Exit button. `getStatus()` answers `null` while the service is not ready instead of failing, so a dashboard opened during a restart or after restart exhaustion shows `Waiting for the telemetry service` and queries again whenever the pushed health enters `ready` (`apps/desktop/src/dashboard-startup.ts`). User-visible text lives in `apps/desktop/src/strings.ts`; there is no localization framework yet. ET-011b appends a seventh method, `setUnitProfile(game, profile)`, and a **Display units** card; see [settings](settings.md#dashboard-and-overlay). ET-012a appends `setOverlayLayout(layout)` and `setOverlaySections(sections)`, with the same trust checks, and an **Overlay** card; ET-012b appends the four overlay edit methods (see [settings](settings.md#overlay-placements-and-edit-mode-et-012b)); the overlay bridge is unchanged. ET-016 PR-3 appends five journal read methods after them: `listJournalTrips(query?)`, `getJournalTrip(tripUuid)`, `listJournalEvents(tripUuid, cursor?)`, `listJournalIntervals(tripUuid, cursor?)` and `listJournalSamples(tripUuid, cursor?)`. Each validates its arguments in the preload and again in main, which fixes the page size and routes the read to the current ready telemetry service; each resolves `{ok: true, value}` or `{ok: false, code}` with a fixed code, and an untrusted or invalid call rejects. Pending reads answer `SERVICE_UNAVAILABLE` when the service fails, exits or restarts, or the application exits. See [journal IPC](journal.md#ipc-methods-and-codes-j10-j11). Since ET-016 PR-4 the main window has two tabs, **Live** (the cards above, the default) and **Journal**, and only the Journal tab calls these methods; see [the Journal tab](journal.md#the-journal-tab-j12j14). ET-016 PR-5 appends the sixth journal method, `exportJournalTrip(tripUuid)` on `journal:export-trip`, with the same trust and argument checks: main reads the trip through the same routing, owns the Save dialog and the file writer, runs one export at a time, and answers `{outcome: 'saved'}` with row counts, `{outcome: 'cancelled'}` or a fixed code, never a path. An exit stops a running export as `EXPORT_INTERRUPTED` and waits within the idle budget above for its partial file's removal; see [the trip export format](journal-export.md).

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

- the detail (`health-recording-detail`): `Synthetic test database (never game history)` or `Replay test database (never game history)` for a test target, then the current trip: `Current trip is partial`, `Current trip is recorded completely so far` or `The current trip's completeness is not known yet`, with `waiting for its delivery outcome` or `checking a loaded save` for those phases, or `The current job started before recording and is not tracked as a trip`;
- the losses (`health-recording-losses`), only when a total is non-zero: the title `Gaps recorded since ETS2Telemetry started` and one line per non-zero counter (lost events, event loss intervals, intervals without a connection, one-second sample loss intervals, restored-database intervals, dropped one-second samples). With a restored-database loss a note says the totals may be an upper bound, since a telemetry service restart in the same game session counts it again ([TD-004](technical-debt.md#td-004-restore-loss-counted-once-in-the-live-loss-totals)); the database itself is correct. Totals start again with each application start. `unknown` carries no totals, although main keeps them, so the loss lines are hidden while the status is `unknown` and reappear, with the earlier service processes' counts included, when a service reports again; after the supervisor's restarts are exhausted they stay hidden until the application restarts ([TD-005](technical-debt.md#td-005-loss-totals-hidden-while-the-recording-status-is-unknown)).

For `retrying`, `stopped` and `live-only` a shadcn `Alert` titled **Recording problem** follows the list (`health-recording-alert`; destructive except for `retrying`) and says that live telemetry and the overlay keep working. The status card's prototype notice (`prototype-notice`) follows the state: `No trip recording or durable history` while disabled, a not-known notice while unknown, `Only a test database is recorded, never game history` for a test target, and a notice that game history recording is new for the history target. Before main's first push the row shows a dash.

The tray's second status line is `Recording: ` and the short form of the headline, for example `off in this version`, `not known`, `on`, `connection lost` or `retrying, the disk is full`, followed by ` · synthetic test database` or ` · replay test database` for a test target; it is cut at 127 characters like the tooltip, and the tooltip does not carry it. The overlay and both preloads are unchanged.

## Isolated smoke diagnostics

Only when `ETS2TELEMETRY_LIVE_SMOKE=1` and absolute diagnostic and profile directories are configured, exactly like the existing service-exit diagnostic, main also listens for two app events that tests emit from Playwright's main-process evaluation:

- `ets2telemetry:diagnostic-tray-action` with `open` or `exit` calls the same handlers as the tray menu;
- `ets2telemetry:diagnostic-lifecycle-state` returns read-only facts (started, exiting, service PID, tray, dashboard, overlay, upstream, health and, since ET-011b, the settings view).

With an explicit diagnostic directory (`ETS2TELEMETRY_DIAGNOSTIC_DIR`), the opt-in timeline also logs `RECORDING_STATUS` whenever `health.recording` changes (ET-015c PR-4), with flat fixed facts: `state`, and for a reported state `target`, `code`, the six loss totals, `tripPhase`, `tripCompleteness` and `untrackedJob`. The recording journey reads these rows to prove states shorter than any poll; default logs never contain them.

Neither is reachable from a renderer. See [CI](ci.md#et-011a-tray-lifecycle-smoke) for the smoke that uses them and [ET-011 validation](validation/et-011.md) for evidence and pending manual checks.
