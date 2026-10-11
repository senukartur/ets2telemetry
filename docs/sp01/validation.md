# SP-01 validation record

Recorded October 11, 2026. Base: `e4f0324eafd3a90e0274f6c42a9e54f90f780ae6`. Branch: `feat/sp-01-game-overlay-spike`. Candidate identity is recorded in the PR/coordinator ledger and smoke receipt; this document does not label later edits as tested. Implementation is entirely in `experiments/sp01/**`; explanatory material is in `docs/sp01/**`.

## Results and limits

| Criterion / regression | Evidence | State |
| --- | --- | --- |
| Project-owned SDK-derived C++17 x64 DLL | Release build with MSVC `/W4 /WX`; official SDK license retained | Passed build; actual load pending |
| Short callback copying, unavailable/zero, SDK units, pause/reset | `sp01_sdk_lifecycle` console harness compiles the plugin source and supplies synthetic SDK callbacks; both game IDs, registration error, unsupported API/game, duplicate init and repeat shutdown | Passed; no actual SDK invocation claim |
| Bounded queues/frame serialization | `sp01_native` queue overflow/order/empty and finite/null/zero checks | Passed |
| Local user DACL, one server, actual pipe, reconnect, stalled consumer and shutdown / partial REG-011 | `sp01_native` inspects exact ACE SID, rejects server collision, reads actual unique named pipe, reconnects, stops an unread client, tests absent reader | Passed in bounded Job; different-user/remote-client attempts not executed |
| Frame validation / partial REG-009, REG-010 | Six Node test groups: split/coalesced frames, uint64 precision, sequence/session rejection, malformed/version/game/value/window bounds, unavailable/zero, field stripping | Passed |
| Functional React overlay and TypeScript | Vite build and spike-specific strict typecheck | Passed build |
| Native pipe → utilityProcess → secure preload → renderer → disconnect/normal shutdown | Reviewed coordinator-owned `electron-smoke.mjs`; per-PID synthetic source and fully isolated environment | Prepared; actual launch pending |
| Foreground/minimize/focus/click-through/DPI / REG-016 | Native PID foreground predicate and Electron flags implemented; [actual checklist](game-checklist.md) | Mandatory game evidence pending |
| Both TruckersMP borderless sessions, one SP windowed and one Convoy session | [SP-01 matrix](game-checklist.md) | Pending |
| 200 ms display latency, frame-time impact and longer stability | No clock mapping or game measurement yet | Unmeasured |

No production integrity, durable events/ACKs, storage, migrations, sampling, packaged distribution or full ET-009 coverage is claimed. The native SDK test is a console harness compiling the same source with an isolated test pipe suffix, not a real-game DLL load test. The DLL has no test suffix override. The synthetic app smoke cannot prove click-through/input focus or game compatibility.

## Commands actually run

Clean `npm ci --cache D:\Projects\ETS2Telemetry\.local\npm-cache` under pinned Node 24.19.0/npm 11.17.0 and `NODE_OPTIONS=--use-system-ca` succeeded: 218 packages added, audit reported zero vulnerabilities. Existing dependency warnings were retained; no dependency versions/root manifests were changed.

The official SDK download/extraction succeeded and measured SHA256 `77504F14D2AC1405BA70EE3A97351662ADBB39C0CF9D3A085423F01D37BC28EC`. SDK archive version is 1.15; telemetry API header current is 1.01. Readme confirms all plugin callbacks are on a single main thread and calls back to SCS must remain in permitted direct game callback context. Native background code calls no SCS API.

Commands used the absolute vendor CMake directory `C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin` and pinned portable Node under the ET-001 worktree. Configure: `cmake -S experiments/sp01 -B experiments/sp01/build -A x64 -DSCS_SDK_ROOT=<ignored verified extraction>`; build: `cmake --build experiments/sp01/build --config Release`; typecheck: `node node_modules/typescript/bin/tsc -p experiments/sp01/app/tsconfig.json`; UI: `node experiments/sp01/build-app.mjs`.

`run-checks.ps1` ran CTest and Node tests inside the existing Windows Job helper, with independent 15 s / 10 s deadlines. Latest implementation-stage receipt `.local/sp01-check-5`: native CTest 2/2 passed in 1.58 s and codec 6/6 passed after the final plugin changes. Spike-specific strict typecheck, root `tsc --noEmit`, syntax checks and Vite build passed. Existing fast baseline ran under the same Job helper with a 60 s deadline: Vitest 8 files / 118 tests passed in 6.13 s (`.local/sp01-baseline-tests`). Subsequent code edits require fresh affected checks before acceptance. Earlier development failures remain visible: initial CMake path was absent; native test initially lacked `sddl.h`; direct TS7 command required an explicit config and CSS declaration type; one check invocation omitted `Common7\IDE` from the vendor path. These were corrected; they are not successful check receipts.

Final implementation-stage built DLL SHA256: `0583DEC72B3A712E02F03CD94218E6DB81FBBF915441AF5915B4A662873344ED`. Native test executable SHA256: `6C2D79A45366044C406A1005EEDD0B06E511B2CB882B5CFE9A975EE423BB9610`. Smoke source SHA256: `9E8B46528164C83BC7E442CA1A9C2E3F1B924E7D3D35FAF787A3D3F96D3CA692`. These identify local outputs before coordinator execution; rebuilds may produce different binary hashes and must be rerecorded. No Electron smoke result exists yet.

## Read-only installed game discovery

Windows Steam registry points to `C:\Program Files (x86)\Steam`. Its actual `steamapps\libraryfolders.vdf` also lists `D:\SteamLibrary` and **`E:\SteamLibrary`**, where the games were found. Previous C:/D: probes alone did not establish absence. The following files were inspected without launching or modifying games:

| Item | Discovery October 11, 2026 |
| --- | --- |
| ETS2 | `E:\SteamLibrary\steamapps\common\Euro Truck Simulator 2\bin\win_x64\eurotrucks2.exe`; product 1.61.1.1, file `1.61.1.1 (6949e633e77902f7e023819d3131cc6ccce3707f)`; Steam buildid 25482642 |
| ATS | `E:\SteamLibrary\steamapps\common\American Truck Simulator\bin\win_x64\amtrucks.exe`; product 1.61.3.1, file `1.61.3.1 (da49adfbbbdb18e60be1a4bd5896d77eebddc129)`; Steam buildid 25646448 |
| TruckersMP launcher | `%LOCALAPPDATA%\TruckersMP\app-1.3.13\TruckersMP-Launcher.exe`; file/product 1.3.13. This identifies the installed launcher, not a connected multiplayer client/server session |
| Host | Windows 11 Home 10.0.26200/build 26200; Intel Core i7-13700KF; NVIDIA GeForce RTX 4070 Ti, driver 32.0.16.1714 |

No `eurotrucks2` or `amtrucks` process was found in the read-only process inventory. No project DLL was installed or removed, no game/client launched, and no accounts or game profiles were changed. Monitor/DPI, RAM, privileges and actual-session client version remain to be recorded when testing.

## Decision

**Continue to coordinated manual validation; acceptance/proceed decision remains pending.** Build and isolated native/protocol evidence support preparing the sessions. They do not support marking TruckersMP compatible or unlocking ET-002a. Keep the PR draft and the ET-009 parent open. Retire/promote the experiment only after recording the required actual evidence and resolving observed failures.

## Primary sources

- [Official SCS SDK archive](https://download.eurotrucksimulator2.com/scs_sdk_1_15.zip): downloaded and read locally, including readme, telemetry example, headers and license.
- [Microsoft: named pipe security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) and [CreateNamedPipe](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createnamedpipew).
- [Microsoft: CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex): cancellation completes before releasing operation storage.
- [Electron: BrowserWindow](https://www.electronjs.org/docs/latest/api/browser-window), [screen](https://www.electronjs.org/docs/latest/api/screen), and [utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process).
