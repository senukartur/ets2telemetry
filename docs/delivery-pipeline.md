# Delivery pipeline

The `deliver` skill (`/deliver` in Antigravity and Claude Code, `$deliver` in OpenAI Codex) runs one task through four project-defined subagents (`architect`, `implementer`, `verifier` and `reviewer`) and takes its PR through Ready for review, successful final-head CI (or an explicit documentation-only CI exclusion) and addressed PR feedback to a squash merge. It automates the planning, implementation, checks and independent review steps that [AGENTS.md](../AGENTS.md) and [TESTING.md](TESTING.md) already require. The [owner delivery decision](../DECISION-LOG.md#deliver-ready-and-feedback-handoff--november-3-2026) authorizes the Ready transition and task feedback replies/resolutions, and the [merge and card status decision](../DECISION-LOG.md#deliver-merge-and-trello-card-status--november-4-2026) authorizes the merge and makes the run keep its card status current; the other owner decisions and real-game acceptance still apply.

The optional [coordinator role](../COORDINATOR.md) remains the way to run a Trello-driven multi-card session. A coordinator in Antigravity, Codex or Claude Code may also use these subagent definitions as its worker, verifier and reviewer roles.

## Files

### Shared skill (Antigravity and OpenAI Codex)

| File | Role |
| --- | --- |
| [`.agents/skills/deliver/SKILL.md`](../.agents/skills/deliver/SKILL.md) | Orchestration steps discovered automatically by both Antigravity (`/deliver`) and OpenAI Codex (`$deliver`) |
| [`.agents/skills/deliver/agents/openai.yaml`](../.agents/skills/deliver/agents/openai.yaml) | Codex UI metadata and `allow_implicit_invocation: false` policy so the pipeline runs only when explicitly invoked |

### Subagents by runtime

| Role | Antigravity (`.agents/agents/`) | OpenAI Codex (`.codex/agents/`) | Claude Code (`.claude/agents/`) | Responsibility |
| --- | --- | --- | --- | --- |
| `architect` | [`architect.md`](../.agents/agents/architect.md) | [`architect.toml`](../.codex/agents/architect.toml) | [`architect.md`](../.claude/agents/architect.md) | Checks scope against owner decisions and writes a plan: branch, owned files, design, tests, checks and remaining verification; never edits files |
| `implementer` | [`implementer.md`](../.agents/agents/implementer.md) | [`implementer.toml`](../.codex/agents/implementer.toml) | [`implementer.md`](../.claude/agents/implementer.md) | Implements the plan with tests in an assigned worktree; commits locally; no push or PR |
| `verifier` | [`verifier.md`](../.agents/agents/verifier.md) | [`verifier.toml`](../.codex/agents/verifier.toml) | [`verifier.md`](../.claude/agents/verifier.md) | Runs the affected-check plan (`npm run test:affected`, ET-066) and the plan's extra checks, runs each check once, and returns a compact `PASS`/`FAIL`/`INCOMPLETE`/`INVALID` report; never edits files |
| `reviewer` | [`reviewer.md`](../.agents/agents/reviewer.md) | [`reviewer.toml`](../.codex/agents/reviewer.toml) | [`reviewer.md`](../.claude/agents/reviewer.md) | Reviews the candidate diff independently and returns verified findings by severity; never edits files |

Claude Code also keeps its runtime-specific skill entrypoint at [`.claude/skills/deliver/SKILL.md`](../.claude/skills/deliver/SKILL.md).

None of the subagents may spawn further agents. The main session is the only orchestrator. Because all four subagents can run shell commands, their remaining limits (no Git state changes in read-only agents, no push, no PR or card moves, no game or real user-data access) are enforced both by instructions and by the orchestrator checking the worktree HEAD and `git status` after every agent and owning every push and PR action.

## Usage

In Antigravity or Claude Code opened at the repository root:

```text
/deliver ET-010
/deliver ET-004b --review-plan
/deliver fix the overlay unit label for ATS
```

In OpenAI Codex opened at the repository root:

```text
$deliver ET-010
$deliver ET-004b --review-plan
$deliver fix the overlay unit label for ATS
```

A card or package ID makes the orchestrator read that Trello card and keep its status current: `В процессе` when the worktree is created, a comment with the PR link, and `Review` at handoff. The card moves to `Готово` only after its PR is merged and when no manual or real-game check and no other package of the card remains; a card that needs such checks stays in `Review` with a comment listing what to check, how and on which build. Any agent may comment on the card to record important information; only the orchestrator moves it. Free text runs as `NO-CARD` and writes nothing to Trello. `--no-merge` ends the run at the verified handoff and leaves the merge to the owner. `--review-plan` always pauses after planning. Without it, the run pauses only when the architect reports a scope problem, open questions, or a change to requirements, architecture, a wire protocol, storage, IPC or security boundaries.

## Flow and limits

0. **Refresh target and instructions:**
   - Before planning or other workflow actions on every start/resume, resolve the intended PR target: the owner's explicit target, otherwise the existing PR base, otherwise `main`.
   - Fetch that branch successfully and pin its SHA. Read the runtime skill, repository rules and agent definitions from that exact commit; a fetch alone does not update an old checkout or instructions already loaded in a chat. Failed fetches or missing required target instructions stop the run.
   - Keep the root checkout and existing task work intact. A resumed run records the fresh target tip separately from its original base; it does not reset or recreate the task branch.
1. **Plan:**
   - Run state starts in `.local/deliver/<run key>/state.md`; the run key is the card ID or a short task summary.
   - The architect returns a plan, saved next to the state as `plan.md`.
2. **Worktree:**
   - The orchestrator checks that the planned branch and PR do not exist yet.
   - It creates `.local/worktrees/<slug>` on a new branch from the freshly fetched target SHA.
   - It installs dependencies only for code changes.
3. **Implement:**
   - The implementer commits on the task branch.
   - The orchestrator checks the commits and the diff itself.
4. **Verify:**
   - The verifier runs the checks.
   - On failure, the implementer gets the excerpts.
   - `INVALID` (unexpected HEAD or tree state) stops the run.
5. **Review:**
   - A fresh reviewer examines the diff.
   - The orchestrator accepts or rejects each finding with evidence.
   - Every fix, including a minor one, goes through verification again and a review pass over the fix delta.
6. **Publish:**
   - Only the commit that was last verified and reviewed is pushed.
   - The orchestrator opens a draft PR from the template against the recorded target branch.
   - It addresses existing feedback and unresolved threads, then marks the PR Ready for review without another owner confirmation. Ready starts hosted CI; it does not claim that CI has already passed. Hosted failures may first appear while the PR is ready, and keep delivery incomplete.
7. **Monitor and hand over:**
   - Discover the expected advisory review for up to 2 minutes after Ready, disclosing an absent run; wait for the automatic final-head Windows CI run and discovered/already-started advisory review runs; inspect conversation comments, reviews and all inline threads, including replies and edited feedback.
   - Diagnose CI failures, fix accepted findings within scope, verify and review every new candidate, push it, and repeat CI/feedback checks. Reply with the actual fixing SHA or evidence for not changing the code before resolving a thread; summary findings also get a reply.
   - Finish only after a fresh check confirms the PR is ready, all three required CI jobs actually succeeded on the final source, and observed feedback is addressed with no unresolved threads or accepted blocker/major findings. A diff limited to `**.md` and `docs/**` gets document checks and an explicit CI exclusion, never a green claim; skill metadata/config changes still trigger CI.
   - Record final evidence in the PR description and resumable state locally. Monitoring ends at this handoff; later feedback is handled when the same task resumes. No recurring automation is created implicitly.
8. **Merge:**
   - With independent review passed, no unresolved thread and the three required jobs green on the final head, the orchestrator squash-merges the PR with `--match-head-commit`. A documentation-only PR is merged under the `--admin` rule in [branch protection](agent-rules.md#branch-protection--october-16-2026).
   - A refused merge is never bypassed; a conflict with the target branch becomes a new candidate. After the merge the card status rules decide between `Готово` and `Review`. `--no-merge` skips this step.

Every build in the pipeline is a staging build (ET-055 UP13; [build channels](setup.md#build-channels-et-055)). The agents leave `ETS2TELEMETRY_BUILD_CHANNEL` unset, never build with `production` or set the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD`, and never install or run a production-identity build; a feature-test build for the owner is a staging Setup, which installs beside production. Production artifacts come only from a Windows CI run on `main`; the pipeline's PR runs and any recovery dispatch on the task branch build staging, and their artifacts are never installed as production.

The run has a budget of 4 fix rounds in total, shared by verifier failures, independent review fixes, CI failures and PR feedback fixes, and at most 5 independent review passes (initial candidate plus the 4 possible fix rounds). Every changed candidate, including post-publish fixes, must be reviewed before pushing. A later push does not trigger the advisory bot again; independent review covers that candidate. Waits are bounded to 60 seconds per call; a monitoring cycle with no terminal CI/review result after 60 minutes is saved as awaiting CI/review, never done. Starting `deliver` again with the same task resumes from `state.md`. The recorded branch, HEAD and PR are first re-verified against Git and GitHub, and fresh agents are started as needed. An unexpected remote-head change stops for reconciliation and must be verified/reviewed before adoption. The run stops for the owner when a limit leaves required work incomplete or a step would need a game launch, real user data, credentials or a destructive Git operation.

## What it does not establish

- A verifier `PASS` covers local checks on one commit. Delivery also waits for the Windows CI run after **Ready for review** on the final head ([CI triggers](ci.md#triggers-and-draft-checks)).
- The reviewer agent is an independent reviewer in the sense of `COORDINATOR.md`; it is not owner approval.
- Real ETS2/ATS, TruckersMP, display, latency and frame-time criteria stay pending. They need actual game sessions.
- Invoking the pipeline authorizes its Ready transition, task-related review replies/resolutions, the squash merge and the card status updates above. It authorizes no release, and a merge does not establish real-game acceptance.

## Changing the agents

- **Antigravity:** Custom subagents in `.agents/agents/*.md` and skills in `.agents/skills/*/SKILL.md` use Markdown with YAML frontmatter; see the Antigravity [subagents](https://antigravity.google/docs/subagents/) and [skills](https://antigravity.google/docs/skills/) documentation. In Antigravity on Windows, `run_command` executes in PowerShell and forbids `cd` commands; pass `Cwd` or `git -C` instead.
- **OpenAI Codex:** Project custom agents in `.codex/agents/*.toml` use TOML validated against `https://developers.openai.com/codex/config-schema.json`, and skills in `.agents/skills/*/SKILL.md` use YAML frontmatter with optional `agents/openai.yaml` metadata; see the Codex [subagents](https://developers.openai.com/codex/multi-agent) and [skills](https://developers.openai.com/codex/skills) references.
- **Claude Code:** Subagents in `.claude/agents/*.md` and skills in `.claude/skills/*/SKILL.md` use Markdown with YAML frontmatter. The subagents' `tools` lists name the Trello connector's card read and write tools by their full MCP names; update them if the connector's server ID changes; see the Claude Code [subagent](https://code.claude.com/docs/en/sub-agents) and [skill](https://code.claude.com/docs/en/slash-commands) references.

Keep all three runtime definitions consistent with `AGENTS.md`, `docs/agent-rules.md` and `.github/workflows/windows-ci.yml`, and update this page when the flow changes.
