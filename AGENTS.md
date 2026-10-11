# Agent Instructions

## Start Here

Read [concept.md](concept.md) before planning or implementing changes. It contains the product requirements, architecture baseline, implementation sequence, acceptance criteria, and research sources. Read [TESTING.md](TESTING.md) before changing behavior or test infrastructure. This file contains repository-wide working instructions and a compact handoff.

Keep the two documents consistent. Use `concept.md` for detailed product decisions and this file for instructions that apply across tasks. Explicit user instructions take precedence over this documentation.

When the owner requests an implementation coordinator, also read [COORDINATOR.md](COORDINATOR.md). It defines Trello execution, bounded subagent delegation, worktree ownership, independent review, recovery state, and PR handoff. Use the [launch prompt](docs/prompts/coordinator-start.md) to start that role in a separate chat. This role applies only when requested; delegated workers follow their bounded assignments and the repository rules.

## Documentation Language

**Write all internal documentation that may be committed to Git in English.** This is an explicit owner requirement.

It applies to Markdown files, agent instructions, plans saved in the repository, architecture notes, decision records, setup guides, API documentation, and explanatory code comments/docstrings. New documents and edits to existing documents must follow this rule.

Continue conversation with the owner in their preferred language, currently Russian. The documentation rule does not select the product's UI language. Preserve proper names, external identifiers, localized game data, and test fixtures where their original values matter.

## Current Project State

At the initial handoff on October 10, 2026:

- The repository directory contains documentation only. No application, plugin, server, or test suite has been implemented.
- The initial directory was not a Git repository. Inspect the current state before using Git commands; do not assume this remains true after later work.
- The working environment is Windows with PowerShell. No development toolchain installation has been verified.
- No package manager, dependency versions, build scripts, or CI workflows have been established.
- Research covered the official SCS SDK 1.15 archive and relevant Electron, Node.js, and TruckersMP documentation.
- Compatibility, overlay behavior, latency, and game performance have not been tested in a running game.
- The SQLite storage estimate was measured using a synthetic in-memory model, not the product.

Treat this as a dated baseline, inspect actual files on each task, and update this section when implementation changes the project state. Do not invent existing commands, implemented features, or successful checks.

Git setup update on October 10, 2026:

- The local directory is now a Git repository. Local `main` tracks the existing `origin/main` history, including its original README.
- The `origin` remote is `https://github.com/senukartur/ets2telemetry.git`.
- Git for Windows 2.55.0.windows.5 with Git Credential Manager 2.9.1 is installed at `C:\Program Files\Git\cmd\git.exe`. The Codex runtime also provides Git 2.53.0.windows.3. GitHub CLI 2.102.0 is installed at `C:\Program Files\GitHub CLI\gh.exe`.
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The repository is private and the authenticated account has admin permission.
- The repository-local commit identity is `Artur Sianiuk <15032912+senukartur@users.noreply.github.com>`. Pulls require a fast-forward (`pull.ff=only`), and pushes use `push.default=simple`.
- Fetch, `git pull --ff-only`, and the initial documentation push succeeded. The published documentation includes `README.md`, `AGENTS.md`, and `concept.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`; do not commit it.
- Use Git for local history and synchronization, and GitHub CLI for pull requests and GitHub checks. A GitHub MCP server is not required for this workflow.
- The application and native development toolchains remain unverified.
- GitHub allows only squash merging and automatically deletes merged task branches. Squash commits use the PR title and body.
- GitHub returned HTTP 403 for branch protection and rulesets because this private repository requires an upgraded plan for those features. PR-only changes to `main` are an owner policy, reinforced by the local pre-push hook; they are not currently enforced on the server. No required CI checks exist yet.

Coordinator documentation update on October 10, 2026:

- [COORDINATOR.md](COORDINATOR.md) and the [launch prompt](docs/prompts/coordinator-start.md) define the optional owner-requested coordinator role. Local recovery state lives under ignored `.local/`.
- This documentation does not implement an application, configure Trello access, start agents, or add CI. Inspect current implementation and integration availability before running the coordinator.

## Product Requirements to Preserve

ET-001 scaffold update on October 11, 2026: pinned Node 24.19.0/npm 11.17.0 workspaces, secure React/Electron window, utilityProcess-owned isolated SQLite worker probe, Forge packaging and C++17 x64 placeholder DLL are implemented. Typecheck, 118 Node tests, clean dependency installation, native build/CTest, maker/static inspection and bounded process controls passed on the corresponding frozen inputs. Native install, repair, update, two installed worker/security smokes and uninstall completed normally; composite acceptance includes the separately reviewed corrected uninstall predicate and exact owned cleanup. The original failed wrapper report and an unexplained Playwright launch timeout remain recorded. Independent whole-PR review at 8aa8991 found no actionable issues; final verifier/documentation delta confirmation is recorded separately. Native Windows launches are owner-authorized and no further VM run is required. See [setup](docs/setup.md) and [validation](docs/validation/et-001.md). No protocol, SDK adapter, production history, overlay, CI or game compatibility is established. Longer stability and host-freeze resolution remain unproven. Entries above are dated historical baselines.

ET-022 candidate update on October 11, 2026: Windows CI has actual clean and restored hosted passes with 122 Node tests, placeholder native CTest, Forge make/static inspection and both bounded SQLite-worker smokes. A deliberate assertion failed the intervening job, then was removed. Whole-job times were 199/200 seconds. Earlier real hosted failures and local Electron flakiness remain recorded in [ET-022 validation](docs/validation/et-022.md). Final current-head checks, independent review and owner merge are still required; no game or production-history acceptance follows from CI success.

- Build an ETS2 and ATS telemetry utility for a virtual trucking company.
- Target Windows x64 first. TruckersMP compatibility is required; validate single-player and Convoy as well.
- The MVP is local and works without an account or internet connection: live telemetry, an overlay, a trip journal, and one-second samples.
- Support windowed and borderless fullscreen overlays. Exclusive fullscreen, rendering hooks, and arbitrary game memory reads are outside the MVP.
- Keep website development, accounts, company permissions, server synchronization, and online reporting in the later server phase.
- Visual design is deferred. Start with a functional, readable UI.
- The owner knows React and TypeScript and is new to desktop development. Explain unfamiliar native and desktop concepts clearly.

ET-002a acceptance update on October 11, 2026: Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

## Architecture Baseline

| Area | Working choice |
| --- | --- |
| Desktop and UI | Electron, React, TypeScript, Vite |
| Game integration | Project-owned C++17 DLL using the official SCS Telemetry SDK; CMake and MSVC |
| Local transport | Windows Named Pipes |
| Persistence | SQLite through better-sqlite3 in a dedicated worker |
| Process supervision | Electron main supervises a telemetry utilityProcess that owns the storage worker |
| Packaging | Electron Forge |
| Validation | Vitest, CTest for native executables, Playwright, simulation/replay, and actual game sessions |
| Later server direction | Node.js, TypeScript, Fastify, PostgreSQL, React |

The ET-001 scaffold pins dependencies and defines process boundaries; consult [docs/setup.md](docs/setup.md) and actual check evidence for installed and verified tooling. Distinguish SDK archive versions from API versions and game versions.

Keep telemetry processing and trip accounting separate from React components so they can be tested without the UI. Keep the plugin, application transport, persistence, and overlay responsibilities distinct. Expose narrow typed interfaces across boundaries.

## Implementation Constraints

### Game Integration and Transport

- Keep SDK callbacks short. Copy data in callbacks; perform serialization and transport work on a background thread.
- Call SCS APIs only in the callback context allowed by the SDK. Never call them from the transport worker.
- A missing or slow application must not stall the game. Bound buffers and report event gaps rather than silently treating incomplete data as complete.
- Version the protocol and preserve session identity and message ordering. Validate incoming messages and document the wire format alongside implementation.
- Coalesce live snapshots when appropriate. Preserve gameplay events separately, acknowledge them after persistence, and handle redelivery without duplicates.
- Restrict pipes to the local user and reject remote access.
- Install the DLL in the selected game's `bin/win_x64/plugins` directory. Change it only while the game is closed, and manage only this project's plugin.
- Use real game tests to establish TruckersMP support. Do not infer compatibility solely from successful single-player tests or documentation.

### Overlay and Electron

- Use a transparent window that passes mouse input to the game and does not steal focus while driving.
- Track the game window and hide the overlay when the game is minimized or another application is foreground. Account for monitor and DPI changes.
- Keep the display update target of up to **20 Hz** separate from the history sampling rate of **1 Hz**.
- Use context isolation, sandboxed renderers, and a narrow preload/IPC API. Do not give React direct Node.js or filesystem access.
- Closing the main window must not silently end recording. Full application exit must be explicit.

### Data Integrity and Storage

- Store the database under `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, resolved at runtime, separately from application binaries.
- Preserve data across application updates and use schema migrations. The MVP has no automatic history deletion.
- Store trip summaries, gameplay events, and samples separately. Prefer numeric internal references in sample rows, keeping stable UUIDs in entity records.
- Generate project-owned record IDs. Do not assume the game exposes a globally unique job ID.
- Distinguish unavailable values from zero, real time from game time, planned distance from observed/delivered distance, and expected income from actual revenue.
- Record one sample per real second during active simulation, including road stops. Represent pauses as events without adding duplicate paused samples.
- Keep completion status separate from recording completeness. Missing job configuration alone does not prove delivery; ambiguous continuations must not be merged automatically.
- Handle late attachment, reconnection, save loading, timer resets, truck changes, and refueling explicitly. Do not fabricate data for missing intervals.
- Convert SDK average consumption from liters/km to liters/100 km for display. Do not equate it with a trip-specific average without a defined calculation.
- Treat game-world coordinates as game coordinates, not latitude/longitude.
- Keep synthetic/replay data distinguishable from real history.

The working storage allowance is about **100 MB per 100 hours** at 1 Hz (estimated range: 60-120 MB). Re-measure once the actual schema exists; do not present this as a guaranteed limit.

## Git Workflow

Use lightweight GitHub Flow: `main` -> task branch -> pull request -> validation and owner review -> squash merge. Do not create a permanent `develop` branch.

### Branches and Scope

- Never implement work or make ordinary commits directly on `main`. Start new tasks from an updated `main` using `git pull --ff-only`; inspect status first and preserve unrelated local work.
- Use one short-lived branch for one coherent task: `feat/<description>`, `fix/<description>`, `docs/<description>`, or `chore/<description>`. Use lowercase English names with hyphens. Reuse the existing task branch when continuing the same task.
- Keep PRs small enough to review independently. Update both plugin and application in the same PR when a shared protocol change requires coordinated compatibility.
- Keep `main` buildable and compatible as implementation progresses. Working in a task branch does not waive the product's acceptance criteria.
- Never commit the ignored temporary Trello planning manifest.

### Commits and Pull Requests

- Write commit messages, PR titles, and PR descriptions in English. Use descriptive prefixes such as `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, or `test:`.
- Commit and push the task branch, then open a PR targeting `main`. Use a draft PR for unfinished work. Implementation requests authorize the normal branch, commit, push, and PR workflow unless the owner specifies otherwise.
- Follow `.github/pull_request_template.md`. Explain the problem and resulting behavior, report checks actually performed, and identify remaining verification. Do not claim that CI or game testing passed when it did not run.
- Attach the created PR to the Codex chat when the app provides an attachment tool, and provide the PR link to the owner.
- The owner reviews and merges PRs by default. The agent may merge only when the owner explicitly requests or authorizes it; do not infer merge authorization from a request to implement a task or open a PR.
- Merge with **Squash merge** after relevant checks pass and review feedback is resolved. A PR becomes one descriptive commit on `main`; the task branch is deleted after merging.
- After a merge, update local `main` with `git pull --ff-only` before starting the next task. Confirm the PR is merged before deleting a local task branch; preserve any remaining work.

### History and Local Guard

- Do not push directly to `main`, force-push `main`, delete `main`, or bypass the local hook during normal work. Rewrite published history only when the owner explicitly authorizes that specific operation. Use an explicit expected remote commit with `--force-with-lease` for an authorized rewrite.
- Fix merged mistakes through a new PR or a revert PR. Avoid rewriting shared history for ordinary corrections.
- Enable the tracked hook in each checkout with `git config --local core.hooksPath .githooks`. The current checkout is configured this way. Git for Windows includes the shell used by the hook.
- `.githooks/pre-push` rejects direct updates or deletion of remote `main`; GitHub PR merging is unaffected. This local guard can be bypassed and does not replace server-side branch protection. Do not bypass it unless necessary for a specifically authorized exception.
- If server-side protection becomes available, require PRs, linear history, resolved review conversations, and passing existing CI checks; block force pushes and branch deletion. Do not invent required check names or require a second-account approval in the current single-owner setup.

### Validation and Releases

- Add build, type, and test checks when the corresponding tooling is scaffolded. Until then, perform appropriate local document checks and state that CI is not configured.
- Test changed telemetry logic through simulation/replay. Validate integration and overlay behavior in actual games when required by the milestone; record versions and display modes. Passing automated checks alone does not establish TruckersMP support.
- Mark tested releases with version tags such as `v0.1.0-alpha.1` or `v1.0.0`, and include release artifacts and game validation results when available. A merge alone does not publish a release. Create or publish releases only when authorized by the owner.

## Workflow and Verification

Work on the milestone requested by the user. Routine implementation decisions within the agreed requirements do not require repeated confirmation. Discuss changes to product requirements or major architecture before committing to them.

The first implementation milestone is a complete path from game telemetry to a working speed/fuel overlay in both games, including TruckersMP. Subsequent milestones add application behavior, reliable recording, and distribution. Follow the sequence and acceptance criteria in `concept.md`.

Follow [TESTING.md](TESTING.md) for regression scenarios, test layers, CI/merge policy, and real-game evidence. ET-001 establishes scaffold tests; ET-022 establishes CI, while ET-019 adds broader recovery coverage later. Neither task replaces tests owned by each implementing card. ET-022 provides a Windows x64 workflow and bounded scaffold runtime checks; clean hosted execution and deliberate failure/restoration are recorded in [ET-022 validation](docs/validation/et-022.md). Final current-head checks, independent review and owner merge remain required. Broader feature regression suites remain pending.

- Include appropriate behavior tests in the same PR as a feature; retain a reproducing regression test for bug fixes where feasible. Explain justified omissions. Do not add redundant implementation-mirroring tests or application tests for documentation-only edits.
- Use deterministic fixtures and controlled clocks for domain logic; use actual Windows pipes, temporary SQLite files, and the storage worker for integration boundaries. Keep all test data isolated from real user history and game files.
- Preserve historical migration fixtures and explicit expectations for trip completion/completeness, event deduplication, durable ACKs, and missing intervals. Update the scenario-to-test registry as components are implemented.
- A failing existing baseline suite blocks acceptance. Check the current PR commit and run extra migration, packaging, native, or real-game checks when the change affects those boundaries. Current repository limitations mean the owner enforces this merge policy; do not claim server-side required checks exist.
- Report flaky outcomes and pending manual checks honestly. Do not silently skip critical tests, replace expected values merely to accept changed behavior, or treat retries/coverage percentages as proof of correctness.

- Inspect the actual project state before choosing commands or editing files. Prefer `rg` for searches.
- Use PowerShell-safe quoting and literal paths. Avoid Unix-only command assumptions in development instructions.
- Add documented setup/build/test commands when the corresponding tooling exists; do not document placeholders as working commands.
- Run checks appropriate to the change. For documentation-only work, inspect content, links, and Markdown structure; do not scaffold application tests.
- For telemetry logic, test units, lifecycle events, duplicates, missing data, and discontinuities using simulation/replay.
- For integration, record the tested game/client versions and display mode. Test both games, the required multiplayer modes, launch order, reconnects, and overlay behavior.
- Measure resource usage and frame-time impact during real sessions. The 200 ms display latency goal is a target until measured.
- If a required game or tool is unavailable, report exactly what was checked and what remains unverified.
- Keep changes focused and preserve unrelated work. Update the relevant documentation when requirements, interfaces, setup, or implementation status change.

Consult the primary sources linked in `concept.md` when validating SDK or framework behavior. Examples of other telemetry utilities may help, but receiving them from the owner is not a prerequisite for implementation.

ET-001 recovery update on October 11, 2026: packaged worker/native dependency paths, supervised shutdown, bounded structured logs, Job containment and static artifact inspection are implemented. The owner revoked the native launch hold and VM requirement. Native installed scaffold acceptance is recorded, including the original failed wrapper report and separate corrected postcondition/owned cleanup. Historical guest harnesses retain their guards; no further VM execution is planned. Preserve bounded owned launches, isolated test state and unrelated user data. [Validation](docs/validation/et-001.md) records artifact/review identities and the remaining unexplained startup flake. Longer stability, actual games and resolution of the original Windows-wide freezes remain unproven.

ET-002a scheduling update on October 11, 2026: the owner explicitly authorized early protocol v0 implementation and a draft PR from updated `main`, deferring SP-01 real-game checks. SP-01 PR #8 remains draft and unaccepted: ETS2 single-player windowed appearance failed and needs a real retry; Convoy remains pending. Preserve those results. The exception does not authorize protocol v1 or waive other acceptance/merge prerequisites; see [COORDINATOR.md](COORDINATOR.md) and [concept.md](concept.md).
