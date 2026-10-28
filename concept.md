# ETS2Telemetry: Project Concept and Requirements

Concept recorded on: October 10, 2026.

ET-012 closeout disposition, October 22, 2026: the owner accepted the four display corrections and 200% mouse-release
behavior on the c6d70e4 ETS2 preview, without individually accepting all layouts or the full game matrix. The owner
separately authorized administrative Done and consolidation of the remaining seven rows and P2/A2/A3/A7/M1–M8/E4
in [ET-044](https://trello.com/c/ucJbXIEH), **unverified**; ET-042/ET-043 transfers retain their existing scope/status.
This supersedes earlier ET-012 manual-gate/Review wording without changing historical outcomes. Independent round 9
passed all 39 local commands / 21 journeys on 722938c9; Claude's four nonblocking notes have recorded dispositions.
Current independent review, final automatic Ready CI and authorized squash merge remain pending PR gates. No release
or real-history enablement follows. See
[ET-012e validation](docs/validation/et-012e.md) for exact identities, limits and pending CI snapshot.

ET-011 closeout authorization, October 22, 2026: the owner requested resolving local failures, independent review,
final automatic Ready CI and squash merge of PR #167, then closing ET-011. Narrator, real-game unit profiles and
close-to-tray overlay continuity transfer **unverified** to [ET-043](https://trello.com/c/2fbiCET0). Installed shortcut
and update checks retain their ET-018 deferral; monitor/mixed-DPI checks remain ET-042. Dated pending statements below
retain their historical scope. Actual code gates and Windows evidence are in [ET-011 validation](docs/validation/et-011.md).

ET-009 owner acceptance, October 20, 2026: the [prototype closeout](docs/validation/et-009.md) records the
accepted functional matrix, indicative latency and performance with their explicit exceptions and limits.
Monitor/mixed-DPI/removal checks moved to ET-042 and remain unverified. The [opt-in measurement procedure](docs/validation/et-009-latency.md)
correlates v0 speed/fuel captures with Chromium marker readbacks; it does not establish physical-screen
latency or a universal 200 ms guarantee. The diagnostic PR's review/CI/merge gates remain separate.

Status updated October 11, 2026: ET-001 scaffold implemented and its native Windows installer/packaged-worker criteria verified. All six actual lifecycle operations exited normally; acceptance includes a separate corrected uninstall residue evaluation and exact owned cleanup, preserving the original failed wrapper report. The package passed installed SQLite/security/startup/shutdown probes. Independent whole-PR review found no actionable source issues; the final documentation delta is reviewed separately. An earlier native Playwright launch timeout remains unexplained flakiness. No integration has been tested in a running game. ETS2Telemetry is the working project name. See [Windows setup](docs/setup.md) and [the validation record](docs/validation/et-001.md) for exact identities and limits. ET-022 and SP-01 become eligible after the accepted scaffold PR is merged.

Repository setup update on October 10, 2026: local `main` tracks the existing history at `https://github.com/senukartur/ets2telemetry.git`. Git for Windows 2.55.0.windows.5 and GitHub CLI 2.102.0 are installed. GitHub CLI is authenticated as `senukartur` and provides Git's HTTPS credentials. Fetch, a fast-forward-only pull, and the initial documentation push succeeded. The published documentation includes this concept, `AGENTS.md`, and `README.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`. Use Git for commits, branches, and synchronization, and GitHub CLI for GitHub operations. This setup does not establish an application build toolchain or game compatibility.

Development uses lightweight GitHub Flow: short-lived task branches, PRs targeting `main`, relevant validation and owner review, and squash merging. Detailed working rules are in `AGENTS.md`. GitHub is configured for squash merging and automatic deletion of merged branches. The server-side `Protect main` ruleset and a local pre-push hook guard `main` ([branch protection](AGENTS.md#branch-protection--october-16-2026)). ET-022 now defines [Windows CI](docs/ci.md) after the scaffold; clean hosted and deliberate failure/restoration evidence is recorded in [ET-022 validation](docs/validation/et-022.md); final current-head checks, independent review and owner merge remain required.

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
- Visual design will be discussed separately. Correct data acquisition and storage are the current priorities. Design target update on October 19, 2026: the owner-approved desktop and overlay design in the Yukon Union style is specified in [docs/design](docs/design/README.md); it changes no requirement in this concept.
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

The owner authorized the coordinator to squash merge PR #10 (ET-003), #12 (ET-004a) and #14 (ET-007) without further confirmation once agreed actionable review findings are resolved and the required final Windows CI passes, and directed their corresponding Trello cards to Done. PR #10 was merged as `85d9f83a763f1ca71c2d640dadc5d8fbf2d9e69b` after its exact-head CI and independent review. Integrate accepted main and verify the final candidate before each subsequent merge. This is an explicit administrative status/code-review exception: mandatory game, environment, CAP-01 and performance evidence, SP-01 windowed retry/Convoy, and ET-004b remain pending and are not accepted or implemented by that status. No compatibility, protocol-v1, durable-history or later-phase authorization follows. Keep every missing check visible in the card and ledger. Advisory AI-review execution failures were non-gating; mandatory independent review and Windows checks remain required.

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
| CD-7 | Minimized, tokenized fixtures derived from CAP-01 may be committed with provenance; lossy captures are rejected and raw or sanitized exports stay local. Explicitly approved by the owner on October 21, 2026, superseding the earlier fixture-publication deferral ([CAP-01a validation](docs/validation/cap-01a.md)) for minimized derived fixtures only. Original captures and sanitized exports remain local; PR-3 lands last |
| CD-8 | Game mode is `unknown` by default (OD-3); a synthetic override exists only to exercise D9 |
| CD-9 | Currency status is chosen per scenario: `unknown` or the SDK-documented EUR or USD |
| CD-10 | In pipe mode, events, gaps, checkpoints and `end` are byte-identical to replay, snapshots equal in state and continuity, and clock replies are checked separately |
| CD-11 | Retention runs in scenario time; pipe mode fast-forwards offline segments |
| CD-12 | A system suspend is modeled both with and without the source clock advancing |

## ET-013 authorization — October 15, 2026

The owner authorized ET-013 (the SQLite storage worker and schema) on October 15, 2026, in parallel with ET-004b PR C, granted the coordinator merge authority after independent review and a successful final Windows CI, and delegated the ET-013 design decisions to the coordinator. The coordinator adopted the architect's recommendations OD-1 to OD-10 as coordinator decisions under owner delegation; [storage](docs/storage.md#decisions-october-15-2026) records them with the schema, durability, migration and backup rules. For ET-013 only, this supersedes the October 14, 2026 statements that ET-013 remains unauthorized; earlier dated text is unchanged. ET-014, ET-015a, ET-015b, ET-015c, ET-006b and ET-016 remain unauthorized by this paragraph; ET-005b is authorized separately in the paragraph above. The desktop application stays on protocol v0, records nothing and sends no ACK. The §7 storage estimate remains a model until ET-013 PR-2 measures the actual schema. No game, TruckersMP or performance claim follows from this authorization or from synthetic storage tests.

ET-013 PR-2 implementation update (October 15, 2026): the telemetry service runs the storage core in its storage worker, opens `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite` at start without blocking live telemetry and closes it in the `storage` shutdown phase; killed-process and worker-failure tests and a measured 53.4 MB per 100 hours are recorded in [ET-013 validation](docs/validation/et-013.md); nothing is recorded or acknowledged yet.

## ET-011 authorization — October 15, 2026

Closeout authorization, October 22, 2026: the owner authorized resolving local verification failures, independent
review, final automatic Ready CI and squash merge of PR #167, followed by ET-011 closure. Narrator accessibility and
remaining real-game unit-profile/close-to-tray overlay checks transfer **unverified** to
[ET-043](https://trello.com/c/2fbiCET0); installed shortcut/update checks retain their ET-018 deferral. Corrected
Windows sign-out and actual restart passed in separate isolated synthetic sessions. The native regression correction
follows the existing pending-start policy and mandatory-join/measured-target contract; no product deadline, protocol,
storage schema, game-history enablement or release scope changes. Historical failures are retained, and this decision
does not assert the PR's remaining gates or transferred checks already passed. See [ET-011 validation](docs/validation/et-011.md).

Windows session-end correction, October 21, 2026: pinned Electron immediately terminates main after confirmed native
`session-end` listeners, so C6's normal asynchronous supervisor completion cannot be guaranteed at that OS boundary.
The owner requested diagnosing/fixing the lost audit and preparing a repeat manual check. Confirmed end now enters
synchronous bounded logging before the same lifecycle request, removes the tray immediately and records the truthful
`WINDOWS_SESSION_END_HANDOFF` boundary. It never invents completed service/app exits, stops on a cancellable query or
vetoes Windows shutdown. Ordinary exit budgets remain unchanged. Actual service/storage completion and real Windows
acceptance remain independently evidenced, as [the lifecycle](docs/app-lifecycle.md#windows-terminal-session-boundary--october-21-2026)
and [validation](docs/validation/et-011.md) describe. This is a diagnostic correction, not an OS-lifecycle policy change.

Closeout instruction, October 21, 2026: the owner requested Review status, card reconciliation and
completion of unattended follow-ups before manual checks together. This includes diagnosing the
historical launcher close timeout and the approved source-selection logs. Main records fixed
`SOURCE_SELECTED`/`SOURCE_SELECTION_RETIRED` dispatch facts with `startup`/`user`/`restore` origin;
the logs do not prove connection, capture binding or recording. Exit observation keeps the existing
eight-second operation and 60-second smoke Job bounds and distinguishes app logs, launcher termination,
stdio closure and Playwright teardown. The original saturated-host cause remains unproven. The
[closeout record](docs/validation/et-011.md) reconciles merged packages and later evidence while
retaining manual Windows/game acceptance. No product architecture, wire, history or release scope
changes.

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

Settings late read fix on October 15, 2026 (hosted run 38755116140): a startup settings read that outlasts the 1000 ms load budget no longer leaves the session read-only. The first windows open with defaults in the read-only `loading` state, saves are refused while the read is pending, and the same read's result (state, writability and units) is applied and pushed to the dashboard and overlay when it settles. A read error stays `unreadable`, and a read still unsettled about 30 s after the start is treated as hung (`unreadable`, its later result ignored). This is a coordinator decision under the owner's delegation; nothing is written at startup and the C10–C12 guarantees are unchanged. See [settings](docs/settings.md#load-states).

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

ET-010c implementation update on October 15, 2026: the dashboard and ET-012a's overlay sections show the live fields only protocol v1 carries, from a whitelisted v1 projection attached to the existing live update ([dashboard rules](docs/live-telemetry-fields.md#dashboard), [overlay section states](docs/minimal-overlay.md)). The coordinator adopted the following decisions under the owner's delegation; the owner did not review them individually. F4 and F7 were revised after ET-012a merged.

| # | Decision |
| --- | --- |
| F1 | Transport: an optional `v1` field on `LiveTelemetry` through the existing service, main and renderer stream (up to 20 Hz), reusing selection gating, invalidation and port recovery. No new channel or bridge key |
| F2 | Projection and authority: `liveV1Projection` whitelists selection, status, reason, freshness and the observation (source, sequence, capture, state without the window, game mode, event loss, receive time, hydration). It omits the window handle, clock mapping, last `end`, durable status, delivery cursor and continuity. Main and preload validate it with `parseLiveV1`, which never throws; main forwards an invalid or mismatched `v1` stripped and logs `LIVE_V1_REJECTED` at occurrences 1, 2, 4, 8… |
| F3 | Freshness: v1 expires on its own after 500 ms in the service, in main (`LiveFreshness`) and in the preload; neither protocol renews the other. A selection change, failure or restart clears v1 |
| F4 | Display, through the shared pure combiner `live-sources.ts` used by the card and the overlay: (a) each row has one source; rows v0 carries stay on v0, so the ET-010b output is byte-identical without v1. (b) Job guard: v1 job fields (source city and company, destination company, cargo mass, market, special job, cargo loaded, deadline) count only when v0 has a job and v1's cargo and destination city ids equal v0's; a mismatch shows them as not current, no v0 job hides them; route remaining, plate, trailers, position and heading are not guarded. (c) With a current v1 observation of the same job, cargo and destination city show v1's names for the same ids. (d) Paused is v0's flag while v0 is current, otherwise v1's while v1 is current. (e) v1 is current only when its origin and game equal v0's observation, whenever v0 has one; otherwise its rows are hidden |
| F5 | A **Protocol v1 source** section shows the v1 status and reason, game mode and lost events (noting that this version records no gameplay events) |
| F6 | telemetry-core `buildLiveView` and `isCurrent` accept a structural source type; no behaviour change |
| F7 | Overlay: main's `overlayPresentation` takes section parts from the combiner. Origin, distance remaining and the deadline come from v1, the destination adds v1's company and the cargo v1's mass; speed, gear, RPM, fuel, range, SDK consumption, expected income and game time stay on v0. A v1 part shows a value only while the overlay is current, v1 is current and, for job parts, the jobs match; otherwise ET-012a's L5 rule applies, and without a v0 job the job sections are left out. The overall state, freshness, dimming and tags stay v0's; v1 never authorizes placement or visibility, and the renderer receives only formatted text |
| F8 | The telemetry runtime smoke serves synthetic v1 (`scripts/ci/live-smoke-source-v1.mjs`) beside the v0 source, with the cargo and destination city ids aligned to the v0 fixture in memory, and checks the card and the overlay's v1 sections |
| F9 | v1 rows use the card's per-game units |
| F10 | IPC: no new channel or bridge key; the payload gains the validated optional `v1`. For ET-010c only this supersedes N4's "no bridge, preload or IPC change" |
| C1 | For ET-010c, ET-012a L7's statement that the bridge carries v0 only is superseded; `LiveTelemetry` still never reaches the overlay renderer |
| C2 | F4(c) is adopted: v1's localized names replace game ids for the same job |
| C3 | ET-012a's and ET-012b's geometry and styles are kept. Review found that with v1 the default Strip kept only seven of twelve sections visible. On the owner's decision of October 16, 2026, ET-012c (PR #76) fixed this first. With v1 the strip now keeps all twelve sections inside its 1280×110 window, and the telemetry smoke asserts it. The Card, HUD and Cluster are measured for review only. The Card fits and cuts off long origin, destination and income values; the HUD fits; the Cluster clips game time. The Cluster is a non-default layout and is fixed in the follow-up package ET-012d after ET-010c merges |
| C4 | Section marker strings only: `protocol-v1` reads "needs the plugin's protocol v1 data", `ids-until-v1` "shows game ids without protocol v1"; the section requirement map is unchanged |
| C5 | The field documentation drops "without an overlay change" for v1 fields |

ET-010c changes no wire, storage, recording, overlay preload, layout, geometry, settings or overlay IPC, and makes no game, TruckersMP, display or performance claim. Whether the real plugin reports the same job ids in v0 and v1, the cost of the second normalization, and long-name readability in each layout remain pending; see [ET-010 validation](docs/validation/et-010.md).

ET-045a truck name, October 24, 2026: at the owner's ET-045 request the truck row extends F4(c). While both sources are current, both truck readings have a value and v1's truck model id equals v0's `truckId`, it shows v1's SDK brand and name (else name, else id) instead of the model id. Presence and currentness stay v0's, and there is no id-to-model mapping table, so an unrecognized id is never given an invented name. The F4 and C2 text above is unchanged.

## ET-006b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-006b (protocol v1 ingestion in the telemetry service) and adopted the architect's recommendations E1–E14 below. They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner; the owner may revise them. For ET-006b only, this supersedes the earlier statements that ET-006b remains unauthorized; earlier dated text is unchanged. ET-004b and ET-005b are merged but not owner-accepted, and their real-game checks remain pending. ET-014, ET-015a, ET-015b, ET-015c, ET-010c and later phases are not authorized by this section. No game, TruckersMP or performance claim follows from synthetic or local tests. The ingestion is described in [the telemetry service v1 ingestion](docs/telemetry-service-v1.md); checks are in [ET-006b validation](docs/validation/et-006b.md).

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
| E9 | Reconnect: backoff 250, 500, 1000, 2000, then 4000 ms, reset only when a connection proves healthy: a live-only connection at its hydrated checkpoint, a durable connection at its first successful commit (PR-1 review fix), so a persistent retryable storage failure keeps backing off. A durable connection that stays open but commits nothing keeps the current step, which costs only reconnection latency. A broker exit at its startup deadline, or exit 4 before any receipt, waits and retries. A schema, order or identity violation is incompatible until the user selects a source again. `end` disconnects and retries; a retired session then finds no discovery record. Freshness is 500 ms on the service receive clock. Every envelope must match the broker receipt (game, process, sessions, process instance, origin `game`); a fixture source must match the selected origin |
| E10 | Clock probes: one per second after the checkpoint, registered with `expectClockReply` before the write; an injectable client clock (default `process.hrtime.bigint`) with one UUID per service; the mapping comes from `computeClockMapping`. A late reply gives no mapping, and no new probe is sent until it arrives. The mapping stays in the service |
| E11 | Three PRs: PR-1 (ingestion and ACK pipeline) and PR-2 (broker v1 mode) independent from `main`; PR-3 (service wiring) after both merge. PR-1 and PR-2 code is unused in production until PR-3 |
| E12 | The v1 discovery directory is derived from the validated v0 broker configuration (basename `v0` under a `transport` parent becomes the sibling `v1`); main and the main-to-service message stay unchanged |
| E13 | No v0 refactor: the v0 `TelemetryIngestion` is untouched |
| E14 | Chain test: a fake-SDK host loads the test DLL with a v1 directory seam and the real broker in v1 mode runs against it; it proves that the plugin accepts the broker-provisioned policy and that ACKs relay and release entries, and that V1Ingestion with a game selection fails closed on the test DLL's synthetic origin under game authority |

ET-006b PR-3 implementation update (October 15, 2026): per E2, E12 and E14 the service connects to the plugin's v1 endpoint through the broker's v1 mode, live-only and without a durable sink; v1 state stays service-internal and is logged only as fixed codes. A game selection now runs two broker processes, one per protocol. The controlled chain test is synthetic; real-game, TruckersMP and performance evidence remain pending ([ET-006b validation](docs/validation/et-006b.md#pr-3-service-wiring)).

## ET-012a authorization — October 15, 2026

On October 15, 2026 the owner reviewed HTML mockups and approved ET-012a: selectable overlay layouts (Strip by default, Card, Cluster and Minimal HUD) and fourteen toggleable overlay sections, configured in the desktop application's settings (settings format v2). The IPC and settings-format changes below are covered by that explicit approval together with the owner's standing autonomy of October 15, 2026. The coordinator adopted the architect's decisions L1–L15, with L5 as amended by the coordinator; they are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. ET-012a changes no protocol wire, fixtures, native code, broker, SQLite schema, trip logic or service, exposes no protocol v1 state to the overlay, and makes no game, TruckersMP, display or performance claim. ET-012b (overlay editing) is separate. See [the minimal overlay](docs/minimal-overlay.md#layouts-and-sections-et-012a), [settings](docs/settings.md#overlay-settings-et-012a) and [ET-012a validation](docs/validation/et-012a.md).

| # | Decision |
| --- | --- |
| L1 | One PR for ET-012a; overlay editing and dragging are ET-012b |
| L2 | Settings format v2 with an `overlay` block (`layout`, `sections` with all fourteen keys), a pure v1-to-v2 migration that adds the defaults, per-field fallbacks (`overlay.layout`, `overlay.sections`, `overlay.sections.<id>`) and no startup write. An ET-011b build reads v2 as `newer-version` (read-only); this downgrade behaviour is accepted |
| L3 | Two narrow IPC channels, `settings:set-overlay-layout` and `settings:set-overlay-sections`, validated in the preload and again in main; sections always travel as a complete strict record with at least one section enabled. No generic settings patch |
| L4 | The overlay projection is built in main from the normalized state and telemetry-core's view model; the overlay renderer only arranges formatted strings |
| L5 | Section states: a disabled section or one the protocol in use does not carry is absent. While current, a section with a value shows it and one without data is absent, except speed and fuel, which keep `unavailable` (a dash) as the ET-008 baseline and REG-009 evidence. While not current, the projection keeps the shape of the one main published last: each still-enabled section it showed, plus speed and fuel, is `unavailable`, and hidden sections stay hidden (amended after the advisory review of PR #70 so the layout does not jump) |
| L6 | ET-010 N6 applies to the overlay: no last-known values. A non-current overlay dims its placeholders and icons; tags show Paused, No signal and a Synthetic or Replay origin |
| L7 | No protocol v1 exposure: the bridge still carries v0 only, so origin, distance remaining, the deadline, cargo mass and company names stay hidden until ET-010c and the v0 retirement. `LiveTelemetry` never reaches the overlay renderer |
| L8 | Distance driven needs trip accounting (ET-014) and stays hidden; the odometer is never a stand-in (REG-008) |
| L9 | The legacy `speed`, `fuel`, `speedUnit` and `fuelUnit` projection fields stay, so the overlay smoke contract and receipt keep their values |
| L10 | Per-layout geometry in DIP inside the game's client area: strip `min(1280, width − 32)` × 38 at the top centre, card 300 × 360 at the top right, cluster 440 × 220 at the bottom left, HUD 320 × 320 at the top left, 16 DIP margins (8 above the strip); a layout that does not fit hides the overlay |
| L11 | The overlay window is created at the saved layout's nominal size; a layout change re-places it from the last observation without renewing freshness and re-asserts topmost without activation when it moves. A hidden overlay is never raised |
| L12 | The RPM ring uses a fixed 0–3000 rpm display scale because neither v0 nor v1 carries the SDK's `rpm.limit` |
| L13 | The dashboard Overlay card uses shadcn components: a layout radio group, one switch per section grouped Driving, Fuel, Job and Time with markers for sections that need protocol v1 or trip tracking, and the presets Everything, Job focus and Driving only. It shows only saved values, and the last enabled section cannot be switched off |
| L14 | No React component tests (as ET-010b B4): the renderer and card are thin maps over tested pure modules, checked end to end by the runtime smokes |
| L15 | The overlay smoke reads its state from `overlay-root` data attributes and separate speed and fuel unit elements, and adds a final layout-switch step; the receipt shape and `RuntimeReceipt.ps1` are unchanged |

## ET-014 authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-014 and adopted the architect's decisions T1–T20 below. They are coordinator decisions and were not individually reviewed by the owner. ET-014 adds a pure, deterministic trip reducer in `packages/telemetry-core` that turns committed protocol v1 events and gaps, session changes, checkpoint hydration and normalized readings into the existing storage `TripEffect` contract; ET-015a wires it into commits. Behaviour seen in real traces rests only on the reviewed CAP-01 observations O1–O11; everything else is labelled synthetic inference and stays pending until real-game sessions. See [trips](docs/trips.md).

| # | Decision |
| --- | --- |
| T1 | Two PRs: the event-driven lifecycle reducer, then readings accounting with simulator replay |
| T2 | Code in `packages/telemetry-core/src/trips`; the boundary test allows a type-only import of `packages/storage/src/api.ts` |
| T3 | A pure step; the caller adopts the new state only after storage reports `committed`, `duplicate`, `covered` or `conflict`, and keeps the old state on a retryable or failed commit (ET-015a replaces the synchronous effects hook) |
| T4 | Trip ID = SHA-256 of `ets2telemetry-trip-v1:` + plugin session + configuring `eventSeq`, shaped as a UUID; a pure TypeScript SHA-256 checked against NIST vectors and `node:crypto` |
| T5 | Per-session processed point: duplicates are no-ops, gaps apply only their suffix, a skipped `eventSeq` or coverage mismatch fails closed |
| T6 | Job identity is every `job.configured` field except `cargoLoaded` (O3) |
| T7 | `job.cleared` waits for an outcome; truck/trailer, pause/start, fines, tolls, transfers and game mode may intervene (O7); a different job, timer restart, regression, gap or session change disqualifies |
| T8 | Save load (O10): clear plus an identical re-send (including the same `cargoLoaded`; a different value closes the trip and opens a new one with a reload continuation) waits for the first decisive event; a game-time regression continues the trip as partial; a clear returns to waiting; a different job closes it and opens a trip from that event; an outcome closes it and opens nothing (attributed ambiguous); other decisive events close it and open an ambiguous continuation. See [trips](docs/trips.md) for the PR-1 interpretations |
| T9 | Hydration never opens, closes or attributes a trip. A job shown by a checkpoint is untracked from the checkpoint's next event on (retained events replayed before it are ordinary stream events); it ends with a clear, an outcome, a new trip, a later checkpoint or a new plugin session, and an identical later `job.configured` opens a partial trip (`late-attach`) |
| T10 | A gap while a trip is open closes it as partial and records a `not-connected` or `event-loss` interval |
| T11 | A new plugin session closes the previous session's open trip as `restart`; identical jobs are not merged |
| T12 | A job configured during a load (before the session's first start, or after a timer restart and before the next start) opens partial (inference from O1); a game-time regression does not start a load |
| T13 | Trips open `unknown`, become `partial` on any loss or ambiguity, and become `complete` only on an outcome close with a clean window; annotations do not downgrade |
| T14 | Exactly one attribution per gameplay event: `trip`, `trip-before-loaded`, `free-driving` (no job known or likely active) or `ambiguous` (including fines, tolls and transfers while a late-attached or gap-closed job is still untracked) |
| T15 | Real duration from monotonic time within one session; UTC is a label and an end before the start is clamped and annotated; game time only within one game clock |
| T16 | Observed distance and fuel used from continuous steps only; refuels reported separately; nothing bridged across a connection hole |
| T17 | Provisional named thresholds for game-time jumps, crossings, position jumps and reading holes |
| T18 | At most 16 effects per commit; annotations merged, capped and deferred |
| T19 | No storage change; gaps S-1 (fuel-used column), S-2 (late-attached job trips), S-3 (effects hook), S-4 (continuation in detail JSON) go to ET-015a or ET-016 |
| T20 | Every test case is tagged with its evidence basis: O1–O11, the October 13–14 decisions, or synthetic inference; no capture bytes are committed |

ET-014 PR-2 implementation update (October 15, 2026): readings accounting per T16 and T17, with the optional `TripSeed.observedDistanceM` so a resumed trip keeps its stored distance, and the interpretations listed in [trips](docs/trips.md) ("PR-2 interpretations of the plan"). Provisional T17 values: a game-time jump is at least 30 game minutes at more than 60 game minutes per real minute, measured from the previous reading and over a 60 s window of readings, and is labelled a crossing when a ferry or train event lies within 300 s before it or during it; an annotated jump grows only by an advance faster than that rate over at least 1 s of real time since its last growth; a position jump uses a 50 m margin over 100 m/s; a reading hole is 5 s of running simulation between readings, split by the stream's simulation states. A resumed trip whose job was cleared (`TripSeed.awaitingOutcome`) awaits its outcome and counts no distance. Fuel used stays in the trip view until storage gap S-1 is resolved.

## ET-012b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-012b, the overlay edit mode with persisted position and scale (the "explicitly enabled configuration mode" and the persisted position and scale of §6), and adopted the architect's decisions M1–M13 below. They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. ET-012b moves the settings file to format v3; an ET-012a build reads a v3 file as `newer-version` (read-only defaults). It changes no protocol wire, fixtures, native code, broker, SQLite schema, trip logic or service, and makes no game, TruckersMP, display or performance claim. Persisting an overlay visibility setting, also listed in §6, is not part of ET-012b and stays open on the ET-012 card. See [the minimal overlay](docs/minimal-overlay.md#edit-mode-et-012b), [settings](docs/settings.md#overlay-placements-and-edit-mode-et-012b) and [ET-012b validation](docs/validation/et-012b.md).

| # | Decision |
| --- | --- |
| M1 | One PR with the edit mode and per-layout persisted position and scale. No preview while the game is minimized (the dashboard says it is waiting for the game window) and no visibility on/off setting. Multi-monitor, mixed-DPI, monitor-removal and off-screen recovery stay deferred; a saved placement is always clamped into the current client area by construction |
| M2 | Settings format v3: `overlay.placements` holds all four layouts in canonical order (strip, card, cluster, HUD), each `{x, y, scale}`. A pure v2-to-v3 migration adds the defaults (v1 chains through v2; `migratedFrom: 1` or `2`). Fallback paths `overlay.placements` (missing or not an object, also when the overlay block is not an object) and `overlay.placements.<layout>` (`x` or `y` not a finite number in [0, 1], or `scale` not one in [0.5, 2]); an out-of-range value falls back and is never clamped. `x` and `y` are rounded to four decimals and the scale to two, when read and written. No startup write; quarantine, read-only newer versions, atomic saves and the four-request bound are unchanged. An ET-012a build reads v3 as `newer-version` (accepted, as L2). An optional key in v2 was rejected |
| M3 | Representation: `x` and `y` are fractions of the free space inside the client area minus the margins (16 DIP; the strip 16 horizontally and 8 vertically): `left = round(cx + mx + x × (cw − 2mx − w))`, `top = round(cy + my + y × (ch − 2my − h))`. The defaults strip `{0.5, 0, 1}`, card `{1, 0, 1}`, cluster `{0, 1, 1}` and HUD `{0, 0, 1}` reproduce the L10 anchors exactly. The inverse clamps to [0, 1]; an axis without free space keeps the previous fraction |
| M4 | Scale in [0.5, 2]. Card, cluster and HUD are `round(nominal × scale)`; the strip is `floor(min(1280 × scale, cw − 32))` wide, at least `round(480 × scale)`, and `round(38 × scale)` high, and needs `ch ≥ 16 + height`. The content scales through the overlay document's zoom factor, set only by main at construction (`webPreferences.zoomFactor`, window size nominal × scale), on every scale change and after each overlay load. The overlay's own `ets2telemetry-overlay` session keeps that zoom away from the dashboard. Nothing shrinks automatically: a scaled layout that does not fit hides, and edit mode reports it as `too-large` |
| M5 | The edit mode lives in main's memory only and is never saved; every start is in driving mode. It is entered only from the trusted dashboard while settings are writable and the application is not exiting. Done or Enter saves; Cancel or Esc discards. It is cancelled without writing when the dashboard closes to the tray, is minimized or its document is retired, when the overlay's subscription or document is retired, and when the exit begins. While it is active the driving overlay stays hidden over the game until Done or Cancel; cancelling on minimize (added after the independent review) keeps a user who minimizes the dashboard and drives from losing the overlay for the whole drive. `settings:set-overlay-layout` is refused with a fixed message while editing; unit and section saves stay allowed |
| M6 | Visibility gate: `visibleGameClientBounds` applies the `currentGameClientBounds` checks without the foreground. The edit overlay shows only with a placement input, a loaded overlay, a window report newer than the last monitor change, bounds inside a display, an own window in front (the dashboard or the overlay `isFocused()`) and the game not in front. A gain of own focus counts at once, a loss after `OWN_FOCUS_GRACE_MS` = 150 ms, because the dashboard blurs before the overlay gains focus on a click; a pure class with injected timers |
| M7 | The overlay is interactive only while shown in edit mode. Show order: `setIgnoreMouseEvents(false)`, `setFocusable(true)`, `setSkipTaskbar(true)`, `setMovable(true)`, zoom and bounds, `showInactive()`, topmost re-assertion. Every hide and exit: `hide()` first, then `setMovable(false)`, `setIgnoreMouseEvents(true)`, `setFocusable(false)`, `setSkipTaskbar(true)`. Never `show()` or `focus()`. `setSkipTaskbar(true)` is needed because Electron 44.7.0 on Windows implements `SetFocusable` with `SetSkipTaskbar(!focusable)`. Driving paths make no interactive call |
| M8 | Dragging: while editing, the overlay root gets `app-region: drag`, `pointer-events: auto`, a move cursor, a dashed outline and a translucent fill over the whole box; the window is not movable outside edit mode. Main listens to the overlay's `will-move` (a moving flag; no `setBounds` while moving) and `moved`: it reads `getBounds()` in DIP, converts it into clamped fractions in the draft and re-places (snaps) the window. The flag clears on every hide and on leaving edit mode. Clamping happens at the end of the drag only |
| M9 | Overlay input: `before-input-event` is always prevented; in edit mode an Enter key-down saves and an Escape key-down cancels. `system-context-menu` is always prevented. The existing close refusal still covers Alt+F4 |
| M10 | Four fixed-shape invoke channels, validated in the preload and in main, from the trusted dashboard main frame only (the overlay is rejected): `overlay-edit:begin` () → `OverlayEditState`; `overlay-edit:set-scale` (one finite number in [0.5, 2], rounded to two decimals) → `OverlayEditState`; `overlay-edit:reset` () → `OverlayEditState` (the layout's default); `overlay-edit:finish` (`save` or `cancel`) → `SettingsView`. Bridge methods `beginOverlayEdit`, `setOverlayEditScale`, `resetOverlayEditPlacement`, `finishOverlayEdit`. `AppState.overlayEdit` is `{active: false}` or `{active: true, layout, scale, placement}` with `placement` `visible`, `waiting-for-game`, `too-large` or `not-foreground`, pushed on change only. The overlay bridge stays `subscribeOverlay` only |
| M11 | Save: `finish('save')` leaves edit mode first (hidden, not interactive), then saves `setOverlayPlacement(layout, draft)` through the shared settings queue with the facts `overlayPlacement` (the layout) and `overlayScale`; it applies only after the durable rename through the usual settings change. A failure keeps the previous placement, sets `saveError` and rejects with a fixed message. Dragging, scaling, reset and cancel write nothing |
| M12 | UI: a **Position and size** block in the Overlay card with the existing shadcn `Button` only. Outside edit mode: **Edit position** and the saved scale in percent. In edit mode: a status line from `placement`, smaller and larger buttons in 10 % steps, **Reset to default**, **Done**, **Cancel** and help text (drag the overlay; Enter saves; Esc cancels). The layout radio group is disabled while editing. The overlay shows no hint text and loads no shadcn styles |
| M13 | No React component tests (as L14); the smokes record the edit steps for review and the receipt and `RuntimeReceipt.ps1` are unchanged |

Invariant (REG-016): the overlay is visible only in driving mode (the game in front; ignoring the mouse, not focusable, not movable) or in edit mode (an own window focused, the game not in front; interactive), and no controller call leaves a taskbar tab enabled.

## ET-015a authorization — October 16, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-015a (events and durable ACK) and adopted the architect's decisions R1–R17 below. They are coordinator decisions and were not individually reviewed by the owner; the owner may revise them. For ET-015a only, this supersedes earlier statements that ET-015a remains unauthorized; earlier dated text is unchanged.

Event and trip effects are committed in one transaction before the ACK. Recording of real game history stays gated until a separate enablement PR, which requires:
- the v0 retirement (D2);
- real-game v1 evidence;
- ET-015b and ET-015c;
- the S-1/S-2 decision in ET-016.

| # | Decision |
| --- | --- |
| R1 | Four PRs in order, each from `main` after the previous merge: storage recovery reads; the trip recorder in the ingestion pipeline; service wiring and the production gate; a runtime recording journey (development and packaged) |
| R2 | A `TripRecorderSink` implements `DurableSink` and owns the `TripState`. `DurableDelivery` stays the only FIFO and single-in-flight scheduler. The reducer steps when an item reaches the head of the FIFO, coverage is read just before the commit, and state is adopted only on `committed`, `duplicate`, `covered` or `conflict` (T3). `EffectsHook` is removed (S-3) |
| R3 | Production gate: `GAME_HISTORY_RECORDING` in `recording-policy.ts` (`false` when decided; `true` since the owner's authorization of October 25, 2026, see [the enablement section](#game-history-recording-enablement--october-25-2026)). `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` opens `%LOCALAPPDATA%\ETS2Telemetry\synthetic\<name>.sqlite` with that purpose instead of history, and durable delivery applies only to the matching selection. An invalid value logs `RECORDING_TARGET_REJECTED` and falls back to the default. The env can never select history |
| R4 | Cold start uses storage-derived `TripSeed`s (job key, observed distance, last UTC label, `awaitingOutcome`), not a replay rebuild. This answers the open rebuild question in [trips](docs/trips.md) |
| R5 | Checkpoints and snapshots of durable connections enter the same FIFO as readings, in stream order, bounded separately by `MAX_PENDING_READINGS` = 512. Overflow closes the connection as retryable `BACKLOG_FULL`; readings are never thinned |
| R6 | At `openSession` the recorder steps `disconnected` itself when the reducer still has a connection |
| R7 | A retryable storage failure gives no adoption and no ACK, then a retryable close. An unavailable failure stops durable delivery for the service lifetime. Reducer violations map to fixed unavailable codes (`TRIP_ORDER_VIOLATION`, `TRIP_COVERAGE_MISMATCH`, `TRIP_UNKNOWN_SESSION`) |
| R8 | The receipt UTC label is captured when the frame is decoded and passed with the commit |
| R9 | ACK ahead of storage (E6) records one session-level `restore-loss` completeness interval, written at most once, before the session continues live-only |
| R10 | A hello requests durable delivery only for listed selections and only while storage is open. When storage opens, a live-only connection reconnects once as durable; live never waits for storage |
| R11 | S-1 (fuel-used column) and S-2 (late-attached job trips) go to ET-016 in one schema v2 migration; S-3 is resolved here; S-4 stays in detail JSON. No schema migration in ET-015a |
| R12 | Storage API additions without a schema change: a `{game, outcome}` filter on `listTrips` and an `ifAbsent` option on `recordCompleteness` |
| R13 | Disk-full, permission and lock failures are injected through the real worker by a test-only entry inside the real transaction, so rollback of the event and its effects is proven |
| R14 | Orderly exit splits ingestion stop into intake (`stopSource`) and a nominal 500 ms `recording-flush` step (bounded unused-intake allocation approved October 21, 2026; see [correction](#et-012-corrective-shutdown-allocation--october-21-2026)) that waits for the in-flight commit and drops queued work; the producer redelivers it. The service stop budget stays 2500 ms |
| R15 | Seeds are read only at the first durable welcome of a game in the recorder's lifetime |
| R16 | `conflict` results are adopted as T3 says; a later divergence fails closed |
| R17 | The recorder exposes a read-only trip view for ET-015b's sample references |

Synthetic and replay recordings use only temporary or synthetic-purpose databases. No schema, wire, preload/IPC or renderer change; ET-015b, ET-015c, ET-016 and later phases are not authorized by this section. No game, TruckersMP, display or performance claim follows from synthetic or local tests.

## ET-012c strip overflow fix — October 16, 2026

On October 16, 2026 the owner decided to fix the overlay strip's overflow first, in a separate package ET-012c, before ET-010c (PR #73) merges.
- **The problem.** With protocol v1 data, the default strip (1280 × 38 DIP, all sections) kept only seven of twelve shown sections on its single visible line. ET-012b's scale could not help.
- **Decisions.** Under that decision and the standing delegation of October 15, 2026, the coordinator adopted the architect's decisions S1–S12 below. They were not individually reviewed by the owner.

| # | Decision |
| --- | --- |
| S1 | One PR, strip only; the overlay smoke assertion is the reproducing regression case |
| S2 | The strip reserves `rows` 36 px rows, computed by greedy in-order packing of per-item maximum widths (two tag slots, then the enabled sections in canonical order, with the 14 px column gap). The window height is `ceil(36 × rows × scale + 2 × max(1, scale))` DIP. Below zoom 1 the surface border snaps to one device pixel, so the inner width counts it as `max(1, 1 / scale)` CSS px. Flexbox line breaking uses widths clamped by `max-width`, so the real layout never needs more lines than reserved. Rejected: a fixed two rows, renderer measurement over new IPC, and rows derived from the values or from the sections that currently have data |
| S3 | Per-section maximum widths in CSS px: speed 140, gear 90, RPM 130, fuel 190, range 140, SDK consumption 230, cargo 300, origin 300, destination 300, distance driven 150, distance remaining 150, deadline 220, expected income 300, game time 200. Two tag slots of 96 each. Longer values end in an ellipsis |
| S4 | A pure module `overlay-strip.ts` holds the constants and `stripRowCount`; main's geometry and the overlay renderer share it, and a unit test cross-checks `renderer.css`. The renderer gains no geometry authority |
| S5 | The geometry functions take the enabled sections and default to all of them, so a forgotten argument over-reserves. The strip width rule is unchanged. The strip fits only when the client height is at least its height plus 16. The one-row strip height uses `ceil` instead of M4's `round` |
| S6 | A strip that does not fit hides as a whole in driving mode, and edit mode reports `too-large` (L10/M4); it never shrinks automatically or clips sections |
| S7 | The controller keeps the saved sections. A sections-only change re-places a shown strip, with one topmost re-assertion when its rectangle changes, never shows a hidden overlay, and re-sizes the edit overlay from its unchanged draft |
| S8 | Main creates the overlay window at the size for the saved sections and passes the sections to the controller only after a durable settings save |
| S9 | Strip items carry their maximum width inline. The fixed 38 px row height is removed; the surface takes its content height at the top of the reserved window, and the unused transparent rows stay click-through |
| S10 | The overlay runtime smoke asserts that every shown strip section lies inside the overlay window and that every strip item is capped; truncation and row counts are recorded only. The receipt and its phase count are unchanged |
| S11 | Card, cluster and HUD are unchanged in ET-012c |
| S12 | No change to settings format v3, preload/IPC, `OverlayPresentation`, protocol, fixtures, service or native code; driving-mode click-through, no focus, the topmost re-assertion and the REG-016 invariant keep their code paths |

**Invariant.** The overlay window geometry is a function only of the layout, placement, enabled sections, client rectangle and display topology. Every enabled strip section that the projection shows lies inside the window.

No game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-012d overlay layout fit — October 16, 2026

- **Problem.** With protocol v1 data (ET-010c), the Cluster's side panel was capped at 200 px and clipped game time. The Card and HUD would clip at 13 sections, and at 14 sections plus a tag.
- **Decisions.** The owner decided on October 16, 2026 to fix the strip first. The coordinator decided to merge ET-010c and fix the remaining layouts here. Under the standing delegation the coordinator adopted the architect's decisions K1–K12 below; the owner did not review them individually.

| # | Decision |
| --- | --- |
| K1 | One PR covering the Card, Cluster and Minimal HUD; the strip (ET-012c) is untouched |
| K2 | Fixed-height rows and a linear reserve. A header or tag row is always reserved, plus one fixed row per enabled section. For the Cluster's side panel, the count is the enabled sections other than speed, gear and RPM, which the gauge shows |
| K3 | Constants in CSS px at zoom 1 with border-box sizing:<br>• Card: 48 + 24 per section<br>• Cluster panel: 36 + 21 per panel section<br>• HUD: 18 + 24 per section |
| K4 | Grow-only. The height is the larger of the scaled nominal height and the scaled reserve, and widths are unchanged. Every configuration whose reserve fits its nominal size at a given scale keeps its exact geometry at that scale |
| K5 | A shared `surfaceHeightDip(content, border, scale) = ceil(content × scale + 2 × border × max(1, scale))`. It applies to every layout and gives the strip no numeric change |
| K6 | Degradation is unchanged: a layout that does not fit hides as a whole, and edit mode reports `too-large` |
| K7 | A pure `overlay-rows.ts` holds the row model. The Cluster gauge set is exported once from `overlay-sections.ts`, and a unit test cross-checks `renderer.css` |
| K8 | The CSS gets fixed row heights with centred alignment and hidden overflow, and the Cluster panel's `max-height: 200px` is removed |
| K9 | No controller or main logic change; sections changes already re-place the window after a durable save |
| K10 | The telemetry smoke asserts Card, HUD and Cluster containment with v1 data in driver-sized windows that are tied to `overlayWindowSize`. The overlay smoke keeps the strip assertion |
| K11 | The containment assertion fails when a shown section lies outside the window or a clipping ancestor, when a value is clipped by its row, or when the viewport is not the reserved size (+1 px rounding) |
| K12 | No change to settings v3, preload/IPC, `OverlayPresentation`, protocol, fixtures, service, native code or the receipt; the REG-016 paths are unchanged |

**Invariant.** The overlay window geometry is a function only of the layout, placement, enabled sections, client rectangle and display topology. Every enabled section that the projection shows lies inside the window, in every layout.

No game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-015b authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015b, one-second history. It adopted the architect's decisions H1–H17 below as coordinator decisions; the owner did not review them individually and may revise them. For ET-015b only, this supersedes earlier statements that ET-015b is not authorized; earlier dated text is unchanged.

| # | Decision |
| --- | --- |
| H1 | Four PRs. PR-1, the storage guard, and PR-2, the pure sampler, both start from `main`. PR-3, the recording pipeline, follows both. PR-4, the runtime journey, follows PR-3 and the ET-015a journey |
| H2 | The pure `sampleReading` lives in `packages/telemetry-core/src/history-samples.ts`. The trip recorder calls it in `observe`, at the head of the DurableDelivery FIFO, so a sample sees only committed trip state. Pending rows sit in a recorder-owned `SampleBuffer`, and DurableDelivery stays the only scheduler (R2) |
| H3 | The tick is the absolute source second, `floor(capture.monotonicNs / 1e9)`, per plugin session and capture clock. The first qualifying reading in each second is sampled. Neither a service timer nor game time is used |
| H4 | A reading is fresh only when its `boundaryOrder` is strictly greater than that of the plugin session's previous reading, across connections. It qualifies only when it is fresh, `simulation` is `running`, its second is new on its clock and its capture is at most 2^63−1 ns. The first reading of a plugin session in a recorder lifetime is a baseline and is never sampled |
| H5 | Paused and unavailable readings produce no row. After a resume or a reconnection the next qualifying second is sampled, and missed seconds are never filled. Source holes add no new interval; the reducer already records trip `sample-loss` and `not-connected` intervals |
| H6 | One row per plugin session, source clock and source second. The sampler enforces it in memory. Storage enforces it inside the transaction through `appendSamples(…, {uniqueSeconds: true})`, which skips a row whose second is at or below the last stored second on the same clock and reports `{appended, skipped}`. A UNIQUE index is deferred to ET-016's schema v2 |
| H7 | A sample references `view.current.tripUuid` only while the trip view's phase is `active`. It is null when idle, awaiting the outcome, during a reload check, and for an untracked job (free driving or ambiguous) |
| H8 | A low-priority `samples` op in the FIFO writes at most 60 rows of one session per `appendSamples`. It is queued when the oldest pending row is 5 s old or 60 rows are pending, and at most one such op is queued or running |
| H9 | Loss budget. In steady state, at most 5 s plus one batch command is uncommitted. A kill loses at most those rows; an open trip records this only through its `consumer-restart` interval. An orderly exit loses none unless its step expires. Under a storage backlog at most 300 rows are held; newer rows are dropped, and each dropped run becomes one session-level `sample-loss` interval with `cause: 'sample-backlog'` |
| H10 | A coverage item waits behind at most one bounded batch. Samples never count against the 256-item and 512-reading bounds |
| H11 | `recording-flush` keeps its nominal 500 ms; the owner-approved October 21, 2026 [correction](#et-012-corrective-shutdown-allocation--october-21-2026) supersedes the fixed effective deadline. After the commit in flight, it writes every pending row (at most 300 per session) unless delivery has failed, and logs `V1_SAMPLES_EXIT` once. The 2500 ms stop total is unchanged |
| H12 | Sample write failures follow the E7 classes. A retryable failure keeps the rows and retries them at the next timer, and the connection stays open. An unavailable failure makes the service live-only for its lifetime and discards pending rows. Diagnostics are the `V1_SAMPLES_*` codes, logged at counts 1, 2, 4, … |
| H13 | Readings carry the receipt UTC label taken at decode (as R8). A sample's `utcMs` is the reading's `captureUtcUnixMs` when it is available and safe, and otherwise this label |
| H14 | Wire canonical units are copied unchanged, and position comes from `worldPlacement.position`. Availability objects lose their `unit` key, and game time keeps its own clock. UTC, game time and real time stay in separate columns |
| H15 | Samples are written only through the recorder, which exists only for a synthetic or replay recording target (R3). The gate is unchanged |
| H16 | No schema or migration change. Storage adds only the `uniqueSeconds` option, the `skipped` count and an in-process test hook |
| H17 | Expected rows are written by hand. Tests use controlled clocks and fake timers, the real storage worker, actual pipes and the reactive simulator |

Recording of real game history stays gated until the separate enablement PR described in the ET-015a authorization. ET-015c, ET-016 and later phases are not authorized by this section. No game, TruckersMP, display or performance claim follows from synthetic or local tests.

## ET-015c authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015c, integrated recovery. It adopted the architect's decisions G1–G20 below as coordinator decisions; the owner did not review them individually and may revise them. For ET-015c only, this supersedes three earlier statements; earlier dated text is unchanged:
- that ET-015c is not authorized;
- C9's statement that recording is always reported as unavailable;
- ET-015a's statement that it makes no preload/IPC or renderer change.

ET-015c shows the user a truthful recording status. It fixes a queue-pressure defect that lost events during reconnections. It also proves, with real pipes and the real storage worker, the recovery paths that only unit tests covered before.

| # | Decision |
| --- | --- |
| G1 | Four PRs:<br>• PR-1 extracts the recording runtime and adds integration proofs, with no behaviour change;<br>• PR-2 fixes the backlog bound;<br>• PR-3 reports the recording status from the service to main;<br>• PR-4 adds the dashboard and tray presentation and the smokes.<br>PR-2 may run beside PR-1 |
| G2 | `AppHealth.recording` becomes a discriminated union with fixed enums only, and no text, paths or identifiers:<br>• `disabled`, `unknown`, or a state (`opening`, `waiting`, `recording`, `paused`, `interrupted`, `retrying`, `not-recorded-source`, `live-only`, `stopped`);<br>• with that state, the target (`history`, `synthetic`, `replay`), a code from a closed set, the committed loss counts and the current trip's phase and completeness.<br>`LiveTelemetry.recording` stays `false` |
| G3 | The service derives the status with a pure, ordered rule set. `recording` needs all three: the database open, the durable cursor active and fresh v1 data. Main never derives it, and the live projection still carries no durable status (F2) |
| G4 | The service posts `{type: 'recording', status}` on its parent port. Main accepts it only from the current child and validates it strictly. An invalid payload sets `unknown` and logs `RECORDING_STATUS_REJECTED`; it is not fatal. Main pushes the status through the existing `app:state` path. No channel, bridge method or preload code is added |
| G5 | Event-driven: state changes are coalesced to at most four per second, and loss changes are sent at once. Main sets `unknown` initially and whenever the service fails, exits or restarts. ET-036 resolves the hung service gap: the service utilityProcess emits an unreferenced 1 Hz heartbeat (`{type: 'heartbeat'}`) on its parent port. Main tracks liveness with an initial 15,000 ms startup deadline before the first message and a 5,000 ms steady-state deadline; upon a missed deadline, main logs `SERVICE_HEARTBEAT_TIMEOUT`, marks recording status as `unknown`, and invalidates live telemetry freshness to `stale` without terminating or restarting the process (preserving ongoing SQLite transactions and avoiding burning the restart budget; automatic restart is rejected). Any message resets the deadline and triggers `SERVICE_HEARTBEAT_RESUMED` upon recovery |
| G6 | Losses count only committed effects:<br>• new gap coverage, and restore-loss ranges;<br>• the interval kinds;<br>• dropped samples.<br>Duplicates, covered and conflict results never count. Main adds the totals across service restarts, giving totals since the application started. The database stays authoritative, and the journal is ET-016 |
| G7 | No `storage-unavailable` interval is written. An outage reaches history through the producer's gap causes, and the live status shows it as it happens |
| G8 | The dashboard's Application status card and the tray show a headline from a pure text builder. The card adds a target note, a current-trip line and loss lines that appear only when non-zero, plus an alert for `retrying`, `stopped` and `live-only`. The overlay is unchanged |
| G9 | `DISK_FULL`, `IO_ERROR` and `DATABASE_LOCKED` stay retryable. A retry code is set by a retryable commit or sample failure and cleared only by a successful write. Recovery uses the existing backoff and the 5 s sample timer |
| G10 | Permission and other unrecoverable codes (SCHEMA_NEWER, DATABASE_UNRECOGNIZED, PURPOSE_MISMATCH, DATA_PATH_INVALID, DATABASE_CORRUPT, DURABILITY_UNVERIFIED, MIGRATION_FAILED, INTERNAL) give `stopped` for the service lifetime with no automatic re-open; recovery is administrative/restart. ET-037 resolves the recoverable stop gap: retryable open refusals (DATABASE_LOCKED, DISK_FULL, IO_ERROR, STORAGE_BUSY, TIMEOUT, and BACKUP_FAILED with retryable cause) automatically re-open with bounded exponential backoff ([250, 500, 1000, 2000, 4000] ms, max 60 attempts). While retrying, status truthfully reports `stopped <code>`. Once the cause clears, HistoryStorage re-opens, durable delivery reconnects with `durableEvents: true`, replayed events commit, and recording resumes without restarting |
| G11 | `MAX_PENDING_COMMITS` goes from 256 to 512, twice the producer's retained entries, so an ended connection's leftover work plus a full redelivery fits. A true stall still closes the connection as retryable `BACKLOG_FULL` |
| G12 | After a service restart the status is `unknown` until the new service reports. A renderer reload or crash gets the full `AppState` on subscribe. Port reattachment cannot change the status |
| G13 | Shutdown phases and budgets are unchanged. The flush wait is proven with the real worker and the real shutdown sequence. The packaged runtime cannot hold a commit at exit, and that limit is recorded |
| G14 | R10 is proven through the production wiring with an open held by the test. The live-only window's events arrive as a committed `noDurableConsumer` gap |
| G15 | `TRIP_COVERAGE_MISMATCH` stays detection after the commit. The exclusive lock, the single worker, one command in flight and the single-instance lock make a coverage change between the read and the commit impossible. The item leaves the enablement list |
| G16 | Plugin exit writes no new interval. T11 keeps the uncertainty: the next plugin session closes the open trip as `restart`, partial |
| G17 | With the application absent there is no spool and no offline history. The checkpoint hydrates and the offline gap is committed and counted |
| G18 | The storage close stall over 2 s was deferred to ET-019 and is resolved in ET-038 via adaptive stop grace: when prompt intake and flush complete within <50 ms, the unused budget cascades to the storage phase steps, expanding effective budget up to ~2,450 ms and history close grace up to ~2,250 ms (with a 200 ms termination reserve), allowing slow closes to exit 0 clean while stalled closes remain strictly bounded within the 2,500 ms `SERVICE_STOP_BUDGET_MS` |
| G19 | The recording gate is unchanged. The enablement PR still needs the v0 retirement, real-game v1 evidence, S-1/S-2 in ET-016, and real full-volume and ACL evidence |
| G20 | Tests use hand-written tables and rows, fake timers, the production wiring in process with the real or fault worker, the reactive simulator on real pipes, and runtime smoke assertions. Waits count commits, ACKs or holds; real-time bounds are only named hang guards |

`GAME_HISTORY_RECORDING` stays `false`. ET-016 and later phases are not authorized by this section. No game, TruckersMP, display or performance claim follows from synthetic or local tests.

## ET-016 authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-016: the trip journal, trip details and JSON export. It adopted the architect's decisions J1–J22 below as coordinator decisions; the owner did not review them individually and may revise them. For ET-016 only, this supersedes two earlier statements; earlier dated text is unchanged:
- that ET-016 is not authorized;
- with J9, T9: a job seen first in a checkpoint now opens a partial late-attach trip. This matches §3, which says recording that starts after a job has begun is reflected in the trip's completeness, and the owner's answer of October 10, 2026 that late attachment marks trips incomplete.

| # | Decision |
| --- | --- |
| J1 | **ET-016a:** schema v2, then journal reads, IPC, the Journal tab and export.<br>**ET-016b:** fuel-used persistence (may start after schema v2), then late-attach trips, then journal and export reconciliation in the recording journey |
| J2 | The journal reads through the telemetry service's open database and its storage worker. A second connection is ruled out by exclusive locking (OD-8), and only the storage worker loads SQLite |
| J3 | Synthetic or replay databases are browsable only as the existing `ETS2TELEMETRY_RECORDING` target. Every response carries the database purpose. A non-history purpose shows a persistent "never game history" banner, and the export header carries the purpose. Tests seed only isolated synthetic databases |
| J4 | Main sends journal queries to the service on its parent port:<br>• one in flight per service and at most 4 queued (`BUSY` beyond that), with 15 s each;<br>• replies from a retired service are ignored.<br>The service runs one query at a time, only while the database is open, so at most one journal command is ever in the storage queue |
| J5 | New worker commands `journalTrips`, `journalTrip`, `journalEvents` and `journalIntervals`; samples reuse `listSamples`. Bounds: trips 50 per page, newest first, with filters applied in SQL before the limit; events 100 (UI) or 500 (export); intervals 100 or 500; samples 300 or 3,600. Money totals are exact, per currency and SDK type, and marked `incomplete` beyond 5,000 amounts |
| J6 | Schema v2 is one migration:<br>• S-1 `trips.fuel_used_l` with its availability state;<br>• the trip close carrier (session and eventSeq);<br>• S-2 `job_configurations` rebuilt with a session reference, an `event` or `checkpoint` source and the matching unique references;<br>• S-2 `trips` rebuilt so that a trip can open from a checkpoint: `opened_event_ref` becomes nullable and a new `opened_by` (`event` or `checkpoint`) is tied to it by a CHECK. v1 rows are backfilled as `event`. This was amended on October 16, 2026 after the PR-1 review found that a checkpoint-opened trip could not be stored.<br>No index is added beyond the implicit indexes of the UNIQUE keys. No UNIQUE sample index is added, because the `uniqueSeconds` guard covers it (closes the H6 deferral) |
| J7 | A trip's timeline window runs through its own session's events, from the job configuration or the opening, up to:<br>• the recorded close carrier, inclusive when it is an event of the same session and exclusive when it is a gap's first new eventSeq;<br>• the end of the trip's own session, when the trip was closed from another session (a restart);<br>• nothing yet, while the trip is open.<br>A trip opened from a checkpoint (J9) starts its window at the checkpoint's next eventSeq; the reads for it arrive with ET-016b. Migrated v1 trips have no known window and list only their attributed or referenced events |
| J8 | S-1: fuel used is persisted like observed distance, both while the trip is open and before every close, and resumes from seeds. Refuels stay annotations |
| J9 | S-2: a job seen in a checkpoint while the game's slot is idle opens a partial trip once the retained events have replayed:<br>• the job values come from the checkpoint;<br>• a `late-attach` not-connected interval is recorded;<br>• when the previous trip with the same job closed without an outcome, a not-merged continuation interval is recorded too;<br>• the identifier is deterministic, and the trip is written by an idempotent storage command ordered in the FIFO, with no ACK or coverage change.<br>Supersedes T9 |
| J10 | Six fixed bridge methods (list trips, get trip, list events, intervals and samples, export trip) on six fixed channels, for the trusted dashboard main frame only. Arguments are validated in the preload and again in main, and main sets the page size. Main validates every service reply strictly. No path, process id or Windows session id reaches the renderer; plugin session identifiers are stable data identifiers and may appear |
| J11 | Methods resolve `{ok, value}` or `{ok: false, code}` with fixed codes, for example `DATABASE_OPENING`, `BUSY`, `NOT_FOUND` and the export codes. Invalid or untrusted calls reject |
| J12 | The main window gains Live and Journal tabs. The journal has a paged list with filters, and a paged detail with summary, job, truck, trailers, money, completeness intervals, timeline and samples. Only the current page is held, and there is no auto-refresh |
| J13 | Display rules:<br>• outcome and recording completeness are separate;<br>• planned, observed and delivered distance are labelled apart;<br>• expected income is shown apart from revenue or penalty, as exact digits with the currency basis, never netted or converted;<br>• a missing value reads "unavailable (reason)", and zero is a value;<br>• game mode carries its confidence;<br>• units follow the game profile;<br>• no trip average consumption |
| J14 | Sample tables show "no samples for N s" between rows more than one source second apart, and "source restarted" at a clock change |
| J15 | Export format `ets2telemetry.trip-export`, version 1:<br>• canonical units and stable identifiers;<br>• the protocol v1 availability and money shapes, with the currency marked SDK-documented or unknown;<br>• the trip, job, truck, trailers, outcome details, money totals, intervals, events, samples and bounds.<br>Any change bumps the version. There is no import |
| J16 | Main exports through the save dialog:<br>• cancelling writes nothing;<br>• a target inside the application's data root is refused;<br>• the file is written as a partial in the target folder, page by page, then synced and renamed;<br>• a failure or an exit removes the partial;<br>• logs carry fixed codes only.<br>The Windows overwrite prompt is a pending manual check |
| J17 | Exporting an open trip takes a bounded snapshot fixed at the start of the export |
| J18 | The owner's uninstall data rule is recorded ("Uninstall removes local data — October 16, 2026"): the journal states next to Export that an uninstall removes local history and that the JSON export is a copy for the user's records, which cannot be imported |
| J19 | TD-004 and TD-005 are unchanged; the journal reads the authoritative database |
| J20 | Tests use hand-written anchor trips and expected values, generated filler trips for paging only, EXPLAIN QUERY PLAN checks instead of timing assertions, and a save dialog stubbed in the smokes only |
| J21 | No trip average consumption (TD-006) |
| J22 | Late-attach trips have no truck or trailer identity until it is sent again (TD-007) |

`GAME_HISTORY_RECORDING` stays `false`. ET-017 and later phases are not authorized by this section. No game, TruckersMP, display or performance claim follows from synthetic or local tests.

ET-016 implementation update on October 17, 2026: ET-016a and ET-016b are implemented.

**ET-016a**
- Schema version 2: #93.
- Bounded journal reads in the storage worker: #96.
- Journal queries from the trusted dashboard through main to the telemetry service: #97. A storage-side timeout is reported as an unavailable database, because it ends recording for that service.
- The Journal tab with trip details: #98.
- The versioned JSON trip export through a main-process save flow: #101. It refuses targets in the data folder by name, real path and file identity, and states the J18 uninstall note next to Export.

**ET-016b**
- Fuel-used persistence: #95.
- Late-attach trips opened from checkpoints, which supersede T9: #99.
- Journal and export reconciliation in the development and packaged recording journey: #102.

**Technical debt.** TD-006 (trip average consumption), TD-007 (late-attach truck and trailer identity) and TD-008 (the export's trailer list is limited to the latest 10 configurations) record the deferred parts.

**Enablement.** It no longer waits for S-1/S-2, but it still needs the v0 retirement, real-game v1 evidence, and real full-volume and ACL evidence. `GAME_HISTORY_RECORDING` stays `false`.

**Pending checks.**
- The real Windows Save dialog, readability and keyboard use of the Journal tab, and a forced render fault.
- The first real upgrade of the owner's existing version 1 history database, after its verified backup.
- The journal and export against real recorded history.
- Real late-attach checkpoints.
- Every real-game, TruckersMP, display and performance check.

See [journal](docs/journal.md), [trip export](docs/journal-export.md) and [ET-016 validation](docs/validation/et-016.md).

## Uninstall removes local data — October 16, 2026

On October 16, 2026 the owner confirmed an answer first given on October 10, 2026: uninstalling ETS2Telemetry removes all of its local data. That covers the application root `%LOCALAPPDATA%\ETS2Telemetry`: the history database and its backups, settings, logs, synthetic recordings and other application-owned files. History is expected to come back from the server once the later server phase exists. Until then, an uninstall loses unsynchronized local history permanently.

- **Scope.** Only data the application owns is removed. The plugin rules above still apply: on uninstall, remove only the plugin file this application installed, and never touch other plugins or game files.
- **Installer work.** ET-018 implements the removal and its checks. The ET-001 scaffold's uninstaller keeps the data root, as recorded in [ET-001 validation](docs/validation/et-001.md); that is the baseline ET-018 changes.
- **Warning to users.** Before the history is removed, the product must say so clearly. The trip journal's export (ET-016, J18) states that an uninstall removes local history and that a JSON export is the way to keep a copy; ETS2Telemetry cannot import that copy.

This records an owner decision. It authorizes no package by itself, and earlier dated text is unchanged.

## ET-017 authorization — October 17, 2026

Under the owner's standing delegation of October 15, 2026, the coordinator started ET-017 to implement the [silent plugin installation](#silent-plugin-installation--october-12-2026) decision of October 12, 2026. The coordinator adopted the architect's decisions P1–P20 as coordinator decisions; the owner agreed explicitly to P11 and P12 on October 17, 2026. The card prerequisites ET-009 and ET-011 are not accepted, and their real-game checks stay pending.

| # | Decision |
| --- | --- |
| P1 | The Steam root is read from `HKCU\Software\Valve\Steam\SteamPath`, falling back to the 32-bit machine key. A single fixed, bounded PowerShell call reads only those two values and returns base64 UTF-8, so non-ASCII paths survive. There is no `reg.exe`, native add-on or new dependency |
| P2 | Libraries come from `steamapps\libraryfolders.vdf`, falling back to `config\`. A bounded KeyValues parser accepts the current and legacy formats and drive paths only. Libraries are deduplicated by file identity. A malformed list falls back to the Steam root |
| P3 | A game is identified by its app id (ETS2 227300, ATS 270880), its app manifest with a safe `installdir`, and the game executable under `bin\win_x64`. The folders on that path must not be links. `StateFlags` is not used |
| P4 | One manual folder per game, chosen through main's folder dialog. A selection inside the game is normalized to the game root. Unsupported paths, a non-game or wrong-game folder, linked folders and duplicates are refused with fixed codes |
| P5 | The build stages the plugin DLL with a manifest: size, SHA-256, the app version, hashes of the plugin sources, and the released hashes from the tracked `released-plugins.json`. Forge ships it as `resources/telemetry-plugin`, and the package inspection verifies it. MSVC builds are not reproducible, so every shipped hash is recorded at release |
| P6 | An existing plugin file is owned only when its hash is the bundled one, a released one, or the one recorded for that folder. Anything else, including links and oversized files, is never replaced or removed. There is no in-app overwrite |
| P7 | A bounded `tasklist` listing runs before every change. A running ETS2 or ATS, or any `truckersmp*` process, blocks the change, and a failed listing blocks too. A locked file, reported by the operating system, closes the remaining race |
| P8 | Every change is atomic per game folder. The intent is recorded first, then the new file is written to a temp file in the same folder, synced, verified by hash, renamed over the target and verified again. The temp file is always removed, and an unfinished operation is recovered at the next run. Rename is retried briefly on `EBUSY` and never on `EPERM`. The plugins folder is created only when missing, and removed only if this application created it and it is empty |
| P9 | `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json` (format v1, bounded) holds the exclusions, the manual folders, the install records, the pending operations and the last failures. It is written atomically like the settings. An invalid file is quarantined, and a newer version is read-only. ET-018 removes only a plugin whose recorded or released hash still matches |
| P10 | `settings.json` keeps its format. The exclusions and manual folders live in `setup.json`, which still persists them, as the October 12 decision requires |
| P11 | Excluding a game in the application stops silent installs and removes this application's plugin from that game once it is safe; while the game runs, removal waits. Closing a game never removes the plugin. Re-including the game installs the plugin again. The owner agreed on October 17, 2026 |
| P12 | There is no elevated helper. A permission error shows recovery text with "Show plugin file" and "Open game plugins folder" for a manual copy. A copied file with the bundled hash is adopted. The helper is technical debt. The owner agreed on October 17, 2026 |
| P13 | Setup runs 2 s after launch and is never awaited by startup. It is bounded to 30 s and runs one at a time. It polls every 15 s only while a target is blocked by a running game or a lock, and it also runs on Retry, a folder choice or an exclusion change. Exit aborts it within the existing idle budget |
| P14 | Setup runs in Electron main with asynchronous file and process calls. The telemetry utilityProcess gains no authority over game folders |
| P15 | A fail-closed mode gate leaves setup disabled for unpackaged runs unless explicitly enabled, and for every test, smoke and diagnostic harness. Tests use a separate test root that must stay inside an isolated profile |
| P16 | Per-game states reach the renderer through the existing application state. Six trusted dashboard-only methods are added: retry, choose folder, exclude, show plugin file, open game plugins folder, export diagnostics. No path reaches the renderer |
| P17 | Connection diagnostics distinguish an unavailable service, a missing game, a missing, outdated, blocked or unrecognized plugin, a transport failure and no running source. An opt-in, redacted diagnostic bundle (at most 2 MiB, no paths, user or machine names) is saved only through main's Save dialog. Nothing is uploaded |
| P18 | One small "Game plugin" card on the Live tab, built from the existing shadcn components. The owner's visual design work is not anticipated, and the overlay is unchanged |
| P19 | Tests run only on temporary fake Steam and game folders, under guards that refuse any other path |
| P20 | Six PRs in order: bundle, discovery, installer, main, card, diagnostics |

There is no wire, schema, recording, overlay or native-source change, and `GAME_HISTORY_RECORDING` stays `false`. Real Steam libraries, real game installs loading the plugin, TruckersMP detection and protected libraries remain pending. ET-018 and later phases are not authorized by this section. No game, TruckersMP, display or performance claim follows.

## ET-017 PR-4 implementation update — October 17, 2026

PR-4 runs silent plugin setup from Electron main and exposes per-game plugin states through the application state. The renderer receives fixed codes and counts only, never paths. Setup starts 2 s after launch and is never awaited by startup. It runs one setup run at a time and each run is bounded to 30 s. The running-game listing is bounded to 10 s.

Setup polls every 15 s only while one of these holds:
- a running game, a running TruckersMP client or a locked file blocks a target;
- the running-game listing failed;
- a run hit its 30 s limit.

This extends P13, which named only running games and locks. A poll writes nothing until its own listing succeeds. Steam game folders beyond the per-game target bound are counted, never shown as paths. Excluding the game still removes this application's recorded plugin from those folders.

The P15 mode gate decides where setup may write:
- **Active mode** requires that no isolation variable and no test root is set. The isolation variables are `ETS2TELEMETRY_PROFILE_DIR`, `ETS2TELEMETRY_DIAGNOSTIC_DIR`, `ETS2TELEMETRY_LIVE_SMOKE` and `ETS2TELEMETRY_SOURCE_KIND`; the test root is `ETS2TELEMETRY_PLUGIN_SETUP_ROOT`. Under that condition:
  - a packaged launch is active when `ETS2TELEMETRY_PLUGIN_SETUP` is unset;
  - any launch, packaged or unpackaged, is active when `ETS2TELEMETRY_PLUGIN_SETUP` is exactly `real`.

  Only active mode touches real Steam libraries and game folders.
- **Disabled mode** applies to every other launch, including `npm run dev` without `=real`, tests, and every smoke or diagnostic harness. Any non-empty value of `ETS2TELEMETRY_PLUGIN_SETUP` other than exactly `real` disables setup.
- **Test-root mode** applies when two conditions hold: `ETS2TELEMETRY_PLUGIN_SETUP_ROOT` names a fake root that holds the test-root marker file, and an isolated profile is set. In this mode, every file operation and the install registry are confined to that root. A root without the marker turns setup off for that run.

The details are in [plugin setup](docs/plugin-setup.md). The repository's checks never run active mode, and an unpackaged launch with `=real` writes into real game folders, so agents must not use it. Real Steam libraries, real ETS2 and ATS installs loading the silently installed plugin, TruckersMP detection, and protected libraries remain pending manual checks. No game, TruckersMP, display or performance claim follows.

## ET-017 implementation update — October 17, 2026

All six ET-017 PRs are implemented:
- PR-1 (#104) bundles the plugin;
- PR-2 (#105) adds Steam discovery and the manual folder check;
- PR-3 (#106) adds the atomic installer and the install registry;
- PR-4 (#107) runs silent setup in main, behind the P15 mode gate;
- PR-5 (#108) adds the Game plugin card on the Live tab and the `plugin` runtime smoke against a fake test root;
- PR-6 adds the connection diagnosis on the card and the opt-in diagnostic bundle. The bundle is saved only through main's Save dialog, is redacted, is at most 2 MiB and is never uploaded.

The deferred parts are TD-009 (an elevated copy helper), TD-010 (path-aware running-game detection) and TD-011 (in-app replacement of an unrecognized plugin file) in [technical debt](docs/technical-debt.md).

The card stays in Review. Its prerequisites ET-009 and ET-011 are not accepted, and every real-environment check remains pending ([ET-017 validation](docs/validation/et-017.md)):
- real Steam libraries;
- real ETS2 and ATS installs loading the silently installed plugin;
- TruckersMP process names;
- protected or ACL-restricted libraries, and antivirus;
- the real folder and Save dialogs and Explorer;
- the card's readability.

`GAME_HISTORY_RECORDING` stays `false`. ET-018 and later phases are not authorized by this update. No game, TruckersMP, display or performance claim follows.

## ET-018 authorization — October 18, 2026

Under the owner's standing delegation of October 15, 2026, the coordinator started ET-018 on October 18, 2026: Windows packaging, safe upgrades and explicit uninstall. It implements the [uninstall rule of October 16, 2026](#uninstall-removes-local-data--october-16-2026) and the uninstall contract in [game plugin setup](docs/plugin-setup.md). The coordinator adopted the architect's decisions U1–U17 as coordinator decisions.

The owner decided these on October 18, 2026:
- **O1, signing.** An unsigned internal alpha now; apply to the SignPath Foundation after the first alpha.
- **O2, distribution.** A GitHub Releases pre-release, published only with the owner's authorization.
- **O3, deferred cleanup.** A RunOnce executor finishes a deferred cleanup at the next sign-in.
- **O7, Roaming folder.** Electron's Roaming folder is removed, best effort.

The owner did not review the other decisions individually.

| # | Decision |
| --- | --- |
| U1 | Keep the Squirrel maker: per-user, no elevation. A Windows-initiated uninstall cannot be stopped, so cleanup defers explicitly instead of claiming success |
| U2 | Our own Squirrel event handler replaces electron-squirrel-startup. It parses argv strictly. Install, update and obsolete events never delete data. The uninstall event runs the cleanup engine within an 8 s deadline, inside Squirrel's 10 s, and writes a bounded receipt with no paths |
| U3 | The roots come from the install location: `app-<semver>` → `ETS2TelemetryDesktop` → base, and the data root is `base\ETS2Telemetry`. In production the LOCALAPPDATA variable must equal base, otherwise nothing is removed. A marked test root ignores the environment and confines every path to itself. Portable, unpackaged and development launches never delete anything |
| U4 | Only the allowlisted top-level entries of the data root are removed: data, backups, settings, logs, synthetic, plugins, captures, transport, uninstall. Unknown entries are kept, and links are unlinked without being followed. The following are never removed: exports, other plugins, game files, the shared SquirrelTemp folder and server records |
| U5 | The cleanup engine works in this order: a read-only preflight, then a persisted intent, then plugin cleanup under the ET-017 contract, then the data wipe. The metadata and the helper go last. Every step is idempotent |
| U6 | Windows-initiated uninstall first asks a running instance to exit. A running game or TruckersMP, a lock, a permission error, an unreadable registry or a timeout defers the cleanup |
| U7 | Deferred cleanup (O3): a retained PowerShell 5.1 executor under HKCU RunOnce runs the same contract at the next sign-in. It stops after 10 attempts, and a reinstall cancels it |
| U8 | App-assisted uninstall is the primary path. A Live-tab card and one trusted-dashboard bridge method, `uninstallApplication()`, which never returns a path. A blocked preflight changes nothing; then come plugin removal, an explicit exit, the data wipe and the `Update.exe --uninstall` hand-off |
| U9 | Warnings in the card, next to export and in a new user guide say that local history, settings, logs, captures and synthetic recordings are deleted, and that exports are kept |
| U10 | Upgrades and repair never write the data root. History migrates on first open with a verified backup. A REG-017 check covers install, repair and update in a test root |
| U11 | Installed smokes run the existing scenarios against the installed executable, with a minimal system PATH |
| U12 | Test isolation: a marked run root, SQUIRREL_TEMP redirected into it, a decoy LOCALAPPDATA for the Windows-initiated case, and fail-closed guards against the owner's real roots, registration and processes. The ET-001 host harness is retired. Agents run the installer lifecycle only on GitHub-hosted runners |
| U13 | CI keeps E1 and E2. On non-PR events an installer lifecycle step runs after make; there is no new job and no check rename |
| U14 | The release identity records the SHA-256 and Authenticode status of every shipped PE file. On main and dispatch, CI uploads the installer as an artifact |
| U15 | Distribution through GitHub Releases pre-releases (O2) |
| U16 | Signing: an unsigned alpha now (O1). Signing the plugin DLL later must happen before staging, so that the ownership hashes match |
| U17 | In-place database restore is not part of ET-018 and is recorded as technical debt |

No release is published, no certificate or paid service is bought, and no auto-update is added. `GAME_HISTORY_RECORDING` stays `false`. A clean machine, real games and TruckersMP, Smart App Control and antivirus, and the owner's first real history upgrade remain pending. No game, TruckersMP, display or performance claim follows.

## ET-018 implementation update — October 18, 2026

All six ET-018 PRs are implemented:
- PR-1 (#117): an installer lifecycle in a marked test root. It runs on GitHub-hosted runners, and locally only with `-AllowLocal` on the owner's explicit request. It shows that install, repair and update keep history and settings.
- PR-2 (#118): the uninstall engine, which works in this order:
  1. derive its folders from the install layout (U3);
  2. preflight;
  3. write an intent;
  4. remove only plugin files whose hash it recognizes, following the ET-017 contract;
  5. wipe the allowlisted data, with `plugins\` and `uninstall\` last.
- PR-3 (#120): our own Squirrel event handling, in place of electron-squirrel-startup. A Windows-initiated uninstall closes a running instance, removes the plugin and the local data, and writes a path-free receipt. If a game runs, or a lock or permission blocks the cleanup, it defers explicitly.
- PR-4 (#122): **Uninstall ETS2Telemetry** on the Live tab. It has a data-loss warning and a native confirmation that defaults to Cancel, and it refuses while a game runs. After an orderly exit it wipes the data, shows the result, and hands over to Windows' uninstall for the program files. The new [user guide](docs/user-guide.md) describes both uninstall paths.
- PR-5 (#123): the deferred cleanup at the next sign-in (O3). An HKCU RunOnce entry runs a retained Windows PowerShell 5.1 executor. It applies the same ownership rules as the engine, which a shared case table checks, and it stops after 10 attempts with a README.
- PR-6 (#121): `release-identity.json` records the source commit, the versions, the hashes and the Authenticode status of every PE image. It fails on a `HashMismatch` or `UnknownError` Authenticode status and on native code packed inside the asar archive. The [release checklist](docs/release.md) covers the unsigned internal alpha (O1, O2).

The hosted installer lifecycle runs these scenarios in a test root. All of them passed together on the `main` push after the last merge ([39153876794](https://github.com/senukartur/ets2telemetry/actions/runs/39153876794), see [final hosted results](docs/validation/et-018.md#final-hosted-results-october-18-2026)):
- install, repair and update;
- three Windows-initiated uninstalls: with the app running, with a fake game running (deferred) and after a reinstall;
- the deferred executor, first while blocked and then to completion;
- both in-app scenarios: refused while a fake game runs, and complete with the `Update.exe` handover.

No installer, `Update.exe` or `--squirrel-*` command ran on the owner's machine. The deferred executor ran there only in temporary test roots (`Test-DeferredCleanup.ps1`), never against a real root, and the real RunOnce key was never written.

The deferred parts are in [technical debt](docs/technical-debt.md):
- TD-012: in-place restore of the history database;
- TD-013: Squirrel vendor residue in the binary root;
- TD-014: code signing (SignPath Foundation after the first alpha);
- TD-015: packaging only the win32-x64 better-sqlite3 binding.

The card stays in Review. Every real-environment check remains pending, among them ([ET-018 validation](docs/validation/et-018.md)):
- a clean Windows machine;
- the native dialogs, and Settings and Control Panel uninstall of a real installation;
- real shortcuts, the Roaming folder removal of a production install, and the uninstall card's readability;
- the RunOnce executor at a real sign-in;
- SmartScreen, Smart App Control, antivirus or EDR, and a Group Policy execution policy;
- non-ASCII and long profile paths, and a second user sharing a Steam game folder;
- real Steam libraries, and a real game or TruckersMP running during an uninstall;
- the owner's first real history upgrade.

Nothing has been published. A release needs the owner's authorization under O2. `GAME_HISTORY_RECORDING` stays `false`. Later phases are not authorized by this update. No game, TruckersMP, display or performance claim follows.

## ET-026 persisted-setting decision and implementation — October 21, 2026

The owner accepted observed persisted-setting verification and configured skilled parking plus manual delivery. Twelve configured rules use the observed current cvars, unchanged numeric thresholds, `g_simple_parking_doubles == 0` and `g_parking_difficulty == 2`. Final qualification additionally requires a delivered event with available `autoParkUsed == false`; actual Expert placement is not claimed. Unpersisted runtime settings and transient changes between observations are outside the evidence model. An observed failure, unknown, source/profile switch or interruption irreversibly loses the trip's qualification; later settings cannot restore it.

[Hard Mode](docs/hard-mode.md) implements bounded read-only local/Cloud profile observation, pure evaluation, irreversible trip audit, schema 3, narrow dashboard IPC, parameter hints/journal UI and JSON export 2. Historical schema/fixture bytes stay frozen and historical trips default false/null. `GAME_HISTORY_RECORDING` stays false, wires/native transport are unchanged, and future server mapping is documentation only. The owner authorized implementation, all checks, independent review, Claude feedback, final automatic Ready CI, squash merge and Done without limiting fix/review rounds; this entry does not assert those gates already passed. Remaining real-environment/history/performance checks retain their recorded status in [ET-026 validation](docs/validation/et-026.md).

Latest owner UI decision, October 21, 2026: retain noninteractive hover/keyboard hints on all twelve parameter names and restore the mockup's accessible 470px checklist drawer, View checklist and Check again controls. This supersedes the earlier no-drawer refinement; its evidence remains historical. All Hard Mode labels, states, reasons, notices and trip audit explanations use the accepted ET-029 EN/RU framework and selected language. SDK cargo/city/company/truck names, raw cvars and stored audit/protocol enums stay unchanged. Causal post-read protocol-v1 clock-probe evidence and bounded intake captures prevent queued/old events from borrowing later file proof; pending openings retain the first observed loss through retry. Scan intervals and coverage expiry use client monotonic time; UTC is an audit label only. See [Hard Mode](docs/hard-mode.md).

ET-026 Claude follow-up: freshness eligibility is frozen at synchronous intake/offer on the service's monotonic boundary and carried as validated private storage metadata; the worker never re-ages frozen proof using commit UTC. Main's cache uses its own monotonic receipt age and service lifetime. Any required unknown still irreversibly loses qualification, including one transient process-query/changing-file failure or a log exceeding 4MiB; no grace period is adopted. Up to two CIM process queries per second, real CPU/frame-time impact and actual log growth remain measurement limits. See [Hard Mode](docs/hard-mode.md#conservative-loss-and-measurement-limits).

ET-026 review follow-up: the production HistoryStorage adapter forwards private freshness unchanged. Ordered observer publications select latest by actual FIFO publication order regardless of UTC; queued frozen captures/close/gap reapplication preserve published latest while first loss remains irreversible. Real-worker adapter and app journeys keep compliant trips open across multiple persisted passing refreshes before positive delivery.

ET-026 Claude2 follow-up: private assessment publications carry only their bounded remaining monotonic lifetime; main consumes it on its own clock, and trip-only updates cannot renew proof. Strict invalid metadata and service retirement fail closed without changing renderer/native/storage contracts. The shared 2000ms read-plus-bind deadline, two sequential 1500ms process-query bounds, three-second coverage and four full bounded log reads retain their unmeasured false-loss/cost limits; no optimization or grace period is adopted.

## ET-005b CAP-01 replay closeout — October 21, 2026

The owner approved CD-7 and authorized completing ET-005 through implementation, validation, independent review, Claude feedback, final automatic Windows CI and squash merge, then moving the card to Done. [CAP-01 replay](docs/simulator-v1.md#cap-01-replay-october-21-2026) imports complete loss-free sanitized CAP0 exports into minimized replay scenarios for runs 2, 4, 7, 8 and 9. Source originals and sanitized exports remain local. Exact callback context is preserved without inventing observed frames, channel samples, pre-attachment configuration, trip outcomes or native replay fidelity. Existing CAP-01 acceptance limits remain unchanged. This implementation record is not a claim that the final code/review/CI gates have completed.

## ET-028 approved desktop presentation — October 21, 2026

ET-028 implements [the canonical Yukon UI](docs/design/ui-spec.md) on the existing read and committed-save boundaries: branded shell/native title overlay, Live instrument/full-width job, Journal/Trip header/four tiles/current-page chart, settings panels and informational Later screens. Onest 5.3.1 is offline in each isolated renderer. All existing raw fields, money distinctions, notes, cursor/export/refusal/security behavior and accepted Hard Mode drawer/hints remain. No protocol/preload/storage/native/qualification authority is added.

Accepted binding limits are explicit: Live trip aggregates/progress, list actual revenue, aggregate trip durations, application version and DB statistics are unavailable; account/sync/autostart/backup/show-overlay/opacity backends are not implemented. The overlay's existing numeric RPM fraction supplies its inner arc; formatted-only speed does not justify numeric speed progress, so the outer track is decorative. App-owned EN/RU copy is localized, while SDK cargo/city/company/vehicle names, raw enums/cvars and exact money/currency remain untouched. `GAME_HISTORY_RECORDING=false` is preserved.

Five development/packaged UI shards retain the global60s owned Job deadline and mandatory screenshots/receipt coverage; the settings read-only relaunch uses the unchanged future-version EN fallback. See [ET-028 evidence](docs/validation/et-028.md) for actual check outcomes and failures. Independent review/full verification/draft CI and manual DPI/native-caption/game-overlay/performance evidence are separate gates; implementation alone accepts none of them.

## ET-012e visibility implementation scope — October 21, 2026

The owner authorized saved overlay visibility (v5 `overlay.enabled`, default true), trusted boolean IPC, durable settings, gate-before-edit/driving behavior and the existing Yukon settings switch. This supersedes earlier statements that show/hide is only planned. Disabling after save cancels/discards unsaved placement; failed saves preserve it. Telemetry and recording behavior is unchanged.

The owner explicitly transferred multi-monitor, mixed-DPI, negative-origin, monitor-removal and off-screen manual checks to ET-042; the coordinator synchronized both task descriptions. Those checks remain unverified, with no inferred display acceptance. ET-012e still needs relevant single-monitor ETS2/ATS SP/TruckersMP windowed/borderless manual disposition and all code/review/CI gates. Preserve accepted ET-009 evidence and all historical ET-012a–d records. See [ET-012e validation](docs/validation/et-012e.md). No game launch, release or game-history enablement follows from implementation.

## ET-012 corrective shutdown allocation — October 21, 2026

The owner explicitly authorized bounded time redistribution and regression checks after the final recording-flush gate was FLAKY (failure followed by one passing diagnostic). Its original delay segment and operating-system cause remain unknown. This correction supersedes the fixed effective 500 ms statements in R14/H11; `RECORDING_FLUSH_BUDGET_MS` remains nominally 500 and registered phase maxima still total at most 2500.

Only `recording-flush` in the `flush` phase may borrow unused intake: let B=2500, I be the maximum registered intake budget, S the maximum registered storage budget, f the nominal flush-step budget and e the monotonic elapsed since sequence start at flush entry. Extra is `max(0, min(I - e, B - e - S - f))`, effective budget `f + extra`, with no grant for nonfinite/negative elapsed or empty intake. Parallel budgets use maxima, never sums. Ordinary intake lasting 0/300/1000 ms gives flush 1500/1200/500 ms. Other steps retain their nominal budgets.

ET-038 storage recalculates from actual elapsed after flushing, so lent time is not spent twice. Its nominal history budget floor, 800 ms grace floor, 200 ms termination reserve and the existing event-loop verdict turn remain. Scheduling can exceed the nominal wall-clock point; this is not an absolute physical deadline under arbitrarily late scheduling. Failure remains sticky; source-stop/no-ACK and final-sample/storage-close ordering are unchanged. See [policy](docs/app-lifecycle.md#recording-flush-allocation-et-012-correction) and [evidence](docs/validation/et-012e.md). Game-history recording stays disabled.

## ET-012 settings v6 integration — October 21, 2026

Accepted ET-031 main `bf17eea` owns settings v5 for autostart. The visibility extension is now v6, superseding earlier dated ET-012 prototype-v5 references. Migration v4-to-v5 remains autostart false; v5-to-v6 copies an object-valued overlay and adds enabled true, retaining every accepted autostart/language/unit/layout/section/placement preference. Malformed values retain independent fallback; startup never rewrites old bytes. No ambiguous second-v5 detection is used: the visibility-v5 schema was an unmerged prototype with temporary automated evidence and no exercised owner/game settings. Current v6 serializes both flags and older apps refuse it read-only. Autostart registration/hidden startup/uninstall behavior and the approved recording-flush allocation remain unchanged. See [settings](docs/settings.md) and [ET-012e](docs/validation/et-012e.md).

## ET-012e presentation followup — October 22, 2026

The owner requested smaller ordinary overlay values, bottom attachment, removal of the visible duplicate dashboard speed paragraph and integer live speed. This supersedes the earlier top-of-capacity presentation and one-decimal LIVE speed wording (including historical N7/S9), without changing canonical telemetry, numeric gauge geometry, journal/export precision or fuel decimals. The native window retains fixed worst-case capacity; an optional finite normalized display-only anchor aligns painted content with committed/draft y. No renderer measurement controls native size. Anchor-only publication retains the existing credit/epoch scheduler and capture/freshness/diagnostic identity. Drag start freezes geometry and painted anchor; release applies the existing bounds-to-fraction conversion. Its painted adjustment `(reservedHeight - paintedHeight) * deltaAnchorY` can be large and does not promise pointer-drop continuity. Sparse content/large capacity/near-bottom release requires owner retesting. See [minimal overlay](docs/minimal-overlay.md#painted-alignment-and-integer-live-speed-et-012e-october-22-2026) and [current evidence](docs/validation/et-012e.md). Earlier dated observations remain historical.


## ET-047 Hard Mode page — October 23, 2026

The owner requested a dedicated Hard Mode page between Live and Journal and clarified that all information belongs inline, removing the need for the checklist drawer. This supersedes the October 21 drawer presentation requirement only. The Live instrument spans the available content width; the global status and dashboard-lifetime observer remain. Preserve all twelve conditions, detected/required/state/reason/cvar evidence, source/age, first loss, bounded refresh and read-only/manual-delivery caveats in EN/RU. Navigation cannot restore qualification. UI work follows ui-ux-pro-max guidance within the existing Yukon design system. See [ET-047 validation](docs/validation/et-047.md) for actual checks and pending acceptance; no merge/release or real-history enablement is implied.

## ET-045c overlay bounds verification — October 24, 2026

Item 12 of [ET-045](https://trello.com/c/OmNYTBsp) amends the placement behaviour of ET-012b M7, ET-012c S7 and ET-012d K9 without a format or contract change. The overlay controller verifies the window's actual bounds against every requested rectangle, also when a sections change keeps the rectangle unchanged. A mismatch beyond 1 DIP per edge is applied again at most twice, while a hidden window stays hidden; the window is shown only once a rectangle is accepted. A window that keeps another size, on an axis changed by more than 2 DIP of rounding, is placed once at that size by the same fractions when it fits inside the client area, and a drop of such a window converts against that size. Otherwise the overlay hides fail-closed, and edit mode reports the existing `too-large` state, until the next distinct game client observation (a changed client rectangle, a gate that opens again, or the overlay enabled or loaded again) gives the request one more bounded verification. Saved scale and fractions, the edit draft, fit refusal, focus, click-through and the topmost re-assertion are unchanged. Settings, IPC, preload, the overlay payload, wire, storage and native code are unchanged. On the development machine at 150% a probe measured a 38 DIP minimum height for the overlay window; the mechanism and the owner's machine are unverified. See [the minimal overlay](docs/minimal-overlay.md#geometry-and-placements-et-012b) and [ET-045c validation](docs/validation/et-045c.md).

## ET-045d overlay numbers and typography — October 24, 2026

At the owner's ET-045 request (items 7, 8 and 2, October 23–24, 2026), under the owner's standing delegation, the coordinator adopted the architect's decisions W1–W8; the owner did not review them individually.

- **W1 stable widths.** Speed, gear and RPM carry a view-model reserve (`000`, `R0`, `0000`), rendered in the strip only as an invisible zero-height block in the value's own font, with right-aligned digits. Changes of digit count, reverse values and dashes never resize those sections or move a neighbour. No hard-coded pixel width, `ch` minimum or extra DOM text is used.
- **W2 RPM unit.** The overlay view splits telemetry-core's fixed `" rpm"` suffix into a number and a localized unit, like speed and fuel; other text stays whole and no number is parsed. `OverlaySectionView` and the payload are unchanged.
- **W3 scope.** Only speed, gear and RPM reserve widths; the other sections keep their content width under their caps.
- **W4 typography.** Values are slightly smaller in every layout and never below the 12 px labels (strip 17/19 px at weight 700, card rows 12 px with a 34/24/16 px hero speed, Cluster gauge speed 34 px with a 14 px gear and a 12 px RPM, Cluster panel 12 px, HUD 13/15 px); units and details are 12 px except the 11 px Cluster RPM unit, which is a unit, not a value.
- **W5 Cluster centre.** A three-row grid centres the speed exactly, with the gear above and the RPM below, each capped in width so every corner stays inside the inner ring at overlay scales 50%, 100% and 200%.
- **W6 no geometry change.** Row heights, strip caps, nominal sizes and window sizes are unchanged; the window size never depends on values.
- **W7 evidence.** Unit tests pin the texts; synchronous probes in the overlay UI shard measure the real renderer and restore every text; a few real source transitions run end to end.
- **W8 unchanged.** `OverlayPresentation`, preload, IPC, settings, presets, wire, storage, export, native code and `GAME_HISTORY_RECORDING`.

For typography only, this supersedes the ordinary-value sizes of the ET-012e presentation followup above. The owner's real-game retest remains pending in [ET-045d validation](docs/validation/et-045d.md); see [the minimal overlay](docs/minimal-overlay.md#stable-numbers-and-value-typography-et-045d-october-24-2026). No display, DPI or performance claim follows.

## ET-048 unified Overlay settings presentation — October 24, 2026

All existing overlay controls now share Settings > Overlay: visibility, layout, position/size, presets and grouped sections. The separate sections destination and cross-page action are removed; opacity remains Planned. One mounted card retains committed-save, main-owned draft, read-only/error and final-section behavior. This is presentation only; settings v6, IPC, geometry and ET-045 corrections are unchanged. See [ET-048 validation](docs/validation/et-048.md). Renderer zoom evidence does not establish Windows DPI, Narrator or real-game acceptance; ET-042/043/044/045 obligations remain unchanged.

Owner follow-up, October 24, 2026: remove the parenthetical technical requirement notes below individual section switches in both EN and RU. Labels, icons, toggles, presets, data-availability rules and the general unavailable/stale explanation remain unchanged. This supersedes earlier presentation instructions to show those per-section notes.

## ET-049 overlay background opacity — October 24, 2026

Owner follow-up, October 25, 2026: the slider shows one percentage to its right, updated during dragging. The separate Saved label is removed at the owner's request; committing, refusal recovery and background publication retain their existing durable-save behavior. The owner accepted the local UI preview and authorized the follow-up squash merge and ET-049 Done after targeted ETS2 windowed validation. This closeout does not turn unobserved game/mode/layout/light/DPI/Narrator/update checks into passes; their evidence limits remain in [ET-049 validation](docs/validation/et-049.md).

The owner requested implementation of [ET-049](https://trello.com/c/GyBnLV5M). Settings format v7 adds a shared per-user overlay background percentage, 40–100 in whole steps, default 80; v6 migrates in memory without startup writes and preserves all prior settings. The unified Overlay page shows a slider and one adjacent percentage that follows its draft during a gesture; one completed gesture/keyboard step submits a bounded durable save. Only a successful save changes the overlay. Its background token uses percentage/100, including both Cluster surfaces; Minimal keeps its backgroundless design. Foreground opacity, edit drafts, native window/input/freshness and recording remain unchanged. This supersedes opacity's unsupported status in the ET-028 snapshot only. Required real-game checks and code gates remain separate; see [settings](docs/settings.md#current-format-v7-background-opacity-et-049) and [validation](docs/validation/et-049.md).

## ET-045g Installed apps icon — October 24, 2026

Item 14 of [ET-045](https://trello.com/c/OmNYTBsp), under the owner's decision D3 of October 24, 2026, amends ET-018 U2: the install and updated events still never delete data, and now also write the Installed apps icon. Beside the shortcuts, `--squirrel-install` and `--squirrel-updated` place the bundled `resources/icon/app.ico` at Squirrel's `<install root>\app.ico` and set the `DisplayIcon` value of this product's HKCU uninstall entry to icon 0 of the versioned executable, through a fixed `reg.exe` call with one retry. They run before Squirrel's own registration, which then neither downloads electron-winstaller's default Electron icon nor overwrites the value. The step never touches the data root, another key or another value, and a failure changes neither the shortcuts, the deferral cancel nor the exit code. `iconUrl` stays the default. The obsolete and uninstall events, the uninstall engine, its roots and allowlist, the names, the Squirrel id and the Setup file name (ET-045h) are unchanged. The hosted installer lifecycle asserts the registration and both icon files after every install, repair and update; the real Windows Settings view remains an owner check. See [releases](docs/release.md#installed-apps-icon-et-045g) and [ET-045g validation](docs/validation/et-045g.md).

## ET-045e rebased overlay scale and strip width — October 24, 2026

Items 9 and 6 of [ET-045](https://trello.com/c/OmNYTBsp), under the owner's decisions of October 24, 2026: D1 option b (saved scale numbers are kept and reinterpreted so the new 100% equals the old 70%; the range is 50–300%) and D5 (the strip is never narrower than at scale 1). Under the owner's delegation the coordinator adopted the architect's decisions Z1–Z9; the owner did not review them individually.

- **Z1 units.** The scale range is [0.5, 3] in 0.1 steps with default placements at 1. `OVERLAY_SCALE_ZOOM = 0.7` and the pure `overlayZoom(scale) = round(scale × 700) / 1000` live in `overlay-placement.ts`. Multiplying the saved values, storing the zoom and applying 0.7 in CSS were rejected.
- **Z2 one boundary.** Placements, `overlay-edit:set-scale`, `AppState.overlayEdit.scale`, the dashboard and diagnostics carry the setting; only geometry internals, `setZoomFactor` and `webPreferences.zoomFactor` use the zoom.
- **Z3 strip width.** `floor(min(1280 × max(1, scale), cw − 32))`, at least `round(480 × zoom)`, with rows at `floor(width / zoom)`; created `round(1280 × max(1, scale))` wide. `cw` is always the game client, never the display.
- **Z4 card, cluster, HUD.** ET-012d's formulas with the zoom; the new 100% is pixel-identical to the old 70%.
- **Z5 settings v8.** (ET-049 took v7 first, so ET-045e uses v8.) An identity v7-to-v8 step keeps every number (`migratedFrom: 7`); validation is [0.5, 3]; out-of-range values fall back alone and are never clamped; no startup write. Older builds, including ET-049, read v8 as newer-version. Not bumping was rejected because an older build would misread the numbers or replace values above 2.
- **Z6 IPC.** `parseOverlayEditScale` accepts one finite number in [0.5, 3], rounded to two decimals; no new channel, bridge method or preload key.
- **Z7 controls.** The existing Smaller/Larger buttons and "Scale: N%"/"Размер: N%" show the setting and disable at 50% and 300%; Reset returns to 100%. No new strings and no slider.
- **Z8 small zoom.** No product clamp and no minimum font size; Chromium's text behaviour at zoom 0.35 is measured by the UI smoke and recorded, containment is gated. The 16 DIP strip at 50% relies on ET-045c's bounded fit to the measured minimum height.
- **Z9 owner comparison.** Reference screenshots of the new 100% and the old 70% and 100% strip go to the run output and ignored `.local/`; nothing is committed.

For the scale's range and meaning, the strip width and the window sizes, this supersedes M2's and M4's [0.5, 2] range and `1280 × scale` width, M10's set-scale range and the window sizes stated by ET-012c, ET-012d and ET-028 above, and settings v7 (ET-049) as the current format; earlier dated text is unchanged. See [the minimal overlay](docs/minimal-overlay.md#rebased-scale-and-strip-width-et-045e-october-24-2026), [settings](docs/settings.md) and [ET-045e validation](docs/validation/et-045e.md). No display, DPI, game or performance claim follows.

## ET-045h product name — October 24, 2026

Item 13 of [ET-045](https://trello.com/c/OmNYTBsp), under the owner's decision D2 of October 24, 2026 (display names only; the Setup file becomes `YukonUnionTelemetry-Setup-<version>.exe`). The user-facing name is **Yukon Union Telemetry**: the Installed apps DisplayName (nuspec `title`), the executable's ProductName and FileDescription (the shortcut name), the tray, the dialogs, the EN/RU copy, the deferral README and the executor's message box. Every technical identity stays: `productName` `ETS2Telemetry Desktop` (userData, the single-instance lock, the O7 Roaming folder), the Squirrel id `ETS2TelemetryDesktop` (install root, Uninstall key, AUMID), the executable, `appBundleId`, the data root, the plugin DLL, pipes, environment variables, the RunOnce value and the receipt, export and diagnostic schemas and file names.

This amends ET-018 U14 (the Setup name) and U2: besides the shortcuts and the ET-045g icon, `--squirrel-install` and `--squirrel-updated` delete this install's old `ETS2Telemetry Desktop.lnk` shortcuts, and `--squirrel-uninstall` removes them after `--removeShortcut`. They still never delete data. Coordinator decisions under the owner's ET-045 delegation:

- **H1.** The Publisher (nuspec `authors`) becomes "Yukon Union Telemetry contributors": display text, covered by D2.
- **H2.** The executable's CompanyName is pinned to the value packager inferred before, "Artur Sianiuk", so the Start menu folder stays where it was, deliberately.
- **H3.** An old shortcut is removed only after the new one exists, only at Squirrel's two exact locations, and only when the ownership predicate holds (no AUMID or Squirrel's, and a target of this install's stub, an `app-<version>` executable or `Update.exe --processStart`). A foreign or unreadable one is kept; a kept old shortcut still starts the application, and the next install or update tries again. The step has a 1 s budget beside the deferral disarm, so the hooks' 12 s worst case is unchanged.
- **H4.** No receipt schema change: `shortcuts` is `removed` only when `--removeShortcut` succeeded, no owned old name failed to delete and none was left undecided (past the step's deadline, uninspectable or unreadable; fix round 1). i18n keys keep their ids.

Taskbar and Start pins keep their old label until the user pins again; a Start Menu redirected apart from Roaming AppData is not found. The hosted installer lifecycle plants the old names (L1-L3) and asserts the new DisplayName and Publisher, one Uninstall entry, one new-name shortcut per location and the executable's version resource. See [releases](docs/release.md#product-name-et-045h) and [ET-045h validation](docs/validation/et-045h.md).

## ET-045f Cluster speed arc — October 24, 2026

Item 3 of [ET-045](https://trello.com/c/OmNYTBsp), under the owner's decision D4 of October 24, 2026: the Cluster shows speed on the outer ring and RPM on the inner ring, with a validated numeric overlay payload field. The coordinator adopted the architect's decisions Y1–Y9 under the owner's delivery authorization for ET-045; the owner did not review them individually.

- **Y1 field.** The `value` variant of `OverlaySectionView` gains the optional `speedRing`, set only on the speed section of a current projection with an available, finite speed: the fraction in [0, 1] of the speed gauge scale of the displayed game's unit profile, 0 while the displayed integer is 0. It is absent while the speed is unavailable, stale, not current or disabled. Reusing `ring` on the speed section and a top-level field were rejected.
- **Y2 one scale rule.** `apps/desktop/src/speed-gauge.ts` holds `SPEED_GAUGE_FULL_SCALE` (130 km/h, 80 mph) and `speedGaugeFraction`, which uses telemetry-core's conversion and the overlay's own speed formatter and never reads display text. The dashboard's Live instrument uses the same helper for its ratio and scale, with unchanged behaviour.
- **Y3 reverse.** A negative speed gives 0 (no arc); the centre still shows the signed number.
- **Y4 validation.** `isGaugeFraction` (a finite number in [0, 1]) and `overlayGauges` in `overlay-sections.ts`: main attaches `speedRing` and the RPM `ring` only when valid, and the overlay preload applies `overlayGauges` to every delivery before its expiry and listener, so a malformed fraction is dropped without dropping the update or the channel.
- **Y5 geometry.** The arc lies on the existing outer track (radius 52, stroke 6) from 12 o'clock clockwise, with dash array `C C` (C = 2π × 52) and inline offset C × (1 − fraction), drawn only above 0, in the order speed track, speed arc, RPM track, RPM arc. The ET-045d centre grid is unchanged.
- **Y6 motion.** `transition: stroke-dashoffset 150ms linear`, and `transition: none` under `prefers-reduced-motion: reduce`. The arc appears and disappears instantly; the RPM arc stays static.
- **Y7 colours.** The speed arc uses `--yu-ov-accent` (#60A5FA) and the RPM arc the new token `--yu-ov-rpm` (#2563EB), following the ui-spec's `overlay.cluster`; the RPM colour is an owner review point.
- **Y8 unchanged.** Window sizes, rows, caps, typography and reserves, the strip, card and HUD, settings, presets, IPC channels and bridge methods, the dashboard preload, the wire, storage, export, native code and `GAME_HISTORY_RECORDING`.
- **Y9 evidence.** Unit tests pin the fractions, validators, view and markup; the overlay UI shard reads the real renderer's arc, transition and reduced-motion behaviour ([ET-045f validation](docs/validation/et-045f.md)).

This records the overlay payload change authorized by D4: the overlay projection now carries a second validated number. For the Cluster only, it supersedes the ET-028 statement that the outer speed track is decorative; earlier dated text is unchanged. No game, display or performance claim follows.

## ET-050 gear display mode — October 25, 2026

[ET-050](https://trello.com/c/y4TUoF6u): a gear display mode for manual range-splitter gearboxes. The coordinator adopted the architect's decisions GD1–GD8 for this card; the owner did not review them individually.

- **GD1 per game.** The mode is chosen per game (`ets2`, `ats`), like the unit profiles, because the trucks and gearboxes a driver uses differ by game. Values are exactly `automatic` and `manual`; the default is `automatic` for both. Without a displayed game, or before the settings arrive, automatic applies.
- **GD2 formula.** Neutral (0) is `N` and reverse −n is `Rn` in both modes. Automatic shows a forward gear g as `g`. Manual shows it as `ceil(g / 2)` followed by `L` for odd g and `H` for even g: 1 is `1L`, 2 `1H`, 3 `2L`, 16 `8H`. This is a uniform simplification of a range-splitter pattern; it does not know the actual gearbox layout, so crawler gears and 10-, 13- and 18-speed layouts may not match the in-game display. A gearbox-aware mapping would need the SDK's H-shifter configuration, which neither protocol carries; it is out of scope.
- **GD3 settings v9.** The settings move to format v9 with a `gearDisplay` block after `units`. The pure v8-to-v9 step adds automatic for both games and replaces any stray pre-v9 key. Per-game fallbacks never coerce. Version 10 or later is newer-version, and builds before ET-050 read v9 as newer-version, so they never drop the mode. Startup writes nothing; the first save of any setting writes v9.
- **GD4 one narrow setter.** `setGearDisplay(game, mode)` over `settings:set-gear-display`, in the ET-049 and ET-012e pattern: exact arity and enums validated in the preload, in main (trusted dashboard main frame only) and in the store; the shared four-request durable queue; facts `{game, gearDisplay}`. No renderer authority is added.
- **GD5 formatting in telemetry-core.** `formatGear(index, mode)` and the mode type live in `packages/telemetry-core`; `buildLiveView` and `liveSources` take the mode, which is kept out of `DisplayUnits` because it is not a unit. Main formats the overlay text; the overlay renderer still receives only formatted text, and its preload and payload type are unchanged.
- **GD6 strip reserve.** The strip's gear reserve becomes mode-independent: the widest of `R0`, `0H` and `0L`, rendered on separate lines by the invisible reserve block. For the gear only, this supersedes ET-045d W1's `R0`; the 90 px cap, row heights, window sizes and the row model are unchanged.
- **GD7 raw values elsewhere.** The protocols, SQLite, the one-second samples, the journal's sample table (which keeps the automatic form) and the JSON export keep the raw integer gear index. Hard Mode and the tray show no gear.
- **GD8 Latin L and H.** The `L` and `H` suffixes are not translated in Russian; the localization of measurement units leaves them untouched.

No wire, fixture, native, schema, recording-eligibility or release change follows, and `GAME_HISTORY_RECORDING` stays `false`. Real-game agreement of the labels with the in-game dashboard, readability and frame time remain pending in [ET-050 validation](docs/validation/et-050.md).

## ET-050b gearbox-aware gear labels — October 25, 2026

[ET-050](https://trello.com/c/y4TUoF6u), package ET-050b. In the owner's ATS session the Mack's game HUD shows gear `LL` where the ET-050 manual formula shows `1L`. The CAP-01 captures show that the SDK's `hshifter` configuration describes the real layout: 32 slots of handle position and selector bits, of which the 18-speed Mack uses crawler position 3 for gears 1 and 2. On October 25, 2026 the owner approved the plan with decisions B1–B9 and the delivery of six PRs in order through squash merge (translated from the chat: "Approve the ET-050b plan with recommendations B1–B9 (protocol v1 minor 1 with state.gearbox, two modes and settings v9, reverse R1..Rn, crawler L/LL/LH). Deliver the six PRs in order through squash merge.").

- **B1 wire.** Protocol v1 minor 1 adds `state.gearbox` to checkpoints and snapshots only. The client hello stays at version 1.0 and offers `maxMinor` 1; the server selects min(`maxMinor`, its own maximum). The welcome's `data.minor` and the envelope of the welcome and of every later message in both directions then carry `{1, selected}`. A consumer rejects a minor that changes within a connection, a welcome minor above its own `maxMinor`, a minor-0 state that has `gearbox` and a minor-1 state that lacks it. Minor-0 bytes, fixtures and expectations are unchanged, and skew is safe both ways: an old plugin with a new application, or a new plugin with an old application, negotiates minor 0 and the formula applies. Rejected alternatives: extending `truck.configured`, a new durable event, an optional field in minor 0, a v0 change and an application-side truck model table.
- **B2 shape and bounds.** `gearbox` is `{forwardGears, reverseGears, hshifter}`. The counts are availability integers 0–100 from the latest truck configuration callback; a truck clear makes them not-observed. `hshifter` is an availability of `{selectorCount: 0–6, slots}` from the latest `hshifter` callback: every SDK slot whose gear is not 0, in SDK slot order, at most 64, each `{gear: −100..100 and not 0, handlePosition: 0–255, selectors: below 2^selectorCount}`, with unique (handlePosition, selectors) pairs. An empty callback is not-observed; a null list, a type mismatch, an incomplete slot triple, a slot index of 64 or more, an out-of-range value, a duplicate pair or disagreeing `selector.count` copies make it `invalid`; it is never truncated. `shifter.type` is not carried. The block sits outside `configuration`: the `hshifter` callback increments no revision, assigns no `eventSeq` and emits no event.
- **B3 modes.** ET-050's two modes and settings v9 stay. `manual` shows labels derived from the gearbox while a valid layout is current, otherwise the GD2 formula. A valid layout without selectors shows plain numbers in manual mode.
- **B4 reverse and neutral.** Reverse stays `R1`…`Rn` and neutral `N`.
- **B5 crawler.** Exactly one crawler handle position is named `L` when it has no splitter pair and `LL`/`LH` when it has one, in both games. It is a single constant, which an ETS2 crawler observation may change. More than one crawler position falls back to the formula.
- **B6 freshness.** A layout applies only while the v1 projection is carried and current (500 ms), its truck model id equals v0's (the ET-045a same-truck rule) and the layout validates against the counts; otherwise the formula applies. A stale layout is never held.
- **B7 projection.** The live update's v1 projection gains `state.gearbox`, validated in main and in the dashboard preload; under minor 0 every part is `{available: false, reason: 'not-supported'}`. No IPC channel or bridge method is added, and the overlay renderer still receives only formatted text.
- **B8 strip reserve.** The strip's gear reserve becomes `R0`, `0H`, `0L`, `LH`, `LL`. For the gear only this supersedes GD6; the 90 px cap, row heights and window sizes are unchanged.
- **B9 delivery.** Six PRs in order, each from `main` after the previous one merges:
  1. PR-1, the TypeScript minor-1 contract, its fixtures and this record;
  2. PR-2, the pure label derivation in telemetry-core, not yet called;
  3. PR-3, the matching C++ contract, which reads the minor-1 fixtures; the plugin still selects minor 0;
  4. PR-4, the plugin's capture of the `hshifter` and truck gear counts and minor-1 encoding;
  5. PR-5, the service, the live projection and the simulator at minor 1;
  6. PR-6, the dashboard and overlay presentation.

For ET-050b, B1 supersedes GD2's statement that a gearbox-aware mapping is out of scope because neither protocol carries the H-shifter configuration, and the statement in [protocol v1](docs/protocol/v1.md) §2 that `version` is always `{"major":1,"minor":0}`, which now holds for minor-0 connections and for every hello. Earlier dated text is unchanged.

PR-1 status (October 25, 2026): the TypeScript contract in `packages/contracts/src/protocol-v1.ts` and `protocol-v1-delivery.ts` implements B1 and B2 with minor-1 fixtures in `tests/fixtures/protocol-v1/minor1`. Every stateless entry point stays at minor 0 unless its caller opts in with `maxMinor: 1`, and the frozen minor-0 corpus is byte-identical. The plugin, broker, simulator and desktop application still negotiate minor 0, so no runtime behaviour changes (true at PR-1; PR-4 and PR-5 moved them to minor 1, see the completion status below). The labels are an inference from the SDK layout, the SCS modding documentation and a non-primary community description; mods may differ, and the ETS2 crawler naming is unobserved. `GAME_HISTORY_RECORDING` stays `false`. Every real-game check remains pending in [ET-050b validation](docs/validation/et-050b.md); no game, TruckersMP, display or performance claim follows.

Completion status (October 25, 2026, PR-6): all six PRs are implemented. PR-1 (#186, `93bbf8b`), PR-2 (#188, `4e215e6`), PR-3 (#189, `de94e0c`), PR-4 (#190, `7ecc846`) and PR-5 (#191, `4609f84`) are merged; PR-6 is under review.

- **Delivered behaviour.** The plugin (PR-4), the native broker, the simulator and the telemetry service (PR-5) negotiate minor 1. An older plugin answers minor 0, its projected gearbox is `not-supported` and manual mode keeps the GD2 formula. `liveSources` in `apps/desktop/src/live-sources.ts` derives the manual labels with `deriveGearLabels` under B6, so the Live instrument, the Live details row and all four overlay layouts change through that one point; automatic mode is unchanged. The strip's gear reserve is `R0`, `0H`, `0L`, `LH`, `LL` (B8, which supersedes GD6 for the gear only).
- **PR-2 step-2 amendment (coordinator decision applying B3 and B5, not an owner B-decision).** A selector bit with no same-position forward pair of different gears is unused and ignored, so the SDK's always-declared second selector bit does not push a range-only or selector-less gearbox back to the formula. A cell collision rejects: when ignored bits fold slots with different gears into one cell state, the layout is unrecognized. A mixed bit and a second bit of the same kind are still rejected.
- **Unchanged.** Settings stay format v9 with the two modes; the protocols, SQLite, samples, journal and export keep the raw gear index; no IPC channel or bridge method was added; `GAME_HISTORY_RECORDING` stays `false`. Nothing is released.
- **Pending.** Every real-game check listed in [ET-050b validation](docs/validation/et-050b.md#pending) remains with the owner. No game, TruckersMP, display or performance claim follows.

### ETS2 crawler amendment — October 26, 2026

In ETS2 the owner drove a Scania with the Opticruise GRSO925R (12+2) in manual mode. The game's dashboard showed `C1` where the overlay showed `1L`. The owner's CAP0 capture of that truck (sanitized and kept local) shows the cause. The `hshifter` layout has a range bit and a splitter bit. Gears 1 and 2 sit on handle 2 together with the high-range gears 9 and 10, and handle 5 holds gears 7 and 8 without high-range gears. The PR-2 derivation took the position without high-range gears for the crawler: handle 5's gears are not the lowest, so it rejected the layout and the overlay fell back to the formula.

- **B5 amended by the owner.** The crawler is named by the source's game: ETS2 `C1`/`C2` with a splitter pair, ATS `LL`/`LH`. A crawler without a splitter pair is `C` in ETS2 and `L` in ATS. Neither game has shown one yet. This supersedes B5's single constant.
- **Crawler detection (coordinator decision applying B5).** With a range bit, the derivation compares the ranges cell by cell instead of by handle position. A high-range cell that repeats its position's low-range gears is dropped. When the low range holds exactly one cell more than the high range, its lowest cell is the crawler, which must lie below every other cell. That cell may share its handle position with high-range gears (the Scania) or not (the Mack). The other low-range cells are numbered 1..n by ascending gear and the high-range cells n+1..2n. Every other difference between the ranges, among them more than one extra cell, still falls back to the formula, as does any label order that is not strictly ascending.

The Mack 18-speed, the ETS2 12-speed and the synthetic layouts keep their labels. Only `deriveGearLabels`, which gains the game, and its caller in `live-sources.ts` change. There is no wire, settings, IPC, storage or native change. The real-game check of the corrected Scania labels and every other ETS2 crawler gearbox remain pending in [ET-050b validation](docs/validation/et-050b.md#ets2-crawler-amendment--october-26-2026).

### ETS2 crawler gear mode — October 26, 2026

On the corrected build the ETS2 Scania Opticruise G38CMR (13+1) still showed `1L` where its dashboard showed `C`. The owner's CAP0 capture of that truck (sanitized and kept local) reports 14 forward and 8 reverse gears. Its forward H-shifter slots are identical to the GRSO925R's, but its H-shifter reaches only reverse gears 1–4. The owner read its dashboard as `C, 1, 2, 3…` and `R1…R4`, while the GRSO925R with the same forward slots reads `C1, C2, 1L…6H`. The game takes these names from each transmission's own definition, which the SDK does not expose, so no layout rule can tell the two gearboxes apart. The owner chose option B on October 26, 2026:

- **A third gear display mode, `crawler`.** Gear 1 is the displayed game's single crawler name (`C` in ETS2, `L` in ATS, as in the amended B5), every higher gear g is shown as g − 1, neutral is N and reverse R1…Rn. The mode uses no gearbox layout and therefore no v1 projection. It is chosen per game on Settings > Units like the other two modes; it does not detect the gearbox. The settings file moves to format v10 by an identity step from v9, so an earlier build reads it as newer-version instead of dropping the mode on its next save.
- **Reverse gears beyond the H-shifter.** The derivation's step 1 now requires only that the reverse slot gears lie in −1..−R, not that they cover every reverse gear. Reverse is always R1…Rn (B4), so an H-shifter that reaches fewer reverse gears than the truck reports no longer makes the layout unrecognized. In manual mode the G38CMR therefore derives the GRSO925R's forward labels; its dashboard names are the crawler mode's.

The automatic rule (option A: switch naming when the truck reports more reverse gears than the H-shifter holds) was not adopted, because it rests on two observed gearboxes. There is no wire, IPC channel, storage or native change; the settings format, the gear display contract and the diagnostic bundle's accepted values change. Real-game checks remain pending in [ET-050b validation](docs/validation/et-050b.md#ets2-crawler-gear-mode--october-26-2026).

### Per-gearbox gear display modes reverted — October 27, 2026

Per-gearbox gear display modes reverted (October 27, 2026): PR #204 (`ecb08e37`) added a gear display mode per gearbox (the SDK truck model id with its forward and reverse gear counts) and settings format v12, after the owner's Scania GA867R 6-speed automatic, which the SDK describes with the same H-shifter pattern as the crawler gearboxes, showed `C` and `C1` instead of `1…6`. The owner then judged the design too complex and asked to roll it back, so this revert restores the per-game modes of #200 and settings format v11. The GA867R case is unresolved: with ETS2 on **Crawler first** or **Manual range-splitter** it still shows `C` or `C1`, and choosing **Automatic** for ETS2 shows `1…6`. No released or installed build carried v12; a development profile written by a build of `ecb08e37` reads as newer-version (read-only defaults) after this revert. The owner's GA867R capture (sanitized, kept local) remains the evidence for any later approach; a threshold on the gear count and gear ratios on the wire were considered and not adopted.

## Game history recording enablement — October 25, 2026

On October 25, 2026 the owner authorized lifting the recording block and preparing the telemetry for recording a real trip (see [AGENTS.md](AGENTS.md#game-history-recording-enablement--october-25-2026)). `GAME_HISTORY_RECORDING` is now `true`, which supersedes the R3 value above and the "stays `false`" notes of the ET-015 to ET-018 sections; those dated sections are otherwise unchanged. Production game selections are durable over protocol v1 into the history database; the v0 retirement is not a prerequisite (the intent of D2, that recording never ships on v0, holds because recording is v1 only); TD-021 keeps the fail-closed `SESSION_CONFLICT`. No wire, schema, IPC or native change follows. The first real recorded trip and every real-game, TruckersMP and performance check remain pending in [the enablement validation](docs/validation/game-history-enablement.md).

## ET-052 mandatory break and protocol v1 minor 2 — October 26, 2026

[ET-052](https://trello.com/c/ZQCdMLy9) shows the time until the next mandatory break in the overlay. The card carries four owner decisions, labelled D1–D4 here as on the card (they are not the protocol v1 decisions D1–D17 above): D1 the SDK channel `mandatory.break` only (not `rest.stop`); D2 a new overlay section that is on by default, including for users who upgrade from settings v9, with a coffee-cup icon; D3 a value of zero or less shows `0` in red, 1 to 119 minutes show orange and 120 or more show the normal colour; D4 the value is live only and never recorded. On October 26, 2026 the owner approved the plan, which adds protocol v1 minor 2, settings v10 with a migration from v9, a validated `urgency` on the overlay sections and a `nextMandatoryBreak` field on the live projection, and the architect's recommendations on its open points 2–7 (translated from Russian: "I approve the ET-052 plan with the architect's recommendations on points 2-7 (dash, the 120 boundary, presets unchanged, underline, windows growing by one row). Continue with all five PRs."). MB1–MB12 distil the plan's design decisions. They are coordinator decisions adopting the architect's plan under that approval; the owner did not review MB1–MB12 individually. The approval authorizes the five PRs and no merge or release.

- **MB1 wire.** Protocol v1 minor 2 adds `state.nextMandatoryBreak` to checkpoints and snapshots, after `gearbox`: `{"available":true,"value":95,"unit":"min"}` or `{"available":false,"reason":"not-observed","unit":"min"}`. Minor 2 carries the gearbox and the break, minor 1 the gearbox only and minor 0 neither; a missing or extra key for the envelope minor is invalid. The value is a plain JSON integer in the s32 range, negatives included, because the SDK channel type is s32; whether the game reports an overdue break as a negative value is unobserved, so the signed range rests on the SDK type alone. It is deliberately not the canonical u64 decimal string of `GameMinutes`, although its unit is also `min`; the specification says so. The worst-case checkpoint is 55,473 bytes. Rejected: an optional field in minor 1 (it would change frozen bytes), a top-level availability without a unit, and a new durable event (D4).
- **MB2 minor selection.** The server selects `min(hello maxMinor, its own maximum)`, as [protocol v1](docs/protocol/v1.md) §4 already specified. The TypeScript and C++ code deviated from that text: they selected 0 whenever the offer was below the server's maximum, which was harmless while the maximum was 1; with a maximum of 2 a minor-1 application would have been served minor 0 and lost its gearbox labels. PR-1 fixes the TypeScript `negotiateV1` and PR-2 the C++ `negotiate`, which the native broker also calls, to match §4. This is a code fix, not a change of the specification.
- **MB3 inert until the service PR.** `V1_MAX_MINOR` becomes 2 in PR-1, but every place that makes an offer stays pinned to the literal 1 with a comment: the service's `V1_CLIENT_MAX_MINOR`, the simulator producer's maximum and the simulator client's default offer. PR-4 flips them, and the plugin endpoint is pinned to 1 in PR-2 and lifted in PR-3. Decoders and storage may accept minor 2 earlier, so the running application does not negotiate minor 2 until PR-4. Skew is safe both ways: a new application with an old plugin negotiates 0 or 1 and the break is `not-supported`, and an old application with a new plugin negotiates 1.
- **MB4 optional capture (PR-3).** The plugin registers `mandatory.break` as an optional channel. A NULL value is `not-observed`, a zero is an available 0 and a value of another type is `invalid`. Any non-OK registration result for this channel alone makes the break `not-supported` and never fails plugin initialization, while the core channels stay strict. The v0 diagnostics and CAP0 do not record it.
- **MB5 below minor 2.** A live projection built from a minor-0 or minor-1 connection reports the break as `NOT_SUPPORTED_BREAK` (PR-4), and the normalized reading is `not-supported`; v0 does not carry the field. PR-1 added the constant and the reading, and PR-4 projects it: the live projection always carries `nextMandatoryBreak`.
- **MB6 boundary and clamp.** Urgency follows the raw value: zero or less is `due`, 1 to 119 is `soon`, 120 or more is `normal`, so exactly 120 minutes is normal. The text clamps at zero (`0 min`), then formats `H h M min`. The wire, the reading and the projection keep the signed value; the clamp is presentation only.
- **MB7 urgency enum.** The overlay renderer stays display-only, so the urgency travels as a validated enum (`soon` or `due`, absent when normal) on the overlay section view and is checked again in the overlay preload (PR-5). Only the `mandatory-break` section in the value state may carry it, and a stale section drops it.
- **MB8 section.** Overlay section id `mandatory-break`, appended last, in the existing `time` group after game time, on by default, with a coffee-cup icon and the labels "Next mandatory break" ("Break" in the strip) and "До обязательного перерыва" ("Перерыв"). It needs protocol v1, and the strip gives it a width cap of its own (PR-5).
- **MB9 dash semantics.** A carried v1 observation without a value (not supported, not observed, or stale v1) shows a dash; a v0-only source keeps the ET-012a L5 rule (hidden unless it was shown before). The dashboard row is hidden for sources without v1 and reads "unavailable" with its reason when v1 is carried. This deviates from a literal reading of "a v1-less session shows a dash" and was approved as point 2.
- **MB10 non-colour cues.** The dashboard row shows an icon and a word (soon, due) in a badge. On the overlay the cue is partial: a `soon` item is orange plus an accessible name with the state word (for sighted users colour is the only visible cue), and a `due` item is red plus the underline plus the accessible name, its text reading `0 min` (PR-5). ET-045b asks that a severity not rely on colour alone, and the owner approved an underline for due only; this is an open readability point for the owner's real-game check. The colour tokens are checked for contrast on the overlay background. Whether assistive technology exposes that accessible name is unverified: ARIA does not allow naming a role-less element, and the overlay is click-through and not focusable, so a screen reader may never reach it; a Narrator check is pending.
- **MB11 settings v11.** Settings move to format v11 (planned as v10; ET-050b took v10 for the crawler gear mode on October 26, 2026, so the step is keyed 10) by a pure migration: a v10 file whose `overlay.sections` is a record gains `mandatory-break: true` on a copy, so the section is on for upgraders and every other choice, the crawler mode included, is preserved; anything else is left to the existing fallbacks. There is no startup rewrite, version 12 or later is `newer-version`, and a build from before ET-052 reads v11 as `newer-version`. The preset `everything` includes the section; `job-focus` and `driving-only` are unchanged (point 4).
- **MB12 side effects and non-goals.** Fifteen sections instead of fourteen grow the default Card, the Cluster side panel and the Minimal HUD by one row each (384 to 408, 267 to 288 and 354 to 378 at scale 1), and the default strip stays three rows at 1280 CSS px (point 6). The ET-012d sizes in AGENTS.md stay historical. D4 holds: the value is never stored, so it is not in samples, trips, the journal, the export, SQLite or the schema, and recorders, the sampler and trip accounting do not read it. `rest.stop`, alerts and sounds, a conversion to real time, the v0 retirement, Hard Mode, CAP0, the v0 wire, `GAME_HISTORY_RECORDING`, the installer and plugin setup, new IPC channels or bridge methods and the TD-021 decision are out of scope.

PR-5 finding on MB12 (October 26, 2026): MB12's "the default strip stays three rows at 1280 CSS px" holds at zoom 1, but the product's setting 1 renders at zoom 0.7 (ET-045e), where the strip's CSS width is 1828 and fourteen sections fitted two rows (56 DIP): the second row ended at game time (1704 of the inner 1801) and the break's 150 px plus the 14 px gap reach 1868. So the default strip at the setting 1 grows from two rows to three, 56 to 82 DIP, on top of the one-row growth of the card (270 to 287 DIP), the cluster (188 to 203) and the HUD (248 to 265). The unused strip rows stay transparent, and the visible surface takes only the rows its values need; the click-through over the taller transparent window is an owner check. The break's 150 px cap was kept, because no cap that makes the item usable (an icon and "00 h 00 min") fits the 83 px left in the second row.

For ET-052 only, MB1 supersedes two earlier statements: that a server selects minor "0 or 1" (ET-050b B1 and [protocol v1](docs/protocol/v1.md) §2, §4) and that "minor 1 differs from minor 0 only by `state.gearbox`" (§2). MB2 supersedes nothing: it aligns the code with §4. Earlier dated text is unchanged.

Delivery is five PRs in order, each from `main` after the previous one merges:
1. PR-1, the TypeScript minor-2 contract, the negotiation fix, the minor-2 fixtures, the pure break rules and reading in telemetry-core and this record;
2. PR-2, the matching C++ contract, which reads the minor-2 fixtures, with the plugin endpoint pinned at minor 1;
3. PR-3, the plugin's capture and encoding of the break and its endpoint at minor 2;
4. PR-4, the service, the live projection, the simulator, the broker tests and the dashboard row, which is the first user-visible change;
5. PR-5, settings v11, the overlay section, its colours and the user documentation.

PR-1 status (October 26, 2026): implemented as the TypeScript contract and the pure telemetry-core rules; nothing at runtime offers, serves or shows the break, and no screen changed. Every real-game check (that the channel updates in ETS2 and ATS, single-player and TruckersMP; what it reports with the simulation off, after a save load, a ferry or a train, and in an old save; overlay readability and colours at 40 to 100 % opacity; the installed settings update from a build with v10 to one with v11 (and an older build reading v11 as newer-version); frame-time impact) remains with the owner in [ET-052 validation](docs/validation/et-052.md). No game, TruckersMP, display or performance claim follows.

PR-4 status (October 26, 2026): the telemetry service offers minor 2 and the Live details card shows the break (the first user-visible change); the simulator serves minor 2 (with `source.highestMinor` to model an older plugin), the live projection carries the raw break, and a storage test proves that nothing records it (D4). The release constraint in AGENTS.md (the ET-052 authorization) holds: PR-3 and PR-4 ship in the same release. The overlay section and settings (planned as v10; v11 after ET-050b took v10) (PR-5) follow.

## ET-055 in-app updates and staging channel — October 28, 2026

[ET-055](https://trello.com/c/XtO5RKn6) adds in-app updates and a staging build channel that installs and runs beside production. On October 28, 2026 the owner approved the architect's plan (revision 2) with the architect's recommendations on UP1, UP5, UP9, UP12 and UP16, and authorized the coordinator to run the deliveries without asking again and to squash merge each PR after its tests and independent code review pass. Publishing a release still needs the owner (UP16 below defines what counts as that authorization for staging). UP2, UP4, UP6, UP10, UP11, UP13, UP14 and the release model of UP16 record owner decisions and requirements taken on the card on October 28, 2026, with the coordinator supplying the details named; the other decisions are coordinator decisions under that approval, which the owner did not review individually.

| # | Decision |
| --- | --- |
| UP1 | Owner: in-app updates and a staging channel are authorized. No server-phase work follows |
| UP2 | Owner: an update downloads and installs only after the user clicks |
| UP3 | No Electron `autoUpdater` (it applies updates without a click, has no timeout on `Update.exe` and quits past the explicit exit). After the click, main downloads the nupkg into `<data root>\updates\<NuGet version>\` (at most 400 MiB, 60 s stall, 30 min total, `.partial` then rename), verifies SHA-256 and SHA-1 against the signed manifest, writes its own one-line RELEASES, runs `<install root>\Update.exe --update <folder>` (180 s), and after the explicit exit starts `Update.exe --processStartAndWait <exe>` detached |
| UP4 | Owner: production updates from ordinary GitHub Releases (tag `v<version>`, `releases/latest/download/update-manifest.json` and its `.sig`); staging from GitHub pre-releases tagged `staging-v<version>`, chosen as the highest NuGet version in the public REST release list regardless of its order. The signed manifest binds the channel, the source tag and the exact nupkg name `<Squirrel id>-<NuGet version>-full.nupkg` (exact equality, never a prefix test) |
| UP5 | Owner: an Ed25519 signature over the exact manifest bytes, with compiled per-channel public keys and a `keyId` for rotation. The owner signs production manifests with an offline key; agents never sign. The staging key is a secret of the `release-staging` environment. Downgrades, equal versions, a wrong channel, tag or name, and a bad signature, size or hash are refused with fixed codes |
| UP6 | Owner: the first check runs 15 s after the application is ready, then every 6 h, with no setting to disable it and a "Check for updates" button in Settings → About. Unpackaged, portable and isolated launches never check. Failures are silent, and no identifier is sent |
| UP7 | An update is refused while ETS2, ATS or TruckersMP runs or the running-game listing fails (fail closed), while exiting or uninstalling, while another update runs, and outside a Squirrel install. The game check repeats before the restart. Only the running channel updates |
| UP8 | Exit reason `update` on the unchanged exit coordinator (intake, `recording-flush`, storage, 2500 ms). The restart helper starts only after an orderly exit. An exit during the download aborts it and deletes the `.partial`; a running `Update.exe --update` is never killed |
| UP9 | Owner: `AppState.application` (`version`, `channel`, `packaged`) and `AppState.update` (state, available version, progress, fixed refusal and failure codes, last check), validated in main and the preload, and two argument-free trusted-dashboard bridge methods, `updateApplication()` and `checkForUpdates()`. No URL or path reaches the renderer |
| UP10 | Owner: a sidebar update control below the recording indicator (#203), hidden while idle, checking or unsupported, with EN/RU text, accessible names and a progress bar; the coordinator set the layout and wording |
| UP11 | Owner: a version line under it ("Version 0.1.1" / "Версия 0.1.1"); a staging build adds a "Staging" badge, its window title and tray tooltip add " Staging", and an unpackaged build reads "Development build" / "Сборка для разработки" |
| UP12 | Owner: build-time identity tables in TypeScript (`apps/desktop/src/channel.ts`), C++ and the PowerShell executor give staging its own Squirrel id `ETS2TelemetryStagingDesktop` (amended on October 28, 2026, see "UP12 amended: staging Squirrel id" below; the approved value was `ETS2TelemetryDesktopStaging`), executable `ETS2TelemetryDesktopStaging`, productName `ETS2Telemetry Desktop Staging`, appBundleId `com.ets2telemetry.desktop.staging`, display name `Yukon Union Telemetry Staging`, Setup `YukonUnionTelemetry-Staging-Setup-<version>.exe`, data root `%LOCALAPPDATA%\ETS2TelemetryStaging`, plugin `ets2telemetry-plugin-staging.dll`, pipe prefix `\\.\pipe\ETS2TelemetryStaging-`, RunOnce value `ETS2TelemetryStagingUninstall`, receipt prefix `ETS2TelemetryStaging-uninstall-` and released plugin list `released-plugins-staging.json`; the AUMID and autostart value derive from the id and executable. Production identities stay byte-identical, and golden tests pin them. Nothing at runtime switches the channel. `ETS2TELEMETRY_*` variables, test registry keys, synthetic test pipes and the export, receipt and diagnostic schema names are unchanged |
| UP13 | Owner requirement: agent and feature-test builds are staging. Enforcement: `scripts/build-channel.mjs` is the only resolver, an unset `ETS2TELEMETRY_BUILD_CHANNEL` means staging, and `production` is accepted only in GitHub Actions or with the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1`; anything else fails. `release-identity.json` records the channel. Pull requests build staging; main pushes and dispatches build both |
| UP14 | Owner: both channels may run at the same time with a game running and both plugins loaded. Each application manages only its own plugin name and hashes, setup record, exclusions, uninstall and deferred cleanup. A CTest host with two plugins records the per-callback cost as an observation; real frame time is pending |
| UP15 | Staging versions are `<base>-stg.<6-digit run number>` (NuGet `stg000042`); local builds are `-stg.000000` |
| UP16 | Owner: the release model. `release.yml` is dispatch-only, takes a successful `main` run and a channel, verifies the artifacts and their identity, writes the manifest and publishes: production as an ordinary release verified as `/latest` after the owner's signature and the `release-production` environment approval, staging as a pre-release in the `release-staging` environment. Owner: approving a staging dispatch is the authorization to publish that staging release |
| UP17 | The staging released-plugin list may stay empty; ownership relies on the install registry hashes |
| UP18 | `updates` joins the data allowlist of the uninstall engine, the executor and the case table; it holds at most one version, is cleaned after an apply and at start, and is left out of the diagnostic bundle |
| UP19 | REG-019 covers an update that keeps data, the refusal while a game runs, the restart after `recording-flush`, side-by-side isolation and two plugins in one game. Only the test-root mode may use a loopback feed and a test public key |
| UP20 | The owner's installed 0.1.1 keeps its identity and moves to the first build with the updater by one manual Setup |

For ET-055 only, UP1 supersedes these earlier statements; earlier dated text is unchanged:
- C15 of the [ET-011 authorization](#et-011-authorization--october-15-2026) and its "no autostart, auto-update, cloud synchronization or recording is authorized" sentence, as far as auto-update is concerned (autostart was authorized separately by ET-031, and cloud synchronization stays in the server phase);
- the [ET-018 authorization](#et-018-authorization--october-18-2026) statement that no auto-update is added;
- the "No auto-update" bullet of [the release checklist](docs/release.md), which the release PR of ET-055 updates.

UP4 amends O2 for production only: a production release is an ordinary GitHub Release, so that `releases/latest` serves it, instead of a pre-release. Staging releases are pre-releases. Every publication still needs the owner's authorization, as O2 requires; UP16 states what counts as that authorization for staging.

Delivery is nine PRs: PR-1 the TypeScript identity table, with production fixed, for the identities `apps/desktop/src` uses to build paths, file names, registry values and the window and tray name (this record); PR-2 the native identity header, in parallel; PR-3 the build-time channel selection, still defaulting to production, together with the identities PR-1 leaves (the `PRODUCTION_HISTORY` guard in `packages/storage/src/sqlite/connection.ts`, the `'transport'` literal in `native-pipe-client.ts`, user-facing copy that names `%LOCALAPPDATA%\ETS2Telemetry` or the plugin DLL, `forge.config.cjs`, the scripts and the PowerShell executor); PR-4 the staging default for agent builds and its rule in the instruction files; PR-5 the hosted side-by-side installer lifecycle; PR-6 the update controller; PR-7 the sidebar control; PR-8 the hosted update-from-feed lifecycle; PR-9 the release workflow, which publishes nothing by itself. No protocol, wire, fixture, SQLite schema, migration, settings format or `GAME_HISTORY_RECORDING` change follows, and no release is authorized. Both channels installed and running on a real machine, real updates after owner-authorized publications, both plugins in real games, frame time and CPU with two plugins, SmartScreen, Smart App Control, antivirus, Narrator and display scaling remain pending owner-operated checks.

ET-055 PR-3 (the build-time channel, October 28, 2026). `scripts/build-channel.mjs` resolves the channel and its version; an unset `ETS2TELEMETRY_BUILD_CHANNEL` still builds production until PR-4. The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **Game-log prefix.** A staging plugin begins every line it writes to the SCS game log with `ETS2TelemetryStaging:`; production keeps `ETS2Telemetry:` byte-identical. The prefix comes from `channel-identity.hpp`, so the two plugins' lines in one game log are told apart.
- **Copy.** User-facing copy is written with the production names; a staging build shows its own display name, data and install roots, Roaming folder and plugin file in every text (`channelCopy` in `apps/desktop/src/channel.ts`), and production text is unchanged. The staging export refusal names both data folders it refuses (UP12), in EN and RU.
- **Storage guard.** A synthetic or replay database may use the history file of neither channel, in every build.
- **Deferred cleanup.** The executor holds both channels' names and the build stamps its `$Channel` line; a staging executor writes its %TEMP% receipt as `ETS2TelemetryStaging-deferred-cleanup-<utc>.json`, and an executor of the other channel refuses with `LAYOUT_INVALID`.
- **Electron name and version.** The packaged package.json carries the channel's productName and the build version, and an unpackaged staging run sets the same name and userData before the single-instance lock. The plugin bundle, the nuspec, the receipts and the history stamp carry the build version.
- **Broker provenance.** The broker's build evidence records its channel, and main refuses a broker built for another channel than the desktop bundle.

ET-055 PR-4 (agent and feature-test builds are staging, October 28, 2026) implements UP13: an unset `ETS2TELEMETRY_BUILD_CHANNEL` builds staging, and exactly `production` is accepted only on a GitHub-hosted Actions runner (`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`, the installer guard's signal; a self-hosted runner is not enough) or with the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1`. The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **The built channel decides the drivers.** The smoke, session-end, compiled-artifact and installer drivers read the channel and version from the desktop build evidence (`node scripts/build-channel.mjs --built`) and never from the shell, so a driver cannot check one channel's names against the other channel's build. The packaged smokes also compare it with the package's broker evidence.
- **CI selects production per job, on main only.** Runs on `main` (`github.ref == 'refs/heads/main'`: a push to `main` or a dispatch on `main`) add `ETS2TELEMETRY_BUILD_CHANNEL=production` to `GITHUB_ENV` in the build, runtime and installer jobs, so every resolver call of those jobs, including `forge.config.cjs` in the upgrade fixture, agrees with the build. Pull requests and dispatches on any other branch leave it unset and build staging, so an unreviewed branch never produces a production-identity Setup or `release-identity.json` (review of PR #210). A branch dispatch uploads its Setup as `windows-installer-staging-<run>-<attempt>`, named from the build evidence, and its hosted installer job skips the lifecycle with a notice until PR-5 adds the staging lifecycle. The production artifact comes only from a `main` run, and a dispatch artifact is never installed as production. Main builds production only; building staging beside it belongs to PR-5's side-by-side lifecycle.
- **`builtBy`.** `release-identity.json` records `{kind: "github-actions", runId}` from `GITHUB_RUN_ID`, or `{kind: "local", runId: null}`; a GitHub Actions build without a valid run id fails.
- **Installer lifecycle.** A local `-AllowLocal` run accepts only a staging Setup and a production Setup runs only on a GitHub-hosted runner. Because the scenarios still use the production install root, names and versions, a staging Setup is refused with `STAGING_LIFECYCLE_PENDING` until PR-5 adds the staging lifecycle; no local lifecycle run is possible before then.

ET-055 PR-5 update (October 28, 2026): the installer lifecycle takes every channel-specific name and version from the built channel (`lifecycleIdentity`, `lifecycleVersions` in `scripts/installer/installer-guard.mjs`), so the refusal above is lifted: a staging Setup runs on a hosted runner, or locally only under the test-root rules with the owner's explicit `-AllowLocal` request; agents never run it locally. The preflight protects both channels' real roots and judges the real install and registration of the channels the run installs only. Coordinator decisions under UP19: Windows CI builds staging on `main` in a separate job `windows-staging-build`, which also runs the staging lifecycle and seals its Setup; `windows-installer` then runs the side-by-side scenario on `main` only, because production is built only there. The scenario installs both channels into one test root, gives each channel its own profile, plants each channel's autostart value with a marker argument, and checks that each channel's install and launch, production's complete Windows-initiated uninstall beside a running staging application, and staging's deferred uninstall with its executor leave the other channel's untouched; the other uninstall pairs stay pending (REG-019 part 1; [installer testing](docs/installer-testing.md#side-by-side-scenario)). No product code changes.
- **Tests.** Vitest removes the build variables before any test file loads, and tests that compare script helpers with the unbundled, production `channel.ts` name the channel explicitly. Tests read a channel's Forge configuration in a separate Node process; production is read with `GITHUB_ACTIONS=true` and builds nothing. No test sets the owner override.
- **Native trees.** `npm run native:configure` passes the resolved channel and refuses extra CMake arguments that could set, load or remove it (`-DETS2TELEMETRY_CHANNEL…` in any form, `-C`, `-U`, `--preset`), because CMake applies the last definition it sees. CMake's own default is staging in both trees, so a tree configured without the value never carries production names; CI's AddressSanitizer and extended trees, configured with `cmake` directly and packaging nothing, pass `-DETS2TELEMETRY_CHANNEL=production`. Every native plugin tree also builds the other channel's plugin DLL under `build/other-channel/` for `channel-identity-contract` and `two-plugin-host-contract`; that DLL is a test artifact and must never be copied into a game.

ET-055 PR-6 (the update controller, October 28, 2026). Main has an update controller (`apps/desktop/src/updater/`) with no user interface yet; PR-7 adds the sidebar control. It implements UP3 to UP9 and UP18 as recorded above. The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **Manifest format.** `format` is `ets2telemetry.update-manifest.v1`, the signature file is the base64 Ed25519 signature over the manifest's exact bytes, and each compiled key is `{keyId, publicKey}` with the base64 of the raw 32-byte public key ([releases](docs/release.md#update-feed-et-055)). Both key lists ship empty, so every manifest is refused with `SIGNATURE_INVALID` until the owner adds the production public key (and the staging one).
- **Production tag binding.** `releases/latest/download` does not reveal its tag, so a production manifest's tag must equal `v<appVersion>` of that manifest; staging manifests must carry the tag of the release they were chosen from.
- **Same version and downgrade.** Both are "nothing to install": the check ends `up-to-date` and the view is `idle`, with the detailed code in the log only.
- **View.** `AppState.update` uses `null` for absent fields; `lastCheck` is `{outcome, failure, atUtcMs}`; a refusal also stays visible in `ready` after a refused restart. A background check keeps a shown offer (it never flips back to `checking`), and a manual check runs at most once per 10 s.
- **Refusal codes.** `BUSY` covers an in-app uninstall in progress and this update's own check in flight; a click while the download or apply runs leaves the view unchanged.
- **Restart.** The helper starts only after an exit requested with reason `update`, whatever its exit code; main allows it 2 s to spawn. An exit during the apply never waits for or interrupts `Update.exe`, and nothing is restarted then.
- **Killed apply (R1).** The exit never kills `Update.exe --update`, but `runFixedProgram` does when the 180 s deadline (`APPLY_TIMEOUT`) or the 16 MiB output bound is reached. Risk R1, a partial `app-<version>` folder, therefore also arises on an apply timeout, not only on an exit or a power loss, and the hosted update lifecycle (PR-8) must observe a killed apply too.
- **Uninstall and update exclude each other (review round 1).** While the update downloads, installs or restarts, the in-app uninstall is refused with the new fixed code `UPDATE_IN_PROGRESS` (EN/RU copy in the uninstall refusal style), by main before the orchestrator runs and by the orchestrator before its confirmation and after the dialog closes. An update click is refused with `BUSY` while an uninstall runs, checked at the click, after the running-game listing and before `Update.exe`.
- **Windows-initiated uninstall during an apply (known gap, TD-025).** Settings → Uninstall while the update is `installing` reaches main through the Squirrel hook's `uninstall-exit` payload, which runs `requestExit('uninstall')` without asking the controller, so `Update.exe --uninstall` can overlap our `--update`; whether Squirrel's own lock serializes them is unverified. No code change in PR-6, because the hook's 6 s wait cannot cover a 180 s apply. PR-8 must observe it together with the killed apply; if that shows harm, a follow-up blocks it.
- **Invalid application info.** An invalid build version is replaced by the fixed fallback `0.0.0` (logged as `APPLICATION_INFO_INVALID`) in main and again in the preload, as an invalid update view becomes `unsupported`, so the rest of the application state is never dropped.
- **Test feed.** Only a test-root install with a profile inside its root reads `ETS2TELEMETRY_UPDATE_TEST_FEED` (a loopback origin) and `ETS2TELEMETRY_UPDATE_TEST_PUBLIC_KEY` (key id `test`).

No protocol, wire, SQLite schema, settings format or `GAME_HISTORY_RECORDING` change follows; nothing is published. Deferred: delta packages (TD-022), an Authenticode check of a downloaded update after code signing (TD-023) and a setting to turn checks off (TD-024).

ET-055 PR-7 (the sidebar update control and the version line, October 28, 2026) implements UP10 and UP11 with the owner's EN/RU texts in the dashboard only (`apps/desktop/src/update-control.tsx`, `update-control-text.ts`); no controller, contract, preload or IPC change. The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **Refusal words the owner did not give.** `BUSY` reads "Another task is running – Retry" / "Выполняется другая задача – Повторить" and `EXITING` "The app is closing" / "Программа закрывается". A restart refused in `ready` shows the refusal's words, because `ready` keeps the refusal code.
- **Failure tooltips.** One fixed sentence per failure code, also the button's description and part of the single assertive alert. The polite region announces the offer and each phase but never each percentage, and the progress bar is a separate `role="progressbar"` element under the button, because a button's content is presentational.
- **Dot and icons.** The 10 px dot is `--yu-accent-light` (the accent family's contrast on the dark sidebar) and appears while an update can be installed or finished (`available`, `ready`). `ArrowUpCircle` marks an offer or a refusal, `RefreshCw` a busy phase, `ready` and a failure; the busy icon turns under the dot's focus and reduced-motion rules.
- **Version line.** The visible words and the badge are `aria-hidden` and one accessible sentence replaces them; an unpackaged staging run reads "Development build, staging build". Main's fallback version `0.0.0` reads "Version unknown" / "Версия неизвестна", because it never names a real build.
- **About check.** It reuses the ET-045b action result beside its button: the answer stays until the next click (no auto-hide). It waits only while the bridge reply shows a running check (bounded at 30 s); any other reply is answered at once, a standing offer with its version. It is busy in `ready`, with a note on finishing the installed update, and while an update runs, and disabled with a note where the launch never checks.
- **Known announcement limits (review round 1).** A repeated identical refusal is not re-announced, and a manual check that finds an update is announced by both the sidebar and About; both are accepted as they are.

ET-055 PR-9 (the release workflow, October 28, 2026) implements the release model of UP4, UP5 and UP16 in `.github/workflows/release.yml` and `scripts/release/`; see [releases](docs/release.md#release-workflow-et-055). It publishes nothing by itself: it has never been dispatched, and no key, environment or secret exists yet. The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **Two production dispatches.** The first creates a draft release with the unsigned manifest and prints the owner's signing commands. The second, `mode=publish_signed`, takes the owner's signature as an input (one base64 line, not secret), checks the draft byte for byte against the CI artifact, verifies the signature against the compiled production key, uploads it and publishes with `make_latest=true`. Both production jobs run in `release-production`, so the owner approves twice; staging signs and publishes in one job in `release-staging`.
- **keyId bound to the key.** A keyId is `<channel>-<16 hex digits of the SHA-256 of the raw public key>`, and the signer refuses a manifest that names another keyId, so a wrong or other-channel key never signs. The writer names a compiled key of the channel, the only one by default; with none it stops, so no manifest is written that no build could verify.
- **Compiled keys of the released commit.** Every job that writes or verifies a manifest takes `update-keys.ts` from the CI run's commit (`git show`), never from the dispatch checkout, and the release scripts import that copy through Node's type stripping. They repeat the application's manifest parser, signature check and NuGet version order; tests show that they agree with `update-manifest.ts` and `update-version.ts` on a malformed corpus and that every manifest the scripts write and sign is accepted by it. The workflow runs no `npm ci`.
- **No local staging version.** A staging artifact whose version carries the local run number `000000` is refused, because every staging build without a run number carries it (UP15). On `main`, `windows-staging-build` sets `ETS2TELEMETRY_STAGING_RUN_NUMBER` to `github.run_number`, zero-padded to 6 digits, writes `release-identity.json` and uploads `windows-installer-staging-<run>-<attempt>`; PR-5's side-by-side hand-off comes from the same build. Branch dispatches and pull requests keep `000000`.
- **Main ancestry.** A run's `head_branch` is only a name, so the release is refused while a tag named `main` exists, main's commit is read from the unambiguous `git/ref/heads/main`, and the run's commit must be in its history (`compare/<commit>...<main's commit>` identical or ahead, with the commit as the merge base).
- **Production version order.** A production version must be higher than the current latest release's `v<version>` by the application's NuGet SemVer order, checked before the draft and again before publishing, so no release is published that installed builds would refuse or that would not become latest (R4).
- **Unambiguous 404.** GitHub GETs whose 404 is an answer go through `scripts/release/gh-get.sh` (exit 44 for HTTP 404, 1 for any other failure), because `gh api` writes a 404's error body to standard output.
- **Waiting.** The candidate artifact is kept for 7 days, the window to approve a publish job. One release runs and at most one more waits; a further dispatch cancels the waiting one.
- **Runners.** The release jobs run on the GitHub-hosted `ubuntu-24.04` runner: no step needs Windows, because the artifact is checked by its recorded hashes and `release-identity.json` already holds the Authenticode facts from the Windows build.
- **Failure after publishing.** If `releases/latest` does not name the new tag, the job fails; the release stays public and the owner corrects it by hand. The workflow never deletes or edits a published release.

No protocol, wire, SQLite schema, settings format or `GAME_HISTORY_RECORDING` change follows, and no release is authorized.

**UP12 amended: staging Squirrel id (coordinator decision, October 28, 2026).** The first hosted side-by-side installer lifecycle on `main` (run 40705814648 at `a441bd0b`) failed with `BESIDE_INSTANCE_ENDED`: production's Windows-initiated uninstall terminated the running staging application (exit code 4294967295). The production hook did not: its receipt records instance `none` and 0 other processes. Squirrel.Windows takes a process or executable as the package's own when its path starts with the install root, compared `OrdinalIgnoreCase` and without a separator (`KillAllProcessesBelongingToPackage` in `src/Squirrel/UpdateManager.InstallHelpers.cs`, and the same test in `CurrentlyInstalledVersion` and `IsInstalledApp` in `src/Squirrel/UpdateManager.cs`). Production's root `%LOCALAPPDATA%\ETS2TelemetryDesktop` was a string prefix of the approved staging root `%LOCALAPPDATA%\ETS2TelemetryDesktopStaging`, so every production uninstall, and probably every production update, would end a running staging application. Under the owner's delegation the coordinator changed only the staging Squirrel id, to `ETS2TelemetryStagingDesktop`. It names the install root `%LOCALAPPDATA%\ETS2TelemetryStagingDesktop`, the HKCU Uninstall key, the nupkg `ETS2TelemetryStagingDesktop-<NuGet version>-full.nupkg` and the AUMID and autostart value `com.squirrel.ETS2TelemetryStagingDesktop.ETS2TelemetryDesktopStaging`.

- **Neither install root is a prefix of the other.** `tests/unit/channel-identity.test.ts` checks, with Squirrel's semantics and for every pair of channels in both identity tables, that neither Squirrel id nor install root is a case-insensitive string prefix of the other's, and that no install root is a prefix of a data root.
- **Everything else in UP12 is unchanged**, including the executable `ETS2TelemetryDesktopStaging`, the data root `ETS2TelemetryStaging` (which must not equal the install root), the plugin, the pipes, the RunOnce value and productName. Production identities are byte-identical.
- **Data roots.** `ETS2Telemetry` remains a string prefix of `ETS2TelemetryStaging` and of both install roots, and `ETS2TelemetryStaging` of the staging install root. Squirrel never sees a data root, and the application, the executor and the installer guard compare them exactly or with a separator.
- **No migration.** No staging build was released or installed outside CI test roots.

Whether the hosted side-by-side scenario now passes is shown only by the next run on `main`.
ET-055 PR-8 (the update from a loopback feed, October 28, 2026) covers UP19's hosted part of REG-019: the update with data kept, the refusal while a game runs and the restart after `recording-flush` ([installer testing](docs/installer-testing.md#update-from-feed-scenario)). The coordinator made these decisions under the owner's approval of October 28, 2026; the owner did not review them individually:

- **No product change.** The driver clicks the existing About check and sidebar control, reads the existing `getAppState()`, and closes an instance that Update.exe or Squirrel's stub started with the uninstall hook's existing `uninstall-exit` lock request; the test-root feed and key variables of PR-6 are the only update inputs. No IPC, bridge method or test-only product switch is added.
- **Per-run key.** The loopback feed's manifest is signed with an Ed25519 key generated inside the driver command; only its public half reaches the application, and nothing of it is written.
- **R1 by a kill.** The apply of a third fixture version C is killed as soon as Update.exe creates `app-<C>` (the end `runFixedProgram`'s 180 s kill also produces), then retried with an exit during it. No shorter apply deadline is added to the product. What Squirrel leaves is recorded; only data loss or an install whose stub starts nothing that reaches the history fails the run. Whether the restart must wait for a complete apply is decided from the hosted evidence.
- **TD-025 stays pending.** A Windows-initiated uninstall during an apply is not exercised.
- **Harness rules from the PR-5 review.** The harness-variable check also reports own-spelling writes to typed or validated parameters and the wider write forms, over every tracked script except the retired ET-001 harness; the side-by-side sentinel samples one file per entry; the workflow guard covers `- run:`, `name:` and `if:` plain scalars.
