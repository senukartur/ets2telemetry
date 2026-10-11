# Windows CI and regression infrastructure

ET-022 provides [Windows CI](../.github/workflows/windows-ci.yml) for pull requests, pushes to `main`, and manual dispatch. Hosted-runner acceptance, controlled failing-assertion evidence, and final candidate evidence remain pending until actual GitHub runs are recorded. Creating a workflow does not establish branch protection, available billing allowances, or game compatibility.

The explicitly selected x64 `windows-2022` image uses Visual Studio 2022 with `Visual Studio 17 2022`, not the local Visual Studio 2026 generator. Image updates may change MSVC, SDK and CMake patch versions; each run records image identity and vendor versions. Node 24.19.0, npm 11.17.0, Electron 44.7.0 and Playwright 1.64.0 are pinned. Action revisions are pinned to exact commits (checkout v5, setup-node v5, cache v4, upload-artifact v4). The [runner manifest](https://github.com/actions/runner-images/blob/main/images/windows/Windows2022-Readme.md) documents VS 2022 support.

Every run installs the lockfile into a clean workspace, runs typecheck and the full Node-safe Vitest corpus, builds desktop and native x64, runs CTest, executes a bounded development Electron smoke, makes the actual Forge/Squirrel artifact, inspects packaged bytes/native paths, and executes the packaged smoke from an unrelated working directory. Vitest never imports Electron or native SQLite. No lint command exists in the scaffold. No test filtering or retries are enabled.

Only downloaded npm archives and Electron distributions are cached. Keys include lockfile, Windows/x64, Node 24.19.0 ABI 137 and Electron 44.7.0 ABI 149. No `node_modules`, native build tree, SQLite binding compiled for another runtime, packaged artifact, profile or database is cached. This is deliberately stricter than [setup-node's default download caching](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md).

## Bounded runtime checks

Run from the repository root on Windows with pinned Node on PATH, after `npm run build` / `npm run make` respectively:

```powershell
./scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode development
./scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode packaged
```

Each mode launches once under the existing Windows Job Object: 60 seconds maximum, 16 processes, 2 GiB committed memory, 25% system CPU and kill-on-close. The owner retains the Job until all descendants exit; a forced cleanup/timeout fails. Playwright launch keeps its 20-second deadline and normal close has 8 seconds. Release sandbox, context isolation, narrow frozen bridge and Node isolation remain enabled. [Playwright Electron support is experimental](https://playwright.dev/docs/api/class-electron); the prior ET-001 launch timeout remains unexplained and is not erased by later success.

Readiness proves Electron main → utilityProcess → storage worker → actual bundled better-sqlite3 N-API write, close, reopen, read. Successful close must report normal app/service exit, worker stop and removal of the temporary probe. This does not test production history, migrations or game telemetry. Paths for TEMP, profiles, APPDATA and LOCALAPPDATA are unique per mode/run; no real user history or game files are accepted. Development and packaged checks remain sequential inside the job to stay within desktop resource caps.

Evidence remains under `.local/ci/<mode>-<uuid>`: expected/actual assertions, candidate identity, Node/Electron/Playwright versions, bounded app/service/Job logs, screenshot and trace. Trace collection failure also fails the smoke. A launch failure can prevent trace creation; the Job stdout/stderr and failure metadata remain available. Abandoned synthetic files are retained for diagnosis rather than deleting evidence before upload. Hosted workspace disposal removes them; local users can remove their exact owned run directory after reviewing it. Test helper owners clean their own synthetic fixtures; `tests/unit/test-resources.test.ts` exercises parallel uniqueness and preservation of a second owner during cleanup.

The wrapper also writes a distinct `wrapper-result.json`. A missing, malformed, failed or mismatched driver receipt fails even if the Job exits zero; a nonzero Job fails even when the driver reports success. The wrapper never overwrites driver evidence or invents worker/security/runtime observations after an early crash. Its receipt records actual Job exit, owned PID and log paths, observed Node version and pinned Playwright metadata; absent Electron runtime observations remain null. Inert `tests/unit/runtime-receipt.test.ts` protects these failure paths without launching Electron. ET-022's first local packaged launch timed out at the unchanged 20-second deadline with an unhandled Playwright promise rejection and no driver receipt; a separately recorded same-cap DEBUG diagnostic succeeded. That failure remains visible and is not a clean-pass claim or justification for retries.

Pushes to `main` and manual dispatch with `extended: true` add actual existing watchdog fixtures and uninstall-residue regressions. These do not run an installer. Production crash/ACK recovery, historical migrations, replay, native parser/fuzz/ASan, sustained recording and domain/protocol branch coverage remain pending until those components exist. The [scenario registry](regression-registry.md) distinguishes pending feature requirements from partial scaffold protection.

Job timeout is 20 minutes; feedback under 10 minutes is a target, not a measured guarantee. `versions.json` records elapsed time from toolchain verification through final collection. GitHub job duration includes earlier checkout/setup overhead and is the end-to-end timing source. Always-uploaded 14-day evidence includes JUnit results, runtime runs, package inspection and CTest diagnostics; workflow command logs contain build/install/vendor output. Current private-repository protection limitations still apply. Superseded runs are cancelled; cancellation is not a passed check.

## Acceptance evidence still required

Record an actual clean hosted Windows run with install/type/build/full tests/native/smokes, then a temporary deliberate failing assertion producing a failed job, and a restored assertion producing a passed job. Remove the deliberate failure before final review. The coordinator owns pushes, PRs and these runs. Record run URLs, exact PR commit, expected/actual failure and measured duration; keep the earlier failure visible. Finally rerun/check the current reviewed PR commit. No local pass substitutes for this hosted evidence or independent review.
