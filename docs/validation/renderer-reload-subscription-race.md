# Renderer reload subscription race

Recorded October 14, 2026 on branch `fix/renderer-reload-subscription-race`, base `origin/main` `0a72da6a8188e5204f1f996370021f54bc4b66a4`. This record covers an intermittent Windows CI failure in the packaged telemetry smoke. The cause was a product race in the Electron main process, not the harness. The fix and its regression checks belong to ET-022 (CI) because the defect surfaced only there. They also protect the ET-006a dashboard and ET-008 overlay subscription paths. Nothing here establishes game compatibility.

## Problem

The step `./scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode packaged -Scenario telemetry` failed intermittently with `JOB_FAILED`:

- Run [38324766032](https://github.com/senukartur/ets2telemetry/actions/runs/38324766032) on PR #31 (a plugin-only change), October 12, 2026.
- Run [38470786173](https://github.com/senukartur/ets2telemetry/actions/runs/38470786173) attempt 1 on PR #39, head `9dd2186`, October 13, 2026. Attempt 2 passed.

In both runs the driver's `failure` was `page.waitForFunction: Timeout 10000ms exceeded`, raised in `waitForCurrentTelemetry` from the `renderer-reload-2` observation. `rendererObservations` held `initial` and `renderer-reload-1` only.

## Evidence

From the downloaded artifacts (`result.json`, `diagnostics/*.jsonl`, `trace.zip`):

- **The new dashboard document never received a live update.** The trace's final DOM snapshot shows `waiting: Awaiting telemetry service` with origin `game`. That is the dashboard's text before its subscription callback has run even once. A subscription delivers the current state immediately on attach, so this document was never attached. Main logged no failure, crash or subscription error.
- **The failing reload committed late.** Trace times from the reload call to the `navigated to` entry:

  | Run, journey | Reload 1 | Reload 2 |
  | --- | --- | --- |
  | 38324766032 packaged telemetry (failed) | 33 ms | 477 ms |
  | 38470786173 packaged telemetry (failed) | 47 ms | 526 ms |
  | 38470786173 development telemetry (passed) | 47 ms | 551 ms |
  | Other telemetry/overlay journeys in both runs (passed) | 18-47 ms | 50-76 ms |

  The hosted Job allows 25% of 2 logical processors. Every failure had a commit later than 250 ms, but one run with a 551 ms commit passed. That is consistent with a race that a late commit makes possible but does not decide on its own.

## Root cause

Reproduced locally with the repository's Electron 44.7.0 in a minimal app outside the repository:

1. When a reload starts, main handles `did-start-loading` by closing the dashboard's live port and clearing `subscribed`.
2. The replaced document keeps running until the replacement commits. Its preload sees the port close and, as designed, schedules a re-subscribe after 250 ms (`lost()` in `preload.ts`).
3. If the commit takes longer than 250 ms, that request reaches main before the commit. Electron keeps the same `WebFrameMain` object for the main frame across the reload, so `trusted()` (sender and main-frame identity) accepts it. The experiment showed `event.senderFrame === webContents.mainFrame` for the replaced document's request 260 ms after `did-start-loading` and 257 ms before `did-navigate`. Only the internal `routingId` differed.
4. Main sets `subscribed = true` and sends a port to the dying document.
5. The new document subscribes after its commit. Main ignores the request because `subscribed` is already true. When the replaced document goes away, its port closes and `dashboardPort` is cleared, but nothing reconnects. The dashboard stays without data.

The overlay's `overlay:subscribe` path has the same shape: a held `overlayPort` from the replaced document makes main ignore the new document's request.

The experiment also showed the ordering the fix relies on. Every IPC message from the replaced document, including `beforeunload`, `pagehide` and `unload` sends, arrived before `did-navigate`. The replacement document's first message arrived after it.

## Fix

`apps/desktop/src/main.ts` now retires the window's subscription a second time on `did-navigate`, the main-frame commit of the new document:

- **Dashboard.** The same retirement as `did-start-loading`: increment the renderer epoch, clear `subscribed`, close the subscriptions and drop the port.
- **Overlay.** `retireOverlay()`.

Anything subscribed between the start of the load and the commit belonged to the replaced document. When such a subscription existed, main logs the fixed event `DASHBOARD_PRECOMMIT_SUBSCRIPTION_RETIRED` or `OVERLAY_PRECOMMIT_SUBSCRIPTION_RETIRED`. Neither name matches the smoke's failure-event pattern.

If the replacement document's request ever arrived before `did-navigate`, the fix would close that new port. The preload's existing bounded recovery would then subscribe again after 250 ms, so the worst case is a short delay, not a dead view. The trust check, the one-subscription limits and the recovery budgets are unchanged.

## Regression checks

- **Unit.** `tests/unit/main-boundaries.test.ts` adds two cases, each for the dashboard and the overlay. The first follows the exact order observed: subscribe, `did-start-loading`, a trusted subscribe from the replaced document, `did-navigate`, then the new document's subscribe. It requires that the pre-commit port is closed, the diagnostic is logged and the new document receives an open port with an immediate delivery. Both instances fail against the previous `main.ts`. The second case checks that an uncontended reload keeps one subscription, ignores a duplicate request and logs nothing.
- **Smoke.** The telemetry journey adds a third reload, `renderer-reload-delayed-commit`. A Playwright route holds only the replacement document's navigation request for 2 s, eight times the 250 ms re-subscribe delay. This makes the race happen on every run instead of by chance. The step requires the current 90 km/h / 73 L observation and exactly one new `DASHBOARD_PRECOMMIT_SUBSCRIPTION_RETIRED` event for that reload. That event proves the replaced document's request did arrive before the commit. An earlier unheld reload that hits the race on a slow host is counted separately and does not fail the check. `result.telemetry.delayedCommit` records the hold and both event counts, and `rendererReloads` is now 3.

The two original unheld reloads are unchanged. Every observation keeps its 10 s deadline; no timeout was raised. The hold adds about 2 s to a journey that takes about 10 s locally, inside the unchanged 60 s Job.

## Local results

Host: the local Windows 11 workstation (24 logical processors), pinned Node 24.19.0, Electron 44.7.0, Playwright 1.64.0. The smoke wrapper applied the same Job limits as CI; 25% of this host is far more CPU than the hosted runner gets.

- **Before the fix**, with the new smoke step, one development telemetry run: the job failed with `page.waitForFunction: Timeout 10000ms exceeded` at the `renderer-reload-delayed-commit` observation. Phases `initial`, `renderer-reload-1` and `renderer-reload-2` passed. This is the hosted failure's signature, now produced deterministically.
- **After the fix**, on the branch before its rebase onto `0a72da6`:
  - Development telemetry: 5 of 5 passed.
  - Packaged telemetry: 5 of 5 passed.
  - Development and packaged scaffold, and development and packaged overlay with `-ForceRendererReuse` as in CI, each passed once.
- **After the rebase**, on code commit `e5ddcab`, rebuilt and repackaged:
  - Development telemetry: 2 of 2 passed.
  - Packaged telemetry: 3 of 3 passed.
  - Development and packaged scaffold and overlay (`-ForceRendererReuse`): each passed once, with wrapper receipts valid.
  - `npm run typecheck`, `npm run lint` and `npm test` (30 files, 568 tests) passed.

Every telemetry run after the fix took about 10 s and recorded `precommitRetirementsBefore: 0` and `precommitRetirementsAfter: 1`. Hosted confirmation is the manual dispatch on the PR head and the final Ready run; that evidence lives in the PR, not here.

## Limits

- The overlay journey has no delayed-commit reload. Its fix is protected by the unit case only.
- The 2 s hold assumes the replaced document's 250 ms timer fires within about 2 s on a loaded runner. If it ever does not, the step fails with the explicit `Delayed-commit reload did not retire the replaced document subscription` message, not with a silent pass.
- The commit-before-new-IPC ordering is an observation of Electron 44.7.0 behavior. The fix remains safe if that ordering changes, as described above.
