# Electron smoke failures and the main-process window stall

Recorded October 14, 2026 on branch `docs/ci-smoke-window-stall`, base `origin/main` `2d48c9a`. This record compares the retained evidence of intermittent Electron smoke failures in Windows CI. It belongs to ET-022 (CI). It changes no code, deadline, retry or Job limit, and establishes nothing about game compatibility.

## Summary

The four runs named for this investigation do not share one cause:

- Three failed for causes that are already recorded and fixed: the CPU-spinning overlay stall (two runs) and the renderer reload subscription race (one run).
- The newest, [38624116941](https://github.com/senukartur/ets2telemetry/actions/runs/38624116941), is a different failure. The Electron main (browser) process stopped dispatching events for about 17.7 s, starting right after it created the dashboard and overlay windows. During that time Playwright saw no page and the dashboard load could not finish. Among all 443 retained hosted launches it is the only window load slower than 1.7 s.

The cause of that stall is **unknown**. The existing evidence places it in the Electron main process and rules out a slow telemetry service or storage worker. It cannot tell CPU starvation under the Job's 25% cap from a native block inside the process, because no CPU accounting or event-loop timing is recorded. [Proposed diagnostics](#proposed-diagnostics) would answer that on the next occurrence. The owner approved them, and they are now collected; see [Implemented diagnostics](#implemented-diagnostics).

## Evidence per run

Artifacts were downloaded with `gh run download` and compared: `result.json`, `diagnostics/startup.jsonl`, `diagnostics/service/startup.jsonl`, `trace.zip`, `job-result.json` and `wrapper-result.json`. Times are from the main process diagnostics of the failed launch.

| Run | Failed step | Driver failure | APP_START → SERVICE_READY | APP_START → WINDOW_LOADED | Job | Cause |
| --- | --- | --- | --- | --- | --- | --- |
| [38271350918](https://github.com/senukartur/ets2telemetry/actions/runs/38271350918) (PR #21, `30a88b0`) | Development overlay smoke | `Independent reading arrived after the stalled renderer completed` | 647 ms | 1730 ms | exit 1, 12.8 s | CPU-spinning stall starved the independent renderer; fixed by the `debugger` pause ([ET-008](et-008.md), [CI](../ci.md#et-008-hidden-overlay-projection-checks-implementation-candidate)) |
| [38314471366](https://github.com/senukartur/ets2telemetry/actions/runs/38314471366) (PR #26, `a1e761e`) | Development overlay smoke | Same as above | 628 ms | 1713 ms | exit 1, 19.6 s | Same as above |
| [38324766032](https://github.com/senukartur/ets2telemetry/actions/runs/38324766032) (PR #31, `b8a9c3c`) | Packaged telemetry smoke | `page.waitForFunction: Timeout 10000ms exceeded` in `waitForCurrentTelemetry` | 564 ms | 1167 ms | exit 1, 20.9 s | Renderer reload subscription race; fixed in PR #40 ([record](renderer-reload-subscription-race.md)) |
| [38624116941](https://github.com/senukartur/ets2telemetry/actions/runs/38624116941) (PR #44, `c4d6e17`, dispatch) | Development scaffold smoke | `EXPECTED_EXACT_DASHBOARD_AND_OVERLAY_URLS_WITHIN_10_SECONDS` (`rendererPages`) | 545 ms | **18361 ms**, during teardown | exit 1, 21.3 s | Main-process stall, cause unknown (below) |

In the first three runs the dashboard loaded on time, 1.2-1.7 s after `APP_START`; they failed later in their journeys. Only 38624116941 failed at startup. Its re-dispatch on the same head, [38625838537](https://github.com/senukartur/ets2telemetry/actions/runs/38625838537), passed all six launches, with `WINDOW_LOADED` 1.65-1.72 s after `APP_START`.

### All retained hosted launches

To see whether 38624116941 was the visible end of a common slowdown, every unexpired `windows-evidence` artifact was downloaded: 135 artifacts, of which 113 contain Electron launches. They cover 443 launches from October 11 09:36 to October 14 19:54 UTC, across all six smoke steps and both runner images seen. Every launch reached `APP_START`, and every receipt that recorded the host reported two logical processors.

| Measure | Value |
| --- | --- |
| `SERVICE_READY` → `WINDOW_LOADED`, all 443 launches | min 125 ms, median 660 ms, p90 1102 ms, p99 1265 ms, max 17816 ms |
| Launches above 2 s | 1 (38624116941) |
| Next slowest launch | 1693 ms (passed) |
| Development scaffold launches only (75) | median 651 ms; slowest other than 38624116941 is 1409 ms |
| `MAIN_CHANNEL_CLOSED` before stop without a deliberate service exit | 1 (38624116941) |

The stall is one isolated event, not the tail of a distribution: no other launch came near the 10 s window deadline or lost its live channel. Every other failing launch in the retained set loaded its windows in 575-1114 ms and failed later in its journey, for an already recorded cause: the CPU-spinning overlay stall (38267265312, 38271350918, 38314471366, 38321006992 attempt 1), the renderer reload race (38324766032, 38470786173 attempt 1) or the ET-006a telemetry journey failure (38155150960, see [ET-006a](et-006a.md)).

## The 38624116941 stall

Timeline of the failed launch (UTC, October 14, 2026):

| Time | Source | Event |
| --- | --- | --- |
| 19:37:49.528 | main | `APP_START` |
| 19:37:49.994 | trace | Playwright `tracing.start` (the trace's only record) |
| 19:37:49.994 | main | `SERVICE_START_REQUESTED` (app ready) |
| 19:37:50.068 | service | `STORAGE_VERIFIED`, ready report |
| 19:37:50.073 | main | `SERVICE_READY`; main then creates both windows and subscribes to the service's live channel in the same synchronous step |
| 19:37:50.085 | profile | Chromium creates the default session's Local Storage database (`Local Storage/leveldb/LOG`) |
| about 19:38:00.0 | driver | `rendererPages` gives up after its 10 s deadline (inferred: no driver timestamp is recorded) |
| 19:38:07.827 | main | `MAIN_CHANNEL_CLOSED` (`Active service live subscription closed`) |
| 19:38:07.889 | main | `WINDOW_LOADED` |
| about 19:38:07.91 | driver | `tracing.stop` returns and `application.close()` starts (from `closeMilliseconds` 2217 and `finishedUtc` 19:38:10.127) |
| 19:38:07.917 | main | `APP_STOP_REQUESTED`, then service and app exit 0 |

What this shows:

- **The main process stopped dispatching.** The telemetry service closes a live subscriber that does not acknowledge a delivery within 5 s (`LiveSubscriptions`, `ackTimeoutMs = 5000`). Main acknowledges each delivery in its port handler as soon as it runs. A closed channel therefore means main did not run that handler for 5 s. Main then saw the close only at 19:38:07.827, and the dashboard load, normally about 1.1 s after `SERVICE_READY`, completed 62 ms later. The simplest reading is one continuous stall of the main thread from shortly after `SERVICE_READY` (19:37:50.073), when main posted the subscription, to 19:38:07.8, about 17.7 s. In Electron that thread is also Chromium's browser UI thread.
- **The stall began after window creation.** Main subscribed to the service after creating both windows, in the same synchronous step. Had window creation itself blocked, the subscription would have been sent only after the block and acknowledged normally. The Local Storage database was created 12 ms after `SERVICE_READY`, as in the passing re-run (14 ms). Chromium creates it on a background task runner, not on the browser UI thread, so this timing is only consistent with a normal startup. It does not show that the UI thread was still dispatching.
- **The service and storage worker were not affected.** The service booted, verified SQLite and reported ready in 37 ms, and reported `stopped` 2 ms after main's stop request.
- **Playwright could not see the pages.** Chromium's DevTools protocol, which Playwright uses to discover and attach pages, is served on the stalled browser UI thread. The trace contains only its `context-options` record: no page was ever attached. In the passing re-run both pages were attached 1.7 s after tracing started. `tracing.stop` also completed only after the stall ended. This is a consequence of the stall, not a separate Playwright attach failure: the app's own port handling, which does not involve Playwright, stalled in the same interval.
- **The release does not appear to come from the driver.** The driver was waiting in `tracing.stop` and had not yet asked the app to quit when the stall ended. The evidence does not show what ended it.
- **Shutdown was also slow.** Creating the empty Session Storage database during shutdown took 596 ms, against 3 ms in the passing re-run. This hints that the process was still slow, but it is one sample.
- The failed run used runner image `win22` `20261012.333.1`; the passing re-run used `20261004.326.1`. The only other retained run on `20261012.333.1`, [38610993355](https://github.com/senukartur/ets2telemetry/actions/runs/38610993355), passed all six launches with loads of 586-1062 ms. One failure among seven launches is too little to implicate the image.

## Possible causes

| Hypothesis | Supported by | Against or untested |
| --- | --- | --- |
| CPU starvation under the Job's hard 25% cap (about 0.5 of the 2 logical processors, shared by the driver, Electron main, GPU, two renderers and the service) | The cap already starved a renderer in the earlier busy-loop stall. The slow shutdown hints at a slow process | Nothing in the Job was known to need much CPU: a normal startup finishes in about 1.7 s. A hard cap delays threads rather than stopping one for 17 s, unless other Job processes used the whole budget. Job CPU time is not recorded, so this is untested |
| A native block on the browser UI thread (for example a synchronous wait on the GPU process or a cross-process window message) | The stall started right after window creation and ended abruptly: all queued events were handled within 90 ms | No main-thread stack, GPU process events or event-loop timing is recorded |
| Runner load outside the Job (other processes, antivirus scanning, I/O) | This was the job's first Electron launch, on a different runner image than the re-run | System-wide CPU and disk activity are not recorded |
| A Playwright attach problem | Playwright never attached a page | The app's own MessagePort handling stalled at the same time, which Playwright does not control |

## Relation to earlier launch timeouts

The ET-001 and ET-022 local packaged launches that timed out in `electron.launch` after 20 s ([ET-001](et-001.md), [ET-022](et-022.md)) had empty application diagnostics: main never logged `APP_START`, so they stopped earlier than this stall and at a point where these diagnostics cannot see. A browser-process stall at that point would look the same, but there is no evidence either way. They stay unexplained and are not linked to this run.

## Proposed diagnostics

These proposals are for owner decision. None is implemented. They change no deadline, retry or Job limit, and they add no product behavior outside isolated smoke diagnostics.

1. **Job CPU time series.** `scripts/watchdog/BoundedProcess.cs` already wakes every 100 ms while it waits for the driver, and already queries the Job's basic accounting, which contains total user and kernel CPU time. Sample it with `GetSystemTimes` on each wake and write `job/cpu.jsonl`: elapsed ms, Job CPU ms, active processes, and system busy and idle ms. That is at most 600 small rows per launch. Job CPU close to 0.5 processor-seconds per second during a stall means the cap was binding. Low Job CPU with a busy system means outside load. Both low means a native block.
2. **Main event-loop lag and window lifecycle events.** Only when `ETS2TELEMETRY_DIAGNOSTIC_DIR` is set, log `MAIN_EVENT_LOOP_LAG` with the measured gap when a 250 ms main-process timer fires more than 1 s late. Also log `WINDOW_CREATED` and `OVERLAY_CREATED` after each `BrowserWindow` constructor returns, each window's `did-start-loading` and `did-finish-load`, and `app` `child-process-gone` for GPU and utility processes. The lag event can be written only after a stall ends, but its gap gives the exact stall interval, and the window events locate it within startup. None of these names may match the smoke's failure pattern (`FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE`); a `GPU` `child-process-gone` would need a deliberate decision on whether it fails the smoke.
3. **Driver phase timestamps.** Record the driver's wall and monotonic times in `result.json` when launch returns, tracing starts, `rendererPages` starts and ends, tracing stops and close starts. The timeline above had to infer the driver's failure time.

Expected cost: one 250 ms timer in the main process during smokes, and up to 600 accounting samples per launch from a thread that already wakes at that rate. The ordinary test suite would need unit cases for the new receipt fields and the lag monitor. With these in place, the next occurrence would distinguish starvation, outside load and a native block, and would give the stall interval directly instead of by inference.

Changing a deadline, adding a retry or raising the CPU cap is not proposed: without the measurements above, any of them would hide the stall rather than explain it.

## Implemented diagnostics

Added October 14, 2026 on branch `chore/smoke-stall-diagnostics`, after owner approval. The proposal above is kept as written. The implementation differs only in names and detail:

- `BoundedProcess.Run` gained an opt-in overload. Only the smoke wrapper uses it. The series header also records the wall-clock start, so the series can be aligned with application diagnostics. `scripts/ci/job-cpu-summary.mjs` adds a per-second summary to `job-result.json` under `cpu`.
- The window events are `DASHBOARD_WINDOW_CREATED`, `OVERLAY_WINDOW_CREATED`, `<DASHBOARD|OVERLAY>_LOAD_STARTED` and `<DASHBOARD|OVERLAY>_LOAD_FINISHED`. The last includes the renderer PID, or `null` when it cannot be read. `CHILD_PROCESS_GONE` is observation only: it does not fail the smoke.
- `result.json` gains `phases`, and `pagesAtRendererPagesFailure` when page discovery fails.

[CI](../ci.md#bounded-runtime-checks) describes how to read the evidence. First hosted evidence, from dispatch run [38637611832](https://github.com/senukartur/ets2telemetry/actions/runs/38637611832) on head `4f68182`, where all six smokes passed:

- Every launch reported two logical processors and a 0.5-processor cap.
- Average Job use was 0.22-0.55 processors. Both scaffold startups ran at about the cap (0.50 and 0.55). So starvation remains a plausible cause of the 38624116941 stall, but it is not shown.
- The busiest single second reached 0.57-0.99 processors. Windows enforces the hard rate over its own interval, so read the cap over several seconds, not one.
- Window creation to load took 582-1105 ms. No launch logged `MAIN_EVENT_LOOP_LAG` or `CHILD_PROCESS_GONE`.

The stall has not recurred with these diagnostics in place, so its cause is still unknown.
