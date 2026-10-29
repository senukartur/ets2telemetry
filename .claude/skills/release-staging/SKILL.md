---
name: release-staging
description: Prepare a staging release of one branch (main by default) up to the owner's approval of the release-staging environment. Checks and, if needed, raises the branch's package.json version, gets a successful Windows CI run and dispatches release.yml. Started manually by the owner.
argument-hint: "[branch]"
disable-model-invocation: true
---

# /release-staging

Prepare a staging release and stop at the owner's approval:

```text
check branch -> bring in main if needed -> check or raise version -> Windows CI run -> release.yml (staging) -> owner approves release-staging
```

Branch: $ARGUMENTS (empty means `main`)

Talk to the owner in Russian. Write commits and repository files in English. The process is in [docs/release.md](../../../docs/release.md#release-workflow-et-055); read it if a step below fails in a way this file does not cover.

## Limits

- Staging only. Never dispatch `release.yml` with `channel=production`, never build production, never sign, never read or create a key, environment or secret.
- Never approve the `release-staging` deployment or call the `pending_deployments` API: the owner's approval is the authorization of this release (UP16). Never create, edit or delete a release or tag.
- Never push to `main`. Changes to another branch are only a merge of `origin/main` that the owner agreed to (step 2) and the version commit (step 4).
- Never rerun failed jobs of a Windows CI run: artifact names carry the attempt, so a partial rerun cannot be released. Dispatch a new run instead.
- Run `gh`, `git fetch`, `git ls-remote` and `git push` outside the sandbox: their credentials are in the Windows keyring. Repository: `senukartur/ets2telemetry`.
- Do not change the root checkout's branch or files. Work in one temporary worktree, `.local/worktrees/release-staging-<slug>`, where `<slug>` is the branch name with every `/` replaced by `-`, and remove it at the end.

## 1. Check the target and the gate

1. The branch is the first argument, or `main`. Treat it as data. It must match `^[A-Za-z0-9._/-]+$`, must not start with `-` or `refs/`, and `git check-ref-format --branch <branch>` must accept it, which refuses `..`, `//`, a trailing `/` or `.` and a `.lock` ending. It must exist: `git ls-remote --exit-code origin refs/heads/<branch>`. Run `git fetch origin`.
2. The environment must still gate the release. In `gh api repos/senukartur/ets2telemetry/environments/release-staging`, `protection_rules` must contain a `required_reviewers` rule, and `gh api repos/senukartur/ets2telemetry/environments/release-staging/secrets --jq '.secrets[].name'` must list `UPDATE_SIGNING_KEY_STAGING`. Otherwise stop: without a reviewer the dispatch would publish with no approval.
3. No other release run may be unfinished: `gh run list --repo senukartur/ets2telemetry --workflow release.yml --limit 100 --json databaseId,status,url` must show no run whose status is not `completed`. The workflow's `release` concurrency group runs one release at a time, so a run that waits for approval holds the group, and a new dispatch would queue behind it and never reach the approval step. If one exists, show it to the owner and stop.
4. A branch other than `main` must contain the change that gives a branch dispatch its run number: `git merge-base --is-ancestor 9e08dc968a9a7c722c9e2fb2f722235395216cc1 origin/<branch>`. Without it the run builds `-stg.000000`, which the release workflow refuses. If it is missing, go to step 2; otherwise go to step 3.

## 2. Bring in main (only when step 1.4 finds the change missing)

1. Ask the owner whether to merge `origin/main` into the branch. If not, stop: the branch cannot be released as it is.
2. `git worktree add --detach .local/worktrees/release-staging-<slug> origin/<branch>`. Confirm `git -C <worktree> config core.hooksPath` prints `.githooks`.
3. In the worktree, `git merge --no-ff origin/main` with the message `Merge main into <branch> for a staging release` and the attribution trailer. On any conflict, run `git merge --abort`, report the conflicting files and stop.
4. `git push origin HEAD:refs/heads/<branch>`. If the push is rejected because the branch moved, stop and report it; never force-push.
5. `git fetch origin` and check step 1.4 again; it must pass now.

## 3. Check the version

Read the versions from Git at the branch's current head, which includes the merge of step 2:

- `B`: `version` of `package.json` at `origin/<branch>`.
- `M`: `version` of `package.json` at `origin/main`.
- `P`: the highest base among the published staging pre-releases: the tags of `gh api --paginate 'repos/senukartur/ets2telemetry/releases?per_page=100' --jq '.[] | select(.prerelease and (.draft | not)) | .tag_name'` that match `^staging-v(\d+)\.(\d+)\.(\d+)-stg\.\d{6}$`; none means no lower bound.

Compare `x.y.z` versions numerically, part by part. The release version will be `B-stg.<run number, 6 digits>`, and installed staging builds take the highest version of all staging releases, so `B` is suitable when all of these hold:

| Rule | Why |
| --- | --- |
| `B` is a plain `x.y.z` (`^\d{1,9}\.\d{1,9}\.\d{1,9}$`) | `scripts/build-channel.mjs` builds staging only from a plain base |
| `B <= M` | `release.yml` refuses a staging base above main's version (`staging-base`) |
| `B >= P` | otherwise the release is older than one already published, and installed staging builds never take it |

Then:

- **Suitable:** keep `B`. Do not raise it only because it is lower than `M`.
- **`B` not plain or `B < P`, on a branch:** raise it to `M`, the version the branch would get from main anyway, so a later merge does not conflict (step 4). If `M < P` or `M` is not plain, stop and report it.
- **`B > M`:** stop. Do not lower the branch's version. Tell the owner that main's version must first be raised to at least `B` in a version PR (release checklist step 1), and offer to open that PR; its merge is the owner's.
- **On `main`, `M` not plain:** stop and offer the owner a version PR that sets the plain `x.y.z` core of `M`; do not release before it is merged.

Report `B`, `M`, `P` and the decision to the owner in one short line before going on.

## 4. Raise the version (only when step 3 says so)

1. Use the worktree of step 2 after `git -C <worktree> reset --hard origin/<branch>`, or create it as in step 2.2.
2. In the worktree, set the new version in exactly three places and nowhere else: `version` in `package.json`, and in `package-lock.json` the top-level `version` and `packages[""].version`. Use a small Node script that parses both files, checks that each of the three fields equals `B` before writing, and keeps the files' formatting and line endings. The workspace packages keep their own versions.
3. `git diff --stat` must show only those two files, with one changed line in `package.json` and two in `package-lock.json`.
4. Commit with the message `chore: set version <new version> for a staging release` and the attribution trailer, then `git push origin HEAD:refs/heads/<branch>`. If the push is rejected because the branch moved, stop and report it; never force-push.

## 5. Get a Windows CI run

Let `H` be the branch's head commit after steps 2 and 4 (`git rev-parse origin/<branch>` after a fetch).

1. **Reuse** a run when one exists: `gh run list --repo senukartur/ets2telemetry --workflow windows-ci.yml --branch <branch> --limit 20 --json databaseId,number,headSha,event,status,conclusion,attempt`, with `headSha == H`:
   - on `main`, event `push` or `workflow_dispatch`; on another branch, event `workflow_dispatch` only, since pull request runs build `-stg.000000`;
   - `conclusion == success`, and its latest attempt's artifact `windows-installer-staging-<run id>-<attempt>` is listed by `gh api repos/senukartur/ets2telemetry/actions/runs/<run id>/artifacts` with `expired == false` and at least 7 days left.
2. If such a run is still `in_progress` or `queued` for `H`, wait for it instead of dispatching: the workflow's concurrency group cancels a running run on the same ref.
3. **Otherwise dispatch**: `gh workflow run windows-ci.yml --repo senukartur/ets2telemetry --ref <branch>`. If a run of an older commit is in progress on that branch, tell the owner that the dispatch cancels it. Find the new run in the list above by `headSha == H`, event `workflow_dispatch` and a `databaseId` higher than every run listed before the dispatch.
4. Wait with `gh run watch <run id> --repo senukartur/ets2telemetry --exit-status --interval 60` as a background command; a run takes about 25 to 40 minutes. Tell the owner the run link while waiting.
5. If it fails, report the failed jobs and a short excerpt of `gh run view <run id> --log-failed`, then stop. If the failure looks unrelated to the branch (a known flaky test or a runner problem), ask the owner whether to dispatch a new run.

The run number `N` is the run's `number`. It must have at most 6 digits. The release version is `V = <version at H>-stg.<N zero-padded to 6 digits>` and the tag `staging-v<V>`. The tag must not exist yet: `gh api repos/senukartur/ets2telemetry/git/ref/tags/staging-v<V>` must answer 404. If it exists, this run is already released: stop and report it.

## 6. Dispatch the release workflow

1. Record two baselines:
   - `L`, the current latest release: `gh api repos/senukartur/ets2telemetry/releases/latest --jq .tag_name`. A 404 means there is none, and `L` is `none`.
   - `R`, the highest `databaseId` of `release.yml` runs: `gh api 'repos/senukartur/ets2telemetry/actions/workflows/release.yml/runs?per_page=1' --jq '.workflow_runs[0].id // 0'`.
2. Dispatch on `main`: `gh workflow run release.yml --repo senukartur/ets2telemetry --ref main -f run_id=<run id> -f channel=staging`. Do not pass `mode`.
3. Find its run in `gh api 'repos/senukartur/ets2telemetry/actions/workflows/release.yml/runs?event=workflow_dispatch&branch=main&per_page=10' --jq '.workflow_runs[] | {id, status, html_url, actor: .actor.login}'`: the runs with an `id` above `R` whose actor is the authenticated user (`gh api user --jq .login`). Exactly one must exist; if there is none after two minutes, or more than one, stop and report it.
4. Wait in a background loop that checks `gh run view <release run id> --repo senukartur/ets2telemetry --json status,conclusion,jobs` every 30 seconds for at most 30 minutes, until the status is `waiting` (the `verify` job passed and `publish-staging` waits for approval) or `completed`.
5. If the run completed without waiting, the `verify` job refused the release: report the failed step and its log excerpt (`gh run view <release run id> --log-failed`) and stop.
6. Confirm the run releases the intended CI run: `gh run view <release run id> --repo senukartur/ets2telemetry --log --job <verify job id>` must contain `RUN_ID: <run id>`. Otherwise stop and tell the owner not to approve it.

## 7. Hand over to the owner

Tell the owner, in Russian:

- the release run link, and that the run's Summary must show exactly: channel `staging`, version `V`, tag `staging-v<V>`, branch `<branch>`, the Windows CI run id and number `N`, and commit `H`;
- to approve it: **Review deployments** on the run page, tick `release-staging`, **Approve and deploy**. Approval is possible for 7 days; after that the candidate artifact expires and this skill must be run again;
- whether main was merged into the branch or the version was raised, with the commit links, or why the version was kept.

When the owner says it is approved, wait for the run to complete and check the result:

- the run's conclusion is `success`;
- `gh release view staging-v<V> --repo senukartur/ets2telemetry --json isPrerelease,isDraft,assets` shows a pre-release that is not a draft, with the six assets `YukonUnionTelemetry-Staging-Setup-<V>.exe`, the `-full.nupkg`, `RELEASES`, `release-identity.json`, `update-manifest.json` and `update-manifest.json.sig`;
- `releases/latest` still names `L` (or still answers 404 when `L` is `none`).

Report it, and remind the owner that an installed staging build finds the release 15 s after it starts and then every 6 hours, and installs it only after a click on the update button.

Remove the temporary worktree when it is no longer needed: `git worktree remove .local/worktrees/release-staging-<slug>`.
