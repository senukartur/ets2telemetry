# Game history recording enablement — validation

Date: October 25, 2026 (Europe/Warsaw). Authorization: the owner's instruction of the same day, recorded in [AGENTS.md](../../AGENTS.md#game-history-recording-enablement--october-25-2026). This record states what was checked and what was not. It claims nothing about a real game, TruckersMP, display or performance.

## What changed

- `GAME_HISTORY_RECORDING` is `true` in [recording-policy.ts](../../apps/desktop/src/recording-policy.ts). The default plan now makes the `ets2` and `ats` selections durable over the history database, so the service builds a `TripRecorderSink` in production and `deriveRecordingStatus` no longer reports `disabled` there.
- Nothing else in the product changed: no wire, schema, migration, IPC, preload, renderer or native code. The dashboard and tray already had texts for every recording state and for the `history` target (ET-015c PR-4).
- The decisions that came with it (v0 retirement not awaited, the unverified boundaries, TD-021) are in the AGENTS.md section and in [technical debt](../technical-debt.md).

## What the dashboard shows now

| Situation | Recording state | Dashboard headline |
| --- | --- | --- |
| The service starts, the database is opening | `opening` | `Opening the database` |
| No source or a synthetic source is selected | `not-recorded-source` | `Not recording the selected source` |
| ETS2 or ATS is selected, the game is not running | `waiting` | `Waiting for the recorded source to connect` |
| The game runs and the plugin delivers | `recording` | `Recording` |
| The game is paused | `paused` | `Game paused; recording continues when it resumes` |
| The connection dropped | `interrupted` | `Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap` |
| The history database is refused (for example a newer schema) | `stopped` with the code | `Stopped: <cause>. Restart Yukon Union Telemetry after fixing it` |

The status card's notice now reads `Prototype live display. Game history recording is new; check the recording status below.`

## Tests that moved with the flag

Expected values were written by hand from the status rules G3 and the plan rules R3, not copied from the output, except where a text is a fixed string of the product.

- `tests/unit/recording-policy.test.ts`: the tripwire asserts `true`; the plan cases already covered the enabled branch.
- `tests/unit/telemetry-service-v0.test.ts`: the default service builds the `TripRecorderSink` for `ets2` and `ats` over the history target (the options, `durableReady` only while the database is open, `durableAvailabilityChanged` on open); rejected `ETS2TELEMETRY_RECORDING` values keep that default; production reports `opening` instead of `disabled`. The shared history-storage stand-in keeps the real `recorderClient`.
- `tests/storage/history-refusal.test.ts`: through the production wiring a refused history database now reports `opening` and then `stopped` with the refusal's code, for all five refusals and for `DATABASE_LOCKED`.
- Four storage suites no longer assert the flag; they assert that a synthetic target never creates the history database, which now also holds with the flag on.
- `tests/unit/runtime-receipt.test.ts`: the refusal and journal receipts follow the smokes below, and the old `disabled` shapes became invalid cases.

## Runtime smokes that moved with the flag

The smokes asserted the earlier fixed texts. Each was first run unchanged against the flag, failed on that text, and was then updated from the observed value after checking it against the rules.

| Smoke | Earlier expectation | Now |
| --- | --- | --- |
| `telemetry` (synthetic source) | `Off: this version does not record game history` | `Not recording the selected source` with the history notice |
| `lifecycle` | main's `{state: 'disabled'}` and the same text | `not-recorded-source` for the history target, zero losses, no trip |
| `refusal` (newer schema) | `disabled`, one status row | `stopped` with `SCHEMA_NEWER`, two status rows (`opening`, `stopped`), the stopped headline and alert |
| `journal` (empty history) | note `Game history recording is off in this version…` | no note (that note belongs to the `disabled` state) |

`RuntimeReceipt.ps1` and its unit cases changed accordingly.

## Checks performed

All on the owner's Windows 11 machine with the pinned Node 24.19.0 and Electron 44.7.0, from a clean `npm ci`, on the branch head that carries this change:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` (ESLint, zero warnings) and `npm run lint:ps` (43 files) | Passed, 0 findings |
| `npm test` | 166 files, 5,377 tests passed |
| `npm run test:storage` | 39 files, 460 tests passed |
| Development runtime smokes: worker, telemetry, lifecycle, refusal, journal, recording, overlay, hard-mode and the UI shards shell, live, journal, settings, overlay | Each passed once locally. `telemetry`, `lifecycle` and `refusal` were run before the journal change, which does not touch them |
| Development `plugin` smoke | **Not run to completion.** It refuses to start while `eurotrucks2.exe` is running (the owner's game was open), so it is left to CI |

Failures on the way, kept: the first `telemetry` and `refusal` runs failed on the earlier fixed texts, as intended, and the `lifecycle` and `journal` expectations were found by searching for the same texts; the first `telemetry-service-v0` run failed on a history-storage stand-in without `recorderClient` (39 tests, one file). The storage suite passed on its first full run.

CI is not claimed: the draft pull request must be checked by manual dispatch, and the run after **Ready for review** on the final head is the merge gate.

## Not checked

- No real game, TruckersMP session or real recorded trip. The application has never recorded a real game; the first run is the pending check below.
- The packaged smokes, the hosted installer lifecycle and the extended campaigns run only in CI; they were not run locally.
- The full-volume, ACL, other-user, remote-pipe, clock/suspend and power-loss boundaries stay unverified (accepted without testing by the owner on October 25, 2026).
- Recording cost: CPU, disk growth and frame time beside a real game are unmeasured. The synthetic soaks are not real recording evidence.

## First real recorded trip

What to do and what to look at, for the owner. Nothing here is an instruction to the application.

1. Install a build that contains this change (the installer of the `main` run after the PR merges, or a local update fixture as used for ET-044 and ET-045). Keep a copy of `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite` first if you want to return to the present history.
2. Start the application, select ETS2 or ATS in Settings → Data, and start the game. The dashboard should move from `Waiting for the recorded source to connect` to `Recording`.
3. Take a short job, drive, stop on the road, use the menu, then deliver (or cancel) it.
4. Open the Journal: the trip should be there with its outcome and completeness. Open its details, and export the JSON.
5. Report what the dashboard said at each step, any `Recording problem` alert with its text, and the exported file. A gap is recorded as a gap and is not an error by itself.

An uninstall removes this history ([AGENTS.md](../../AGENTS.md#uninstall-removes-local-data--october-16-2026)); export a trip you want to keep.
