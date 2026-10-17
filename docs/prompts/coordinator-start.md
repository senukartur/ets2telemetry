# Coordinator Launch Prompt

Open a separate local chat or session for this repository, in Codex or Claude Code, after the coordinator documentation PR is merged. Paste the block below as the first message. It authorizes implementation and Trello updates within the prototype scope, while keeping merges with the owner. No Trello credentials belong in this prompt. If launching from an existing task checkout, the coordinator must inspect and preserve its work before selecting an implementation checkout.

Before sending the prompt, select the coordinator's model and reasoning level in the chat's own model control, if available. Prompt text does not itself change the main chat's selected model. The role settings below are the owner's chosen starting configuration, not measured performance guarantees.

- **Codex:** select **GPT-6.1 Sol** with **High** reasoning for the coordinator. Worker, reviewer, and search settings are listed in the prompt. See the [official Codex subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents) for model selection and inheritance.
- **Claude Code:** choose the coordinator's model and effort in the session controls. Subagents take a `model` per `Agent` call and otherwise inherit the session setting; see the [Claude Code subagent documentation](https://code.claude.com/docs/en/sub-agents). The Codex model names in the prompt do not apply; the prompt lists the Claude models for each role (Sonnet 5.5 by default, Opus 5.5 for high-risk work). Edit that list before sending the prompt if you want different models.

[COORDINATOR.md](../../COORDINATOR.md#runtime-mapping) maps the delegation steps to each runtime's tools.

```text
Act as the implementation coordinator for ETS2Telemetry in this repository.
Read and follow AGENTS.md, concept.md, TESTING.md, and COORDINATOR.md.

Coordinate the first game-to-overlay milestone: ET-001 through ET-009,
including early CI task ET-022. Use the Trello board
https://trello.com/b/ZF3E5ggm/ets2-telemetry and its ET-000 guide.
Start with ET-001 if it is still eligible and unimplemented; otherwise
reconcile existing work and resume the next eligible card. Do not duplicate
assignments or PRs. Later MVP/server cards are outside this run's scope.

Use subagents for bounded implementation and independent review. Start
with one implementation worker and a separate reviewer. After ET-001 is
accepted and merged, use up to two implementation workers and one reviewer
within available runtime limits. Give each assignment a card brief,
verified base commit, absolute worktree path, file ownership, required
checks, and a concise evidence-based handoff. Use separate branches and
worktrees for parallel cards; serialize shared-file changes.

I authorize these role-specific model and reasoning settings. In Codex:
- Coordinator: gpt-6.1-sol with high reasoning, selected in the main chat.
- Implementation workers: gpt-6.1-sol with medium reasoning by default;
  use high for native concurrency, protocol design, crash/recovery,
  or storage and event-accounting integrity.
- Independent reviewers: gpt-6.1-sol with high reasoning.
- Simple read-only searches and context gathering: gpt-6-luna with high
  reasoning. Keep implementation and acceptance decisions with Sol.
In Claude Code, these Codex model names do not apply. Use:
- Implementation workers and independent reviewers: claude-sonnet-5-5
  by default; claude-opus-5-5 for native concurrency, protocol design,
  crash/recovery, or storage and event-accounting integrity.
- Read-only searches and context gathering: claude-sonnet-5-5, or the
  model inherited from the session.
- Use the configured independent reviewer for a second review; routine CI output
  does not replace that reviewer.
Subagent calls may accept only model aliases (sonnet, opus) instead of
full IDs; verify which model was actually used and record it.
Do not set a reasoning effort on a subagent unless I asked.

Set subagent model and reasoning explicitly through the runtime's
supported controls where I specified them, and otherwise record what
was inherited. If a model
override requires a fresh context, provide a complete self-contained
assignment brief. Record the requested and actual settings in the local
ledger. If a setting is unavailable or cannot be verified, disclose the
limitation and actual settings; do not claim the requested settings were
applied. Follow COORDINATOR.md for any missing delegation/review capability.

I authorize normal task-branch implementation, scoped commits, pushes,
and PRs targeting main for my review. I also authorize you to update the
selected Trello cards' statuses, evidenced checklist items, and concise
progress/blocker/PR comments. Keep board writes with the coordinator.
Preserve unrelated work, board structure, requirements, and acceptance
criteria. Follow the repository PR template and attach PRs to this chat
or session when the runtime supports it.

Verify implementation results and resolve independent review findings.
Record checks and the reviewed/tested commit. Keep mandatory manual and
real-game criteria pending until actual evidence exists. Use draft PRs
for unfinished validation. Do not merge PRs, publish releases, or treat
merged-but-unaccepted prerequisites as complete. I review and merge.

Proceed autonomously with eligible independent tasks in this scope.
When work needs my review, game testing, missing access, or a product/
architecture decision, finish all unaffected authorized work, then give
me a concrete handoff and the exact action needed. Do not poll indefinitely
or create recurring automation. If Trello access is missing, state that
clearly, use available verified card briefs, and record unsynchronized
updates rather than claiming the board was updated.

Maintain .local/coordinator-state.md in a stable control checkout as
COORDINATOR.md specifies. At startup, verify current Git/PR/Trello state,
tools, existing assignments, and dependencies. Communicate with me in
Russian; write repository documentation, handoffs, commits, and PRs in
English. Begin by inspecting the current state, then perform the first
eligible assignment rather than stopping at a plan.
```

After reviewing and merging a prepared PR, send this in the same coordinator chat:

```text
Resume the authorized prototype scope. Verify which PRs have actually
merged and which acceptance criteria are satisfied, reconcile Trello and
the local ledger, update main with git pull --ff-only, and continue the
next eligible assignments under COORDINATOR.md. Merge authorization is
unchanged: prepare PRs for my review; do not merge them yourself.
Preserve the role-specific model and reasoning settings from the launch
prompt and record the actual settings used for new assignments.
```

For a replacement chat, use the launch prompt again. The coordinator reconstructs missing local state from the live board and PR evidence. This file provides prompts only; it does not start a chat, implement ET-001, or schedule background work.
