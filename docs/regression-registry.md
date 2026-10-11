# Regression scenario-to-test registry

Read the full requirements in [TESTING.md](../TESTING.md). Pending means the owning component has not implemented an executable scenario; there are no passing empty cases. Partial protection does not satisfy the complete REG requirement.

| Scenario | Status / existing executable protection | Remaining owner / boundary |
| --- | --- | --- |
| REG-001 normal job/road stop/delivery | Pending | ET-014, ET-015 domain/1 Hz integration |
| REG-002 pause/resume | Pending | ET-014, ET-015 controlled-clock samples/events |
| REG-003 late attachment/gap | Partial: shared checkpoint/continuity streams; `simulator-v0.test.ts` and `telemetry-service-v0.test.ts` cover reconnect hydration, stale-until-checkpoint, authority mismatch and retirement of the prior connection | ET-006a historical 7595cbf actual Electron/native interoperability proof passed; accepted-main integration checks pending; ET-014/015 recording completeness |
| REG-004 cancellation/disappearance | Pending | ET-003, ET-014 terminal payload/lifecycle |
| REG-005 duplicate/order | Partial: shared v0 ordering streams reject duplicate/regressing sequence, changed identity/clock, and counter regression in TypeScript and C++ | ET-002b, ET-004, ET-014, ET-015 durable redelivery/accounting |
| REG-006 crash before commit/ACK | Pending | ET-004, ET-013, ET-015 actual storage process recovery |
| REG-007 failed writes/bounded buffer | Pending | ET-013, ET-015 durable ACK/failure integration |
| REG-008 resets/truck/refueling | Pending | ET-010, ET-014 domain discontinuities |
| REG-009 missing/zero/units | Partial: shared v0 availability/unit fixtures and materialized zero/unavailable assertions in TypeScript and C++; synthetic simulator fixtures preserve canonical units, explicit availability, reverse speed and legitimate zero | ET-003, ET-010 actual SDK normalization and trip averages |
| REG-010 frame parser/version | Partial: shared TypeScript/C++ wire fixtures; simulator/CLI and `telemetry-service-v0.test.ts` reject malformed handshake/frames and incomplete hydration; `native-pipe-client` uses actual controlled Windows peer identity and bounded relay | ET-002b v1; historical ET-004a69a/ET-006a7595 interoperability and hosted client ASan passed; current accepted-main integration checks and fuzz coverage pending |
| REG-011 stalled reader/reconnect/shutdown | Partial: service supervisor/probe and watchdog tests; actual simulator pipes; `telemetry-service-v0.test.ts` covers one-inflight/one-pending subscriptions, stale data and restart bounds; native client controls exercise withheld relay credit and EOF cancellation | Historical ET-004a69a/ET-006a7595 integration and four bounded runtime jobs passed, including renderer reloads and owned service termination. Current accepted-main integration evidence remains pending; v1 event queue/ACK coverage deferred |
| REG-012 close-to-tray/instance/restart | Pending; scaffold explicit smoke shutdown is not recording persistence | ET-011, ET-015 app lifecycle |
| REG-013 historical migrations | Pending; no production schema or historical database exists | ET-013, ET-018 immutable supported/unsupported-newer fixtures |
| REG-014 journal/export | Pending | ET-016 reconciliation/cancellation |
| REG-015 project DLL management | Pending; placeholder is never installed in a game | ET-017, ET-018 actual game path/plugin ownership |
| REG-016 overlay/DPI/focus | Pending | ET-007, ET-008, ET-012 and real games |
| REG-017 packaged startup/upgrade/history | Partial: `tests/unit/scaffold.test.ts`, `package-integrity.test.ts`, `scripts/inspect-package.mjs`, CI packaged SQLite worker smoke, `tests/windows/Test-UninstallResidue.ps1`; earlier ET-001 native installer evidence in its validation record | ET-018, ET-020 full production history/settings/migration upgrade pending |
| REG-018 sustained one-hour | Pending | ET-019, ET-020 real duration/resource/game evidence |

Shared fixtures: `tests/shared/resources.ts` offers unique temporary database paths and Windows pipe names, owner-only cleanup, controlled time and deterministic synthetic IDs. Its resource test uses inert bytes, not native SQLite; production pipe/storage integrations must exercise real implementations as they arrive. No protocol/domain coverage thresholds or native parser sanitizer target are advertised before those components exist.
