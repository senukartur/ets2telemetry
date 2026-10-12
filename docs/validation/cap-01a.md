# CAP-01a validation record

Recorded October 12, 2026. Package CAP-01a is the no-game implementation part of CAP-01 (card ET-009, <https://trello.com/c/Y3qJd9aF>): the [CAP0 evidence capture transport](../protocol/cap0.md). It implements the owner-approved "Proposed first implementation interface and bounds" of the CAP-01 decision brief (approved October 12, 2026). Branch `feat/cap01-capture-transport`, verified base `origin/main` `224505f423c5605512ae3479c2bc6ebbcb5ceb6f`.

This record contains only checks that were actually run, on the worker's local Windows 11 host. It is not acceptance. **No game was launched and no real-game evidence exists.** CAP-01 acceptance, ET-009 Done and every real-game observation remain pending. No DLL was installed into a game directory; Electron, Playwright and packaging were not run.

## Environment

Windows 11 Home 10.0.26200, x64. Node 24.19.0 and npm 11.17.0 (portable pinned copy, `NODE_OPTIONS=--use-system-ca`). Visual Studio 18 Community developer shell (`Launch-VsDevShell.ps1 -Arch amd64`), CMake 4.3.1-msvc1, MSVC tools 14.51.36231, Windows SDK 10.0.26100.0. ASan runtime from `VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64`. Commands ran from the worktree root.

## Commands and results

| Command | Result |
| --- | --- |
| `npm ci` | Passed; 310 packages added, 0 vulnerabilities reported |
| `npm run typecheck` | Passed, no diagnostics |
| `npm run lint:install` then `npm run lint` | Passed, zero errors and zero warnings |
| `npm test` | **29 files, 528 tests passed** (22.99 s). New: `capture-cap0` 11, `capture-writer` 8, `capture-session` 5, `capture-broker-client` 6, `capture-export` 2, `main-boundaries` +2 (494 pre-existing tests in 24 files unchanged and passing) |
| `npm run native:configure`, `npm run native:build`, `npm run native:test` | **29/29 CTest passed** (24.85 s): the 21 pre-existing cases unchanged and passing, plus `capture-cap0-contract-{queue,adapter,wire,server,stall,rejection,v0-isolation}` and `capture-cap0-dll-contract` |
| `cmake -S native/telemetry-plugin -B native/telemetry-plugin/build-asan -A x64 -DETS2TELEMETRY_ASAN_TESTS=ON`, build of the CI ASan target list plus `capture-cap0-asan-test`, `ctest ... -R asan-contract` | **23/23 passed** (30.0 s), including the seven `capture-cap0-asan-contract-*` cases; no sanitizer finding |
| `cmake -S native/telemetry-client -B native/telemetry-client/build -A x64`, build, `ctest --test-dir native/telemetry-client/build -C Release --output-on-failure` | **1/1 passed** (`native-pipe-client`, 22.9 s) including the new `capture`, `capture-v0-hello` and `capture-bad-arguments` cases |
| `npm run build` | Passed: native client CMake build, Vite desktop/renderer bundles, simulator bundle |
| `npm run test:cap0-chain` | **1/1 passed** (0.76 s test body): tests-only fake-SDK host `eurotrucks2.exe` + test plugin DLL + native broker `--capture cap0` + TypeScript session/writer + built export CLI |
| `npm run capture:export -- C:\nonexistent-cap0-capture C:\nonexistent-cap0-export` | Built the CLI; exited 1 with `ENOENT ... manifest.json` (expected error path). The positive CLI path ran inside `test:cap0-chain` |
| `dumpbin /exports` and `/dependents` on `ets2telemetry-plugin.dll` | Production exports exactly `scs_telemetry_init` and `scs_telemetry_shutdown`; imports only system DLLs (bcrypt, USER32, ADVAPI32, SHELL32, ole32, KERNEL32). The test seam `ets2telemetry_test_capture_endpoint` exists only in `snapshot-transport-test-plugin.dll` |

`npm run lint:ps` was not run: no PowerShell file was added or changed. CI was not run (no push); the CI workflow now also builds `capture-cap0-asan-test`, which was verified only locally with the Visual Studio 18 generator, not the hosted Visual Studio 17 2022 generator.

## Criteria and evidence

| Approved element | Evidence (controlled, synthetic) | Remaining |
| --- | --- | --- |
| Separate versioned contract, v0 unchanged | v0 sources, fixtures and the 21 pre-existing CTest and 494 Vitest cases are unchanged and pass. `adapter` compares an evidence-enabled adapter with a reference adapter: identical boundary order, configuration revision, continuity counters, game time and v0 diagnostic batch. Vitest and C++ assert that v0 decoders reject all CAP0 packets and the CAP0 hello, and that CAP0 rejects v0 fixtures; the v0 server rejects a CAP0 hello | Hosted CI on the final head |
| Copy in callbacks, no extra SDK calls | `adapter`: configuration/gameplay/lifecycle/timer-restart/game-time-regression envelopes; strings copied before source memory mutation; exact u64 `UINT64_MAX`, s64 `INT64_MIN`, indexed fvector, dplacement, non-finite/invalid UTF-8/oversized values and names explicit; unterminated 256-entry scan marked; null attributes explicit. All fake SDK API entries ran on the SDK thread (`wrong_thread == 0`) in every case, including with both workers active | Real SDK callback payloads |
| Background serialization only, callbacks never blocked | `stall`: 200 configuration callbacks of 268,530-byte envelopes while the capture client stopped reading took 47 ms in total, worst single callback 0.49 ms; the queue stayed within bounds while the worker was blocked in pipe I/O | Real frame-time impact |
| 128 envelopes / 2 MiB, newest-drop, loss counters | `queue`: 129th envelope dropped with slot counter; byte cap admitted exactly 7 large envelopes; 400 wrap-around cycles kept FIFO identity and contents (1 counted wrap drop); closed gate copies nothing. `stall`: 192 of 200 dropped; every gap equals `droppedBefore`; loss packet totals match the producer | Real event rates |
| 64 KiB packets, omissions counted | `wire`: a 255 x 1,024-byte control-character envelope split into 26 packets at 64 KiB (255 at an 8 KiB test limit), all within the limit, contiguous ranges, every attribute exactly once; an unrepresentable limit fails explicitly | None identified |
| Header identity, exact 64-bit values, clock domains | `server`: header binds game/process/session/plugin identities, source clock id and producer image SHA-256; publication follows callback time in the source clock; Vitest checks decimal-string preservation through decoder, writer file and export | Real version/unit/currency observations |
| Separate keyed endpoint, local-user security, broker authority, opt-in | `server`: CAP0 name derived from process instance and plugin session; protected DACL verified; second client busy. `rejection`: v0 hello, wrong version, 4,097-byte prefix, trailing byte, malformed hello, missing hello (measured five-second deadline) and unapproved image digest all close without opening the gate. Client test: broker capture receipt carries `evidence:"cap0"`, connects only to the CAP0 endpoint, rejects a v0 hello and invalid mode arguments | Second-user, remote and elevation matrix not executed |
| No offline spool; disconnect, end and shutdown markers | `server`: nothing copied before opt-in or between captures; a new client restarts at `envelopeSeq` 1; shutdown drains and sends `plugin-shutdown` (0 unsent) within bounded time. `dll`: official init/shutdown/FreeLibrary with a connected capture client delivered the end marker | Pathological OS I/O noncompletion remains as in ET-004a |
| Capture never blocks v0 | `v0-isolation`: 32 v0 snapshots were received while the capture client was stalled; the stalled capture was retired by its write deadline independently | Real game load |
| Application writer bounds and evidence on close | `capture-writer.test.ts`: pending cap with a slow write, file cap, controlled-timer deadline, write failure (manifest still written), disconnect inside a split envelope, protocol error, approved-limit enforcement and no directory reuse; manifest hashes match file bytes; output only under `captures\<session>` | None for synthetic inputs |
| Fixed non-renderer client, default-off activation | `capture-broker-client.test.ts`: fixed broker arguments with `--capture cap0`, v0 receipt rejected, one packet per credit, waiting/exit mapping; activation off by default, interval 1-60, label pattern, grant validation. `main-boundaries.test.ts`: grant attached once to the first verified ETS2 selection, not renewed for later selections; invalid activation rejected and logged | Electron runtime path not launched |
| Real pipe integration with a fake SDK source | `capture-session.test.ts` over actual named pipes (complete, mid-envelope disconnect, malformed frame, absent source until deadline, service stop). `test:cap0-chain`: fake-SDK host and test DLL through the native broker to a complete `synthetic` manifest with 5 packets/3 envelopes and exact values | Actual ETS2/ATS process |
| Export/sanitize | `capture-export.test.ts` and the chain's CLI run: raw integrity verified; UUIDs, process/session IDs, creation times, user tag, display id and paths replaced by stable first-appearance tokens; values and order kept; tampered input and existing output refused | Reviewer judgement on game-provided strings |

## Pending (not done by this package)

- All real-game CAP-01 evidence: ETS2 and ATS; single-player, Convoy and TruckersMP; windowed and borderless; accept/deliver/cancel/config-clear/menu/pause/late-attach/reconnect/save-load/ferry/train/refuel observations; units, currency and clock behaviour; loss annotations from real sessions. Unobserved events remain synthetic or unverified.
- First real use of the Electron activation path (`ETS2TELEMETRY_CAPTURE=cap0`), installed/packaged behaviour and the measured game frame-time impact of the capture copy.
- Second-user, remote-client and elevation rejection on actual hosts; hosted CI on the final head; independent review.
- SP-01 windowed retry and Convoy, and every other previously pending gate, are unchanged.
