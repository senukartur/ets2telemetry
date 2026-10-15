# Windows CI job split: AddressSanitizer job

Recorded October 15, 2026 on branch `chore/ci-split-asan-job`, base `origin/main` `ceba919`. This record belongs to ET-022 (CI). It moves the native AddressSanitizer steps of [Windows CI](../../.github/workflows/windows-ci.yml) into a parallel job. It removes no check and changes no command, test selection, step timeout, deadline, cap or retry. It establishes nothing about game compatibility. The resulting layout is described in [CI job layout](../ci.md#job-layout).

## Problem

The workflow had one job, **Windows x64 scaffold**, with a 20-minute timeout. By October 15, 2026 successful hosted runs took 17.4 and 19.0 minutes. The Ready run [38723874689](https://github.com/senukartur/ets2telemetry/actions/runs/38723874689) for PR #56 ran for 1202 s and was cancelled at the limit, although every step up to the final upload had succeeded. Every later PR that adds steps would time out.

## Measured durations before the split

Step durations come from `gh run view <id> --json jobs` (`startedAt` and `completedAt` of each step, one-second resolution). Job duration is `completedAt - startedAt` of the job. All three are `pull_request` runs on `windows-2022`.

| Step | [38707218393](https://github.com/senukartur/ets2telemetry/actions/runs/38707218393) `92f230c` | [38714322202](https://github.com/senukartur/ets2telemetry/actions/runs/38714322202) `107bbd2` | [38723874689](https://github.com/senukartur/ets2telemetry/actions/runs/38723874689) `ba5952d` |
| --- | ---: | ---: | ---: |
| Set up job, checkout, setup-node | 16 | 15 | 18 |
| Acquire pinned CMake | 16 | 13 | 14 |
| Verify npm and record versions, cache restore | 5 | 6 | 5 |
| `npm ci` | 18 | 17 | 19 |
| Lint TypeScript and JavaScript | 25 | 28 | 28 |
| Analyze PowerShell scripts | 23 | 27 | 22 |
| Typecheck and Node-safe suite | 48 | 50 | 54 |
| Storage suite under Electron | 23 | 23 | 27 |
| Build desktop and native x64 (includes Release CTest) | 266 | 289 | 302 |
| CAP0 controlled capture chain | 2 | 2 | 2 |
| **SDK-independent console AddressSanitizer checks** | **335** | **377** | **413** |
| **Separate native client AddressSanitizer controls** | **64** | **61** | **63** |
| v0 CLI pipe smoke | 1 | 1 | 1 |
| Development smokes (scaffold, telemetry, overlay, lifecycle) | 50 | 62 | 66 |
| Forge make and package inspection | 96 | 100 | 96 |
| Packaged smokes (scaffold, telemetry, overlay, lifecycle) | 46 | 58 | 62 |
| Final versions, upload and post steps | 6 | 6 | 7 |
| **Job** | **1043 (17.4 min)** | **1138 (19.0 min)** | **1202 (20.0 min, cancelled)** |

Run 38707218393 predates the two lifecycle smokes. The extended regressions were skipped in all three runs. Rounded step durations do not add up exactly to the job duration.

Log timestamps split the two ASan steps of 38714322202 and 38723874689:

| Phase | 38714322202 | 38723874689 |
| --- | ---: | ---: |
| Plugin ASan configure and build | about 162 s | about 173 s |
| Plugin `-R asan-contract` CTest, 68 tests | 211.71 s | 236.67 s |
| Client ASan configure and build | about 25 s | about 26 s |
| Client `^native-pipe-client-asan-` CTest, 37 tests | 33.52 s | 34.09 s |

The ASan trees are built from the checkout alone and use no output of the earlier steps, so they can run on another runner.

## Change

- New job `windows-asan`, check name **Windows x64 native AddressSanitizer**, 20-minute timeout. It checks out the source, sets up pinned Node 24.19.0 only for `scripts/ci/versions.mjs`, acquires the checksum-pinned CMake, records host versions, runs the two ASan steps unchanged and in the same order, records final versions and uploads `windows-asan-evidence-<run>-<attempt>` with `.local/ci` and the ASan CTest diagnostics of both trees.
- The scaffold job keeps its ID `windows`, its name **Windows x64 scaffold**, its 20-minute timeout and every other step. Its artifact `windows-evidence-<run>-<attempt>` no longer lists the `build-asan` diagnostics, which the new job uploads.
- Triggers, the draft skip, the path filter, the concurrency group with cancel-in-progress, permissions and the `extended` dispatch input are unchanged. The extended regressions stay in the scaffold job.

A structural comparison of the workflow before and after (parsed with a small subset parser, since the repository has no YAML tooling) confirmed: unchanged `on`, `concurrency` and `permissions`; identical `if` on both jobs; the two ASan steps byte-for-byte equal to the removed ones; every other original step present unchanged in the scaffold job except the upload path list; distinct artifact names.

## Expected durations

Derived from the step durations above, not measured:

| Job | Estimate | Basis |
| --- | --- | --- |
| Windows x64 scaffold | 644–726 s (10.7–12.1 min) | Previous job minus the two ASan steps |
| Windows x64 native AddressSanitizer | about 430–520 s (7.2–8.7 min) | ASan steps 399–476 s plus about 30–45 s of setup, version records and upload |

## Pending

- Hosted runs of the new layout on the branch and after Ready, with per-job durations recorded here.
- Evidence that both artifacts upload and that a failure in either job fails the run.
