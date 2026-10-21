# ET-004 v0 stop and discovery record validation record

Regression reconciliation, October 22, 2026: [ET-011](et-011.md#local-contract-correction-and-closeout-authorization--october-22-2026)
holds protected publication beyond the 1,000 ms measured target after stop's first cancellation and requires mandatory
join, cleanup and the unchanged `shutdown_deadline_exceeded` diagnostic. The pending-startup stop assertion now checks
status against internal duration instead of imposing an undocumented universal sub-second stop. No product cancellation
window, ownership or threshold changes; earlier 1,078 ms observations remain target misses, not performance fixes.

Recorded October 15, 2026. This is a transport lifecycle bug fix in the v0 pipe server, not a wire change. Pipe names, discovery records and their bytes, the v0 protocol, the CAP0 contract and the [October 13, 2026 startup budget](et-004-startup-budget.md) (1 s SDK-initialization wait, pending rather than failed, one deferred log) are unchanged. No game was launched and no DLL was installed into a game directory. The fix was developed on top of ET-004b PR C (`c284a6b`), whose `1d73b29` fixed the same defect for the v1 endpoint, and was cherry-picked onto `main` after PR C merged as `ceba919` (#54).

## Problem

`transport::Server::stop()` set the stop event, called `CancelSynchronousIo` on the worker, and repeated the call every 10 ms until the worker exited. The point was to interrupt long synchronous peer-image and policy reads. After the stop event the v0 worker leaves its accept loop and runs `~Discovery`, which deletes the discovery record with `SetFileInformationByHandle(FileDispositionInfo)`. A cancellation request that lands during that call makes it fail with `STATUS_CANCELLED` (`ERROR_OPERATION_ABORTED`), and the record stays behind. Two more paths had the same exposure:

- A stop during startup could cancel discovery publication itself (`verify_owner_only`, `CreateFileW`, `WriteFile`, `FlushFileBuffers`, the rename). The [startup-budget record](et-004-startup-budget.md#hosted-flake-stop-during-the-hold-october-15-2026) measured that case.
- When publication fails, the constructor's catch path deletes its `.tmp` file the same way, so a cancelled deletion leaves the temporary file behind.

A leftover record names a pipe that no longer exists. Discovery records are not authority and clients reject stale records ([the v0 native boundary](../native-transport-boundary-v0.md)), so this is stale state in the protected discovery directory, not an authority leak.

## Fix

The v1 inspection window from `1d73b29` moved into a shared header-only helper, `transport::CancelWindow` (`native/telemetry-plugin/src/cancel-window.hpp`). The worker holds a `CancelWindow::Scope` open around reads whose cancellation it handles. `stop()` calls `CancelWindow::cancel()`, which issues `CancelSynchronousIo` only under the window's mutex and only while a window is open. The mutex orders every request with the window's open and close, so no request reaches synchronous I/O issued after the window has closed. `stop()` still repeats the request every 10 ms and still joins the worker.

| Server | Window open | Never cancelled |
| --- | --- | --- |
| v0 | Startup checks before endpoint creation (current user, directory security, source identity); peer and policy inspection in `serve()` | Endpoint creation, discovery publication including its catch path, the accept loop, the exit path and `~Discovery` |
| v1 | Peer and policy inspection in `serve()`, as in `1d73b29` | Everything else, as in `1d73b29` |

The v0 startup window keeps the existing startup-budget behaviour: a stop can still abort a slow startup check (the `startup-late` real-read variant requires that). A stop that arrives after the checks lets publication finish; the exit path then deletes the record, and that startup is reported once as a success under the startup-budget rules. v1 behaviour is unchanged: only its private `InspectionWindow` and `cancel_inspection()` were replaced by the shared type with the same mutex, flag and checks.

CAP0 (`capture-server.cpp`) uses the same repeated cancellation but publishes no discovery record. Its synchronous I/O is the startup directory check, peer and policy inspection, and the plugin image read when a capture opens; its exit path creates or deletes no file and only closes the queue and handles. A cancellation there can only end the worker's startup or the connection being opened, after the stop request, and leaves nothing on disk. CAP0 is unchanged.

## Reproduction and RED

Local machine: Windows 11 Home 10.0.26200 x64, 24 logical processors, Visual Studio 18 Community, MSVC 14.51.36231, CMake 4.3.1-msvc1.

Natural reproduction on the unfixed code (`c284a6b`, the ET-004b PR C head before its squash merge as `ceba919`; Release `snapshot-transport-test`):

| Run | Result |
| --- | --- |
| `collision` (stops a listening worker and requires the record to be deleted), 300 runs one at a time | **1 failure**: "owned discovery retired" |
| `collision`, 400 runs, 8 in parallel | 0 failures |

The deterministic case `stop-discovery` adds two console-only hook points to `pipe-server.cpp`: `v0-exit` in the exit path, before the record is deleted, and `startup-before-discovery`, after endpoint creation and just before publication. Each block runs a blocking synchronous read on an owned anonymous pipe at one point. Only a cancellation or a 750 ms fallback write ends it, so the outcome does not depend on scheduling: on the fixed code nothing can cancel the read and the fallback always ends it.

| Check | Result |
| --- | --- |
| `stop-discovery` on the unfixed `stop()` (`0d6cf6a`, cherry-picked to `main` as `f14b797`), exit-path block | Failed: `exitReadError=995 fallback=0`, "stop never cancels synchronous I/O in the v0 exit path" |
| Same, exit-path block skipped (temporary local edit) | Failed: `publishReadError=995 fallback=0`, "stop never cancels synchronous I/O during discovery publication" |
| Same, first two blocks skipped | Failed: `collisionReadError=995 fallback=0`, "stop never cancels synchronous I/O before a failing publication" |
| Fixed code, startup window left open for the whole run | `stop-discovery` failed in the exit-path block (995) |
| Fixed code, no window in `serve()` | `hash-cancel-race` failed: "stop cancels real read scheduled after first cancellation" (`lateReadError=0 fallback=1`) |
| Fixed code, no startup window | `startup-late` failed: "stop joins a pending startup promptly" (the startup read was not cancelled; stop took 2,015 ms) |
| `CancelWindow::cancel()` ignoring the window | `stop-discovery` and `v1-transport-test shutdown` both failed in their exit-path blocks (995) |

## Stress results on the fixed code

Repeat runs of the fixed code (`946d6ea`, cherry-picked to `main` as `0001557` with identical content). "4 parallel" means four loops at once on the 24-CPU host. "Loaded" means the test and three busy loops pinned to two CPUs, as in the [ET-004b fix round 2](et-004b.md#fix-round-2-october-15-2026) runs.

| Case | Build | Runs | Mode | Failures |
| --- | --- | --- | --- | --- |
| `stop-discovery` | Release | 200 | 4 parallel | 0 |
| `stop-discovery` | Release | 50 | Loaded | 0 |
| `collision` | Release | 300 | One at a time | 0 (unfixed: 1) |
| `collision` | Release | 200 | Loaded | 0 (unfixed: 0) |
| `startup-late` | Release | 200 | 4 parallel | 0 |
| `hash-cancel-race` | Release | 200 | 4 parallel | 0 |
| `accept-failure` | Release | 200 | 4 parallel | 0 |
| `dll` (official init/shutdown of the test DLL) | Release | 200 | 4 parallel | 0 |
| `dll-late` (hooked test DLL, late reporting) | Release | 200 | 4 parallel | 0 |
| `v1-transport-test shutdown` | Release | 200 | 4 parallel | 0 |
| `stop-discovery`, `collision`, `startup-late`, `hash-cancel-race`, `accept-failure`, `dll-late`, `v1-transport shutdown` | ASan | 20 each | One at a time | 0 |
| `stop-discovery` | ASan | 20 | Loaded | 0 |

The ASan `dll-late` loop loaded the hooked test DLL from the Release build tree. Under load one `stop-discovery` stop took 1,078 ms, including the 750 ms fallback. The case does not assert the 1,000 ms shutdown target: the fallback is part of its own duration.

After these runs the temporary test directories held no record from the fixed code. Eight older `%TEMP%\ET004a-*` directories from earlier local runs (October 11-15) still hold one leftover v0 record each, which is consistent with this defect, but their runs are not identified. The directory left by the unfixed `collision` failure above was removed.

## Commands and results

Node 24.19.0 and npm 11.17.0 (portable pinned copy).

| Command | Result |
| --- | --- |
| `npm run native:configure`, `npm run native:build` | Clean with `/W4 /WX` |
| `npm run native:test` | 75/75 passed, including `snapshot-transport-contract-stop-discovery` |
| ASan configure (`-DETS2TELEMETRY_ASAN_TESTS=ON`), build of the Windows CI ASan target list, `ctest -R asan-contract` | Clean build; 69/69 passed, including `snapshot-transport-asan-contract-stop-discovery` |
| `npm ci`, `npm run build`, `npm run test:cap0-chain` | Passed; chain 1/1 |
| `git diff --check` | Clean |

The local ASan build used the Visual Studio 18 generator; Windows CI uses Visual Studio 17 2022.

## Post-review and CI fix (October 15, 2026)

**Hosted failure.** The Ready run [38719984311](https://github.com/senukartur/ets2telemetry/actions/runs/38719984311) on `42fdfe6` failed `v1-transport-asan-contract-policy` with "only the authorized client hydrated". All other 68 ASan cases passed.

**Root cause: a race in the test, already on `main`.** The v1 worker increments `hydrations()` and then stores `connected`, both after the checkpoint write has completed. The client can read the checkpoint and return from `handshake()` before the worker runs that increment, so reading the count right away could see 0. The policy case does not call `stop()` before that read, so no cancellation happens there. The `CancelWindow` refactor does not change v1: the window wraps the same two calls, and `stop()` still takes the same mutex and checks the same flag. The worker handle is now read before the lock, but only the SDK thread that calls `start()` and `stop()` changes it. One CPU, two busy loops:

| Build | `main` `ceba919` | This branch before the fix | After `21175ce` |
| --- | --- | --- | --- |
| Release `policy` | 14 of 100 failed | 10 of 100 failed | 0 of 200 failed |
| ASan `policy` | 11 of 50 failed | 17 of 50 failed | `ctest --repeat until-fail:200` passed |

All failures had the hosted message. As a RED check, a temporary 200 ms sleep before the increment made the old `policy` case fail 3 of 3, and the fixed case passed 3 of 3.

**Fix (`21175ce`, test only).** The new `Fixture::hydrated()` waits for `connected` and then reads the count. Seeing `connected` guarantees that the count includes this connection and every earlier one. The `policy` check and the same pattern at the end of `ack-control` use it. No timeout or expected count changed.

**Exit-path fallback (`6c08b94`).** An advisory review noted that the exit-path block started its 750 ms fallback timer before `stop()`. On a slow host the fallback byte could already be in the pipe when the worker reached `v0-exit`. The read would then complete at once, and an unfixed `stop()` would have nothing to cancel. The guard thread now starts the timer only after the hook's `reached` event, as the publication blocks do. Against the unfixed `stop()`, the block failed 3 of 3 runs without load and 20 of 20 on one CPU with two busy loops.

**Checks on `6c08b94`:**

- `native:build` was clean.
- The first `native:test` had 73 of 75 passing. `event-channel-contract-concurrency` and `capture-cap0-contract-counters` hit their 60 s timeouts while other agents loaded the host. Both cases are unchanged by this branch, and the cause is unknown. A rerun of the suite passed 75 of 75, and 100 repeats of the two cases passed.
- ASan `-R asan-contract` passed 69 of 69.
- `ctest --repeat until-fail` under contention: ASan `policy` passed 200, `stop-discovery` passed 200 in Release and 20 in ASan, and ASan `ack-control` passed 20.
- Two other cases failed once each in these loops, at assertions this branch did not change:
  - Release `policy` failed "v1 listening": `Fixture::start` has a 3 s bound, with one CPU and two busy loops.
  - Release `ack-control` failed "release point stays before the gap record" (block g), with CPUs 0–1 and three busy loops.
- Neither failure recurred on retest. With CPUs 0–1 and three busy loops, `ack-control` passed 100 of 100 on `main` and 100 of 100 on this branch. They are recorded here as possible flakes outside this change.

## Remaining

- Endpoint creation and discovery publication are no longer cancellable. They are short local file operations, but a stop that arrives during them now waits for them; a pathological file system filter could extend shutdown, as any non-cancellable call already could. The mandatory join is unchanged.
- The `stop-after-cancel` hold in the `startup-late` stop-during-hold variants is no longer needed to keep cancellation away from publication; it is kept unchanged.
- Hosted Windows CI, independent review and owner acceptance of this change are pending. No game, TruckersMP or performance claim follows from these synthetic tests.
