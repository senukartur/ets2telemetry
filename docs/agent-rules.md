# Agent Rules

## Start Here

This file holds the rules that apply across tasks. [AGENTS.md](../AGENTS.md), which every agent session loads, keeps only a short summary and points here. Read the sections of this file that a task needs. Dated owner decisions, authorizations and implementation updates go to the [decision log](../DECISION-LOG.md), not here (see [Maintaining this file](#maintaining-this-file)).

Read the short documents whole and the large ones only in the parts a task needs:

- [CONCEPT.md](CONCEPT.md) is short: the product idea, its principles and how each feature works. Read it whole when a task touches product behavior.
- [DESIGN-DECISIONS.md](../DESIGN-DECISIONS.md) holds the earlier full concept and the dated design decision records of each card, with the decision IDs other documents cite (for example K1–K12).
- [TESTING.md](TESTING.md) is short: the testing rules and the permanent regression scenarios. Read it whole before changing behavior or tests. The [test index](regression-registry.md) maps each test entry point to its scenarios.
- [TESTING-HISTORY.md](../TESTING-HISTORY.md) and the [registry history](regression-registry-history.md) hold the earlier per-card test records.
- [DECISION-LOG.md](../DECISION-LOG.md) holds the dated owner decisions that used to be in this file.

List the sections with `rg -n '^## ' DECISION-LOG.md DESIGN-DECISIONS.md TESTING-HISTORY.md`, find a card's records with `rg -n 'ET-015a' DECISION-LOG.md DESIGN-DECISIONS.md TESTING-HISTORY.md docs`, and read those sections with targeted reads.

Keep the two documents consistent. Use `docs/CONCEPT.md` for what the product does and this file for instructions that apply across tasks. Explicit user instructions take precedence over this documentation.

Owner-approved deferred capabilities are tracked in [technical debt](technical-debt.md). An entry there records a future need; it does not expand the current milestone or authorize work outside the MVP scope.

When the owner requests an implementation coordinator, also read [COORDINATOR.md](../COORDINATOR.md). It defines Trello execution, bounded subagent delegation, worktree ownership, independent review, recovery state, and PR handoff. Use the [launch prompt](prompts/coordinator-start.md) to start that role in a separate chat. This role applies only when requested; delegated workers follow their bounded assignments and the repository rules.

In Claude Code, the owner can run a single task through project subagents (architect, implementer, verifier and independent reviewer) with `/deliver`, which ends with a draft PR. See [the delivery pipeline](delivery-pipeline.md). It grants no authority beyond this file.

## Documentation Language

**Write all internal documentation that may be committed to Git in English.** This is an explicit owner requirement.

It applies to Markdown files, agent instructions, plans saved in the repository, architecture notes, decision records, setup guides, API documentation, and explanatory code comments/docstrings. New documents and edits to existing documents must follow this rule.

Continue conversation with the owner in their preferred language, currently Russian. The documentation rule does not select the product's UI language. Preserve proper names, external identifiers, localized game data, and test fixtures where their original values matter.

## Current Project State

Snapshot as of October 28, 2026 (`main` at `ae5ab6a7`). Inspect the actual files before relying on it, and update this section when a merge changes it. The October 10, 2026 baseline and the earlier dated status notes are in the [decision log](../DECISION-LOG.md#current-project-state).

- **Application.** Yukon Union Telemetry (technical name ETS2Telemetry Desktop): Electron, React and TypeScript npm workspaces pinned to Node 24.19.0 and npm 11.17.0 ([setup](setup.md)). It has the Yukon UI ([design](design/README.md)), a tray lifecycle, a live dashboard, Hard Mode, a trip journal with JSON export format 2, and a transparent overlay with four layouts. The settings file is format v11 ([settings](settings.md)).
- **Game integration.** A C++17 SCS SDK plugin serves protocol v0 to the live dashboard and overlay, protocol v1 minors 0–2 for durable events and v1-only live fields, and the evidence-only CAP0 endpoint. A native broker relays the pipes to the telemetry utilityProcess. Silent plugin setup installs the plugin into discovered ETS2 and ATS folders.
- **Recording.** Since October 25, 2026 real ETS2 and ATS sources are configured to record into the history database (SQLite schema version 3): protocol v1 events, gaps, trips and one-second samples, acknowledged only after the commit. The first real recorded trip remains unverified ([enablement validation](validation/game-history-enablement.md)).
- **Distribution.** A Squirrel installer with an explicit uninstall that removes local data, production and staging channels that install side by side, and in-app updates from Ed25519-signed manifests, with the owner's public keys compiled in (#218). `release.yml` is dispatch-only. No release has been published, so a real update from a published release remains unobserved ([releases](release.md)).
- **CI.** Windows CI with three required jobs, plus the non-required extended workflow and the dispatch-only soak ([CI](ci.md)).
- **Real-game evidence.** Partial. The ET-009 prototype gate is accepted with recorded limits. Many real-game, TruckersMP, display, DPI, Narrator and performance checks remain unverified, several of them transferred to ET-042, ET-043 and ET-044. Check the card's record in `docs/validation/` before claiming anything.

## Product Requirements to Preserve

- Build an ETS2 and ATS telemetry utility for a virtual trucking company.
- Target Windows x64 first. TruckersMP compatibility is required; validate single-player as well. The built-in Convoy mode is deferred from the validation matrix by owner decision on October 12, 2026 and is not claimed as supported.
- The MVP is local and works without an account or internet connection: live telemetry, an overlay, a trip journal, and one-second samples.
- Support windowed and borderless fullscreen overlays. Exclusive fullscreen, rendering hooks, and arbitrary game memory reads are outside the MVP.
- Keep website development, accounts, company permissions, server synchronization, and online reporting in the later server phase.
- Visual design follows [the UI specification](design/ui-spec.md) in [docs/design](design/README.md), by owner decision of October 19, 2026. New UI work follows the specification; each package still needs its own card.
- The owner knows React and TypeScript and is new to desktop development. Explain unfamiliar native and desktop concepts clearly.

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

The ET-001 scaffold pins dependencies and defines process boundaries; consult [docs/setup.md](setup.md) and actual check evidence for installed and verified tooling. Distinguish SDK archive versions from API versions and game versions.

Keep telemetry processing and trip accounting separate from React components so they can be tested without the UI. Keep the plugin, application transport, persistence, and overlay responsibilities distinct. Expose narrow typed interfaces across boundaries.

The utilityProcess owns ingestion and source validation. A fixed project-owned native client broker supplies authoritative Windows pipe-peer queries and bounded raw I/O under its supervision; it exposes no arbitrary renderer commands. See [the v0 native boundary](native-transport-boundary-v0.md) for discovery, provenance, flow-control and lifetime requirements. This is a transport implementation detail, not a wire change or game-compatibility claim.

## Implementation Constraints

### Game Integration and Transport

- Keep SDK callbacks short. Copy data in callbacks; perform serialization and transport work on a background thread.
- Call SCS APIs only in the callback context allowed by the SDK. Never call them from the transport worker.
- A missing or slow application must not stall the game. Bound buffers and report event gaps rather than silently treating incomplete data as complete.
- Version the protocol and preserve session identity and message ordering. Validate incoming messages and document the wire format alongside implementation.
- Coalesce live snapshots when appropriate. Preserve gameplay events separately, acknowledge them after persistence, and handle redelivery without duplicates.
- Restrict pipes to the local user and reject remote access.
- Install the DLL in each discovered, non-excluded game's `bin/win_x64/plugins` directory, silently where safe (see the October 12, 2026 silent plugin installation decision in `DESIGN-DECISIONS.md`). Change it only while the game is closed, copy atomically with SHA-256 verification against the bundled artifact, never overwrite an unrecognized file with the plugin's name, and manage only this project's plugin.
- Use real game tests to establish TruckersMP support. Do not infer compatibility solely from successful single-player tests or documentation.

### Overlay and Electron

- Use a transparent window that passes mouse input to the game and does not steal focus while driving.
- Make the overlay topmost with `setAlwaysOnTop(true, 'screen-saver')`. Never use the constructor's `alwaysOnTop` option or Electron's default `floating` level: on Windows they stack the window behind the taskbar and can lose `WS_EX_TOPMOST` over a borderless game. Re-assert the level without activation after each show; see [the minimal overlay z-order](minimal-overlay.md#z-order).
- Track the game window and hide the overlay when the game is minimized or another application is foreground. Account for monitor and DPI changes.
- Keep the display update target of up to **20 Hz** separate from the history sampling rate of **1 Hz**.
- Build main-window UI from the shadcn/ui components in `apps/desktop/src/components/ui`; see [docs/setup.md](setup.md#ui-components-shadcnui). The transparent overlay must not load the shadcn base stylesheet (it paints an opaque `body` background) and does not need interactive Radix components.
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

### Repository and Tools

- The `origin` remote is `https://github.com/senukartur/ets2telemetry.git`.
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The authenticated account has admin permission on the repository; its visibility is recorded under [Repository visibility and license](#repository-visibility-and-license--october-16-2026). The token lives in the Windows keyring. A sandboxed agent shell may be unable to reach the keyring, so `gh auth status` reports "not logged in" there. Run `gh` outside the sandbox instead of asking the owner to authenticate again.
- The repository-local commit identity is `Artur Sianiuk <15032912+senukartur@users.noreply.github.com>`. Pulls require a fast-forward (`pull.ff=only`), and pushes use `push.default=simple`.
- Use Git for local history and synchronization, and GitHub CLI for pull requests and GitHub checks. A GitHub MCP server is not required for this workflow.
- GitHub allows only squash merging and automatically deletes merged task branches. Squash commits use the PR title and body.

### Branches and Scope

- Never implement work or make ordinary commits directly on `main`. Start new tasks from an updated `main` using `git pull --ff-only`; inspect status first and preserve unrelated local work.
- Use one short-lived branch for one coherent task: `feat/<description>`, `fix/<description>`, `docs/<description>`, or `chore/<description>`. Use lowercase English names with hyphens. Reuse the existing task branch when continuing the same task.
- Keep PRs small enough to review independently. Update both plugin and application in the same PR when a shared protocol change requires coordinated compatibility.
- Keep `main` buildable and compatible as implementation progresses. Working in a task branch does not waive the product's acceptance criteria.
- Never commit the ignored temporary Trello planning manifest.

### Commits and Pull Requests

- Write commit messages, PR titles, and PR descriptions in English. Use descriptive prefixes such as `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, or `test:`.
- Start every PR title with the Trello identifier in square brackets, followed by a space and the prefixed summary: `[ET-023b] chore: add PSScriptAnalyzer checks`. Use the work-package ID when the PR implements a package (`ET-023b`, `ET-015a`); otherwise use the card ID (`ET-024`, `SP-01`, `CAP-01`). Use `[NO-CARD]` only for work without a card, and explain why in the PR description. Squash merges use the PR title, so the identifier also lands in `main` history. Rename an older open PR to this format when you next update it.
- Commit and push the task branch, then open a PR targeting `main`. Use a draft PR for unfinished work. CI does not run automatically on draft PRs or on changes limited to `**.md`/`docs/**`. A skipped or absent run is not a passed check. Check a draft head by manual dispatch and record the run link; the run after **Ready for review** on the final head is the merge gate (see [docs/ci.md](ci.md#triggers-and-draft-checks)). Implementation requests authorize the normal branch, commit, push, and PR workflow unless the owner specifies otherwise.
- Follow `.github/pull_request_template.md`. Explain the problem and resulting behavior, report checks actually performed, and identify remaining verification. Do not claim that CI or game testing passed when it did not run.
- Attach or bind the created PR to the current chat or session when the app provides a tool for it (Codex attachment tool, Claude Code desktop PR binding), and provide the PR link to the owner.
- The owner reviews and merges PRs by default. The agent may merge only when the owner explicitly requests or authorizes it; do not infer merge authorization from a request to implement a task or open a PR.
- Merge with **Squash merge** after relevant checks pass and review feedback is resolved as described in [Review Threads](#review-threads). A PR becomes one descriptive commit on `main`; the task branch is deleted after merging.
- After a merge, update local `main` with `git pull --ff-only` before starting the next task. Confirm the PR is merged before deleting a local task branch; preserve any remaining work.

### Review Threads

These rules apply to the agent that addresses review feedback on a PR, whoever wrote the comment (owner, independent reviewer, or another reviewer).

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
- After a release is published, append the shipped plugin DLL hash to `native/telemetry-plugin/released-plugins.json` in a PR before the next release build, as [game plugin setup](plugin-setup.md#released-plugin-list) describes; the shipped artifact is the CI-built one.
- Mark tested releases with version tags such as `v0.1.0-alpha.1` or `v1.0.0`, and include release artifacts and game validation results when available. A merge alone does not publish a release. Create or publish releases only when authorized by the owner.

## Repository visibility and license — October 16, 2026

On October 16, 2026 the owner released the project under the [MIT License](../LICENSE) and decided to make the GitHub repository public, so that standard GitHub-hosted Actions runners stop consuming the private-repository minute quota. The visibility switch is a separate owner action in the GitHub settings; check the current state with `gh repo view senukartur/ets2telemetry --json visibility` instead of assuming it. The vendored SCS SDK headers keep their own license and notice ([vendor](../native/telemetry-plugin/vendor/README.md)).

Once the repository is public, its full Git history, pull requests, review comments, Actions logs and retained artifacts are readable by anyone, and that cannot be undone. Never commit or paste into PRs, comments or logs any secret, token, personal path, account, player or profile data, raw game captures or screenshots. Fork pull requests run Windows CI without repository secrets. Branch protection and rulesets become available on the Free plan for public repositories; the ruleset now in force is described under [Branch protection](#branch-protection--october-16-2026), and the local pre-push hook and the owner merge policy still apply. This decision changes no product scope and no package authorization.

## Branch protection — October 16, 2026

The repository became public on October 16, 2026, and at the owner's request the active repository ruleset `Protect main` (id 25232619) now protects the default branch:

- Deleting `main` and non-fast-forward pushes are blocked, and history must be linear.
- Changes reach `main` only through a pull request merged by squash. No approving review is required in the single-owner setup, but every review thread must be resolved.
- The `Windows CI` jobs `Windows x64 tests`, `Windows x64 scaffold` and `Windows x64 native AddressSanitizer`, reported by GitHub Actions, must pass on the PR head. The owner authorized adding `Windows x64 tests` on October 17, 2026, and the coordinator added it to the ruleset that day, after the ET-019t PR's first Ready run (#103, run 39030712000) reported the job. The branch need not be up to date with `main` first. The advisory Claude review is not a required check.
- The repository admin role may bypass these rules only when merging a pull request (`pull_requests_only`); direct pushes to `main` stay blocked for everyone.

Windows CI does not run on PRs that change only `**.md` or `docs/**`, so their required checks never report. Merge such a PR with `gh pr merge <pr> --squash --admin` only when its diff is limited to those paths, after the review rules above are met. Never use `--admin` to skip a failing, pending or cancelled check on any other PR. GitHub counts a job skipped by its `if` condition, such as the draft skip in the Windows CI jobs, as a passing required check, so the ruleset alone does not prove a real run: the merge gate remains a successful run of all three jobs (`Windows x64 tests`, `Windows x64 scaffold`, `Windows x64 native AddressSanitizer`) on the final head after **Ready for review** ([docs/ci.md](ci.md#triggers-and-draft-checks)). The local pre-push hook remains in place. Inspect the live rules with `gh api repos/senukartur/ets2telemetry/rules/branches/main` before relying on this description.

## Workflow and Verification

Work on the milestone requested by the user. Routine implementation decisions within the agreed requirements do not require repeated confirmation. Discuss changes to product requirements or major architecture before committing to them.

The first implementation milestone is a complete path from game telemetry to a working speed/fuel overlay in both games, including TruckersMP. Subsequent milestones add application behavior, reliable recording, and distribution. The original sequence and acceptance criteria are in sections 9 and 10 of `DESIGN-DECISIONS.md`.

Follow [TESTING.md](TESTING.md) for regression scenarios, test layers, CI/merge policy, and real-game evidence. CI and the recovery suites do not replace the tests that each implementing card owns.

- Lint and static analysis run locally and in Windows CI before the build, with zero allowed findings: `npm run lint:install` and `npm run lint` (ESLint with type-aware rules and renderer/preload import boundaries) and `npm run lint:ps` (PSScriptAnalyzer over every tracked PowerShell file). New or changed code and PowerShell scripts must pass them; exceptions and their reasons are in [docs/setup.md](setup.md#linting).
- The advisory Claude review workflow never counts as approval, a required check or verification evidence.

- Include appropriate behavior tests in the same PR as a feature; retain a reproducing regression test for bug fixes where feasible. Explain justified omissions. Do not add redundant implementation-mirroring tests or application tests for documentation-only edits.
- Use deterministic fixtures and controlled clocks for domain logic; use actual Windows pipes, temporary SQLite files, and the storage worker for integration boundaries. Keep all test data isolated from real user history and game files.
- Preserve historical migration fixtures and explicit expectations for trip completion/completeness, event deduplication, durable ACKs, and missing intervals. Update the scenario-to-test registry as components are implemented.
- A failing existing baseline suite blocks acceptance. Check the current PR commit and run extra migration, packaging, native, or real-game checks when the change affects those boundaries. The merge gate is all three Windows CI jobs, `Windows x64 tests`, `Windows x64 scaffold` and `Windows x64 native AddressSanitizer`; the `Protect main` ruleset requires all three, as described in [Branch protection](#branch-protection--october-16-2026); the owner enforces the rest of this merge policy, so do not claim that the server enforces review, real-game or other acceptance evidence.
- Report flaky outcomes and pending manual checks honestly. Do not silently skip critical tests, replace expected values merely to accept changed behavior, or treat retries/coverage percentages as proof of correctness.

- Inspect the actual project state before choosing commands or editing files. Prefer `rg` for searches.
- Use PowerShell-safe quoting and literal paths. Avoid Unix-only command assumptions in development instructions.
- Add documented setup/build/test commands when the corresponding tooling exists; do not document placeholders as working commands.
- Run checks appropriate to the change. For documentation-only work, inspect content, links, and Markdown structure; do not scaffold application tests.
- For telemetry logic, test units, lifecycle events, duplicates, missing data, and discontinuities using simulation/replay.
- For integration, record the tested game/client versions and display mode. Test both games, the required multiplayer modes, launch order, reconnects, and overlay behavior.
- Measure resource usage and frame-time impact during real sessions. The 200 ms display latency goal is a target until measured.
- If a required game or tool is unavailable, report exactly what was checked and what remains unverified.
- Keep changes focused and preserve unrelated work. Update the relevant documentation when requirements, interfaces or setup change, within the [documentation budget](#documentation-budget).

Consult the primary sources listed in section 12 of `DESIGN-DECISIONS.md` when validating SDK or framework behavior. Examples of other telemetry utilities may help, but receiving them from the owner is not a prerequisite for implementation.

## Uninstall removes local data — October 16, 2026

On October 16, 2026 the owner confirmed that uninstalling ETS2Telemetry removes all of its local data under `%LOCALAPPDATA%\ETS2Telemetry`: the history database and its backups, settings, logs and synthetic recordings. Unsynchronized history is lost until the later server phase can restore it. Only application-owned data and the plugin file this application installed are removed. ET-018 implements this, changing the ET-001 baseline that keeps the data root. The ET-016 journal states the rule next to its JSON export, which is a copy for the user's records and cannot be imported (J18). See [DESIGN-DECISIONS.md](../DESIGN-DECISIONS.md#uninstall-removes-local-data--october-16-2026).

## Standing Owner Rules

These rules summarize the dated owner decisions that still bind all work. Each links to its full text in the [decision log](../DECISION-LOG.md). If a rule here and the log disagree, the latest dated decision in the log governs; correct this section.

Evidence and claims:

- Real-game, TruckersMP, display, DPI, Narrator and performance criteria are met only by real evidence. Never infer them from synthetic, simulator, replay or CI results, from single-player results, from a merge, or from an authorization. Keep pending checks visible as pending; checks transferred to another card stay unverified ([ET-012 closeout](../DECISION-LOG.md#et-012-administrative-closeout-and-code-gates--october-22-2026)).
- An owner acceptance or an administrative Done does not waive code gates: independent review and a successful final Windows CI after Ready still apply. Preserve original failed evidence and unknown causes. Do not repeat accepted game checks as a new gate without a relevant behavior change or finding ([ET-009](../DECISION-LOG.md#et-009-acceptance-and-diagnostic-pr-handoff--october-20-2026)).
- The validation matrix is ETS2 and ATS, each in single-player and TruckersMP, windowed and borderless. Convoy is deferred: neither validated nor claimed, and never advertised ([Convoy](../DECISION-LOG.md#convoy-validation-deferral--october-12-2026)).

Scope and authority:

- Work on a package needs an authorization recorded in the decision log or given by the owner in the conversation. An authorization covers only the package it names; it authorizes no release, later phase or server work. Since October 15, 2026 a standing delegation lets the coordinator start packages and adopt architect decisions until a task needs a real-game test ([delegation](../DECISION-LOG.md#et-005b-authorization--october-15-2026)).
- Merge authority is granted per package and recorded with it, or comes from that standing delegation, under which the coordinator has merged packages (for example ET-010c). A PR that neither covers is merged by the owner.

Recording and data:

- `GAME_HISTORY_RECORDING` is `true` since October 25, 2026: real ETS2 and ATS sources are configured to record over protocol v1 into history; the first real recorded trip remains unverified. Synthetic, replay and fixture sources are never durable in history, and `ETS2TELEMETRY_RECORDING` selects only a synthetic or replay database. Changing the flag is an owner decision ([enablement](../DECISION-LOG.md#game-history-recording-enablement--october-25-2026)).
- CAP0 is evidence-only and default-off. Original captures and sanitized exports stay local; only minimized, anonymized CAP-01-derived fixtures may be committed ([CAP0](../DECISION-LOG.md#cap-01a-evidence-capture-transport--october-12-2026), [replay](../DECISION-LOG.md#et-005b-cap-01-replay-authorization--october-21-2026)).
- Hard Mode qualification is conservative: an observed failure or any required unknown loses the trip's qualification irreversibly, and no grace period is adopted ([Hard Mode](../DECISION-LOG.md#et-026-persisted-setting-decision-and-implementation--october-21-2026)).
- Uninstall removes all local data; see [Uninstall removes local data](#uninstall-removes-local-data--october-16-2026). The public repository must never receive secrets or personal data; see [Repository visibility and license](#repository-visibility-and-license--october-16-2026).

Builds, installers and releases:

- Agent and feature-test builds are staging. Leave `ETS2TELEMETRY_BUILD_CHANNEL` unset, never set it to `production`, and never set `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD`. Never install or run a production-identity build on the owner's machine; install a feature-test build only as staging (`YukonUnionTelemetry-Staging-Setup-<version>.exe`, data root `%LOCALAPPDATA%\ETS2TelemetryStaging`). Production artifacts come only from Windows CI on `main`, and the native plugin trees' `build/other-channel/` DLL is a test artifact that must never be copied into a game ([ET-055](../DECISION-LOG.md#et-055-in-app-updates-and-staging-channel--october-28-2026)).
- Never launch the application unpackaged with `ETS2TELEMETRY_PLUGIN_SETUP=real`: it writes into real game folders. Validation uses only temporary fake Steam and game folders ([ET-017 PR-4](../DECISION-LOG.md#et-017-pr-4-implementation-update--october-17-2026)).
- The installer lifecycle runs in a marked test root on GitHub-hosted runners; it runs locally with `-AllowLocal`, for a staging Setup only, only on the owner's explicit request. The update-from-feed and side-by-side scenarios run on hosted runners only, never under `-AllowLocal`. Agents never run a lifecycle against a real root and never write the production RunOnce value. Installing a staging feature-test build, as the rule above allows, is not a lifecycle run ([ET-018](../DECISION-LOG.md#et-018-authorization--october-18-2026), [ET-055](../DECISION-LOG.md#et-055-in-app-updates-and-staging-channel--october-28-2026)).
- Every release publication needs the owner's explicit authorization; approving a staging `release.yml` environment is the authorization of that staging release. A staging release may come from a Windows CI run on any branch, never a pull request or a fork; production releases only from `main` ([staging from any branch](../DECISION-LOG.md#et-055-in-app-updates-and-staging-channel--october-28-2026)). Agents never generate, hold or use a signing key, never create release environments or secrets, and never dispatch `release.yml`.
- The plugin's protocol v1 minor-2 serving and the application's minor-2 offer must ship in the same release ([ET-052](../DECISION-LOG.md#et-052-authorization--october-26-2026)).

Contracts that tests must preserve:

- Native shutdown keeps a mandatory join even when protected I/O exceeds the measured 1,000 ms target, and allows a pending startup followed by one deferred SDK-thread result. A v0 startup that has not finished within the 1 s SDK-initialization wait is pending, not failed ([ET-011](../DECISION-LOG.md#et-011-closeout-authorization--october-22-2026), [startup budget](../DECISION-LOG.md#v0-startup-budget-hardening--october-13-2026)).
- The service stop sequence keeps its nominal 2,500 ms total. Only the `recording-flush` step may borrow unused registered intake time, and the history close uses the adaptive budget of ET-038 ([shutdown](../DECISION-LOG.md#et-012-corrective-shutdown-authorization--october-21-2026)).

Product identity:

- The user-facing name is **Yukon Union Telemetry**. Technical identities stay unchanged: the `ETS2Telemetry Desktop` productName, the Squirrel ids, executables, data roots, plugin DLL names, pipes, `ETS2TELEMETRY_*` variables, the RunOnce value and the receipt, export and diagnostic schemas ([ET-045h](../DECISION-LOG.md#et-045h-product-name--october-24-2026)).

## Active Authorizations

Open authorizations as of October 28, 2026. Check the Trello board and the decision log for the current state.

| Card | Authorized | Not authorized | Record |
| --- | --- | --- | --- |
| ET-055 | In-app updates and the staging channel, nine PRs; the agent may squash merge each after tests and independent review | Any release or signing by an agent | [ET-055](../DECISION-LOG.md#et-055-in-app-updates-and-staging-channel--october-28-2026) |
| ET-042, ET-043, ET-044 | Hold transferred real-environment checks (multi-monitor and DPI; accessibility, unit profile and close-to-tray overlay; consolidated Review-card validation) | Treating them as passed | [ET-012 closeout](../DECISION-LOG.md#et-012-administrative-closeout-and-code-gates--october-22-2026), [ET-011 closeout](../DECISION-LOG.md#et-011-closeout-authorization--october-22-2026) |

## Documentation Budget

The owner decided on October 28, 2026 to limit the documentation that agents write ([decision](../DECISION-LOG.md#agentsmd-cut-and-documentation-budget--october-28-2026)). Documentation describes how the system works now; the PR and Git history record how it got there.

- **Evidence goes in the PR description.** Commands run, results, measurements, review outcomes, failed attempts and remaining checks belong in the PR description, not in committed files.
- **No new documents** unless the owner asks for one, or a new interface, setup step or user-facing workflow has no place in an existing document. Never commit plans, summaries, handoffs, reports or per-PR notes.
- **Edit in place.** When behavior changes, update the existing document that describes it and replace the outdated text. Do not append dated "update", "implementation update" or "follow-up" paragraphs, and do not add per-card or per-PR sections to `docs/CONCEPT.md`, `docs/TESTING.md` or other documents.
- **`docs/CONCEPT.md` describes features, not work.** Change it only when a feature is added or an existing feature's behavior changes, and then only by adding or editing that feature's short description in place: a few present-tense sentences, with no dates, task IDs, decisions or validation status. A bug fix, refactoring, test or internal change does not touch it.
- **`docs/TESTING.md` holds rules, not results.** Change it only when a testing rule changes or a regression scenario is added. The tests a PR adds are described in its description, and each new test entry point gets one row in the [test index](regression-registry.md), nothing more.
- **Owner decisions** get one short entry at the end of [DECISION-LOG.md](../DECISION-LOG.md), only when the owner decides something; architect or coordinator design decisions go in the PR description.
- **Validation records** in `docs/validation/` are only for real-game or real-environment evidence that must outlive the PR, such as game versions, display modes, owner observations and checks still pending. Keep them short, one file per card.
- **Required updates stay:** the regression registry rows that [TESTING.md](TESTING.md) section 9 requires, the protocol and storage contract documents when a contract changes, and the user guide when user-visible behavior changes.
- **Size.** A documentation change should be much smaller than the code change it describes. If it is not, cut it.

## Maintaining This File

- Do not add dated authorization, acceptance or implementation-update sections here. Record each new owner decision at the end of [DECISION-LOG.md](../DECISION-LOG.md).
- Change this file only when a rule that applies to all work changes: update [Standing Owner Rules](#standing-owner-rules), [Active Authorizations](#active-authorizations) or [Current Project State](#current-project-state) in place, with a link to the log entry. Keep [AGENTS.md](../AGENTS.md) at about 1,000 characters: it holds only the basics every session needs.
- Keep this file under about 45 KB; move a rule that applies only to one area into that area's document instead of growing this file.
