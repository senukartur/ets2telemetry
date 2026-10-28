import {readFile} from 'node:fs/promises';
import {expect, it} from 'vitest';

// ET-055 PR-9 (UP5, UP13, UP16): the release workflow's security boundaries, asserted in the workflow text as
// tests/unit/ci-build-channel-workflow.test.ts does for Windows CI. Dispatch only; read-only by default; only the publish
// jobs, each in its owner-approved environment, may write releases; the staging key is read only by the staging job; no
// input is expanded into a script; third-party actions are pinned by commit; runners are GitHub-hosted.

const workflow = async () => (await readFile('.github/workflows/release.yml', 'utf8')).replaceAll('\r\n', '\n');
const jobIds = (text: string) => [...text.split('\njobs:\n')[1].matchAll(/^ {2}([a-z-]+):\n/gm)].map(match => match[1]);
const job = (text: string, id: string) => text.split(`\n  ${id}:\n`)[1].split(/\n {2}[a-z-]+:\n/)[0];

it('runs only on dispatch, one release at a time, with read-only default permissions', async () => {
  const text = await workflow();
  expect(text).toMatch(/\non:\n {2}workflow_dispatch:\n/);
  expect(text).not.toMatch(/\n {2}(push|pull_request|pull_request_target|schedule|workflow_run|release):/);
  expect(text).toContain('\npermissions:\n  contents: read\nconcurrency:\n  # One release runs and at most one more waits; a further dispatch cancels the waiting one, never the running one.\n' +
    '  group: release\n  cancel-in-progress: false\n');
  expect(jobIds(text)).toEqual(['verify', 'publish-staging', 'draft-production', 'publish-production']);
});

it('gives contents: write only to the publish jobs, each in its environment and for its channel and mode', async () => {
  const text = await workflow();
  const verify = job(text, 'verify');
  expect(verify).toContain('    permissions:\n      contents: read\n      actions: read\n');
  expect(verify).not.toContain('environment:');
  expect(verify).toContain("if [[ \"$GITHUB_REF\" != 'refs/heads/main' ]]");
  const publish = {
    'publish-staging': ["inputs.channel == 'staging' && inputs.mode == 'release'", 'release-staging'],
    'draft-production': ["inputs.channel == 'production' && inputs.mode == 'release'", 'release-production'],
    'publish-production': ["inputs.channel == 'production' && inputs.mode == 'publish_signed'", 'release-production']
  };
  for (const [id, [condition, environment]] of Object.entries(publish)) {
    const body = job(text, id);
    expect(body, id).toContain(`    needs: verify\n    if: ${condition}\n`);
    expect(body, id).toContain(`    environment: ${environment}\n    permissions:\n      contents: write\n`);
  }
  expect(text.match(/\n {6}contents: write\n/g)).toHaveLength(3);
  expect(text).not.toMatch(/(actions|id-token|packages|deployments|pull-requests|issues): write/);
});

it('reads the staging signing key only in the staging job and never asks for a production key', async () => {
  const text = await workflow();
  expect(text.match(/secrets\./g)).toHaveLength(1);
  expect(job(text, 'publish-staging')).toContain('UPDATE_SIGNING_KEY_STAGING: ${{ secrets.UPDATE_SIGNING_KEY_STAGING }}\n        run: node scripts/release/sign-update-manifest.mjs');
  for (const id of ['draft-production', 'publish-production']) expect(job(text, id)).not.toContain('sign-update-manifest.mjs --manifest "$RUNNER_TEMP');
});

it('publishes staging as a pre-release that never becomes latest, and production as latest only after checking it', async () => {
  const text = await workflow();
  const staging = job(text, 'publish-staging');
  expect(staging).toContain('--prerelease --latest=false');
  expect(staging).toContain('a staging release must never become latest');
  const draft = job(text, 'draft-production');
  // The draft carries the unsigned manifest only; the owner's signature arrives with mode publish_signed.
  expect(draft).toContain('--draft --title "$TITLE" --notes-file release/release-notes.md \\\n' +
    '            "artifacts/$SETUP" "artifacts/$NUPKG" artifacts/RELEASES artifacts/release-identity.json release/update-manifest.json\n');
  const production = job(text, 'publish-production');
  expect(production).toContain('-F draft=false -F prerelease=false -f make_latest=true');
  expect(production).toContain('if [[ "$latest" == "$TAG" ]]; then');
  expect(production.indexOf('verify-update-manifest.mjs')).toBeLessThan(production.indexOf('make_latest=true'));
});

it('passes every input through the environment, never into a script', async () => {
  const text = await workflow();
  const runs = [...text.matchAll(/\n( +)run: (\|\n(?:\1 {2}.*\n|\n)+|.*\n)/g)].map(match => match[2]);
  expect(runs.length).toBeGreaterThan(10);
  for (const script of runs) expect(script).not.toContain('${{');
});

it('pins every action by commit and runs on GitHub-hosted runners only', async () => {
  const text = await workflow();
  const uses = [...text.matchAll(/uses: (\S+)/g)].map(match => match[1]);
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) expect(action).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
  const runners = [...text.matchAll(/runs-on: (.+)/g)].map(match => match[1]);
  expect(runners).toEqual(Array(4).fill('ubuntu-24.04'));
  expect(text).not.toContain('self-hosted');
});

it('reads releases/latest and other 404-meaningful answers only through gh-get.sh, never as "{…}none"', async () => {
  // gh api writes the 404 error body to standard output, so `$(gh api … || echo none)` would read "{…}none" (review of PR-9).
  const text = await workflow();
  expect(text).not.toMatch(/\|\| *echo none/);
  const latest = [...text.matchAll(/^.*repos\/\$GITHUB_REPOSITORY\/releases\/latest.*$/gm)].map(match => match[0]);
  expect(latest.length).toBe(5);
  for (const line of latest) expect(line).toMatch(/bash scripts\/release\/gh-get\.sh "repos\/\$GITHUB_REPOSITORY\/releases\/latest" "\$RUNNER_TEMP\/latest[a-z-]*\.json" \|\| status=\$\?$/);
  expect(text.match(/elif \[\[ \$status -eq 44 \]\]; then (latest|after)=none; else exit 1; fi/g)).toHaveLength(3);
  // The final confirmation retries a transient failure and decides only after its last try.
  const confirm = job(text, 'publish-production').split("- name: Confirm that releases/latest is the new release\n")[1];
  expect(confirm).toContain('elif [[ $status -eq 44 ]]; then latest=none; else latest="unreadable (gh-get exit $status)"; fi\n');
  expect(confirm.indexOf('sleep 10\n          done\n')).toBeLessThan(confirm.lastIndexOf('exit 1'));
  const loop = confirm.slice(confirm.indexOf('for attempt in 1 2 3 4 5 6; do'), confirm.indexOf('done\n'));
  expect(loop).not.toContain('exit 1');
  expect(text).not.toMatch(/gh api [^\n]*git\/ref\/tags/);
  expect(text).not.toContain('gh release view');
});

// Owner decision of October 28, 2026 (concept.md, "UP15 and UP16 amended"): the main-ancestry proof and
// the refusal of a tag named main are production-only, so a staging release may come from any branch's CI run. The
// workflow itself is still dispatched on main only, for both channels.
it('proves a production run\'s commit is on the main branch and refuses a tag named main, for production only', async () => {
  const verify = job(await workflow(), 'verify');
  expect(verify).toContain("- name: Prove that a production run's commit is on the main branch\n        if: inputs.channel == 'production'\n        env:\n");
  expect(verify.match(/git\/ref\/tags\/main/g)).toHaveLength(1);
  expect(verify.match(/check-github-release\.mjs ancestry/g)).toHaveLength(1);
  // The run check itself is unconditional and applies the channel's branch rule (checkReleaseRun).
  expect(verify).toContain('      - name: Check the Windows CI run\n        id: run\n        run: |\n');
  expect(verify).toContain('--repository "$GITHUB_REPOSITORY" --channel "$CHANNEL" >> "$GITHUB_OUTPUT"\n');
  const proof = verify.indexOf("- name: Prove that a production run's commit is on the main branch");
  expect(proof).toBeGreaterThan(verify.indexOf('- name: Check the Windows CI run'));
  expect(proof).toBeLessThan(verify.indexOf('- name: Download the installer artifact'));
  expect(verify).toContain('bash scripts/release/gh-get.sh "repos/$GITHUB_REPOSITORY/git/ref/tags/main" "$RUNNER_TEMP/tag-main.json" || status=$?\n' +
    "          if [[ $status -eq 0 ]]; then echo '::error::A tag named main exists; delete it before releasing.'; exit 1; fi\n" +
    "          if [[ $status -ne 44 ]]; then echo '::error::Could not check for a tag named main.'; exit 1; fi\n");
  // main's commit comes from the unambiguous refs/heads/main, never the bare name.
  expect(verify).toContain('bash scripts/release/gh-get.sh "repos/$GITHUB_REPOSITORY/git/ref/heads/main" "$RUNNER_TEMP/main.json"\n' +
    `          main_sha=$(jq -r 'select(.ref == "refs/heads/main" and .object.type == "commit") | .object.sha' "$RUNNER_TEMP/main.json")\n`);
  expect(verify).not.toContain('...main"');
  expect(verify).toContain('bash scripts/release/gh-get.sh "repos/$GITHUB_REPOSITORY/compare/$COMMIT...$main_sha" "$RUNNER_TEMP/compare.json"\n' +
    '          node scripts/release/check-github-release.mjs ancestry --json "$RUNNER_TEMP/compare.json" --commit "$COMMIT"\n');
});

// Review of October 28, 2026: a staging artifact must carry the released run's number, a staging base above main's
// version is refused, and the owner sees what he approves in the verify job's summary before any publish job waits.
it('binds a staging release to its run number, refuses a base above main\'s and summarizes the candidate before approval', async () => {
  const text = await workflow();
  const verify = job(text, 'verify');
  expect(verify).toContain('      run_number: ${{ steps.run.outputs.run_number }}\n');
  expect(verify).toContain('          RUN_NUMBER: ${{ steps.run.outputs.run_number }}\n        run: |\n          mkdir -p "$RUNNER_TEMP/candidate/release"\n' +
    '          args=(--artifacts "$RUNNER_TEMP/candidate/artifacts" --channel "$CHANNEL" --run-id "$RUN_ID" --run-number "$RUN_NUMBER" --commit "$COMMIT"');
  const base = "- name: Refuse a staging base version higher than main's\n        if: inputs.channel == 'staging'\n        env:\n" +
    '          VERSION: ${{ steps.facts.outputs.version }}\n        run: |\n          main_version=$(jq -r .version package.json)\n' +
    '          node scripts/release/check-github-release.mjs staging-base --version "$VERSION" --main-version "$main_version"\n';
  expect(verify).toContain(base);
  const summary = verify.indexOf('- name: Summarize the release candidate\n        env:\n');
  expect(summary).toBeGreaterThan(verify.indexOf(base));
  expect(verify.indexOf(base)).toBeGreaterThan(verify.indexOf('- name: Verify the release identity and write the unsigned manifest'));
  expect(summary).toBeLessThan(verify.indexOf('actions/upload-artifact'));
  const summaryStep = verify.slice(summary, verify.indexOf('actions/upload-artifact'));
  for (const fact of ['$CHANNEL', '$VERSION', '$TAG', '$BRANCH', '$RUN_ID', '$RUN_NUMBER', '$COMMIT', '$MODE']) expect(summaryStep, fact).toContain(fact);
  expect(summaryStep).toContain('          BRANCH: ${{ steps.run.outputs.branch }}\n');
  expect(summaryStep).toContain('} >> "$GITHUB_STEP_SUMMARY"\n');
  expect(summaryStep).not.toMatch(/\n {8}if: /);
  const staging = job(text, 'publish-staging');
  expect(staging).toContain('      RUN_NUMBER: ${{ needs.verify.outputs.run_number }}\n');
  expect(staging).toContain('--channel staging --run-id "$RUN_ID" --run-number "$RUN_NUMBER" --commit "$COMMIT" --keys-file "$RUNNER_TEMP/keys/update-keys.ts"');
});

it('never runs the released commit\'s update-keys.ts: no type stripping, only the data reader', async () => {
  const text = await workflow();
  expect(text).not.toContain('MODULE_TYPELESS_PACKAGE_JSON');
  expect(text).not.toMatch(/node [^\n]*update-keys\.ts/);
  expect(text).not.toMatch(/--experimental-strip-types|--import|tsx /);
});

it('reads the compiled keys at the run\'s commit wherever a manifest is written or verified', async () => {
  const text = await workflow();
  const extract = 'git fetch --no-tags --depth=1 origin "$COMMIT"\n          mkdir -p "$RUNNER_TEMP/keys"\n' +
    '          git show "$COMMIT:apps/desktop/src/updater/update-keys.ts" > "$RUNNER_TEMP/keys/update-keys.ts"\n';
  for (const id of ['verify', 'publish-staging', 'publish-production']) {
    const body = job(text, id);
    expect(body, id).toContain(extract);
    expect(body.indexOf(extract), id).toBeLessThan(body.search(/(write|verify)-update-manifest\.mjs/));
  }
  const scripts = [...text.matchAll(/node scripts\/release\/(write|verify)-update-manifest\.mjs/g)];
  expect(scripts).toHaveLength(3);
  expect(text.match(/--keys-file "\$RUNNER_TEMP\/keys\/update-keys\.ts"/g)).toHaveLength(3);
});

it('refuses a production version that is not higher than the latest release, before the draft and before publishing', async () => {
  const text = await workflow();
  const verify = job(text, 'verify');
  expect(verify).toContain("- name: Refuse a production version that is not higher than the latest release\n        if: inputs.channel == 'production'\n");
  expect(verify.indexOf('check-github-release.mjs newer')).toBeLessThan(verify.indexOf('actions/upload-artifact'));
  const production = job(text, 'publish-production');
  expect(production.indexOf('check-github-release.mjs newer --latest "$latest" --version "$VERSION"')).toBeGreaterThan(0);
  expect(production.indexOf('check-github-release.mjs newer')).toBeLessThan(production.indexOf('make_latest=true'));
});

it('keeps the release candidate for 7 days, the window to approve the publish job', async () => {
  expect(job(await workflow(), 'verify')).toContain('          retention-days: 7\n');
});

it('writes every run line that carries a colon and a space as a block scalar', async () => {
  // GitHub rejects a workflow whose plain scalar contains ': ' (tests/unit/ci-build-channel-workflow.test.ts has the same rule).
  for (const line of (await workflow()).split('\n')) {
    const run = /^\s*run: (?!\|)(.*)$/.exec(line);
    if (run) expect(run[1], line).not.toMatch(/: /);
  }
});
