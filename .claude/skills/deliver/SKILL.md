---
name: deliver
description: Run the plan, implement, verify and review pipeline for one ETS2Telemetry task and open a draft PR. Started manually by the owner.
argument-hint: "<card ID or task description> [--review-plan]"
disable-model-invocation: true
---

# /deliver

Deliver one task through the project agents and open a draft PR:

```text
architect -> implementer -> verifier -> reviewer -> draft PR
                 ^              |           |
                 +-- fixes -----+-----------+
```

Task: $ARGUMENTS

You are the orchestrator. You run every agent in the foreground, because each step depends on the previous one. You own Git branch setup, pushes, the PR and CI dispatch. Subagents start cold: pass them absolute paths and every fact they need, and continue an existing agent with `SendMessage` rather than starting a new one.

Read [docs/delivery-pipeline.md](../../../docs/delivery-pipeline.md) for the design. This pipeline does not replace the coordinator role in `COORDINATOR.md` and grants no authority beyond `AGENTS.md`. It never marks a PR ready, merges, or writes to Trello unless the owner asks for that in this conversation.

Talk to the owner in Russian. Write plans, commits, PR text and repository files in English.

## 1. Understand the task

1. If the task is empty, ask the owner for it and stop.
2. If it starts with a card or package ID (for example `ET-010`, `ET-004b`, `SP-01`, `CAP-01`), read that Trello card read-only for its brief, checklist and acceptance criteria. If the card cannot be read, ask the owner for the brief. Without an ID, the task text is the brief and the ID is `NO-CARD`. The PR must then explain why no card exists.
3. `--review-plan` in the arguments means: always stop after planning for the owner's approval.

## 2. Prepare the base

1. In the repository root, inspect `git status`, `git worktree list` and `gh pr list --state open` (run `gh` outside the sandbox). Preserve unrelated local work. If a branch, worktree or open PR already exists for this task, report it and continue there only with the owner's agreement. Never start a duplicate.
2. Run `git fetch origin` and record `origin/main` as the base commit. Do not switch the branch of the root checkout.
3. Resolve the toolchain. If `node --version` or `cmake --version` fails, find the pinned tools as `docs/setup.md#toolchain` describes. Pass the resulting `PATH` prefix to every agent. Never install anything globally.

## 3. Plan

1. Run the `architect` agent with the brief, the acceptance criteria, the repository root and the base commit.
2. Save its plan to `.local/deliver/<slug>/plan.md`. `<slug>` is the branch name after its prefix. `.local/` is ignored by Git.
3. Stop and show the plan to the owner when any of these holds:
   - Scope is not `OK`.
   - The plan lists open questions.
   - `--review-plan` was given.
   - The plan changes product requirements, major architecture, the wire protocol, the storage schema, the preload/IPC surface or security boundaries.

   Continue only after the owner approves. Otherwise, give a short summary of the plan and continue.

## 4. Create the worktree

1. Run `git worktree add --no-track -b <branch> .local/worktrees/<slug> <base-sha>`. Confirm that `git -C <worktree> config core.hooksPath` prints `.githooks`.
2. For a code change, run `npm ci` in the worktree, plus `npm run lint:install` when lint applies. If TLS validation fails, set `NODE_OPTIONS=--use-system-ca` as `docs/setup.md` describes. A documentation-only change needs no install.
3. Create `.local/deliver/<slug>/state.md` with the brief, the base commit, the worktree, the branch, the agent IDs and the current step. Update it after every step, so an interrupted run can resume.

## 5. Implement

1. Run the `implementer` agent with this assignment:

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

2. Do not trust the report. Check `git -C <worktree> log --oneline <base>..HEAD`, `git status --porcelain` and `git diff --stat <base>...HEAD` yourself. Confirm that the changes stay within the owned files. Record the candidate commit.

## 6. Verify

1. Run the `verifier` agent with the worktree, the base, the candidate commit, the plan's `Checks` list and the toolchain prefix.
2. If the result is `FAIL`, send the failure excerpts to the same implementer through `SendMessage`, then verify the new candidate. Allow at most 2 fix rounds. If checks still fail, stop and report to the owner with the last verifier report.
3. If the result is `INCOMPLETE` because a tool is missing, continue, but carry each `NOT RUN` check into the PR's remaining verification.

## 7. Review

1. Run a fresh `reviewer` agent with the brief, the criteria, the plan, the worktree, the base, the candidate commit and the last verifier report. Do not pass the implementer's conversation.
2. Decide each `blocker` or `major` finding yourself. Accept it, or reject it with evidence. Send accepted findings to the implementer, then verify again (step 6). Then review the fix delta with the same reviewer through `SendMessage`. Allow at most 2 review rounds; after that, stop and report the open findings.
3. Fix `minor` and `nit` findings when they are cheap. Otherwise list them in the PR.
4. Record every finding with its outcome in `state.md`: the fixing commit, or the reason it was rejected.

## 8. Publish

1. Push with `git -C <worktree> push -u origin <branch>`. Run `git push` and `gh` outside the sandbox, because their credentials live in the Windows keyring.
2. Write the PR body to `.local/deliver/<slug>/pr-body.md` from `.github/pull_request_template.md`:
   - Change: the problem and the resulting behavior; the card link or the `NO-CARD` reason.
   - Validation: only commands that actually ran, on which commit, with their results.
   - Regression protection: tests and REG scenarios.
   - Remaining verification: `NOT RUN`, `CI ONLY` and `FLAKY` checks, rejected or deferred review findings, and every real-game, TruckersMP, display or performance criterion this PR cannot satisfy.

   End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
3. Create a draft PR: `gh pr create --draft --base main --head <branch> --title "[<ID>] <type>: <summary>" --body-file <pr-body.md>`. Bind it to this session if the app provides a PR-binding tool.
4. For a change outside `**.md` and `docs/**`, dispatch CI once on the draft head: `gh workflow run windows-ci.yml --ref <branch> -f extended=false`. Record the run link from `gh run list --workflow windows-ci.yml --branch <branch> --limit 1`. Do not poll it. A documentation-only change gets no CI run, which is expected and not a pass.

## 9. Report

Tell the owner, in Russian:

- the PR link;
- what changed;
- which checks ran, with their results;
- the review findings and their outcomes;
- the CI run link;
- what remains unverified;
- the worktree path.

Leave the worktree in place. Marking the PR ready and merging it are the owner's decisions.

## Stop conditions

Stop and ask the owner instead of continuing when:

- the task conflicts with an owner decision in `AGENTS.md`;
- the plan needs an owner decision;
- the fix or review round limits are reached;
- an agent reports a blocker it cannot resolve;
- unexpected changes appear in the worktree;
- any step would need a game launch, a game directory change, real user data, credentials or a destructive Git operation.
