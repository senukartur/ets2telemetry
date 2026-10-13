# Native client test timeout validation

Recorded October 13, 2026 on branch `fix/client-test-timeout`, base `origin/main` `3c70b38d56813a2a07871b0c0c4558a381ad4aed`. This is a test-harness and CI-registration fix for the native broker's console fixture (`native/telemetry-client/tests/client-test.cpp`). It changes no product code. It has its own record rather than an addendum to a feature record because the fixture spans ET-006a, CAP-01a and ET-006 (#28) cases.

## Problem

Main push run [38319616211](https://github.com/senukartur/ets2telemetry/actions/runs/38319616211) on `4f16fab` failed in "Build desktop and native x64". The single CTest entry `native-pipe-client` was killed at its 30 s timeout (30.01 s). Hosted runs usually take 23.2-23.8 s. The fixture's stderr is unbuffered, so the log shows the process was still inside `partial-payload` (after `authority received`) when it was killed. No assertion had failed. PR #28 later raised that timeout to 60 s, which masks the symptom without explaining it.

## Findings

All runs below used the local Windows 11 host from the CAP-01a record and the Release build.

- **Unloaded runs are deterministic.** The whole fixture ran 30 times unconstrained, all passing. The sum of case times was 22,969-23,250 ms (median 23,062).
- **Four fixed waits dominate.** Four cases take about 21.4 s of the 23 s. Each waits out a fixed product or fixture window:

  | Case | Fixed window | Measured (median / max of 30 runs) |
  | --- | --- | --- |
  | `quiet` | Broker must still be alive at 5.5 s | 5,672 / 5,703 ms |
  | `quiet-exit` | Host keeps the pipe 5.5 s | 5,563 / 5,594 ms |
  | `partial-prefix` | Broker's 5 s partial-frame deadline | 5,078 / 5,110 ms |
  | `partial-payload` | Broker's 5 s partial-frame deadline | 5,063 / 5,079 ms |

  Every other case takes 0-266 ms; per-case figures are in the results section.
- **No broker hang was found.** Nothing in the 30 unloaded runs, the 2-core runs or the contention runs below stalled without bound. When the broker overran the fixture's bound under contention, it still exited by itself and wrote its fixed diagnostic. In one such run that diagnostic reported 7,016 ms in the relay stage.
- **The fixture's waits were too tight.** `Child::wait()` allowed 6 s for a broker process to exit. Frame reads (`stdio_io`) and the host's connect wait allowed 5 s. These sit 0-1 s above the product windows the timed cases wait out. Process creation and broker authority (image hashing, discovery) consume the margin on a loaded host.
- **Contention reproduces both failure modes.** Four CPU-bound processes were pinned to the fixture's single core:
  - The monolithic fixture, instrumented with per-case timing but otherwise unchanged, took 34.4 s, 40.2 s and 61.6 s, with every case passing. All three runs would exceed the old 30 s CTest timeout, and one would exceed the current 60 s.
  - With the per-case split but the old bounds, `partial-prefix` and `partial-payload` failed their 6 s `client.wait()` in one of three runs.

Most likely cause, reproduced locally: the fixture's wait bounds are a test timing assumption, and the hosted kill is that assumption summed over one executable. About 75 process launches plus four fixed 5-5.7 s windows run in one process under one timeout. A slower hosted run spreads seconds of delay across cases and exceeds the timeout without any case failing. This is an inference, not hosted confirmation. The old hosted log has no per-case timestamps, so it cannot locate where that run lost its time. The per-case timing added here will show it in future hosted runs, and that confirmation remains pending.

## Changes

- `client-test.cpp`:
  - Every case prints `case <name> ms=<n>` on stderr.
  - The case lists are named arrays.
  - `--verify-cases <list>` fails when the CTest registration and the fixture's list differ.
  - A case filter that matches no case now fails instead of passing vacuously.
  - The fixture's hang-detection waits (child exit, frame reads, host connect) share one 15 s bound, `fixtureWaitMs`.
  - The `quiet` EOF-promptness bound is 4 s, still below every 5 s broker deadline. Its "alive after 5.5 s" assertion is unchanged.
  - The broker also exits (code 3) when the host process exits. In `quiet`, `partial-prefix` and `partial-payload` the host is therefore held for `hostHoldMs` (45 s, three times the fixture bound) and still returns as soon as the broker exits. This keeps a broker regression from passing by riding on host exit.
  - `partial-prefix` and `partial-payload` measure the broker's exit from just after the credit and require 4.5-12 s, so the 5 s partial-frame deadline is neither early nor missing. A missing EOF cancellation in `quiet` would now exit only at host exit, about 39 s after EOF, far beyond the 4 s bound and the 15 s wait.
  - Independent review of `7eb1fc8` found that, without the held host, the 15 s wait let a broker without the partial-frame deadline pass by exiting at the 10 s host exit, and left only about 0.5 s between a prompt and a non-prompt `quiet` exit. This change addresses both findings.
  - The temporary base directory is named by PID plus process creation time, so it cannot collide with a directory left by an earlier killed run.
- `CMakeLists.txt`:
  - One CTest entry per case: `native-pipe-client-<case>`, and `native-pipe-client-asan-<case>` in the ASan build, plus a `*-case-list` entry.
  - Each entry has a 20 s backstop, or 30 s for the four timed cases, doubled under ASan.
  - All entries share a resource lock, because the fixture's endpoint names are fixed per user and session. The lock serializes entries only within one `ctest` invocation. Do not run client suites concurrently: the Release and ASan suites, or suites from two worktrees, collide on the same endpoint names.
- Workflow: the ASan step selects `-R '^native-pipe-client-asan-'`. The ordinary step runs every entry in the client build directory as before.

## Results

All checks below ran on the final test source, before merging `origin/main`.

- Client Release CTest, 10 runs unconstrained: 37/37 entries passed in every run, total 23.72-23.96 s.
  - Per entry: `quiet` 5.68-5.70 s, `quiet-exit` 5.58-5.61 s, `partial-prefix` 5.08-5.11 s and `partial-payload` 5.07-5.11 s.
  - Every other entry took at most 0.19 s; `case-list` took about 0.02 s.
- The same 10 runs on 2 cores (`start /affinity 3`): 37/37 entries passed in every run, total 23.90-24.04 s. Every other entry took at most 0.20 s.
- Client Release CTest under contention (four CPU-bound processes on the fixture's single core), 5 runs: 37/37 entries passed in every run, total 140-145 s.
  - The slowest entries were `quiet` 11.1-12.1 s, `partial-*` 9.3-10.7 s and `quiet-exit` 8.9-10.3 s, each within its 30 s backstop.
  - The slowest other entries were `valid`, `stale-live` and `dead-live` at up to 7.0 s, against a 20 s backstop.
  - Before the wait fix, the same setup failed `partial-prefix` and `partial-payload` in one of three runs.
- Client ASan build as in the workflow (`-DETS2TELEMETRY_CLIENT_ASAN=ON`, targets `telemetry-pipe-client-asan` and `telemetry-client-test-asan`), with `-R '^native-pipe-client-asan-'`: 37/37 passed in 25.6 s.
  - Timed entries: `quiet` 5.76 s, `quiet-exit` 5.65 s, `partial-prefix` 5.14 s, `partial-payload` 5.15 s.
- Negative checks:
  - `--verify-cases` with a different list exits 1 and prints both lists.
  - `ETS2TELEMETRY_CLIENT_TEST_CASE=no-such-case` exits 1 with `matched 0 cases`.
- One intermediate 10-run batch failed `reparse-record` once at the fixture's own `require(!fs::exists(base))`, before any case work. The local temp directory still held 17 `ets2telemetry-client-test-<pid>` directories left by earlier killed or failed runs. Running 37 processes per suite instead of one makes reuse of such a PID likelier. The base directory name now also carries the process creation time, and the rerun batches above passed. The 17 old directories were left in place; they are test temp files, not created in this session.
- `npm run typecheck`, `npm run lint`, `npm test` (30 files, 557 tests), `npm run build`, `npm run native:configure`, `npm run native:build` and `npm run native:test` (plugin, 38/38) all passed.

Review corrections (held host, measured partial-frame exit), on the corrected test source:

- Mutation proofs with temporary broker edits in `src/client.cpp`, each reverted with `git checkout` and rebuilt afterwards:
  - With the `pipe_io` wait forced to `INFINITE`, which removes the partial-frame deadline, `partial-prefix` and `partial-payload` failed after 15.09 s each at the fixture's wait; `quiet` and `quiet-exit` passed.
  - With the Credits reader no longer signalling `cancelled` on stdin EOF, `quiet` failed (20.69 s); the other three timed entries passed.
- Restored broker: `partial-prefix` exited after 5,000 ms and `partial-payload` after 5,015 ms, measured from just after the credit. Their entry times are unchanged at about 5.1 s, so passing runs are not slower.
- After the correction (`498b1f7`, on merged main `62c2d0f`):
  - Client Release CTest, 5 runs unconstrained: 37/37 entries passed in every run, total 23.76-23.80 s.
    - Timed entries: `quiet` 5.68-5.70 s, `quiet-exit` 5.58-5.60 s, `partial-prefix` and `partial-payload` 5.08-5.09 s.
    - Every other entry took at most 0.20 s.
  - The same 5 runs on 2 cores: 37/37 entries passed in every run, total 23.90-23.99 s, with the same timed-entry ranges.
  - Client ASan as in the workflow: 37/37 passed in 25.7 s (`quiet` 5.78 s, `partial-*` 5.14-5.16 s).
  - `npm run typecheck`, `npm run lint`, `npm test` (30 files, 557 tests), `npm run build` and the native plugin suite (40/40) passed.

Not done here:

- Hosted CI on this branch.
- Locating where hosted run 38319616211 lost its time. Its log has no per-case timestamps; future runs print `case <name> ms=<n>`.
- Measuring the shorter product windows (the broker's 5 s deadlines). They are product behaviour and were not changed.
