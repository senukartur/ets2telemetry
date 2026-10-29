# Regression scenario-to-test registry

This file is the test index: every test entry point with the [regression scenarios](TESTING.md#4-permanent-regression-scenario-corpus) it protects, where it runs and what must not be removed. To find the tests for a scenario, search for its ID, for example `rg -n "REG-006" docs/regression-registry.md`.

**Changing this file.** Add one row for each new test entry point and update a row when an entry point moves or changes what it protects. Do not add dated notes or per-card sections ([documentation budget](agent-rules.md#documentation-budget)). The earlier narrative records are in the [registry history](regression-registry-history.md).

## Test index (ET-019t, October 17, 2026)

This index lists every test entry point once, with the scenarios it protects. The index says where a requirement is tested and what must not be removed; the narrative scenario rows that recorded what each scenario's protection proves are in the [registry history](regression-registry-history.md). Paths are repository paths, because file basenames repeat across layers. Each new test entry point is added here in the PR that adds it ([TESTING.md](TESTING.md#9-handoff-for-every-behavior-change)).

Columns:

- **REG IDs.** The scenarios the entry point protects in part. "Smoke evidence" marks a harness-integrity test: it guards the evidence of the runtime smokes for those scenarios, not the product behavior itself. "Harness" marks a test of a test helper that the named scenarios depend on.
- **Source.** How the mapping was confirmed. R: this registry, a scenario row or a dated paragraph. F: `REG-0nn` tags in the test file. T: [TESTING.md](TESTING.md). V: the validation record of the PR that added the file, found with `git log --diff-filter=A`; the record is named in brackets.
- **Owning card.** The card and PR that added the entry point.
- **Runs in.** PR: every Windows CI run on a code PR, in the job named (`Windows x64 tests`, `Windows x64 scaffold` or `Windows x64 native AddressSanitizer`). Extended: pushes to `main` and manual dispatch with `extended=true`. Extended campaigns workflow: the separate `windows-extended.yml` workflow, on pushes to `main` and by dispatch, not a required check (ET-019 PR-10). Soak workflow: run only by a dispatch of the separate `windows-soak.yml` workflow, never on push or pull_request, not a required check (ET-019 PR-12a). Manual: not run by CI.
- **Protected.** The categories that must not be removed or weakened: ACK, dedup, gap, trip completeness, security (DACL, peer, authority, sandbox, the renderer boundary), v0/CAP0 isolation, historical fixture, and regression (a test for a fixed bug). The categories were assigned by reading each file's case titles. A dash means none of these; such a test can still be the only protection of its REG.

### Vitest, Playwright and measurement entry points

| Entry point | Layer | REG IDs | Source | Owning card (PR) | Runs in | Protected |
| --- | --- | --- | --- | --- | --- | --- |
| `tests/unit/action-result-rendering.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-045b) | ET-045b | PR (tests job, `npm test`) | — |
| `tests/unit/app-health.test.ts` | Node unit (Vitest) | REG-011, REG-012 | T, V (et-011) | ET-011a (#52) | PR (tests job, `npm test`) | — |
| `tests/unit/app-lifecycle.test.ts` | Node unit (Vitest) | REG-012 | R | ET-011a (#52) | PR (tests job, `npm test`) | — |
| `tests/unit/autostart.test.ts` | Node unit (Vitest) | REG-012, REG-017 | R, T | ET-031 | PR (tests job, `npm test`) | — |
| `tests/unit/broker-artifact.test.ts` | Node unit (Vitest) | REG-003, REG-010, REG-011 | R | ET-006a (#13) | PR (tests job, `npm test`) | security |
| `tests/unit/capture-broker-client.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | security, v0/CAP0 isolation |
| `tests/unit/capture-cap0.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | v0/CAP0 isolation |
| `tests/unit/capture-controller.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | v0/CAP0 isolation |
| `tests/unit/capture-export.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | v0/CAP0 isolation |
| `tests/unit/capture-session.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | gap, v0/CAP0 isolation |
| `tests/unit/capture-writer.test.ts` | Node unit (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (tests job, `npm test`) | gap, v0/CAP0 isolation |
| `tests/unit/connection-diagnosis.test.ts` | Node unit (Vitest) | REG-015, REG-017 | R, F, T, V (et-017) | ET-017 (PR-6) | PR (tests job, `npm test`) | — |
| `tests/unit/dashboard-startup.test.ts` | Node unit (Vitest) | REG-011, REG-012 | T, V (et-011) | ET-011a (#52) | PR (tests job, `npm test`) | regression |
| `tests/unit/diagnostics-bundle-check.test.ts` | Node unit (Vitest) | smoke evidence: REG-015, REG-017 | T, V (et-017) | ET-017 (PR-6, PR #111 review) | PR (tests job, `npm test`) | security |
| `tests/unit/diagnostic-bundle-writer.test.ts` | Node unit (Vitest) | REG-012, REG-015, REG-017 | R, F, T, V (et-017) | ET-017 (PR-6) | PR (tests job, `npm test`) | security |
| `tests/unit/diagnostic-bundle.test.ts` | Node unit (Vitest) | REG-015, REG-017 | R, F, T, V (et-017) | ET-017 (PR-6) | PR (tests job, `npm test`) | security |
| `tests/unit/diagnostics.test.ts` | Node unit (Vitest) | REG-017 | T, V (et-001) | ET-001 (#5) | PR (tests job, `npm test`) | security |
| `tests/unit/event-loop-lag.test.ts` | Node unit (Vitest) | smoke evidence: REG-011, REG-012, REG-014, REG-016, REG-017 | V (ci-smoke-window-stall) | ET-022 (#46) | PR (tests job, `npm test`) | — |
| `tests/unit/exit-observation.test.ts` | Node unit (Vitest), inert emitters/promises and controlled clock | harness: REG-012, REG-017 | R, T | ET-011 (#162) | PR (tests job, `npm test`) | regression |
| `tests/unit/hard-mode-proof-observation.test.ts` | Node unit (Vitest), real monitor with gated read/bind, controlled clocks and trusted-request ports | harness: REG-011, REG-012 | R, T | ET-011 (#167), ET-026 journey | PR (tests job, `npm test`) | regression |
| `tests/unit/game-folder.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/game-processes.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | — |
| `tests/unit/guarded-fs.test.ts` | Node unit (Vitest) | harness: REG-015 | T, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/history-invariants.test.ts` | Node unit (Vitest) | REG-005, REG-006, REG-012 | F, T, V (et-019) | ET-019 (PR-1) | PR (tests job, `npm test`) | ACK, dedup, gap, trip completeness |
| `tests/unit/history-samples.test.ts` | Node unit (Vitest) | REG-001, REG-002, REG-003, REG-009, REG-018 | R, F | ET-015b (#85) | PR (tests job, `npm test`) | gap |
| `tests/unit/history-storage.test.ts` | Node unit (Vitest) | REG-007, REG-011 | R | ET-013 (#60); ET-038 | PR (tests job, `npm test`) | regression |
| `tests/unit/installer-driver-provenance.test.ts` | Node unit (Vitest) | REG-017 (historical provenance) | T, V (et-001) | ET-001 (#5) | PR (tests job, `npm test`) | — |
| `tests/unit/installer-guard.test.ts` | Node unit (Vitest) | REG-013, REG-017 | T, V (et-018) | ET-018 (PR-1); ET-045g; ET-045h | PR (tests job, `npm test`) | security |
| `tests/unit/installer-ui-navigation.test.ts` | Inert Node unit (Vitest), production navigation helpers and hidden-control/budget fixture | REG-017 | T, R (et-028 closeout) | ET-028 | PR (tests job, `npm test`) | exact visible startup, About warning, remaining deadline |
| `tests/unit/uninstall-data-wipe.test.ts` | Node unit (Vitest) | REG-017 | T, V (et-018) | ET-018 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/uninstall-engine.test.ts` | Node unit (Vitest) | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/uninstall-plugin-cleanup.test.ts` | Node unit (Vitest) | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/uninstall-roots.test.ts` | Node unit (Vitest) | REG-017 | T, V (et-018) | ET-018 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/squirrel-events.test.ts` | Node unit (Vitest) | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-3); ET-045g; ET-045h | PR (tests job, `npm test`) | security |
| `tests/unit/legacy-shortcuts.test.ts` | Node unit (Vitest) on an in-memory file system and fake shortcut reader | REG-012, REG-017 | F, V (et-045h) | ET-045h | PR (tests job, `npm test`) | security (exact candidates, ownership, no link followed, deadline) |
| `tests/unit/product-name.test.ts` | Node unit (Vitest) over the tracked copy, executor, window title and maker config | REG-012, REG-015, REG-017 | F, V (et-045h) | ET-045h | PR (tests job, `npm test`) | regression (no user-facing old name; kept technical identities) |
| `tests/unit/channel-identity.test.ts` | Node unit (Vitest) over the channel identity table, the routed constants, the maker config of both channels (a child Node process for staging), the mirrored script, storage and executor tables and the build-time define | REG-015, REG-017 | F, T | ET-055 (PR-1, PR-3) | PR (tests job, `npm test`) | regression (production identities byte-identical; no identity shared between channels) |
| `tests/unit/build-channel.test.ts` | Node unit (Vitest) over `scripts/build-channel.mjs` with injected environments, a temporary package.json and build evidence | REG-017 | F | ET-055 (PR-3, PR-4) | PR (tests job, `npm test`) | regression (exactly two channels accepted; staging by default; production only in GitHub Actions or with the owner override; staging version format; the built channel read from evidence) |
| `tests/unit/ci-build-channel-workflow.test.ts` | Node unit (Vitest) over the text of `.github/workflows/windows-ci.yml` | REG-017 | F | ET-055 (PR-4) | PR (tests job, `npm test`) | regression (production only on main; channel-named installer artifact; lifecycle skipped for staging; since October 28, 2026 a branch dispatch's staging run number and staging release artifact) |
| `tests/unit/configure-native-plugin.test.ts` | Node unit (Vitest) over `scripts/configure-native-plugin.mjs`, and one CLI run that stops before CMake | REG-017 | F | ET-055 (PR-4) | PR (tests job, `npm test`) | regression (no extra argument chooses the native tree's channel) |
| `tests/unit/export-file.test.ts` | Node unit (Vitest) over the export refusal with a fake file system | REG-015 | F | ET-055 (PR-3) | PR (tests job, `npm test`) | security (no export into either channel's data root) |
| `tests/unit/channel-app-name.test.ts` | Node unit (Vitest) with a fake Electron app | REG-017 | F | ET-055 (PR-3) | PR (tests job, `npm test`) | regression (separate userData and single-instance lock per channel) |
| `tests/unit/update-manifest.test.ts` | Node unit (Vitest) over the v1 manifest, the Ed25519 check with keys generated in the test, and the version and tag rules | REG-019 | F | ET-055 (PR-6) | PR (tests job, `npm test`) | security (signature, key rotation, channel, tag, exact name, downgrade) |
| `tests/unit/update-feed.test.ts` | Node unit (Vitest) over both feeds with a routed fake fetch and fake timers; no network | REG-019 | F, T | ET-055 (PR-6) | PR (tests job, `npm test`) | security (fixed URLs, staging selection regardless of order, bounds, rate limits) |
| `tests/unit/update-view.test.ts` | Node unit (Vitest) over main's application-info fallback | REG-019 | F | ET-055 (PR-6) | PR (tests job, `npm test`) | regression (an invalid build version never drops the application state) |
| `tests/unit/update-context.test.ts` | Node unit (Vitest) over the launch decision on literal roots | REG-019 | F | ET-055 (PR-6) | PR (tests job, `npm test`) | security (no check in unpackaged, portable or isolated launches; the loopback feed and test key only in a test root) |
| `tests/unit/update-controller.test.ts` | Node unit (Vitest) over the reducer and the controller with fake feed, Update.exe and running-game ports, fake timers and a guarded temporary data root | REG-012, REG-019 | F, T | ET-055 (PR-6) | PR (tests job, `npm test`) | regression (click only, refusals, verified download, stall, abort on exit, apply timeout, restart only when no game runs) |
| `tests/unit/update-control-dom.test.ts` (fixtures `tests/fixtures/update-control-dom`) | Node unit (Vitest) that bundles a page with Vite and runs the real components with React DOM in a hidden, sandboxed Electron window with an isolated userData folder | REG-019 | F, T | ET-055 (PR-7) | PR (tests job, `npm test`) | regression (the focused sidebar button survives failed and back; About waits only for a started check, its 30 s fake timer, rejection, `ready` and a standing offer) |
| `tests/unit/update-feed-fixture.test.ts` | Node unit (Vitest) running the product's feed reader, manifest verifier and downloader against the installer lifecycle's loopback feed over a real 127.0.0.1 socket; a per-test key | REG-019 | F | ET-055 (PR-8) | PR (tests job, `npm test`) | security (fixed feed paths, signature, the request check) |
| `tests/unit/update-incomplete-version.test.ts` | Node unit (Vitest) over `removeIncompleteVersion` in a guarded temporary root | REG-019 | F | ET-055 (PR-8) | PR (tests job, `npm test`) | regression (R1: only the half-written target folder goes, never the running one; links unlinked) |
| `tests/unit/installer-update-feed.test.ts` | Node unit (Vitest) over the installer driver's `update-feed`, `stub-launch` and `update-feed-verify` commands with hand-written evidence; no installer or application runs | REG-019 | F | ET-055 (PR-8) | PR (tests job, `npm test`) | regression (refusal with a game, one download after the click, the `update` exit and `recording-flush` before the restart into `app-<B>`, kept data) |
| `tests/unit/update-control.test.ts` | Node unit (Vitest) rendering the sidebar update control, the version line and the About check with `renderToStaticMarkup`, only the shadcn primitives substituted | REG-019 | F | ET-055 (PR-7) | PR (tests job, `npm test`) | regression (owner EN/RU texts and accessible names, hidden states, `aria-disabled` while busy, progressbar, assertive failure, click rules, staging badge, staging copy unchanged) |
| `tests/unit/release-scripts.test.ts` | Node unit (Vitest) over the release scripts on synthetic artifact folders, with keys generated in the test into temporary folders and the application's own manifest verifier; spawns the scripts under plain Node | REG-019 | F | ET-055 (PR-9) | PR (tests job, `npm test`) | security (signature round trip, wrong key and channel, artifact identity, exact nupkg name, key never printed, key path outside the repository, commit on main for production, staging from any branch's push or dispatch but never a pull request or a fork, version above the latest release, keys of the released commit read as data and never run, staging run-number binding, staging base not above main, script and application parsers agree) |
| `tests/unit/release-workflow.test.ts` | Node unit (Vitest) text assertions over `.github/workflows/release.yml` | REG-019 | F | ET-055 (PR-9) | PR (tests job, `npm test`) | security (dispatch only, read-only default, write permission only in environment-gated publish jobs, secret scope, pinned actions, no expanded inputs, unambiguous 404 answers, main ancestry for production only, keys of the run's commit) |
| `tests/unit/installed-app-icon.test.ts` | Node unit (Vitest) on a guarded temporary install root; injected execFile, never `reg.exe` | REG-017 | F, V (et-045g) | ET-045g | PR (tests job, `npm test`) | security (fixed key and value, no link followed) |
| `tests/unit/fixed-program.test.ts` | Node unit (Vitest) with real child processes | REG-012, REG-015 | T, V (et-018) | ET-018 (PR-3) | PR (tests job, `npm test`) | regression |
| `tests/unit/uninstall-deferral.test.ts` | Node unit (Vitest) | REG-017 | T, V (et-018) | ET-018 (PR-3) | PR (tests job, `npm test`) | security |
| `tests/unit/app-uninstall.test.ts` | Node unit (Vitest) | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-4) | PR (tests job, `npm test`) | security |
| `tests/unit/uninstall-text.test.ts` | Node unit (Vitest) | REG-017 | T, V (et-018) | ET-018 (PR-4) | PR (tests job, `npm test`) | — |
| `tests/unit/uninstall-executor.test.ts` | Node unit (Vitest); one real `reg.exe` round trip under its own `HKCU\Software\ETS2Telemetry-Test-<id>\RunOnce` key, deleted afterwards | REG-017 | T, V (et-018) | ET-018 (PR-5) | PR (tests job, `npm test`) | security |
| `tests/unit/uninstall-deferred-cases.test.ts` (fixture `tests/fixtures/uninstall/deferred-cases.json`) | Node unit (Vitest) | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-5) | PR (tests job, `npm test`) | security |
| `tests/unit/single-instance-relock.test.ts` (fixtures `tests/fixtures/single-instance`) | Node unit (Vitest) with the real Electron binary | REG-012, REG-017 | T, V (et-018) | ET-018 (PR-3) | PR (tests job, `npm test`) | — |
| `tests/unit/release-identity.test.ts` | Node unit (Vitest); one case calls the real Windows PowerShell 5.1 | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-6) | PR (tests job, `npm test`) | security |
| `tests/unit/installer-helper-provenance.test.ts` | Node unit (Vitest) | REG-017 (historical provenance) | T, V (et-001) | ET-001 (#5) | PR (tests job, `npm test`) | — |
| `tests/unit/installer-root-proof.test.ts` | Node unit (Vitest) | REG-017 (historical provenance) | T, V (et-001) | ET-001 (#5) | PR (tests job, `npm test`) | — |
| `tests/unit/job-cpu-summary.test.ts` | Node unit (Vitest) | smoke evidence: REG-011, REG-012, REG-014, REG-016, REG-017 | V (ci-smoke-window-stall) | ET-022 (#46) | PR (tests job, `npm test`) | — |
| `tests/unit/launch-evidence.test.ts` | Node unit (Vitest) | smoke evidence: REG-017, REG-018 | T, V (et-019) | ET-019 (PR-11) | PR (tests job, `npm test`) | — |
| `tests/unit/journal-broker.test.ts` | Node unit (Vitest) | REG-011, REG-014 | R, F | ET-016a (#97) | PR (tests job, `npm test`) | — |
| `tests/unit/journal-contract.test.ts` | Node unit (Vitest) | REG-014 | R, F | ET-016a (#97) | PR (tests job, `npm test`) | security |
| `tests/unit/journal-export-writer.test.ts` | Node unit (Vitest) | REG-014 | R, F | ET-016a (#101) | PR (tests job, `npm test`) | security |
| `tests/unit/journal-export.test.ts` | Node unit (Vitest) | REG-014 | R, F | ET-016a (#101) | PR (tests job, `npm test`) | gap, trip completeness |
| `tests/unit/journal-preload.test.ts` | Node unit (Vitest) | REG-011, REG-012, REG-014 | R, T | ET-016a (#97) | PR (tests job, `npm test`) | security |
| `tests/unit/journal-service.test.ts` | Node unit (Vitest) | REG-011, REG-014 | R, F | ET-016a (#97) | PR (tests job, `npm test`) | — |
| `tests/unit/journal-view.test.ts` | Node unit (Vitest) | REG-009, REG-014, REG-017 | R, F | ET-016a (#98) | PR (tests job, `npm test`) | gap, trip completeness |
| `tests/unit/info-hint-rendering.test.ts` | Node unit (Vitest) | REG-009 | R | ET-057 (#225) | PR (tests job, `npm test`) | — |
| `tests/unit/live-dashboard-break-rendering.test.ts` | Node unit (Vitest) | REG-009 | R, F | ET-052 PR-4 | PR (tests job, `npm test`) | — |
| `tests/unit/live-dashboard-text.test.ts` | Node unit (Vitest) | REG-002, REG-003, REG-009 | R, F | ET-010b (#62) | PR (tests job, `npm test`) | — |
| `tests/unit/live-smoke-source-v1.test.ts` | Node unit (Vitest) | REG-003, REG-010, REG-011 | R, F | ET-010c (#73) | PR (tests job, `npm test`) | — |
| `tests/unit/live-sources.test.ts` | Node unit (Vitest) | REG-002, REG-009, REG-010 | R | ET-010c (#73), ET-056 | PR (tests job, `npm test`) | — |
| `tests/unit/live-v1.test.ts` | Node unit (Vitest) | REG-010 | R | ET-010c (#73) | PR (tests job, `npm test`) | security |
| `tests/unit/main-boundaries.test.ts` | Node unit (Vitest) | REG-010, REG-011, REG-012, REG-014, REG-015, REG-016, REG-017 | R, F | ET-006a (#13) | PR (tests job, `npm test`) | security, regression |
| `tests/unit/game-source-coordinator.test.ts` | Node unit (Vitest) | REG-003, REG-010, REG-011, REG-012 | R, F | ET-056 | PR (tests job, `npm test`) | security, recovery, fixture isolation |
| `tests/unit/native-game-discovery.test.ts` | Node unit (Vitest) | REG-003, REG-010, REG-011 | R, T | ET-056 | PR (tests job, `npm test`) | security, bounded ownership |
| `tests/unit/source-mode.test.ts` | Node unit (Vitest) | REG-010, REG-012 | R, F | ET-056 | PR (tests job, `npm test`) | fixture isolation |
| `tests/unit/native-pipe-client.test.ts` | Node unit (Vitest) | REG-003, REG-005, REG-010, REG-011 | R, T | ET-006a (#13) | PR (tests job, `npm test`) | security |
| `tests/unit/overlay-bounds.test.ts` | Node unit (Vitest) | REG-016 | R, F | ET-045c | PR (tests job, `npm test`) | regression |
| `tests/unit/overlay-edit.test.ts` | Node unit (Vitest) | REG-016 | R | ET-012b (#74) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-geometry.test.ts` | Node unit (Vitest) | REG-016 | R, F | ET-012a (#70) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-placement.test.ts` | Node unit (Vitest) | REG-016 | T, V (et-012b) | ET-012b (#74) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-preload.test.ts` | Node unit (Vitest) | REG-016 | R | ET-008 (#21) | PR (tests job, `npm test`) | security, regression |
| `tests/unit/overlay-rendering.test.ts` | Node unit (Vitest) | REG-009, REG-010 | R, F | ET-056 (existing rendering entry extended) | PR (tests job, `npm test`) | localized explicit game choice |
| `tests/unit/overlay-presentation.test.ts` | Node unit (Vitest) | REG-009 | R, F | ET-012a (#70) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-latency.test.ts` | Node unit (Vitest) | REG-016, REG-018 | R, T, F | ET-009 | PR (tests job, `npm test`) | clock bounds, security, bounded diagnostics, before-load/reload regression |
| `tests/diagnostics/overlay-latency-smoke.ts` | Electron compositor smoke | partial REG-016, REG-018 | T | ET-009 | Manual, Windows Job via `Run-OverlayLatencySmoke.ps1` | synthetic frame correlation, zoom, no game latency claim |
| `scripts/diagnostics/Run-OverlayLatencySmoke.ps1` | PowerShell smoke entry | partial REG-016, REG-018 | T | ET-009 | Manual after `npm run build` | bounded ownership, isolated synthetic state |
| `tests/diagnostics/overlay-bounds-probe.ts` | Electron window-bounds probe | partial REG-016 | T | ET-045c | Manual, Windows Job via `Run-OverlayBoundsProbe.ps1` | actual versus requested bounds at the local scale factor, no game claim |
| `scripts/diagnostics/Run-OverlayBoundsProbe.ps1` | PowerShell probe entry | partial REG-016 | T | ET-045c | Manual after `npm ci` | bounded ownership, isolated synthetic state |
| `tests/unit/overlay-rows.test.ts` | Node unit (Vitest) | REG-016 | R, F | ET-012d (#81) | PR (tests job, `npm test`) | regression |
| `tests/unit/overlay-sections.test.ts` | Node unit (Vitest) | REG-009, REG-016 | T, V (et-012a) | ET-012a (#70) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-smoke-source.test.ts` | Node unit (Vitest) | smoke evidence: REG-009, REG-011, REG-016, REG-017 | R | ET-008 (#21) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay-strip.test.ts` | Node unit (Vitest) | REG-016 | R, F | ET-012c (#76) | PR (tests job, `npm test`) | regression |
| `tests/unit/overlay-settings-rendering.test.ts` | Node unit (Vitest) | REG-016, REG-017 | R | ET-048 | PR (tests job, `npm test`) | regression |
| `tests/unit/overlay-view.test.ts` | Node unit (Vitest) | REG-009, REG-016, REG-017 | R | ET-012a (#70) | PR (tests job, `npm test`) | — |
| `tests/unit/overlay.test.ts` | Node unit (Vitest) | REG-016 | R, F | ET-008 (#21) | PR (tests job, `npm test`) | security |
| `tests/unit/package-integrity.test.ts` | Node unit (Vitest) | REG-017 | R | ET-001 (#5) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-action-result.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-045b) | ET-045b | PR (tests job, `npm test`) | — |
| `tests/unit/plugin-bundle-stage.test.ts` | Node unit (Vitest) | REG-015, REG-017 | R, F | ET-017 (PR-1) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-bundle.test.ts` | Node unit (Vitest) | REG-015, REG-017 | R, F, T, V (et-017) | ET-017 (PR-4) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-installer.test.ts` | Node unit (Vitest) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-3) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-registry.test.ts` | Node unit (Vitest) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-3) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-setup-mode.test.ts` | Node unit (Vitest) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-4) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-setup-text.test.ts` | Node unit (Vitest) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-5) | PR (tests job, `npm test`) | security |
| `tests/unit/plugin-setup.test.ts` | Node unit (Vitest) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-4) | PR (tests job, `npm test`) | security |
| `tests/unit/preload-recovery.test.ts` | Node unit (Vitest) | REG-010, REG-015 | R | ET-006a (#13) | PR (tests job, `npm test`) | security, regression |
| `tests/unit/protocol-fuzz.test.ts` | Node unit (Vitest) | REG-010, REG-011 | F, T, V (et-019) | ET-019 (PR-9) | PR (tests job, `npm test`); Extended campaigns workflow (200,000 inputs per case) | security, v0/CAP0 isolation |
| `tests/unit/protocol-v0.test.ts` | Node unit (Vitest) | REG-003, REG-005, REG-010 | F | ET-002a (#9) | PR (tests job, `npm test`) | — |
| `tests/unit/protocol-v1-delivery.test.ts` | Node unit (Vitest) | REG-003, REG-004, REG-005, REG-006, REG-009, REG-010, REG-011 | F, T | ET-002b (#42) | PR (tests job, `npm test`) | ACK, dedup, gap |
| `tests/unit/protocol-v1.test.ts` | Node unit (Vitest) | REG-003, REG-004, REG-005, REG-006, REG-009, REG-010, REG-011 | F, T | ET-002b (#42) | PR (tests job, `npm test`) | gap |
| `tests/unit/recording-policy.test.ts` | Node unit (Vitest) | REG-007, REG-012 | T, V (et-015a) | ET-015a (#79) | PR (tests job, `npm test`) | — |
| `tests/unit/recording-proxy.test.ts` | Node unit (Vitest) | smoke evidence: REG-006, REG-012 | T, V (et-015a) | ET-015a (#82) | PR (tests job, `npm test`) | ACK |
| `tests/unit/recording-status-text.test.ts` | Node unit (Vitest) | REG-012 | R | ET-015c (#91) | PR (tests job, `npm test`) | gap |
| `tests/unit/recording-status.test.ts` | Node unit (Vitest) | REG-003, REG-006, REG-007, REG-011 | R | ET-015c (#90) | PR (tests job, `npm test`) | gap |
| `tests/unit/renderer-entry.test.ts` | Node unit (Vitest) | REG-016, REG-017 | V (et-012a) | ET-008 (#21) | PR (tests job, `npm test`) | — |
| `tests/unit/renderer-observation.test.ts` | Node unit (Vitest) | smoke evidence: REG-002, REG-003, REG-009, REG-011, REG-016 | T, V (et-006a) | ET-006a (#13) | PR (tests job, `npm test`) | — |
| `tests/unit/runtime-receipt.test.ts` | Node unit (Vitest) | smoke evidence: REG-002, REG-006, REG-011, REG-012, REG-013, REG-014, REG-015, REG-016, REG-017 | T, V (et-022) | ET-022 (#7) | PR (tests job, `npm test`) | regression |
| `tests/unit/sample-buffer.test.ts` | Node unit (Vitest) | REG-007, REG-009 | R, F | ET-015b (#86) | PR (tests job, `npm test`) | gap |
| `tests/unit/scaffold.test.ts` | Node unit (Vitest) | REG-017 | R | ET-001 (#5) | PR (tests job, `npm test`) | — |
| `tests/unit/service-heartbeat.test.ts` | Node unit (Vitest) | REG-011 | R, F | ET-036 | PR (tests job, `npm test`) | regression |
| `tests/unit/service-probe.test.ts` | Node unit (Vitest) | REG-011 | F | ET-001 (#5) | PR (tests job, `npm test`) | regression |
| `tests/unit/service-supervisor.test.ts` | Node unit (Vitest) | REG-011, REG-012 | R, T | ET-001 (#5) | PR (tests job, `npm test`) | regression |
| `tests/unit/settings-schema.test.ts` | Node unit (Vitest) | REG-017 | R, F | ET-011b (#56) | PR (tests job, `npm test`) | — |
| `tests/unit/settings-store.test.ts` | Node unit (Vitest) | REG-017 | R, F | ET-011b (#56) | PR (tests job, `npm test`) | regression |
| `tests/unit/shutdown-sequence.test.ts` | Node unit (Vitest) | REG-011, REG-012 | R, T | ET-011a (#52); ET-038; ET-011 (#167) | PR (tests job, `npm test`) | regression |
| `tests/unit/simulator-v0.test.ts` | Node unit (Vitest) | REG-003 | R | ET-005a (#11) | PR (tests job, `npm test`) | gap |
| `tests/unit/simulator-v1-cap0-import.test.ts` | Node unit (Vitest) | REG-008, REG-009, REG-010 | R, F | ET-005b PR-3 | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-cap0-replay.test.ts` | Node unit/integration (Vitest, real pipes) | REG-001, REG-002, REG-008, REG-009 | R, F | ET-005b PR-3 | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-faults.test.ts` | Node unit (Vitest) | REG-005, REG-010 | R, F | ET-005b (#61) | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-pipe.test.ts` | Node unit (Vitest) | REG-003, REG-011 | R, F | ET-005b (#61) | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-reactive.test.ts` | Node unit (Vitest) | REG-011 | F | ET-005b (#61) | PR (tests job, `npm test`) | ACK |
| `tests/unit/simulator-v1-replay.test.ts` | Node unit (Vitest) | REG-001, REG-003 | R | ET-005b (#50) | PR (tests job, `npm test`) | dedup, gap |
| `tests/unit/simulator-v1-scenario.test.ts` | Node unit (Vitest) | REG-001, REG-009, REG-010, REG-011 | T | ET-005b (#50) | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-soak.test.ts` | Node unit (Vitest) | REG-010, REG-011, REG-018 | R, T, V (et-019) | ET-019 (PR-12a) | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-source.test.ts` | Node unit (Vitest) | REG-009 | R, F | ET-005b (#50) | PR (tests job, `npm test`) | — |
| `tests/unit/simulator-v1-store.test.ts` | Node unit (Vitest) | REG-005, REG-011 | R, F | ET-005b (#50) | PR (tests job, `npm test`) | ACK, gap |
| `tests/unit/soak-evidence.test.ts` | Node unit (Vitest) | smoke evidence: REG-001, REG-002, REG-003, REG-011, REG-018 | R, T, V (et-019) | ET-019 (PR-12b) | PR (tests job, `npm test`) | trip completeness |
| `tests/unit/soak-receipt.test.ts` | Node unit (Vitest) | smoke evidence: REG-011, REG-012, REG-014, REG-018 | R, T, V (et-019) | ET-019 (PR-12b) | PR (tests job, `npm test`) | ACK, gap |
| `tests/unit/speed-display.test.ts` | Node unit (Vitest) | REG-009, REG-012, REG-017 | R, T | ET-008 (#21) | PR (tests job, `npm test`) | — |
| `tests/unit/steam-discovery.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/steam-registry.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | security |
| `tests/unit/steam-vdf.test.ts` | Node unit (Vitest) | REG-015 | R, F, V (et-017) | ET-017 (PR-2) | PR (tests job, `npm test`) | — |
| `tests/unit/storage-client.test.ts` | Node unit (Vitest) | REG-007, REG-011, REG-014 | R | ET-013 (#60); ET-038 | PR (tests job, `npm test`) | ACK, regression |
| `tests/unit/storage-codec.test.ts` | Node unit (Vitest) | REG-009 | R | ET-013 (#51) | PR (tests job, `npm test`) | — |
| `tests/unit/storage-errors.test.ts` | Node unit (Vitest) | REG-007 | R | ET-013 (#51) | PR (tests job, `npm test`) | — |
| `tests/unit/storage-retention.test.ts` | Node unit (Vitest) | REG-007, REG-013 | V (et-013) | ET-013 (#51) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-boundaries.test.ts` | Node unit (Vitest) | REG-008, REG-009 | R | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-derived.test.ts` | Node unit (Vitest) | REG-008 | R, F | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-format.test.ts` | Node unit (Vitest) | REG-009 | F | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-gear-labels.test.ts` | Node unit (Vitest) | REG-009 | F | ET-050b (#188) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-live-view.test.ts` | Node unit (Vitest) | REG-002, REG-003, REG-009 | F | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-normalize.test.ts` | Node unit (Vitest) | REG-004, REG-009 | F | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-core-units.test.ts` | Node unit (Vitest) | REG-009 | F | ET-010a (#53) | PR (tests job, `npm test`) | — |
| `tests/unit/telemetry-service-v0.test.ts` | Node unit (Vitest) | REG-003, REG-007, REG-010, REG-011, REG-012 | R, F | ET-006a (#13) | PR (tests job, `npm test`) | security, regression |
| `tests/unit/test-resources.test.ts` | Node unit (Vitest) | harness: REG-001 to REG-014, REG-016, REG-017 (the scenarios of every case that imports `tests/shared/resources.ts`, directly or through `tests/storage/helpers.ts`) | R (shared fixtures note), V (et-022), importers | ET-022 (#7) | PR (tests job, `npm test`) | — |
| `tests/unit/tray-model.test.ts` | Node unit (Vitest) | REG-012 | R | ET-011a (#52) | PR (tests job, `npm test`) | — |
| `tests/unit/trip-accounting.test.ts` | Node unit (Vitest) | REG-001, REG-002, REG-003, REG-008, REG-012 | R, F | ET-014 (#72) | PR (tests job, `npm test`) | gap, trip completeness |
| `tests/unit/trip-identity.test.ts` | Node unit (Vitest) | REG-005, REG-008 | T, V (et-014) | ET-014 (#71) | PR (tests job, `npm test`) | dedup |
| `tests/unit/trip-recorder.test.ts` | Node unit (Vitest) | REG-001, REG-003, REG-004, REG-005, REG-006, REG-007, REG-009, REG-011 | R, F | ET-015a (#77) | PR (tests job, `npm test`) | ACK, dedup, gap, trip completeness |
| `tests/unit/trip-reducer-replay.test.ts` | Node unit (Vitest) | REG-005 | R, F | ET-014 (#71) | PR (tests job, `npm test`) | dedup, trip completeness |
| `tests/unit/trip-reducer.test.ts` | Node unit (Vitest) | REG-001, REG-002, REG-003, REG-004, REG-005, REG-006, REG-008, REG-012 | R, F | ET-014 (#71) | PR (tests job, `npm test`) | dedup, gap, trip completeness, regression |
| `tests/unit/trip-seeds.test.ts` | Node unit (Vitest) | REG-006, REG-012 | R | ET-015a (#75) | PR (tests job, `npm test`) | trip completeness, regression |
| `tests/unit/trip-simulator-replay.test.ts` | Node unit (Vitest) | REG-001, REG-003, REG-005, REG-006, REG-008 | R, F | ET-014 (#72) | PR (tests job, `npm test`) | gap, trip completeness |
| `tests/unit/unit-profiles.test.ts` | Node unit (Vitest) | REG-009, REG-012, REG-017 | R, T | ET-011b (#56) | PR (tests job, `npm test`) | — |
| `tests/unit/v1-durable-delivery.test.ts` | Node unit (Vitest) | REG-005, REG-006, REG-007, REG-011 | R, F | ET-006b (#64) | PR (tests job, `npm test`) | ACK, dedup, gap |
| `tests/unit/v1-ingestion-pipe.test.ts` | Node unit (Vitest) | REG-003, REG-005, REG-011 | R, F | ET-006b (#64) | PR (tests job, `npm test`) | ACK, dedup, gap |
| `tests/unit/v1-ingestion.test.ts` | Node unit (Vitest) | REG-003, REG-004, REG-005, REG-007, REG-010, REG-011 | R, F | ET-006b (#64) | PR (tests job, `npm test`) | ACK, security |
| `tests/unit/window-placement.test.ts` | Node unit (Vitest) | REG-016 | R | ET-007 (#14) | PR (tests job, `npm test`) | security |
| `tests/storage/backlog-redelivery.test.ts` | Storage (Vitest under Electron) | REG-011 | R, F | ET-015c (#88) | PR (tests job, `npm run test:storage`) | dedup, gap, regression |
| `tests/storage/backup-restore.test.ts` | Storage (Vitest under Electron) | REG-007, REG-013 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | historical fixture |
| `tests/storage/backup-sweep.test.ts` | Storage (Vitest under Electron) | REG-007, REG-013 | V (et-013) | ET-013 (#60) | PR (tests job, `npm run test:storage`) | regression |
| `tests/storage/client-socket.test.ts` | Storage (Vitest under Electron) | harness: REG-006, REG-011 | V (et-015a) | ET-015a (#84) | PR (tests job, `npm run test:storage`) | regression |
| `tests/storage/crash-recovery.test.ts` | Storage (Vitest under Electron) | REG-006 | R, F | ET-013 (#60) | PR (tests job, `npm run test:storage`) | ACK, dedup |
| `tests/storage/events-commit.test.ts` | Storage (Vitest under Electron) | REG-005, REG-006, REG-009 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | ACK, dedup, gap |
| `tests/storage/failures.test.ts` | Storage (Vitest under Electron) | REG-007 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | ACK |
| `tests/storage/fixtures.test.ts` | Storage (Vitest under Electron) | REG-005, REG-013 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | historical fixture |
| `tests/storage/journal-export.test.ts` | Storage (Vitest under Electron) | REG-014 | R, F | ET-016a (#101) | PR (tests job, `npm run test:storage`) | trip completeness |
| `tests/storage/journal-reads.test.ts` | Storage (Vitest under Electron) | REG-003, REG-009, REG-014 | R, F | ET-016a (#96) | PR (tests job, `npm run test:storage`) | gap, trip completeness, historical fixture |
| `tests/storage/journal-scale.test.ts` | Storage (Vitest under Electron) | REG-014 | R, F | ET-016a (#96) | PR (tests job, `npm run test:storage`) | — |
| `tests/storage/journal-service.test.ts` | Storage (Vitest under Electron) | REG-011, REG-012, REG-014 | R, F | ET-016a (#97) | PR (tests job, `npm run test:storage`) | — |
| `tests/storage/late-attach.test.ts` | Storage (Vitest under Electron) | REG-003 | R | ET-016b (#99) | PR (tests job, `npm run test:storage`) | dedup, trip completeness |
| `tests/storage/migration-crash.test.ts` | Storage (Vitest under Electron) | REG-006, REG-013 | R, F | ET-019 (PR-2) | PR (tests job, `npm run test:storage`) | historical fixture |
| `tests/storage/migrations.test.ts` | Storage (Vitest under Electron) | REG-013 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | historical fixture |
| `tests/storage/open-durability.test.ts` | Storage (Vitest under Electron) | REG-006, REG-007 | V (et-013) | ET-013 (#51) | PR (tests job, `npm run test:storage`) | ACK |
| `tests/storage/producer-loss.test.ts` | Storage (Vitest under Electron) | REG-003, REG-005, REG-007, REG-011, REG-014 | R, F, T, V (et-019) | ET-019 (PR-3) | PR (tests job, `npm run test:storage`) | ACK, dedup, gap, trip completeness |
| `tests/storage/recording-runtime.test.ts` | Storage (Vitest under Electron) | REG-003, REG-005, REG-006, REG-010, REG-011, REG-012 | R, F | ET-015c (#89), ET-056 | PR (tests job, `npm run test:storage`) | ACK, gap |
| `tests/storage/recording-status.test.ts` | Storage (Vitest under Electron) | REG-002, REG-003, REG-006, REG-007, REG-011 | R, F | ET-015c (#90) | PR (tests job, `npm run test:storage`) | gap |
| `tests/storage/recording-target.test.ts` | Storage (Vitest under Electron) | REG-007 | R, F | ET-015a (#79) | PR (tests job, `npm run test:storage`) | — |
| `tests/storage/replay-journal-export.test.ts` | Storage (Vitest under Electron) | REG-003, REG-004, REG-005, REG-008, REG-014 | R, F, T, V (et-019) | ET-019 (PR-5) | PR (tests job, `npm run test:storage`) | ACK, gap, trip completeness |
| `tests/storage/break-not-recorded.test.ts` | Storage (Vitest under Electron) | REG-003, REG-005, REG-009, REG-014 | R, F | ET-052 PR-4 | PR (tests job, `npm run test:storage`) | — |
| `tests/storage/sample-recorder.test.ts` | Storage (Vitest under Electron) | REG-001, REG-002, REG-003, REG-005, REG-009, REG-012 | R, F | ET-015b (#86) | PR (tests job, `npm run test:storage`) | gap |
| `tests/storage/samples.test.ts` | Storage (Vitest under Electron) | REG-005, REG-009 | R, F | ET-013 (#51) | PR (tests job, `npm run test:storage`) | dedup |
| `tests/storage/schema-constraints.test.ts` | Storage (Vitest under Electron) | REG-013 | R | ET-013 (#51) | PR (tests job, `npm run test:storage`) | historical fixture |
| `tests/storage/shutdown-stalls.test.ts` | Storage (Vitest under Electron) | REG-006, REG-011, REG-012 | F, T, V (et-019) | ET-019 (PR-4); ET-038; ET-011 (#167) | PR (tests job, `npm run test:storage`) | ACK, dedup, gap, trip completeness |
| `tests/storage/trip-accounting-effects.test.ts` | Storage (Vitest under Electron) | REG-001, REG-008 | R | ET-014 (#72) | PR (tests job, `npm run test:storage`) | trip completeness |
| `tests/storage/trip-effects.test.ts` | Storage (Vitest under Electron) | REG-001, REG-003, REG-004, REG-005, REG-006, REG-008, REG-013 | R, F | ET-014 (#71) | PR (tests job, `npm run test:storage`) | dedup, trip completeness |
| `tests/storage/trip-recorder-crash.test.ts` | Storage (Vitest under Electron) | REG-005, REG-006, REG-012 | R, F, T, V (et-019) | ET-015a (#77); ET-019 (PR-1) invariants, kill rows and seeded campaign | PR (tests job, `npm run test:storage`); Extended campaigns workflow (200 seeds) | ACK, dedup, gap, trip completeness |
| `tests/storage/trip-recorder-faults.test.ts` | Storage (Vitest under Electron) | REG-007, REG-011 | R, F | ET-015a (#77) | PR (tests job, `npm run test:storage`) | ACK |
| `tests/storage/trip-recorder.test.ts` | Storage (Vitest under Electron) | REG-001, REG-003, REG-004, REG-005, REG-006, REG-007, REG-009 | R, F | ET-015a (#77) | PR (tests job, `npm run test:storage`) | ACK, dedup, trip completeness |
| `tests/storage/trip-recovery-reads.test.ts` | Storage (Vitest under Electron) | REG-006, REG-008, REG-012 | R | ET-015a (#75) | PR (tests job, `npm run test:storage`) | trip completeness |
| `tests/storage/v1-durable-ingestion.test.ts` | Storage (Vitest under Electron) | REG-003, REG-005, REG-006, REG-007 | R, F | ET-006b (#64) | PR (tests job, `npm run test:storage`) | ACK, dedup, gap |
| `tests/storage/v1-ingestion-crash.test.ts` | Storage (Vitest under Electron) | REG-006 | R, F | ET-006b (#64) | PR (tests job, `npm run test:storage`) | ACK, dedup |
| `tests/storage/worker.test.ts` | Storage (Vitest under Electron) | REG-005, REG-006, REG-007, REG-014 | R, F | ET-013 (#60) | PR (tests job, `npm run test:storage`) | ACK, regression |
| `tests/integration/cap0-chain.test.ts` | Integration chain (Vitest) | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | T, V (cap-01a) | CAP-01a (#26) | PR (scaffold job) | security, v0/CAP0 isolation |
| `tests/integration/v1-chain.test.ts` | Integration chain (Vitest) | REG-003, REG-005, REG-010, REG-011 | T, V (et-006b) | ET-006b (#68) | PR (scaffold job) | ACK, security |
| `tests/integration/v1-chain-process-death.test.ts` | Integration chain (Vitest) | REG-003, REG-011 | R, F, T, V (et-019) | ET-019 (PR-8), extended by ET-033 and ET-034 | PR (scaffold job, `npm run test:v1-chain`) | gap, security |
| `tests/integration/plugin-image-lock.test.ts` | Integration (Vitest, fake SDK host) | REG-015 | R, F, T, V (et-017) | ET-017 (PR-3) | PR (scaffold job, `npm run test:plugin-lock`) | security |
| `tests/electron/startup.spec.ts` | Playwright Electron | REG-017 | T, V (et-001) | ET-001 (#5) | manual (`npm run test:electron`); kept by owner decision Q2 of October 17, 2026 | security |
| `tests/measurement/storage-size.measure.ts` | Measurement (Vitest under Electron) | REG-018 (size only) | F, V (et-013) | ET-013 (#60) | manual (`npm run measure:storage`) | — |

### Native CTest families

From `ctest -N` on the four build trees at ET-019t: 75 cases in the plugin Release tree `native/telemetry-plugin/build` (the ET-001 `placeholder-contract` case was removed), 53 in the client Release tree `native/telemetry-client/build`, 70 selected by `-R asan-contract` in the plugin tree `build-asan` and 53 selected by `-R '^native-pipe-client-asan-'` in the client tree `build-asan`. Every case writes its result to the job's CTest JUnit file.

| Entry point | Layer | REG IDs | Source | Owning card (PR) | Runs in | Protected |
| --- | --- | --- | --- | --- | --- | --- |
| `protocol-v0-contract` | Native CTest, plugin | REG-003, REG-005, REG-009, REG-010 | T, V (et-002a) | ET-002a (#9) | PR (scaffold job) | — |
| `protocol-v1-contract` | Native CTest, plugin | REG-003, REG-004, REG-005, REG-006, REG-009, REG-010, REG-011 | R, T | ET-002b (#43) | PR (scaffold job) | ACK, dedup, gap |
| `v1-producer-contract-{store,release,retention,overflow,encoding,messages,streams,randomized,fuzz}` | Native CTest, plugin | REG-003, REG-005, REG-006, REG-007, REG-009, REG-010, REG-011 | R, T | ET-004b (#47) | PR (scaffold job); Extended campaigns workflow: the `fuzz` case at x50 | ACK, dedup, gap |
| `sdk-adapter-contract` | Native CTest, plugin | REG-004, REG-008, REG-009, REG-010, REG-011 | R | ET-003 (#10) | PR (scaffold job) | gap |
| `sdk-adapter-contract-gearbox`, `v1-producer-contract-gearbox`, `v1-transport-contract-gearbox` and their ASan twins `*-asan-contract-gearbox` | Native CTest, plugin (ASan twins in the AddressSanitizer job) | REG-005, REG-009, REG-010 | R, T | ET-050b (#190) | PR (scaffold job; AddressSanitizer job) | v0/CAP0 isolation |
| `event-channel-contract-{ring,gate,loss-runs,flush,concurrency,exhaustion}` | Native CTest, plugin | REG-003, REG-004, REG-005, REG-006, REG-007, REG-009, REG-011 | R | ET-004b (#48) | PR (scaffold job) | gap |
| `sdk-exports-contract` | Native CTest, plugin | REG-017 (shipped plugin artifact integrity); supports REG-015, which is partial since ET-017 PR-1 | V (et-003), ET-019t review | ET-003 (#10) | PR (scaffold job) | security |
| `snapshot-transport-contract-*` (13 cases) and `snapshot-transport-dll-contract` | Native CTest, plugin | REG-003, REG-005, REG-010, REG-011 | R | ET-004a (#12) | PR (scaffold job); Extended campaigns workflow: the `fuzz` case at x50 | security, regression |
| `snapshot-transport-reporting-contract`, `snapshot-transport-late-reporting-contract` | Native CTest, plugin | REG-011 | R, V (et-004-startup-budget) | ET-004a (#12) | PR (scaffold job) | regression |
| `snapshot-transport-window-contract`, `-window-dll-contract`, `-window-reporting-contract` | Native CTest, plugin | REG-011, REG-016 | R | ET-007 (#14) | PR (scaffold job) | security |
| `game-window-monitor-contract`, `game-window-monitor-contract-slow-peer` | Native CTest, plugin | REG-011, REG-016 | V (et-007) | ET-007 (#14) | PR (scaffold job) | regression |
| `capture-cap0-contract-*` (16 cases) and `capture-cap0-dll-contract` | Native CTest, plugin | REG-004, REG-005, REG-007, REG-009, REG-010, REG-011 | R | CAP-01a (#26) | PR (scaffold job) | gap, v0/CAP0 isolation |
| `v1-transport-contract-*` (17 cases) and `v1-transport-dll-contract` | Native CTest, plugin | REG-003, REG-004, REG-005, REG-006, REG-007, REG-010, REG-011 | R, T | ET-004b (#54) | PR (scaffold job); Extended campaigns workflow: the `fuzz` case at x50 | ACK, dedup, gap, security, v0/CAP0 isolation |
| `channel-identity-contract` | Native CTest, plugin | REG-015, REG-017 (production native names unchanged; no name shared with staging) | F | ET-055 PR-2 | PR (scaffold job) | regression |
| `two-plugin-host-contract` (prints per-callback time per plugin as an observation, no threshold) | Native CTest, plugin | REG-011, REG-015 (both channels' plugins serving in one process) | F | ET-055 PR-2 | PR (scaffold job) | security, v0/CAP0 isolation |
| `native-pipe-client-discover-*`, `native-pipe-client-asan-discover-*` | Native CTest, client Release/ASan | REG-003, REG-010, REG-011 | R, T | ET-056 | PR (scaffold and AddressSanitizer jobs) | security, endpoint-free discovery, stale identity |
| `native-pipe-client-*` (72 cases, including discovery, CAP0 and protocol v1 broker modes) | Native CTest, client | REG-003, REG-005, REG-010, REG-011 | R, T | ET-006a (#13), extended by CAP-01a, ET-006b and ET-033 | PR (scaffold job) | security, v0/CAP0 isolation |
| `*-asan-contract*` (70 cases): the AddressSanitizer twins of the protocol v0 and v1, producer, adapter, event channel, snapshot transport, window, CAP0 and v1 transport cases | Native CTest, plugin ASan | as their Release twins | R, T | the twins' cards | PR (AddressSanitizer job) | as their Release twins |
| `native-pipe-client-asan-*` (72 cases) | Native CTest, client ASan | as `native-pipe-client-*` | R | ET-006a (#13) and later | PR (AddressSanitizer job) | security, v0/CAP0 isolation |

### PowerShell suites

| Entry point | Layer | REG IDs | Source | Owning card (PR) | Runs in | Protected |
| --- | --- | --- | --- | --- | --- | --- |
| `tests/watchdog/run.ps1` | Windows Job Object fixtures | REG-011 | R, T | ET-001 (#5) | Extended (`scripts/ci/Invoke-Extended.ps1`) | regression |
| `tests/windows/Test-UninstallResidue.ps1` | Windows uninstall residue fixtures | REG-017 | T | ET-001 (#5) | Extended (`scripts/ci/Invoke-Extended.ps1`) | — |
| `tests/windows/Test-DeferredCleanup.ps1` (fixture `tests/fixtures/uninstall/deferred-cases.json`) | The deferred-cleanup executor under Windows PowerShell 5.1 on temporary test-root scenes, started as Windows starts a RunOnce entry, with its own per-run test key, deleted afterwards | REG-015, REG-017 | T, V (et-018) | ET-018 (PR-5) | Extended (`scripts/ci/Invoke-Extended.ps1`) | security |
| `scripts/installer/Invoke-InstallerLifecycle.ps1` (driver `installer-lifecycle.mjs`) | Installer lifecycle in a test root: install, repair, update, installed smokes, data launches; since PR-3 the Windows-initiated uninstall scenarios (complete, deferred, reinstall and adoption); since PR-5 the registered deferred-cleanup executor run as at sign-in (blocked, then complete); since ET-045g the Installed apps icon after every install, repair and update, a planted legacy icon replaced by the update, and the shell pixel comparison of both icons | REG-013, REG-015, REG-017 | T, V (et-018) | ET-018 (PR-1, PR-3, PR-5); ET-045g | main push and dispatch (scaffold job, step "Installer lifecycle in a test root"); refuses local runs without `-AllowLocal`, which only an owner request allows | historical fixture, security |
| `tests/windows/Invoke-NativeInstallerAcceptance.ps1`, `native-installer-step.ps1` | Retired ET-001 real-root installer harness; `-Run` throws `RETIRED_ET018_REAL_ROOTS` | REG-017 (historical) | T, V (et-018) | ET-001 (#5), retired by ET-018 (PR-1) | Never | — |
| `tests/vm/Test-InstallerController.ps1`, `Test-InstallerConsoleCustody.ps1`, `Test-InstallerDriverProvenance.ps1`, `Test-InstallerHelperProvenance.ps1` | Installer harness controls | REG-017 (historical provenance) | T, V (et-001) | ET-001 (#5) | Manual | — |
| `tests/package-integrity/read.ps1`, `path-regression.ps1` | Package fingerprint fixtures | REG-017 | R, T | ET-001 (#5), ET-022 (#7) | PR (tests job, through `tests/unit/package-integrity.test.ts`) | security |

### Runtime smokes and CLI smokes

Each runtime smoke scenario runs once per mode through `./scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode development` or `-Mode packaged` in the scaffold job ([ci](ci.md#bounded-runtime-checks)). By owner decision E2 of October 17, 2026, pull requests run only the packaged mode; pushes to `main` and every dispatch run both modes ([ci](ci.md#et-019t-speed-up-october-17-2026)).

| Entry point | Layer | REG IDs | Source | Owning card (PR) | Runs in | Protected |
| --- | --- | --- | --- | --- | --- | --- |
| scenario `scaffold`, development and packaged | Electron runtime smoke | REG-011, REG-015, REG-017 | R, T | ET-001 (#5), ET-022 (#7), extended by ET-017 PR-5 (disabled plugin card) and PR-6 (diagnosis line, export button) | PR: packaged mode; main push and dispatch: both modes (scaffold job) | security |
| scenario `telemetry`, development and packaged | Electron runtime smoke | REG-003, REG-009, REG-010, REG-011, REG-016 | R, T | ET-006a (#13), extended by ET-010b/c | PR: packaged mode; main push and dispatch: both modes (scaffold job) | security, regression |
| scenario `overlay` (`-ForceRendererReuse`), development and packaged | Electron runtime smoke | REG-009, REG-011, REG-016, REG-017 | R | ET-008 (#21), extended by ET-012a-d | PR: packaged mode; main push and dispatch: both modes (scaffold job) | security, regression |
| scenario `lifecycle`, development and packaged | Electron runtime smoke | REG-011, REG-012, REG-017 | R, T | ET-011a (#52) | PR: packaged mode; main push and dispatch: both modes (scaffold job) | — |
| scenario `recording`, development and packaged | Electron runtime smoke | REG-001, REG-002, REG-006, REG-012, REG-014, REG-017 | R, T | ET-015a (#82), extended by ET-015b/c and ET-016 | PR: packaged mode; main push and dispatch: both modes (scaffold job) | ACK, dedup, gap, trip completeness |
| scenario `journal`, development and packaged | Electron runtime smoke | REG-009, REG-014, REG-017 | R, T | ET-016a (#98) | PR: packaged mode; main push and dispatch: both modes (scaffold job) | trip completeness |
| scenario `refusal`, development and packaged | Electron runtime smoke | REG-013, REG-014, REG-017 | R, T | ET-019 (PR-7) | PR: packaged mode; main push and dispatch: both modes (scaffold job) | historical fixture |
| scenario `plugin`, development and packaged | Electron runtime smoke | REG-015, REG-017 | R, T | ET-017 PR-5, extended by PR-6 (diagnostics export) | PR: packaged mode; main push and dispatch: both modes (scaffold job) | security |
| mode `installed` (`-Executable <binary root>app-<version>ETS2TelemetryDesktop.exe`): scenarios `scaffold` on 0.1.0 and `scaffold`, `plugin`, `telemetry` on 0.1.1 by default | Electron runtime smoke of an installed copy (minimal PATH, unrelated working directory) | REG-017, and the scenarios' own REG IDs | T, V (et-018) | ET-018 (PR-1) | main push and dispatch, inside the installer lifecycle step (scaffold job) | as the scenarios |
| `npm run smoke --workspace @ets2telemetry/telemetry-simulator` (v0 CLI pipe smoke) | Simulator CLI | REG-003, REG-010 | R | ET-005a (#11) | PR (scaffold job) | — |
| `npm run smoke:v1 --workspace @ets2telemetry/telemetry-simulator` (v1 CLI pipe smoke, lockstep and reactive) | Simulator CLI | REG-003, REG-005, REG-011 | R, T | ET-005b (#61) | PR (scaffold job) | — |
| scenario `soak` (`-SoakMinutes <1-90>`), development and packaged, under `BoundedProcess.RunExtended` | Electron runtime smoke, real time | REG-001, REG-002, REG-003, REG-011, REG-012, REG-014, REG-018 | R, T, V (et-019) | ET-019 (PR-12b) | Soak workflow (`Windows x64 recording soak`, target `application`, packaged mode) | ACK, gap, trip completeness |
| `scripts/ci/Invoke-SoakSource.ps1` (`smoke-soak-v1` under `BoundedProcess.RunExtended`) | Simulator CLI soak, real time | REG-011, REG-018 | R, T, V (et-019) | ET-019 (PR-12a) | Soak workflow (`Windows x64 recording soak`) | — |

### Index findings

- **Mapped by the ET-019t review.** No record named a scenario for two entry points, so the review mapped them from what they guard. `tests/unit/test-resources.test.ts` tests the shared helper `tests/shared/resources.ts` (unique temporary directories and pipe names, deterministic clocks); its importers are `capture-export`, `capture-session`, `capture-writer`, `journal-export-writer`, `overlay-smoke-source`, `runtime-receipt`, `settings-store` and, through `tests/storage/helpers.ts`, the storage suite, so it is a harness for REG-001 to REG-014, REG-016 and REG-017. `sdk-exports-contract` checks that the production plugin DLL exports exactly the SCS entry points and none of the test seams, which is packaged-artifact integrity (REG-017); the plugin DLL management that REG-015 requires will install that artifact, so the check supports REG-015 while REG-015 itself stays pending. Neither was deleted.
- **Installer tests map to REG-017, not REG-015.** The ET-019t plan proposed REG-015/017 for `tests/unit/installer-*.test.ts`. TESTING-HISTORY.md (the ET-001 table) and ET-001 validation record them as provenance proofs of the ET-001 installer acceptance harness, which is partial REG-017 evidence. They do not exercise plugin DLL management.
- **No same-title, same-layer duplicate.** The only case title repeated within a layer is the `bounded framing` describe block of `protocol-v0.test.ts` and `protocol-v1.test.ts`, which test different protocols.
- **Coverage gaps, report only.** REG-015 had no executable test; ET-017 PR-1 added partial bundle-identity protection (`plugin-bundle-stage.test.ts`), and PR-2 partial discovery and folder-validation protection (`steam-vdf`, `steam-discovery`, `game-folder`, `steam-registry` and `game-processes`, with the `guarded-fs` harness), and PR-3 partial installer and registry protection (`plugin-registry`, `plugin-installer` and the `plugin-image-lock` integration check). REG-018 covers database size only. REG-002 still has its trip-level pause outcome pending. REG-012, REG-014 and REG-016 keep runtime-only gaps: the real notification area, the real Save dialog and real-game overlay behavior.
- `tests/electron/startup.spec.ts` stays: the owner decided on October 17, 2026 (Q2) to keep it and `npm run test:electron`, although the `scaffold` runtime smoke covers similar ground ([ET-019t validation](validation/et-019t.md)).
