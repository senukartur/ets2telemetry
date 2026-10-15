# ET-004 v0 stop and discovery record validation record

Recorded October 15, 2026. This is a transport lifecycle bug fix in the v0 pipe server, not a wire change. Pipe names, discovery records and their bytes, the v0 protocol, the CAP0 contract and the [October 13, 2026 startup budget](et-004-startup-budget.md) (1 s SDK-initialization wait, pending rather than failed, one deferred log) are unchanged. No game was launched and no DLL was installed into a game directory. The branch is stacked on ET-004b PR C (`c284a6b`), whose `1d73b29` fixed the same defect for the v1 endpoint.

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

Natural reproduction on the unfixed code (`c284a6b`, Release `snapshot-transport-test`):

| Run | Result |
| --- | --- |
| `collision` (stops a listening worker and requires the record to be deleted), 300 runs one at a time | **1 failure**: "owned discovery retired" |
| `collision`, 400 runs, 8 in parallel | 0 failures |

The deterministic case `stop-discovery` adds two console-only hook points to `pipe-server.cpp`: `v0-exit` in the exit path, before the record is deleted, and `startup-before-discovery`, after endpoint creation and just before publication. Each block runs a blocking synchronous read on an owned anonymous pipe at one point. Only a cancellation or a 750 ms fallback write ends it, so the outcome does not depend on scheduling: on the fixed code nothing can cancel the read and the fallback always ends it.

| Check | Result |
| --- | --- |
| `stop-discovery` on the unfixed `stop()` (`0d6cf6a`), exit-path block | Failed: `exitReadError=995 fallback=0`, "stop never cancels synchronous I/O in the v0 exit path" |
| Same, exit-path block skipped (temporary local edit) | Failed: `publishReadError=995 fallback=0`, "stop never cancels synchronous I/O during discovery publication" |
| Same, first two blocks skipped | Failed: `collisionReadError=995 fallback=0`, "stop never cancels synchronous I/O before a failing publication" |
| Fixed code, startup window left open for the whole run | `stop-discovery` failed in the exit-path block (995) |
| Fixed code, no window in `serve()` | `hash-cancel-race` failed: "stop cancels real read scheduled after first cancellation" (`lateReadError=0 fallback=1`) |
| Fixed code, no startup window | `startup-late` failed: "stop joins a pending startup promptly" (the startup read was not cancelled; stop took 2,015 ms) |
| `CancelWindow::cancel()` ignoring the window | `stop-discovery` and `v1-transport-test shutdown` both failed in their exit-path blocks (995) |

## Stress results on the fixed code

Repeat runs of the fixed code (`946d6ea`). "4 parallel" means four loops at once on the 24-CPU host. "Loaded" means the test and three busy loops pinned to two CPUs, as in the [ET-004b fix round 2](et-004b.md#fix-round-2-october-15-2026) runs.

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

## Remaining

- Endpoint creation and discovery publication are no longer cancellable. They are short local file operations, but a stop that arrives during them now waits for them; a pathological file system filter could extend shutdown, as any non-cancellable call already could. The mandatory join is unchanged.
- The `stop-after-cancel` hold in the `startup-late` stop-during-hold variants is no longer needed to keep cancellation away from publication; it is kept unchanged.
- Hosted Windows CI, independent review and owner acceptance of this change are pending. No game, TruckersMP or performance claim follows from these synthetic tests.
