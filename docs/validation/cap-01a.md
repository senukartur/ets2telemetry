# CAP-01a validation record

Recorded October 12, 2026. Package CAP-01a is the no-game implementation part of CAP-01 (card ET-009, <https://trello.com/c/Y3qJd9aF>): the [CAP0 evidence capture transport](../protocol/cap0.md). It implements the owner-approved "Proposed first implementation interface and bounds" of the CAP-01 decision brief (approved October 12, 2026). Branch `feat/cap01-capture-transport`, verified base `origin/main` `224505f423c5605512ae3479c2bc6ebbcb5ceb6f`.

This record contains only checks that were actually run. The implementation worker's checks ran on its local Windows 11 host. The worker launched no game, installed no DLL into a game directory and did not run Electron, Playwright or packaging. The owner later ran ETS2 single-player sessions through `npm run dev`; they are recorded under [Owner game sessions](#owner-game-sessions-october-12-2026). They are evidence, not acceptance. CAP-01 acceptance, ET-009 Done and the rest of the real-game matrix remain pending.

## Environment

Windows 11 Home 10.0.26200, x64. Node 24.19.0 and npm 11.17.0 (portable pinned copy, `NODE_OPTIONS=--use-system-ca`). Visual Studio 18 Community developer shell (`Launch-VsDevShell.ps1 -Arch amd64`), CMake 4.3.1-msvc1, MSVC tools 14.51.36231, Windows SDK 10.0.26100.0. ASan runtime from `VC\Tools\MSVC\14.51.36231\bin\Hostx64\x64`. Commands ran from the worktree root.

## Commands and results

The native results below are for head `a5297f9`, after the fourth review (`86bab17` had passed the same checks after the third review). The TypeScript results (typecheck, lint, `npm test`) are from `3d0d67d`; later commits changed only native code, tests and documentation. Earlier heads also passed their checks: the first candidate `eb98e66` (29 Vitest files/528 tests, 29/29 CTest, 23/23 ASan), the first corrected head `d6e69bf` (30 files/543 tests, 33/33 CTest, 27/27 ASan), `3d0d67d` (34/34 CTest, 28/28 ASan) and `2b94f5b` (the coordinator's full rerun).

| Command | Result (`a5297f9` native, `3d0d67d` TypeScript) |
| --- | --- |
| `npm ci` | Passed at the start of the package; 310 packages added, 0 vulnerabilities reported |
| `npm run typecheck` | Passed, no diagnostics |
| `npm run lint:install` then `npm run lint` | Passed, zero errors and zero warnings |
| `npm test` | **30 files, 544 tests passed** (23.17 s). CAP0 tests: `capture-cap0` 12, `capture-writer` 10, `capture-session` 11, `capture-broker-client` 6, `capture-export` 5, `capture-controller` 3, `main-boundaries` +3. The 494 pre-existing tests are unchanged and pass |
| `npm run native:configure`, `npm run native:build`, `npm run native:test` | **35/35 CTest passed** (28.66 s on `a5297f9`). The 21 pre-existing cases are unchanged and pass, plus `capture-cap0-contract-{queue,adapter,wire,server,stall,rejection,v0-isolation,counters,stop-inflight,stop-slow-reader,stop-drain-boundary,stop-clean-markers,stop-stalled-partial,stream-verifier,v0-continuity,clock}` and `capture-cap0-dll-contract` |
| `cmake -S native/telemetry-plugin -B native/telemetry-plugin/build-asan -A x64 -DETS2TELEMETRY_ASAN_TESTS=ON`, build of the CI ASan target list plus `capture-cap0-asan-test`, `ctest ... -R asan-contract` | **29/29 passed** (39.48 s on `a5297f9`), including the thirteen `capture-cap0-asan-contract-*` cases; no sanitizer finding |
| Repeated runs on `3d0d67d`: `capture-cap0-asan-test counters` (3x) and `stop-slow-reader` (2x), Release `counters` (3x) and `stop-slow-reader` (3x) | All passed. ASan `counters` had 1,532-1,573 overlapping samples per run, Release 89,554-93,230. `stop-slow-reader` stopped in 453-454 ms under ASan and 453-468 ms in Release |
| Repeated runs on `86bab17`: ASan `stop-slow-reader` (2x) and `stop-drain-boundary` (2x); Release `stop-slow-reader` (3x) and `stop-drain-boundary` (3x); ASan `stop-inflight` (3x, before the commit) | All passed. `stop-slow-reader` stopped in 453-454 ms with a valid stream and no marker, because a 25 ms-paced reader cannot drain the pipe buffer in the reserved 100 ms. `stop-drain-boundary` stopped in 360-375 ms and received `end` (`plugin-shutdown`, unsent=33) every time. ASan `stop-inflight` stopped in 375 ms and ended with the marker (6 unsent). It had failed once on `c144504`, before the drain-fit estimate |
| Repeated stop cases on `a5297f9`: Release `stop-inflight` (2x), `stop-slow-reader` (2x), `stop-drain-boundary` (3x); ASan `stop-inflight`, `stop-slow-reader`, `stop-drain-boundary` (2x each) | All passed. Release: `stop-inflight` 78-94 ms with the end marker (0 unsent); `stop-slow-reader` 453 ms with a valid stream and no marker; `stop-drain-boundary` (reader without sleeps) 15-32 ms with the end marker (0 unsent). ASan: `stop-inflight` 375-390 ms with the marker (6 unsent); `stop-slow-reader` 453 ms, no marker; `stop-drain-boundary` 453 ms with the marker (21 unsent, first packet never issued) |
| Counters case on `51f6925` (after hosted CI failure) | ASan `capture-cap0-asan-test counters` run 5x on 2 cores (`start /affinity 3`): passed, 1,330-4,578 overlapping samples, about 1.03-1.05 s each. 3x on 1 core (`/affinity 1`): passed, about 28-29k samples, about 1.1 s. Release 3x unconstrained (about 1.47-1.49 million samples) and 2x on 2 cores: passed. RED: the `eb98e66` queue failed `every concurrent counter sample and loss packet is internally consistent` twice unconstrained and once on 2 cores. After the change, `npm run native:test` passed 35/35 and `ctest -R asan-contract` passed 29/29 (ASan counters 1.02 s) |
| Timing-sensitive cases on `52d581e` (after hosted CI failure) | Each run 5x under ASan on 2 cores (`start /affinity 3`), all passed. `stop-inflight`: end marker every run, 3-5 unsent, 328-516 ms. `stop-slow-reader`: 453-469 ms, valid stream, no marker. `stop-drain-boundary`: 437-484 ms, end marker with 21-22 unsent. `stop-clean-markers`: end marker, 0 unsent, 47 ms. `stall` (60 attempts): 52 dropped, production 46-62 ms. `server` and `counters` also passed (3,250-4,962 overlapping samples). Release 3x of `stop-inflight`, `stop-slow-reader`, `stop-drain-boundary`, `stop-clean-markers` and `stall`: all passed. After the change, `npm run native:test` passed 36/36 and `ctest -R asan-contract` passed 30/30 |
| Stop and stream cases on `0d52ff4` | Each run 5x under ASan on 2 cores (`start /affinity 3`) and 3x in Release, all passed. ASan `stop-inflight`: four runs ended with the marker (4 unsent, 390-547 ms); one ended cleanly without a marker after a cancelled pending write (531 ms), which the contract allows. `stop-slow-reader`: 453-469 ms, clean. `stop-drain-boundary`: 437-469 ms, end marker. `stop-clean-markers`: end marker, 0 unsent. `stop-stalled-partial`: about 453 ms, clean, no marker. `stream-verifier`: passed. Negative controls: `stream-verifier` failed with the partial-frame marker check removed. `stop-stalled-partial` failed in 3 of 3 runs (outcome `end`) when a cancelled pending write was trusted as never issued. Neither change was committed. After the change, `npm run native:test` passed 38/38 and `ctest -R asan-contract` passed 32/32 |
| Counters case on `c37d20c` (handshake design) | All passed: ASan `counters` 10x on 1 core (`start /affinity 1`), 109-139 ms wall, 856-1,833 overlapping samples (minimum 200); 10x on 2 cores (`/affinity 3`), 141-194 ms, 1,317-2,500; 3x unconstrained, 128-138 ms. Release 5x unconstrained, 0-31 ms of test time, about 11.6-11.9k samples (minimum 1,000); 2x on 1 core, about 95 ms; 2x on 2 cores, 39-42 ms. Every run had drops, enqueues and attempted = bursts x 64. RED: the `eb98e66` queue failed `every concurrent counter sample and loss packet is internally consistent` 3/3 unconstrained and 2/2 on 2 cores. An intermediate version without the reader yield took 16-18 s on one Release core; the yield fixed it before commit. After the change, `npm run native:test` passed 38/38 and `ctest -R asan-contract` passed 32/32 (ASan counters 0.12 s) |
| Startup-wait cases on `97b0e67`, compared with unchanged `main` `224505f` (separate checkout, scratch ASan build directory) | `snapshot-transport-asan-test accept-failure`, run alone 30x on 2 cores (`/affinity 3`) and 30x unconstrained: both trees passed 60/60 (wall 60-562 ms, medians 77 ms and 92 ms). Contention reproduces the hosted failure. With 64 concurrent ASan instances on one core, `main` failed `accept-failure` in 21/192, 11/192 and 9/64 runs with exactly `unknown accept startup succeeds`. With 64 instances on 2 cores it failed 4/128. With 64 instances on one core, `main` `accept-disconnect` failed 51/192 (`injected disconnect startup` and `listening`). The branch on `a79203a` failed the same way, 10/128. With the fix, all of these passed: `accept-failure` 192/192 on one core and 128/128 on 2 cores; `accept-disconnect` 192/192 on one core. Observed startups took up to 3,985 ms on one core, and 169 of 576 exceeded 1 s. Run alone, startup took 0-16 ms (60 startups, timer resolution). Run alone, `v0-isolation` passed 10/10. One earlier 64-way `accept-disconnect` batch on `a79203a` did not finish within its 300 s wait; it did not recur in the nine later 64-way batches (576 runs, each batch 5-9 s). The timing-throughput CAP0 case `v0-isolation` is not expected to pass under 32-way single-core oversubscription (4/32 passed: too few snapshots in its 2 s window). After the change, `npm run native:test` passed 38/38 and `ctest -R asan-contract` passed 32/32 |
| `ctest --test-dir native/telemetry-client/build -C Release --output-on-failure` (after `npm run build` rebuilt the client) | **1/1 passed** (`native-pipe-client`, 22.88 s on `a5297f9`), including the `capture`, `capture-v0-hello` and `capture-bad-arguments` cases |
| `npm run build` | Passed on `a5297f9`: native client CMake build, Vite desktop/renderer bundles, simulator bundle |
| `npm run test:cap0-chain` | **1/1 passed** (1.05 s on `a5297f9`): tests-only fake-SDK host `eurotrucks2.exe` + test plugin DLL + native broker `--capture cap0` + TypeScript session/writer + built export CLI |
| `npm run capture:export -- C:\nonexistent-cap0-capture C:\nonexistent-cap0-export` (first candidate) | Built the CLI; exited 1 with `ENOENT ... manifest.json` (expected error path). The positive CLI path runs inside `test:cap0-chain` |
| `dumpbin /exports` and `/dependents` on `ets2telemetry-plugin.dll` (first candidate; `sdk-exports.cpp` unchanged since) | Production exports exactly `scs_telemetry_init` and `scs_telemetry_shutdown` and imports only system DLLs. The test seam `ets2telemetry_test_capture_endpoint` exists only in `snapshot-transport-test-plugin.dll` |
| RED check: `capture-cap0-test counters` built against the `eb98e66` queue | Failed: `every concurrent counter sample and loss packet is internally consistent`. With the fixed queue, Release passed three runs (559,704-591,384 overlapping samples) and the ASan run had 7,744 overlapping samples |
| RED check: `capture-cap0-test stop-slow-reader` built against the `6be7c49` capture server (per-write grace) | Failed twice, stopping in 907 ms and 891 ms against the 700 ms bound. With the single stop budget it stops in about 454 ms. The revised `counters` case still fails against the `eb98e66` queue |

One local ASan run on the intermediate head `e118c79` failed `capture-cap0-asan-contract-counters` with `samples overlapped the live producer burst`: the sanitized reader took fewer than 1,000 samples before an unpaced producer finished. The test was corrected in `d6e69bf`, which keeps the burst running until 1,000 samples overlap and paces attempts briefly. All local runs of that case since have passed; hosted runs later failed it twice, see findings I and L and the [hosted run table](#hosted-windows-ci-runs). `npm run lint:ps` was not run because no PowerShell file changed. The workflow builds `capture-cap0-asan-test` and runs `npm run test:cap0-chain` after the native build. Locally this used the Visual Studio 18 generator; the hosted runs below use the Visual Studio 17 2022 generator.

### Hosted Windows CI runs

| Run | Head | Result |
| --- | --- | --- |
| [38300381448](https://github.com/senukartur/ets2telemetry/actions/runs/38300381448) (dispatch) | `960dff7` | Failed: ASan `counters` (finding I) |
| [38305278372](https://github.com/senukartur/ets2telemetry/actions/runs/38305278372) (dispatch) | `41f45de` | Failed: ASan `stop-inflight` (finding J); `counters` passed |
| [38307680711](https://github.com/senukartur/ets2telemetry/actions/runs/38307680711) (dispatch) | `7c98f82` | Failed: ASan `counters` (finding L); the run was cancelled |
| [38309803378](https://github.com/senukartur/ets2telemetry/actions/runs/38309803378) (dispatch) | `a79203a` | Failed: v0 ASan `accept-failure` (finding M); every CAP0 ASan case and the CAP0 chain step passed; later steps were skipped |
| [38312261138](https://github.com/senukartur/ets2telemetry/actions/runs/38312261138) (dispatch) | `43c4f8f` | **Passed, all steps** |
| [38314471366](https://github.com/senukartur/ets2telemetry/actions/runs/38314471366) (Ready for review) | `a1e761e` (merge ref `24f80f4`) | Failed only in the ET-008 overlay stall smoke, which is not a CAP0 step and is under separate investigation |

No hosted run has yet covered the flow-control change in `12043ee` or later heads.

## Owner game sessions (October 12, 2026)

The owner ran ETS2 single-player through `npm run dev` with `ETS2TELEMETRY_CAPTURE=cap0`. The plugin DLL was built from `960dff7`, SHA-256 `39B9CD3663BD6BCDE76AB4356E160C3CF846CC19F6F87DE4B0AA6E6E15F55C47`. Raw and sanitized captures stay on the owner's machine and are not committed. These sessions are evidence for CAP-01, not its acceptance. The game version is not recorded here.

| Run | Mode | Outcome |
| --- | --- | --- |
| 1 (first attempt) | ETS2 single-player | 33 packets captured. The coordinator then hard-stopped the application, so no `manifest.json` exists. This is the documented behaviour for a terminated service, and the exporter refuses such a directory |
| 2 | ETS2 single-player, borderless, late attach, quick job | Capture `complete` with an end marker. 69/69 envelopes, no loss. 10 `player.fined` events. `job.delivered` reported revenue 0, while the job configuration reported income 2635 |
| 3 | ETS2 single-player, windowed, own truck, freight-market job | Capture `complete`. 58/58 envelopes, no loss. 5 fines. `job.cancelled` reported penalty 12000. The owner saw the overlay and live data in windowed mode |

Ordering observed in these sessions:

- On cancellation, the job configuration cleared before `job.cancelled`.
- On delivery, `job.delivered` came before the configuration cleared.

ATS, TruckersMP, the remaining event types and frame-time impact were not observed.

## Independent review corrections

| Finding | Resolution |
| --- | --- |
| 1 Loss-counter tearing (major) | Fixed in `fe5d372`: seqlock-published counters with a consistent last-drop pair. Regression `counters` in `fc87df8`/`d6e69bf`; every stall loss packet is checked against the decoder's rules |
| 2 Unhandled close rejection (major) | Fixed in `7c6c90a`: close never rejects, onClose always runs, transport teardown, `manifestWriteError` on the in-memory result. Tests in `97b2de4` |
| 3 Stop during in-flight write | Fixed in `ad31938`: in-flight write completion, drain and markers within a bounded shutdown window (later tightened to one per-stop budget by finding A); a write that still cannot finish leaves no end marker (documented). Test `stop-inflight` |
| 4 Fabricated zero time | Fixed in `ad31938`: no gate without a clock; an open capture closes without further packets. Test `clock` (console-only seam) |
| 5 `read_current` polling | Fixed in `ad31938`: lock-free `source_live()`. Test `v0-continuity` |
| 6 Idle 10 ms wake-ups | Fixed in `ad31938`: event waits without polling (INFINITE while idle). No automated test: wake-up counts are not observable without instrumentation. The v0 server is unchanged |
| 7 Transient pre-authority failures | Fixed in `7c6c90a`: 250 ms-4 s backoff within 60 s, then `source-unavailable`; `authority-rejected` only for an invalid receipt or protocol use. Tests in `97b2de4` |
| 8 Tests/docs gaps | Restart non-renewal and `CaptureController` tests in `97b2de4` (glue moved in `9a02f4f`); CI chain step in `e118c79`; docs describe crash-without-manifest refusal and payload storage |
| 9 Embedded paths | Fixed in `6d7d5ce`: embedded drive/UNC/extended paths and user folder fragments redacted. Tests in `97b2de4` |
| 10 `-0` | Fixed in `7c6c90a` (verbatim payload text in the writer) and `6d7d5ce` (export serializer). Decoder, writer and export tests in `97b2de4` |
| ASan timing | Wall-clock bounds widen 4x under AddressSanitizer only, in `fc87df8` |
| A Shutdown grace per write, not per stop (re-review) | Fixed in `919d525`: one 550 ms stop budget from the first observed stop. In-flight and split-envelope writes and the drain share the window up to 450 ms; loss and end markers finish by 550 ms. Test `stop-slow-reader` in `18cd1e1` (RED against `6be7c49`); the bound is documented in `cap0.md`. This supersedes the per-write 250 ms grace of finding 3 |
| B Transient window never reset (re-review) | Fixed in `2d97d74`: waiting/clean discovery rounds and receipts restart the window. Test: transient, progress, then a transient 70 s later completes |
| C Fixed counter attempt floor (re-review) | Fixed in `18cd1e1`: at least 1 s and 1,000 overlapping samples, bounded by 20 s; still requires consistent samples, drops and enqueues. Still RED against `eb98e66` |
| D Seqlock reader spin (re-review) | Fixed in `b211934`: `SwitchToThread()` after 64 spins |
| E Export rule wording (re-review) | Fixed in `3d0d67d` (`export.json` rules); `cap0.md` updated in the documentation commit |
| G Drain writes could consume the marker reserve (third review) | Fixed in `da061b6`: drain writes use the 450 ms drain deadline, and a cut before any byte of an envelope's first packet rewinds the sequence, counts that envelope as unsent and still sends markers. `86bab17` starts another drain envelope only if the previous envelope's cost fits; this fixed an ASan `stop-inflight` failure seen on `c144504`. Tests in `c144504`: `stop-drain-boundary` (marker delivered within the bound, 10/10 Release runs plus repeats) and stream validation in `stop-slow-reader`. No deterministic RED was available: the `2b94f5b` server also delivers the marker in this configuration (stopping at 500 ms), because any reader fast enough to receive markers also finishes a single 64 KiB or smaller drain packet within the old 100 ms slack |
| H Clean-cut byte counts, loss write after stop, drain-boundary timer resolution, abandoned counting (fourth review) | Fixed in `2f7a5fa`: only a never-issued first packet (deadline already passed, or `WriteFile` failed immediately) counts as a clean cut; any cancelled pending write ends without markers. After a stop the capture loop calls `finish()` instead of writing a periodic loss packet; `abandoned` counts with `++`. Test change in `a5297f9`: the `stop-drain-boundary` reader does not sleep, and the case requires the end marker unless the drain window was exhausted (the documented no-marker outcome) |
| I Hosted CI flake in ASan counters | [Windows CI run 38300381448](https://github.com/senukartur/ets2telemetry/actions/runs/38300381448) on `960dff7` (windows-2022, Visual Studio 17 2022 generator, 2 vCPU) failed `capture-cap0-asan-contract-counters` with `samples overlapped the live producer burst` after 20.28 s. Each sanitized sample also built and parsed a JSON loss packet, so too few samples completed before the producer cap. The other 28 ASan cases passed, and later CI steps did not run. Fixed in `51f6925`: decoder loss invariants are checked on every sample and the JSON round trip on every 16th and the final snapshot; the producer yields every 256 attempts; the queue is drained only after new drops, so drops and enqueues occur at any reader speed; overlap minimum is 200 under ASan and 1,000 otherwise; producer cap 15 s. RED property retained. On the next hosted run (38305278372, `41f45de`) `counters` passed in 1.12 s; it failed again on 38307680711 (finding L) |
| J Hosted CI failure in ASan stop-inflight | [Windows CI run 38305278372](https://github.com/senukartur/ets2telemetry/actions/runs/38305278372) on `41f45de` failed `capture-cap0-asan-contract-stop-inflight` (0.91 s) with `stop during an in-flight write still ends with plugin-shutdown`; `counters` passed (1.12 s). Under the clean-cut rule of `2f7a5fa`, a cancelled pending write correctly ends without a marker, but the test required one. Fixed in `52d581e` without changing the product rule. `stop-inflight` now asserts the contract: a valid contiguous stream; when a marker arrives, `plugin-shutdown` with enqueued = published + unsent and every published envelope received; otherwise nothing after the cut; and a bounded stop. New `stop-clean-markers` proves marker delivery deterministically (the whole capture fits in the pipe buffer). Hardened in the same commit: every verified stream checks end-marker accounting; `stall` uses 60 attempts; the drain-boundary no-marker allowance starts at 400 ms for tick resolution. `stop-inflight` passed on hosted runs 38309803378 (`a79203a`) and 38312261138 (`43c4f8f`) |
| K Partial ending not inspected (review of the test fixes) | Fixed in `0d52ff4` (tests only). `verify_stream` rejects loss or end marker kinds inside a trailing incomplete frame. `stream-verifier` reproduces markers hidden in a cut frame and fails without the check. `stop-stalled-partial` drains into a pending single-packet write, then stalls through the stop, and must never end with a marker; it fails when the pre-`2f7a5fa` byte-count trust is reintroduced. On this host a cancelled pending write transferred no bytes, so the reintroduced defect produced a well-formed but forbidden marker rather than a hidden one. That is why both cases are kept |
| L Hosted CI counters overlap still scheduler-dependent | [Windows CI run 38307680711](https://github.com/senukartur/ets2telemetry/actions/runs/38307680711) on `7c98f82` (same counters test as `51f6925`) failed `capture-cap0-asan-contract-counters` after 15.11 s with `samples overlapped the live producer burst`. The same test passed in 1.12 s on run 38305278372, and the other 29 ASan cases passed. Fixed in `c37d20c` (test only): the producer writes fixed bursts and waits after each burst, bounded at 10 s with a loud failure, until the reader has sampled again, so the overlap minimum holds on any core count. The reader yields while the producer waits. The RED property was re-proven. `counters` passed on hosted runs 38309803378 (`a79203a`) and 38312261138 (`43c4f8f`) |
| M Hosted CI v0 startup treated as failure under load | [Windows CI run 38309803378](https://github.com/senukartur/ets2telemetry/actions/runs/38309803378) on `a79203a` failed `snapshot-transport-asan-contract-accept-failure` with `unknown accept startup succeeds` after 1.26 s; it passes in 0.07-0.18 s. All CAP0 ASan cases and the CAP0 chain step passed; later steps were skipped. The failing assertion is the sixth: the four fixture assertions, worker start, then the first mode's startup check. Cause: `Server::await_startup()` waits at most the product's 1 s SDK-initialization budget and then returns `timeout`; the extra roughly 1.08 s matches that wait. The injected accept errors cannot change the startup result, because the hooks run only after the worker has stored `none`. The fixture directory and discovery names are unique, and the CAP0 server does not use these hooks. Unchanged `main` `224505f` fails the same assertion under CPU contention, so this is pre-existing test timing, not a CAP-01 behavior change (the startup path in `pipe-server.cpp` and `pipe-discovery.cpp` is unchanged). Fixed in `97b0e67` (tests only, product and its 1 s budget unchanged): `settled_startup()` waits for the worker's actual startup result for up to 10 s. It is used by the startup checks, by `Fixture::start()` before its listening wait, and by the CAP0 `v0-isolation` case. The same commit fixes the CAP0 test `io()` helper, which dropped bytes from an operation completing between its deadline and `CancelIoEx`. One stress run showed a resulting `Invalid protocol v0 message` in `v0-isolation`. Hosted run 38312261138 on `43c4f8f` passed all steps |
| F Header stamp after gate (re-review) | Fixed in `919d525`: both header timestamps are taken before `queue_.open()`; the `clock` case still passes |

## Criteria and evidence

| Approved element | Evidence (controlled, synthetic) | Remaining |
| --- | --- | --- |
| Separate versioned contract, v0 unchanged | v0 sources, fixtures and the 21 pre-existing CTest and 494 Vitest cases are unchanged and pass. `adapter` compares an evidence-enabled adapter with a reference adapter: identical boundary order, configuration revision, continuity counters, game time and v0 diagnostic batch. Vitest and C++ assert that v0 decoders reject all CAP0 packets and the CAP0 hello, and that CAP0 rejects v0 fixtures; the v0 server rejects a CAP0 hello | Hosted CI on the final head |
| Copy in callbacks, no extra SDK calls | `adapter`: configuration/gameplay/lifecycle/timer-restart/game-time-regression envelopes; strings copied before source memory mutation; exact u64 `UINT64_MAX`, s64 `INT64_MIN`, indexed fvector, dplacement, non-finite/invalid UTF-8/oversized values and names explicit; unterminated 256-entry scan marked; null attributes explicit. All fake SDK API entries ran on the SDK thread (`wrong_thread == 0`) in every case, including with both workers active | Real SDK callback payloads |
| Background serialization only, callbacks never blocked | `stall`: 200 configuration callbacks of 268,530-byte envelopes while the capture client stopped reading took 47 ms in total, worst single callback 0.49 ms; the queue stayed within bounds while the worker was blocked in pipe I/O | Real frame-time impact |
| 128 envelopes / 2 MiB, newest-drop, loss counters | `queue`: 129th envelope dropped with slot counter; byte cap admitted exactly 7 large envelopes; 400 wrap-around cycles kept FIFO identity and contents (1 counted wrap drop); closed gate copies nothing. `stall`: 192 of 200 dropped; every gap equals `droppedBefore`; every loss packet satisfies the decoder rules. `counters`: hundreds of thousands of samples taken during a live 3,000,000-attempt drop burst are all internally consistent (the `eb98e66` implementation fails this) | Real event rates |
| 64 KiB packets, omissions counted | `wire`: a 255 x 1,024-byte control-character envelope split into 26 packets at 64 KiB (255 at an 8 KiB test limit), all within the limit, contiguous ranges, every attribute exactly once; an unrepresentable limit fails explicitly | None identified |
| Header identity, exact 64-bit values, clock domains | `server`: header binds game/process/session/plugin identities, source clock id and producer image SHA-256; publication follows callback time in the source clock; Vitest checks decimal-string preservation through decoder, writer file and export | Real version/unit/currency observations |
| Separate keyed endpoint, local-user security, broker authority, opt-in | `server`: CAP0 name derived from process instance and plugin session; protected DACL verified; second client busy. `rejection`: v0 hello, wrong version, 4,097-byte prefix, trailing byte, malformed hello, missing hello (measured five-second deadline) and unapproved image digest all close without opening the gate. Client test: broker capture receipt carries `evidence:"cap0"`, connects only to the CAP0 endpoint, rejects a v0 hello and invalid mode arguments | Second-user, remote and elevation matrix not executed |
| No offline spool; disconnect, end and shutdown markers | `server`: nothing copied before opt-in or between captures; a new client restarts at `envelopeSeq` 1; shutdown drains and sends `plugin-shutdown` (0 unsent) within bounded time. `dll`: official init/shutdown/FreeLibrary with a connected capture client delivered the end marker | Pathological OS I/O noncompletion remains as in ET-004a |
| Capture never blocks v0 | `v0-isolation`: 32 v0 snapshots were received while the capture client was stalled, and the stalled capture was retired independently by its write deadline. `v0-continuity`: v0 continuity counters and boundary order are identical to a reference adapter while a capture worker polls. `stop-inflight`: a stop during a pending frame write still ends with `plugin-shutdown`. `stop-slow-reader`: a slow reader receiving a split envelope cannot extend the stop beyond the single budget (about 454 ms measured). `clock`: no header or further packets without a source clock | Real game load |
| Application writer bounds and evidence on close | `capture-session.test.ts`: credit held back during a writer stall and resumed after flushing, so plugin drops replace the pending cap; a persistent stall ends as `disconnect` with `withheldAtClose`. `capture-writer.test.ts`: pending cap with a slow write, file cap, controlled-timer deadline, write failure (manifest still written), disconnect inside a split envelope, protocol error, approved-limit enforcement and no directory reuse; manifest hashes match file bytes; output only under `captures\<session>` | None for synthetic inputs |
| Fixed non-renderer client, default-off activation | `capture-broker-client.test.ts`: fixed broker arguments with `--capture cap0`, v0 receipt rejected, one packet per credit, waiting/exit mapping; activation off by default, interval 1-60, label pattern, grant validation. `main-boundaries.test.ts`: grant attached once to the first verified ETS2 selection, not renewed for later selections; invalid activation rejected and logged | Exercised only through `npm run dev` in the owner's ETS2 sessions; packaged path not run |
| Real pipe integration with a fake SDK source | `capture-session.test.ts` over actual named pipes (complete, mid-envelope disconnect, malformed frame, absent source until deadline, service stop). `test:cap0-chain`: fake-SDK host and test DLL through the native broker to a complete `synthetic` manifest with 5 packets/3 envelopes and exact values | Windowed mode for ATS single-player and for both games under TruckersMP; installed/packaged activation path (owner dev-mode sessions so far: see the October 13 addendum) |
| Export/sanitize | `capture-export.test.ts` and the chain's CLI run: raw integrity verified; UUIDs, process/session IDs, creation times, user tag, display id and paths replaced by stable first-appearance tokens; values and order kept; tampered input and existing output refused | Reviewer judgement on game-provided strings |

## PR #26 advisory review threads

| Thread | Resolution |
| --- | --- |
| Stale "no game / no CI" statements | Corrected in this document and `docs/setup.md`. They now record the owner's ETS2 single-player sessions, the hosted run history and the follow-up hosted result for findings I, J, L and M |
| Pending list still named Convoy | The matrix below follows the owner's October 12, 2026 Convoy deferral; SP-01 status updated |
| Credit returned before bytes reach disk; a stall ends the capture as `pending-cap` | Fixed in `12043ee`: the broker credit is held back while pending storage lacks room for one more maximum-size line and is granted after writes complete. A burst stays in the plugin's newest-drop queue with exact loss counters. A stall that persists after the backlog fills still ends the capture as `disconnect` once the plugin's 1 s write deadline runs out. The manifest records `flowControl`. `capture-session.test.ts` uses a credit-honouring broker over a modelled newest-drop queue; both new cases fail with `pending-cap` when the credit is returned immediately. After the change: `npm run typecheck`, `npm run lint`, `npm test` (30 files, 546 tests), `npm run build` and `npm run test:cap0-chain` passed. No native code changed, so the native suites were not rerun |

## Pending (not done by this package)

- CAP-01 real-game evidence across the owner's validation matrix: ETS2 and ATS, each in single-player and TruckersMP, in windowed and borderless modes. Owner sessions now cover ETS2 and ATS, single-player and TruckersMP, borderless, plus ETS2 single-player windowed (see the October 13 addendum below). Still pending: windowed mode for ATS single-player and for both games under TruckersMP. The built-in Convoy mode is deferred by the owner's October 12, 2026 decision: it is neither validated nor claimed as supported. Still needed (accept, deliver, cancel, configuration clear, pause, late attach at session start and sleep are now observed; save load, application reconnect, a ferry and a cargo-market job were added on October 14, see that addendum): menu-only states, a train, refuel observations and profile change; runtime unit and currency observation (currency is only SDK-documented); loss annotations from real sessions (no loss has occurred yet). Unobserved events remain synthetic or unverified.
- Installed/packaged behaviour of the activation path, which has run only through `npm run dev`, and the measured game frame-time impact of the capture copy.
- Second-user, remote-client and elevation rejection on actual hosts; a passing Ready-for-review run on the final head; independent review.
- SP-01: PR #8 was closed unmerged. SP-01 acceptance is the owner's later decision. Every other previously pending gate is unchanged.

## Owner sessions and independent observation review (October 13, 2026 addendum)

These are owner real-game sessions captured with CAP0 (`npm run dev`, `ETS2TELEMETRY_CAPTURE=cap0`). Sanitized exports are kept locally and are not committed (the owner deferred committing fixtures). Game mode and display mode are operator labels; the SDK does not report them.

| Run | Game / mode / display | Plugin build (DLL SHA-256 prefix) | Result |
| --- | --- | --- | --- |
| 1 | ETS2 single-player, borderless | PR #26 head `960dff7` (`39B9CD36`) | 33 packets; no manifest because the coordinator hard-stopped the app |
| 2 | ETS2 single-player, borderless, late attach | `960dff7` (`39B9CD36`) | complete, 69/69 envelopes |
| 3 | ETS2 single-player, windowed | `960dff7` product code (`39B9CD36`) | complete, 58/58 |
| 4 | ATS single-player, borderless | main `a7724de` (`B03A6C79`) | complete, 71/71 |
| 5 | ETS2 via TruckersMP, borderless | `a7724de` (`B03A6C79`) | complete, 61/61 |
| 6 | ETS2 then ATS via TruckersMP | `a7724de` (`B03A6C79`) | the one-shot grant bound to a short ETS2 session selected first; the ATS trip was not captured (v0 live worked) |
| 7 | ATS via TruckersMP, borderless | `a7724de` (`B03A6C79`) | complete, 56/56 |

The capture manifests report `sourceCommit: null`; the build mapping above comes from the coordinator ledger. A read-only module listing of the ATS TruckersMP game process showed the TruckersMP client module `core_atsmp.dll` loaded before all SDK plugins; the ETS2 module name is unverified.

An independent read-only reviewer checked the sanitized exports of runs 2, 3, 4, 5 and 7:

- Completeness, identities, values and orderings were verified.
- Currency is SDK-documented (header comment), not observed at runtime. The versions are SDK game-telemetry versions 1.20 (ETS2) and 1.07 (ATS), not game patch versions.
- Revenue differences cannot be attributed to fines. In run 5, revenue equalled income despite fines. In run 4, the shortfall is consistent with cargo damage. In run 2, zero revenue is consistent with a delivery 471 game minutes late.
- The run 2 sleep appears only as an unannounced game-time jump.
- The sanitized exports retain game strings, including a player-customized licence plate; the owner decided this is acceptable. Hardware geometry and binary hashes form a mild fingerprint.

Proposed ordering expectations (owner sessions, small samples; `sharedBoundaryOrder` shows only the adapter's observation order, not the game's causal order):

| # | Expectation | Samples | Confidence |
| --- | --- | --- | --- |
| O1 | At game start: a contiguous configuration burst (job empty, bus/car jobs, controls, hshifter, truck, trailers), then `timers.restart`, then `simulation.started` | 4 runs, both games, single-player and TruckersMP | High for these builds |
| O2 | A job configuration set arrives while paused, in a burst that re-sends truck and trailers; `simulation.started` follows | 5 jobs | High |
| O3 | Job configuration does not change between set and clear | 5 jobs (quick and freight market only) | Medium |
| O4 | Event `delivery.time` equals game time at delivery minus game time at configuration set | 4 deliveries | Medium-high |
| O5 | `simulation.paused` precedes `job.delivered`; delivery arrives while paused | 4 deliveries | Medium-high |
| O6 | `job.delivered` precedes the configuration clear | 4 deliveries | Medium-high; the reverse is not excluded |
| O7 | On cancellation, the configuration clear precedes `job.cancelled` | 1 | Low |
| O8 | Fines and tolls arrive only while running, inside and outside job windows | 23 fines, 3 tolls | Medium |
| O9 | Game time did not regress; its clock rotated only at `timers.restart`; a large forward jump (sleep) carried no event | 5 runs, 1 jump | Medium / low |

Still missing for CAP-01 acceptance (in addition to the Pending section above):

- **Display matrix:** windowed mode for ATS single-player and for both games under TruckersMP.
- **Events:** ferry and train.
- **Scenarios:** save/load and profile change, reconnect, late attach after a job started, a second job in one session, cargo-market and special jobs, owned trailers, and TruckersMP disconnect.
- **Performance:** frame-time impact.

Bus and car jobs are deferred (TD-002).

## Owner session, ETS2 single-player windowed (October 14, 2026 addendum)

**Setup**
- One ETS2 1.61.1.1s single-player session in a windowed game window (2311 × 1000 physical), on the same machine and settings as the earlier sessions.
- Application and plugin from `main` `aa67956` (DLL `B03A6C79`, unchanged since `a7724de`), started with `npm run dev`.
- The session produced two CAP0 captures. Sanitized exports are kept locally, as before.

| Run | Game / mode / display | Plugin build (DLL SHA-256 prefix) | Result |
| --- | --- | --- | --- |
| 8 | ETS2 single-player, windowed, cargo-market job, ferry | `aa67956` (`B03A6C79`) | complete, 29/29 envelopes, no loss; the source ended with the plugin end marker (`plugin-shutdown`) |
| 9 | ETS2 single-player, windowed, application relaunched while the game ran (attached mid-job), save load, cancellation | `aa67956` (`B03A6C79`) | complete, 54/54, no loss; ended with the plugin end marker at game exit |

### Observations

These are coordinator observations from the raw captures and logs. They have not been independently reviewed yet.

**Cargo-market job (run 8).**
- The job configuration (19 attributes, `job.market` `cargo_market`) arrived while paused, with `cargo.loaded` false.
- At pickup, about 50 s later, it arrived again while paused, together with truck and trailer configuration. The only changed attribute was `cargo.loaded`, now true.
- This is the first observation of `cargo.loaded` false, and it refines O3.

**Ferry (run 8).**
- `player.use.ferry` arrived while paused, between a `simulation.paused` and a `simulation.started`. It carried `pay.amount` 677 and the source and target port names and ids, with names in the game's UI language.
- Game time advanced faster than driving across the crossing. Without periodic samples, the capture cannot locate the jump.

**Game process end (run 8).**
- At 15:40:41 UTC the plugin sent its end marker after SDK shutdown, with no loss and no unsent envelopes.
- Within the same second, Windows Error Reporting recorded an access violation in `eurotrucks2.exe` in `MSVCR120.dll`, followed 8 s later by a second fault in ASUS `AacAmbientHal_x64.dll`.
- The project plugin links its C runtime statically and imports no `MSVCR120.dll`. In the game's plugin folder, only a third-party plugin from 2019 imports it. The cause is not established. The owner may have closed a third-party telemetry companion application at that time.
- The owner restarted the game about 20 s later. The still-running application's v0 live connection attached to the new game process without intervention, and the overlay followed the new window.
- The one-shot capture grant had been consumed by the first process, so the new process was not captured until the application was relaunched (run 9).

**Application relaunch while the game ran (run 9).**
- The owner closed the dashboard window. The application stopped cleanly: `APP_STOP_REQUESTED`, `SERVICE_EXIT`, `APP_EXIT`.
- After a relaunch, the owner selected ETS2 again, and the overlay showed live data.
- The capture attached while a job was active. CAP0 copies only callbacks after its broker authenticates, so the capture held no job configuration until the game sent configuration again. v0 live is unaffected, because its checkpoint carries current configuration ([v0](../protocol/v0.md)).

**Save load within one game process (run 9)**, in adapter observation order:
- `simulation.paused`;
- the job, controls, truck and trailer configurations cleared (0 attributes);
- about 3 s later, configuration set again: job (19 attributes, same cargo-market job), `bus_job` empty, controls, `hshifter`, truck and trailers;
- `simulation.started`;
- immediately afterwards, `game.time.regression`: game time went back from 251808 to 251789 game minutes, the saved time, and the game-time `clockId` rotated.
- The plugin stayed loaded and the v0 session continued; there was no `timers.restart`.

**Cancellation (run 9).**
- `simulation.paused`, then the job configuration cleared together with a truck and trailer re-send, then `job.cancelled` with `cancel.penalty` 12000.
- This is the second sample for O7.

**Fine.** One `player.fined` (`crash`, 400) arrived while running, consistent with O8.

### Expectation updates

| # | Change | Samples now |
| --- | --- | --- |
| O3 | Refined: a cargo-market job re-sends its configuration at pickup, changing only `cargo.loaded` from false to true. Quick and freight-market jobs did not change between set and clear | 6 jobs |
| O7 | Unchanged expectation, second sample (run 9) | 2 |
| O9 | Refined: game time regresses on save load. The adapter reports `game.time.regression` and rotates the game-time clock right after `simulation.started`, without `timers.restart` | 7 runs, 1 regression, 1 jump |
| O10 (new) | Save load clears job, controls, truck and trailer configuration while paused, re-sends the full configuration set, then `simulation.started` and `game.time.regression` follow | 1 |
| O11 (new) | `player.use.ferry` arrives while paused, between a pause and the next start | 1 |

### Still missing for CAP-01 acceptance

This replaces the earlier list.
- **Display matrix:** windowed mode for ATS single-player and for both games under TruckersMP.
- **Events:** a train crossing, refuel (no SDK event exists in 1.15; already recorded as absent), weigh station.
- **Scenarios:**
  - profile change;
  - a second job in one session;
  - special jobs;
  - owned trailers;
  - TruckersMP disconnect;
  - menu-only states.
- **Performance:** the [ET-009 frame-time record](et-009-frame-time-2026-10-13.md) found no FPS change from the application, the overlay and CAP0 capture in one scene. The plugin's own cost is not measured.
- **Review:** independent review of runs 8 and 9.
