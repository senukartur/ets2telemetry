# Regression scenario-to-test registry

Read the full requirements in [TESTING.md](../TESTING.md). Pending means the owning component has not implemented an executable scenario; there are no passing empty cases. Partial protection does not satisfy the complete REG requirement.

| Scenario | Status / existing executable protection | Remaining owner / boundary |
| --- | --- | --- |
| REG-001 normal job/road stop/delivery | Pending | ET-014, ET-015 domain/1 Hz integration |
| REG-002 pause/resume | Pending | ET-014, ET-015 controlled-clock samples/events |
| REG-003 late attachment/gap | Partial: `tests/unit/protocol-v0.test.ts`, native `protocol-v0-contract`, shared checkpoint/continuity streams; `tests/unit/simulator-v0.test.ts` synthetic replay and actual test pipes exercise reconnect hydration, offline counters and stale-until-checkpoint | ET-006, ET-014, ET-015 actual desktop ingestion/recording completeness |
| REG-004 cancellation/disappearance | Pending | ET-003, ET-014 terminal payload/lifecycle |
| REG-005 duplicate/order | Partial: shared v0 ordering streams reject duplicate/regressing sequence, changed identity/clock, and counter regression in TypeScript and C++ | ET-002b, ET-004, ET-014, ET-015 durable redelivery/accounting |
| REG-006 crash before commit/ACK | Pending | ET-004, ET-013, ET-015 actual storage process recovery |
| REG-007 failed writes/bounded buffer | Pending | ET-013, ET-015 durable ACK/failure integration |
| REG-008 resets/truck/refueling | Pending | ET-010, ET-014 domain discontinuities |
| REG-009 missing/zero/units | Partial: shared v0 availability/unit fixtures and materialized zero/unavailable assertions in TypeScript and C++; synthetic simulator fixtures preserve canonical units, explicit availability, reverse speed and legitimate zero | ET-003, ET-010 actual SDK normalization and trip averages |
| REG-010 frame parser/version | Partial: `tests/unit/protocol-v0.test.ts`, native `protocol-v0-contract`, identical `tests/fixtures/protocol-v0` bytes; split/coalesced/invalid UTF-8/duplicate keys/depth/frame bounds/version/uint64 checks; `simulator-v0.test.ts` and CLI test-pipe smoke reject malformed handshake/frames and incomplete hydration | ET-002b v1, ET-004/ET-006 production pipe/desktop ingestion integration; fuzz/sanitizer coverage pending |
| REG-011 stalled reader/reconnect/shutdown | Partial: `tests/unit/service-probe.test.ts`, `service-supervisor.test.ts`; `tests/watchdog/run.ps1`; `scripts/ci/Invoke-RuntimeSmoke.ps1` orderly scaffold worker stop; `simulator-v0.test.ts` actual synthetic pipes cover slow readers, bounded waits, cancellation and immediate reconnects | ET-004, ET-006 native production pipe queues/callback bounds/gap semantics pending |
| REG-012 close-to-tray/instance/restart | Pending; scaffold explicit smoke shutdown is not recording persistence | ET-011, ET-015 app lifecycle |
| REG-013 historical migrations | Pending; no production schema or historical database exists | ET-013, ET-018 immutable supported/unsupported-newer fixtures |
| REG-014 journal/export | Pending | ET-016 reconciliation/cancellation |
| REG-015 project DLL management | Pending; placeholder is never installed in a game | ET-017, ET-018 actual game path/plugin ownership |
| REG-016 overlay/DPI/focus | Pending | ET-007, ET-008, ET-012 and real games |
| REG-017 packaged startup/upgrade/history | Partial: `tests/unit/scaffold.test.ts`, `package-integrity.test.ts`, `scripts/inspect-package.mjs`, CI packaged SQLite worker smoke, `tests/windows/Test-UninstallResidue.ps1`; earlier ET-001 native installer evidence in its validation record | ET-018, ET-020 full production history/settings/migration upgrade pending |
| REG-018 sustained one-hour | Pending | ET-019, ET-020 real duration/resource/game evidence |

Shared fixtures: `tests/shared/resources.ts` offers unique temporary database paths and Windows pipe names, owner-only cleanup, controlled time and deterministic synthetic IDs. Its resource test uses inert bytes, not native SQLite; production pipe/storage integrations must exercise real implementations as they arrive. No protocol/domain coverage thresholds or native parser sanitizer target are advertised before those components exist.
