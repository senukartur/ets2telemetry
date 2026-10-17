# Agent Instructions

## ET-008 code-acceptance exception — October 12, 2026

The owner explicitly accepts ET-008 code by exception and authorizes the coordinator to integrate PR #21 with current main, preserve Tailwind/shadcn in the main window and the isolated transparent overlay, obtain independent review and a successful final automatic Windows CI after Ready, then squash merge without another confirmation. This supersedes the earlier implementation-only permission for this package. Mandatory game, environment, CAP-01/SP-01 and performance checks remain pending; a code merge does not establish compatibility or complete those criteria. The card remains in Review until its mandatory criteria are accepted. No protocol v1, durable history, later MVP or server work is authorized.


## Start Here

Read [concept.md](concept.md) before planning or implementing changes. It contains the product requirements, architecture baseline, implementation sequence, acceptance criteria, and research sources. Read [TESTING.md](TESTING.md) before changing behavior or test infrastructure. This file contains repository-wide working instructions and a compact handoff.

Keep the two documents consistent. Use `concept.md` for detailed product decisions and this file for instructions that apply across tasks. Explicit user instructions take precedence over this documentation.

Owner-approved deferred capabilities are tracked in [technical debt](docs/technical-debt.md). An entry there records a future need; it does not expand the current milestone or authorize work outside the MVP scope.

When the owner requests an implementation coordinator, also read [COORDINATOR.md](COORDINATOR.md). It defines Trello execution, bounded subagent delegation, worktree ownership, independent review, recovery state, and PR handoff. Use the [launch prompt](docs/prompts/coordinator-start.md) to start that role in a separate chat. This role applies only when requested; delegated workers follow their bounded assignments and the repository rules.

In Claude Code, the owner can run a single task through project subagents (architect, implementer, verifier and independent reviewer) with `/deliver`, which ends with a draft PR. See [the delivery pipeline](docs/delivery-pipeline.md). It grants no authority beyond this file.

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
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The authenticated account has admin permission on the repository; its visibility is recorded under [Repository visibility and license](#repository-visibility-and-license--october-16-2026). The token lives in the Windows keyring. A sandboxed agent shell may be unable to reach the keyring, so `gh auth status` reports "not logged in" there. Run `gh` outside the sandbox instead of asking the owner to authenticate again.
- The repository-local commit identity is `Artur Sianiuk <15032912+senukartur@users.noreply.github.com>`. Pulls require a fast-forward (`pull.ff=only`), and pushes use `push.default=simple`.
- Fetch, `git pull --ff-only`, and the initial documentation push succeeded. The published documentation includes `README.md`, `AGENTS.md`, and `concept.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`; do not commit it.
- Use Git for local history and synchronization, and GitHub CLI for pull requests and GitHub checks. A GitHub MCP server is not required for this workflow.
- The application and native development toolchains remain unverified.
- GitHub allows only squash merging and automatically deletes merged task branches. Squash commits use the PR title and body.
- GitHub returned HTTP 403 for branch protection and rulesets while the repository was private on the Free plan. Since October 16, 2026 the public repository enforces the `Protect main` ruleset; see [Branch protection](#branch-protection--october-16-2026).

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
- Make the overlay topmost with `setAlwaysOnTop(true, 'screen-saver')`. Never use the constructor's `alwaysOnTop` option or Electron's default `floating` level: on Windows they stack the window behind the taskbar and can lose `WS_EX_TOPMOST` over a borderless game. Re-assert the level without activation after each show; see [the minimal overlay z-order](docs/minimal-overlay.md#z-order).
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
- `.githooks/pre-push` rejects direct updates or deletion of remote `main`; GitHub PR merging is unaffected. This local guard can be bypassed; the server-side `Protect main` ruleset enforces the same rule. Do not bypass it unless necessary for a specifically authorized exception.
- Server-side protection follows these rules: require PRs, linear history, resolved review conversations, and passing existing CI checks; block force pushes and branch deletion. Do not invent required check names or require a second-account approval in the current single-owner setup. The `Protect main` ruleset implements them; see [Branch protection](#branch-protection--october-16-2026).

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
- A failing existing baseline suite blocks acceptance. Check the current PR commit and run extra migration, packaging, native, or real-game checks when the change affects those boundaries. The `Protect main` ruleset requires only the two Windows CI jobs ([Branch protection](#branch-protection--october-16-2026)); the owner enforces the rest of this merge policy, so do not claim that the server enforces review, real-game or other acceptance evidence.
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

## CAP-01a evidence capture transport — October 12, 2026

The owner approved the CAP0 evidence-capture direction on October 12, 2026. CAP0 is a separately versioned, default-off, evidence-only contract on its own named pipe, isolated from the frozen v0 live protocol; the v0 handshake, parser, fixtures and overlay path are unchanged. Approved bounds: 64 KiB per packet; a native evidence queue of 128 envelopes and 2 MiB with non-blocking newest-drop and explicit loss counters; an application writer with 2 MiB pending data, 20 MiB per file and a 10-minute default deadline; output in a separate capture directory outside `telemetry.sqlite` and the application binaries. CAP0 has no ACK, offline spool, history, trip effects or renderer authority. Package CAP-01a implements this contract and its tooling without a game; see [the CAP0 contract](docs/protocol/cap0.md) and [CAP-01a validation](docs/validation/cap-01a.md). The production plugin always exposes a passive CAP0 endpoint that copies nothing until the approved broker authenticates; the application enables one capture per launch only through `ETS2TELEMETRY_CAPTURE=cap0`. CAP-01a does not accept CAP-01 or ET-009: real captures from both games and the required modes, sanitized and independently reviewed observations, frame-time impact, and the SP-01 windowed retry remain pending (Convoy is deferred). No protocol v1, durable history or later-phase work is authorized.

## Convoy validation deferral — October 12, 2026

The owner removed the built-in Convoy multiplayer mode from the current validation matrix: the owner does not play Convoy and has no procedure to test it. The matrix for SP-01, CAP-01, the full ET-009 gate and later ET-020 is now ETS2 and ATS, each in single-player and TruckersMP, with windowed and borderless modes. Convoy is deferred, not rejected: it is neither validated nor claimed as supported, and the application must not advertise Convoy compatibility. Earlier dated records that list Convoy as pending keep their historical wording; this decision supersedes those pending Convoy checks. TruckersMP still requires actual game evidence; single-player and TruckersMP results do not establish Convoy behavior.

## v0 startup-budget hardening — October 13, 2026

Owner decision: a v0 transport startup that has not finished within the fixed 1 s SDK-initialization wait is pending, not failed. Official init logs one fixed warning and returns `ok`; the worker keeps starting. The adapter logs its eventual result once on the SDK thread, from the next `frame_end` or from shutdown. Failures reported within the wait still return `generic_error` with one fixed error log. The game never waits longer than before. See [the native transport](docs/native-transport-v0.md) and [the startup-budget record](docs/validation/et-004-startup-budget.md). This is ET-004 hardening only; it establishes no game compatibility and authorizes no protocol v1 or later-phase work.

## CAP-01 and SP-01 acceptance — October 14, 2026

The owner accepted CAP-01 with explicit gaps and accepted SP-01 on October 14, 2026. See [concept.md](concept.md#cap-01-and-sp-01-acceptance--october-14-2026) and [CAP-01a validation](docs/validation/cap-01a.md#cap-01-acceptance-october-14-2026). The gaps stay pending, not observed. Neither acceptance establishes TruckersMP, display or performance support, or completes the full ET-009 gate. Authorization for later packages, such as ET-002b, is recorded separately.

## ET-002b authorization — October 14, 2026

The owner authorized ET-002b on October 14, 2026 as a contract-only package: the durable telemetry protocol v1 wire specification, its TypeScript schemas and delivery helpers and the shared fixtures (PR-1), then the matching C++17 representation that reads the same fixtures (PR-2). For ET-002b only, this supersedes the "no protocol v1" wording in earlier dated paragraphs. ET-004b, ET-005b, ET-006b, durable storage, trip logic and later phases remain unauthorized. No runtime path changes: v0 stays the live protocol until those packages land, and recording never ships on v0. Real-game, TruckersMP, display and performance criteria remain pending, and Convoy stays deferred. The owner accepted all architect recommendations D1–D17; they are recorded in [concept.md](concept.md#protocol-v1-decisions--october-14-2026), and the wire format is [protocol v1](docs/protocol/v1.md).

## ET-002b acceptance and ET-004b authorization — October 14, 2026

The owner accepted ET-002b on October 14, 2026: PR #42 (`59a2667`) and PR #43 (`2d48c9a`). The owner authorized ET-004b, the plugin's protocol v1 producer, delivered as three PRs in order: the producer core (records, encoder and event store), callback capture and the v1 endpoint. Per D2 the production plugin may serve v1 beside v0; the v1 endpoint stays passive and fail-closed until ET-006b provisions its service policy (OD-2). Game mode is reported as `unknown` until a separate detection package (OD-3). The owner approved the architect recommendations OD-1 to OD-6; the OD-5 wording clarifications S1–S11 are recorded in [protocol v1](docs/protocol/v1.md) and the producer's store rules in [the native v1 transport](docs/native-transport-v1.md). For ET-004b only, this supersedes the statement in the ET-002b authorization paragraph that ET-004b remains unauthorized; earlier dated text is unchanged. ET-005b, ET-006b, ET-013 and later storage, trip logic and later phases remain unauthorized, and the desktop application stays on v0. No game, TruckersMP or performance claim follows from this authorization or from synthetic tests.

## ET-005b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents."

Coordinator interpretation: this instruction is what authorizes starting ET-005b, the protocol v1 simulator, delivered as three PRs: the deterministic simulator core, pipe serving with fault injection, and sanitized CAP-01 replay. For ET-005b only, it supersedes the earlier statements that ET-005b remains unauthorized; earlier dated text is unchanged. CD-1 to CD-12, recorded in [concept.md](concept.md#et-005b-authorization--october-15-2026), are coordinator decisions under that delegation and were not individually reviewed by the owner. The merge gate (a verifier pass, independent review, no unresolved review threads and a successful Windows CI after Ready on the final head) is the coordinator's self-imposed standard. The simulator opens no database, writes no history, discovery or service-policy file, calls no SDK function and emits only synthetic or replay origins, never `game`. The desktop application stays on v0. ET-006b, ET-013 and later storage, trip logic and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows from the simulator. See [the simulator v1 guide](docs/simulator-v1.md) and [ET-005b validation](docs/validation/et-005b.md).

## ET-013 authorization — October 15, 2026

The owner authorized ET-013 (the SQLite storage worker and schema) on October 15, 2026, in parallel with ET-004b PR C, granted the coordinator merge authority after independent review and a successful final Windows CI, and delegated the ET-013 design decisions to the coordinator, who adopted the architect's recommendations OD-1 to OD-10 ([storage](docs/storage.md#decisions-october-15-2026)). For ET-013 only, this supersedes the October 14, 2026 statements that ET-013 remains unauthorized; earlier dated text is unchanged. ET-013 is delivered as two PRs: the storage core with schema version 1, migrations and verified backups, then the worker integration and the storage measurement. ET-014, ET-015a, ET-015b, ET-015c, ET-006b and ET-016 remain unauthorized by this paragraph; ET-005b is authorized separately in the paragraph above. The desktop application stays on protocol v0, records nothing and sends no ACK. No game, TruckersMP or performance claim follows from this authorization or from synthetic storage tests.

ET-013 PR-2 implementation update (October 15, 2026): the telemetry service opens the history database in its storage worker at start (non-blocking, no TEMP fallback) and closes it in the `storage` shutdown phase; the measured size of 100 hours of 1 Hz history is 53.4 MB, superseding the 60-120 MB model ([storage](docs/storage.md#measured-size-et-013-pr-2), [ET-013 validation](docs/validation/et-013.md)).

## ET-011 authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-011 and adopted the architect's decisions C1–C17 as coordinator decisions; the owner has not reviewed them individually. They are recorded in [concept.md](concept.md#et-011-authorization--october-15-2026). ET-011 is delivered as two PRs: ET-011a (tray lifecycle, single instance, explicit exit, health and service shutdown hooks) and then ET-011b (validated persistent settings and per-game unit profiles), which starts from `main` after ET-011a merges. Closing the main window now hides it to the tray and leaves the service and overlay running; only an explicit exit stops them ([application lifecycle](docs/app-lifecycle.md)). The card stays in Review until the manual Windows checks (the real notification-area icon at 100% and 150% scaling, overflow, click/menu/Exit without a ghost icon, Explorer restart, second launch from the Start menu, sign-out/restart) and the real-game overlay checks are accepted; see [ET-011 validation](docs/validation/et-011.md). This paragraph covers ET-011 only; other packages started under the same delegation are recorded in their own paragraphs. It authorizes no autostart, auto-update, cloud synchronization or recording, and synthetic or local checks establish no game, TruckersMP, display or performance claim. Recording survival across close-to-tray (REG-012) still requires ET-015.

ET-011b implementation update on October 15, 2026: per-game display unit profiles are saved in `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json` (format v1, no startup write, byte-identical quarantine of invalid files, read-only newer versions, synced atomic saves) and applied to the dashboard and overlay through telemetry-core conversions only after a durable save; see [settings](docs/settings.md). The ET-011 manual and real-game checks remain pending.

## ET-010 authorization — October 15, 2026

On October 15, 2026 the owner gave the coordinator standing autonomy: "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under that delegation the coordinator started ET-010 and adopted the architect decisions N1–N16 ([concept.md](concept.md#et-010-authorization--october-15-2026)). They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. ET-010 is three packages in order: ET-010a (live telemetry normalization and per-game display profiles in `packages/telemetry-core`), ET-010b (the complete live field set on the dashboard, after ET-011a and ET-011b) and ET-010c (protocol v1 fields on the dashboard, after ET-006b). Unit conversion lives in telemetry-core over the canonical units m/s, m, L and L/100 km. The SDK average consumption is never a trip average. Money stays exact raw digits with an SDK-documented or unknown currency. ET-010 changes no v0 wire, preload/IPC, storage, trip logic, recording or later-phase scope, and makes no game, TruckersMP, display or performance claim. Real-source dashboard checks are pending in [ET-010 validation](docs/validation/et-010.md); the field rules are in [live telemetry fields](docs/live-telemetry-fields.md).

ET-010b implementation update on October 15, 2026: the main window shows the complete protocol v0 live field set in a **Live telemetry** card between the status card and the application status card; speed and fuel stay in their existing lines. The card is built from telemetry-core's view model with labels from `apps/desktop/src/strings.ts` and uses the same per-game unit profile as the speed and fuel lines. Coordinator decisions B1–B6 are in [concept.md](concept.md#et-010-authorization--october-15-2026), the rules in [live telemetry fields](docs/live-telemetry-fields.md#dashboard). Real-source dashboard checks remain pending in [ET-010 validation](docs/validation/et-010.md#et-010b-dashboard).

ET-010c implementation update on October 15, 2026: the Live telemetry card adds the rows only protocol v1 carries (route remaining, delivery deadline, source city and company, destination company, cargo mass, market, special job, cargo loaded, license plate, trailers, world position, heading) and a Protocol v1 source section (status, game mode, lost events). They come from a whitelisted v1 projection that the telemetry service attaches to the existing live update as an optional `v1` field. It omits the window handle, clock mapping, delivery cursor and durable status, is validated in main and preload, and expires independently of v0 after 500 ms at each layer. Rows v0 carries stay on v0; with a current v1 observation of the same job (the same cargo and destination city ids), cargo and destination city show their names instead of game ids. Main feeds the same projection into ET-012a's overlay sections: origin, distance remaining and the deadline appear, the destination gains its company and the cargo its mass. A v1 section shows a value only while both v0 and v1 data are current and, for job fields, describe the same job; otherwise it follows ET-012a's L5 rule (a dash if it was shown, hidden if it was not); without a v0 job the job sections are left out. The overlay renderer still receives only formatted text, its preload, layouts and geometry and the overlay IPC are unchanged, and v1 never authorizes overlay placement or visibility. For ET-010c only this supersedes N4's "no bridge, preload or IPC change" and ET-012a L7's statement that the bridge carries v0 only: the live payload type gains the `v1` field, while bridge methods and IPC channels are unchanged. Coordinator decisions F1–F10 and C1–C5 are in [concept.md](concept.md#et-010-authorization--october-15-2026). The default-configuration strip regression found during review is resolved by ET-012c (PR #76, `65eaeb8`). With v1, the default strip (all sections on, 1280×110 at scale 1) keeps all twelve shown sections inside the window on two rows, and the telemetry smoke asserts this containment. Long origin, destination and income values end in an ellipsis. The same holds at scale 2.
In the review-only measurement:
- the Card fits all twelve sections and cuts off the same three values;
- the HUD fits with nothing cut off;
- the Cluster clips one section, game time, out of its 440×220 window.

The Cluster is not the default layout. Under the owner's standing delegation the coordinator merges ET-010c and fixes the Cluster in a follow-up package, ET-012d. No wire, storage, recording or game, TruckersMP, display or performance claim follows; real-source dashboard and overlay checks remain pending in [ET-010 validation](docs/validation/et-010.md).

ET-004b implementation update on October 15, 2026: the producer core (PR #47), callback capture (PR #48) and the v1 plugin endpoint (PR C) are implemented. The plugin serves protocol v1 beside v0 and CAP0, passive and fail-closed until ET-006b provisions `transport\v1\service-policy.json`; the desktop application stays on v0. Synthetic pipe, DLL and AddressSanitizer tests pass locally ([ET-004b validation](docs/validation/et-004b.md)); hosted CI, independent review, owner acceptance, second-user and remote-client rejection, and every real-game, TruckersMP and performance check remain pending.

## ET-006b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-006b, protocol v1 ingestion in the telemetry service, and adopted the architect's decisions E1–E14 ([concept.md](concept.md#et-006b-authorization--october-15-2026)). E1–E14 are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. For ET-006b only, this supersedes the earlier statements that ET-006b remains unauthorized; earlier dated text is unchanged. ET-006b is three PRs: v1 ingestion with a storage-commit ACK pipeline (PR-1), the v1 mode of the native broker, which provisions `transport\v1\service-policy.json` (PR-2), and the connection of the telemetry service to the plugin's v1 endpoint (PR-3, which starts only after PR-1 and PR-2 merge). Production connects v1 live-only beside v0: it writes no history rows, sends no ACK and changes no renderer until ET-015a supplies trip effects and the v0-retirement PR lands. The durable path is exercised only against temporary synthetic databases in tests. ET-014, ET-015a, ET-015b, ET-015c, ET-010c and later phases are not authorized by this paragraph. No game, TruckersMP or performance claim follows from synthetic or local tests.

ET-006b PR-2 implementation update on October 15, 2026: the native broker `telemetry-pipe-client.exe` has a protocol v1 mode (`--protocol v1`) that provisions `transport\v1\service-policy.json`, validates the v1 discovery record and hello, and relays the service's `ack` and `clock.probe` frames through tagged stdin records; no production code path uses it until the service wiring (PR-3). See [the native broker control](docs/telemetry-service-v0.md#native-broker-control) and [ET-006b broker validation](docs/validation/et-006b-broker.md).

ET-006b PR-1 implementation update on October 15, 2026: `V1Ingestion`, the `DurableDelivery` ACK pipeline and `StorageDurableSink` exist in `apps/desktop/src` with unit, actual-pipe, storage-worker and killed-process tests, but the running service does not use them yet; see [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-006b validation](docs/validation/et-006b.md).

ET-006b PR-3 implementation update on October 15, 2026: the telemetry service runs protocol v1 beside v0, live-only. For ETS2 or ATS selections it starts the native broker in its v1 mode, with the v1 discovery directory derived from the validated v0 broker configuration (E12); fixtures come only from `ETS2TELEMETRY_SOURCE_PIPE_V1`. The hello requests `durableEvents: false`, no ACK or history row is written, and no preload, IPC or renderer changed, so the dashboard and overlay stay on v0. `npm run test:v1-chain` (Windows CI) checks the broker-provisioned policy, ACK relay and the fail-closed synthetic origin against the test plugin DLL. See [service wiring](docs/telemetry-service-v1.md#service-wiring) and [ET-006b validation](docs/validation/et-006b.md#pr-3-service-wiring). Hosted CI, independent review, the production durable path and every real-game, TruckersMP and performance check remain pending.

## ET-012a authorization — October 15, 2026

On October 15, 2026 the owner reviewed HTML mockups and approved ET-012a: selectable overlay layouts (Strip by default, Card, Cluster, Minimal HUD) and fourteen toggleable overlay sections configured in the desktop settings, which move to format v2. The coordinator adopted decisions L1–L15 under the owner's delegation ([concept.md](concept.md#et-012a-authorization--october-15-2026)). Main formats every section through telemetry-core in the displayed game's unit profile; the overlay renderer stays display-only and loads no shadcn styles. The bridge still carries protocol v0 only, so sections that need v1 or trip tracking stay hidden. ET-012b, protocol v1 exposure and later phases are not authorized by this paragraph. Each layout's visibility, readability, click-through and focus behaviour above a real game remain pending in [ET-012a validation](docs/validation/et-012a.md); no game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-014 authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-014, the pure trip lifecycle and completeness reducer in `packages/telemetry-core`, and adopted the architect's decisions T1–T20 ([concept.md](concept.md#et-014-authorization--october-15-2026), [trips](docs/trips.md)). They are coordinator decisions and were not individually reviewed by the owner. For ET-014 only, this supersedes earlier statements that ET-014 remains unauthorized; earlier dated text is unchanged. ET-014 is two PRs: the event-driven lifecycle reducer, then readings accounting with simulator replay. It changes no storage schema, wire, preload/IPC, renderer or native code and records nothing; ET-015a wires effects into commits. Behaviour seen in real traces rests only on the reviewed CAP-01 observations O1–O11; train, profile switch, quick-job replacement, late attach after a job started, refuel, teleport, suspend and clock changes are synthetic inferences. ET-015a, ET-015b, ET-015c, ET-016 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-014 PR-2 implementation update on October 15, 2026: the trip reducer accounts readings (T16, T17): observed distance from continuous odometer steps while active, fuel used and refuel episodes, nothing bridged across connection holes (`odometerDeltaM` recorded), observed distance persisted on carriers and before every close, and provisional named thresholds for game-time jumps (crossing or possible sleep), position jumps and 5 s reading holes. Twelve ET-005b scenarios replay against hand-written trip expectations ([trips](docs/trips.md#readings-accounting-t16-t17), [ET-014 validation](docs/validation/et-014.md)). Nothing records yet; the thresholds and every real-game behaviour remain pending.

## ET-012b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-012b, the explicit overlay edit mode with per-layout position and scale persisted in the desktop settings, and adopted the architect's decisions M1–M13 ([concept.md](concept.md#et-012b-authorization--october-15-2026)). They are coordinator decisions and were not individually reviewed by the owner. For ET-012b only, this supersedes the ET-012a statement that ET-012b is not authorized; earlier dated text is unchanged. The settings file moves to format v3, which an ET-012a build reads as `newer-version` (read-only defaults). Main owns the edit mode in memory: the overlay is interactive only while it is shown for editing with an own window in front and the game not in front, and driving mode stays click-through, nonfocusable and hidden unless the game is in front. ET-012b changes no protocol, wire, fixtures, native code, broker, storage or trip logic. Multi-monitor, mixed-DPI, monitor-removal and off-screen recovery stay deferred, and every real-game check (dragging and scaling over ETS2 and ATS, single-player and TruckersMP, windowed and borderless, focus transitions and restart restore) remains pending in [ET-012b validation](docs/validation/et-012b.md). No game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-015a authorization — October 16, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-015a (events and durable ACK) and adopted the architect's decisions R1–R17 ([concept.md](concept.md#et-015a-authorization--october-16-2026)). They are coordinator decisions and were not individually reviewed by the owner. For ET-015a only, this supersedes earlier statements that ET-015a remains unauthorized; earlier dated text is unchanged.

ET-015a is four PRs: storage recovery reads, the trip recorder in the v1 ingestion pipeline, service wiring behind the recording gate, and a runtime recording journey. It commits v1 events, gaps and their ET-014 trip effects in one storage transaction and acknowledges only after the commit. It runs in the telemetry utilityProcess with its storage worker.

Production game sources stay live-only (`GAME_HISTORY_RECORDING` false, `durableEvents: false`, no history row) until a separate enablement PR. That PR comes after the v0 retirement (D2), real-game v1 evidence, ET-015b, ET-015c, and the S-1/S-2 decision in ET-016. `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` records synthetic or replay sources into a separate database in the synthetic directory, never into history.

ET-015a makes no schema, wire, preload/IPC or renderer change. ET-015b, ET-015c, ET-016 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-015a PR-1 implementation update on October 16, 2026: storage gains a `{game, outcome}` filter on `listTrips` and an `ifAbsent` option on `recordCompleteness`; `apps/desktop/src/trip-seeds.ts` derives cold-start `TripSeed`s from stored rows (not yet called); and a test-only fault storage worker injects disk-full, permission and lock failures inside the real transaction. No production behaviour changes; see [ET-015a validation](docs/validation/et-015a.md).

ET-015a PR-2 implementation update on October 16, 2026:
- **Commit and ACK.** `TripRecorderSink` (`apps/desktop/src/trip-recorder.ts`) commits v1 events and gaps together with their ET-014 trip effects in one storage transaction. The ACK is sent only after the commit, and trip state is adopted only after `committed`, `duplicate`, `covered` or `conflict`.
- **Readings.** Checkpoints and snapshots go through the same FIFO, bounded at 512 readings apart from the 256 items. The receipt UTC label is taken when the frame is decoded.
- **ACK ahead of storage.** It records one `restore-loss` interval.
- **Ingestion.** Ingestion gains durable selections and readiness and a `stopSource`/`flush` split. `EffectsHook` is removed (S-3).
- **Evidence.** All of this is proven only with synthetic sources against temporary synthetic-purpose databases: the real storage worker, killed processes and injected SQLite failures.
- **Production is unchanged.** The service passes no sink and game selections stay live-only. See [ET-015a validation](docs/validation/et-015a.md).

ET-015a PR-3 implementation update on October 16, 2026: the telemetry service applies the recording gate in `apps/desktop/src/recording-policy.ts`, where `GAME_HISTORY_RECORDING` is `false` and a unit tripwire asserts it.
- **Production game sources are unchanged.** History opens, no recorder is built, hellos ask for `durableEvents: false`, and no ACK or history row is written.
- **Synthetic and replay recording.** Only `ETS2TELEMETRY_RECORDING=synthetic:<name>` or `replay:<name>` runs `TripRecorderSink` in the service, for the matching selection only. It writes to `%LOCALAPPDATA%\ETS2Telemetry\synthetic\<name>.sqlite` instead of history. Durable delivery starts once that database is open. An invalid value logs `RECORDING_TARGET_REJECTED` and falls back to the default.
- **Stop sequence.** Service stop is intake (1000 ms), then a new `recording-flush` step (500 ms) that waits for the commit in flight, then storage (1000 ms). The total stays 2500 ms.
- See [ET-015a validation](docs/validation/et-015a.md).

ET-015a PR-4 implementation update on October 16, 2026: the development and packaged `recording` runtime smokes record a synthetic protocol v1 source into `synthetic\smoke.sqlite` through four steps:
- a terminated and restarted service, which redelivers a duplicate;
- recording while the main window is closed to the tray;
- a tray exit with `recording-flush`;
- an application restart that appends to the same database.

The database must equal hand-written rows, and no history database may be created. No product code changed. Whether `recording-flush` waits for a commit in flight is shown only by unit tests, because no commit is in flight at the journey's exit. Hosted CI, the enablement PR and every real-game check remain pending ([ET-015a validation](docs/validation/et-015a.md)).

## ET-012c strip overflow fix — October 16, 2026

On October 16, 2026 the owner decided to fix the overlay strip's overflow first, in a separate package ET-012c, before ET-010c (PR #73) merges. Under that decision and the standing delegation of October 15, 2026, the coordinator adopted the architect's decisions S1–S12 ([concept.md](concept.md#et-012c-strip-overflow-fix--october-16-2026)).

The strip now reserves as many 36 px rows as its enabled sections need at its width. Every strip section has a fixed maximum width, and a longer value ends in an ellipsis, so no enabled section is hidden. The window size depends only on the saved layout, placement and sections and on the game's client area, never on values. A strip that does not fit is hidden as a whole, and edit mode reports `too-large`. The overlay smoke fails when a shown strip section lies outside the overlay window.

ET-012c makes no settings format, IPC, preload, protocol, projection or service change, and the card, cluster and HUD are unchanged. For the strip, M4's height `round(38 × scale)` becomes `ceil(36 × rows × scale + 2 × max(1, scale))`, which equals `ceil((36 × rows + 2) × scale)` at scale 1 or more. Below zoom 1 the row model counts the surface border snapped to one device pixel. Earlier dated text is unchanged. Real-game readability, click-through over the taller window, fractional-DPI rounding and frame-time impact remain pending in [ET-012c validation](docs/validation/et-012c.md). No game, TruckersMP, display or performance claim follows.

## ET-012d overlay layout fit — October 16, 2026

On October 16, 2026 the owner decided to fix the overlay strip first. The coordinator then decided to merge ET-010c and to fix the Cluster in a follow-up package, ET-012d. Under those decisions and the standing delegation of October 15, 2026, the coordinator adopted the architect's decisions K1–K12 ([concept.md](concept.md#et-012d-overlay-layout-fit--october-16-2026)). The owner did not review them individually.

The Card, the Cluster's side panel and the Minimal HUD use fixed row heights, and each reserves its height for its enabled sections. The window is at least its ET-012a nominal size and grows only when the enabled sections need more room. With every section at scale 1 the windows are:
- Card: 300 × 384;
- Cluster: 440 × 267;
- HUD: 320 × 354.

The size never depends on values. A layout that does not fit hides as a whole, and edit mode reports `too-large`. The telemetry smoke asserts that every shown Card, Cluster and HUD section lies inside the overlay window with protocol v1 data.

ET-012d makes no settings format, IPC, preload, projection, protocol or service change, and the strip is unchanged. For the Card, Cluster and HUD, M4's height `round(nominal × scale)` becomes `max(round(nominal height × scale), ceil(content × scale + 2 × border × max(1, scale)))`. Widths are unchanged, and earlier dated text is unchanged.

Real-game readability of the taller layouts, click-through over them, fractional-DPI rounding and frame-time impact remain pending in [ET-012d validation](docs/validation/et-012d.md). No game, TruckersMP, display or performance claim follows.

## Repository visibility and license — October 16, 2026

On October 16, 2026 the owner released the project under the [MIT License](LICENSE) and decided to make the GitHub repository public, so that standard GitHub-hosted Actions runners stop consuming the private-repository minute quota. The visibility switch is a separate owner action in the GitHub settings; check the current state with `gh repo view senukartur/ets2telemetry --json visibility` instead of assuming it. The vendored SCS SDK headers keep their own license and notice ([vendor](native/telemetry-plugin/vendor/README.md)).

Once the repository is public, its full Git history, pull requests, review comments, Actions logs and retained artifacts are readable by anyone, and that cannot be undone. Never commit or paste into PRs, comments or logs any secret, token, personal path, account, player or profile data, raw game captures or screenshots. Fork pull requests run Windows CI without repository secrets; do not ask `@claude` to review a fork PR. Branch protection and rulesets become available on the Free plan for public repositories; the ruleset now in force is described under [Branch protection](#branch-protection--october-16-2026), and the local pre-push hook and the owner merge policy still apply. This decision changes no product scope and no package authorization.

## Branch protection — October 16, 2026

The repository became public on October 16, 2026, and at the owner's request the active repository ruleset `Protect main` (id 25232619) now protects the default branch:

- Deleting `main` and non-fast-forward pushes are blocked, and history must be linear.
- Changes reach `main` only through a pull request merged by squash. No approving review is required in the single-owner setup, but every review thread must be resolved.
- The `Windows CI` jobs `Windows x64 scaffold` and `Windows x64 native AddressSanitizer`, reported by GitHub Actions, must pass on the PR head. The branch need not be up to date with `main` first. The advisory Claude review is not required.
- The repository admin role may bypass these rules only when merging a pull request (`pull_requests_only`); direct pushes to `main` stay blocked for everyone.

Windows CI does not run on PRs that change only `**.md` or `docs/**`, so their required checks never report. Merge such a PR with `gh pr merge <pr> --squash --admin` only when its diff is limited to those paths, after the review rules above are met. Never use `--admin` to skip a failing, pending or cancelled check on any other PR. GitHub counts a job skipped by its `if` condition, such as the draft skip in both Windows CI jobs, as a passing required check, so the ruleset alone does not prove a real run: the merge gate remains a successful run of both jobs on the final head after **Ready for review** ([docs/ci.md](docs/ci.md#triggers-and-draft-checks)). The local pre-push hook remains in place. Inspect the live rules with `gh api repos/senukartur/ets2telemetry/rules/branches/main` before relying on this description.

## ET-015b authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015b, one-second history. It adopted the architect's decisions H1–H17 ([concept.md](concept.md#et-015b-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-015b only, this supersedes earlier statements that ET-015b remains unauthorized; earlier dated text is unchanged.

ET-015b is four PRs:
- a storage guard that stores at most one sample per source second;
- a pure, freshness-aware 1 Hz sampler in `packages/telemetry-core`;
- sample recording through the trip recorder and the DurableDelivery FIFO, with bounded batches, a 5 s flush, a 300-row backlog bound and a final write in the existing `recording-flush` step;
- the extension of the recording runtime journey.

Samples follow active real seconds of the source capture clock, never renderer frequency or game time. Paused, stale and missing seconds produce no row, and missing seconds are never filled.

Storage gains only the `appendSamples` option `uniqueSeconds`, a `skipped` count and an in-process test hook that never crosses the worker boundary. There is no schema, migration, wire, preload/IPC, renderer or native change. `GAME_HISTORY_RECORDING` stays `false`, so samples are written only to synthetic or replay recording targets. ET-015c, ET-016 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-015b PR-1 implementation update on October 16, 2026: `appendSamples` gains the `uniqueSeconds` option and returns `{appended, skipped}`. With the option, one transaction skips each row whose source second does not advance past the session's latest stored row on the same clock or an earlier row of the batch. The test-only fault worker can fail or hold sample batches. Nothing outside tests writes samples yet. See [ET-015b validation](docs/validation/et-015b.md).

ET-015b PR-2 implementation update on October 16, 2026: `packages/telemetry-core/src/history-samples.ts` adds the pure `sampleReading`. It picks the first fresh, running reading in each source-clock second, treats a plugin session's first reading as a baseline, and never fills missed seconds. A sample references a trip only while that game's trip view is active. Nothing calls it until PR-3. See [trips](docs/trips.md) and [ET-015b validation](docs/validation/et-015b.md).

ET-015b PR-3 implementation update on October 16, 2026:
- **Sampling.** The trip recorder samples durable readings at the head of the DurableDelivery FIFO with `sampleReading` and keeps the rows in a bounded buffer: 300 rows, with newer rows dropped. Each contiguous outage becomes one session-level `sample-loss` interval, and at most 16 loss runs are kept per session and clock.
- **Writes.** A low-priority `samples` op writes at most 60 rows through `appendSamples` with `uniqueSeconds`. It is queued after 5 s or at 60 rows, and only one is queued or running at a time. It never produces or advances an ACK.
- **Exit.** The existing 500 ms `recording-flush` step writes the pending rows and loss intervals after the commit in flight.
- **Failures.** Retryable failures keep the rows. Unavailable failures make the service live-only and discard them. Diagnostics are the `V1_SAMPLES_*` codes.
- **Production is unchanged.** `GAME_HISTORY_RECORDING` stays `false`. See [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-015b validation](docs/validation/et-015b.md).

ET-015b PR-4 implementation update on October 16, 2026: the development and packaged `recording` runtime smokes now assert exact one-second sample rows written by the running application. The restarted service and the run-B service each store one hand-written row after their checkpoint baselines, written by their explicit exits' `recording-flush` unless the 5 s flush wrote it first, and a paused second gets no row. The killed first service's second-1000 row stays optional. No product code changed. The 5 s flush, batches, backlog drops and storage skips are covered only by unit and storage tests, and every real-game check remains pending ([ET-015b validation](docs/validation/et-015b.md)).

## ET-015c authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015c, integrated recovery. It adopted the architect's decisions G1–G20 ([concept.md](concept.md#et-015c-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-015c only, this supersedes three earlier statements; earlier dated text is unchanged:
- that ET-015c is not authorized;
- ET-011 C9's statement that recording is always reported as unavailable;
- ET-015a's statement that it makes no preload/IPC or renderer change.

ET-015c is four PRs:
- the recording runtime extracted from the service, with real-worker proofs of the flush wait and the R10 upgrade;
- a commit backlog bound of 512 items, so that one ended connection's leftover work plus a full redelivery fits; a true stall still closes as retryable `BACKLOG_FULL`;
- a validated recording status from the service to main in `AppState.health.recording`;
- its dashboard and tray presentation, with runtime smoke assertions.

No IPC channel, bridge method or preload code is added; only the `AppState` payload type is wider. There is no wire, schema, migration, native, overlay or settings change, and `GAME_HISTORY_RECORDING` stays `false`.

ET-015c settles two items of the enablement list:
- the backlog bound (G11);
- `TRIP_COVERAGE_MISMATCH`, which stays detection after the commit (G15).

The enablement PR still needs the v0 retirement, real-game v1 evidence and the S-1/S-2 decision in ET-016. ET-016 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-015c PR-2 implementation update on October 16, 2026: the commit backlog bound is now 512 items, twice the producer's 256 retained entries. The leftover work of one ended connection plus a full redelivery and live items now fits, so such a reconnection is no longer refused. Before, it was refused, and events were lost as `offline` through the refused reconnection. Leftovers stacked from several connections that ended before the queue drained, or a true storage stall, still close the connection as retryable `BACKLOG_FULL`: bounded and draining. See [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-015c validation](docs/validation/et-015c.md).

ET-015c PR-1 implementation update on October 16, 2026: the service's recording wiring moved unchanged into `apps/desktop/src/recording-runtime.ts`. With it, the storage suite proves the following with the real storage worker and the real shutdown sequence:
- `recording-flush` waits for a commit in flight;
- a live-only connection made while storage is opening reconnects durable once it opens, and its window's events are committed as a `noDurableConsumer` gap (R10);
- a stop during a retryable backoff ends within the stop budget, and a stop while a restore-loss row is in flight waits for that row and acknowledges nothing.

No behaviour changed. See [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-015c validation](docs/validation/et-015c.md).

ET-015c PR-3 implementation update on October 16, 2026: the telemetry service now sends main a validated recording status:
- the state and target;
- a fixed cause code;
- the current trip's phase and completeness;
- the committed loss counts.

Main keeps it in `AppState.health.recording`. It resets the status to `unknown` while the service is not running, and adds the totals across service restarts. A restore loss counted again after a service restart in the same plugin session overstates the totals (TD-004); the database stays correct. No IPC channel, bridge method or preload code changed; only the payload type is wider. Production reports `disabled`, and the dashboard and tray text follow in PR-4. See [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-015c validation](docs/validation/et-015c.md).

ET-015c PR-4 implementation update on October 16, 2026: the Application status card of the dashboard and the tray's second status line show the recording state from `AppState.health.recording`.
- **Dashboard.** It shows the target, with a note that a synthetic or replay database is never game history, the current trip's completeness, and the gaps recorded since ETS2Telemetry started. A restore loss carries the TD-004 upper-bound note. An alert appears for `retrying`, `stopped` and `live-only`.
- **Unknown state.** The `unknown` headline now reads "Not known: the telemetry service is not running or has not reported a valid status", because main also sets `unknown` for a rejected status message. This amends G8's fixed text.
- **Smokes.** The development and packaged smokes assert the default `Off` text. The recording journey asserts the state across the start, a service restart, a dashboard reload, close-to-tray, a tray exit with the main window closed and an application restart.
- **Unchanged.** The overlay, the preloads, IPC channels and bridge methods are unchanged, and `GAME_HISTORY_RECORDING` stays `false`.

See [application lifecycle](docs/app-lifecycle.md) and [ET-015c validation](docs/validation/et-015c.md).

## ET-016 authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-016: the trip journal, trip details and JSON export. It adopted the architect's decisions J1–J22 ([concept.md](concept.md#et-016-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-016 only, this supersedes two earlier statements; earlier dated text is unchanged:
- that ET-016 is not authorized;
- with J9, ET-014's T9: a job seen first in a checkpoint now opens a partial late-attach trip. This follows concept §3 and the owner's answer of October 10, 2026 that late attachment marks trips incomplete.

**ET-016a** is five PRs:
- storage schema v2 with S-1 fuel used, S-2 checkpoint jobs and checkpoint-opened trips, and trip close carriers;
- bounded journal reads in the storage worker;
- journal queries from main through the telemetry service;
- the Journal tab in the main window;
- versioned JSON export through a main-process save dialog.

**ET-016b** is three PRs:
- fuel-used persistence;
- late-attach trips;
- journal and export reconciliation in the recording runtime journey.

How the journal reads and exports:
- It reads the database the telemetry service opened, through its storage worker. That is history in production, or the synthetic or replay recording target, which is clearly labelled.
- Six fixed bridge methods are added. The renderer receives bounded pages and never a path.
- Main owns the save dialog and the export file writer. Cancelling the dialog writes nothing.

`GAME_HISTORY_RECORDING` stays `false`. Once ET-016b merges, the enablement PR no longer waits for S-1/S-2, but it still needs the v0 retirement, real-game v1 evidence and real full-volume and ACL evidence. Next to Export the journal states that an uninstall removes local history and that the JSON export is a copy, which cannot be imported (J18; owner rule recorded on October 16, 2026). ET-017 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-016 implementation update on October 17, 2026: ET-016a and ET-016b are implemented.

**ET-016a**
- Schema version 2: #93.
- Bounded journal reads in the storage worker: #96.
- Journal queries from the trusted dashboard through main to the telemetry service: #97. A storage-side timeout is reported as an unavailable database, because it ends recording for that service.
- The Journal tab with trip details: #98.
- The versioned JSON trip export through a main-process save flow: #101. It refuses targets in the data folder by name, real path and file identity, and states the J18 uninstall note next to Export.

**ET-016b**
- Fuel-used persistence: #95.
- Late-attach trips opened from checkpoints, which supersede T9: #99.
- Journal and export reconciliation in the development and packaged recording journey: #102.

**Technical debt.** TD-006 (trip average consumption), TD-007 (late-attach truck and trailer identity) and TD-008 (the export's trailer list is limited to the latest 10 configurations) record the deferred parts.

**Enablement.** It no longer waits for S-1/S-2, but it still needs the v0 retirement, real-game v1 evidence, and real full-volume and ACL evidence. `GAME_HISTORY_RECORDING` stays `false`.

**Pending checks.**
- The real Windows Save dialog, readability and keyboard use of the Journal tab, and a forced render fault.
- The first real upgrade of the owner's existing version 1 history database, after its verified backup.
- The journal and export against real recorded history.
- Real late-attach checkpoints.
- Every real-game, TruckersMP, display and performance check.

See [journal](docs/journal.md), [trip export](docs/journal-export.md) and [ET-016 validation](docs/validation/et-016.md).

## Uninstall removes local data — October 16, 2026

On October 16, 2026 the owner confirmed that uninstalling ETS2Telemetry removes all of its local data under `%LOCALAPPDATA%\ETS2Telemetry`: the history database and its backups, settings, logs and synthetic recordings. Unsynchronized history is lost until the later server phase can restore it. Only application-owned data and the plugin file this application installed are removed. ET-018 implements this, changing the ET-001 baseline that keeps the data root. The ET-016 journal states the rule next to its JSON export, which is a copy for the user's records and cannot be imported (J18). See [concept.md](concept.md#uninstall-removes-local-data--october-16-2026).

## ET-019t test-suite audit — October 17, 2026

On October 12, 2026 the owner defined ET-019t, a test-suite audit and cleanup, in a comment on the ET-019 card. It does not wait for ET-012, ET-017 or ET-018. Under the standing delegation of October 15, 2026, the coordinator started it on October 17, 2026. That day the owner also approved three changes:
- **Squirrel only on main (E1).** Pull requests package and inspect the application without building the Squirrel distributable; main pushes and manual dispatches still run the full `make`.
- **Development smokes only on main (E2).** Pull requests run only the packaged runtime smokes; the development-mode smokes run on main pushes and manual dispatches.
- **A third required check.** A third Windows CI job, `Windows x64 tests` (lint, PowerShell analysis, typecheck, the Node-safe and storage suites), is added to the required status checks of ruleset `Protect main`, beside the two existing jobs. Run `gh api repos/senukartur/ets2telemetry/rules/branches/main` to see the live rules.

The owner kept `tests/electron/startup.spec.ts`.

The audit maps every test entry point to the regression registry and removes two verified pieces of dead scaffold code: the ET-001 placeholder DLL contract and `isScaffoldStatus`. It rewrites wall-clock-dependent tests so they wait on observable state or controlled clocks, and it seeds the 5,000-amount journal case instead of committing 5,000 transactions. Native MSBuild now builds in parallel, and every CTest run writes JUnit results.

No product behaviour, protocol, schema, IPC or security boundary changes. The scenario coverage stays the same, and the must-not-remove categories are untouched. The measurements and per-test rationale are in [ET-019t validation](docs/validation/et-019t.md). The rest of ET-019 still waits for its prerequisites. No game, TruckersMP, display or performance claim follows.
