# ET-004 startup-budget validation record

Recorded October 13, 2026. This is hardening of accepted ET-004a code: v0 pipe-server startup that is slow but succeeds no longer fails the plugin load. The bug was found on October 12, 2026 while investigating the hosted CI flake for PR #26 (CAP-01); see [CAP-01a validation](cap-01a.md) finding M. The wire protocol, discovery records, CAP0 contract and application code are unchanged. No game was launched and no DLL was installed into a game directory.

## Problem

`scs_telemetry_init` runs on the game's main thread. It starts the transport worker and waits at most 1,000 ms (`Server::await_startup()`) for local security, endpoint creation and discovery publication. On `main` `4f16fab`, a timeout was treated as a startup failure. Initialization joined the worker, logged `transport startup failed: timeout` and returned `SCS_RESULT_generic_error`. The game then runs without the plugin for the whole session.

Run alone, startup takes 0-16 ms. Under CPU contention it is slow but successful: in the CAP-01a stress runs, startup took up to 3,985 ms on one core, and 169 of 576 startups exceeded 1 s. Game launch is itself a high-load moment, so a player could lose telemetry for a whole session on a busy machine.

## What the 1 s budget protects

The SDK readme requires every game call to happen on the game's thread during a direct invocation. The project rules require short SDK callbacks, and a missing or slow application must not stall the game. The wait bounds how long initialization blocks the game's main thread. Failing the load on timeout was not a requirement in itself. It came from the ET-004a review ([ET-004a validation](et-004a.md)): asynchronous startup failures were returning `ok` without any report. That review required a reported startup failure, not a fixed failure outcome for slow startups.

## Design (owner decision, October 13, 2026)

The owner chose a hybrid with a deferred game log:

- Initialization still waits at most 1,000 ms. The game is never blocked longer than before.
- A failure reported within the wait keeps the ET-004a behavior: retire, one fixed error log on the direct caller, `SCS_RESULT_generic_error`.
- On timeout, initialization logs one fixed warning, `ETS2Telemetry: transport startup pending: timeout`, and returns `SCS_RESULT_ok`. The worker keeps starting. The monitor and the CAP0 endpoint start as on success.
- Exactly one side reports each startup. A compare-exchange on a `pending`/`completed`/`detached` state decides whether the result belongs to the waiting initialization or is detached. This also covers the race where completion coincides with the end of the wait.
- A detached worker stores a pointer to one static fixed entry in the adapter (`Adapter::defer_log`); it never calls the SDK. The adapter logs that entry once on the SDK thread, from the next `frame_end` callback or from explicit SDK shutdown. The SDK readme permits game calls during callbacks the game invoked directly. The callback cost is one relaxed atomic load per frame while no entry is waiting.
- A late success logs the message `ETS2Telemetry: transport started after the startup wait`. A late failure logs the same fixed error as an early one, keeps `failed` status and publishes no endpoint. This matches the existing runtime failure after startup. No detached result is dropped. A startup that ends after SDK shutdown has requested stop is logged at shutdown: a success with the same message, and a failure with the fixed warning `ETS2Telemetry: transport startup ended by shutdown`. That warning names no stage, because the stage may be an artifact of cancellation. A game-logger exception in the deferred path counts one callback failure and no lost observation.
- Shutdown during a pending startup uses the existing stop path: stop event, repeated `CancelSynchronousIo`, join.

Update, October 15, 2026: since the [v0 stop fix](et-004-v0-stop.md), that cancellation reaches only the startup checks and peer inspection; endpoint creation, discovery publication and record deletion are no longer cancelled.

Rejected alternatives: a longer synchronous budget would block the game longer. A fully asynchronous startup would drop the synchronous ET-004a failure report for common local failures (collisions, insecure ACLs, foreign discovery records).

## Tests

| Case | What it checks |
| --- | --- |
| `snapshot-transport-contract-startup-late` and its ASan counterpart | A console hook (`startup-before-endpoint`, compiled only into the console-test core) holds the actual worker. `await_startup()` returns `timeout` after about 1,000 ms, and nothing is logged while pending. Late success: the endpoint listens, one `message` log arrives from `frame_end` on the SDK thread, nothing more after further frames or shutdown, and a real client receives `welcome` and `checkpoint`. Late failure: an actual foreign pipe created during the hold makes startup fail with `failed` status and no endpoint. The worker never logs, and explicit shutdown logs the fixed `endpoint-creation` error once; the foreign pipe is preserved. Stop during the hold joins promptly. If the worker then completes, shutdown logs one success message; if it fails as if cancelled, or an actual synchronous startup read is aborted by stop's cancellation, shutdown logs one `ended by shutdown` warning. Each variant also asserts the server status that matches its outcome (see [the stop-during-hold flake](#hosted-flake-stop-during-the-hold-october-15-2026)). A second hook (`startup-await-timeout`) makes the race deterministic: the wait expires, and the worker completes before the caller's compare-exchange. The caller then receives the actual result (`none`, or `endpoint-creation` with an actual foreign pipe) and no deferred entry follows. A prompt startup leaves no deferred entry; this is checked only when the first wait returns `none`, so a loaded host cannot make it flaky |
| `snapshot-transport-late-reporting-contract` and `snapshot-transport-asan-contract-late-reporting` | Official `scs_telemetry_init`/`scs_telemetry_shutdown` on a separate hooked test DLL (`snapshot-transport-hooked-test-plugin`, the only artifact with the `ets2telemetry_test_transport_hook` export). Held startup returns `ok` after the fixed wait with exactly one pending warning. Late success logs one message from `frame_end` and the endpoint serves the handshake. Late failure against an actual foreign pipe logs one fixed error from `frame_end` and preserves the foreign pipe. Shutdown while pending is bounded and logs one `ended by shutdown` warning. A failure that completes after the wait but before the exchange stays the caller's: init returns `generic_error` after about 1 s with one fixed error log, and shutdown adds nothing. All logging runs on the SDK caller thread |
| Existing `snapshot-transport-reporting-contract` | Unchanged scenarios; additionally asserts error severity. Prompt local failures still return `generic_error` with one fixed error log |
| `sdk-adapter-contract` and `sdk-adapter-asan-contract` (`deferred_log`) | An entry handed over from another thread is logged once, from `frame_end` only (not `frame_start`), on the SDK thread. A later entry replaces an unlogged one. Explicit shutdown logs a waiting entry. Re-initialization discards an entry from an earlier session. A throwing game logger adds exactly one callback failure, no lost observations compared with a control interval, and the entry is not retried |

The `Host::log` fake now records the severity instead of requiring `error`. The `snapshot-transport-test` `io()` helper also reports bytes from an operation that completes between its deadline and `CancelIoEx`, matching the CAP0 helper fix in `97b0e67`. Before, it returned `false` and dropped bytes it had already consumed.

RED check: with the product timeout path restored to the old failure, and without the deferred log, `startup-late` failed with `late success reaches a later frame_end callback`. `late-reporting` failed with `held startup returns ok after the fixed wait` after 1.05 s. Both pass with the change.

## Advisory review findings

The advisory Claude review on `b8a9c3c` reported three low-severity findings, all fixed:

1. A detached result was suppressed whenever the stop event was set, so a real late failure coinciding with shutdown was dropped. Now no detached result is dropped; a failure after stop is reported as `ended by shutdown`.
2. No deterministic test covered the race where completion falls between the wait and the compare-exchange. The new `startup-await-timeout` hook covers it for success and failure, at the server level and through official init.
3. A game-logger exception in the deferred flush called `failure()`, which also increments `lost_observations`. That reported a data loss that did not happen. The flush now counts only `callback_failures`.

RED checks: with the old stop suppression, `startup-late` failed with `a startup ending during stop is logged once at shutdown, without a stage reason for a failure`. `late-reporting` failed with `eventual result logged exactly once with its fixed text and severity`. With `failure()` restored in the flush, `sdk-adapter-contract` failed with `throwing game logger fabricates no lost observation`. The race cases pass against both versions: they cover existing behavior rather than reproducing a defect.

## Commands and results

Environment: Windows 11 Home 10.0.26200 x64, Visual Studio 18 Community, MSVC tools 14.51.36231, CMake 4.3.1-msvc1, Node 24.19.0, npm 11.17.0 (portable pinned copy). Base `main` `4f16fab`.

| Command | Result |
| --- | --- |
| `npm ci`, `npm run typecheck`, `npm run lint:install`, `npm run lint` | Passed; no diagnostics, zero lint errors and warnings |
| `npm test` | 30 files, 547 tests passed |
| `npm run native:configure`, `npm run native:build`, `npm run native:test` | Build clean with `/W4 /WX`; **40/40 CTest passed** (34.6 s on `b8a9c3c`; 38.6 s after the review fixes), including the two new cases |
| ASan configure (`-DETS2TELEMETRY_ASAN_TESTS=ON`), build of the CI ASan target list plus `snapshot-transport-hooked-test-plugin`, `ctest -R asan-contract` | **34/34 passed** (46.4 s on `b8a9c3c`; 50.3 s after the review fixes), including `snapshot-transport-asan-contract-startup-late` and `-late-reporting` (3.1 s each; waits 1,000-1,016 ms, pending stop 15 ms) |
| `npm run build`, `npm run test:cap0-chain` | Passed; chain 1/1 |
| `dumpbin /exports` | Production `ets2telemetry-plugin.dll` exports exactly `scs_telemetry_init` and `scs_telemetry_shutdown`. The hook export exists only in the hooked test DLL, and only that DLL contains the `startup-before-endpoint` phase string |

## Contention comparison

Each tree ran 3 batches of 32 concurrent `snapshot-transport-test dll` lifecycles (each lifecycle runs three official init/shutdown cycles of the isolated test DLL). Each batch also ran 48 concurrent `snapshot-transport-asan-test accept-failure` processes as CPU load. Everything was pinned to one core through inherited process affinity. `main` `4f16fab` was built in an ignored detached worktree. In both runs the load processes reported startups up to about 1.9 s (20 and 27 of 432 over 1 s).

| Tree | Lifecycles passed | `official DLL initialization` failures | `official DLL shutdown joins active IO under deadline` failures |
| --- | --- | --- | --- |
| `main` `4f16fab` | 79/96 | **14** | 3 |
| This change | 95/96 | **0** | 1 |

On `main`, each initialization failure is a plugin load that the game would keep failed for the session. The shutdown failures occur on both trees. That is the test's fixed 1 s shutdown bound under single-core oversubscription; this change does not touch the stop path. An earlier lighter run without CPU load (64 concurrent lifecycles, one core) passed 192/192 on this change.

## Hosted flake: stop during the hold (October 15, 2026)

Hosted Windows CI run 38643076212 (the Ready run of PR #44 at `c4d6e17`, merged with `main` `2d48c9a`; that PR changes only tests and docs) failed `snapshot-transport-contract-startup-late` once. The output was `awaitMs=1000/1016/1016`, `pendingStopMs=0`, then `a startup ending during stop is logged once at shutdown, without a stage reason for a failure`. That is the first stop-during-hold iteration, which injects `ERROR_SUCCESS` and expects one `message` log. No earlier failure of this case appears in the last 40 failed CI runs.

**Root cause: a test race, not a reporting defect.** In that iteration the `startup-before-endpoint` hook waits only for the stop event. `Server::stop()` sets the event, then calls `CancelSynchronousIo` on the worker, and repeats the call every 10 ms until the worker exits. Once released, the worker continues startup with synchronous I/O: `CreateNamedPipeW`, then the discovery record (`verify_owner_only`, `CreateFileW`, `WriteFile`, `FlushFileBuffers`, the rename). A cancellation request that lands during that I/O aborts it with `ERROR_OPERATION_ABORTED`. Startup then genuinely fails at `discovery-publication` after stop was requested. The server correctly reports this as the one `ended by shutdown` warning, not the success message the test expected. The test assumed that an injected `ERROR_SUCCESS` always produces a successful startup. That is true only if no cancellation request overlaps the remaining startup I/O.

Other interleavings checked against the code:

- **Zero logs:** not possible. `complete_startup()` runs on the worker before it exits; `stop()` joins the worker before `Adapter::shutdown()` flushes. `await_startup()` has already detached the result, so the worker's compare-exchange fails and it always calls `defer_log`.
- **Two logs:** not possible. Each worker run calls `complete_startup()` once (guarded by `startup_complete`), the adapter holds one atomic slot, and the flush clears it with `exchange`.
- **Wrong thread:** not possible. The worker only stores a pointer; the flush runs in `Adapter::shutdown()` on the test (SDK) thread.
- **`hooks.synchronized` false:** only if a hook wait times out after 10 s. `pendingStopMs=0` rules that out.
- **Wrong type or text:** the observed case. Stop always precedes completion here, so a failure maps to the `ended by shutdown` warning and a success to the message. No stage-specific error is possible.

Production behavior matches the documented design. A startup that ends after stop was requested is reported once, at shutdown, and a cancelled one carries no stage reason. Nothing is dropped or duplicated, and nothing is logged off the SDK thread. No product change was made.

**Reproduction.** Local machine: Windows 11 Home 10.0.26200 x64, 24 logical processors, MSVC 14.51.36231, Release and ASan builds of `snapshot-transport-test`.

| Run | Result |
| --- | --- |
| Unchanged `startup-late`, 200 runs, 8 in parallel | 0 failures |
| Unchanged `startup-late`, 400 runs, 24 in parallel | 0 failures; the full test did not reproduce the CI failure locally |
| Temporary probe (not committed): the unchanged hook releases on stop, then `stop()` runs at once (no 1 s wait); counts final status; 300 runs alone | 300 `stopped`, 0 `failed` |
| Same probe, 16 processes × 200 runs in parallel | 3,069 `stopped`, 35 `failed`, 96 `shutdown_deadline_exceeded` (stop above 1 s under this load; that status hides whether startup failed) |
| Same probe with temporary catch instrumentation in `Server::run`, 16 × 200 | 3,062 `stopped`, 25 `failed`, 113 `shutdown_deadline_exceeded`. The worker logged 40 startup failures after stop (15 of them inside slow stops), **all** at `discovery-publication` with `discovery-policy` and last error 995 (`ERROR_OPERATION_ABORTED`) |

The probe shows the mechanism at about 1.1-1.3% of released startups under 16-way contention. It confirms that the cancelled operation is the discovery record publication. The full test reaches that window rarely: only one iteration per run is exposed, and its 1 s wait spaces the startups out. The unchanged test passed all 600 local runs, so the CI failure itself was not reproduced; the probe and the matching hosted symptom (`pendingStopMs=0`, a failure in the success iteration only) establish the cause.

**Fix (test only).** In the stop-during-hold iterations the hook now resumes the worker only after `stop()`'s first `CancelSynchronousIo` has returned (`stop-after-cancel` phase). For the injected variants, that phase also holds `stop()`'s repeat loop until the worker has exited. `CancelSynchronousIo` affects only operations already pending, so no cancellation request can reach the remaining startup I/O, and each run reaches the outcome it asserts. A third variant keeps the CI interleaving deterministic. The released worker performs an actual synchronous read on an owned anonymous pipe. `stop()`'s repeated cancellation aborts it with `ERROR_OPERATION_ABORTED`, startup fails, and shutdown logs exactly one `ended by shutdown` warning. A bounded 2 s fallback write fails the case instead of hanging it if cancellation never arrives. All three variants keep the original assertions: prompt join, no endpoint, no worker log, one log of the expected severity and text, and synchronized hooks. They now also assert SDK-thread logging and the matching server status (`stopped` for success, `failed` otherwise). The official-init `dll-late` shutdown-while-pending scenario uses the same hook, so it gets the same ordering. It already injected `ERROR_OPERATION_ABORTED`, so its expected outcome did not depend on this race.

| Run (fixed test) | Result |
| --- | --- |
| Full plugin CTest subset `-R "snapshot-transport\|sdk-adapter"` (Release and ASan) | 35/35 passed |
| `startup-late`, 400 runs, 24 in parallel | 0 failures; every run reached its forced outcome (400 × success message, 400 × warning after injected abort, 400 × warning after an actual read aborted with error 995) |
| ASan `startup-late`, 200 runs, 24 in parallel | 0 failures; the same three outcomes in all 200 runs |

## Remaining limits

- The init wait still blocks the game's main thread for up to 1,000 ms when startup is slow. That bound is unchanged, not improved.
- A late result appears in the game log only after the next `frame_end` or shutdown. Additional runtime SDK logging for later transport failures remains deferred, as before.
- Under load, the existing `dll-report` scenarios can still exceed the wait. They then return `ok` with the pending warning instead of the earlier `timeout` error; both outcomes fail that test, as before.
- No game was launched. Actual game load time, frame-time impact, and the behavior in ETS2/ATS single-player and TruckersMP remain pending under CAP-01/SP-01/ET-009.
