# Agent Instructions

## ET-008 code-acceptance exception — October 12, 2026

The owner explicitly accepts ET-008 code by exception and authorizes the coordinator to integrate PR #21 with current main, preserve Tailwind/shadcn in the main window and the isolated transparent overlay, obtain independent review and a successful final automatic Windows CI after Ready, then squash merge without another confirmation. This supersedes the earlier implementation-only permission for this package. Mandatory game, environment, CAP-01/SP-01 and performance checks remain pending; a code merge does not establish compatibility or complete those criteria. The card remains in Review until its mandatory criteria are accepted. No protocol v1, durable history, later MVP or server work is authorized.


## Start Here

Read [concept.md](concept.md) before planning or implementing changes. It contains the product requirements, architecture baseline, implementation sequence, acceptance criteria, and research sources. Read [TESTING.md](TESTING.md) before changing behavior or test infrastructure. This file contains repository-wide working instructions and a compact handoff.

Keep the two documents consistent. Use `concept.md` for detailed product decisions and this file for instructions that apply across tasks. Explicit user instructions take precedence over this documentation.

Owner-approved deferred capabilities are tracked in [technical debt](docs/technical-debt.md). An entry there records a future need; it does not expand the current milestone or authorize work outside the MVP scope.

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
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The repository is private and the authenticated account has admin permission. The token lives in the Windows keyring. A sandboxed agent shell may be unable to reach the keyring, so `gh auth status` reports "not logged in" there. Run `gh` outside the sandbox instead of asking the owner to authenticate again.
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
- Target Windows x64 first. TruckersMP compatibility is required; validate single-player as well. The built-in Convoy mode is deferred from the validation matrix by owner decision on October 12, 2026 and is not claimed as supported.
- The MVP is local and works without an account or internet connection: live telemetry, an overlay, a trip journal, and one-second samples.
- Support windowed and borderless fullscreen overlays. Exclusive fullscreen, rendering hooks, and arbitrary game memory reads are outside the MVP.
- Keep website development, accounts, company permissions, server synchronization, and online reporting in the later server phase.
- Visual design is deferred. Start with a functional, readable UI.
- The owner knows React and TypeScript and is new to desktop development. Explain unfamiliar native and desktop concepts clearly.

ET-002a acceptance update on October 11, 2026: Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

Owner sequencing decision on October 11, 2026 initially allowed ET-004a, ET-006a and ET-007 to start on isolated branches based on independently reviewed PR #10/#11 commits, which were unaccepted at that time. Every missing criterion remains pending; this exception does not authorize v1/history or extend scope to ET-008 or later phases.

Owner acceptance update on October 11, 2026: ET-005a was explicitly accepted and PR #11 squash merged as `a9cc9b34f25480226d34b86c2fb5100c55e9312e`, from verified source `00402bb90abfc41da748b9ff629b460d629c9ee8`. ET-006a now continues against accepted ET-002a and ET-005a on updated main. ET-003/ET-004a/ET-007 and SP-01 remain unaccepted; required game, environment and performance checks remain pending. ET-005b still requires ET-002b/CAP-01, so the ET-005 parent card is not Done. This acceptance does not waive other package gates.

Owner decision on October 11, 2026: ET-006a implementation and automated evidence were accepted for squash merge. PR #13 merged as `123663d8186cef7ff4745d9474caab68d3be6fa4` from source `69dba2c`, after final Ready CI run 38174065173 and independent source/raw evidence review passed. ET-006b and mandatory game, environment and performance checks remain pending. The owner requested preparing existing PR #10/#12/#14 for merge; this does not merge or accept those packages, waive their manual criteria or extend scope to ET-008/v1/history.

## Architecture Baseline

| Area | Working choice |
| --- | --- |
| Desktop and UI | Electron, React, TypeScript, Vite, Tailwind CSS v4, shadcn/ui (Radix) |
| Game integration | Project-owned C++17 DLL using the official SCS Telemetry SDK; CMake and MSVC |
| Local transport | Windows Named Pipes |
| Persistence | SQLite through better-sqlite3 in a dedicated worker |
| Process supervision | Electron main supervises a telemetry utilityProcess that owns the storage worker |
| Packaging | Electron Forge |
| Validation | Vitest, CTest for native executables, Playwright, simulation/replay, and actual game sessions |
| Later server direction | Node.js, TypeScript, Fastify, PostgreSQL, React |

The ET-001 scaffold pins dependencies and defines process boundaries; consult [docs/setup.md](docs/setup.md) and actual check evidence for installed and verified tooling. Distinguish SDK archive versions from API versions and game versions.

Keep telemetry processing and trip accounting separate from React components so they can be tested without the UI. Keep the plugin, application transport, persistence, and overlay responsibilities distinct. Expose narrow typed interfaces across boundaries.

The utilityProcess owns ingestion and source validation. A fixed project-owned native client broker supplies authoritative Windows pipe-peer queries and bounded raw I/O under its supervision; it exposes no arbitrary renderer commands. See [the v0 native boundary](docs/native-transport-boundary-v0.md) for discovery, provenance, flow-control and lifetime requirements. This is a transport implementation detail, not a wire change or game-compatibility claim.

## Implementation Constraints

### Game Integration and Transport

- Keep SDK callbacks short. Copy data in callbacks; perform serialization and transport work on a background thread.
- Call SCS APIs only in the callback context allowed by the SDK. Never call them from the transport worker.
- A missing or slow application must not stall the game. Bound buffers and report event gaps rather than silently treating incomplete data as complete.
- Version the protocol and preserve session identity and message ordering. Validate incoming messages and document the wire format alongside implementation.
- Coalesce live snapshots when appropriate. Preserve gameplay events separately, acknowledge them after persistence, and handle redelivery without duplicates.
- Restrict pipes to the local user and reject remote access.
- Install the DLL in each discovered, non-excluded game's `bin/win_x64/plugins` directory, silently where safe (see the October 12, 2026 silent plugin installation decision in `concept.md`). Change it only while the game is closed, copy atomically with SHA-256 verification against the bundled artifact, never overwrite an unrecognized file with the plugin's name, and manage only this project's plugin.
- Use real game tests to establish TruckersMP support. Do not infer compatibility solely from successful single-player tests or documentation.

### Overlay and Electron

- Use a transparent window that passes mouse input to the game and does not steal focus while driving.
- Track the game window and hide the overlay when the game is minimized or another application is foreground. Account for monitor and DPI changes.
- Keep the display update target of up to **20 Hz** separate from the history sampling rate of **1 Hz**.
- Build main-window UI from the shadcn/ui components in `apps/desktop/src/components/ui`; see [docs/setup.md](docs/setup.md#ui-components-shadcnui). The transparent overlay must not load the shadcn base stylesheet (it paints an opaque `body` background) and does not need interactive Radix components.
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
- Start every PR title with the Trello identifier in square brackets, followed by a space and the prefixed summary: `[ET-023b] chore: add PSScriptAnalyzer checks`. Use the work-package ID when the PR implements a package (`ET-023b`, `ET-015a`); otherwise use the card ID (`ET-024`, `SP-01`, `CAP-01`). Use `[NO-CARD]` only for work without a card, and explain why in the PR description. Squash merges use the PR title, so the identifier also lands in `main` history. Rename an older open PR to this format when you next update it.
- Commit and push the task branch, then open a PR targeting `main`. Use a draft PR for unfinished work. CI does not run automatically on draft PRs or on changes limited to `**.md`/`docs/**`. A skipped or absent run is not a passed check. Check a draft head by manual dispatch and record the run link; the run after **Ready for review** on the final head is the merge gate (see [docs/ci.md](docs/ci.md#triggers-and-draft-checks)). Implementation requests authorize the normal branch, commit, push, and PR workflow unless the owner specifies otherwise.
- Follow `.github/pull_request_template.md`. Explain the problem and resulting behavior, report checks actually performed, and identify remaining verification. Do not claim that CI or game testing passed when it did not run.
- Attach or bind the created PR to the current chat or session when the app provides a tool for it (Codex attachment tool, Claude Code desktop PR binding), and provide the PR link to the owner.
- The owner reviews and merges PRs by default. The agent may merge only when the owner explicitly requests or authorizes it; do not infer merge authorization from a request to implement a task or open a PR.
- Merge with **Squash merge** after relevant checks pass and review feedback is resolved as described in [Review Threads](#review-threads). A PR becomes one descriptive commit on `main`; the task branch is deleted after merging.
- After a merge, update local `main` with `git pull --ff-only` before starting the next task. Confirm the PR is merged before deleting a local task branch; preserve any remaining work.

### Review Threads

These rules apply to the agent that addresses review feedback on a PR, whoever wrote the comment (owner, independent reviewer, or the advisory Claude review).

- Close every review thread you handle with a reply, then resolve it. Never resolve a thread silently.
- **Fixed:** push the fix to the PR branch first, then reply with the commit SHA that contains the fix and a one-line summary, for example `Fixed in 28b2f26: renderer rules now cover apps/desktop/src/**/*.tsx.` Use the actual commit that changed the code, not a later documentation or merge commit. If the branch is later rewritten, update the reply so the SHA still exists on the PR branch.
- **Not fixed:** if you disagree with the finding, reply with the reason and the evidence (requirement, test, measurement, or code reference), then resolve the thread. Disagreement is not a reason to leave a thread open or to resolve it without a reply.
- If the owner reopens a thread or replies after it is resolved, treat it as open feedback: answer again and resolve it only after the new point is addressed.
- Findings in a summary comment, outside any line thread, get one PR comment that lists each finding with its fixing SHA or the reason it was not changed.
- Before marking a PR ready or merging it, confirm that no review thread is unresolved.

Commands (replace `<pr>`, `<comment-id>` and `<thread-id>`):

```powershell
# List threads with their IDs, state and the first comment's database ID, 100 per page.
# If pageInfo.hasNextPage is true, repeat with -F c=<endCursor> until it is false.
gh api graphql -f query='query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){reviewThreads(first:100,after:$c){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved path comments(first:1){nodes{databaseId body}}}}}}}' -F o=senukartur -F r=ets2telemetry -F n=<pr>
# Reply inside the thread, then resolve it.
gh api -X POST repos/senukartur/ets2telemetry/pulls/<pr>/comments/<comment-id>/replies -f body='Fixed in <sha>: <summary>'
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -F id=<thread-id>
```

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

CI trigger update on October 11, 2026 (ET-024): Windows CI skips draft PRs and changes limited to `**.md`/`docs/**`. Check a draft head by manual dispatch, and treat the run after **Ready for review** on the final head as the merge gate; see [docs/ci.md](docs/ci.md#triggers-and-draft-checks).

ET-023a lint update on October 11, 2026: `npm run lint:install` and `npm run lint` run ESLint 10 with type-aware typescript-eslint rules, React Hooks rules and renderer/preload import boundaries, with zero allowed errors or warnings; Windows CI runs them before the build. TypeScript 7.0 has no compiler API, so the separately locked `tools/lint` package uses Microsoft's side-by-side TypeScript 6.0.2 for linting only; the project still typechecks and builds with TypeScript 7.0.2. Rule exceptions and limits are in [docs/setup.md](docs/setup.md#linting). Feature PRs that merge after ET-023a fix lint findings in their own files. 

ET-023b PowerShell analysis update on October 11, 2026: `npm run lint:ps` runs hash-pinned PSScriptAnalyzer 1.25.0 under Windows PowerShell 5.1 over every tracked `.ps1`/`.psm1`/`.psd1` file with zero allowed findings, locally and in Windows CI before the build. Rule exclusions and scoped suppressions are listed with reasons in [docs/setup.md](docs/setup.md#powershell-script-analysis). New or changed PowerShell scripts must pass it.

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

AI review update on October 11, 2026: an advisory [Claude code review](docs/ai-review.md) workflow and a root `CLAUDE.md` that imports this file were added. The workflow requires an owner-provided `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret; its comments never count as approval, a required check, or verification evidence.

## Owner merge and board-status exception — October 12, 2026

The owner authorized the coordinator to squash merge PR #10 (ET-003), #12 (ET-004a) and #14 (ET-007) without further confirmation once agreed actionable review findings are resolved and the required final Windows CI passes, and directed their corresponding Trello cards to Done. PR #10 was merged as `85d9f83a763f1ca71c2d640dadc5d8fbf2d9e69b` after its exact-head CI and independent review. Integrate accepted main and verify the final candidate before each subsequent merge. This is an explicit administrative status/code-review exception: mandatory game, environment, CAP-01 and performance evidence, SP-01 windowed retry/Convoy, and ET-004b remain pending and are not accepted or implemented by that status. No compatibility, protocol-v1, durable-history or later-phase authorization follows. Keep every missing check visible in the card and ledger. Advisory AI-review execution failures remain non-gating under docs/ai-review.md; mandatory independent review and Windows checks remain required.

## Minimal overlay continuation — October 12, 2026

After the conditional code-review merges of PR #10, #12 and #14, the owner instructed the coordinator to continue available first-stage work that does not require launching actual games. ET-008 may now implement the maintained minimal overlay from accepted main `6c3af45b039aa9d8bb88a8479728f1212f7a343f` (ET-004a, ET-006a and ET-007). Keep its real-game/input/focus/mixed-DPI/monitor-removal/performance acceptance pending, as well as CAP-01 and SP-01 windowed retry/Convoy. This permission authorizes implementation, isolated automated/controlled validation and a task PR; it does not extend the PR10/12/14 conditional merge or Done exception to ET-008, waive its game gate, or authorize ET-010+, protocol v1, durable history or server work. Reuse the protected v0/typed bridge and current-window authority; the overlay renderer receives no native placement, HWND, filesystem or source-selection authority. Follow physical-client to Electron DIP conversion and preserve independent SDK/window freshness, bounded up-to-20Hz delivery, nonfocus click-through driving mode and hiding on foreground/minimize loss. ET-000 display defaults remain ETS2 metric and ATS US customary, separate from canonical v0 m/s and L; real SDK unit observations remain pending CAP-01.

## Convoy validation deferral — October 12, 2026

The owner removed the built-in Convoy multiplayer mode from the current validation matrix: the owner does not play Convoy and has no procedure to test it. The matrix for SP-01, CAP-01, the full ET-009 gate and later ET-020 is now ETS2 and ATS, each in single-player and TruckersMP, with windowed and borderless modes. Convoy is deferred, not rejected: it is neither validated nor claimed as supported, and the application must not advertise Convoy compatibility. Earlier dated records that list Convoy as pending keep their historical wording; this decision supersedes those pending Convoy checks. TruckersMP still requires actual game evidence; single-player and TruckersMP results do not establish Convoy behavior.
