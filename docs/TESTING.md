# Testing and Regression Strategy

This file holds the current testing rules and the permanent regression scenarios. It is not a log.

**Changing this file.** Change it only when a testing rule changes or a regression scenario is added. A PR describes the tests it adds in its description, and each new test entry point gets one row in the [test index](regression-registry.md). The earlier full text, with the per-card test records, is in [TESTING-HISTORY.md](../TESTING-HISTORY.md).

To find the tests for a feature or scenario, search the [test index](regression-registry.md) for its REG ID or file, then read those tests and the area's document in `docs/`.

## 1. Delivery rule

A behavior change includes automated tests in the same PR. A bug fix includes a regression case that fails with the defect and passes with the fix, where feasible; explain when it is not. Choose the smallest useful test boundary and do not write tests that only repeat the implementation. Documentation-only changes need document checks, not application tests.

Passing tests reduce regression risk; they do not prove compatibility with every game version, machine or display configuration. Simulation and real-game acceptance are different evidence, and both are required where they apply.

## 2. Test layers and tools

| Layer | Tool or environment | What it protects |
| --- | --- | --- |
| Domain logic | Vitest, deterministic fixtures, controlled clocks | Unit conversion, missing values, trip transitions, completeness, distance and fuel rules, sampling |
| Protocol contracts | Shared versioned fixtures read by TypeScript and C++ tests | Framing, units, availability, ordering, identifiers, bounds, version negotiation |
| Native components | C++ executables under CTest, MSVC x64, AddressSanitizer twins | Callback copies, serialization, bounded queues, ACK handling, shutdown |
| Integration | Vitest with real Windows named pipes, real SQLite files and the storage worker | Process boundaries, transactions, recovery, idempotency, migrations, lifecycle |
| Desktop journeys | Runtime smokes and Playwright driving Electron with the simulator | Connection status, displayed values, settings, recording, journal, export, restart, errors |
| Packaged application | The Forge package and the installer lifecycle in a marked test root on hosted runners | Native assets, bundled plugin and worker, clean startup, upgrade, uninstall, history preservation |
| Game acceptance | Real ETS2 and ATS sessions and recorded observations | SDK callbacks, TruckersMP, click-through, focus, DPI and monitors, latency, frame time |

Native OS dialogs may be substituted in automated journeys; real dialogs, tray actions, input pass-through and focus still need desktop checks. Never weaken release security to make a test pass. Commands and their setup are in [docs/setup.md](setup.md) and [docs/ci.md](ci.md).

## 3. Design for useful tests

- Keep telemetry normalization, sampling and trip accounting independent of React and Electron, with the clock and ID generator injected.
- Fake external input in unit tests, but exercise real pipes, the storage worker and transactions in integration tests.
- Keep SDK-independent C++ logic separately buildable. Adapter tests can simulate callbacks; they cannot show that a running game calls them as expected.
- Drive end-to-end tests through the simulator's production protocol endpoint, across ingestion, domain logic, storage, preload and UI, instead of mocking all of them.
- Use temporary per-test directories, unique pipe names and isolated processes. Never touch the real database, real settings or installed game files, and clean up workers and handles after failures.
- Keep failure-injection hooks test-only, and keep production validation and isolation settings in automated runs.
- Write expected values by hand from the requirement, never by running the code under test.

## 4. Permanent regression scenario corpus

Every scenario below keeps the same ID across domain, integration and UI tests, without repeating every assertion at every layer. The [test index](regression-registry.md) maps each test entry point to the scenarios it protects. A scenario without protection stays visibly pending; never add a passing placeholder. Fixtures record their scenario, input, timing, expected outcome and origin (synthetic or sanitized capture); committed captures contain no player, profile or personal data.

| ID | Scenario | Required result | Primary owners |
| --- | --- | --- | --- |
| REG-001 | Normal job acceptance, driving, road stop, delivery | One delivered trip; active road stops retain 1 Hz sampling | ET-014, ET-015 |
| REG-002 | Pause and resume under controlled time | Pause events exist; no repeated paused samples; sampling resumes without invented catch-up data; a verified unchanged pause across a gap-free reconnection preserves completeness | ET-014, ET-015 |
| REG-003 | App attaches mid-job or reconnects after a gap; a save-created job opens before driving | Partial recording is visible for real or unverified losses; a clean loaded job needs distance and game-duration corroboration at delivery; missing intervals are not fabricated | ET-006, ET-014, ET-015 |
| REG-004 | Cancellation, job disappearance, and configuration cleared before delivery event | Cancellation and delivery remain distinct; missing configuration alone never proves delivery; terminal payload is retained | ET-003, ET-014 |
| REG-005 | Duplicate/redelivered events and ordering violations | No duplicate trip/accounting; unsupported ordering is rejected or represented as a gap under the protocol | ET-002, ET-004, ET-014, ET-015 |
| REG-006 | Process terminates before commit or after commit but before ACK | Retry recovers uncommitted work or deduplicates committed work; no ACK for a failed transaction | ET-004, ET-013, ET-015 |
| REG-007 | Disk/permission/write failure | Failure is visible, uncommitted events are not acknowledged, buffering is bounded, game input remains independent | ET-013, ET-015 |
| REG-008 | Save load, timer/odometer reset, truck change or quick-job/truck replacement, refueling, ferry/train crossing, sleep, road-service teleport, profile switch, clock adjustment, suspend/resume | No negative accumulated distance, false fuel usage, distance across a teleport or connection hole, or unjustified merging of ambiguous trips; jumps are annotated, not hidden | ET-010, ET-014 |
| REG-009 | Missing/invalid channels, zero speed, and unit conversion | Unavailable differs from zero; liters/km conversion is correct; SDK average is not mislabeled as trip average | ET-003, ET-010 |
| REG-010 | Split/coalesced/malformed/oversized frames, large identifiers, incompatible version | Both implementations enforce the contract and bounds without crashing or silently changing identity | ET-002, ET-004, ET-006 |
| REG-011 | Stalled reader, full event queue, reconnect, shutdown | Callback work and memory stay bounded; any loss is explicit; processes terminate cleanly | ET-004, ET-006 |
| REG-012 | Close main window, second launch, explicit exit, restart | Recording survives close-to-tray; one app instance; explicit exit flushes committed work; history survives restart | ET-011, ET-015 |
| REG-013 | Representative old database upgraded to each supported schema | Known trips, events, samples, IDs, and completeness survive; failure does not leave a silently partial migration | ET-013, ET-018 |
| REG-014 | Journal pagination, incomplete trip, export and save cancellation | Correct values and gaps are shown; versioned export reconciles with stored records; cancellation creates no output | ET-016 |
| REG-015 | Setup/update/remove with unrelated DLLs, running game, locked files, invalid paths | Only the project plugin is managed; running-game and failure checks prevent unsafe replacement | ET-017, ET-018 |
| REG-016 | Foreground/minimize, window recreation, mixed DPI, removed monitor | Placement remains usable; the overlay hides appropriately and never steals driving controls | ET-007, ET-008, ET-012; real-game checks required |
| REG-017 | Clean packaged startup and upgrade with existing history | Correct native assets load without development tools; settings and data are preserved | ET-018, ET-020 |
| REG-018 | Sustained input and real one-hour recording | Cadence, resource bounds, database growth, latency, and frame-time impact have recorded measurements | ET-019, ET-020 |
| REG-019 | In-app update and channel coexistence: an update with data kept, a refusal while a game runs, the restart after `recording-flush`, both channels side by side, two plugins in one game | Only a signed manifest of the build's own channel and a verified package install, only after a click and while no game runs; the restart follows the explicit exit; data and the other channel stay untouched | ET-055 |

- **REG-006:** terminate a real subprocess at known commit and ACK boundaries and reopen the real database; unit mocks alone are not enough.
- **REG-013:** keep small immutable databases from every supported older schema and check their meaning after migration, plus a newer-schema case that fails clearly without modifying the file. Never replace historical fixtures with freshly generated ones.
- **Regression fixes:** find the smallest reproducing scenario, show that the old behavior fails it where practical, fix the defect and keep the scenario. For critical trip and ACK logic, check invariants across several deterministic event sequences.

## 5. Automation and merge policy

| When | Checks |
| --- | --- |
| Local development | The focused suite for the changed behavior, then the relevant boundary scenarios before pushing |
| Every code PR | Lockfile install, lint (`npm run lint:install`, `npm run lint`, `npm run lint:ps`), typecheck, desktop and native builds, the full fast suite and the bounded Windows integration and packaged smokes |
| Risky change | Also the affected migration, crash and recovery, packaging, native or overlay checks on the PR commit, with any manual evidence recorded |
| Push to `main` and manual dispatch | The broader replay, recovery, extended and packaged suites, including the installer lifecycle |
| Before a release | The exact candidate artifact, a fresh install and an upgrade, the real-game matrix and a one-hour recording session |

- CI does not run on draft PRs or on changes limited to `**.md` and `docs/**`. A skipped or absent run is not a pass: the merge gate is a successful run of the three required jobs (`Windows x64 tests`, `Windows x64 scaffold`, `Windows x64 native AddressSanitizer`) on the final head after Ready for review ([docs/ci.md](ci.md#triggers-and-draft-checks)).
- A failing baseline suite blocks the change. Check the current PR commit, not an earlier run, and run every consumer of a changed shared contract or migration.
- Required checks prove only that the jobs passed. Review, real-game and other acceptance evidence remain owner and reviewer policy; the advisory Claude review is never a required check.
- Dependency upgrades (Electron, Node, better-sqlite3, the SDK, protocol tooling) need the native, packaged and migration checks besides unit tests. SDK, window, input, game-client and native changes need real-game checks that simulation cannot replace. If a machine or game is unavailable, keep the evidence pending instead of claiming success.

## 6. Test reliability and evidence

- Assert observable behavior or a documented invariant, not private implementation details or broad UI snapshots.
- No retries for deterministic logic and integration tests. A retry used to diagnose an environment failure stays visible, and a pass after a failure does not erase the flake: investigate it.
- Do not depend on how fast the host is. Wait for an observable signal (a readiness message, an exit, a gate or deferred resolved by an injected port) instead of a real `setTimeout`, a default `vi.waitFor` timeout or a sleep. Give real processes a named hang guard, and keep product deadlines in force.
- Keep CPU-heavy or one-time work out of the default 5 s case timeout: prepare it once in `beforeAll` with an explicit, commented budget, and keep assertion overhead proportionate. A case whose duration is irreducible work and that asserts no timing may get a named budget whose comment says it bounds work, not behavior timing; for real file work it is the counted operations times the average allowance (`fileWorkBudget` in `tests/shared/file-work.ts`). A file whose cases observe no durability runs its file work without the flush to disk (`withoutFlush`, `unflushedOpen`), because one Windows `FileHandle.sync()` can wait seconds for other processes' data; a case that observes the sync, its order or its failure keeps the real call or injects its own.
- A test that imports a side-effecting entry point per case loads the module graph once in `beforeAll`, tracks every in-flight import and awaits it in `afterEach`, so a timed-out case cannot affect the next one (`tests/unit/main-boundaries.test.ts`).
- Cases that share fake timers and long-lived objects keep their state in a per-case harness and stop it through the product's own stop API in `afterEach`, before restoring real timers (`tests/unit/plugin-setup.test.ts`).
- Tests that need the real host serially (real process listings, guarded file-system I/O under product deadlines) run in the one-worker `host-boundaries` Vitest project, not in quarantine.
- Temporary quarantine needs a linked defect, an owner, a reason, a restoration point and alternative verification. Trip-integrity, ACK and migration regressions are never skipped to make a release pass.
- Report the failing scenario or seed, expected and actual values, bounded sanitized logs, the commit and the commands. Coverage percentages and test counts are not proof that history is correct.
- Virtual-time or accelerated replay checks logic and size; it cannot certify one-hour stability, display latency or frame-time impact.

## 7. Real-game acceptance record

Keep a matrix for ETS2 and ATS, each in single-player and TruckersMP, in windowed and borderless mode; Convoy is not part of it. Record the exact game, client, application and SDK versions, the Windows version, the hardware, the monitor and DPI setup, the launch order, the outcome and the evidence in the card's file in `docs/validation/`. Support is tied to the versions actually tested, and a game or TruckersMP update may need revalidation.

Cover startup order, real values, pause and resume, Alt+Tab, click-through, minimize and restore, monitor changes, delivery and cancellation, reconnect and orderly exit; before a release, also the journal and export, setup and upgrade, history preservation and a measured one-hour session. A simulator run is never evidence of real-game support.

## 8. Later server phase

When the server phase is specified, extend this strategy with API and schema compatibility, authentication and company isolation, idempotent uploads, offline and restart recovery, account switching and report reconciliation, using a disposable real PostgreSQL instance. The offline desktop suite stays a regression gate.

## 9. Handoff for every behavior change

The PR description names the protected scenarios, the tests added or changed, the commands actually run on the current commit with their results, and the manual checks still needed. Explain a justified test omission instead of inventing coverage.

In the same PR, update the fixtures, and add one row to the [test index](regression-registry.md) for every new test entry point (a test file, CTest family, PowerShell suite, runtime-smoke scenario or CLI smoke) with its REG IDs, mapping source, owning card, where it runs and its protected categories. Do not add per-card sections to this file or the registry ([documentation budget](agent-rules.md#documentation-budget)). A card moves to Review with evidence; Done requires accepted criteria, including regression protection for the behavior it implemented.
