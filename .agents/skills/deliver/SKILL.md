---
name: deliver
description: >-
  Run the plan, implement, verify and review pipeline for one ETS2Telemetry
  task and open a draft PR. Activate only when the owner explicitly invokes
  /deliver or $deliver with a card ID or task description.
---

# /deliver

Deliver one task through the project subagents and open a draft PR:

```text
architect -> implementer -> verifier -> reviewer -> draft PR
                 ^              |           |
                 +-- fixes -----+-----------+
```

Task: $ARGUMENTS

You are the orchestrator. Run every agent sequentially, because each step depends on the previous one. You own the Git branch setup, pushes, the PR and CI dispatch. Subagents start cold. Pass them absolute paths and every fact they need. Within one session, continue an existing subagent rather than starting a new one when sending follow-up instructions for the same role.

Read [docs/delivery-pipeline.md](../../../docs/delivery-pipeline.md) for the design. This pipeline does not replace the coordinator role in `COORDINATOR.md` and grants no authority beyond `AGENTS.md`. Never mark the PR ready, merge it, or write to Trello unless the owner asks for that in this conversation.

Talk to the owner in Russian. Write plans, commits, PR text and repository files in English.

## Runtime mapping

Use the tools of the active runtime (Antigravity or OpenAI Codex):

| Capability | Antigravity | OpenAI Codex |
| --- | --- | --- |
| **Agent definitions** | `.agents/agents/{architect,implementer,verifier,reviewer}.md` (discovered automatically by Antigravity). | `.codex/agents/{architect,implementer,verifier,reviewer}.toml` (discovered automatically by Codex). |
| **Start a subagent** | Call `invoke_subagent` with `TypeName` (`architect`, `implementer`, `verifier`, `reviewer`), `Model: "inherit"` (unless the owner explicitly asked for another tier), and `Workspace: "inherit"`. End your turn after `invoke_subagent` and wait for the system wakeup when the subagent finishes; never poll in a loop. | Spawn the named custom agent (`architect`, `implementer`, `verifier`, `reviewer`) and wait for its result before proceeding to the next step. |
| **Continue an existing subagent** | Call `send_message` with `Recipient: <conversationID>` to wake the idle subagent with its prior context, then end your turn to wait for its reply. | Message or steer the existing subagent thread rather than spawning a new cold agent. |
| **Shell and working directory** | `run_command` runs PowerShell on Windows. **Never use `cd` inside `CommandLine`**; pass `Cwd: "<worktree>"` (or `git -C "<worktree>"`) and prepend `$env:PATH = "<toolchain-prefix>;$env:PATH"; ` when needed. | Pass `workdir: "<worktree>"` or `git -C "<worktree>"`, and prepend `$env:PATH = "<toolchain-prefix>;$env:PATH"; ` (PowerShell) or `export PATH="<toolchain-prefix>:$PATH"` (Git Bash). |
| **Trello read-only lookup** | Read `mcp/trello/trelloReadCard.json` (or `trelloSearch.json`) and call via `call_mcp_tool` (`ServerName: "trello"`). | Use the connected Trello MCP read tools. |

## 1. Understand the task

1. If the task is empty, ask the owner for it and stop.
2. Recognize `--review-plan` anywhere in the arguments: it means always stop after planning for the owner's approval. Strip `--review-plan` before parsing the task text below.
3. If the remaining task starts with a card or package ID (for example `ET-010`, `ET-004b`, `SP-01`, `CAP-01`):
   - Read that Trello card read-only for its brief, checklist and acceptance criteria. If the card cannot be read, ask the owner for the brief.
   - The run key is the ID in lowercase.
4. Without an ID:
   - The remaining task text (without `--review-plan`) is the brief, and the ID is `NO-CARD`. The PR must explain why there is no card.
   - The run key is `nc-` followed by the first six words of the stripped task text, lowercased, with every run of non-alphanumeric characters replaced by one hyphen. For example, `fix the overlay unit label for ATS` becomes `nc-fix-the-overlay-unit-label-for`.
5. The run directory is `.local/deliver/<run key>/` in the repository root. `.local/` is ignored by Git.
6. If no `state.md` exists for this key, also scan `.local/deliver/*/state.md` for an unfinished run with the same brief. If one exists, ask the owner whether to resume it.
7. If `state.md` already exists there, this is a resume. Read it. Then verify the recorded branch, HEAD, worktree and PR against Git and GitHub; the recorded values alone are not proof. Continue from the recorded step. Agent IDs from an earlier session are gone. Start fresh agents, and give them the plan, the state and the current diff.

## 2. Prepare the base

1. In the repository root, inspect `git status`, `git worktree list` and `gh pr list --state open`. Run `gh` and every authenticated Git remote operation (`git fetch`, `git ls-remote`, `git push`) outside the sandbox when sandboxing blocks the Windows keyring. Preserve unrelated local work. If an open PR or worktree obviously belongs to this task, report it and continue there only with the owner's agreement.
2. Run `git fetch origin` and record the SHA of `origin/main` as the base commit. Do not switch the branch of the root checkout.
3. Resolve the toolchain:
   - Use `node --version` (must be 24.19.0) and `cmake --version` if they work.
   - Otherwise look for `.local/toolchain/node-v24.19.0-win-x64` in each checkout that `git worktree list` shows, and for `C:\Program Files\Microsoft Visual Studio\*\*\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin`.
   - If either tool is still missing, ask the owner.

   Build the toolchain `PATH` prefix (Windows `;`-separated path for PowerShell `$env:PATH`, plus POSIX `:`-separated path if Git Bash is used) and pass it to every agent. Never install anything globally. Add `NODE_OPTIONS=--use-system-ca` if npm downloads fail on TLS validation.
4. Create `state.md` with the brief, the run key, the base commit and `step: plan`. Update it after every step below.

## 3. Plan

1. Run the `architect` subagent with the brief, the acceptance criteria, the repository root and the base commit.
2. Save its plan as `plan.md` in the run directory.
3. Confirm that the root checkout's HEAD and `git status` are unchanged by the architect.
4. Stop and show the plan to the owner when any of these holds:
   - Scope is not `OK`.
   - The plan lists open questions.
   - `--review-plan` was given.
   - The plan changes product requirements, major architecture, the wire protocol, the storage schema, the preload/IPC surface or security boundaries.

   Record `step: awaiting plan approval` and continue only after the owner approves. Otherwise, give a short summary of the plan and continue.

## 4. Create the worktree

1. Check that the planned branch is new. `git branch --list <branch>`, `git ls-remote --heads origin <branch>` and `gh pr list --head <branch> --state all` must all be empty. If any of them returns something, report it and ask the owner.
2. Run `git worktree add --no-track -b <branch> .local/worktrees/<slug> <base-sha>`. `<slug>` is the branch name after its prefix. Confirm that `git -C <worktree> config core.hooksPath` prints `.githooks` (and set `git -C <worktree> config --local core.hooksPath .githooks` if not).
3. For a code change, run `npm ci` in the worktree (using `Cwd: "<worktree>"` in Antigravity or `workdir: "<worktree>"` in Codex). A documentation-only change needs no install.
4. Record the worktree and the branch in `state.md`.

## 5. Implement

1. Run the `implementer` subagent with this assignment:

   ```text
   Task ID and brief, acceptance criteria:
   Accepted plan (full text):
   Absolute worktree path, branch, base commit:
   Owned files; shared files needing care:
   Toolchain PATH prefix:
   Attribution trailer for every commit message: <the trailer this session's instructions require, or none>
   Commit locally only. No push, PR, CI dispatch or Trello writes.
   Return the report format from your instructions.
   ```

2. Do not trust the report. Check these yourself:
   - `git -C <worktree> log --oneline <base>..HEAD`
   - `git -C <worktree> status --porcelain`
   - `git -C <worktree> diff --stat <base>...HEAD`

   Confirm that the changes stay within the owned files. Record HEAD as the candidate commit.

## 6. Verify

1. Run the `verifier` subagent with the worktree, the base, the candidate commit, the plan's `Checks` list and the toolchain prefix.
2. If the result is `INVALID`, stop and report. Something changed the worktree unexpectedly.
3. If the result is `FAIL`, send the failure excerpts to the existing `implementer` subagent, then repeat steps 5.2 and 6 on the new candidate.
4. If the result is `INCOMPLETE` because of `NOT RUN` or `FLAKY` checks, continue. Carry every such check into the PR's remaining verification.
5. The run has a budget of 2 fix rounds in total. It is shared by verifier failures and review fixes and never resets. When it is spent and checks still fail, stop and report the last verifier report to the owner.

## 7. Review

1. Run a fresh `reviewer` subagent with the brief, the criteria, the plan, the worktree, the base, the candidate commit and the last verifier report. Do not pass the implementer's conversation.
2. Decide each finding yourself:
   - Accept it, or reject it with evidence.
   - Accepted `blocker` and `major` findings must be fixed.
   - Accepted `minor` and `nit` findings may be fixed in the same round. Otherwise list them in the PR.
3. If any accepted finding is to be fixed:
   - Send all of them to the existing `implementer` subagent at once. This uses one fix round.
   - Run step 5.2 and the full step 6 on the new candidate.
   - Send the fix delta to the same `reviewer` subagent for a follow-up pass.
4. Allow at most 2 review passes. If accepted `blocker` or `major` findings remain open after them, stop and report.
5. Record every finding with its outcome in `state.md`: the fixing commit, the reason for rejection, or "listed in PR".
6. Read-only agents can still run shell commands. After the verifier and the reviewer return, confirm that the worktree HEAD and `git status` are unchanged.

## 8. Publish

1. Precondition: the worktree HEAD equals the final candidate. That candidate's last verifier result is `PASS` or `INCOMPLETE`, and the last review pass covered that exact commit. If not, return to step 6. Record the published SHA in `state.md`.
2. Push with `git -C <worktree> push -u origin <branch>`.
3. Write `pr-body.md` in the run directory from `.github/pull_request_template.md`:
   - Change: the problem and the resulting behavior; the card link or the `NO-CARD` reason.
   - Validation: the published SHA, then only commands that actually ran on it, with their results.
   - Regression protection: tests and REG scenarios. For a documentation-only change, write "Not applicable: documentation only".
   - Remaining verification:
     - `NOT RUN`, `FLAKY` and `CI ONLY` checks;
     - review findings that were rejected or deferred;
     - every real-game, TruckersMP, display or performance criterion this PR cannot satisfy.

   Include a generation footer only if the active session's instructions require one, and never claim a different runtime than the one actually used.
4. Create a draft PR: `gh pr create --draft --base main --head <branch> --title "[<ID>] <type>: <summary>" --body-file <pr-body.md>`. Bind it to this session if the app provides a PR-binding tool.
5. For a code change, dispatch CI once on the draft head: `gh workflow run windows-ci.yml --ref <branch> -f extended=false`. Find that run with `gh run list --workflow windows-ci.yml --branch <branch> --event workflow_dispatch --limit 1 --json databaseId,headSha,url`. The run must have `headSha` equal to the published SHA. If it is not listed yet, retry a few times over about a minute. Record the run link in `state.md` and in a PR comment. Do not wait for the run to finish. A documentation-only change gets no CI run, which is expected and not a pass.

## 9. Report

Tell the owner, in Russian:

- the PR link and the published SHA;
- what changed;
- which checks ran, with their results;
- the review findings and their outcomes;
- the CI run link;
- what remains unverified;
- the worktree path.

Record `step: done` in `state.md`. Leave the worktree in place. Marking the PR ready and merging it are the owner's decisions.

## Stop conditions

Stop and ask the owner instead of continuing when:

- the task conflicts with an owner decision in `AGENTS.md`;
- the plan needs an owner decision;
- the planned branch or PR already exists;
- the verifier reports `INVALID`;
- the fix or review limit is reached;
- an agent reports a blocker it cannot resolve;
- unexpected changes appear in the worktree;
- a step would need a game launch, a game directory change, real user data, credentials or a destructive Git operation.
