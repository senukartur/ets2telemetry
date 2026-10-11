# Testing and Regression Strategy

ET-002a adds shared TypeScript/C++ protocol 0.0 fixtures and partial REG-003/005/009/010 protection. See [the wire format](docs/protocol/v0.md), [validation](docs/validation/et-002a.md), and [scenario registry](docs/regression-registry.md). Full baseline checks remain required; no game or durable-recording acceptance is inferred.

Owner exception on October 11, 2026 permits early ET-002a protocol v0 implementation and a draft PR while SP-01 game checks are deferred. Keep the failed ETS2 single-player windowed appearance result and required retry explicit; Convoy remains pending. Automated contract checks do not accept SP-01 or establish game compatibility. Existing applicable baseline suites remain mandatory.

Recorded on October 10, 2026; updated October 11, 2026. **Status: scaffold checks implemented and verified; ET-022 CI workflow implemented with hosted clean/failure/restoration evidence recorded; feature suites pending.** ET-001 defines Node unit, Electron startup/worker, native CTest, bounded native Windows installer and historical disposable-guest entrypoints. Current native evidence covers six normally completed install/repair/smoke/update/upgraded-smoke/uninstall operations, actual packaged SQLite/security/orderly shutdown, separate corrected uninstall postconditions and exact owned cleanup. The original failed wrapper report and an unexplained standalone Playwright launch timeout remain recorded. Exact identities and independent review belong in [the acceptance record](docs/validation/et-001.md). No game compatibility or full production REG-017 coverage is established.

Read [concept.md](concept.md) for product behavior and [AGENTS.md](AGENTS.md) for the development workflow.

Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

## 1. Delivery rule

Protect existing behavior while adding features. A behavior change includes appropriate automated tests in the same PR, and a bug fix normally includes a regression case that fails with the defect and passes with the fix. Choose the smallest useful test boundary; do not write tests that merely repeat the implementation. Documentation-only changes need document checks, not application tests.

Tests reduce regression risk; passing them does not prove compatibility with every game version, machine, or display configuration. Automated simulation and real-game acceptance provide different evidence, and both are required where applicable.

## 2. Test layers and tools

| Layer | Planned tool or environment | What it protects |
| --- | --- | --- |
| Domain logic | Vitest, deterministic fixtures, controlled clocks | Unit conversion, missing values, trip transitions, completeness, distance/fuel rules, and sample scheduling |
| Protocol contracts | Shared versioned fixtures consumed by TypeScript and C++ tests | Framing, units, availability, ordering, identifiers, payload bounds, and version negotiation |
| Native components | C++ test executables registered with CTest, built with MSVC x64 | Copied callback data, serialization, bounded queues, acknowledgement handling, cancellation, and shutdown |
| Integration | Vitest orchestration, actual Windows Named Pipes, actual SQLite files and worker | Production component boundaries, transactions, recovery, idempotency, migrations, and lifecycle |
| Desktop journeys | Playwright controlling Electron with the telemetry simulator | Connection status, displayed values, settings, recording, journal, export, restart, and visible error states |
| Packaged application | Windows installer/packaged build and temporary user data | Native dependency ABI, bundled plugin and worker assets, clean startup, upgrades, and history preservation |
| Game acceptance | Actual ETS2/ATS sessions and recorded observations | SCS callbacks, TruckersMP/Convoy compatibility, click-through, focus, DPI/monitor behavior, latency, and frame-time impact |

Pin compatible versions during ET-001/ET-022. Vitest is the TypeScript test runner; use its timer controls for deterministic logic tests. CTest runs the native test executables; choose and pin a small C++ assertion framework during scaffolding if needed rather than adding several competing frameworks. See the official [Vitest guide](https://vitest.dev/guide/), [timer documentation](https://vitest.dev/guide/mocking/timers), and [CTest manual](https://cmake.org/cmake/help/latest/manual/ctest.1.html).

Playwright's [Electron support is experimental](https://playwright.dev/docs/api/class-electron). Validate the pinned Electron/Playwright combination with a Windows startup smoke test before relying on it. If release hardening prevents instrumentation, use a documented instrumentable test build for automation and separately smoke-test the unchanged release artifact. Do not weaken release security to make tests pass. Native OS dialogs may be substituted in automated journeys; real dialogs, tray actions, input pass-through, and window focus still require desktop checks.

## 3. Design for useful tests

- Keep telemetry normalization, sampling decisions, and trip accounting independent of React and Electron. Inject the clock and ID generator at these boundaries.
- Give transport, storage, and lifecycle components narrow interfaces. Fake external input in unit tests, but exercise real pipes, the storage worker, and transactions in integration tests.
- Keep SDK-independent C++ logic separately buildable. Adapter tests may simulate callback inputs; they cannot establish that a running game invokes callbacks as expected.
- Drive end-to-end tests through the simulator's production protocol endpoint. A representative journey must cross ingestion, domain logic, storage, preload, and UI instead of mocking all of them.
- Use temporary per-test data directories, uniquely named pipes, and isolated processes. Never run tests against the driver's real database or installed game files. Clean up workers and handles even after failure.
- Use explicit synchronization and bounded timeouts for real processes. Fake time tests scheduler rules; a short wall-clock integration check validates real cadence. Avoid long sleeps as a substitute for observable completion.
- Keep failure injection hooks restricted to test execution. Preserve production validation and isolation settings in automated runs.

## 4. Permanent regression scenario corpus

ET-005 establishes versioned scenario fixtures. Each fixture records its scenario ID, purpose, input events/snapshots, timing, expected outcomes, and origin (synthetic or sanitized game capture). Expected results are reviewed independently of the implementation being tested; do not generate the expected output by running that same implementation.

Use the same scenario identity across relevant domain, integration, and UI checks without duplicating every assertion at every layer. A scenario registry maps each requirement below to test locations and the owning component as it is implemented. Unimplemented checks remain visibly pending; they are not passing placeholders. Recordings used in Git must remove player/profile names, personal paths, and unrelated data, and remain clearly distinct from real history.

| ID | Scenario | Required result | Primary owners |
| --- | --- | --- | --- |
| REG-001 | Normal job acceptance, driving, road stop, delivery | One delivered trip; active road stops retain 1 Hz sampling | ET-014, ET-015 |
| REG-002 | Pause and resume under controlled time | Pause events exist; no repeated paused samples; sampling resumes without invented catch-up data | ET-014, ET-015 |
| REG-003 | App attaches mid-job or reconnects after a gap | Partial recording is visible; missing intervals are not fabricated | ET-006, ET-014, ET-015 |
| REG-004 | Cancellation, job disappearance, and configuration cleared before delivery event | Cancellation and delivery remain distinct; missing configuration alone never proves delivery; terminal payload is retained | ET-003, ET-014 |
| REG-005 | Duplicate/redelivered events and ordering violations | No duplicate trip/accounting; unsupported ordering is rejected or represented as a gap under the protocol | ET-002, ET-004, ET-014, ET-015 |
| REG-006 | Process terminates before commit or after commit but before ACK | Retry recovers uncommitted work or deduplicates committed work; no ACK for a failed transaction | ET-004, ET-013, ET-015 |
| REG-007 | Disk/permission/write failure | Failure is visible, uncommitted events are not acknowledged, buffering is bounded, game input remains independent | ET-013, ET-015 |
| REG-008 | Save load, timer/odometer reset, truck change, refueling | No negative accumulated distance, false fuel usage, or unjustified merging of ambiguous trips | ET-010, ET-014 |
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

For REG-006, use controlled subprocess termination and reopen the real database at known commit/ACK boundaries; unit mocks alone are insufficient. For REG-013, keep small immutable databases from supported older schema versions and check semantic contents after migration. Also preserve an unsupported-newer-schema case: fail clearly without modifying that database. Do not replace historical fixtures with freshly generated current-schema files.

For regression fixes, identify the smallest reproducing scenario, demonstrate that the old behavior fails it where practical, fix the defect, and retain the scenario permanently. Explain when an old version cannot be executed. Add invariants across multiple deterministic event sequences for critical trip/ACK logic; introduce property-based tooling only when it provides concrete additional coverage.

## 5. Automation and merge policy

ET-022 introduces GitHub Actions early, after the scaffold exists. The implemented workflow and bounded commands are documented in [docs/ci.md](docs/ci.md); clean hosted acceptance and controlled failure/restore runs are recorded in [ET-022 validation](docs/validation/et-022.md); the final current PR head still requires its check/review association before owner merge. The [scenario registry](docs/regression-registry.md) maps all REG-001–018 requirements to implemented partial protection or explicit pending owners. [GitHub workflows](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows) support PR, push, and manual triggers; use a supported, explicitly selected [Windows x64 runner image](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) for Windows/native integration.

| When | Planned checks |
| --- | --- |
| During local development | Run the focused suite for changed behavior, then relevant boundary scenarios before pushing |
| Every code PR | Lockfile installation, type/lint checks, desktop/native build, the full existing fast unit/contract corpus, and bounded Windows integration/Electron smoke suites |
| Before merging a risky change | In addition, run impacted migration, crash/recovery, packaging, or native/overlay checks on the PR commit; record required manual evidence |
| After merge to main and by manual trigger | Broader replay/recovery and packaged-app regression suites, including supported historical migrations as those features become available |
| Before a release | Verify the exact candidate artifact, fresh install/upgrade, the real-game matrix, and a one-hour performance/recording session |

ET-001 must start with meaningful scaffold checks. ET-022 wires existing checks into CI and provides reusable test infrastructure; each feature task adds its own tests as the component arrives. ET-019 extends cross-component fault coverage before distribution. Do not postpone all regression work until ET-019 or create green empty suites for unimplemented features.

ET-001 entrypoints and limitations are in [docs/setup.md](docs/setup.md). Node Vitest covers Node-safe status/path, lifecycle, and logging modules without loading Electron or native SQLite. Electron Playwright checks the sandboxed window and actual utilityProcess/storage worker probe; repeat against the Forge package from an unrelated temporary cwd to exercise the pinned N-API native binary and ASAR worker paths. CTest calls the placeholder DLL export and checks x64. These checks do not cover production migrations or establish full REG-017 upgrade/history preservation. The early SP-01 and CAP-01 packages feed ET-009 as defined in concept.md; game evidence does not await ET-022, but relevant local code checks remain mandatory.

Keep the initial PR suite bounded; target feedback within about 10 minutes and measure the actual duration once it exists. This is a planning target, not a current measurement or permission to skip failing checks. Start with the full existing fast suite on every code PR; adopt affected-test filtering only after its dependency mapping is verified. Documentation-only PRs can use focused document checks when runtime/build files are untouched.

A failing baseline suite blocks acceptance of the change. Check the current PR commit, not a stale earlier run; shared-contract or migration changes require all relevant consumers. Record check names only after real jobs exist. On the current private repository plan, branch protection is unavailable: this is an owner/reviewer merge policy, not a server-enforced guarantee. Enable required status checks if repository capabilities later permit it.

The optional [Claude code review](docs/ai-review.md) workflow posts advisory PR comments only. It is not a baseline suite or required check, and its findings or silence do not replace owner review, independent review, CI results, or real-game evidence.

Dependency upgrades (especially Electron, Node, better-sqlite3, SDK, or protocol tooling) need the relevant native, packaged, and migration checks in addition to unit tests. Real-game checks are triggered before release and earlier for SDK, window/input behavior, game/client compatibility, or native changes that simulation cannot validate. If a necessary machine or game is unavailable, keep the required acceptance evidence pending rather than claiming success.

## 6. Test reliability and evidence

- A test asserts observable behavior or a documented invariant, not private implementation details. Prefer values, outcomes, and state transitions over broad UI snapshots, especially while design is deferred.
- Retain failing scenario/seed, expected-versus-actual values, bounded sanitized logs, and useful Playwright traces/screenshots. Include app commit, protocol/schema/tool versions, commands, and relevant environment details in the report.
- Default to no retries for deterministic logic and integration tests. A retry used to diagnose an Electron/environment failure must remain visible; a pass after failure does not erase flakiness. Investigate rather than repeatedly rerunning until green. See [Playwright retry reporting](https://playwright.dev/docs/test-retries).
- Temporary quarantine requires a linked defect, owner, reason, and agreed restoration point plus alternative verification. Critical trip-integrity/ACK/migration regressions cannot be silently skipped to make a release pass.
- Collect line and branch coverage for the domain and protocol modules once they exist, using [Vitest coverage](https://vitest.dev/guide/coverage). Use it to find untested decisions. Review missing critical branches; select enforceable module thresholds after the first meaningful baseline. A global percentage or test count is not proof that history is correct.
- Compare long-running resource/performance measurements under recorded, comparable conditions. Virtual-time or accelerated replay is useful for logic and size checks but cannot certify one-hour wall-clock stability, display latency, or game frame-time impact.

## 7. Real-game acceptance record

ET-009 validates the prototype; ET-020 validates the release candidate. Keep a matrix for ETS2 and ATS, each in single-player, Convoy, and TruckersMP, with windowed and borderless modes. Record exact game/client/app/SDK versions, Windows version, relevant hardware, monitor/DPI configuration, launch order, scenario outcome, and evidence. A game or TruckersMP update may require revalidation; support is tied to versions actually tested.

Test startup order, real values, pause/resume, Alt+Tab, click-through, minimize/restore, monitor changes, delivery/cancellation, reconnect, and orderly exit. Before release, also cover the journal/export, setup/upgrade, history preservation, and measured one-hour session. Do not require every game combination for unrelated text changes, and do not use a successful simulator run as evidence of real-game support.

## 8. Later server phase

When ET-101 resolves the future-phase requirements, extend this strategy with API/schema compatibility, authentication and company isolation, idempotent uploads, offline/restart recovery, credential/account-switch behavior, and report reconciliation. Use a disposable real PostgreSQL instance for backend integration, and preserve the existing offline desktop suite as a regression gate. Those tests and server infrastructure are outside the local MVP implementation phase.

## 9. Handoff for every behavior change

The PR and task handoff identify the protected requirement/scenario, tests added or updated, actual commands/results on the current commit, and any manual checks still needed. Explain a justified test omission instead of inventing coverage. Update the scenario registry, fixtures, and this document when behavior or test entry points change. Move a card to Review with evidence; Done requires accepted criteria, including regression protection for the behavior implemented.

### ET-001 recovery checks and runtime hold

The owner revoked the native Electron/application launch hold and removed the VM requirement on October 11, 2026. Native lifecycle acceptance now uses the [ownership harness](tests/windows/README.md), normal Job completion, isolated probes and preserved owner state. Composite acceptance combines six actual operations with a separate corrected uninstall predicate and exact cleanup; it never relabels the original failed wrapper report. Historical guest proof remains separate. An earlier standalone Playwright launch timeout remains unexplained; longer stability and host-freeze resolution are not established. See [setup](docs/setup.md#packaged-startup-recovery-hold-october-11-2026) and [validation](docs/validation/et-001.md).

| Requirement | Executable regression protection | Evidence boundary |
| --- | --- | --- |
| Partial REG-011 startup/stop races | `tests/unit/service-probe.test.ts`, `tests/unit/service-supervisor.test.ts` | Deterministic Node tests; no Electron runtime claim |
| Bounded/private startup logs | `tests/unit/diagnostics.test.ts` | Temporary filesystem and failed-destination cases |
| Physical ASAR entrypoints and isolated native dependency resolution | `tests/unit/scaffold.test.ts`, `scripts/inspect-package.mjs` | Reads packaged bytes and resolves files; never loads the native binding |
| Reviewed package identity includes unpacked code and native/binary assets | `tests/unit/package-integrity.test.ts`, `scripts/verify-package.ps1`, `scripts/package-integrity.mjs` | Inert fixtures check Node/PowerShell fingerprint agreement, same-ASAR unpacked corruption, extra files, altered EXE bytes, and invalid header/path/link rejection; never executes the fixtures |
| External process containment | `tests/watchdog/run.ps1` | Real Windows Job Objects with harmless Node fixtures; timeout, orphan, watchdog death, bounded logs and unrelated-process preservation |
| Installer controller custody and process provenance | `tests/vm/Test-InstallerController.ps1`, `tests/vm/Test-InstallerConsoleCustody.ps1`, `tests/unit/installer-root-proof.test.ts`, `tests/unit/installer-driver-provenance.test.ts`, `tests/unit/installer-helper-provenance.test.ts` | Eighteen actual bounded native controls passed against controller 19a4c5fb; pure assertions protect readiness, late-console ordering, native exits and retained parent identities. Metadata-authority changes require fresh source/library review and installed guest proof |
| Packaged app / partial REG-017 | `tests/electron/startup.spec.ts`; `tests/windows/Invoke-NativeInstallerAcceptance.ps1`; `tests/windows/Test-UninstallResidue.ps1`; historical guest harness | Six actual native operations plus separate corrected uninstall evaluation and owned cleanup accepted; original failed report preserved. Both installed smokes verify native probe/security/normal shutdown. Twelve inert residue cases reject corrupt/unexpected files, registration, links and reparse points. Synthetic preservation does not establish production migrations/full REG-017 coverage |

Do not reproduce the previous host freeze to obtain a red test. Static package inspection exposed SQLite resolving outside the package before the full module was unpacked; the retained inspector rejects that layout. The first orphan fixture used Node's own child cleanup and did not leave an orphan; the corrected fixture uses a detached child to exercise watchdog cleanup. No physical-host Electron retries were performed during recovery; the separately authorized VM startup runs are recorded above.
