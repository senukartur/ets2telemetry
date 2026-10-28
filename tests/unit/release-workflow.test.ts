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
  expect(text).toContain('\npermissions:\n  contents: read\nconcurrency:\n  # One release at a time; a second dispatch waits instead of cancelling a release in progress.\n  group: release\n  cancel-in-progress: false\n');
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
  expect(production).toContain('releases/latest" --jq .tag_name');
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
