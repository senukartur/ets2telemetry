# ET-009 overlay latency measurement

## Audit and scope (October 20, 2026)

Existing lifecycle/freshness logs cannot measure SDK-to-overlay latency. A v0 capture has a session-relative timestamp,
but the formatted overlay projection lost its identity. The v1 service already calibrates its clock against the same
plugin clock. A subscription acknowledgement or animation callback does not establish frame presentation.

The default-off measurement correlates **v0 speed/fuel** with Chromium frame pixels. It excludes independent v1 sections,
input-to-SDK time, Windows DWM composition, scan-out and monitor response. It establishes neither game compatibility nor
performance acceptance. The 200 ms goal remains a target until actual game measurements are reviewed.

## Method and limits

Main attaches a unique token to each new eligible v0 capture's projection. React commits a small opaque black/white
marker alongside speed/fuel. Schema v2 uses Electron's [`capturePage`](https://github.com/electron/electron/blob/v44.7.0/docs/api/web-contents.md#contentscapturepagerect-opts)
to read only the marker rectangle (128x8 CSS pixels, adjusted for zoom), with at most 20 requests/s and one pending
readback. It runs only for a loaded, visible eligible overlay and uses `stayHidden: true, stayAwake: false`; an in-flight
request cannot show the page after Alt+Tab. Main timestamps readback resolution before decoding. This introduces no
renderer timing commands, rendering hooks, game-memory reads, game/desktop capture or saved screenshots/video.

After observing the frame, main sends its source/session/clock identity to the current service. A mismatched, paused,
stale or unmapped source, or a mapping older than 1500 ms, is rejected. With `source ≈ service + offset ± uncertainty`,
`serviceNow - sourceCapture + offset + uncertainty` is a conservative capture-to-readback upper bound, since service
receipt follows readback completion. The lower bound is `mainReadback - mainPublish` on one clock. Main and service Node
clock origins are never compared. Native v0/v1 streams share the SDK adapter's source clock.

Bounds assume the offset stays inside measured uncertainty during the reported mapping age; both values are retained.
The upper bound includes polling, readback, decoding and IPC; the lower bound includes polling/readback delay. An upper
bound <=200 ms supports that observed-stage target for that sample. A bound >200 ms alone does not prove slow physical
presentation. A physical screen claim requires a separately designed external-camera/optical measurement and reference.

Readback adds diagnostic overhead: disable this mode for separate performance checks. Live coalescing, scheduling and
capture can skip tokens. Preserve all attempted rows, missing frames/replies, startup, outliers and exclusions. Review
p50/p95/p99/max of both bounds and successful/attempted counts; do not infer acceptance from successful rows alone.
There is no automatic overall pass verdict.

## Activation, collection and evidence

All three variables are required: `ETS2TELEMETRY_OVERLAY_LATENCY=1`, an absolute `ETS2TELEMETRY_PROFILE_DIR`, and an absolute
`ETS2TELEMETRY_DIAGNOSTIC_DIR`. Use new evidence paths per launch. Keep real `LOCALAPPDATA` for authenticated native
discovery, disable automatic plugin setup and use a unique `ETS2TELEMETRY_RECORDING=synthetic:<run-name>` target so game
sources remain live-only and real history is not opened. The profile override **does not isolate application preferences**:
snapshot real settings/history before/after and preserve owner changes. Pin installed DLL hashes; change no game files
while a game runs.

Collection starts with a visible, current, non-paused, non-editing projection with fresh window authority. It ends after
120 seconds, 3000 attempted captures or explicit Exit. Pending rows expire after two seconds; retirement/non-current
projections invalidate pending work. Tokens never repeat in one app lifetime. Output is atomically written to
`<diagnostics>/overlay-latency.json`; logs show `OVERLAY_LATENCY_STARTED`, `OVERLAY_LATENCY_SAVED` or a write failure. Only
bounded scalar rows are retained. Report flushing participates in the existing bounded shutdown idle; abrupt termination
or a failed/over-budget write is not a successful run.

Pin commit, build/source hashes, EXE/ASAR/broker/DLL hashes, game/TruckersMP versions, Windows/GPU/display configuration
and UTC interval. Retain launch receipt, raw report, app/service logs, owner scenario notes, process/exit audit and
before/after file hashes. Distinguish this instrumented candidate from previous functional candidates. Preparation or a
simulator does not move ET-009 to Done.

## Operator sequence

Start with ATS single-player, windowed, and select ATS in the diagnostic app. Enter a safe offline driving area. During
the two-minute interval keep ATS foreground, display/overlay settings unchanged, and include a stationary interval,
gradual acceleration, steady driving and a normal stop. Avoid Alt+Tab and menus while collecting. The marker is expected.
After the coordinator confirms the report is saved, use Exit and close the game; audit completion and preserve evidence.
Repeat the required game/mode matrix or record an explicit owner acceptance decision with its limits. Investigate missing
frames, failed calibration or wide bounds before interpreting the target.

## Automated checks

`tests/unit/overlay-latency.test.ts` covers opt-in gates, hand-computed bounds, stale/mismatched clocks and sessions,
marker scale/corruption, retirement, missing frames, outliers, duplicates and deadline. Existing main/overlay tests protect
the default path. After `npm run build`, run the actual sandboxed renderer/preload and production observer/collector:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/diagnostics/Run-OverlayLatencySmoke.ps1 `
  -OutputRoot D:\absolute\new-smoke
```

This smoke uses the existing Windows Job containment (30 s, 16 processes, 2 GiB, 25% CPU, kill-on-close), isolated Electron
state and synthetic fixtures at zoom 0.75, 1 and 1.5. It opens no application service, settings, history or games. Its
controlled in-process clock does not validate native calibration. First paint is warmed up here only; game startup rows
remain measured.

Preparation evidence remains under `.local/validation/et009-latency-compositor-*`: `-a` records a PowerShell inline-quoting
failure; `-b` records a real first-paint delay (4/25 frames at the first scale). The corrected file-based builder and
warmed-up `-c` passed all scales (24/25 each). The later `-final` run decoded all scales but exposed a harness receipt-write
race after the last window closed (empty summary despite exit 0). The harness now keeps the app alive through its write
and the wrapper independently requires a complete receipt. Preserve these original results. Final-source checks belong
to the PR and frozen run evidence.

Local final preparation: typecheck passed; 134 Node test files / 4205 tests passed; PSScriptAnalyzer passed with 40 files
and zero findings; Forge package inspection verified 151 files and unchanged plugin SHA-256
`b2a30a4fe4e07f3396dd635d3b1afbe8e83ac7869f1ba6ab0c19b41d728e4f00`. The packaged scaffold smoke naturally drained its
descendants and passed. `-verified` has a complete compositor receipt and 24/25 matched frames at every scale; its
synthetic upper-bound maxima were 19.106/19.167/19.403 ms, which are not real-game measurements. Full ESLint passed with
`.claude/**` excluded: the ordinary command also traverses an unrelated nested Claude checkout with missing lint
dependencies and fails there. That local checkout was preserved. Native game calibration and latency remain pending.

## First ATS game attempt and observer fix (October 20, 2026)

The first frozen-path launch (`78f8532`) hit the existing four-entry v0 broker-policy capacity. It shut down cleanly and
reported zero attempted samples. No policy was edited. The identical 151-file package was then launched from its already
authorized `out` path while ATS remained running. The owner completed the prescribed cycle in ATS single-player 1.61.3.18,
windowed 1920x1200 at 144 DPI. Collection ran 18:24:09–18:26:09 UTC and saved a report: **1914 attempted, zero observed
frames/valid bounds**, 1882 frame-or-reply timeouts and 32 unfinished rows. This is failed instrumentation, not measured
latency or game performance failure. Preserve both original attempts under `.local/validation/et009-latency-ats-sp-windowed-78f8532*`.

The original compositor smoke subscribed after loading its document. Production subscribed on the hidden initial
`about:blank` widget. Matching the production order reproduced zero matched frames (25 attempts) without a game in
`.local/validation/et009-latency-before-load-reproduction`. Electron's [subscriber implementation](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/frame_subscriber.cc)
can retain a host without constructing a video capturer when its view is absent. The observer now waits for
`did-finish-load`, ends capture on navigation, rebinds for the loaded/recovered document and supports explicit disposal.
The smoke retains the before-load/hidden/resize path. The fixed reproducer matched 25/25, 25/25 and 24/25 frames; the
final source smoke matched 25/25, 24/25 and 24/25 at zoom 0.75/1/1.5. These remain synthetic results.

Two bounded log records, `OVERLAY_LATENCY_FIRST_FRAME` and `OVERLAY_LATENCY_FIRST_RESULT`, now allow a stationary
preflight before asking the owner to drive. Reports also count `observedFrames`, separating failure to observe pixels
from failure to calibrate a bound. The unit regression covers initial blank state, navigation, reload, completion and
listener disposal. A corrected game run is still required; do not reuse either failed report as acceptance evidence.

Corrective checks retain two local full-suite failures: a real `tasklist` call exceeded its 10 s budget in
`game-processes.test.ts`, and a later run timed out in the existing `plugin-setup.test.ts` locked-file polling case at
5 s. The isolated game-process suite passed (19 tests). No assertions, test timeouts or expected values were relaxed;
the full suite was rerun with four workers to reduce host contention while ATS remained running. The corrected package
is built in a separate output directory so the still-running original application and its frozen evidence are untouched.

## Stationary observer retry and explicit readback (October 20, 2026)

The owner closed the first retry through Exit; all six shutdown steps and application/service exits passed. The
`a37ba88` package was verified and copied into the existing authorized application path, without touching game files.
However, its real stationary preflight also failed: 18:40:00–18:42:00 UTC, **1911 attempted, zero observed frames and
zero valid bounds**. The owner confirmed that both overlay and marker were visible. The after-load change fixed the
synthetic startup case but did not resolve capture in this game environment. The underlying continuous-subscription
failure remains unexplained; it must not be described as resolved by that change.

The current v2 observer replaces continuous subscription with bounded explicit marker readback. Reports identify this
different endpoint/method; do not compare its values directly with hypothetical v1 frame-callback latency. They retain
request/completion counts, one-pending state, eligibility/visibility skips, bitmap dimensions and decoding counts.
Retired-document responses are ignored; an active readback error ends measurement, and disposal cancels scheduling.
The original game reports and the passing but insufficient subscription tests are preserved. A more faithful two-window,
isolated-session/topmost/odd-viewport smoke still passed continuous capture, so those tests do not explain the game
failure. The first explicit-readback smoke matched 19/25, 25/25 and 25/25 synthetic captures at zoom 0.75/1/1.5.
Real stationary calibration with v2 is still required before another driving cycle.

V2 final local checks: typecheck and lint passed; the full suite passed 134 files / 4207 tests with four workers. The
marker-only compositor smoke matched 21/25, 25/25 and 25/25 at zoom 0.75/1/1.5, retaining the missing rows. Static package
inspection verified all 151 files and the unchanged game-plugin hash. The observer counts requested/completed readbacks,
in-flight work, hidden/ineligible polls and decoded tokens, without storing images. These are preparation checks only.
