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

The minimum sections are connection and diagnostics, live metrics, the trip journal, trip details, and settings. The application runs in the system tray. Closing the main window must not silently stop recording; fully exiting the application must be an explicit action. ET-011a implements tray operation, a single instance and explicit exit; see [ET-011 authorization](#et-011-authorization--october-15-2026) and [the application lifecycle](docs/app-lifecycle.md).

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

Measured storage (ET-013 PR-2, October 15, 2026): the actual schema version 1 used **53.4 MB per 100 hours** of 1 Hz history (360,000 samples, 100 trips, 950 events and 50 gaps written through the storage core with its durability settings; samples with both indexes take about 144 bytes each), with a WAL peak of 4.2 MB. **100 MB per 100 hours** stays the planning allowance. This is one synthetic measurement, not a guarantee; real one-hour growth remains REG-018 work. See [storage](docs/storage.md#measured-size-et-013-pr-2). The earlier estimate of **60-120 MB per 100 hours**, from an in-memory SQLite model with 15 fields and two indexes (about 52 MB with numeric references and 107 MB with full UUIDs repeated in each row), is superseded by this measurement.

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

## CAP-01a evidence capture transport — October 12, 2026

The owner approved the CAP0 evidence-capture direction on October 12, 2026. CAP0 is a separately versioned, default-off, evidence-only contract on its own named pipe, isolated from the frozen v0 live protocol; the v0 handshake, parser, fixtures and overlay path are unchanged. Approved bounds: 64 KiB per packet; a native evidence queue of 128 envelopes and 2 MiB with non-blocking newest-drop and explicit loss counters; an application writer with 2 MiB pending data, 20 MiB per file and a 10-minute default deadline; output in a separate capture directory outside `telemetry.sqlite` and the application binaries. CAP0 has no ACK, offline spool, history, trip effects or renderer authority. Package CAP-01a implements this contract and its tooling without a game; see [the CAP0 contract](docs/protocol/cap0.md) and [CAP-01a validation](docs/validation/cap-01a.md). The production plugin always exposes a passive CAP0 endpoint that copies nothing until the approved broker authenticates; the application enables one capture per launch only through `ETS2TELEMETRY_CAPTURE=cap0`. CAP-01a does not accept CAP-01 or ET-009: real captures from both games and the required modes, sanitized and independently reviewed observations, frame-time impact, and the SP-01 windowed retry remain pending (Convoy is deferred). No protocol v1, durable history or later-phase work is authorized.

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

## Fine and gameplay-event trip attribution — October 13, 2026

The owner decided how gameplay events such as `player.fined` relate to trips:

- Record every gameplay event in the gameplay-event store, including events that occur when no job is active, for example while driving freely before taking a job or after delivery.
- Place every event relative to job configuration changes by the plugin's shared boundary order (or its successor in protocol v1), never by wall-clock time.
- An unloaded leg to the pickup location counts as part of the trip. Events on it are attributed to the trip and marked as occurring before the cargo was loaded, so reports can separate them. Per SDK 1.15, `cargo.loaded` is meaningful only for cargo-market jobs (it is always true for other markets), so this marking applies to cargo-market jobs; no cargo-market job has been observed yet.
- Events outside any active job stay visible as free-driving events. They must not change any trip's totals.

### Attribution window

A job's event window opens at the first job configuration that defines the job. It closes at the earliest of these boundaries:

- the job's outcome event (`job.delivered` or `job.cancelled`);
- the configuration clear for that job;
- a different job configuration;
- a session or plugin restart;
- a timer reset, save load or other discontinuity;
- the start of a reported gap or loss interval.

Events after the window closes are not attributed to the trip.

The outcome is decided only by the gameplay outcome event, never by the configuration clear, and either order between the two must be handled. An outcome event that follows the clear is attached to the job only when nothing lies between them: no different job configuration, no restart, discontinuity or reported gap. Otherwise the trip keeps no inferred outcome and stays incomplete, consistent with the existing completion rule.

When a different job configuration, restart, discontinuity or gap closes the window without an outcome, that close is unattributable: the trip stays incomplete. Events inside a reported gap or loss interval are not attributed to any trip. They are kept and marked ambiguous.

### Owner-session observations (independently reviewed October 13, 2026)

The following come from owner CAP-01 sessions. An independent read-only reviewer verified them against the sanitized exports on October 13, 2026 (see the addendum in `docs/validation/cap-01a.md`, including ordering expectations O1–O9 with sample sizes). The exports are kept locally, not committed as fixtures. Samples are small (four deliveries, one cancellation): they establish that these orderings occur, not that they are guaranteed.

- ATS single-player, run 4, October 13, 2026: four `red_signal` fines occurred before the job configuration appeared, and two fines occurred during the job.
- ETS2 single-player, run 3, October 12, 2026: two of the five fines occurred before the job configuration appeared.
- All four observed deliveries (single-player and TruckersMP): `simulation.paused` preceded `job.delivered`, which arrived while paused. On delivery, `job.delivered` arrived before the job configuration cleared.
- ETS2 single-player, run 3, October 12, 2026: on cancellation, the configuration cleared before `job.cancelled`.

ET-014 implements this attribution and adds replay scenarios for each window boundary and both outcome orderings.

## Job, cargo, trailer and truck identity in trip records — October 13, 2026

Owner CAP-01 sessions (independently reviewed October 13, 2026) show that the SDK provides per-job route, cargo and vehicle configuration. For example, run 4 in ATS reported:

- source and destination city and company;
- cargo id, mass, unit mass and unit count;
- market and income;
- trailer body type, model id, chain type and plate;
- truck brand, model and plate.

The owner decided that trip records keep this data, with two storage rules:

- **Store both the stable id and the localized display name.** Store `source.city.id`, `source.company.id`, `destination.city.id`, `destination.company.id`, `cargo.id`, the truck `brand_id` and `id`, and the trailer `id` and `body.type`, together with the localized names the game sent. Names arrive in the game's UI language (for example, a Russian client reported cargo and plate-country names in Russian, while most city and company names arrived untranslated; the SDK does not update localized strings if the in-game language changes). Comparisons, aggregation and future company reports use ids, so drivers with different game languages see the same entities. The localized name is display data captured at that time.
- **Trailer names may be absent.** SDK 1.15 defines trailer `brand_id`, `brand` and `name`, but they were absent for every job trailer observed (none owned); only the internal model id and body type arrived. Owned trailers are untested. When no name arrives, display the body type or a project-maintained id-to-name mapping; do not invent names. Keep unknown ids visible as ids.
- **Provided empty values differ from missing values.** The SDK sometimes sends an attribute with an empty string (for example `cargo.accessory.id`). Store it as a provided empty value, distinct from an unavailable (not sent) attribute; the "never empty strings" rule applies to values the game did not send.

ET-013 and ET-014 own the schema and capture of these fields. Missing attributes remain unavailable, never empty strings or zero.

## Game mode as a trip attribute — October 13, 2026

The owner decided that every trip records its game mode, single-player or TruckersMP, because the mode is an important criterion for a trip. Convoy stays deferred, but the attribute must allow it to be added later. If the mode cannot be determined, record it as unknown; never default it to single-player.

The SCS SDK does not report TruckersMP. In CAP-01 run 5 (ETS2 via TruckersMP, October 13, 2026; an owner session, independently reviewed October 13, 2026), the capture header was indistinguishable from single-player apart from the operator label.

Candidate detection methods, in order of preference, still to be verified on real sessions before implementation:

1. **Inside the plugin.** The plugin checks the game process's loaded-module list for the TruckersMP client module. This is an operating-system module enumeration, not a read of game memory, so the MVP exclusion of arbitrary game memory reads still holds. Record the exact module name only after it is observed in a real session. Inside SDK initialization the check is a single bounded call, with no retries or waiting. If the real-session check shows that TruckersMP may inject its module after plugin initialization, re-check from the plugin worker thread, never from an SDK callback, until a positive result or a bounded deadline. Finding the module is strong evidence of TruckersMP. Not finding it is weak evidence: the module may load later or be renamed. Such a result is recorded as single-player with low confidence and must never be presented as a confident single-player label.
2. **From the application.** Check whether a TruckersMP client process is running. This is weaker, because a client left open during single-player would mislabel the trip.
3. **Indirect signals,** such as the game version pinned by TruckersMP. These are hints only and must never decide the mode alone.

The detected mode, its method and its confidence are trip evidence and travel through the protocol. Adding the mode to the wire contract belongs to protocol v1 (ET-002b); ET-014 stores the mode on the trip. Switching between single-player and TruckersMP requires restarting the game, which is already a session and plugin restart boundary in the attribution window. The mode is therefore determined per plugin session and is not expected to change within one. If a later re-check ever contradicts the recorded mode, keep both results as evidence and mark the trip mode ambiguous rather than rewriting it.

Update on October 14, 2026: protocol v1 carries this evidence (mode, method, confidence and module) per plugin session in `welcome` and `status`, and as the durable `source.gameMode` event; see [protocol v1](docs/protocol/v1.md#8-durable-events).

## Sleep and unannounced game-time jumps — October 13, 2026

SDK 1.15 has no sleep or rest gameplay event. In CAP-01 run 2 (ETS2 single-player, October 12, 2026) the owner slept, and the only trace was a forward game-time jump of about 595 game minutes within a few minutes of active simulation, with no lifecycle or gameplay event. ET-014 must treat a large forward game-time jump without a timer reset as a possible sleep or rest: keep it as an annotated discontinuity of game time, never fabricate samples or game-time intervals across it, and keep real-time accounting unaffected. Report game-time durations, such as delivery time, as the plain game-time span including the jump: this matches the game's own `delivery.time` (O4) and its lateness accounting (run 2 was 471 game minutes late across the sleep). Annotate the jump instead of subtracting it. The `rest.stop` channel and the `avoid_sleeping` fine are additional, unverified hints. Ferry and train crossings also advance game time faster than driving (CAP-01 run 8, October 14, 2026), but they come with an explicit `player.use.ferry` or `player.use.train` event. ET-014 should label a jump next to such an event as a crossing, not as a possible sleep. Because the capture cannot locate the jump relative to the event, this labelling rule is still unverified.

## Save loading — October 14, 2026

In CAP-01 run 9 (ETS2 single-player, October 14, 2026; owner session, independently reviewed October 14, 2026), a save loaded within one game process produced this sequence:
- `simulation.paused`;
- the job, controls, truck and trailer configurations cleared;
- the configuration set re-sent, except `car_job`;
- `simulation.started`;
- `game.time.regression`, with game time back at the saved value and the game-time clock rotated. Only this event carries the new time and clock: the re-sent configuration and `simulation.started` still carry the pre-load values.

The plugin stayed loaded and the v0 session continued; there was no `timers.restart`. CAP0 carries no channel values, so odometer, distance and fuel across a load are unobserved. ET-014 must not assume they are continuous.

ET-014 must therefore:
- treat a configuration clear and re-send around a game-time regression as a probable save load, and decide only after the regression is observed (it follows `simulation.started`);
- continue the same trip only when every job attribute is identical to the trip's last known job configuration. A load can restore a different job or no job; otherwise mark the continuation ambiguous and do not merge it;
- annotate the discontinuity and never count negative distance or time.

A save load first clears truck and trailer to empty configurations. A cancellation instead re-sends them with their values and emits `job.cancelled`. A configuration clear alone still does not prove an outcome: delivery and cancellation come only from their gameplay events. A cargo-market job also re-sends its configuration at pickup with only `cargo.loaded` changed, so a re-send alone is not a new job. These rules rest on one save-load sample.

## CAP-01 and SP-01 acceptance — October 14, 2026

The owner accepted CAP-01 on October 14, 2026 with explicit gaps, and SP-01 on the same day.

CAP-01 is accepted on owner CAP0 sessions 2–9, two independent observation reviews, and expectations O1–O11 ([CAP-01a validation](docs/validation/cap-01a.md#cap-01-acceptance-october-14-2026)). Its gaps remain pending, not observed:
- windowed ATS single-player, and both games under TruckersMP in windowed mode;
- a train crossing and a weigh station;
- a profile change, a second job in one session, special jobs, owned trailers, a TruckersMP disconnect and menu-only states;
- late attach after a job started (job configuration at attach);
- refuel through the fuel channel;
- runtime currency;
- values across a save load;
- the plugin's own frame-time cost.

SP-01 is accepted as an owner decision. Its early feasibility goal was superseded by the maintained ET-008 path. The windowed retry passed in ETS2 single-player on October 14, 2026 ([ET-008 validation](docs/validation/et-008.md)), and Convoy stays deferred.

Neither acceptance establishes TruckersMP, display or performance support, or completes the full ET-009 gate. Authorization for later packages is recorded separately.

## Multi-monitor validation deferred — October 14, 2026

The owner deferred multi-monitor, mixed-DPI and monitor-removal testing until a distributable installer exists, to be performed on another computer. The overlay requirements for monitor and DPI changes are unchanged. Their validation for ET-008, ET-009 and ET-020 is deferred, not waived, and no multi-monitor support is claimed until it is tested.

## Bus and car jobs deferred — October 13, 2026

The owner deferred bus jobs and car jobs (`bus_job`, `car_job`, `car_job.delivered`, `car_job.cancelled`) from the current validation and trip scope: bus content is not yet released for ETS2, car jobs in ATS are recent, and TruckersMP buses are out of interest for now. They are tracked as technical debt TD-002. Their empty configuration envelopes, observed at every session start, must be tolerated and must not create trips.

## ET-002b authorization — October 14, 2026

The owner authorized ET-002b on October 14, 2026 as a contract-only package. PR-1 adds the English wire specification [protocol v1](docs/protocol/v1.md), the TypeScript schemas and delivery helpers, and shared fixtures with Vitest. PR-2 adds the matching C++17 representation that reads the same fixtures. For ET-002b only, this supersedes the "no protocol v1" wording in earlier dated paragraphs.

The authorization does not extend to ET-004b (the plugin's v1 endpoint and producer queue), ET-005b (the v1 simulator), ET-006b (v1 ingestion), durable storage, trip logic or later phases; each remains unauthorized. No runtime path changes: the plugin, broker, simulator and desktop service keep speaking v0. Real-game, TruckersMP, display and performance criteria remain pending, and Convoy stays deferred and unclaimed.

## Protocol v1 decisions — October 14, 2026

The owner accepted all architect recommendations for ET-002b on October 14, 2026. [Protocol v1](docs/protocol/v1.md) specifies them in detail.

| # | Decision |
| --- | --- |
| D1 | Strict length-prefixed JSON as in v0 and CAP0; no binary encoding |
| D2 | A separate v1 pipe, discovery directory and service policy. The plugin serves v0 and v1 side by side during ET-004b and ET-006b. A v0-retirement PR lands before ET-015a enables recording; recording never ships on v0 |
| D3 | v1 drops the v0 `diagnostic` kind; CAP0 is the evidence channel |
| D4 | The durable event set: job, truck and trailer configuration and clears, simulation pause and start, timer restart, game-time regression, delivery, cancellation, fine, toll, ferry, train and game mode. Bus and car jobs are excluded (TD-002) |
| D5 | `eventSeq` is assigned to every observed event, including lost ones. Coverage is contiguous: events plus ordered gap messages with counted causes |
| D6 | The ACK is cumulative only and equals the highest contiguous storage-committed `eventSeq`, gap markers included. No selective ACK, no in-connection retransmission; redelivery only on reconnect |
| D7 | Retention of 256 entries and 1 MiB with newest-drop; maximum encoded event 16 KiB; disconnect retention 5 minutes; client frames 4 KiB; hello deadline 5 s; write deadline 1 s; snapshots at most 20 Hz |
| D8 | Durable delivery is opted into with `durableEvents` in hello. A live-only v1 client is allowed; while no durable consumer is connected, events become `no-durable-consumer` gaps |
| D9 | Game mode is per-session evidence in welcome and status, plus a durable `source.gameMode` event. Convoy is reserved. A weak single-player result is never presented as confident |
| D10 | `clock.probe`/`clock.reply` and a local-only clock mapping with uncertainty |
| D11 | Currency status is `sdk-documented` (with the header source) or `unknown`, until runtime observation |
| D12 | A provided empty string is available `""`. Ids are at most 128 bytes and names at most 256 bytes; text is never truncated |
| D13 | One event per job or truck configuration callback, including identical re-sends. Trailer slots only when non-empty, or when cleared after being non-empty |
| D14 | A best-effort `end` at shutdown; the producer never waits for an ACK |
| D15 | One event per frame; no batching |
| D16 | Two PRs: the specification, TypeScript and fixtures first, then C++ |
| D17 | Current-state additions: world placement, navigation distance, boundary order, truck and trailer identity and the status block. The worst-case checkpoint must fit in 64 KiB, proven by a fixture |

## ET-002b acceptance and ET-004b authorization — October 14, 2026

The owner accepted ET-002b on October 14, 2026: PR #42 (`59a2667`, specification, TypeScript and fixtures) and PR #43 (`2d48c9a`, C++17 representation). The owner authorized ET-004b, the plugin's protocol v1 producer, delivered as three PRs: the producer core, callback capture and the v1 endpoint. For ET-004b only, this supersedes the statement in the ET-002b authorization section that ET-004b remains unauthorized. ET-005b, ET-006b, ET-013 and later storage, trip logic and later phases remain unauthorized. The desktop application stays on v0. Synthetic tests establish no game, TruckersMP or performance behavior.

The owner approved the architect recommendations OD-1 to OD-6:

| # | Decision |
| --- | --- |
| OD-1 | Three PRs in order: producer core, callback capture, endpoint |
| OD-2 | Per D2 the production plugin serves v1 beside v0. The v1 endpoint is passive and fail-closed until ET-006b provisions its service policy; its startup is asynchronous and non-fatal and writes no game log |
| OD-3 | Game mode is `unknown`, method `none`, confidence `none`, and no `source.gameMode` event is emitted. Detection is a separate package |
| OD-4 | Without a durable consumer, events become `offline` or `noDurableConsumer` gaps; a live-only client starts no retention |
| OD-5 | Wording clarifications S1–S11 in [protocol v1](docs/protocol/v1.md), with no wire, field or fixture change |
| OD-6 | State `trailers` always has ten entries; an empty slot is unavailable (`not-observed`) |

The producer's store rules are in [the native v1 transport](docs/native-transport-v1.md).

## ET-005b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents."

Coordinator interpretation: this instruction is what authorizes starting ET-005b, the protocol v1 simulator, as three PRs. For ET-005b only, it supersedes the statements in the ET-002b authorization and ET-004b authorization sections that ET-005b remains unauthorized. The merge gate (a verifier pass, independent review, no unresolved review threads and a successful Windows CI after Ready on the final head) is the coordinator's self-imposed standard. The simulator opens no database, writes no history, discovery or service-policy file, calls no SDK function and emits only synthetic or replay origins. The desktop application stays on v0, and nothing here establishes game, TruckersMP, display or performance behavior.

The coordinator adopted these decisions under that delegation; the owner has not reviewed them individually:

| # | Decision |
| --- | --- |
| CD-1 | Three PRs in order: the deterministic simulator core, pipe serving with fault injection, then CAP-01 replay |
| CD-2 | A TypeScript producer model that mirrors the native store invariants I1–I8 and the endpoint caller sequence; the ET-002b contract helpers are reused unchanged |
| CD-3 | One SDK-callback vocabulary for synthetic scenarios and CAP-01-derived sequences |
| CD-4 | Only `synthetic` and `replay` origins; the simulator never emits `game` |
| CD-5 | A `SYNTHETIC-TEST-v1` pipe endpoint without discovery records or service-policy files |
| CD-6 | An in-memory commit ledger stands in for storage; it is not storage |
| CD-7 | Minimized, tokenized fixtures derived from CAP-01 may be committed with provenance; lossy captures are rejected and raw or sanitized exports stay local. Adopted, pending owner acknowledgement before PR-3: it reverses the owner's earlier deferral of committing CAP-01 fixtures ([CAP-01a validation](docs/validation/cap-01a.md)), for these derived fixtures only. PR-3 lands last and records the owner's response |
| CD-8 | Game mode is `unknown` by default (OD-3); a synthetic override exists only to exercise D9 |
| CD-9 | Currency status is chosen per scenario: `unknown` or the SDK-documented EUR or USD |
| CD-10 | In pipe mode, events, gaps, checkpoints and `end` are byte-identical to replay, snapshots equal in state and continuity, and clock replies are checked separately |
| CD-11 | Retention runs in scenario time; pipe mode fast-forwards offline segments |
| CD-12 | A system suspend is modeled both with and without the source clock advancing |

## ET-013 authorization — October 15, 2026

The owner authorized ET-013 (the SQLite storage worker and schema) on October 15, 2026, in parallel with ET-004b PR C, granted the coordinator merge authority after independent review and a successful final Windows CI, and delegated the ET-013 design decisions to the coordinator. The coordinator adopted the architect's recommendations OD-1 to OD-10 as coordinator decisions under owner delegation; [storage](docs/storage.md#decisions-october-15-2026) records them with the schema, durability, migration and backup rules. For ET-013 only, this supersedes the October 14, 2026 statements that ET-013 remains unauthorized; earlier dated text is unchanged. ET-014, ET-015a, ET-015b, ET-015c, ET-006b and ET-016 remain unauthorized by this paragraph; ET-005b is authorized separately in the paragraph above. The desktop application stays on protocol v0, records nothing and sends no ACK. The §7 storage estimate remains a model until ET-013 PR-2 measures the actual schema. No game, TruckersMP or performance claim follows from this authorization or from synthetic storage tests.

ET-013 PR-2 implementation update (October 15, 2026): the telemetry service runs the storage core in its storage worker, opens `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite` at start without blocking live telemetry and closes it in the `storage` shutdown phase; killed-process and worker-failure tests and a measured 53.4 MB per 100 hours are recorded in [ET-013 validation](docs/validation/et-013.md); nothing is recorded or acknowledged yet.

## ET-011 authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-011 (application tray lifecycle and persistent settings) and adopted the architect's recommendations C1–C17 below as coordinator decisions. The owner has not reviewed them individually; they can be revisited like any other recorded decision. This section covers ET-011 only; other packages started under the same delegation are recorded in their own sections.

| # | Decision |
| --- | --- |
| C1 | Two PRs: ET-011a (tray lifecycle, single instance, explicit exit, health, service shutdown hooks), then ET-011b (persistent settings and unit profiles) from `main` after ET-011a merges |
| C2 | Closing the main window destroys it and retires only its document state; reopening creates a new window that subscribes again |
| C3 | The overlay survives main-window close and keeps following the game; it closes only on exit |
| C4 | Single instance after the diagnostic profile override; a second launch exits 0 silently before any log, service or window; its arguments, working directory and data are ignored |
| C5 | A generated multi-resolution PNG tray icon without a fixed GUID; menu with status, recording notice, Open and Exit; click opens; no balloons; without a notification area, closing minimizes |
| C6 | One idempotent exit for the tray, the renderer, `app.quit()` and Windows session end; existing 3 s kill and 5 s final exit bounds unchanged |
| C7 | Service shutdown in ordered intake, flush and storage phases with per-step budgets and a 2500 ms total |
| C8 | Post-readiness service failures use the existing supervised restart with visible state instead of exiting; pre-readiness failures stay fatal |
| C9 | Main-owned application health with fixed codes only; recording is reported unavailable |
| C10 | Settings live in `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json` (ET-011b) |
| C11 | Settings format v1 with validation, migration of older versions, read-only handling of newer versions, quarantine of invalid files and atomic writes (ET-011b) |
| C12 | Per-game unit profiles `metric` and `us-customary`, defaulting to ETS2 metric and ATS US customary (ET-011b) |
| C13 | English user interface text centralized in one module; no localization framework yet |
| C14 | A narrow preload extension with sender and main-frame checks on every handler; no paths, details or generic patch API |
| C15 | No autostart, auto-update or cloud synchronization |
| C16 | A bounded lifecycle smoke in development and packaged modes under the unchanged Job limits, split into a separate restart scenario only if the 60 s Job is too tight |
| C17 | Work packages ET-011a and ET-011b; the card stays in Review until its manual Windows and real-game checks are accepted |

ET-011a changes the earlier behavior in which closing the dashboard stopped the v0 service and closed the overlay. Recording survival across close-to-tray (REG-012) still requires ET-015. Manual checks of the real notification-area icon, display scaling, Explorer restart, Start-menu relaunch and sign-out, and real-game overlay behavior while the main window is closed, remain pending; see [ET-011 validation](docs/validation/et-011.md). No autostart, auto-update, cloud synchronization or recording is authorized, and no game, TruckersMP, display or performance claim follows from synthetic or local checks.

ET-011b implementation update on October 15, 2026: per-game display unit profiles are saved in `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json` (format v1, no startup write, byte-identical quarantine of invalid files, read-only newer versions, synced atomic saves) and applied to the dashboard and overlay through telemetry-core conversions only after a durable save; see [settings](docs/settings.md). The ET-011 manual and real-game checks remain pending.

## ET-010 authorization — October 15, 2026

On October 15, 2026 the owner gave the coordinator standing autonomy: "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under that delegation the coordinator started ET-010 (live telemetry) and adopted the architect recommendations N1–N16 below. They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner; the owner may revise them.

ET-010 changes no v0 wire, preload/IPC, storage, trip logic, recording or later-phase scope. It makes no game, TruckersMP, display or performance claim; real-source dashboard checks are pending in [ET-010 validation](docs/validation/et-010.md). The field catalogue and rules are in [live telemetry fields](docs/live-telemetry-fields.md).

| # | Decision |
| --- | --- |
| N1 | Three packages in order: ET-010a normalization and display profiles in telemetry-core; ET-010b the complete live field set on the dashboard, after ET-011a and ET-011b; ET-010c protocol v1 fields on the dashboard, after ET-006b |
| N2 | telemetry-core is the single numeric source for unit conversion; ET-011b delegates its numerics to it |
| N3 | A source-agnostic normalized state with v0 and v1 adapters; the internal `not-carried` reason marks fields the protocol in use does not transport and never reaches the wire or storage |
| N4 | The renderer builds the view from pure functions per bridge update; no bridge, preload or IPC change |
| N5 | Labels and reason texts live in the application strings (`apps/desktop/src/strings.ts`) |
| N6 | Missing, stale and paused rules: missing values show `unavailable` with a reason; every non-current status hides all values; paused current values stay visible with a banner; no dimmed last-known values |
| N7 | A fixed rounding table, with one decimal for speed and fuel; no signed zero |
| N8 | Consumption: the exact US mpg constant, the SDK-mean label, and no own trip average or range |
| N9 | Money stays exact raw digits with an SDK-documented or unknown currency; no symbols and no conversion |
| N10 | Four distance kinds: planned, navigation remaining, game-delivered and odometer |
| N11 | REG-008 stateless step primitives with provisional thresholds |
| N12 | Mass in t or lb, compass bearing, `Day N, HH:MM` game time and signed deadline formats; zero L/100 km is numeric in metric only |
| N13 | The MVP field set; driving controls and navigation extras deferred as TD-003; gameplay events go to the journal |
| N14 | Text fallback: localized name, then id; trailers use the body type before the id |
| N15 | Per-quantity unit overrides as a seam; no settings migration |
| N16 | A boundary test instead of a lint-config edit keeps telemetry-core free of Node.js, Electron and React |

ET-010b implementation update on October 15, 2026: the main window shows the complete protocol v0 live field set in a **Live telemetry** card built from telemetry-core's view model, with labels, reasons and notes from the application strings ([dashboard rules](docs/live-telemetry-fields.md#dashboard)). The coordinator adopted the following decisions under the owner's delegation; the owner did not review them individually.

| # | Decision |
| --- | --- |
| B1 | Speed and fuel stay in the existing `Speed: …` and `Fuel: …` lines and are not repeated in the card |
| B2 | New rows are label and value pairs (`<dt>`/`<dd>`); the N6 `<Label>: <text>` wording keeps applying to the existing speed and fuel lines |
| B3 | A reason is a sibling element `live-<id>-reason` and a note `live-<id>-note` |
| B4 | No React component tests (no jsdom or Testing Library); the card is a thin map over a tested pure builder, checked end to end by the runtime smokes |
| B5 | The card uses the same game and profile rule as the speed and fuel lines; under "Select a game" the units are metric while the ATS note may follow the source game |
| B6 | Smoke checks of card rows below the fold require one visible element with a non-empty box but no viewport intersection or scrolling; the existing speed and fuel checks keep their viewport requirement |

ET-010b changes no telemetry-core, contracts, wire, fixtures, preload/IPC, overlay, storage or receipt code, and makes no game, TruckersMP, display or performance claim; see [ET-010 validation](docs/validation/et-010.md#et-010b-dashboard).

## ET-006b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-006b (protocol v1 ingestion in the telemetry service) and adopted the architect's recommendations E1–E14 below. They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner; the owner may revise them. For ET-006b only, this supersedes the earlier statements that ET-006b remains unauthorized; earlier dated text is unchanged. ET-004b and ET-005b are merged but not owner-accepted, and their real-game checks remain pending. ET-014, ET-015a, ET-015b, ET-015c, ET-010c and later phases are not authorized by this section. No game, TruckersMP or performance claim follows from synthetic or local tests. The ingestion is described in the telemetry service v1 ingestion guide (`docs/telemetry-service-v1.md`, added by ET-006b PR-1); checks are in ET-006b validation (`docs/validation/et-006b.md`, added by ET-006b PR-1); the broker checks are in [ET-006b broker validation](docs/validation/et-006b-broker.md).

| # | Decision |
| --- | --- |
| E1 | Boundary with ET-015a: ET-006b delivers `V1Ingestion`, the `DurableDelivery` pipeline and a `DurableSink` interface with a real `StorageDurableSink` over `StorageClient` (`upsertSession`, `commitEvent`/`commitGap`, `committedThrough`) and an optional effects hook that supplies none by default. The durable path is proven only against temporary synthetic-purpose databases; production sends `durableEvents: false` with no sink. Rejected: committing to history now with empty effects (effects apply on first insert only, recording would start before ET-015a and the v0 retirement, history accepts only game origin), and an interface with only a fake (no proof of an ACK after a real commit) |
| E2 | Live path: v0 stays the only dashboard and overlay source. v1 runs beside it with service-internal `V1SourceState` (status, reason, latest checkpoint or snapshot and its receive time, hydration, source status, continuity, clock mapping, last `end`, durable status `off`, `pending`, `active` or `failed` with a code). No preload, IPC or renderer change; ET-010c exposes it and the v0-retirement PR switches the live path |
| E3 | Service policy (OD-2): the existing broker bootstrap policy runs in v1 mode with `--discovery-dir %LOCALAPPDATA%\ETS2Telemetry\transport\v1`, with the v0 schema, lock, protected temporary file, `MoveFileExW` replacement and no replacement of identical bytes. It is written only when the plugin already created `transport\v1`; otherwise the broker exits 2 (waiting). Tests use temporary directories only. Rejected: writing the policy from Node |
| E4 | Broker v1 mode: `--protocol v1` (excludes `--capture`), records with `protocolMajor` 1 and the v1 pipe name, unchanged collision, peer and image checks; the receipt adds `"protocolMajor":1`; the hello is checked with the C++ v1 negotiation; tagged stdin control (`0x01` one credit, `0x02` plus a length of 1–4,096 and one `ack` or `clock.probe` client frame) written in order with its own overlapped I/O and a 5 s deadline; v0 and CAP0 modes unchanged. Rejected: Node connecting straight to the game pipe (no authoritative peer identity) |
| E5 | Credits and backlog: a credit returns after synchronous decode, validation and live application, never after a commit. Commits run in one FIFO across connections with one storage command in flight and at most 256 pending; an overflow closes the connection as retryable and the producer redelivers. Rejected: credit after commit (10 s storage deadline against the plugin's 1 s write deadline) |
| E6 | Cursor: at each welcome, after earlier queued commits drain, `openSession` returns stored coverage C and a new `DurableAckCursor(pluginSessionId, C)` starts; the checkpoint's A begins the connection. After every commit storage coverage must equal the cursor's, else `COVERAGE_MISMATCH` fails durable delivery without an ACK. A > C disables durable delivery for that plugin session (`ACK_AHEAD_OF_STORAGE`) and the service reconnects live-only; ET-015a defines restore-loss |
| E7 | Commit results: `committed`, `duplicate` and `covered` commit the range in the cursor; `conflict` keeps the stored row, counts as committed and is logged with a coalesced count. Retryable (`DISK_FULL`, `IO_ERROR`, `DATABASE_LOCKED`, `STORAGE_BUSY`): no ACK, close, reconnect on backoff. Every other storage code, including `WORKER_FAILED` and `TIMEOUT`: durable delivery unavailable for the service lifetime, reconnect live-only, `V1_DURABLE_UNAVAILABLE {code}` logged once and the failure visible in `V1SourceState` |
| E8 | ACK writes: `cursor.ack()` is written only while the connection that received the coverage is current, open and before `end`. A commit finishing after a disconnect or `end` writes nothing; the next connection acknowledges again after redelivery |
| E9 | Reconnect: backoff 250, 500, 1000, 2000, then 4000 ms, reset by a hydrated checkpoint. A broker exit at its startup deadline, or exit 4 before any receipt, waits and retries. A schema, order or identity violation is incompatible until the user selects a source again. `end` disconnects and retries; a retired session then finds no discovery record. Freshness is 500 ms on the service receive clock. Every envelope must match the broker receipt (game, process, sessions, process instance, origin `game`); a fixture source must match the selected origin |
| E10 | Clock probes: one per second after the checkpoint, registered with `expectClockReply` before the write; an injectable client clock (default `process.hrtime.bigint`) with one UUID per service; the mapping comes from `computeClockMapping`. A late reply gives no mapping, and no new probe is sent until it arrives. The mapping stays in the service |
| E11 | Three PRs: PR-1 (ingestion and ACK pipeline) and PR-2 (broker v1 mode) independent from `main`; PR-3 (service wiring) after both merge. PR-1 and PR-2 code is unused in production until PR-3 |
| E12 | The v1 discovery directory is derived from the validated v0 broker configuration (basename `v0` under a `transport` parent becomes the sibling `v1`); main and the main-to-service message stay unchanged |
| E13 | No v0 refactor: the v0 `TelemetryIngestion` is untouched |
| E14 | Chain test: a fake-SDK host loads the test DLL with a v1 directory seam and the real broker in v1 mode runs against it; it proves that the plugin accepts the broker-provisioned policy and that ACKs relay and release entries, and that V1Ingestion with a game selection fails closed on the test DLL's synthetic origin under game authority |
