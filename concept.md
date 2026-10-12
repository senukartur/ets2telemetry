# ETS2Telemetry: Project Concept and Requirements

Concept recorded on: October 10, 2026.

Status updated October 11, 2026: ET-001 scaffold implemented and its native Windows installer/packaged-worker criteria verified. All six actual lifecycle operations exited normally; acceptance includes a separate corrected uninstall residue evaluation and exact owned cleanup, preserving the original failed wrapper report. The package passed installed SQLite/security/startup/shutdown probes. Independent whole-PR review found no actionable source issues; the final documentation delta is reviewed separately. An earlier native Playwright launch timeout remains unexplained flakiness. No integration has been tested in a running game. ETS2Telemetry is the working project name. See [Windows setup](docs/setup.md) and [the validation record](docs/validation/et-001.md) for exact identities and limits. ET-022 and SP-01 become eligible after the accepted scaffold PR is merged.

Repository setup update on October 10, 2026: local `main` tracks the existing history at `https://github.com/senukartur/ets2telemetry.git`. Git for Windows 2.55.0.windows.5 and GitHub CLI 2.102.0 are installed. GitHub CLI is authenticated as `senukartur` and provides Git's HTTPS credentials. Fetch, a fast-forward-only pull, and the initial documentation push succeeded. The published documentation includes this concept, `AGENTS.md`, and `README.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`. Use Git for commits, branches, and synchronization, and GitHub CLI for GitHub operations. This setup does not establish an application build toolchain or game compatibility.

Development uses lightweight GitHub Flow: short-lived task branches, PRs targeting `main`, relevant validation and owner review, and squash merging. Detailed working rules are in `AGENTS.md`. GitHub is configured for squash merging and automatic deletion of merged branches. Server-side branch protection is unavailable on the current plan for this private repository; a local pre-push hook guards `main`. ET-022 now defines [Windows CI](docs/ci.md) after the scaffold; clean hosted and deliberate failure/restoration evidence is recorded in [ET-022 validation](docs/validation/et-022.md); final current-head checks, independent review and owner merge remain required.

## 1. Project Overview

Build a custom telemetry utility for **Euro Truck Simulator 2 (ETS2)** and **American Truck Simulator (ATS)**. It should display essential metrics over the game, automatically maintain a local trip journal, and record detailed samples for later analysis.

The target audience is members of a virtual trucking company (VTC). Eventually, the utility should synchronize data with a dedicated service whose website presents driver and company statistics, including deliveries, distance driven, cargo, and other metrics.

The first complete release is a standalone Windows application with an overlay, a trip journal, and telemetry recording. It does not require an internet connection or an account.

The project owner has web development experience with React and TypeScript, but no desktop application development experience. Most of the product should remain maintainable using familiar web technologies, with native code isolated in a small component.

## 2. User Requirements

Owner-approved deferred capabilities are tracked in [technical debt](docs/technical-debt.md). TD-001 records future game screenshots containing the overlay, including investigation and actual validation of Steam capture. It does not change the current separate-window overlay or authorize rendering hooks in the MVP.

- The initial platform is **Windows x64**.
- Both ETS2 and ATS must be supported.
- **TruckersMP compatibility is required** for the first release. Single-player is also part of the validation matrix. The built-in Convoy mode is deferred from the matrix by owner decision on October 12, 2026; it is neither validated nor claimed as supported.
- The initial overlay may require windowed mode, including borderless fullscreen. Exclusive fullscreen support is outside the MVP.
- The main interface and overlay use **React and TypeScript**.
- The first release includes live metrics, an overlay, and a local trip history.
- Record both trip summaries and **one telemetry sample per second** for future charts and trip analysis.
- The website, accounts, company-wide statistics, and server synchronization belong to a later phase.
- Visual design will be discussed separately. Correct data acquisition and storage are the current priorities.
- New functionality must preserve existing behavior through regression tests added alongside each feature. Bug fixes should retain a reproducing test where feasible; the detailed policy is in [TESTING.md](TESTING.md).
- **All internal documentation that may be committed to Git must be written in English.** This includes this concept, agent instructions, technical specifications, and development guides. This does not determine the application's UI language.

The technical choices below are the working implementation baseline. Changes to these user requirements should be discussed with the owner. Routine implementation details can be decided within this concept without repeatedly seeking approval.

## 3. Initial User Journey

1. The driver installs the utility. On launch, it discovers installed games without a multi-step setup wizard.
2. The utility installs or updates its telemetry plugin in each discovered game silently, and asks the driver only when it cannot proceed alone (see the October 12, 2026 silent plugin installation decision).
3. The driver starts the utility and launches the game normally or through TruckersMP.
4. The application connects to the plugin and displays connection status and live metrics.
5. The overlay remains visible while driving, while mouse clicks and controls continue to reach the game.
6. The utility automatically tracks the job and records telemetry, events, and the trip outcome.
7. The driver opens the journal to inspect completed or incomplete records and export data when needed.

Support either launch order: application first or game first. Starting recording after a job has already begun must be reflected in the trip's data completeness.

## 4. Working Technology Stack

| Component | Technologies | Responsibility |
| --- | --- | --- |
| Desktop shell | Electron, TypeScript | Windows, tray, application lifecycle, plugin connection |
| Main interface and overlay | React, TypeScript, Vite, Tailwind CSS v4, shadcn/ui | Metrics, journal, settings. The overlay is display-only and keeps its own minimal stylesheet |
| Game plugin | C++17, CMake, MSVC, SCS Telemetry SDK | Data acquisition through the supported game interface |
| Local transport | Windows Named Pipes | Messages between the plugin and application |
| Storage | SQLite, better-sqlite3 | Trips, events, samples, migrations |
| Distribution | Electron Forge | Application installation and updates |
| Automated checks | Vitest, CTest, Playwright, a simulated telemetry source | Domain and native logic, contracts, integration, UI, scenario replay |

Electron keeps most application logic in TypeScript. Measure its memory usage and impact on the game during the early prototype. Tauri was considered but not selected because it would introduce Rust into the current architecture.

Build the plugin from project-owned source using the official SDK. Existing open-source projects can inform implementation choices; a prebuilt third-party DLL is not a required product dependency.

Pin dependency versions when scaffolding the project. The SCS SDK archive examined during planning was **1.15**. The SDK archive version, API version, and game version are different identifiers.

## 5. Architecture and Telemetry Acquisition

```text
ETS2 / ATS, including launch through TruckersMP
    |
    | Official SCS Telemetry SDK callbacks
    v
Project-owned C++ DLL plugin
    |
    | Local Windows named pipe
    v
Electron main process (window lifecycle and service supervision)
    |-- Main React window (sandboxed, narrow preload)
    |-- React overlay window (sandboxed, narrow preload)
    `-- utilityProcess telemetry service
            `-- Dedicated storage worker --> SQLite
                              |
                              | Later phase
                              v
                         Synchronization queue
                              |
                              | HTTPS
                              v
                         Server --> Company website
```

### Game Plugin

- Install the DLL under `bin/win_x64/plugins`, relative to each game's installation directory.
- Obtain channel values and events through SCS SDK. Arbitrary game memory reads and rendering hooks are outside the MVP.
- Keep game callbacks limited to short data copies. Serialize messages and communicate with the application on a separate thread.
- Call SCS APIs only from the SDK-permitted game-thread callback context. The background thread must not call game APIs.
- A slow or disconnected consumer must not stall the game. Bound queues, detect event loss, and reflect any gap in recording quality.
- Release resources correctly during initialization, shutdown, and plugin reload cycles.
- The native component also reports the game window's position, size, foreground state, and minimized state to support overlay behavior.

SCS SDK provides telemetry for the player's own truck and job. Collecting other TruckersMP players' telemetry is outside the requirements. Consider the additional TruckersMP SDK only when a specific multiplayer data requirement arises.

### Local Transport and Interfaces

Define a versioned contract between the plugin and application for:

- current telemetry snapshots;
- gameplay events and job configuration changes;
- connection state and source capabilities;
- game window state.

Messages must identify the session, ordering, and protocol version. Document the concrete schema during implementation and validate messages on both sides of the transport.

Newer live snapshots may replace older ones. Trip events use a separate delivery path and are acknowledged after persistence; redelivery must not create duplicates. An unavailable channel must remain distinguishable from a numeric zero.

Restrict named pipe access to the local user and reject remote connections. Expose only necessary operations to the UI through a typed Electron preload/IPC interface, without direct Node.js access. Use context isolation and sandboxing for renderer processes.

## 6. Main Application and Overlay

### Main Application

The minimum sections are connection and diagnostics, live metrics, the trip journal, trip details, and settings. The application runs in the system tray. Closing the main window must not silently stop recording; fully exiting the application must be an explicit action.

Distinguish waiting for a connection, active simulation, pause, lost connection, and version incompatibility. Stale readings must not appear to be current.

### Overlay

The initial metrics are:

- speed, current gear, and engine RPM;
- fuel remaining, average consumption, and estimated range;
- current cargo, delivery destination, and remaining distance when available.

The overlay is a separate transparent Electron window above the game window. It must:

- support windowed and borderless fullscreen modes;
- pass mouse clicks through to the game without taking focus while driving;
- hide when the game is minimized or the driver switches to another application;
- account for game window position, monitor selection, and Windows display scaling;
- persist position, scale, and visibility settings;
- allow repositioning in an explicitly enabled configuration mode.

The working display update rate is **up to 20 Hz**, independent of the **1 Hz** history sampling rate. A simple, readable presentation is sufficient for the initial implementation.

## 7. Trip Journal and Recording Rules

### Summaries and Events

Build the journal automatically from job configuration and delivery/cancellation events. Core fields include the game, cargo, origin and destination cities and companies, truck, planned and actual distance, time, income, cargo damage, and trip outcome.

Each record needs a project-generated stable identifier. Do not assume the SDK provides a globally unique job identifier.

Keep these concepts distinct:

- expected job income and actual delivery revenue;
- planned distance, observed odometer distance, and distance reported by the game at delivery;
- real recording time and in-game time;
- job completion and telemetry completeness.

A delivered job can have incomplete telemetry. A disappearing job configuration does not by itself confirm delivery. Determine completion from gameplay events; preserve an incomplete record without inventing an outcome when evidence is ambiguous.

Game restarts, save loading, truck changes, timer resets, and disconnections must not cause negative distance, duplicate accounting, or unjustified trip merging. Do not automatically merge ambiguous continuations. Specify detailed recovery behavior during implementation.

### Per-Second Samples

Record timestamps, speed, fuel, average consumption, range, gear, RPM, odometer, and game-world coordinates. Associate each sample with a session and, when a job exists, a trip.

Sample once per second of real time during active simulation, including stops on the road. Record pauses as events without accumulating repeated samples while paused. Free driving can be recorded as a session without an associated job.

The SDK average fuel consumption is expressed in liters/km; convert it to liters/100 km for display. It is not automatically the average for the current trip. Derived consumption calculations must account for refueling and missing data.

SDK coordinates are game-world coordinates. A geographical map and conversion to latitude/longitude are outside the MVP.

### Storage

The working database location for each Windows user is:

```text
%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite
```

Resolve the location through the user's system directory without hardcoding an account name. Store the database separately from application binaries. Application updates preserve history; schema changes use migrations.

The telemetry utilityProcess owns a dedicated SQLite worker; Electron main supervises service lifecycle and owns windows. Keep processing and persistence outside renderers. Persist an event and its corresponding trip update transactionally. The MVP does not automatically delete history. Provide JSON export.

Estimated storage is **60-120 MB per 100 hours**, with **100 MB per 100 hours** as the planning allowance. At 1 Hz, 100 hours produces 360,000 samples. An in-memory SQLite model with 15 fields and two indexes used about 52 MB with numeric references and 107 MB with full UUIDs repeated in each row. This is a model estimate, not a measurement of the finished application; auxiliary files and the final schema affect disk usage.

Prefer compact internal references in sample rows and store each UUID once in its associated entity record.

## 8. Future Server and Company Website

After the local MVP is ready, build a dedicated service supporting:

- driver accounts and virtual company membership;
- company access permissions;
- delivery history, total distance, and other reports;
- sample analysis and trip charts;
- reliable synchronization of accumulated local data.

The working stack direction is **Node.js + TypeScript + Fastify**, **PostgreSQL**, and a **React** website. Specify the server, authentication, and reports separately before implementing that phase.

Synchronize in batches over HTTPS from a durable local queue. Retries must not create duplicates. Loss of connectivity must not interfere with the overlay or local recording. The server associates uploads with the authenticated driver and verifies company access.

Keep samples, events, and summaries separate so they can be synchronized independently. Uploading the entire overlay update stream is not required.

Client telemetry is a source of statistics, not proof that a trip was legitimate. A competitive leaderboard resistant to forged data would require a separate verification design.

## 9. Implementation Sequence

ET-002a now implements SDK-independent prototype protocol 0.0 contracts and shared TypeScript/C++ fixtures in its task branch. See [wire format](docs/protocol/v0.md) and [validation](docs/validation/et-002a.md). This is synthetic contract evidence; actual pipe/game integration and durable recording are not implemented by this package.

Owner exception on October 11, 2026: ET-002a may be implemented independently from updated `main` and submitted as a draft PR while SP-01 real-game validation is deferred. SP-01 remains unaccepted and unmerged; its failed ETS2 single-player windowed appearance check requires a real retry, and Convoy remains pending. This early-start exception does not establish game compatibility, enable durable protocol v1, or waive other acceptance and merge prerequisites.

Owner-approved package sequence (October 11, 2026): ET-001 enables ET-022 and SP-01 (the early ET-009 game-validation package) in parallel. SP-01 enables ET-002a protocol v0; ET-002a enables ET-003 and ET-005a. ET-003 enables ET-004a and ET-007. ET-002a plus ET-005a enables ET-006a; ET-004a plus ET-006a plus ET-007 enables ET-008. ET-003 plus ET-004a plus ET-006a enables CAP-01. ET-008 plus CAP-01 enables full ET-009. ET-002a plus CAP-01 enables ET-002b; ET-004a plus ET-002b enables ET-004b; ET-005a plus ET-002b plus CAP-01 enables ET-005b; ET-006a plus ET-004b plus ET-005b enables ET-006b. Package acceptance requires its criteria and merge; a parent card is Done only after all its packages are accepted. ET-009 game evidence does not depend on ET-022, while relevant code checks remain mandatory. The owner alone authorizes merges.

1. **End-to-end technical prototype.** Read speed and fuel through the project-owned plugin, transmit them to Electron, and display them above the game. Validate ETS2 and ATS, including TruckersMP, before expanding the journal or visual design.
2. **Application and overlay behavior.** Connection states, reconnection, core metrics, tray operation, settings, window tracking, and monitor handling.
3. **Reliable history.** Job events, SQLite, samples, incomplete recordings, the journal, trip details, and export.
4. **Distribution.** An installer, Steam library discovery with manual path selection, plugin installation, diagnostics, and updates that preserve the database.
5. **Server phase.** A separate specification for accounts, company features, synchronization, and the website after validating the local product.

Install, replace, or remove the DLL only while the game is closed. Manage only this project's plugin; do not overwrite other telemetry plugins. Manual updates through the distribution package are sufficient for the MVP; an automatic update service is not required.

Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

Owner sequencing decision on October 11, 2026 initially allowed ET-004a, ET-006a and ET-007 to start on isolated branches based on independently reviewed PR #10/#11 commits, which were unaccepted at that time. Every missing criterion remains pending; this exception does not authorize v1/history or extend scope to ET-008 or later phases.

Owner acceptance update on October 11, 2026: ET-005a was explicitly accepted and PR #11 squash merged as `a9cc9b34f25480226d34b86c2fb5100c55e9312e`, from verified source `00402bb90abfc41da748b9ff629b460d629c9ee8`. ET-006a now continues against accepted ET-002a and ET-005a on updated main. ET-003/ET-004a/ET-007 and SP-01 remain unaccepted; required game, environment and performance checks remain pending. ET-005b still requires ET-002b/CAP-01, so the ET-005 parent card is not Done. This acceptance does not waive other package gates.

Owner decision on October 11, 2026: ET-006a implementation and automated evidence were accepted for squash merge. PR #13 merged as `123663d8186cef7ff4745d9474caab68d3be6fa4` from source `69dba2c`, after final Ready CI run 38174065173 and independent source/raw evidence review passed. ET-006b and mandatory game, environment and performance checks remain pending. The owner requested preparing existing PR #10/#12/#14 for merge; this does not merge or accept those packages, waive their manual criteria or extend scope to ET-008/v1/history.

The maintained v0 client uses a fixed project-owned native broker for documented Windows connected-pipe authority and bounded raw I/O, supervised by the telemetry utilityProcess. Framing, validation, state/domain logic and subscriptions remain in the service; main owns windows/supervision and the service owns its SQLite worker. See [the native transport boundary](docs/native-transport-boundary-v0.md). This preserves the process architecture and wire format while making peer verification explicit; implementation/runtime evidence remains with ET-004a/ET-006a.

## 10. Acceptance Criteria and Validation

[TESTING.md](TESTING.md) defines the test layers, permanent regression scenarios, CI/merge policy, historical migration checks, and real-game evidence. ET-001 adds scaffold checks; extend them in every feature PR. Most repeatable feature logic will use simulation, real local transport, and isolated storage; real-game compatibility and input/window behavior require separate evidence. The Windows CI workflow has recorded clean hosted and deliberate failure/restoration evidence; final current-head checks and review remain required, and broader feature suites remain pending.

- Complete job lifecycle in both games: acceptance, driving, stopping, pausing, delivery, and cancellation.
- A separate compatibility matrix for single-player and TruckersMP, recording tested versions. Convoy is deferred (see the October 12, 2026 owner decision). Documentation alone does not establish compatibility.
- Application launch before and after the game, reconnection, restart, game exit, and plugin reinitialization.
- Save loading, truck changes, refueling, unavailable channels, timer resets, and partially recorded trips.
- The ordering of job configuration changes and delivery events must not lose the result. Duplicate events must not create duplicate trips.
- Overlay behavior with Alt+Tab, multiple monitors, different DPI settings, window movement, mouse pass-through, and uninterrupted game controls.
- A one-hour recording session without hangs or sustained memory growth. The working display latency target is at most 200 ms under normal conditions.
- Measure frame-time impact under comparable conditions with and without the utility. Performance claims require measurements.
- Installation on a machine without development tools, application updates, and history preservation.
- A simulated source and recorded scenario replay should support most logic testing without running the game. Clearly mark simulated data and keep it separate from real trip history.

## 11. Guidance for Future Agents

- Start with this document and the applicable repository instructions in `AGENTS.md`.
- For owner-requested implementation coordination, follow [COORDINATOR.md](COORDINATOR.md) and the [launch prompt](docs/prompts/coordinator-start.md). The coordinator delegates bounded work, verifies dependencies and acceptance evidence, manages Trello execution, and prepares PRs for owner review. This workflow does not change product requirements, authorize merges, or establish game compatibility.
- Write all internal documentation that may enter Git in English, including explanatory code documentation. Continue user-facing conversation in the user's preferred language; the owner currently communicates in Russian.
- Explain desktop-specific behavior through concrete process and component responsibilities, accounting for the owner's web development background.
- Validate the SDK/application/overlay path against a running game early in implementation.
- Preserve the distinction between MVP requirements, the future server phase, and visual design that has not yet been agreed.
- Document the protocol, units, trip accounting rules, and tested versions as implementation progresses.
- Distinguish verified behavior from assumptions. Do not promise support for every fullscreen mode or TruckersMP version without testing.
- Examples of other utilities may inform scenarios and design, but receiving them is not a prerequisite for starting the technical work.
- Update this concept when requirements change so it remains an accurate handoff document.

## 12. Primary Sources Examined

- [SCS Telemetry SDK official page](https://modding.scssoft.com/wiki/Documentation/Engine/SDK/Telemetry).
- [SCS SDK 1.15 archive](https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip): examined `readme.txt`, event definitions, fuel channel definitions, and job configuration definitions; plugin examples are also included.
- [TruckersMP plugin development and installation](https://github.com/TruckersMP/Docs/blob/master/client-sdk/getting-started.md).
- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model).
- [Electron transparent windows](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles).
- [Electron mouse pass-through](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).
- [Electron security and renderer isolation](https://www.electronjs.org/docs/latest/tutorial/security).
- [Node.js IPC and Windows named pipes](https://nodejs.org/api/net.html#ipc-support).
- [Microsoft named pipes documentation](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipes).
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3).
- [Electron Forge](https://www.electronforge.io/).

These sources reflect research performed when the concept was recorded. Verify current APIs and required capabilities again when selecting implementation versions.

### ET-001 recovery status (October 11, 2026)

At source `43d3cc3`, coordinator typecheck and 102 Node tests passed; 18 actual harmless installer-controller controls were independently accepted. Installed attempts remain failed evidence, including WMI null and non-null differing images with matching held native identity. The single-query native-authority observer passed metadata binding in the guest; terminal held-identity handling is now being validated without changing product architecture or runtime caps. Actual installed acceptance and final immutable PR review are still required before dependent packages start; see the validation record for exact commits, exports and restoration results.

The scaffold includes bounded startup diagnostics, corrected physical worker/dependency packaging, shutdown regression tests, an external Windows Job Object watchdog and static package fingerprints. The owner revoked the native launch hold and VM requirement on October 11, 2026. Native installed lifecycle/probe acceptance is recorded as six actual operations plus a separate corrected uninstall predicate and owned cleanup; historical failures remain retained. This does not prove long-session stability, game compatibility or resolution of the original Windows-wide freeze. See [setup](docs/setup.md#packaged-startup-recovery-hold-october-11-2026) and [validation](docs/validation/et-001.md).

## Owner merge and board-status exception — October 12, 2026

The owner authorized the coordinator to squash merge PR #10 (ET-003), #12 (ET-004a) and #14 (ET-007) without further confirmation once agreed actionable review findings are resolved and the required final Windows CI passes, and directed their corresponding Trello cards to Done. PR #10 was merged as `85d9f83a763f1ca71c2d640dadc5d8fbf2d9e69b` after its exact-head CI and independent review. Integrate accepted main and verify the final candidate before each subsequent merge. This is an explicit administrative status/code-review exception: mandatory game, environment, CAP-01 and performance evidence, SP-01 windowed retry/Convoy, and ET-004b remain pending and are not accepted or implemented by that status. No compatibility, protocol-v1, durable-history or later-phase authorization follows. Keep every missing check visible in the card and ledger. Advisory AI-review execution failures remain non-gating under docs/ai-review.md; mandatory independent review and Windows checks remain required.

## Minimal overlay continuation — October 12, 2026

After the conditional code-review merges of PR #10, #12 and #14, the owner instructed the coordinator to continue available first-stage work that does not require launching actual games. ET-008 may now implement the maintained minimal overlay from accepted main `6c3af45b039aa9d8bb88a8479728f1212f7a343f` (ET-004a, ET-006a and ET-007). Keep its real-game/input/focus/mixed-DPI/monitor-removal/performance acceptance pending, as well as CAP-01 and SP-01 windowed retry/Convoy. This permission authorizes implementation, isolated automated/controlled validation and a task PR; it does not extend the PR10/12/14 conditional merge or Done exception to ET-008, waive its game gate, or authorize ET-010+, protocol v1, durable history or server work. Reuse the protected v0/typed bridge and current-window authority; the overlay renderer receives no native placement, HWND, filesystem or source-selection authority. Follow physical-client to Electron DIP conversion and preserve independent SDK/window freshness, bounded up-to-20Hz delivery, nonfocus click-through driving mode and hiding on foreground/minimize loss. ET-000 display defaults remain ETS2 metric and ATS US customary, separate from canonical v0 m/s and L; real SDK unit observations remain pending CAP-01.

## ET-008 code-acceptance exception — October 12, 2026

The owner explicitly accepts ET-008 code by exception and authorizes the coordinator to integrate PR #21 with current main, preserve Tailwind/shadcn in the main window and the isolated transparent overlay, obtain independent review and a successful final automatic Windows CI after Ready, then squash merge without another confirmation. This supersedes the earlier implementation-only permission for this package. Mandatory game, environment, CAP-01/SP-01 and performance checks remain pending; a code merge does not establish compatibility or complete those criteria. The card remains in Review until its mandatory criteria are accepted. No protocol v1, durable history, later MVP or server work is authorized.

## Convoy validation deferral — October 12, 2026

The owner removed the built-in Convoy multiplayer mode from the current validation matrix: the owner does not play Convoy and has no procedure to test it. The matrix for SP-01, CAP-01, the full ET-009 gate and later ET-020 is now ETS2 and ATS, each in single-player and TruckersMP, with windowed and borderless modes. Convoy is deferred, not rejected: it is neither validated nor claimed as supported, and the application must not advertise Convoy compatibility. Earlier dated records that list Convoy as pending keep their historical wording; this decision supersedes those pending Convoy checks. TruckersMP still requires actual game evidence; single-player and TruckersMP results do not establish Convoy behavior.

## Silent plugin installation — October 12, 2026

The owner chose silent plugin installation, matching other telemetry utilities, over a multi-step setup wizard. On launch, the application discovers ETS2 and ATS through the Steam library list. Without asking, it installs the project plugin into each discovered game's `bin/win_x64/plugins`, or updates it there, whenever it can do so safely. The driver can also add a game folder manually at any time, for example an installation outside the Steam libraries. The driver can exclude a game, and the exclusion persists in settings, so an excluded game is never reinstalled silently.

The application shows a prompt only when it cannot proceed alone:

- the game or TruckersMP is running, so the driver must close it before the plugin can be installed or replaced;
- no game is found automatically, so the driver must choose the game folder;
- the destination needs permissions the application does not have;
- a file with the project plugin's name already exists, but its hash matches no version this application installed (for example after the developer procedure in `docs/manual-plugin-setup.md`, an interrupted copy or a user-modified file). The driver must remove or explicitly confirm it; the application never overwrites it silently.

All existing safety rules still apply, made precise for unattended installs:

- Change the DLL only while the game and client are closed. Treat the closed-state check as advisory: if the destination is locked, or the game starts during an update, fail the update and report `blocked`. Never wait or retry while the game is in use; try again after the game exits or at the next launch.
- Manage only this project's file and never touch other plugins.
- Copy atomically. Write a temporary file in the same `plugins` directory and verify its SHA-256 against the expected hash of the plugin bundled with this application version. Then rename it over the destination. A failed or interrupted copy must never leave a partial `ets2telemetry-plugin.dll`.
- Replace or remove an existing file only when its hash matches a version this application installed.
- Remove only the owned file on uninstall.

The application must show the plugin state for each game: installed, outdated, missing, excluded by the driver, or blocked (with the reason). ET-017 implements this behaviour; its card title still says "wizard", but this decision governs the user experience.
