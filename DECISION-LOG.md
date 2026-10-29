# Owner decision log

This file holds the dated owner decisions, authorizations and implementation updates that `AGENTS.md` recorded until October 28, 2026. They were moved here verbatim and in date order, so that the files agents load or read for every task stay short. The text is unchanged apart from links to the rule sections, which now live in `docs/agent-rules.md`.

- Search by card or package ID, for example `rg -n "ET-015a" DECISION-LOG.md`, and read only the matching sections.
- Where two dated decisions conflict, the later one governs. Earlier text stays unchanged as the record.
- `docs/agent-rules.md` summarizes the decisions that still bind work under [Standing Owner Rules](docs/agent-rules.md#standing-owner-rules). If that summary and this log disagree, the latest dated decision here governs and `docs/agent-rules.md` must be corrected.
- Record each new dated owner decision at the end of this file, not in `AGENTS.md`.
- In the moved text, "this file" means the former `AGENTS.md`, whose rules are now in `docs/agent-rules.md`.

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
- GitHub CLI is authenticated as `senukartur` through the Windows credential store and configured as Git's HTTPS credential helper for GitHub. The authenticated account has admin permission on the repository; its visibility is recorded under [Repository visibility and license](docs/agent-rules.md#repository-visibility-and-license--october-16-2026). The token lives in the Windows keyring. A sandboxed agent shell may be unable to reach the keyring, so `gh auth status` reports "not logged in" there. Run `gh` outside the sandbox instead of asking the owner to authenticate again.
- The repository-local commit identity is `Artur Sianiuk <15032912+senukartur@users.noreply.github.com>`. Pulls require a fast-forward (`pull.ff=only`), and pushes use `push.default=simple`.
- Fetch, `git pull --ff-only`, and the initial documentation push succeeded. The published documentation includes `README.md`, `AGENTS.md`, and `concept.md`. The temporary Trello planning manifest stays local and is excluded through `.gitignore`; do not commit it.
- Use Git for local history and synchronization, and GitHub CLI for pull requests and GitHub checks. A GitHub MCP server is not required for this workflow.
- The application and native development toolchains remain unverified.
- GitHub allows only squash merging and automatically deletes merged task branches. Squash commits use the PR title and body.
- GitHub returned HTTP 403 for branch protection and rulesets while the repository was private on the Free plan. Since October 16, 2026 the public repository enforces the `Protect main` ruleset; see [Branch protection](docs/agent-rules.md#branch-protection--october-16-2026).

Coordinator documentation update on October 10, 2026:

- [COORDINATOR.md](COORDINATOR.md) and the [launch prompt](docs/prompts/coordinator-start.md) define the optional owner-requested coordinator role. Local recovery state lives under ignored `.local/`.
- This documentation does not implement an application, configure Trello access, start agents, or add CI. Inspect current implementation and integration availability before running the coordinator.

## Notes formerly inside AGENTS.md rule sections

These dated notes stood inside the rule sections of `AGENTS.md`. They are listed under the section that held them.

### From "Start Here"

Read [CONCEPT.md](docs/CONCEPT.md) before planning or implementing changes. It contains the product requirements, architecture baseline, implementation sequence, acceptance criteria, and research sources. Read [TESTING.md](docs/TESTING.md) before changing behavior or test infrastructure. This file contains repository-wide working instructions and a compact handoff.

### From "Product Requirements to Preserve"

ET-001 scaffold update on October 11, 2026: pinned Node 24.19.0/npm 11.17.0 workspaces, secure React/Electron window, utilityProcess-owned isolated SQLite worker probe, Forge packaging and C++17 x64 placeholder DLL are implemented. Typecheck, 118 Node tests, clean dependency installation, native build/CTest, maker/static inspection and bounded process controls passed on the corresponding frozen inputs. Native install, repair, update, two installed worker/security smokes and uninstall completed normally; composite acceptance includes the separately reviewed corrected uninstall predicate and exact owned cleanup. The original failed wrapper report and an unexplained Playwright launch timeout remain recorded. Independent whole-PR review at 8aa8991 found no actionable issues; final verifier/documentation delta confirmation is recorded separately. Native Windows launches are owner-authorized and no further VM run is required. See [setup](docs/setup.md) and [validation](docs/validation/et-001.md). No protocol, SDK adapter, production history, overlay, CI or game compatibility is established. Longer stability and host-freeze resolution remain unproven. Entries above are dated historical baselines.

ET-022 candidate update on October 11, 2026: Windows CI has actual clean and restored hosted passes with 122 Node tests, placeholder native CTest, Forge make/static inspection and both bounded SQLite-worker smokes. A deliberate assertion failed the intervening job, then was removed. Whole-job times were 199/200 seconds. Earlier real hosted failures and local Electron flakiness remain recorded in [ET-022 validation](docs/validation/et-022.md). Final current-head checks, independent review and owner merge are still required; no game or production-history acceptance follows from CI success.

ET-002a acceptance update on October 11, 2026: Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

Owner sequencing decision on October 11, 2026 initially allowed ET-004a, ET-006a and ET-007 to start on isolated branches based on independently reviewed PR #10/#11 commits, which were unaccepted at that time. Every missing criterion remains pending; this exception does not authorize v1/history or extend scope to ET-008 or later phases.

Owner acceptance update on October 11, 2026: ET-005a was explicitly accepted and PR #11 squash merged as `a9cc9b34f25480226d34b86c2fb5100c55e9312e`, from verified source `00402bb90abfc41da748b9ff629b460d629c9ee8`. ET-006a now continues against accepted ET-002a and ET-005a on updated main. ET-003/ET-004a/ET-007 and SP-01 remain unaccepted; required game, environment and performance checks remain pending. ET-005b still requires ET-002b/CAP-01, so the ET-005 parent card is not Done. This acceptance does not waive other package gates.

Owner decision on October 11, 2026: ET-006a implementation and automated evidence were accepted for squash merge. PR #13 merged as `123663d8186cef7ff4745d9474caab68d3be6fa4` from source `69dba2c`, after final Ready CI run 38174065173 and independent source/raw evidence review passed. ET-006b and mandatory game, environment and performance checks remain pending. The owner requested preparing existing PR #10/#12/#14 for merge; this does not merge or accept those packages, waive their manual criteria or extend scope to ET-008/v1/history.

- Visual design is deferred. Start with a functional, readable UI.

### From "Workflow and Verification"

CI trigger update on October 11, 2026 (ET-024): Windows CI skips draft PRs and changes limited to `**.md`/`docs/**`. Check a draft head by manual dispatch, and treat the run after **Ready for review** on the final head as the merge gate; see [docs/ci.md](docs/ci.md#triggers-and-draft-checks).

ET-023a lint update on October 11, 2026: `npm run lint:install` and `npm run lint` run ESLint 10 with type-aware typescript-eslint rules, React Hooks rules and renderer/preload import boundaries, with zero allowed errors or warnings; Windows CI runs them before the build. TypeScript 7.0 has no compiler API, so the separately locked `tools/lint` package uses Microsoft's side-by-side TypeScript 6.0.2 for linting only; the project still typechecks and builds with TypeScript 7.0.2. Rule exceptions and limits are in [docs/setup.md](docs/setup.md#linting). Feature PRs that merge after ET-023a fix lint findings in their own files. 

ET-023b PowerShell analysis update on October 11, 2026: `npm run lint:ps` runs hash-pinned PSScriptAnalyzer 1.25.0 under Windows PowerShell 5.1 over every tracked `.ps1`/`.psm1`/`.psd1` file with zero allowed findings, locally and in Windows CI before the build. Rule exclusions and scoped suppressions are listed with reasons in [docs/setup.md](docs/setup.md#powershell-script-analysis). New or changed PowerShell scripts must pass it.

ET-001 recovery update on October 11, 2026: packaged worker/native dependency paths, supervised shutdown, bounded structured logs, Job containment and static artifact inspection are implemented. The owner revoked the native launch hold and VM requirement. Native installed scaffold acceptance is recorded, including the original failed wrapper report and separate corrected postcondition/owned cleanup. Historical guest harnesses retain their guards; no further VM execution is planned. Preserve bounded owned launches, isolated test state and unrelated user data. [Validation](docs/validation/et-001.md) records artifact/review identities and the remaining unexplained startup flake. Longer stability, actual games and resolution of the original Windows-wide freezes remain unproven.

ET-002a scheduling update on October 11, 2026: the owner explicitly authorized early protocol v0 implementation and a draft PR from updated `main`, deferring SP-01 real-game checks. SP-01 PR #8 remains draft and unaccepted: ETS2 single-player windowed appearance failed and needs a real retry; Convoy remains pending. Preserve those results. The exception does not authorize protocol v1 or waive other acceptance/merge prerequisites; see [COORDINATOR.md](COORDINATOR.md) and [CONCEPT.md](docs/CONCEPT.md).

AI review update on October 11, 2026: an advisory Claude code review workflow and a root `CLAUDE.md` that imports this file were added. The workflow requires an owner-provided `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` secret; its comments never count as approval, a required check, or verification evidence. The workflow and setup guide were removed on October 17, 2026, then restored on October 18, 2026 (Europe/Warsaw) with `claude-sonnet-5-5` at the owner's request.

Claude review restoration on October 18, 2026: the advisory workflow and setup guide are active again. They do not replace independent review, required Windows CI, or real-game criteria governed by this file and [TESTING.md](docs/TESTING.md).

Follow [TESTING.md](docs/TESTING.md) for regression scenarios, test layers, CI/merge policy, and real-game evidence. ET-001 establishes scaffold tests; ET-022 establishes CI, while ET-019 adds broader recovery coverage later. Neither task replaces tests owned by each implementing card. ET-022 provides a Windows x64 workflow and bounded scaffold runtime checks; clean hosted execution and deliberate failure/restoration are recorded in [ET-022 validation](docs/validation/et-022.md). Final current-head checks, independent review and owner merge remain required. Broader feature regression suites remain pending.

## ET-008 code-acceptance exception — October 12, 2026

The owner explicitly accepts ET-008 code by exception and authorizes the coordinator to integrate PR #21 with current main, preserve Tailwind/shadcn in the main window and the isolated transparent overlay, obtain independent review and a successful final automatic Windows CI after Ready, then squash merge without another confirmation. This supersedes the earlier implementation-only permission for this package. Mandatory game, environment, CAP-01/SP-01 and performance checks remain pending; a code merge does not establish compatibility or complete those criteria. The card remains in Review until its mandatory criteria are accepted. No protocol v1, durable history, later MVP or server work is authorized.

## Owner merge and board-status exception — October 12, 2026

The owner authorized the coordinator to squash merge PR #10 (ET-003), #12 (ET-004a) and #14 (ET-007) without further confirmation once agreed actionable review findings are resolved and the required final Windows CI passes, and directed their corresponding Trello cards to Done. PR #10 was merged as `85d9f83a763f1ca71c2d640dadc5d8fbf2d9e69b` after its exact-head CI and independent review. Integrate accepted main and verify the final candidate before each subsequent merge. This is an explicit administrative status/code-review exception: mandatory game, environment, CAP-01 and performance evidence, SP-01 windowed retry/Convoy, and ET-004b remain pending and are not accepted or implemented by that status. No compatibility, protocol-v1, durable-history or later-phase authorization follows. Keep every missing check visible in the card and ledger. Advisory AI-review execution failures were non-gating; mandatory independent review and Windows checks remain required.

## Minimal overlay continuation — October 12, 2026

After the conditional code-review merges of PR #10, #12 and #14, the owner instructed the coordinator to continue available first-stage work that does not require launching actual games. ET-008 may now implement the maintained minimal overlay from accepted main `6c3af45b039aa9d8bb88a8479728f1212f7a343f` (ET-004a, ET-006a and ET-007). Keep its real-game/input/focus/mixed-DPI/monitor-removal/performance acceptance pending, as well as CAP-01 and SP-01 windowed retry/Convoy. This permission authorizes implementation, isolated automated/controlled validation and a task PR; it does not extend the PR10/12/14 conditional merge or Done exception to ET-008, waive its game gate, or authorize ET-010+, protocol v1, durable history or server work. Reuse the protected v0/typed bridge and current-window authority; the overlay renderer receives no native placement, HWND, filesystem or source-selection authority. Follow physical-client to Electron DIP conversion and preserve independent SDK/window freshness, bounded up-to-20Hz delivery, nonfocus click-through driving mode and hiding on foreground/minimize loss. ET-000 display defaults remain ETS2 metric and ATS US customary, separate from canonical v0 m/s and L; real SDK unit observations remain pending CAP-01.

## CAP-01a evidence capture transport — October 12, 2026

The owner approved the CAP0 evidence-capture direction on October 12, 2026. CAP0 is a separately versioned, default-off, evidence-only contract on its own named pipe, isolated from the frozen v0 live protocol; the v0 handshake, parser, fixtures and overlay path are unchanged. Approved bounds: 64 KiB per packet; a native evidence queue of 128 envelopes and 2 MiB with non-blocking newest-drop and explicit loss counters; an application writer with 2 MiB pending data, 20 MiB per file and a 10-minute default deadline; output in a separate capture directory outside `telemetry.sqlite` and the application binaries. CAP0 has no ACK, offline spool, history, trip effects or renderer authority. Package CAP-01a implements this contract and its tooling without a game; see [the CAP0 contract](docs/protocol/cap0.md) and [CAP-01a validation](docs/validation/cap-01a.md). The production plugin always exposes a passive CAP0 endpoint that copies nothing until the approved broker authenticates; the application enables one capture per launch only through `ETS2TELEMETRY_CAPTURE=cap0`. CAP-01a does not accept CAP-01 or ET-009: real captures from both games and the required modes, sanitized and independently reviewed observations, frame-time impact, and the SP-01 windowed retry remain pending (Convoy is deferred). No protocol v1, durable history or later-phase work is authorized.

## Convoy validation deferral — October 12, 2026

The owner removed the built-in Convoy multiplayer mode from the current validation matrix: the owner does not play Convoy and has no procedure to test it. The matrix for SP-01, CAP-01, the full ET-009 gate and later ET-020 is now ETS2 and ATS, each in single-player and TruckersMP, with windowed and borderless modes. Convoy is deferred, not rejected: it is neither validated nor claimed as supported, and the application must not advertise Convoy compatibility. Earlier dated records that list Convoy as pending keep their historical wording; this decision supersedes those pending Convoy checks. TruckersMP still requires actual game evidence; single-player and TruckersMP results do not establish Convoy behavior.

## v0 startup-budget hardening — October 13, 2026

Owner decision: a v0 transport startup that has not finished within the fixed 1 s SDK-initialization wait is pending, not failed. Official init logs one fixed warning and returns `ok`; the worker keeps starting. The adapter logs its eventual result once on the SDK thread, from the next `frame_end` or from shutdown. Failures reported within the wait still return `generic_error` with one fixed error log. The game never waits longer than before. See [the native transport](docs/native-transport-v0.md) and [the startup-budget record](docs/validation/et-004-startup-budget.md). This is ET-004 hardening only; it establishes no game compatibility and authorizes no protocol v1 or later-phase work.

## CAP-01 and SP-01 acceptance — October 14, 2026

The owner accepted CAP-01 with explicit gaps and accepted SP-01 on October 14, 2026. See [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#cap-01-and-sp-01-acceptance--october-14-2026) and [CAP-01a validation](docs/validation/cap-01a.md#cap-01-acceptance-october-14-2026). The gaps stay pending, not observed. Neither acceptance establishes TruckersMP, display or performance support, or completes the full ET-009 gate. Authorization for later packages, such as ET-002b, is recorded separately.

## ET-002b authorization — October 14, 2026

The owner authorized ET-002b on October 14, 2026 as a contract-only package: the durable telemetry protocol v1 wire specification, its TypeScript schemas and delivery helpers and the shared fixtures (PR-1), then the matching C++17 representation that reads the same fixtures (PR-2). For ET-002b only, this supersedes the "no protocol v1" wording in earlier dated paragraphs. ET-004b, ET-005b, ET-006b, durable storage, trip logic and later phases remain unauthorized. No runtime path changes: v0 stays the live protocol until those packages land, and recording never ships on v0. Real-game, TruckersMP, display and performance criteria remain pending, and Convoy stays deferred. The owner accepted all architect recommendations D1–D17; they are recorded in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#protocol-v1-decisions--october-14-2026), and the wire format is [protocol v1](docs/protocol/v1.md).

## ET-002b acceptance and ET-004b authorization — October 14, 2026

The owner accepted ET-002b on October 14, 2026: PR #42 (`59a2667`) and PR #43 (`2d48c9a`). The owner authorized ET-004b, the plugin's protocol v1 producer, delivered as three PRs in order: the producer core (records, encoder and event store), callback capture and the v1 endpoint. Per D2 the production plugin may serve v1 beside v0; the v1 endpoint stays passive and fail-closed until ET-006b provisions its service policy (OD-2). Game mode is reported as `unknown` until a separate detection package (OD-3). The owner approved the architect recommendations OD-1 to OD-6; the OD-5 wording clarifications S1–S11 are recorded in [protocol v1](docs/protocol/v1.md) and the producer's store rules in [the native v1 transport](docs/native-transport-v1.md). For ET-004b only, this supersedes the statement in the ET-002b authorization paragraph that ET-004b remains unauthorized; earlier dated text is unchanged. ET-005b, ET-006b, ET-013 and later storage, trip logic and later phases remain unauthorized, and the desktop application stays on v0. No game, TruckersMP or performance claim follows from this authorization or from synthetic tests.

## ET-005b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents."

Coordinator interpretation: this instruction is what authorizes starting ET-005b, the protocol v1 simulator, delivered as three PRs: the deterministic simulator core, pipe serving with fault injection, and sanitized CAP-01 replay. For ET-005b only, it supersedes the earlier statements that ET-005b remains unauthorized; earlier dated text is unchanged. CD-1 to CD-12, recorded in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-005b-authorization--october-15-2026), are coordinator decisions under that delegation and were not individually reviewed by the owner. The merge gate (a verifier pass, independent review, no unresolved review threads and a successful Windows CI after Ready on the final head) is the coordinator's self-imposed standard. The simulator opens no database, writes no history, discovery or service-policy file, calls no SDK function and emits only synthetic or replay origins, never `game`. The desktop application stays on v0. ET-006b, ET-013 and later storage, trip logic and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows from the simulator. See [the simulator v1 guide](docs/simulator-v1.md) and [ET-005b validation](docs/validation/et-005b.md).

## ET-013 authorization — October 15, 2026

The owner authorized ET-013 (the SQLite storage worker and schema) on October 15, 2026, in parallel with ET-004b PR C, granted the coordinator merge authority after independent review and a successful final Windows CI, and delegated the ET-013 design decisions to the coordinator, who adopted the architect's recommendations OD-1 to OD-10 ([storage](docs/storage.md#decisions-october-15-2026)). For ET-013 only, this supersedes the October 14, 2026 statements that ET-013 remains unauthorized; earlier dated text is unchanged. ET-013 is delivered as two PRs: the storage core with schema version 1, migrations and verified backups, then the worker integration and the storage measurement. ET-014, ET-015a, ET-015b, ET-015c, ET-006b and ET-016 remain unauthorized by this paragraph; ET-005b is authorized separately in the paragraph above. The desktop application stays on protocol v0, records nothing and sends no ACK. No game, TruckersMP or performance claim follows from this authorization or from synthetic storage tests.

ET-013 PR-2 implementation update (October 15, 2026): the telemetry service opens the history database in its storage worker at start (non-blocking, no TEMP fallback) and closes it in the `storage` shutdown phase; the measured size of 100 hours of 1 Hz history is 53.4 MB, superseding the 60-120 MB model ([storage](docs/storage.md#measured-size-et-013-pr-2), [ET-013 validation](docs/validation/et-013.md)).

## ET-011 authorization — October 15, 2026

Closeout instruction, October 21, 2026: the owner requested moving ET-011 to Review, updating the
card and completing work that needs no owner participation, beginning with the historical launcher
exit timeout and source-selection diagnostics. Keep manual Windows/game acceptance pending. Source
diagnostics describe successful dispatch only, with fixed source/origin facts; they grant no source,
connection or recording authority. Preserve the original failed evidence and the existing exit/Job
bounds; a clean app log is not process termination. See [ET-011](docs/validation/et-011.md).

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-011 and adopted the architect's decisions C1–C17 as coordinator decisions; the owner has not reviewed them individually. They are recorded in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-011-authorization--october-15-2026). ET-011 is delivered as two PRs: ET-011a (tray lifecycle, single instance, explicit exit, health and service shutdown hooks) and then ET-011b (validated persistent settings and per-game unit profiles), which starts from `main` after ET-011a merges. Closing the main window now hides it to the tray and leaves the service and overlay running; only an explicit exit stops them ([application lifecycle](docs/app-lifecycle.md)). The card stays in Review until the manual Windows checks (the real notification-area icon at 100% and 150% scaling, overflow, click/menu/Exit without a ghost icon, Explorer restart, second launch from the Start menu, sign-out/restart) and the real-game overlay checks are accepted; see [ET-011 validation](docs/validation/et-011.md). This paragraph covers ET-011 only; other packages started under the same delegation are recorded in their own paragraphs. It authorizes no autostart, auto-update, cloud synchronization or recording, and synthetic or local checks establish no game, TruckersMP, display or performance claim. Recording survival across close-to-tray (REG-012) still requires ET-015.

ET-011b implementation update on October 15, 2026: per-game display unit profiles are saved in `%LOCALAPPDATA%\ETS2Telemetry\settings\settings.json` (format v1, no startup write, byte-identical quarantine of invalid files, read-only newer versions, synced atomic saves) and applied to the dashboard and overlay through telemetry-core conversions only after a durable save; see [settings](docs/settings.md). The ET-011 manual and real-game checks remain pending.

## ET-010 authorization — October 15, 2026

On October 15, 2026 the owner gave the coordinator standing autonomy: "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under that delegation the coordinator started ET-010 and adopted the architect decisions N1–N16 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-010-authorization--october-15-2026)). They are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. ET-010 is three packages in order: ET-010a (live telemetry normalization and per-game display profiles in `packages/telemetry-core`), ET-010b (the complete live field set on the dashboard, after ET-011a and ET-011b) and ET-010c (protocol v1 fields on the dashboard, after ET-006b). Unit conversion lives in telemetry-core over the canonical units m/s, m, L and L/100 km. The SDK average consumption is never a trip average. Money stays exact raw digits with an SDK-documented or unknown currency. ET-010 changes no v0 wire, preload/IPC, storage, trip logic, recording or later-phase scope, and makes no game, TruckersMP, display or performance claim. Real-source dashboard checks are pending in [ET-010 validation](docs/validation/et-010.md); the field rules are in [live telemetry fields](docs/live-telemetry-fields.md).

ET-010b implementation update on October 15, 2026: the main window shows the complete protocol v0 live field set in a **Live telemetry** card between the status card and the application status card; speed and fuel stay in their existing lines. The card is built from telemetry-core's view model with labels from `apps/desktop/src/strings.ts` and uses the same per-game unit profile as the speed and fuel lines. Coordinator decisions B1–B6 are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-010-authorization--october-15-2026), the rules in [live telemetry fields](docs/live-telemetry-fields.md#dashboard). Real-source dashboard checks remain pending in [ET-010 validation](docs/validation/et-010.md#et-010b-dashboard).

ET-010c implementation update on October 15, 2026: the Live telemetry card adds the rows only protocol v1 carries (route remaining, delivery deadline, source city and company, destination company, cargo mass, market, special job, cargo loaded, license plate, trailers, world position, heading) and a Protocol v1 source section (status, game mode, lost events). They come from a whitelisted v1 projection that the telemetry service attaches to the existing live update as an optional `v1` field. It omits the window handle, clock mapping, delivery cursor and durable status, is validated in main and preload, and expires independently of v0 after 500 ms at each layer. Rows v0 carries stay on v0; with a current v1 observation of the same job (the same cargo and destination city ids), cargo and destination city show their names instead of game ids. Main feeds the same projection into ET-012a's overlay sections: origin, distance remaining and the deadline appear, the destination gains its company and the cargo its mass. A v1 section shows a value only while both v0 and v1 data are current and, for job fields, describe the same job; otherwise it follows ET-012a's L5 rule (a dash if it was shown, hidden if it was not); without a v0 job the job sections are left out. The overlay renderer still receives only formatted text, its preload, layouts and geometry and the overlay IPC are unchanged, and v1 never authorizes overlay placement or visibility. For ET-010c only this supersedes N4's "no bridge, preload or IPC change" and ET-012a L7's statement that the bridge carries v0 only: the live payload type gains the `v1` field, while bridge methods and IPC channels are unchanged. Coordinator decisions F1–F10 and C1–C5 are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-010-authorization--october-15-2026). The default-configuration strip regression found during review is resolved by ET-012c (PR #76, `65eaeb8`). With v1, the default strip (all sections on, 1280×110 at scale 1) keeps all twelve shown sections inside the window on two rows, and the telemetry smoke asserts this containment. Long origin, destination and income values end in an ellipsis. The same holds at scale 2.
In the review-only measurement:
- the Card fits all twelve sections and cuts off the same three values;
- the HUD fits with nothing cut off;
- the Cluster clips one section, game time, out of its 440×220 window.

The Cluster is not the default layout. Under the owner's standing delegation the coordinator merges ET-010c and fixes the Cluster in a follow-up package, ET-012d. No wire, storage, recording or game, TruckersMP, display or performance claim follows; real-source dashboard and overlay checks remain pending in [ET-010 validation](docs/validation/et-010.md).

ET-004b implementation update on October 15, 2026: the producer core (PR #47), callback capture (PR #48) and the v1 plugin endpoint (PR C) are implemented. The plugin serves protocol v1 beside v0 and CAP0, passive and fail-closed until ET-006b provisions `transport\v1\service-policy.json`; the desktop application stays on v0. Synthetic pipe, DLL and AddressSanitizer tests pass locally ([ET-004b validation](docs/validation/et-004b.md)); hosted CI, independent review, owner acceptance, second-user and remote-client rejection, and every real-game, TruckersMP and performance check remain pending.

## ET-006b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-006b, protocol v1 ingestion in the telemetry service, and adopted the architect's decisions E1–E14 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-006b-authorization--october-15-2026)). E1–E14 are coordinator decisions under the owner's delegation and were not individually reviewed by the owner. For ET-006b only, this supersedes the earlier statements that ET-006b remains unauthorized; earlier dated text is unchanged. ET-006b is three PRs: v1 ingestion with a storage-commit ACK pipeline (PR-1), the v1 mode of the native broker, which provisions `transport\v1\service-policy.json` (PR-2), and the connection of the telemetry service to the plugin's v1 endpoint (PR-3, which starts only after PR-1 and PR-2 merge). Production connects v1 live-only beside v0: it writes no history rows, sends no ACK and changes no renderer until ET-015a supplies trip effects and the v0-retirement PR lands. The durable path is exercised only against temporary synthetic databases in tests. ET-014, ET-015a, ET-015b, ET-015c, ET-010c and later phases are not authorized by this paragraph. No game, TruckersMP or performance claim follows from synthetic or local tests.

ET-006b PR-2 implementation update on October 15, 2026: the native broker `telemetry-pipe-client.exe` has a protocol v1 mode (`--protocol v1`) that provisions `transport\v1\service-policy.json`, validates the v1 discovery record and hello, and relays the service's `ack` and `clock.probe` frames through tagged stdin records; no production code path uses it until the service wiring (PR-3). See [the native broker control](docs/telemetry-service-v0.md#native-broker-control) and [ET-006b broker validation](docs/validation/et-006b-broker.md).

ET-006b PR-1 implementation update on October 15, 2026: `V1Ingestion`, the `DurableDelivery` ACK pipeline and `StorageDurableSink` exist in `apps/desktop/src` with unit, actual-pipe, storage-worker and killed-process tests, but the running service does not use them yet; see [the telemetry service v1 ingestion](docs/telemetry-service-v1.md) and [ET-006b validation](docs/validation/et-006b.md).

ET-006b PR-3 implementation update on October 15, 2026: the telemetry service runs protocol v1 beside v0, live-only. For ETS2 or ATS selections it starts the native broker in its v1 mode, with the v1 discovery directory derived from the validated v0 broker configuration (E12); fixtures come only from `ETS2TELEMETRY_SOURCE_PIPE_V1`. The hello requests `durableEvents: false`, no ACK or history row is written, and no preload, IPC or renderer changed, so the dashboard and overlay stay on v0. `npm run test:v1-chain` (Windows CI) checks the broker-provisioned policy, ACK relay and the fail-closed synthetic origin against the test plugin DLL. See [service wiring](docs/telemetry-service-v1.md#service-wiring) and [ET-006b validation](docs/validation/et-006b.md#pr-3-service-wiring). Hosted CI, independent review, the production durable path and every real-game, TruckersMP and performance check remain pending.

## ET-012a authorization — October 15, 2026

On October 15, 2026 the owner reviewed HTML mockups and approved ET-012a: selectable overlay layouts (Strip by default, Card, Cluster, Minimal HUD) and fourteen toggleable overlay sections configured in the desktop settings, which move to format v2. The coordinator adopted decisions L1–L15 under the owner's delegation ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-012a-authorization--october-15-2026)). Main formats every section through telemetry-core in the displayed game's unit profile; the overlay renderer stays display-only and loads no shadcn styles. The bridge still carries protocol v0 only, so sections that need v1 or trip tracking stay hidden. ET-012b, protocol v1 exposure and later phases are not authorized by this paragraph. Each layout's visibility, readability, click-through and focus behaviour above a real game remain pending in [ET-012a validation](docs/validation/et-012a.md); no game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-014 authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-014, the pure trip lifecycle and completeness reducer in `packages/telemetry-core`, and adopted the architect's decisions T1–T20 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-014-authorization--october-15-2026), [trips](docs/trips.md)). They are coordinator decisions and were not individually reviewed by the owner. For ET-014 only, this supersedes earlier statements that ET-014 remains unauthorized; earlier dated text is unchanged. ET-014 is two PRs: the event-driven lifecycle reducer, then readings accounting with simulator replay. It changes no storage schema, wire, preload/IPC, renderer or native code and records nothing; ET-015a wires effects into commits. Behaviour seen in real traces rests only on the reviewed CAP-01 observations O1–O11; train, profile switch, quick-job replacement, late attach after a job started, refuel, teleport, suspend and clock changes are synthetic inferences. ET-015a, ET-015b, ET-015c, ET-016 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

ET-014 PR-2 implementation update on October 15, 2026: the trip reducer accounts readings (T16, T17): observed distance from continuous odometer steps while active, fuel used and refuel episodes, nothing bridged across connection holes (`odometerDeltaM` recorded), observed distance persisted on carriers and before every close, and provisional named thresholds for game-time jumps (crossing or possible sleep), position jumps and 5 s reading holes. Twelve ET-005b scenarios replay against hand-written trip expectations ([trips](docs/trips.md#readings-accounting-t16-t17), [ET-014 validation](docs/validation/et-014.md)). Nothing records yet; the thresholds and every real-game behaviour remain pending.

## ET-012b authorization — October 15, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-012b, the explicit overlay edit mode with per-layout position and scale persisted in the desktop settings, and adopted the architect's decisions M1–M13 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-012b-authorization--october-15-2026)). They are coordinator decisions and were not individually reviewed by the owner. For ET-012b only, this supersedes the ET-012a statement that ET-012b is not authorized; earlier dated text is unchanged. The settings file moves to format v3, which an ET-012a build reads as `newer-version` (read-only defaults). Main owns the edit mode in memory: the overlay is interactive only while it is shown for editing with an own window in front and the game not in front, and driving mode stays click-through, nonfocusable and hidden unless the game is in front. ET-012b changes no protocol, wire, fixtures, native code, broker, storage or trip logic. Multi-monitor, mixed-DPI, monitor-removal and off-screen recovery stay deferred, and every real-game check (dragging and scaling over ETS2 and ATS, single-player and TruckersMP, windowed and borderless, focus transitions and restart restore) remains pending in [ET-012b validation](docs/validation/et-012b.md). No game, TruckersMP, display or performance claim follows from synthetic checks.

## ET-015a authorization — October 16, 2026

On October 15, 2026 the owner wrote (translated from Russian): "Overall, keep doing other tasks until you hit tests in the real game. Make optimal decisions. I want you to close as many tasks as possible without my involvement. If there are flaky tests, delegate their fixes to subagents." Under this standing delegation the coordinator started ET-015a (events and durable ACK) and adopted the architect's decisions R1–R17 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-015a-authorization--october-16-2026)). They are coordinator decisions and were not individually reviewed by the owner. For ET-015a only, this supersedes earlier statements that ET-015a remains unauthorized; earlier dated text is unchanged.

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

On October 16, 2026 the owner decided to fix the overlay strip's overflow first, in a separate package ET-012c, before ET-010c (PR #73) merges. Under that decision and the standing delegation of October 15, 2026, the coordinator adopted the architect's decisions S1–S12 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-012c-strip-overflow-fix--october-16-2026)).

The strip now reserves as many 36 px rows as its enabled sections need at its width. Every strip section has a fixed maximum width, and a longer value ends in an ellipsis, so no enabled section is hidden. The window size depends only on the saved layout, placement and sections and on the game's client area, never on values. A strip that does not fit is hidden as a whole, and edit mode reports `too-large`. The overlay smoke fails when a shown strip section lies outside the overlay window.

ET-012c makes no settings format, IPC, preload, protocol, projection or service change, and the card, cluster and HUD are unchanged. For the strip, M4's height `round(38 × scale)` becomes `ceil(36 × rows × scale + 2 × max(1, scale))`, which equals `ceil((36 × rows + 2) × scale)` at scale 1 or more. Below zoom 1 the row model counts the surface border snapped to one device pixel. Earlier dated text is unchanged. Real-game readability, click-through over the taller window, fractional-DPI rounding and frame-time impact remain pending in [ET-012c validation](docs/validation/et-012c.md). No game, TruckersMP, display or performance claim follows.

## ET-012d overlay layout fit — October 16, 2026

On October 16, 2026 the owner decided to fix the overlay strip first. The coordinator then decided to merge ET-010c and to fix the Cluster in a follow-up package, ET-012d. Under those decisions and the standing delegation of October 15, 2026, the coordinator adopted the architect's decisions K1–K12 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-012d-overlay-layout-fit--october-16-2026)). The owner did not review them individually.

The Card, the Cluster's side panel and the Minimal HUD use fixed row heights, and each reserves its height for its enabled sections. The window is at least its ET-012a nominal size and grows only when the enabled sections need more room. With every section at scale 1 the windows are:
- Card: 300 × 384;
- Cluster: 440 × 267;
- HUD: 320 × 354.

The size never depends on values. A layout that does not fit hides as a whole, and edit mode reports `too-large`. The telemetry smoke asserts that every shown Card, Cluster and HUD section lies inside the overlay window with protocol v1 data.

ET-012d makes no settings format, IPC, preload, projection, protocol or service change, and the strip is unchanged. For the Card, Cluster and HUD, M4's height `round(nominal × scale)` becomes `max(round(nominal height × scale), ceil(content × scale + 2 × border × max(1, scale)))`. Widths are unchanged, and earlier dated text is unchanged.

Real-game readability of the taller layouts, click-through over them, fractional-DPI rounding and frame-time impact remain pending in [ET-012d validation](docs/validation/et-012d.md). No game, TruckersMP, display or performance claim follows.

## ET-015b authorization — October 16, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015b, one-second history. It adopted the architect's decisions H1–H17 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-015b-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-015b only, this supersedes earlier statements that ET-015b remains unauthorized; earlier dated text is unchanged.

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

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-015c, integrated recovery. It adopted the architect's decisions G1–G20 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-015c-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-015c only, this supersedes three earlier statements; earlier dated text is unchanged:
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

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-016: the trip journal, trip details and JSON export. It adopted the architect's decisions J1–J22 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-016-authorization--october-16-2026)) as coordinator decisions; the owner did not review them individually. For ET-016 only, this supersedes two earlier statements; earlier dated text is unchanged:
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

## ET-019t test-suite audit — October 17, 2026

On October 12, 2026 the owner defined ET-019t, a test-suite audit and cleanup, in a comment on the ET-019 card. It does not wait for ET-012, ET-017 or ET-018. Under the standing delegation of October 15, 2026, the coordinator started it on October 17, 2026. That day the owner also approved three changes:
- **Squirrel only on main (E1).** Pull requests package and inspect the application without building the Squirrel distributable; main pushes and manual dispatches still run the full `make`.
- **Development smokes only on main (E2).** Pull requests run only the packaged runtime smokes; the development-mode smokes run on main pushes and manual dispatches.
- **A third required check.** A third Windows CI job, `Windows x64 tests` (lint, PowerShell analysis, typecheck, the Node-safe and storage suites), is added to the required status checks of ruleset `Protect main`, beside the two existing jobs, as authorized by the owner on October 17, 2026. The coordinator applied it on October 17, 2026, after the PR's first Ready run reported the job. Run `gh api repos/senukartur/ets2telemetry/rules/branches/main` to see the live rules.

The owner kept `tests/electron/startup.spec.ts`.

The audit maps every test entry point to the regression registry and removes two verified pieces of dead scaffold code: the ET-001 placeholder DLL contract and `isScaffoldStatus`. It rewrites wall-clock-dependent tests so they wait on observable state or controlled clocks, and it seeds the 5,000-amount journal case instead of committing 5,000 transactions. Native MSBuild now builds in parallel, and every CTest run writes JUnit results.

No product behaviour, protocol, schema, IPC or security boundary changes. The scenario coverage stays the same, and the must-not-remove categories are untouched. The measurements and per-test rationale are in [ET-019t validation](docs/validation/et-019t.md). The rest of ET-019 still waits for its prerequisites. No game, TruckersMP, display or performance claim follows.

## ET-017 authorization — October 17, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-017: game discovery, silent plugin setup and diagnostics. It follows the owner's [silent plugin installation](DESIGN-DECISIONS.md#silent-plugin-installation--october-12-2026) decision of October 12, 2026. The coordinator adopted the architect's decisions P1–P20 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-017-authorization--october-17-2026)) as coordinator decisions. On October 17, 2026 the owner agreed explicitly to P11 (excluding a game in the application removes its plugin; closing a game never does) and P12 (no elevated helper); the owner did not review the other decisions individually.

For ET-017 only, this supersedes the earlier statements that ET-017 is not authorized; earlier dated text is unchanged. ET-017's card prerequisites, ET-009 and ET-011, are not accepted, and their real-game checks stay pending.

ET-017 is six PRs:
- PR-1 bundles the plugin DLL with a SHA-256 manifest and checks it in the package inspection;
- PR-2 discovers ETS2 and ATS through the Steam library list and validates a manual game folder;
- PR-3 installs, updates and removes only the owned plugin atomically, and records each install in a registry;
- PR-4 runs silent setup in main and exposes per-game state;
- PR-5 adds a small per-game plugin card on the dashboard;
- PR-6 adds connection diagnostics and an opt-in diagnostic bundle export.

Setup behaviour:
- **Ownership.** The application replaces or removes only a file whose hash it recognizes. A recognized hash is the bundled one, a released one, or the one recorded in the registry for that game folder. It never overwrites an unrecognized file with the plugin's name, and it leaves other plugins untouched.
- **Running games.** It changes nothing while the game or TruckersMP is running.
- **Excluding a game.** This removes the application's own plugin from that game when it is safe.
- **No elevated helper.** A protected game folder gets a manual copy alternative; the helper is technical debt.
- **Install registry.** `%LOCALAPPDATA%\ETS2Telemetry\plugins\setup.json` holds the exclusions, a manual folder per game, and an install record. ET-018 uses that record for uninstall cleanup. `settings.json` keeps its format.
- **Real-folder safety.** A fail-closed mode gate keeps development runs, smokes and tests from ever writing to real game folders. Only temporary fake Steam and game folders are used in validation.
- **Renderer.** It receives no paths, only per-game states and fixed codes.

There is no wire, schema, recording, overlay or native-source change, and `GAME_HISTORY_RECORDING` stays `false`. Real Steam libraries, real ETS2 and ATS installs loading the silently installed plugin, TruckersMP detection, and protected or ACL-restricted libraries all remain pending manual checks. ET-018 and later phases are not authorized by this paragraph. No game, TruckersMP, display or performance claim follows.

## ET-017 PR-4 implementation update — October 17, 2026

PR-4 runs silent plugin setup from Electron main and exposes per-game plugin states through the application state. The renderer receives fixed codes and counts only, never paths. Setup starts 2 s after launch and is never awaited by startup. It runs one setup run at a time and each run is bounded to 30 s. The running-game listing is bounded to 10 s.

Setup polls every 15 s only while one of these holds:
- a running game, a running TruckersMP client or a locked file blocks a target;
- the running-game listing failed;
- a run hit its 30 s limit.

This extends P13, which named only running games and locks. A poll writes nothing until its own listing succeeds. Steam game folders beyond the per-game target bound are counted, never shown as paths. Excluding the game still removes this application's recorded plugin from those folders.

The P15 mode gate decides where setup may write:
- **Active mode** requires that no isolation variable and no test root is set. The isolation variables are `ETS2TELEMETRY_PROFILE_DIR`, `ETS2TELEMETRY_DIAGNOSTIC_DIR`, `ETS2TELEMETRY_LIVE_SMOKE` and `ETS2TELEMETRY_SOURCE_KIND`; the test root is `ETS2TELEMETRY_PLUGIN_SETUP_ROOT`. Under that condition:
  - a packaged launch is active when `ETS2TELEMETRY_PLUGIN_SETUP` is unset;
  - any launch, packaged or unpackaged, is active when `ETS2TELEMETRY_PLUGIN_SETUP` is exactly `real`.

  Only active mode touches real Steam libraries and game folders.
- **Disabled mode** applies to every other launch, including `npm run dev` without `=real`, tests, and every smoke or diagnostic harness. Any non-empty value of `ETS2TELEMETRY_PLUGIN_SETUP` other than exactly `real` disables setup.
- **Test-root mode** applies when two conditions hold: `ETS2TELEMETRY_PLUGIN_SETUP_ROOT` names a fake root that holds the test-root marker file, and an isolated profile is set. In this mode, every file operation and the install registry are confined to that root. A root without the marker turns setup off for that run.

The details are in [plugin setup](docs/plugin-setup.md). The repository's checks never run active mode, and an unpackaged launch with `=real` writes into real game folders, so agents must not use it. Real Steam libraries, real ETS2 and ATS installs loading the silently installed plugin, TruckersMP detection, and protected libraries remain pending manual checks. No game, TruckersMP, display or performance claim follows.

## ET-017 implementation update — October 17, 2026

All six ET-017 PRs are implemented:
- PR-1 (#104) bundles the plugin;
- PR-2 (#105) adds Steam discovery and the manual folder check;
- PR-3 (#106) adds the atomic installer and the install registry;
- PR-4 (#107) runs silent setup in main, behind the P15 mode gate;
- PR-5 (#108) adds the Game plugin card on the Live tab and the `plugin` runtime smoke against a fake test root;
- PR-6 adds the connection diagnosis on the card and the opt-in diagnostic bundle. The bundle is saved only through main's Save dialog, is redacted, is at most 2 MiB and is never uploaded.

The deferred parts are TD-009 (an elevated copy helper), TD-010 (path-aware running-game detection) and TD-011 (in-app replacement of an unrecognized plugin file) in [technical debt](docs/technical-debt.md).

The card stays in Review. Its prerequisites ET-009 and ET-011 are not accepted, and every real-environment check remains pending ([ET-017 validation](docs/validation/et-017.md)):
- real Steam libraries;
- real ETS2 and ATS installs loading the silently installed plugin;
- TruckersMP process names;
- protected or ACL-restricted libraries, and antivirus;
- the real folder and Save dialogs and Explorer;
- the card's readability.

`GAME_HISTORY_RECORDING` stays `false`. ET-018 and later phases are not authorized by this update. No game, TruckersMP, display or performance claim follows.

## ET-018 authorization — October 18, 2026

Under the owner's standing delegation of October 15, 2026 (quoted in the ET-015a authorization above), the coordinator started ET-018 on October 18, 2026: Windows packaging, safe upgrades and explicit uninstall. It implements the owner's [uninstall rule of October 16, 2026](docs/agent-rules.md#uninstall-removes-local-data--october-16-2026) and the uninstall contract in [game plugin setup](docs/plugin-setup.md).

The coordinator adopted the architect's decisions U1–U17 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-018-authorization--october-18-2026)). On October 18, 2026 the owner decided these questions explicitly:
- **Signing (O1).** Builds are an unsigned internal alpha for now; nothing is bought. After the first alpha release the project applies to the SignPath Foundation.
- **Distribution (O2).** A GitHub Releases pre-release on the public repository. Every publication needs the owner's explicit authorization.
- **Deferred cleanup (O3).** When a Windows-initiated uninstall cannot remove the plugin, for example because a game is running, a retained Windows PowerShell 5.1 script registered under HKCU RunOnce finishes the cleanup at the next sign-in. It checks hashes and stops after 10 attempts.
- **Electron's Roaming folder (O7).** `%APPDATA%\ETS2Telemetry Desktop` is removed, best effort, in production installs only.

The owner did not review the other decisions individually.

For ET-018 only, this supersedes the earlier statements that ET-018 is not authorized; earlier dated text is unchanged.

**Safety.** The uninstall engine derives its folders from its own install location, never from `%LOCALAPPDATA%` alone. It refuses when they differ (U3), so a test install can only ever wipe its own test root. The ET-001 host installer harness, which used the real roots, is retired. Installer lifecycle tests run only in a marked test root on GitHub-hosted runners, and never on the owner's machine without an explicit owner request.

**Delivery.** Six PRs:
1. a test-root installer lifecycle that proves upgrade and repair keep history and settings;
2. the uninstall engine;
3. our own Squirrel event handling, with cleanup on Windows-initiated uninstall;
4. in-app uninstall with data-loss warnings;
5. the deferred cleanup at the next sign-in;
6. the release artifact identity and signing status.

**Not authorized by this paragraph:** no release is published, no certificate or paid service is bought, and no auto-update is added. `GAME_HISTORY_RECORDING` stays `false`.

**Pending manual checks.** A clean Windows machine, real Steam libraries and game folders, uninstall while a real game or TruckersMP runs, Smart App Control and antivirus behaviour, and the owner's first real history upgrade remain pending. No game, TruckersMP, display or performance claim follows.

## ET-018 implementation update — October 18, 2026

All six ET-018 PRs are implemented:
- PR-1 (#117): an installer lifecycle in a marked test root. It runs on GitHub-hosted runners, and locally only with `-AllowLocal` on the owner's explicit request. It shows that install, repair and update keep history and settings.
- PR-2 (#118): the uninstall engine, which works in this order:
  1. derive its folders from the install layout (U3);
  2. preflight;
  3. write an intent;
  4. remove only plugin files whose hash it recognizes, following the ET-017 contract;
  5. wipe the allowlisted data, with `plugins\` and `uninstall\` last.
- PR-3 (#120): our own Squirrel event handling, in place of electron-squirrel-startup. A Windows-initiated uninstall closes a running instance, removes the plugin and the local data, and writes a path-free receipt. If a game runs, or a lock or permission blocks the cleanup, it defers explicitly.
- PR-4 (#122): **Uninstall ETS2Telemetry** on the Live tab. It has a data-loss warning and a native confirmation that defaults to Cancel, and it refuses while a game runs. After an orderly exit it wipes the data, shows the result, and hands over to Windows' uninstall for the program files. The new [user guide](docs/user-guide.md) describes both uninstall paths.
- PR-5 (#123): the deferred cleanup at the next sign-in (O3). An HKCU RunOnce entry runs a retained Windows PowerShell 5.1 executor. It applies the same ownership rules as the engine, which a shared case table checks, and it stops after 10 attempts with a README.
- PR-6 (#121): `release-identity.json` records the source commit, the versions, the hashes and the Authenticode status of every PE image. It fails on a `HashMismatch` or `UnknownError` Authenticode status and on native code packed inside the asar archive. The [release checklist](docs/release.md) covers the unsigned internal alpha (O1, O2).

The hosted installer lifecycle runs these scenarios in a test root. All of them passed together on the `main` push after the last merge ([39153876794](https://github.com/senukartur/ets2telemetry/actions/runs/39153876794), see [final hosted results](docs/validation/et-018.md#final-hosted-results-october-18-2026)):
- install, repair and update;
- three Windows-initiated uninstalls: with the app running, with a fake game running (deferred) and after a reinstall;
- the deferred executor, first while blocked and then to completion;
- both in-app scenarios: refused while a fake game runs, and complete with the `Update.exe` handover.

No installer, `Update.exe` or `--squirrel-*` command ran on the owner's machine. The deferred executor ran there only in temporary test roots (`Test-DeferredCleanup.ps1`), never against a real root, and the real RunOnce key was never written.

The deferred parts are in [technical debt](docs/technical-debt.md):
- TD-012: in-place restore of the history database;
- TD-013: Squirrel vendor residue in the binary root;
- TD-014: code signing (SignPath Foundation after the first alpha);
- TD-015: packaging only the win32-x64 better-sqlite3 binding.

The card stays in Review. Every real-environment check remains pending, among them ([ET-018 validation](docs/validation/et-018.md)):
- a clean Windows machine;
- the native dialogs, and Settings and Control Panel uninstall of a real installation;
- real shortcuts, the Roaming folder removal of a production install, and the uninstall card's readability;
- the RunOnce executor at a real sign-in;
- SmartScreen, Smart App Control, antivirus or EDR, and a Group Policy execution policy;
- non-ASCII and long profile paths, and a second user sharing a Steam game folder;
- real Steam libraries, and a real game or TruckersMP running during an uninstall;
- the owner's first real history upgrade.

Nothing has been published. A release needs the owner's authorization under O2. `GAME_HISTORY_RECORDING` stays `false`. Later phases are not authorized by this update. No game, TruckersMP, display or performance claim follows.

## Desktop UI design target — October 19, 2026

The owner asked for a final mockup of the desktop application and the overlay in the Yukon Union community style, including the Hard Mode status of [ET-026](https://trello.com/c/Cl5oNGTw), and chose: files in the repository, English with a proposed Russian translation, the "Yukon Union Telemetry" brand, and screens for Live, the Hard Mode checklist, Journal, Trip details, Settings, account and sync (server phase), first run, and empty and error states. The result is [docs/design](docs/design/README.md): [the UI specification](docs/design/ui-spec.md) with spec ids and data bindings, [design tokens](docs/design/tokens.css) and an [interactive mockup](docs/design/mockup.html). For the visual design, this supersedes "Visual design is deferred" in the product requirements above; earlier dated text is unchanged. New UI work follows the specification. The design changes no product requirement, contract or acceptance criterion and authorizes no implementation, autostart, localization framework or server-phase work; each package needs its own card. The open points are in [§11 of the specification](docs/design/ui-spec.md#11-open-points-for-the-owner).

## ET-019 implementation update — October 19, 2026

Under the owner's standing delegation of October 15, 2026, the coordinator delivered the rest of ET-019, cross-component recovery and regression coverage, from October 18 to 19, 2026. The coordinator adopted the ET-019 plan decisions D3–D5 (D3 measure, then gate; D4 campaign sizes; D5 seeded mutation fuzzing); D6, a synthetic-content history-purpose fixture, was adopted but no PR needed it. These plan labels are not the protocol v1 decisions D1–D17 in concept.md. The owner approved D1, an extended CI job, and D2, a dispatch-only soak, on October 18, 2026. Every PR changed tests, test tools, CI or docs only: no product source, protocol, schema or IPC changed, and `GAME_HISTORY_RECORDING` stays `false`.

Delivered work:
- **History invariants and kill campaigns.**
  - PR-1 (#126): history invariants I1–I5 and a seeded killed-recorder campaign.
  - PR-2 (#127): kills of the storage open during backup and migration.
- **Producer losses, stalls and replays.**
  - PR-3 (#129): producer losses recorded as visible partial trips.
  - PR-4 (#132): shutdown and close stalls.
  - PR-5 (#133): lifecycle scenarios replayed into the journal and the export.
- **Refusing databases it cannot use.**
  - PR-6 (#139): the newer, foreign, locked or unbackupable database refused through the service wiring.
  - PR-7 (#140): the refusal shown in the packaged journal.
- **Process death and parser fuzzing.**
  - PR-8 (#141): the broker and the fake game host ended mid-session.
  - PR-9 (#142): seeded mutation fuzzing of the TypeScript frame parsers.
- **CI evidence.**
  - PR-10 (#144): a separate, non-required workflow, `windows-extended.yml`, that runs 200 recovery seeds, 200,000 fuzz inputs per case and the native fuzz cases at x50 on every `main` push and on dispatch.
  - PR-11 (#143): Job peak memory and cold-launch phases recorded for every runtime smoke.
- **The soak** (PR-12a: #145, PR-12b: #146). A bounded-memory soak source in the simulator, and a dispatch-only workflow, `windows-soak.yml`, that soaks the packaged application against it for 1 to 90 minutes. Hand-written expectations are checked against the stored rows, while memory, growth and log use are recorded only.
- **Flaky-test fixes found on the way:** #125, #130, #131, #134, #136, #137 and #138.

Hosted results:
- The 30-minute application soak stored exactly the expected 183 events, 30 trips, 1,524 cycle samples and the 19-sample tail, with no gap.
- The 90-minute application soak passed. The telemetry service's memory trend after the warm-up was flat (−1.3 MiB/h), while Electron main grew about 11 MiB per hour (r² 0.99). That growth is recorded as an observation for its own investigation, not a threshold (ET-019 plan decision D3).
- The extended workflow's first own run passed in 14.5 minutes, and its second in 24.3 minutes.

See [ET-019 validation](docs/validation/et-019.md).

The card stays in Review. These gaps remain open and are recorded, not fixed. TD-016, TD-018 and TD-019 were found by these tests; TD-017 is a deferred test-tooling item; G5, G10 and G18 were deferred to ET-019 by ET-015c:
- TD-016: a replayed gap's stale checkpoint;
- TD-017: coverage-guided and native fuzzing;
- TD-018: a broker that exits mid-session is not restarted;
- TD-019: stale discovery records accumulate, so after enough game crashes the broker fails closed (resolved on October 19, 2026 by ET-033: the broker now sweeps demonstrably stale discovery records during directory enumeration before counting live records toward the 256-entry / 128-record bounds);
- G10: no automatic re-open of history after it stopped;
- G18: a history close slower than the 800 ms grace is terminated and reported unclean, so the service exits 1, though nothing committed is lost (resolved on October 20, 2026 by ET-038: adaptive stop budget cascading in `ShutdownSequence` grants `history-storage` unused budget from earlier prompt phases, expanding close grace up to ~2,250 ms so slow orderly closes finish cleanly without expanding the total 2,500 ms stop bound);
- G5: no service heartbeat, so a hung telemetry service keeps its last recording status;
- a kill between a backup's rename and its manifest can leave a manifest-less backup (PR-2, an uncovered kill point).

Each needs its own card. Thresholds for resource use wait for more hosted runs (ET-019 plan decision D3). Real recording into history, CPU and frame time beside a game, TruckersMP, one-hour real sessions and a real power loss remain pending (ET-020). ET-020 and later phases are not authorized by this update. No game, TruckersMP, display or performance claim follows.

## ET-009 acceptance and diagnostic PR handoff — October 20, 2026

The owner accepted the full ET-009 prototype gate and moved the card to Done after reviewing the
[closeout](docs/validation/et-009.md). Functional-matrix, latency and performance exceptions retain their
recorded measurement limits. Multi-monitor, mixed-DPI and monitor-removal validation moved to
[ET-042](https://trello.com/c/GmLKrK10) for later execution and remains unverified. Intentional TruckersMP
disconnect plus console-assisted manual server re-entry passed in both games; automatic network-loss
recovery is not inferred. SP-01/CAP-01 acceptance and CAP-01's recorded gaps remain unchanged.

The owner subsequently authorized taking diagnostic PR #157 through independent review, final automatic
Windows CI after Ready and squash merge. Card acceptance does not replace those code gates, authorize a
release, or accept other cards. Preserve the frozen local evidence; do not repeat accepted game checks as
a new gate without a relevant behavior change or finding.

## ET-038 implementation update — October 20, 2026

ET-038 resolves product gap G18 by introducing adaptive stop budget cascading in `ShutdownSequence`. When earlier shutdown phases (`intake` and `flush`) complete promptly (<50 ms), the remaining sequence budget up to 2,500 ms `SERVICE_STOP_BUDGET_MS` cascades to `history-storage`, expanding the history close grace from the nominal 800 ms baseline up to ~2,250 ms (retaining a 200 ms termination reserve). Other storage steps maintain their registered nominal budgets.

Under this adaptive cascading:
- A slow close that takes up to ~2,250 ms finishes cleanly, logs `HISTORY_STORAGE_CLOSED` and allows the service to stop with exit code 0 (`tests/storage/shutdown-stalls.test.ts` case b1).
- A stalled close (held indefinitely) is terminated after the expanded ~2,250 ms grace and exits 1 unclean, strictly bounded within `SERVICE_STOP_BUDGET_MS` plus loop clock slack, without hanging service shutdown and preserving all committed events in the WAL (`tests/storage/shutdown-stalls.test.ts` case b2).
- Unit tests (`tests/unit/shutdown-sequence.test.ts`, `tests/unit/history-storage.test.ts`, `tests/unit/storage-client.test.ts`) verify that the adaptive budget calculation strictly enforces total sequence bounds and scales down when earlier phases consume their budgets.

See [ET-038 validation](docs/validation/et-038.md). No protocol, schema, IPC, or game integration was changed.

## ET-026 persisted-setting decision and implementation — October 21, 2026

The owner accepted observed persisted-setting verification and configured skilled parking plus manual delivery. Twelve configured rules use the observed current cvars, unchanged numeric thresholds, `g_simple_parking_doubles == 0` and `g_parking_difficulty == 2`. Final qualification additionally requires a delivered event with available `autoParkUsed == false`; actual Expert placement is not claimed. Unpersisted runtime settings and transient changes between observations are outside the evidence model. An observed failure, unknown, source/profile switch or interruption irreversibly loses the trip's qualification; later settings cannot restore it.

[Hard Mode](docs/hard-mode.md) implements bounded read-only local/Cloud profile observation, pure evaluation, irreversible trip audit, schema 3, narrow dashboard IPC, parameter hints/journal UI and JSON export 2. Historical schema/fixture bytes stay frozen and historical trips default false/null. `GAME_HISTORY_RECORDING` stays false, wires/native transport are unchanged, and future server mapping is documentation only. The owner authorized implementation, all checks, independent review, Claude feedback, final automatic Ready CI, squash merge and Done without limiting fix/review rounds; this entry does not assert those gates already passed. Remaining real-environment/history/performance checks retain their recorded status in [ET-026 validation](docs/validation/et-026.md).

Latest owner UI decision, October 21, 2026: retain noninteractive hover/keyboard hints on all twelve parameter names and restore the mockup's accessible 470px checklist drawer, View checklist and Check again controls. This supersedes the earlier no-drawer refinement; its evidence remains historical. All Hard Mode labels, states, reasons, notices and trip audit explanations use the accepted ET-029 EN/RU framework and selected language. SDK cargo/city/company/truck names, raw cvars and stored audit/protocol enums stay unchanged. Causal post-read protocol-v1 clock-probe evidence and bounded intake captures prevent queued/old events from borrowing later file proof; pending openings retain the first observed loss through retry. Scan intervals and coverage expiry use client monotonic time; UTC is an audit label only. See [Hard Mode](docs/hard-mode.md).

ET-026 Claude follow-up: freshness eligibility is frozen at synchronous intake/offer on the service's monotonic boundary and carried as validated private storage metadata; the worker never re-ages frozen proof using commit UTC. Main's cache uses its own monotonic receipt age and service lifetime. Any required unknown still irreversibly loses qualification, including one transient process-query/changing-file failure or a log exceeding 4MiB; no grace period is adopted. Up to two CIM process queries per second, real CPU/frame-time impact and actual log growth remain measurement limits. See [Hard Mode](docs/hard-mode.md#conservative-loss-and-measurement-limits).

ET-026 review follow-up: the production HistoryStorage adapter forwards private freshness unchanged. Ordered observer publications select latest by actual FIFO publication order regardless of UTC; queued frozen captures/close/gap reapplication preserve published latest while first loss remains irreversible. Real-worker adapter and app journeys keep compliant trips open across multiple persisted passing refreshes before positive delivery.

ET-026 Claude2 follow-up: private assessment publications carry only their bounded remaining monotonic lifetime; main consumes it on its own clock, and trip-only updates cannot renew proof. Strict invalid metadata and service retirement fail closed without changing renderer/native/storage contracts. The shared 2000ms read-plus-bind deadline, two sequential 1500ms process-query bounds, three-second coverage and four full bounded log reads retain their unmeasured false-loss/cost limits; no optimization or grace period is adopted.

## ET-005b CAP-01 replay authorization — October 21, 2026

The owner explicitly approved CD-7: commit minimized anonymized CAP-01-derived fixtures; original captures and sanitized exports remain local. The owner authorized completing ET-005 through implementation, checks, independent review, Claude feedback, final automatic Windows CI and squash merge, then Done. This removes the earlier pending acknowledgement for PR-3 only. The replay importer and five derived runs are described in [simulator v1](docs/simulator-v1.md#cap-01-replay-october-21-2026). Existing CAP-01 evidence/gaps stay frozen; no new game sessions, real user history, release, wire, native or storage changes are authorized by this task.

## ET-028 Yukon UI implementation candidate — October 21, 2026

The assigned ET-028 candidate implements the approved Yukon dark desktop shell/screens, bundled Onest, local routing, settings panels, truthful placeholders, bounded sample-page chart and independently styled four-layout overlay. Existing game-provided names remain exact in EN/RU; raw protocol/audit/cvar evidence and money digits/currency are unchanged. The working source selector is in Settings → Data. One dashboard-lifetime Hard Mode controller retains the accepted drawer/hints; no qualification, source proof or recorder behavior changes.

`GAME_HISTORY_RECORDING` stays false. Protocol/preload/storage/schema/native and package/data identities are unchanged. Current automated/visual evidence and failed attempts are recorded in [ET-028 validation](docs/validation/et-028.md); full verifier, independent code/visual review and hosted draft CI remain delivery gates. Manual native-caption/DPI/game-overlay/performance checks remain unverified. This is implementation status, not ET-028 acceptance, Ready or merge authorization.


ET-028 supersession: the dated ET-012c 36px strip-row observations above remain historical. The current Yukon presentation uses `STRIP_ROW_HEIGHT_CSS = 38`, with height `ceil(38 × rows × scale + 2 × max(1, scale))`. Wrapping, snapped borders and whole-overlay fit refusal are unchanged. Real-game taller-window placement/click-through and fractional-DPI/performance checks remain unverified.

## ET-012e visibility implementation scope — October 21, 2026

The owner authorized saved overlay visibility (v5 `overlay.enabled`, default true), trusted boolean IPC, durable settings, gate-before-edit/driving behavior and the existing Yukon settings switch. This supersedes earlier statements that show/hide is only planned. Disabling after save cancels/discards unsaved placement; failed saves preserve it. Telemetry and recording behavior is unchanged.

The owner explicitly transferred multi-monitor, mixed-DPI, negative-origin, monitor-removal and off-screen manual checks to ET-042; the coordinator synchronized both task descriptions. Those checks remain unverified, with no inferred display acceptance. ET-012e still needs relevant single-monitor ETS2/ATS SP/TruckersMP windowed/borderless manual disposition and all code/review/CI gates. Preserve accepted ET-009 evidence and all historical ET-012a–d records. See [ET-012e validation](docs/validation/et-012e.md). No game launch, release or game-history enablement follows from implementation.

## ET-012 corrective shutdown authorization — October 21, 2026

The owner explicitly approved bounded redistribution of shutdown time and regression checks for the recording-flush gate. Only the flush-phase `recording-flush` step may borrow unused registered intake while preserving the registered storage maximum and nominal 2500 ms total. The nominal recording constant stays 500 ms; ET-038 uses actual elapsed for history close. Existing history floors, termination reserve and event-loop verdict scheduling limits remain; no absolute physical deadline is inferred. This supersedes fixed-effective-500 wording in R14/H11, as detailed in [concept](DESIGN-DECISIONS.md#et-012-corrective-shutdown-allocation--october-21-2026). Preserve the original failure and passing diagnostic as FLAKY, with unknown cause. No game, native, wire, SQLite schema, recording-eligibility or release change is authorized by this correction.

## ET-012 / accepted ET-031 integration — October 21, 2026

Accepted main `bf17eea` defines settings v5 as autostart. Current ET-012 integration uses v6 for overlay visibility: the accepted v4-to-v5 autostart-false step remains unchanged, then v5-to-v6 adds enabled-true while preserving autostart. Earlier dated visibility-v5 notes refer to the unmerged prototype schema; no owner/game preferences were exercised with it and its bounded temporary evidence remains historical. No dual-v5 guessing is introduced. Preserve the separate settings autostart boolean and application registration-status enum, General UI and both narrow setters. Portable checks remain not-installed and never activate Windows login registration. Shutdown source/tests from `15420f0` and historical fixtures remain unchanged; [current settings](docs/settings.md), [integration evidence](docs/validation/et-012e.md).

## ET-012 administrative closeout and code gates — October 22, 2026

The owner explicitly authorized consolidating unfinished Review-card validation in
[ET-044](https://trello.com/c/ucJbXIEH) and moving the source cards to Done administratively. ET-012 is Done/complete
under that decision; its remaining seven game-matrix rows and criteria P2/A2/A3/A7/M1–M8/E4 transferred **unverified**.
Existing ET-042 monitor and ET-043 accessibility/unit-profile/close-to-tray transfers remain unverified. This explicit
disposition supersedes earlier ET-012 Review/manual-gate wording; it does not claim those tests passed.

The owner accepted the four display corrections and observed mouse-release behavior at 200% on the c6d70e4 ETS2 preview,
within the limits in [ET-012e validation](docs/validation/et-012e.md). All four layouts and the full matrix were not
individually accepted. PR #163 still requires current independent review, Claude disposition, final automatic CI after
Ready and the already authorized squash merge. Administrative Done does not waive code gates or authorize a release.

## ET-011 closeout authorization — October 22, 2026

The owner authorized investigating the local verification failures and taking PR #167 through independent review,
final automatic Windows CI after Ready and squash merge, then closing ET-011. Narrator accessibility and the remaining
in-game unit-profile and close-to-tray overlay checks move, **unverified**, to
[ET-043](https://trello.com/c/2fbiCET0). The installed Start-menu and settings-through-update checks retain their existing
ET-018 deferral; this decision neither passes nor waives them. Corrected real Windows sign-out and restart passed in
separate isolated synthetic sessions; see [ET-011 validation](docs/validation/et-011.md).

The existing native contract requires a mandatory join even when protected I/O exceeds the measured 1,000 ms shutdown
target, and permits a pending startup followed by one deferred SDK-thread result. Tests must preserve those outcomes,
the diagnostic threshold and ownership, rather than impose an undocumented universal deadline. Historical failed
observations and unknown causes stay recorded. This authorization does not assert that the remaining code gates have
passed, enable real recording, authorize a release or accept the transferred checks.

## ET-047 Hard Mode page — October 23, 2026

The owner requested a dedicated Hard Mode page between Live and Journal and clarified that all information belongs inline, removing the need for the checklist drawer. This supersedes the October 21 drawer presentation requirement only. The Live instrument spans the available content width; the global status and dashboard-lifetime observer remain. Preserve all twelve conditions, detected/required/state/reason/cvar evidence, source/age, first loss, bounded refresh and read-only/manual-delivery caveats in EN/RU. Navigation cannot restore qualification. UI work follows ui-ux-pro-max guidance within the existing Yukon design system. See [ET-047 validation](docs/validation/et-047.md) for actual checks and pending acceptance; no merge/release or real-history enablement is implied.

## ET-045a readable labels and standstill gauge — October 24, 2026

ET-045a implements items 1, 4, 5, 10 and 11 of [ET-045](https://trello.com/c/OmNYTBsp): the Live speed arc is not drawn while the displayed speed is `0`; known SDK job markets show EN/RU labels on the dashboard and in the journal while telemetry-core, storage and the export keep raw values; the truck row shows v1's brand and name only for the same model id; the overlay labels the SDK mean "Consumption" / "Расход" without the strip caption and shows expected income without "(SDK-documented)" (dashboard, journal and export keep it). No settings, IPC, wire, storage, export or native change. The other items are later packages, and D1–D5 await the owner. The owner's ETS2 retest and all other game checks remain pending; see [ET-045 validation](docs/validation/et-045.md).

## ET-045b contextual action results — October 24, 2026

ET-045 item 15 only. Each Game plugin card action now answers next to its trigger, with the action, the game and a severity (information, done, refused, failed) shown by tone, icon and word in EN/RU; information, done and refused are polite announcements and failures assertive, and focus stays on the control. A Steam folder duplicate is information. Renderer only: no IPC, preload, main, contract, settings, wire, storage, export or native change, and `GAME_HISTORY_RECORDING` is unchanged. Owner packaged/installed, Windows scaling, real dialog focus and Narrator checks remain pending in [ET-045b validation](docs/validation/et-045b.md).

## ET-045 delivery authorization and decisions — October 24, 2026

On October 24, 2026 the owner authorized delivering the ET-045 packages sequentially through squash merge, with decisions at the coordinator's discretion, and decided D1–D5:

- **D1:** option b. Saved scale numbers are kept and reinterpreted, so the new 100% equals the old 70%; the range is 50–300%.
- **D2:** display names only change; the setup file is renamed to `YukonUnionTelemetry-Setup-<version>.exe`.
- **D3:** an install/update hook writes `app.ico` and `DisplayIcon`.
- **D4:** the Cluster shows speed on the outer ring and RPM on the inner ring, with a validated numeric overlay payload field.
- **D5:** the strip is never narrower than at scale 1.

This supersedes the ET-045a statement above that D1–D5 await the owner. It authorizes no release, and every package keeps its code gates and pending real-game checks; see [ET-045 validation](docs/validation/et-045.md).

## ET-045c overlay bounds verification — October 24, 2026

ET-045c implements item 12 of ET-045 only. In the owner's ATS TruckersMP windowed session at 150%, the Driving only strip at x 0.8485, y 1, scale 0.5 kept a taller window than the 21 DIP that main requested and extended below the game client. The overlay controller cached its own last request, called `setBounds` only when the next rectangle differed, and never read the actual bounds. The fix verifies the actual bounds after every request and placement (1 DIP per edge), re-applies a mismatch at most twice, fits a window that keeps another size at the same fractions when it fits (only on axes changed beyond 2 DIP of rounding, and drops convert against that size), and otherwise hides fail-closed, reporting `too-large` while editing, until the next distinct game client observation re-arms one more bounded verification. A hidden window is shown only once its rectangle is accepted. Mismatches write bounded fact-only `OVERLAY_BOUNDS_MISMATCH` lines (a hide once per refused request, other outcomes once per mode, outcome and size difference, at most 16 per launch); every verified apply is recorded only in the opt-in diagnostic timeline. On the development machine at 150% the verifier's probe measured a 38 DIP minimum height for the overlay window; the enforcing mechanism and the owner's machine are unverified, and no game result follows. No settings, IPC, preload, wire, storage or native change. The owner's real-game retest is pending; see [ET-045c validation](docs/validation/et-045c.md).

## ET-045d stable overlay numbers and typography — October 24, 2026

ET-045 items 7, 8 and 2 only. In the strip, speed, gear and RPM reserve the width of `000`, `R0` and `0000` through an invisible CSS block in the value's font, so 9↔10, 99↔100 and 999↔1000 never resize a section or move a neighbour; RPM shows its localized unit separately in every layout. Overlay values are slightly smaller and never below the 12 px labels, and the Cluster's speed, gear and RPM stay inside the inner ring at 50/100/200%. Decisions W1–W8 are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-045d-overlay-numbers-and-typography--october-24-2026). No window size, row height, cap, settings, IPC, preload, payload, wire, storage, export or native change, and `GAME_HISTORY_RECORDING` is unchanged. The owner's ETS2/ATS retest and every other game check remain pending in [ET-045d validation](docs/validation/et-045d.md).

## ET-049 overlay background opacity — October 24, 2026

The owner requested implementation of [ET-049](https://trello.com/c/GyBnLV5M). The candidate adds a 40–100% background-only slider (default 80), settings format v7 with in-memory v6 migration and no startup rewrite, exact validated dashboard IPC and committed overlay publication. Minimal stays backgroundless. No recording, wire, native or placement-draft semantics change. Code checks and pending owner-operated game/input/DPI/Narrator/installed-update evidence are recorded in [ET-049 validation](docs/validation/et-049.md); no merge or release is authorized by this request.

## ET-045g Installed apps icon — October 24, 2026

ET-045 item 14 only, under owner decision D3. Squirrel downloaded electron-winstaller's default Electron icon into `app.ico` and pointed `DisplayIcon` at it, so Windows Settings showed the atom. The install and updated hooks now place the bundled `resources/icon/app.ico` there and set this product's `DisplayIcon` to icon 0 of the versioned executable; `iconUrl` stays the default. No name, Squirrel id or Setup file name changes (ET-045h), no data-root, settings, IPC, wire, storage, native or uninstall-engine change, and nothing is released. The hosted installer lifecycle asserts the registration and both icon files. The owner's check of the real Installed apps entry after a fresh install, a Setup over an existing install and an update remains pending; see [ET-045g validation](docs/validation/et-045g.md).

## ET-045e overlay scale rebase — October 24, 2026

ET-045 items 9 and 6 only, under owner decisions D1 option b and D5 and decisions Z1–Z9 in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-045e-rebased-overlay-scale-and-strip-width--october-24-2026). The saved overlay scale is a setting in 50–300% whose zoom factor is setting × 0.7 (`overlayZoom`), so the new 100% renders exactly as the old 70%; saved numbers are kept and reinterpreted, and settings move to v8 by an identity v7-to-v8 step (ET-049 took v7 first), which builds before ET-045e, including ET-049, read as newer-version (read-only defaults, file kept). The strip is `floor(min(1280 × max(1, scale), client width − 32))` wide with rows at its zoomed CSS width, so a smaller scale shrinks only its text, never the width it takes from the actual game client. The set-scale IPC accepts [0.5, 3]; no new channel, bridge method, wire, storage, export or native change, and `GAME_HISTORY_RECORDING` is unchanged. The owner's saved 50% strip now renders at the old 35%. The owner's comparison against the old 70% and every real-game check remain pending in [ET-045e validation](docs/validation/et-045e.md); no display, DPI, game or performance claim follows.

## ET-045h product name — October 24, 2026

ET-045 item 13 only, under owner decision D2. The user-facing name is **Yukon Union Telemetry**: Installed apps DisplayName and Publisher ("Yukon Union Telemetry contributors", H1), the executable's ProductName/FileDescription and thus the shortcut name, tray, dialogs, EN/RU copy, deferral README and executor message box; Setup is `YukonUnionTelemetry-Setup-<version>.exe`. CompanyName stays "Artur Sianiuk" (H2). Every technical identity is unchanged: `productName` `ETS2Telemetry Desktop`, the Squirrel id, executable, `appBundleId`, data root, plugin DLL, pipes, `ETS2TELEMETRY_*`, RunOnce value and the receipt/export/diagnostic schemas and file names. The install/updated hooks delete this install's old `ETS2Telemetry Desktop.lnk` shortcuts only after the new ones exist and only when owned; uninstall removes them after `--removeShortcut` (H3; no receipt schema change, H4). `tests/unit/product-name.test.ts` guards the copy. No settings, IPC, wire, storage or native change; nothing is released. The hosted installer lifecycle (L1-L3) and the owner's Installed apps, Start menu and pin checks remain pending; see [ET-045h validation](docs/validation/et-045h.md).

## ET-045f animated Cluster speed arc — October 24, 2026

ET-045 item 3 only, under owner decision D4 and decisions Y1–Y9 in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-045f-cluster-speed-arc--october-24-2026). The Cluster overlay draws a speed arc on its outer ring, on the Live instrument's 130 km/h / 80 mph scale of the displayed profile, and keeps RPM on the inner ring, now in its own #2563EB colour. The arc comes from a validated numeric `speedRing` fraction in the overlay sections, checked in main and again in the overlay preload; it is absent at a displayed 0, in reverse and without a current speed, eases over 150 ms linear and does not animate under reduced motion. For the Cluster only this supersedes the ET-028 statement that the outer track is decorative. No new IPC channel or bridge method, and no settings, wire, storage, export, native or window-size change; `GAME_HISTORY_RECORDING` is unchanged. The owner's real-game check of smoothness, distinctness from RPM, readability at 50/100/200% and frame-time impact remains pending in [ET-045f validation](docs/validation/et-045f.md).

## ET-050 gear display mode — October 25, 2026

[ET-050](https://trello.com/c/y4TUoF6u) adds a per-game gear display mode on Settings > Units under coordinator decisions GD1–GD8 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-050-gear-display-mode--october-25-2026)): `automatic` shows 1, 2, 3; `manual` shows range-splitter pairs (`ceil(g / 2)` plus L for odd and H for even g: 1L, 1H, 2L … 8H); neutral N and reverse R1, R2 in both. The Live instrument, the Live details row and all four overlay layouts use the displayed game's mode; telemetry-core formats it. Settings move to format v9 (`gearDisplay` after `units`; v8 migrates in memory, version 10 or later is newer-version, older builds read v9 as read-only) with one narrow trusted setter, `settings:set-gear-display`. The strip's gear reserve becomes mode-independent; window sizes and the row model are unchanged. The protocols, SQLite, samples, journal and export keep the raw integer gear, and `GAME_HISTORY_RECORDING` stays `false`. Real-game label agreement with the in-game dashboard, readability, Narrator, Windows DPI and an installed v8-to-v9 update remain pending in [ET-050 validation](docs/validation/et-050.md). This is implementation status, not card acceptance, merge or release authorization.

## ET-045 owner acceptance — October 25, 2026

The owner retested every ET-045 item on a build of `main` `8476fc43` and accepted them. The setup was ETS2 1.61.1.9 single-player at 150%, after updating the installed ET-044 build from `0.1.0` to `0.1.1` with a local feed. The coordinator checked the shortcut migration, the single "Yukon Union Telemetry" Installed apps entry and its icon, the plugin update and the unchanged history; see [ET-045 validation](docs/validation/et-045.md#owner-acceptance--october-25-2026). The card moves to Done. ATS, TruckersMP, borderless, a fresh install, pins, Narrator, reduced motion with "Animation effects" off and frame-time impact remain unobserved. The ET-044 matrix and other cards are unaffected. No release is authorized.

## ET-050b gearbox-aware gear labels — October 25, 2026

On October 25, 2026 the owner approved the ET-050b plan with decisions B1–B9 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-050b-gearbox-aware-gear-labels--october-25-2026)) and the delivery of six PRs in order through squash merge. This approves a protocol wire change: protocol v1 minor 1 adds `state.gearbox` (the truck's gear counts and the SDK H-shifter layout) to checkpoints and snapshots, negotiated through the hello's `maxMinor`, with one minor per connection. For ET-050b it supersedes GD2's statement that a gearbox-aware mapping is out of scope and the [protocol v1](docs/protocol/v1.md) statement that `version` is always `{1,0}`, which now holds for minor-0 connections and every hello. Minor-0 bytes and fixtures stay frozen.

Delivered state (PR-6, October 25, 2026): the plugin, the native broker, the simulator and the telemetry service negotiate minor 1 (PR-1 #186, PR-2 #188, PR-3 #189, PR-4 #190 and PR-5 #191 merged; PR-6 under review). An older plugin answers minor 0, its projected gearbox is `not-supported`, and manual mode keeps the GD2 formula. In manual mode the Live instrument, the Live details row and all four overlay layouts show labels derived from the truck's SDK H-shifter layout (for example `LL`, `LH`, `1L`…`8H` on the ATS Mack) only while the v1 projection is current, its truck model id equals v0's and the layout validates (B6); otherwise the formula applies. The strip's gear reserve adds `LH` and `LL` (B8). Settings stay format v9, the protocols, SQLite, samples, journal and export keep the raw gear index, no IPC channel was added, and `GAME_HISTORY_RECORDING` stays `false`. The session's protocol minor is part of its stored identity, so a minor change within one plugin session is `SESSION_CONFLICT`: it can occur only after an application downgrade during a game session with a minor-1 plugin loaded, or with a development build that has PR-4 but not PR-5. A supported update cannot cause it, because plugin setup never replaces the DLL while a game runs. The durable sink maps it to `unavailable`, which fails closed and loses nothing; the decision for the enablement PR is TD-021. Every real-game check remains pending and nothing is released; no game, TruckersMP, display or performance claim follows; see [ET-050b validation](docs/validation/et-050b.md).

ETS2 crawler amendment (October 26, 2026): the owner confirmed the ATS Mack labels in game. On an ETS2 Scania GRSO925R 12+2 the dashboard showed `C1` where the overlay showed `1L`, and the owner decided that ETS2 names crawlers `C1`/`C2` while ATS keeps `L`/`LL`/`LH` (B5 amended). The owner's CAP0 capture showed the Scania crawler sharing a handle position with high-range gears. The derivation now takes the source's game and detects the crawler by range cells, not by handle position. There is no wire, settings, IPC, storage or native change. The in-game check of the corrected Scania labels remains pending; see [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#ets2-crawler-amendment--october-26-2026).

ETS2 crawler gear mode (October 26, 2026): the ETS2 Scania G38CMR 13+1 has the GRSO925R's forward H-shifter slots but its dashboard reads `C, 1, 2, 3…`, and its H-shifter reaches 4 of its 8 reverse gears. The SDK cannot tell the two gearboxes apart, so the owner chose option B: a third per-game gear display mode, `crawler` (gear 1 is `C` in ETS2 or `L` in ATS, gear g above it is g − 1), on Settings > Units, with settings format v10 (an identity step from v9; v10 is newer-version for earlier builds). The layout derivation now accepts reverse gears beyond the H-shifter's slots. There is no wire, IPC channel, storage or native change; see [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#ets2-crawler-gear-mode--october-26-2026). Real-game checks remain pending.

Per-gearbox gear display modes reverted (October 27, 2026): PR #204 (`ecb08e37`) added a gear display mode per gearbox (the SDK truck model id with its forward and reverse gear counts) and settings format v12, after the owner's Scania GA867R 6-speed automatic, which the SDK describes with the same H-shifter pattern as the crawler gearboxes, showed `C` and `C1` instead of `1…6`. The owner then judged the design too complex and asked to roll it back, so this revert restores the per-game modes of #200 and settings format v11. The GA867R case is unresolved: with ETS2 on **Crawler first** or **Manual range-splitter** it still shows `C` or `C1`, and choosing **Automatic** for ETS2 shows `1…6`. No released or installed build carried v12; a development profile written by a build of `ecb08e37` reads as newer-version (read-only defaults) after this revert.

## Game history recording enablement — October 25, 2026

On October 25, 2026 the owner wrote (translated from Russian): "I authorize lifting the block and prepare the telemetry for recording a real trip." This is the separate enablement decision that the ET-015a gate reserved. For game history recording only, it supersedes the earlier statements that `GAME_HISTORY_RECORDING` stays `false`, including the ET-016 enablement note; earlier dated text is unchanged.

`GAME_HISTORY_RECORDING` is now `true` in [recording-policy.ts](apps/desktop/src/recording-policy.ts). With an ETS2 or ATS selection the telemetry service requests durable protocol v1 delivery, commits events, gaps, trip effects and one-second samples to `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite`, and acknowledges only after the commit. Synthetic, replay and fixture sources are still never durable in history, and `ETS2TELEMETRY_RECORDING` still selects only a synthetic or replay database. A refused or unavailable history database leaves the service live-only and the dashboard reports the recording as stopped with its code, instead of the earlier fixed "Off" text.

Coordinator decisions under this authorization, which the owner did not review individually:
- The enablement does not wait for the v0 retirement (D2). Recording is protocol v1 only, so the intent of D2, that recording never ships on v0, holds; v0 stays the live path of the dashboard and overlay beside it. The v0-retirement PR remains a separate package.
- The full-volume, ACL, other-user, remote-pipe, clock/suspend and power-loss boundaries (ET-044 B6, B7, I4, E1 and E5) were accepted by the owner on October 25, 2026 without testing. They are unverified, not passed, and the enablement does not change that.
- TD-021: `upsertSession` keeps comparing `protocol_minor`. A minor change inside one plugin session stays `SESSION_CONFLICT`, which the durable sink maps to `unavailable`: recording fails closed and loses nothing committed. A supported update cannot cause it, because plugin setup never replaces the DLL while a game runs.

There is no wire, schema, migration, IPC, preload, renderer or native change. Pending, and not claimed by this decision: the first real recorded trip, the Journal and the JSON export against real history, ET-044 A4–A6, B1–B3 and E2, and every real-game, TruckersMP, display and performance check. The merge of the PR that carries this change publishes nothing; a release needs the owner's authorization. See [the enablement validation](docs/validation/game-history-enablement.md).

## ET-052 authorization — October 26, 2026

The owner decided the four points of [ET-052](https://trello.com/c/ZQCdMLy9) on its card: D1 the SDK channel `mandatory.break` only; D2 a new overlay section that is on by default, also for users who upgrade from settings v9, with a coffee-cup icon; D3 zero or less shows `0` in red, 1 to 119 minutes orange and 120 or more the normal colour; D4 the value is live only and never recorded. On October 26, 2026 the owner approved the ET-052 plan, including protocol v1 minor 2 (`state.nextMandatoryBreak`, hello `maxMinor` 2), settings with a migration that switches the new section on (planned as v10; ET-050b took v10 first, so the format is v11), a validated `urgency` on the overlay sections and a `nextMandatoryBreak` field on the live projection, and the architect's recommendations on its open points 2–7, and told the coordinator to continue with all five PRs (translated from Russian: "I approve the ET-052 plan with the architect's recommendations on points 2-7 (dash, the 120 boundary, presets unchanged, underline, windows growing by one row). Continue with all five PRs."). The coordinator adopted the plan's design decisions as MB1–MB12 ([DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-052-mandatory-break-and-protocol-v1-minor-2--october-26-2026)); they are coordinator decisions and the owner did not review them individually. The approval authorizes the five PRs and no merge or release.

For ET-052 only, this supersedes the "minor 0 or 1" wording (ET-050b B1 and [protocol v1](docs/protocol/v1.md) §2, §4) and the statement that minor 1 differs from minor 0 only by `state.gearbox`: a server now selects minor 0, 1 or 2, and minor 2 adds `state.nextMandatoryBreak` on top of the gearbox. The negotiation rule `min(hello maxMinor, its own maximum)` is not a change: protocol v1 §4 already specified it, and the code is fixed to match (PR-1 the TypeScript `negotiateV1`, PR-2 the C++ `negotiate`). Earlier dated text is unchanged.

Implementation status (PR-5 of 5): the contracts, the plugin side, the application's dashboard and the overlay section are implemented. PR-1 added the minor-2 wire contract and its fixtures, the TypeScript negotiation fix, and the break reading and pure rules in telemetry-core; PR-2 made the C++ contract read the same corpus and fixed the C++ negotiation (which the native broker also calls); PR-3 made the plugin capture the optional `mandatory.break` channel (a refused registration is `not-supported` and never fails initialization; the v0 snapshot, v0 diagnostics and CAP0 stay as they were) and serve minor 2 to a hello that offers it. PR-4 makes the telemetry service offer minor 2 (the simulator serves it and the native broker relays it), projects the raw break on the live update (`LiveStateV1.nextMandatoryBreak`, `not-supported` below minor 2, validated in main and the dashboard preload; no new IPC channel or bridge method) and adds the "Next mandatory break" row, with a Coffee icon and a soon or due badge (an icon, a word and an accessible name, never colour alone), to the Live details card. That row is the first user-visible change; it appears only while a minor-2 plugin serves the break and v1 data is current. PR-5 adds the overlay section `mandatory-break` (Time group after game time, lucide Coffee, labels "Next mandatory break" / "Break" and "До обязательного перерыва" / "Перерыв", text from the same live view as the dashboard row, a dash when a carried v1 observation has no value) with the validated `soon`/`due` enum (orange 1 to 119 minutes, red and underlined at zero or less; `data-urgency` and an accessible name with the state word serve assistive technology, so `soon` has colour as its only visible cue, which is partial against ET-045b and an open readability point for the owner), and moves the settings file to **format v11** (ET-050b took v10 first) by a pure v10-to-v11 step that switches the section on, also for upgraders (owner decision D2); the presets `job-focus` and `driving-only` do not include it. **Owner-visible consequences:** an older build reads a v11 file as newer-version (read-only defaults, the file is kept); the default windows grow, the card, the cluster's side panel and the Minimal HUD by one row (to 210 × 287, 308 × 203 and 224 × 265 DIP at the setting 1) and the default strip by a third row (1280 × 82 DIP, was 56, because the break no longer fits the second row at the setting 1's CSS width of 1828), the extra rows being transparent; the earlier ET-012d sizes above are historical. The value is live only: the recorder, the one-second sampler and the trip reducer do not read it (D4; a storage test proves a changing break stores the rows of the same source at minor 1), and no schema, SQLite, sample, trip, journal or export changed; `GAME_HISTORY_RECORDING` is unchanged and TD-021 gains no new trigger in code. Release constraint: PR-3 (plugin serves minor 2) and PR-4 (application offers minor 2) must ship in the same release; built together they pair consistently (a new application negotiates 1 with an older plugin still loaded in a running game and never changes a session's minor), whereas a release with PR-3 but not PR-4 could have the application record a session at minor 1 and then conflict (`SESSION_CONFLICT`, recording fails closed until the game restarts, nothing committed is lost) when the application is later updated to PR-4 during that game; the owner would have to accept that. No release is authorized by this work. Every real-game, TruckersMP, display and performance check remains pending in [ET-052 validation](docs/validation/et-052.md), among them the colours and underline above a real game, the click-through over the taller windows and an installed v10-to-v11 update; no game claim follows. On October 26, 2026 the owner told the coordinator (translated from Russian): "merge it yourself if all checks pass". Under that instruction PR-1 to PR-5 are merged one at a time, each after the Windows CI run on its Ready head passed and with no open review thread; it is not a release authorization. Whether assistive technology exposes that accessible name is unverified: ARIA does not allow naming a role-less element, and the overlay is click-through and not focusable, so a screen reader may never reach it; a Narrator check is pending.

## ET-055 in-app updates and staging channel — October 28, 2026

On October 28, 2026 the owner approved the [ET-055](https://trello.com/c/XtO5RKn6) plan (revision 2) with the architect's recommendations on UP1, UP5, UP9, UP12 and UP16: in-app updates that download and install only after a click, and a staging build channel with its own Squirrel id, executable, data root `%LOCALAPPDATA%\ETS2TelemetryStaging`, plugin `ets2telemetry-plugin-staging.dll`, pipes and registry values, so that it installs and runs beside production. The owner authorized the coordinator to run the nine deliveries without asking again and to squash merge each PR after its tests and independent code review pass. Decisions UP1–UP20 are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-055-in-app-updates-and-staging-channel--october-28-2026).

For ET-055 only, this supersedes the ET-011 statement (C15) that no auto-update is authorized, the ET-018 statement that no auto-update is added and the "No auto-update" bullet of [the release checklist](docs/release.md); it amends O2 so that a production release is an ordinary GitHub Release, while staging releases stay pre-releases. Earlier dated text is unchanged.

In `apps/desktop/src`, the installation identities used to build paths, file names, registry values and the window and tray name come from the channel table in `apps/desktop/src/channel.ts` (PR-1); production values stay byte-identical, and `tests/unit/channel-identity.test.ts` pins them. PR-3 covers the rest: the `PRODUCTION_HISTORY` guard in `packages/storage/src/sqlite/connection.ts`, the `'transport'` literal in `native-pipe-client.ts`, user-facing copy that names `%LOCALAPPDATA%\ETS2Telemetry` or the plugin DLL, `forge.config.cjs`, the build and release scripts and the PowerShell executor; the native code follows in PR-2. Until then they name the production values. Until PR-3 adds the build-time selection, every build is production. Once PR-4 lands, agent and feature-test builds are staging: an unset `ETS2TELEMETRY_BUILD_CHANNEL` builds staging, a production build is accepted only in GitHub Actions or with the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1`, and agents must never set that variable. `npm run dev` and CAP0 captures then use the staging data root and pipes.

No release is authorized by this approval: every publication still needs the owner, and approving a staging `release.yml` dispatch is the authorization for that staging release (UP16). Production manifests are signed only by the owner's offline key; agents never sign. No protocol, wire, SQLite schema, settings format or `GAME_HISTORY_RECORDING` change follows. Both channels on a real machine, real updates, two plugins in real games and their frame-time cost remain pending owner-operated checks; no game, TruckersMP, display or performance claim follows.

ET-055 PR-3 implementation update (October 28, 2026): `scripts/build-channel.mjs` is the only resolver of the build channel and version (`ETS2TELEMETRY_BUILD_CHANNEL` exactly `production` or `staging`; unset is still production until PR-4). The bundles, both native trees, the plugin bundle and released list, Forge (Squirrel id, executable, productName, display name, Setup name, version), the deferred-cleanup executor (a stamped `$Channel` line), `inspect-package` and `release-identity.json` (`channel`) all take it from there; production names are unchanged and the golden tests pin them. A staging export refuses both data roots, as the owner-approved UP12 table specifies. Staging copy, the storage guard of both history files and the staging game-log prefix `ETS2TelemetryStaging:` are coordinator decisions recorded in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-055-in-app-updates-and-staging-channel--october-28-2026). Run `inspect:package`, `make` and `release-identity` with the build's variables; see [build channels](docs/setup.md#build-channels-et-055). The CI workflow and the smoke drivers still assume production until PR-4.

ET-055 PR-4 implementation update (October 28, 2026): agent and feature-test builds are staging (UP13).

- **Resolver.** An unset `ETS2TELEMETRY_BUILD_CHANNEL` builds staging. Exactly `production` is accepted only on a GitHub-hosted Actions runner (`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`) or with the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD=1`; any other value stops the build. `npm run dev`, `build`, `package`, `make`, `native:configure` (which now passes the resolved channel) and the native builds therefore produce staging locally: the data root `%LOCALAPPDATA%\ETS2TelemetryStaging`, the plugin `ets2telemetry-plugin-staging.dll` and the staging pipes. A CAP0 capture through `npm run dev` needs the staging plugin in the game.
- **Native trees.** CMake's own default for `ETS2TELEMETRY_CHANNEL` is staging in both native trees, and `native:configure` refuses extra arguments that would set or load the channel. CI's directly configured AddressSanitizer and extended trees pass `-DETS2TELEMETRY_CHANNEL=production`. Every native plugin tree also builds the other channel's plugin DLL under `build/other-channel/` for `channel-identity-contract` and `two-plugin-host-contract`; that DLL is a test artifact and must never be copied into a game.
- **Rule for every agent.** Never build with `ETS2TELEMETRY_BUILD_CHANNEL=production` or set `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD`, never install or run a production-identity build on the owner's machine, and install a feature-test build only as staging (`YukonUnionTelemetry-Staging-Setup-<version>.exe`). Production builds come from Windows CI.
- **CI.** Only `main` builds production, for the release artifact: a push to `main` or a dispatch on `main` (`github.ref == 'refs/heads/main'`). Pull requests and dispatches on any other branch build the default staging channel, upload a branch dispatch's Setup as `windows-installer-staging-<run>-<attempt>` and skip the hosted installer lifecycle with a notice until PR-5 ([CI](docs/ci.md#build-channels-et-055-pr-4)). The production artifact comes only from a `main` run; never install an artifact of a branch dispatch as production: it is a staging build. The required job names are unchanged. The smoke, session-end and compiled-artifact drivers read the built channel from the desktop build evidence (`node scripts/build-channel.mjs --built`), and `release-identity.json` records `builtBy`: the GitHub Actions run id, or `local`.
- **Installer lifecycle.** A local `-AllowLocal` run accepts only a staging Setup, and a production Setup runs only on a GitHub-hosted runner. The staging lifecycle itself arrives with PR-5, so until then a staging Setup is refused with `STAGING_LIFECYCLE_PENDING` ([installer testing](docs/installer-testing.md#build-channels-et-055)).
- **Tests.** Every Vitest suite removes the build variables first (`tests/shared/build-channel-environment.ts`), and tests name the channel they check, so the shell's channel never changes a result.

No product behaviour, protocol, schema, settings format or `GAME_HISTORY_RECORDING` change follows. Both channels on a real machine and every real-game, TruckersMP, display and performance check remain pending.

ET-055 PR-6 implementation update (October 28, 2026): main has an update controller (`apps/desktop/src/updater/`) without a user interface; the sidebar control is PR-7. An installed Squirrel build checks its own channel's feed 15 s after the first readiness and every 6 h (never unpackaged, portable or isolated), verifies an Ed25519-signed manifest against the public keys compiled into `apps/desktop/src/updater/update-keys.ts`, and only after the dashboard's click, while no game or TruckersMP runs, downloads the verified nupkg into `<data root>\updates`, applies it with `Update.exe --update` and restarts through the explicit exit with the new reason `update`. Both key lists are empty until the owner generates the production key offline and adds its public half ([release checklist](docs/release.md#release-checklist) step 0), so no build installs an update yet; agents never generate, hold or use a signing key. `AppState.application` and `AppState.update` and the two argument-free bridge methods `updateApplication()` and `checkForUpdates()` are validated in main and in the dashboard preload; no URL or path reaches the renderer. `updates` joins the uninstall data allowlist. Coordinator decisions are in [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-055-in-app-updates-and-staging-channel--october-28-2026), the behaviour in [application lifecycle](docs/app-lifecycle.md#in-app-updates-et-055), the tests under REG-019 in [TESTING-HISTORY.md](TESTING-HISTORY.md#et-055-update-controller--october-28-2026). Nothing is published; a real update, the hosted update lifecycle (PR-8) and the release workflow (PR-9) remain pending.

ET-055 PR-5 implementation update (October 28, 2026): the installer lifecycle is channel-aware and has a hosted side-by-side scenario.

- **Lifecycle.** Its install root, Uninstall key, names, versions, plugin file, RunOnce value and receipts come from the built channel (`scripts/installer/installer-guard.mjs`), so `STAGING_LIFECYCLE_PENDING` is gone. A staging Setup runs on a GitHub-hosted runner, or locally only with the owner's explicit `-AllowLocal` request under the test-root rules; agents never run the lifecycle locally (ET-018). A production Setup, and so the side-by-side scenario, runs on a hosted runner only.
- **Side by side.** On `main`, `windows-staging-build` builds staging, runs the staging lifecycle and seals its Setup; `windows-installer` installs that Setup beside the production build in one test root and checks separate install roots, Uninstall entries, shortcuts and AUMIDs, Run values and data roots, both applications running at once and both plugins in one fake game folder. Two cross-channel uninstall pairs are covered: production's complete Windows-initiated uninstall beside a running staging application, and staging's deferred uninstall with its executor beside an installed production copy, each leaving the other channel's data root, plugin, registration, shortcuts and Run value untouched. The other pairs (staging's complete path beside a running production, production's deferred path, either in-app uninstall, an update beside the other channel) stay pending (REG-019 part 1). A branch dispatch builds staging only, so it runs the staging lifecycle without the side-by-side step. Pull requests skip the installer (E1). See [installer testing](docs/installer-testing.md#side-by-side-scenario) and [CI](docs/ci.md#side-by-side-installer-lifecycle-et-055-pr-5).

No product code changes. The first hosted side-by-side run, both channels on a real machine and two plugins in a real game remain pending.

ET-055 PR-9 implementation update (October 28, 2026): the release workflow `.github/workflows/release.yml` and the scripts in `scripts/release/` exist. **No release is authorized or published by this PR**, the workflow has never been dispatched, and no key, environment or secret was created.
- **Workflow.** It is dispatch-only, on `main`, and takes a successful `Windows CI` run on `main` and a channel. A read-only `verify` job checks the run and its installer artifact (channel, `builtBy`, commit, clean tree, versions, hashes, exact nupkg name) and writes the unsigned manifest. Only the publish jobs, in the environments `release-staging` and `release-production`, have `contents: write`.
- **Staging.** The job signs with the `release-staging` secret `UPDATE_SIGNING_KEY_STAGING` and publishes a pre-release `staging-v<version>`; approving that environment is the owner's authorization of that staging release (UP16).
- **Production.** A first dispatch creates a draft with the unsigned manifest. The owner signs it offline with `scripts/release/sign-update-manifest.mjs`, and a second dispatch (`mode=publish_signed`) verifies that signature against the compiled production key, publishes with `make_latest=true` and fails unless `releases/latest` names the new tag. Release checklist steps 5 and 6 still apply to production.
- **Keys.** `scripts/release/generate-update-key.mjs` writes a private key only outside every Git working tree and prints only the `{keyId, publicKey}` entry. Agents never generate, hold or use a real signing key, never create the environments or the secret, and never dispatch the workflow; `update-keys.ts` stays empty until the owner's PR ([release checklist](docs/release.md#release-checklist) step 0).
- **Guards.** The run's commit must be in the history of main's commit read from `git/ref/heads/main`, and no tag `main` may exist; the compiled keys are read from `update-keys.ts` at the run's commit, never from the dispatch checkout; a production version must be higher than the current latest release; 404 answers go through `scripts/release/gh-get.sh`.
- **Tests.** `tests/unit/release-scripts.test.ts` and `tests/unit/release-workflow.test.ts` (REG-019) use keys generated inside the test run only.
- **Staging release artifact.** On `main`, `windows-staging-build` now sets `ETS2TELEMETRY_STAGING_RUN_NUMBER` from `github.run_number` (zero-padded to 6 digits), so its version is `<base>-stg.<NNNNNN>`, writes `release-identity.json` and uploads `windows-installer-staging-<run>-<attempt>` beside PR-5's `windows-staging-input-<run>-<attempt>` hand-off from the same build. No hosted run has produced it yet. Branch dispatches and pull requests keep `-stg.000000`, which the release workflow refuses.

See [releases](docs/release.md#release-workflow-et-055) and [CI](docs/ci.md#et-055-release-workflow-dispatch-only). No game, TruckersMP, display or performance claim follows.

ET-055 staging Squirrel id amendment (October 28, 2026): the first hosted side-by-side run on main (run 40705814648, after PR-5) failed with `BESIDE_INSTANCE_ENDED`. Production's Windows-initiated uninstall terminated the running staging application, because Squirrel.Windows matches a package's processes with a plain `StartsWith(rootAppDirectory)` and the production root `%LOCALAPPDATA%\ETS2TelemetryDesktop` was a string prefix of the staging root. As a coordinator decision under the owner's delegation, the staging Squirrel id (install root, Uninstall key, nupkg, AUMID first part) is now `ETS2TelemetryStagingDesktop`; every other UP12 staging name, including the executable `ETS2TelemetryDesktopStaging`, is unchanged. `channel-identity.test.ts` refuses any channel pair where one id or install root is a case-insensitive string prefix of the other. No staging build was released, so nothing migrates. The fix is proven only by the next main run's side-by-side step; see [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-055-in-app-updates-and-staging-channel--october-28-2026) and [installer testing](docs/installer-testing.md#side-by-side-scenario).

ET-055 PR-8 implementation update (October 28, 2026): the hosted installer lifecycle has an update-from-feed scenario (REG-019 part 2). For the built channel on every non-PR event, in its own test root, the installed build updates itself through its own controller from a loopback feed that the driver serves on `127.0.0.1` and signs with an Ed25519 key generated for the run and never stored: a click is refused while the fake game runs with nothing downloaded, then the download, the apply, the `update` exit with `recording-flush` and the restart into `app-<version>` keep the seeded history and settings. Risk R1 is observed by killing the apply of a further version and retrying it with an exit during it. The hosted run 40710991951 showed that a killed apply left a half-written `app-<version>` that Squirrel's stub then started and failed on, so the one product change of PR-8 is that the still-running application removes exactly that target folder after a failed or timed-out apply; the scenario asserts it, and a power loss or a forced end of the application during the apply stays uncovered (TD-026). It runs on a GitHub-hosted runner only and never under `-AllowLocal`; agents never run it locally. The first hosted run, R1's outcome, TD-025, a power loss, a real feed and the production key remain pending; see [installer testing](docs/installer-testing.md#update-from-feed-scenario).

ET-055 staging releases from any branch (owner decision, October 28, 2026): asked why staging differs from production if both build from `main`, the owner chose "Yes, any branch": a staging release may come from a Windows CI dispatch on any branch, production stays `main`-only, and the owner's approval of the `release-staging` deployment remains the gate (UP16). A `workflow_dispatch` on a branch other than `main` now gives its staging build the version `<base>-stg.<6-digit run number>`, writes `release-identity.json` and uploads `windows-installer-staging-<run>-<attempt>`. Pull requests and tag dispatches keep `-stg.000000`, which stays unreleasable, and `main`'s jobs are unchanged. `release.yml` is still dispatched on `main` only. For staging it accepts a successful `push` or `workflow_dispatch` run of this repository on any branch, never a pull request or a fork, without the tag and ancestry check. The run's commit, the artifact identity checks and the compiled keys at that commit still apply. The environments' `main`-only deployment rule limits `release.yml`'s own ref, not the released run's branch. After the independent review, the release scripts read the released commit's `update-keys.ts` as data and never run it. A staging version must carry the released run's number, and a staging base above `main`'s `package.json` version is refused, so raise `main`'s version first. The verify job summarizes the channel, version, branch, run and commit before approval. Agents still never dispatch `release.yml`. Since PR #218 (October 28, 2026) both update key lists hold the owner's keys (`production-611eb870520f2b0f`, `staging-9a83aca3ea8c5402`); earlier dated statements that the lists ship empty are historical. See [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md#et-055-in-app-updates-and-staging-channel--october-28-2026) ("UP15 and UP16 amended") and [releases](docs/release.md#release-workflow-et-055). No workflow has run with this change, and no release is authorized.

## AGENTS.md cut and documentation budget — October 28, 2026

On October 28, 2026, after a token-usage diagnosis, the owner wrote (translated from Russian): "AGENTS.md still looks too bloated to me. I would try to squeeze it into about 1,000 characters, and it should contain only the most basic necessary information about the project. Also I would like to reduce the amount of documentation that agents generate. We need to add some rule so that agents do not generate unnecessary documents." The owner then confirmed the resulting `AGENTS.md`, the Standing Owner Rules and the documentation budget.

- `AGENTS.md`, which every agent session loads, holds only about 1,000 characters of basics. The rules that apply across tasks are in [docs/agent-rules.md](docs/agent-rules.md), and the dated decisions that `AGENTS.md` held are in this file.
- The [documentation budget](docs/agent-rules.md#documentation-budget) applies to all agent work: evidence goes in the PR description, no new documents unless the owner asks or a new interface, setup step or user-facing workflow has no other place, existing documents are edited in place without dated update paragraphs or per-card sections, and `docs/validation/` keeps only real-environment evidence. For the same reason the rule "update the relevant documentation when ... implementation status change" no longer lists implementation status, and `TESTING.md` section 9 asks for an update of `TESTING.md` only when a general rule changes.
- `concept.md` rewrite. The owner then wrote (translated from Russian): "Let's rewrite concept.md, because it has also grown a lot. I originally meant it to describe the idea of the program and its main features, how it should work, but now there are many logs, task information and so on. Refactor it: state the main idea of the program and its main features, and add a rule that something may be added to or changed in this file only when a new feature appears or current functionality changes, and even then without a lot of text: briefly describe the new feature or correct the feature's description if its behavior changed." `concept.md` now holds only the product idea, principles and features; its earlier full text, including the dated design decision records, moved verbatim to [DESIGN-DECISIONS.md](DESIGN-DECISIONS.md), and the rule is part of the [documentation budget](docs/agent-rules.md#documentation-budget).
- `TESTING.md` and registry cleanup. The owner then approved the same treatment for `TESTING.md` and `docs/regression-registry.md` (translated from Russian: "Yes, let's do it in the same pull request"). `TESTING.md` now holds only the testing rules and the regression scenarios, and the registry only the test index. Their earlier full texts moved verbatim to [TESTING-HISTORY.md](TESTING-HISTORY.md) and [docs/regression-registry-history.md](docs/regression-registry-history.md). `TESTING.md` changes only when a testing rule changes or a scenario is added; a PR describes its tests in its description and adds one test-index row per new test entry point.

## Staging release skill — October 29, 2026

The owner asked (translated from Russian) for a skill "release staging" that prepares a staging release from a branch given as a parameter, `main` when none is given, checks that the `package.json` version suits the release and raises it when it does not. The `release-staging` skill ([Claude Code](.claude/skills/release-staging/SKILL.md); [Antigravity and Codex](.agents/skills/release-staging/SKILL.md), at the owner's further request), started only by the owner, may therefore dispatch `release.yml` with `channel=staging`; this narrows the rule that agents never dispatch it. The owner's approval of `release-staging` stays the authorization of each staging release, agents never approve an environment, and production dispatches, signing and keys stay with the owner.

## Staging icon — October 29, 2026

Asked for a staging icon that differs from production, the owner chose variant 4 of five rendered proposals: the production road-merge mark with an amber flag across the upper right corner, clear of the tray's status dot ([UI specification](docs/design/ui-spec.md#3-tokens-type-and-icons)). Production icons stay byte-identical.
