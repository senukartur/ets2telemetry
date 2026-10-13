# Claude Code delivery pipeline

The `/deliver` command runs one task through four project-defined Claude Code subagents and opens a draft PR. It automates the planning, implementation, checks and independent review steps that [AGENTS.md](../AGENTS.md) and [TESTING.md](../TESTING.md) already require. It adds no authority: owner decisions in `AGENTS.md`, real-game acceptance and owner merges still apply.

This is a Claude Code workflow. Codex does not read these files. The optional [coordinator role](../COORDINATOR.md) remains the way to run a Trello-driven multi-card session. A coordinator may use these agents as its worker, verifier and reviewer types.

## Files

| File | Role | Tools |
| --- | --- | --- |
| [`.claude/agents/architect.md`](../.claude/agents/architect.md) | Checks scope against owner decisions and writes a plan: branch, owned files, design, tests, checks and remaining verification | Read, search, shell and web lookup; no edit tools |
| [`.claude/agents/implementer.md`](../.claude/agents/implementer.md) | Implements the plan with tests in an assigned worktree; commits locally | Read, edit and shell; no Trello or agent tools |
| [`.claude/agents/verifier.md`](../.claude/agents/verifier.md) | Runs the local equivalent of the Windows CI job (runtime smokes when desktop, packaging or client paths change), runs each check once, and returns a compact `PASS`/`FAIL`/`INCOMPLETE`/`INVALID` report | Shell and read; no edit tools |
| [`.claude/agents/reviewer.md`](../.claude/agents/reviewer.md) | Reviews the candidate diff independently and returns verified findings by severity | Read, search, shell and web lookup; no edit tools |
| [`.claude/skills/deliver/SKILL.md`](../.claude/skills/deliver/SKILL.md) | The `/deliver` orchestration steps that the main session follows | The main session's tools |

None of the agents can start further agents. The main session is the only orchestrator.

Tool lists remove the edit tools from the architect, verifier and reviewer. All four agents keep `Bash`, so their remaining limits (no Git state changes, no push, no PR or Trello writes, no game or user-data access) are instructions, not enforcement. The orchestrator compensates by checking the worktree HEAD and status after every agent and by owning every push and PR action.

## Usage

In a Claude Code session opened at the repository root:

```text
/deliver ET-010
/deliver ET-004b --review-plan
/deliver fix the overlay unit label for ATS
```

A card or package ID makes the orchestrator read that Trello card read-only. Free text runs as `NO-CARD`. `--review-plan` always pauses after planning. Without it, the run pauses only when the architect reports a scope problem, open questions, or a change to requirements, architecture, the wire protocol, storage, IPC or security boundaries.

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

The run has a budget of 2 fix rounds in total, shared by verifier failures and review fixes, and at most 2 review passes. Starting `/deliver` again with the same task resumes from `state.md`. The recorded branch, HEAD and PR are first re-verified against Git and GitHub, and fresh agents are started. The run stops for the owner when a limit is reached or a step would need a game launch, real user data, credentials or a destructive Git operation.

## What it does not establish

- A verifier `PASS` covers local checks on one commit. The merge gate is still the Windows CI run after **Ready for review** on the final head ([CI triggers](ci.md#triggers-and-draft-checks)).
- The reviewer agent is an independent reviewer in the sense of `COORDINATOR.md`. Like the advisory [AI review](ai-review.md), it is not owner approval.
- Real ETS2/ATS, TruckersMP, display, latency and frame-time criteria stay pending. They need actual game sessions.
- The pipeline never marks a PR ready, merges it, or writes to Trello unless the owner asks for that in the session.

## Changing the agents

Agent and skill files are Markdown with YAML frontmatter. The Claude Code [subagent](https://code.claude.com/docs/en/sub-agents) and [skill](https://code.claude.com/docs/en/slash-commands) references list the supported fields. Unknown fields are ignored silently, so check field names against those pages. Project agents override user agents of the same name in `~/.claude/agents/`. Keep agent instructions consistent with `AGENTS.md`, and update this page when the flow changes.
