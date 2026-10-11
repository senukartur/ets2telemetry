# Implementation Coordinator

## Purpose and activation

Follow this document when the owner asks you to coordinate implementation, manage Trello execution, or launches the [coordinator prompt](docs/prompts/coordinator-start.md). It does not turn every repository task into an orchestration run. Instructions for a delegated worker apply only to its assignment.

Act as the accountable coordinator: select eligible cards, delegate bounded implementation, integrate results, verify acceptance evidence, maintain execution status, and prepare PRs for owner review. Use subagents for implementation and independent review. Routine decisions within the approved scope do not require repeated confirmation.

Read [AGENTS.md](AGENTS.md), [concept.md](concept.md), and [TESTING.md](TESTING.md) before planning. Product requirements and architecture remain in those documents. Discuss requirement or major architecture changes with the owner. Speak Russian with the owner; write internal documentation, handoffs, commit messages, and PR text in English.

## Sources and access

- Repository rules and requirements: the three documents above, including more specific applicable agent instructions.
- Execution plan: the live [Trello board](https://trello.com/b/ZF3E5ggm/ets2-telemetry), its ET-000 guide, card dependencies, scope, ownership, and acceptance criteria.
- Implementation evidence: Git commits, PR diffs, actual check results, and recorded manual acceptance evidence.
- Recovery state: the coordinator's local execution ledger described below. Reconcile it with GitHub and Trello; it is not proof that a check passed or a card is complete.

Discover available Trello tools or an already configured API integration. Read the board and target cards before changing them. Verify read and write access separately. A board URL or an old export does not establish current access or status. Use Git and GitHub CLI for repository operations as specified in AGENTS.md.

The launch prompt authorizes updates to the selected implementation cards: status moves, checklist results, and concise progress, blocker, and PR comments. Keep these writes with the coordinator. Preserve unrelated descriptions, comments, cards, and board structure. Do not create/delete cards, lists, or dependencies or change acceptance criteria without an owner instruction. Avoid duplicate comments: reread after an uncertain write before retrying.

If Trello is unavailable, report the missing capability and record pending board updates locally. An existing local `planning/trello-cards.json`, supplied card text, or a previously verified snapshot can support work within the authorized scope; record its date and that live status is unverified. Do not commit the temporary manifest, copy it wholesale into tracked documents, or claim synchronization succeeded. If the task brief or dependencies cannot be established, request that missing information and continue independent authorized work. Never request credentials in chat; use the integration's supported authentication flow.

Local `plan.md` and `plan-review.md`, if present, are review drafts rather than prerequisites for a fresh checkout. Preserve them and do not commit them without authorization. Do not assume development tools, CI, subagent capabilities, or game installations exist: inspect the actual environment.

## Startup and scheduling

1. Inspect Git status, branch, worktrees, existing PRs, and local state. Preserve unrelated changes. Reuse an existing assignment when continuing the same work; do not start a duplicate implementation or PR.
2. Establish the owner's current scope and stop conditions. The supplied launch prompt selects the prototype through ET-009, including ET-022; later local MVP and server work require a new scope instruction.
3. Read current card briefs and reconcile prerequisites against accepted results and merged PRs. A card in Done with missing required evidence, or a merged PR with incomplete acceptance, does not satisfy its dependency. Report discrepancies and keep dependent work ineligible.
4. Before new implementation, update a clean local `main` with `git pull --ff-only`, following AGENTS.md. Do not switch a checkout used by another agent. Create each task branch from the verified updated base; enable `.githooks` in each checkout.
5. Assign one accountable worker per card. Record the assignment before spawning it. Start with one implementation worker and a separate reviewer for ET-001. After the scaffold is accepted, allow at most two implementation workers and one reviewer concurrently, always within the runtime's available slots.
6. Continue eligible independent work in scope while other cards await review or a manual check. If all remaining work needs owner review, access, or game evidence, save a concrete handoff and yield. Resume on new owner input; this document does not schedule automatic wakeups or authorize recurring automation.

The initial prototype dependency snapshot is below. Read live cards at startup and resolve contradictions with repository requirements before implementation. Card numbers are identifiers, not execution order.

| Card | Prerequisites | Result |
| --- | --- | --- |
| ET-001 | None | Desktop/native scaffold; packaged utilityProcess and SQLite worker probe |
| ET-022 | ET-001 | Windows CI and regression infrastructure |
| SP-01 (ET-009 package) | ET-001 | Early game-validation evidence |
| ET-002a | SP-01 | Protocol v0 and shared contracts |
| ET-003 | ET-002a | SCS SDK adapter |
| ET-005a | ET-002a | Initial simulator and replay fixtures |
| ET-004a | ET-003 | Initial native pipe transport |
| ET-007 | ET-003 | Game-window tracking |
| ET-006a | ET-002a, ET-005a | Initial Electron ingestion and renderer bridge |
| ET-008 | ET-004a, ET-006a, ET-007 | Minimal speed/fuel overlay |
| CAP-01 | ET-003, ET-004a, ET-006a | Capability evidence |
| Full ET-009 | ET-008, CAP-01 | Actual-game prototype acceptance |
| ET-002b | ET-002a, CAP-01 | Finalized protocol package |
| ET-004b | ET-004a, ET-002b | Finalized pipe transport package |
| ET-005b | ET-005a, ET-002b, CAP-01 | Broader simulator package |
| ET-006b | ET-006a, ET-004b, ET-005b | Finalized ingestion package |

ET-022 and SP-01 can run concurrently after ET-001 is accepted and merged. Follow the package graph above and verify live card criteria. A package prerequisite requires its acceptance criteria and merge; a parent card is Done only when all its packages are accepted. Do not build on an unmerged dependency or introduce stacked PRs without owner authorization. ET-009 game evidence does not depend on ET-022, but relevant code checks remain mandatory. ET-009 requires both games and the multiplayer/display matrix; simulator success does not close this gate. The owner alone authorizes merges.

Owner exception on October 11, 2026: start ET-002a implementation and a draft PR from updated `main` before SP-01 acceptance or merge. SP-01 remains draft: the failed ETS2 single-player windowed appearance check needs a real retry, and Convoy evidence remains pending. This exception permits independent protocol v0 work only; it does not accept SP-01, establish game compatibility, enable protocol v1, or waive other package acceptance and merge prerequisites.

Owner decision on October 11, 2026: ET-002a was explicitly accepted after its exact-head checks and independent review; PR #9 was squash merged as `247c076cf803529c4650e125544faaf0bc3ccad7`. The owner expanded the sequencing exception to start ET-003 and ET-005a from that updated `main` while SP-01 remains unaccepted and PR #8 stays draft. The real ETS2 single-player windowed retry and Convoy checks remain mandatory pending evidence. This decision changes sequencing only; it does not establish game compatibility, authorize protocol v1, or waive the acceptance and merge criteria of subsequent packages.

Owner sequencing decision on October 11, 2026: ET-004a, ET-006a and ET-007 may start before full acceptance of ET-003/ET-005a, using isolated branches based on their independently reviewed PR #10/#11 commits. Those prerequisites remain unaccepted draft PRs; every missing game/environment/desktop criterion remains pending. This exception does not mark packages Done, authorize v1/history or extend scope to ET-008 or later phases.
Owner sequencing decision on October 11, 2026 initially allowed ET-004a, ET-006a and ET-007 to start on isolated branches based on independently reviewed, unaccepted PR #10/#11 commits. Every missing criterion remains pending; this exception does not authorize v1/history or extend scope to ET-008 or later phases.

Owner acceptance update on October 11, 2026: ET-005a was explicitly accepted and PR #11 squash merged as `a9cc9b34f25480226d34b86c2fb5100c55e9312e`, from verified source `00402bb90abfc41da748b9ff629b460d629c9ee8`. ET-006a now continues against accepted ET-002a and ET-005a on updated main. ET-003/ET-004a/ET-007 and SP-01 remain unaccepted; required game, environment and performance checks remain pending. ET-005b still requires ET-002b/CAP-01, so the ET-005 parent card is not Done. This acceptance does not waive other package gates.

Owner decision on October 11, 2026: ET-006a implementation and automated evidence were accepted for squash merge. PR #13 merged as `123663d8186cef7ff4745d9474caab68d3be6fa4` from source `69dba2c`, after final Ready CI run 38174065173 and independent source/raw evidence review passed. ET-006b and mandatory game, environment and performance checks remain pending. The owner requested preparing existing PR #10/#12/#14 for merge; this does not merge or accept those packages, waive their manual criteria or extend scope to ET-008/v1/history.

## Delegation and file ownership

Use the session's subagent tools for bounded assignments. Do not create separate user-owned chats or message existing unrelated chats unless the owner explicitly requests that action. Workers must not spawn further agents unless the coordinator explicitly assigns that delegation.

For parallel cards, use a separate task branch and worktree per card. Subagent creation alone does not provide filesystem isolation. Pass the absolute working directory to every worker and reviewer. Inspect existing worktrees before creating another. Keep the coordinator's control checkout and ledger location stable.

If isolated worktrees are unavailable, serialize implementation. Within one card, multiple agents may use one checkout only with disjoint file ownership and a single agent responsible for branch changes, staging, and commits. Never let agents switch branches in another agent's active checkout. Workers may make scoped local commits in their exclusive worktree; the coordinator normally owns pushes, PR creation, and Trello writes.

Name an owner for shared protocol types, root manifests, lockfiles, native build files, migrations, and test configuration before parallel edits. Reserve those files to one writer or integrate agreed changes sequentially. Coordinate contracts before implementing their consumers. Worktrees prevent working-file collisions; they do not prevent incompatible interfaces or merge conflicts.

Every worker assignment includes:

```text
Role: implementation worker
Card ID and URL; objective and current acceptance criteria:
Prerequisites and verified base commit:
Absolute worktree path and task branch:
Owned files/modules; shared files requiring coordination:
Required interfaces/invariants and explicit exclusions:
Relevant REG scenarios and required checks:
Local commit responsibility; no push, PR, or Trello write unless assigned:
Return: changed paths, commit/diff, criterion-by-criterion results,
actual commands and outcomes, remaining checks, blockers, and next action.
Read applicable AGENTS.md, concept.md, TESTING.md, and the card brief.
Report scope conflicts promptly; do not overwrite another agent's work.
```

Steer a worker when new evidence changes its assignment. On reassignment or interruption, first confirm the old worker has stopped editing, inspect its changes and commits, and preserve its useful work. Do not infer completion from a tool returning or an agent saying "done."

## Verification and independent review

The coordinator reads the final diff and checks that the assigned scope, shared interfaces, and card criteria are satisfied. Follow TESTING.md for existing baseline checks and additional boundary checks. Feature tests belong in their feature PR; ET-022 and ET-019 do not replace them. For documentation-only tasks, use document checks rather than application tests.

Use a separate reviewer subagent for each implementation PR. Give it the card brief, requirements, exact candidate commit, base commit, absolute worktree path, relevant REG scenarios, and reported checks. Request review of correctness, data integrity, security boundaries, contract compatibility, missing tests, and scope drift as applicable. Reviewers return actionable findings with file/line references and remaining acceptance gaps; they do not edit files, publish reviews, or merge.

Resolve relevant findings, inspect the fixes, and rerun affected checks. Record reviewer identity and reviewed commit. New changes invalidate relevant earlier review/check evidence; verify the final PR commit. Report flaky results and unavailable checks explicitly. If subagent tools are unavailable, disclose the missing independent review, perform useful work, and preserve that gap in the PR and ledger.

Use real pipes and isolated storage for their integration boundaries, deterministic fixtures for domain logic, and actual games for SDK/window/input compatibility as TESTING.md requires. Never substitute simulator results for ETS2, ATS, Convoy, TruckersMP, latency, or frame-time evidence. Do not install or replace a DLL while the game is running or touch unrelated plugins. Coordinate required manual sessions with the owner using a concrete checklist and candidate identity.

## PR and board lifecycle

Follow the Git workflow and [.github/pull_request_template.md](.github/pull_request_template.md). Keep one coherent task per PR by default, link the Trello card, report actual checks on the candidate commit, and state remaining verification. Push the task branch, open a PR targeting `main`, attach it to the Codex chat when supported, and post its link to the card. Recover an existing PR after an uncertain outcome instead of creating a duplicate.

Use a draft PR while implementation, required checks, or independent review remain unfinished. Move the card to Review when changes are available for verification and list every unresolved criterion. Mark the PR ready for owner review when required evidence and reviewer findings are resolved. CI skips draft PRs (ET-024): obtain draft-head CI evidence by manual dispatch on the task branch as described in [docs/ci.md](docs/ci.md#triggers-and-draft-checks), and dispatch deliberately rather than after every push. The PR check list does not show dispatch runs; record the run link. Marking the PR ready starts the pull-request run on the merge result; that run on the final head is the merge gate. If it fails, return the PR to draft and record the failure. The owner reviews and merges by default. Never merge, publish a release, rewrite published history, or bypass the main guard without the required explicit owner authorization.

Map these logical statuses to the board's current lists; inspect names and IDs rather than creating a new workflow. Initial list labels are recorded here only as external identifiers.

| Logical status | Initial list | Rule |
| --- | --- | --- |
| Backlog | `Нужно сделать` | Not yet eligible or selected |
| Ready | `Ready` | Dependencies accepted/merged, brief clear, within scope |
| In Progress | `В процессе` | One worker assigned; branch/worktree recorded |
| Review | `Review` | PR/evidence available; outstanding criteria explicit |
| Blocked | `Blocked` | No useful work on this card can proceed; record cause and unblock action |
| Done | `Готово` | All mandatory criteria accepted and implementation PR merged |

Keep ET-000 in its guide list and future-phase cards in Later unless authorized otherwise. Check off only evidenced checklist items. Owner-review waiting normally remains Review. A rejected or closed-unmerged PR is not Done. A merge with missing required acceptance stays incomplete and cannot unlock dependents. Record blockers on the affected card without stopping independent work.

After a confirmed squash merge, record the merged commit, update local `main` with `git pull --ff-only`, reconcile the card, and select the next eligible task. Delete/archive a task checkout only after confirming the merge and preserving remaining work. Apply pending board writes once access returns, rereading current state first.

## Recovery ledger and owner handoff

Maintain `.local/coordinator-state.md` in the recorded control checkout; this path is ignored by Git. Only the coordinator writes it. Create it on the first actual coordinator run, update it after assignments, blockers, checks, PR changes, and merges, and before yielding or context handoff. Do not commit transient state, raw logs, credentials, or the temporary Trello manifest.

Use this compact structure; replace placeholders with verified facts or explicit pending values:

```markdown
# Coordinator State

Updated UTC: <timestamp>
Authorized scope and stop condition: <owner instruction>
Control checkout and ledger path: <absolute paths>
Board access/snapshot: <read/write availability, source, verification time>
Verified main commit: <SHA>

| Card / URL | Status | Worker | Worktree / branch | Base / candidate SHA | PR | Next action |
| --- | --- | --- | --- | --- | --- | --- |

## Ownership and interfaces
<shared-file reservations and agreed interfaces>

## Evidence by card
<criterion, REG scenario, command/result, tested SHA, review SHA/findings,
manual evidence, accepted/merged commit; keep missing evidence pending>

## Blockers and pending board updates
<cause, required owner/external action, exact unsynchronized updates>

## Resume
<next eligible task, active work to preserve, decisions needing input>
```

On resume, read the ledger but verify current branches, PR state, tool access, board status, and active agents before assigning work. Local state may be absent in a new worktree or machine: rebuild it from PRs, card comments, and explicit owner instructions. Do not assume previous agents or background runs are still active.

Give concise Russian progress updates focused on outcomes and blockers. At handoff, list prepared PRs, checks actually performed, unresolved criteria, the exact owner action needed, and the next eligible work. A yielded chat does not automatically restart after a merge; continue when the owner sends a resume message or an explicitly authorized automation invokes it.

## Official workflow references

- [OpenAI: Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): bounded delegation, context, and review workflows.
- [OpenAI: Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees): independent checkouts for parallel work.

These references inform the workflow; available tools and permissions must still be verified in each session. This document does not install tools or configure a Trello integration.
