# Delivery pipeline

The `deliver` skill (`/deliver` in Antigravity and Claude Code, `$deliver` in OpenAI Codex) runs one task through four project-defined subagents (`architect`, `implementer`, `verifier` and `reviewer`) and opens a draft PR. It automates the planning, implementation, checks and independent review steps that [AGENTS.md](../AGENTS.md) and [TESTING.md](../TESTING.md) already require. It adds no authority: owner decisions in `AGENTS.md`, real-game acceptance and owner merges still apply.

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
| `implementer` | [`implementer.md`](../.agents/agents/implementer.md) | [`implementer.toml`](../.codex/agents/implementer.toml) | [`implementer.md`](../.claude/agents/implementer.md) | Implements the plan with tests in an assigned worktree; commits locally; no push, PR or Trello writes |
| `verifier` | [`verifier.md`](../.agents/agents/verifier.md) | [`verifier.toml`](../.codex/agents/verifier.toml) | [`verifier.md`](../.claude/agents/verifier.md) | Runs the local equivalent of the Windows CI jobs (plus packaged runtime smokes when desktop, packaging or client paths change), runs each check once, and returns a compact `PASS`/`FAIL`/`INCOMPLETE`/`INVALID` report; never edits files |
| `reviewer` | [`reviewer.md`](../.agents/agents/reviewer.md) | [`reviewer.toml`](../.codex/agents/reviewer.toml) | [`reviewer.md`](../.claude/agents/reviewer.md) | Reviews the candidate diff independently and returns verified findings by severity; never edits files |

Claude Code also keeps its runtime-specific skill entrypoint at [`.claude/skills/deliver/SKILL.md`](../.claude/skills/deliver/SKILL.md).

None of the subagents may spawn further agents. The main session is the only orchestrator. Because all four subagents can run shell commands, their remaining limits (no Git state changes in read-only agents, no push, no PR or Trello writes, no game or real user-data access) are enforced both by instructions and by the orchestrator checking the worktree HEAD and `git status` after every agent and owning every push and PR action.

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

A card or package ID makes the orchestrator read that Trello card read-only. Free text runs as `NO-CARD`. `--review-plan` always pauses after planning. Without it, the run pauses only when the architect reports a scope problem, open questions, or a change to requirements, architecture, a wire protocol, storage, IPC or security boundaries.

## Flow and limits

1. **Plan:**
   - Run state starts in `.local/deliver/<run key>/state.md`; the run key is the card ID or a short task summary.
   - The architect returns a plan, saved next to the state as `plan.md`.
2. **Worktree:**
   - The orchestrator checks that the planned branch and PR do not exist yet.
   - It creates `.local/worktrees/<slug>` on a new branch from `origin/main`.
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
   - The orchestrator opens a draft PR from the template.
   - For code changes, it dispatches Windows CI once and records the matching run link, without waiting for the result.

Every build in the pipeline is a staging build (ET-055 UP13; [build channels](setup.md#build-channels-et-055)). The agents leave `ETS2TELEMETRY_BUILD_CHANNEL` unset, never build with `production` or set the owner-only `ETS2TELEMETRY_OWNER_PRODUCTION_BUILD`, and never install or run a production-identity build; a feature-test build for the owner is a staging Setup, which installs beside production. Production artifacts come only from a Windows CI run on `main`; the pipeline's dispatch on the task branch builds staging, and its artifact is never installed as production.

The run has a budget of 2 fix rounds in total, shared by verifier failures and review fixes, and at most 2 review passes. Starting `deliver` again with the same task resumes from `state.md`. The recorded branch, HEAD and PR are first re-verified against Git and GitHub, and fresh agents are started. The run stops for the owner when a limit is reached or a step would need a game launch, real user data, credentials or a destructive Git operation.

## What it does not establish

- A verifier `PASS` covers local checks on one commit. The merge gate is still the Windows CI run after **Ready for review** on the final head ([CI triggers](ci.md#triggers-and-draft-checks)).
- The reviewer agent is an independent reviewer in the sense of `COORDINATOR.md`; it is not owner approval.
- Real ETS2/ATS, TruckersMP, display, latency and frame-time criteria stay pending. They need actual game sessions.
- The pipeline never marks a PR ready, merges it, or writes to Trello unless the owner asks for that in the session.

## Changing the agents

- **Antigravity:** Custom subagents in `.agents/agents/*.md` and skills in `.agents/skills/*/SKILL.md` use Markdown with YAML frontmatter; see the Antigravity [subagents](https://antigravity.google/docs/subagents/) and [skills](https://antigravity.google/docs/skills/) documentation. In Antigravity on Windows, `run_command` executes in PowerShell and forbids `cd` commands; pass `Cwd` or `git -C` instead.
- **OpenAI Codex:** Project custom agents in `.codex/agents/*.toml` use TOML validated against `https://developers.openai.com/codex/config-schema.json`, and skills in `.agents/skills/*/SKILL.md` use YAML frontmatter with optional `agents/openai.yaml` metadata; see the Codex [subagents](https://developers.openai.com/codex/multi-agent) and [skills](https://developers.openai.com/codex/skills) references.
- **Claude Code:** Subagents in `.claude/agents/*.md` and skills in `.claude/skills/*/SKILL.md` use Markdown with YAML frontmatter; see the Claude Code [subagent](https://code.claude.com/docs/en/sub-agents) and [skill](https://code.claude.com/docs/en/slash-commands) references.

Keep all three runtime definitions consistent with `AGENTS.md` and `.github/workflows/windows-ci.yml`, and update this page when the flow changes.
