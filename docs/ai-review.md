# Advisory AI code review

[Claude code review](../.github/workflows/claude-review.yml) runs [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) on pull requests. Its comments are advisory input for the owner. They never approve, request changes, satisfy a required check, or replace the owner review, the [Windows CI](ci.md) checks, independent review, or real-game evidence defined in [TESTING.md](../TESTING.md). Do not cite an AI review as proof that a change is correct.

## Triggers

| Event | Job | Notes |
| --- | --- | --- |
| Non-draft PR opened or reopened, or draft marked ready for review | `Automatic PR review` | Runs from the PR's own workflow file. Pushing new commits does not re-run it, which keeps the cost bounded |
| Owner comment containing `@claude` on a PR (conversation or review line) | `On-demand review (@claude)` | Use it for re-reviews after new commits and for questions. GitHub runs comment-triggered workflows from the default branch only, so this job is active only after the workflow is merged to `main` |

Both jobs skip PRs from forks and comments from accounts other than the repository owner. The action also refuses actors without write access and bot actors by default.

Each job runs on `ubuntu-latest` with a 20-minute timeout and job permissions limited to `contents: read`, `pull-requests: write` and `issues: write`. Claude may read the repository and post PR comments through the job's `GITHUB_TOKEN`; it cannot push commits. Allowed tools are restricted to `Read`, `Grep`, `Glob`, `gh pr view`, `gh pr diff`, `gh pr comment` and inline review comments. The automatic review keeps one sticky summary comment per PR.

The action restores `CLAUDE.md` and `.claude/` from the PR base branch before running. The root [CLAUDE.md](../CLAUDE.md) only imports [AGENTS.md](../AGENTS.md), so repository rules are maintained in one place. The review prompt in the workflow lists the project-specific constraints to check; update it when AGENTS.md changes a review-relevant invariant.

## Setup

The workflow needs exactly one of these repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Billing | How to obtain |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro/Max subscription usage limits | Run `claude setup-token` in a local terminal and copy the printed token |
| `ANTHROPIC_API_KEY` | Pay-per-token Claude API usage | Create a key in the [Claude Console](https://console.anthropic.com/) |

With the GitHub CLI, run `gh secret set CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) from the repository and paste the value at the prompt. Never commit a token or paste it into a PR or issue. No GitHub App installation is required, because the workflow authenticates to GitHub with `GITHUB_TOKEN`; comments therefore appear as `github-actions[bot]`.

Without a secret, the review job fails with an authentication error. That failure concerns only the advisory review and does not affect the Windows CI result.

## Cost and limits

Each run consumes Claude usage roughly proportional to the diff and the documents read. Ubuntu runner minutes count against the private repository's Actions quota at the Linux rate. Draft PRs are skipped; mark a PR ready for review, or comment `@claude review the latest changes` when a review is worth the cost.

The reviewer sees the PR checkout, not the game, native runtime, or packaged application. It does not run tests, builds, or the simulator. Findings can be wrong or incomplete; verify each one before acting on it.

The action version is pinned to an exact commit, matching the other workflows. Review the upstream changelog before updating the pin.
