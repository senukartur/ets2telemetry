# Claude Code delivery pipeline

The `/deliver` command runs one task through four project-defined Claude Code subagents and opens a draft PR. It automates the planning, implementation, checks and independent review steps that [AGENTS.md](../AGENTS.md) and [TESTING.md](../TESTING.md) already require. It adds no authority: owner decisions in `AGENTS.md`, real-game acceptance and owner merges still apply.

This is a Claude Code workflow. Codex does not read these files. The optional [coordinator role](../COORDINATOR.md) remains the way to run a Trello-driven multi-card session. A coordinator may use these agents as its worker, verifier and reviewer types.

## Files

| File | Role | Tools |
| --- | --- | --- |
| [`.claude/agents/architect.md`](../.claude/agents/architect.md) | Checks scope against owner decisions and writes a plan: branch, owned files, design, tests, checks and remaining verification | Read-only, plus web lookup of primary sources |
| [`.claude/agents/implementer.md`](../.claude/agents/implementer.md) | Implements the plan with tests in an assigned worktree; commits locally | Read, edit and shell; no push, PR or Trello access |
| [`.claude/agents/verifier.md`](../.claude/agents/verifier.md) | Selects checks from the diff, runs each once, and returns a compact `PASS`/`FAIL`/`INCOMPLETE` report | Shell and read; no edits |
| [`.claude/agents/reviewer.md`](../.claude/agents/reviewer.md) | Reviews the candidate diff independently and returns verified findings by severity | Read-only |
| [`.claude/skills/deliver/SKILL.md`](../.claude/skills/deliver/SKILL.md) | The `/deliver` orchestration steps that the main session follows | The main session's tools |

None of the agents can start further agents. The main session is the only orchestrator.

## Usage

In a Claude Code session opened at the repository root:

```text
/deliver ET-010
/deliver ET-004b --review-plan
/deliver fix the overlay unit label for ATS
```

A card or package ID makes the orchestrator read that Trello card read-only. Free text runs as `NO-CARD`. `--review-plan` always pauses after planning. Without it, the run pauses only when the architect reports a scope problem, open questions, or a change to requirements, architecture, the wire protocol, storage, IPC or security boundaries.

## Flow and limits

1. **Plan:** the architect returns a plan. It is saved to `.local/deliver/<slug>/plan.md`.
2. **Worktree:** the orchestrator creates `.local/worktrees/<slug>` on a new task branch from `origin/main`. It installs dependencies only for code changes.
3. **Implement:** the implementer commits on the task branch. The orchestrator checks the commits and diff itself.
4. **Verify:** the verifier runs the checks. On failure, the same implementer gets the excerpts. The limit is 2 fix rounds.
5. **Review:** a fresh reviewer examines the diff. The orchestrator accepts or rejects each finding with evidence. Accepted fixes are verified again. The limit is 2 review rounds.
6. **Publish:** the orchestrator pushes, opens a draft PR from the template and dispatches Windows CI once for code changes, without polling it.

Run state is kept in `.local/deliver/<slug>/state.md`, so an interrupted run can be resumed. The run stops for the owner when a limit is reached or a step would need a game launch, real user data, credentials or a destructive Git operation.

## What it does not establish

- A verifier `PASS` covers local checks on one commit. The merge gate is still the Windows CI run after **Ready for review** on the final head ([CI triggers](ci.md#triggers-and-draft-checks)).
- The reviewer agent is an independent reviewer in the sense of `COORDINATOR.md`. Like the advisory [AI review](ai-review.md), it is not owner approval.
- Real ETS2/ATS, TruckersMP, display, latency and frame-time criteria stay pending. They need actual game sessions.
- The pipeline never marks a PR ready, merges it, or writes to Trello unless the owner asks for that in the session.

## Changing the agents

Agent and skill files are Markdown with YAML frontmatter. The Claude Code [subagent](https://code.claude.com/docs/en/sub-agents) and [skill](https://code.claude.com/docs/en/slash-commands) references list the supported fields. Unknown fields are ignored silently, so check field names against those pages. Project agents override user agents of the same name in `~/.claude/agents/`. Keep agent instructions consistent with `AGENTS.md`, and update this page when the flow changes.
