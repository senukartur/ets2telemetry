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
- A late success logs the message `ETS2Telemetry: transport started after the startup wait`. A late failure logs the same fixed error as an early one, keeps `failed` status and publishes no endpoint. This matches the existing runtime failure after startup. A startup cancelled by SDK shutdown is not reported.
- Shutdown during a pending startup uses the existing stop path: stop event, repeated `CancelSynchronousIo`, join.

Rejected alternatives: a longer synchronous budget would block the game longer. A fully asynchronous startup would drop the synchronous ET-004a failure report for common local failures (collisions, insecure ACLs, foreign discovery records).

## Tests

| Case | What it checks |
| --- | --- |
| `snapshot-transport-contract-startup-late` and its ASan counterpart | A console hook (`startup-before-endpoint`, compiled only into the console-test core) holds the actual worker. `await_startup()` returns `timeout` after about 1,000 ms, and nothing is logged while pending. Late success: the endpoint listens, one `message` log arrives from `frame_end` on the SDK thread, nothing more after further frames or shutdown, and a real client receives `welcome` and `checkpoint`. Late failure: an actual foreign pipe created during the hold makes startup fail with `failed` status and no endpoint. The worker never logs, and explicit shutdown logs the fixed `endpoint-creation` error once; the foreign pipe is preserved. Stop during the hold joins promptly with no report. A prompt startup leaves no deferred entry; this is checked only when the first wait returns `none`, so a loaded host cannot make it flaky |
| `snapshot-transport-late-reporting-contract` and `snapshot-transport-asan-contract-late-reporting` | Official `scs_telemetry_init`/`scs_telemetry_shutdown` on a separate hooked test DLL (`snapshot-transport-hooked-test-plugin`, the only artifact with the `ets2telemetry_test_transport_hook` export). Held startup returns `ok` after the fixed wait with exactly one pending warning. Late success logs one message from `frame_end` and the endpoint serves the handshake. Late failure against an actual foreign pipe logs one fixed error from `frame_end` and preserves the foreign pipe. Shutdown while pending is bounded and adds no log. All logging runs on the SDK caller thread |
| Existing `snapshot-transport-reporting-contract` | Unchanged scenarios; additionally asserts error severity. Prompt local failures still return `generic_error` with one fixed error log |

The `Host::log` fake now records the severity instead of requiring `error`. The `snapshot-transport-test` `io()` helper also reports bytes from an operation that completes between its deadline and `CancelIoEx`, matching the CAP0 helper fix in `97b0e67`. Before, it returned `false` and dropped bytes it had already consumed.

RED check: with the product timeout path restored to the old failure, and without the deferred log, `startup-late` failed with `late success reaches a later frame_end callback`. `late-reporting` failed with `held startup returns ok after the fixed wait` after 1.05 s. Both pass with the change.

## Commands and results

Environment: Windows 11 Home 10.0.26200 x64, Visual Studio 18 Community, MSVC tools 14.51.36231, CMake 4.3.1-msvc1, Node 24.19.0, npm 11.17.0 (portable pinned copy). Base `main` `4f16fab`.

| Command | Result |
| --- | --- |
| `npm ci`, `npm run typecheck`, `npm run lint:install`, `npm run lint` | Passed; no diagnostics, zero lint errors and warnings |
| `npm test` | 30 files, 547 tests passed |
| `npm run native:configure`, `npm run native:build`, `npm run native:test` | Build clean with `/W4 /WX`; **40/40 CTest passed** (34.6 s), including the two new cases |
| ASan configure (`-DETS2TELEMETRY_ASAN_TESTS=ON`), build of the CI ASan target list plus `snapshot-transport-hooked-test-plugin`, `ctest -R asan-contract` | **34/34 passed** (46.4 s), including `snapshot-transport-asan-contract-startup-late` and `-late-reporting` (3.1 s each; waits 1,000-1,016 ms, pending stop 15 ms) |
| `npm run build`, `npm run test:cap0-chain` | Passed; chain 1/1 |
| `dumpbin /exports` | Production `ets2telemetry-plugin.dll` exports exactly `scs_telemetry_init` and `scs_telemetry_shutdown`. The hook export exists only in the hooked test DLL, and only that DLL contains the `startup-before-endpoint` phase string |

## Contention comparison

Each tree ran 3 batches of 32 concurrent `snapshot-transport-test dll` lifecycles (each lifecycle runs three official init/shutdown cycles of the isolated test DLL). Each batch also ran 48 concurrent `snapshot-transport-asan-test accept-failure` processes as CPU load. Everything was pinned to one core through inherited process affinity. `main` `4f16fab` was built in an ignored detached worktree. In both runs the load processes reported startups up to about 1.9 s (20 and 27 of 432 over 1 s).

| Tree | Lifecycles passed | `official DLL initialization` failures | `official DLL shutdown joins active IO under deadline` failures |
| --- | --- | --- | --- |
| `main` `4f16fab` | 79/96 | **14** | 3 |
| This change | 95/96 | **0** | 1 |

On `main`, each initialization failure is a plugin load that the game would keep failed for the session. The shutdown failures occur on both trees. That is the test's fixed 1 s shutdown bound under single-core oversubscription; this change does not touch the stop path. An earlier lighter run without CPU load (64 concurrent lifecycles, one core) passed 192/192 on this change.

## Remaining limits

- The init wait still blocks the game's main thread for up to 1,000 ms when startup is slow. That bound is unchanged, not improved.
- A late result appears in the game log only after the next `frame_end` or shutdown. Additional runtime SDK logging for later transport failures remains deferred, as before.
- Under load, the existing `dll-report` scenarios can still exceed the wait. They then return `ok` with the pending warning instead of the earlier `timeout` error; both outcomes fail that test, as before.
- No game was launched. Actual game load time, frame-time impact, and the behavior in ETS2/ATS single-player and TruckersMP remain pending under CAP-01/SP-01/ET-009.
