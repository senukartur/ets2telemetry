# Regression scenario-to-test registry

Read the full requirements in [TESTING.md](../TESTING.md). Pending means the owning component has not implemented an executable scenario; there are no passing empty cases. Partial protection does not satisfy the complete REG requirement.

| Scenario | Status / existing executable protection | Remaining owner / boundary |
| --- | --- | --- |
| REG-001 normal job/road stop/delivery | Pending | ET-014, ET-015 domain/1 Hz integration |
| REG-002 pause/resume | Pending | ET-014, ET-015 controlled-clock samples/events |
| REG-003 late attachment/gap | Partial: `tests/unit/protocol-v0.test.ts`, native `protocol-v0-contract`, shared checkpoint/continuity streams; v0 hydration has no gameplay effects | ET-006, ET-014, ET-015 actual ingestion/recording completeness |
| REG-004 cancellation/disappearance | Partial: native `sdk-adapter-contract` preserves copied signed terminal payloads across job/truck clear in either callback order; disappearance creates no delivery | ET-014 trip outcomes; CAP-01 actual callback order and game observations |
| REG-005 duplicate/order | Partial: shared v0 ordering streams reject duplicate/regressing sequence, changed identity/clock, and counter regression in TypeScript and C++ | ET-002b, ET-004, ET-014, ET-015 durable redelivery/accounting |
| REG-006 crash before commit/ACK | Pending | ET-004, ET-013, ET-015 actual storage process recovery |
| REG-007 failed writes/bounded buffer | Pending | ET-013, ET-015 durable ACK/failure integration |
| REG-008 resets/truck/refueling | Partial: native `sdk-adapter-contract` rotates game clocks on timer/time regression and invalidates dynamic truck readings on configuration boundaries | ET-010, ET-014 refueling/domain discontinuities and actual game observations |
| REG-009 missing/zero/units | Partial: shared v0 fixtures and native `sdk-adapter-contract` cover missing/invalid/zero, exact u64/s64, km-to-m and L/km-to-L/100km using fake SDK callbacks and pinned headers | ET-010 trip averages; actual game channel/unit/currency observations pending |
| REG-010 frame parser/version | Partial: `tests/unit/protocol-v0.test.ts`, native `protocol-v0-contract` and console `protocol-v0-asan-contract` exercise the shared bounded v0 corpus; `sdk-adapter-contract` covers API negotiation and bounded SDK-owned string/attribute copies | ET-002b v1, ET-004/ET-006 actual pipe/ingestion; fuzzing and live SDK behavior pending |
| REG-011 stalled reader/reconnect/shutdown | Partial: scaffold service/watchdog checks plus native `sdk-adapter-contract`/`sdk-adapter-asan-contract` exercise nonblocking coherent publication, diagnostic bounds/loss, disconnect erasure, concurrent reads and shutdown/reinitialization with a fake SDK host | ET-004, ET-006 actual transport queues/gap integration; actual game performance pending |
| REG-012 close-to-tray/instance/restart | Pending; scaffold explicit smoke shutdown is not recording persistence | ET-011, ET-015 app lifecycle |
| REG-013 historical migrations | Pending; no production schema or historical database exists | ET-013, ET-018 immutable supported/unsupported-newer fixtures |
| REG-014 journal/export | Pending | ET-016 reconciliation/cancellation |
| REG-015 project DLL management | Pending; placeholder is never installed in a game | ET-017, ET-018 actual game path/plugin ownership |
| REG-016 overlay/DPI/focus | Partial candidate: native `game-window-monitor-contract` and separate console ASan copies exercise actual controlled Win32 lifecycle, negative window origin, one-monitor DPI, unrelated host/PID rejection, ambiguity, minimized unavailable bounds, recreation and shutdown | ET-007 production transport binding, mixed-DPI/negative monitor topology/removal/elevation and actual game focus/input checks pending; ET-008/012 overlay behavior pending |
| REG-017 packaged startup/upgrade/history | Partial: `tests/unit/scaffold.test.ts`, `package-integrity.test.ts`, `scripts/inspect-package.mjs`, CI packaged SQLite worker smoke, `tests/windows/Test-UninstallResidue.ps1`; earlier ET-001 native installer evidence in its validation record | ET-018, ET-020 full production history/settings/migration upgrade pending |
| REG-018 sustained one-hour | Pending | ET-019, ET-020 real duration/resource/game evidence |

Shared fixtures: `tests/shared/resources.ts` offers unique temporary database paths and Windows pipe names, owner-only cleanup, controlled time and deterministic synthetic IDs. Its resource test uses inert bytes, not native SQLite; production pipe/storage integrations must exercise real implementations as they arrive. ET-003 console sanitizer targets exercise the bounded parser corpus and fake-host adapter, with executed results and limitations in [validation](validation/et-003.md). No full fuzzing or domain coverage threshold is claimed.
