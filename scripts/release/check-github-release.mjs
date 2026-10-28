import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {isReleaseChannel} from './update-manifest-common.mjs';

// The release workflow's checks of GitHub API answers (ET-055 PR-9, decisions UP13 and UP16; docs/release.md, "Release
// workflow"). `run` checks `GET /repos/{repo}/actions/runs/{id}`: only a completed, successful Windows CI run of this
// repository on `main`, from a push or a dispatch, is released, and it names the installer artifact of its latest attempt
// for the channel. `release` checks `GET /repos/{repo}/releases/{id}` or `/releases/tags/{tag}`: the tag, the target
// commit, the draft and pre-release flags and exactly the expected asset names, each fully uploaded. Both print
// `key=value` lines for $GITHUB_OUTPUT and fail with a fixed reason otherwise.

export const CI_WORKFLOW = '.github/workflows/windows-ci.yml';
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const refuse = message => {throw new Error(`Release refused: ${message}`);};

/** The installer artifact a Windows CI run uploads for `channel` (scripts/ci and windows-ci.yml, ET-055 PR-4). */
export const installerArtifactName = (channel, runId, attempt) => `${channel === 'production' ? 'windows-installer' : 'windows-installer-staging'}-${runId}-${attempt}`;

/** Checks a workflow run object; returns its head commit, latest attempt and the channel's installer artifact name. */
export function checkReleaseRun(run, {runId, repository, channel}) {
  if (!isReleaseChannel(channel)) refuse(`unknown channel ${JSON.stringify(channel)}`);
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('the run id must be a positive integer');
  if (!plainObject(run) || String(run.id) !== runId) refuse(`the API answer is not run ${runId}`);
  if (run.path !== CI_WORKFLOW) refuse(`run ${runId} is not a ${CI_WORKFLOW} run`);
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) refuse(`run ${runId} did not build ${repository} itself`);
  if (run.head_branch !== 'main') refuse(`run ${runId} did not build main`);
  if (run.event !== 'push' && run.event !== 'workflow_dispatch') refuse(`run ${runId} was started by ${JSON.stringify(run.event)}, not a push to or a dispatch on main`);
  if (run.status !== 'completed' || run.conclusion !== 'success') refuse(`run ${runId} did not complete successfully`);
  if (typeof run.head_sha !== 'string' || !COMMIT.test(run.head_sha)) refuse(`run ${runId} names no head commit`);
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) refuse(`run ${runId} names no attempt`);
  return {commit: run.head_sha, attempt: run.run_attempt, artifact: installerArtifactName(channel, runId, run.run_attempt)};
}

/** Checks a release object against the expected tag, commit, flags and asset names. */
export function checkRelease(release, {tag, commit, draft, prerelease, names}) {
  if (!plainObject(release) || release.tag_name !== tag) refuse(`the release is not ${tag}`);
  if (release.target_commitish !== commit) refuse(`release ${tag} does not target commit ${commit}`);
  if (release.draft !== draft) refuse(`release ${tag} is ${release.draft ? '' : 'not '}a draft`);
  if (release.prerelease !== prerelease) refuse(`release ${tag} is ${release.prerelease ? '' : 'not '}a pre-release`);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const present = assets.map(asset => asset?.name).sort(), expected = [...names].sort();
  if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) refuse(`release ${tag} must carry exactly ${expected.join(', ')}`);
  if (assets.some(asset => asset.state !== 'uploaded')) refuse(`release ${tag} has an asset that is not fully uploaded`);
  return {id: release.id};
}

const USAGE = 'Usage: node scripts/release/check-github-release.mjs run --json <file> --run-id <id> --repository <owner/name> --channel <channel>\n' +
  '       node scripts/release/check-github-release.mjs release --json <file> --tag <tag> --commit <sha> --draft <true|false> --prerelease <true|false> --names <a,b,...>';
const flag = value => {
  if (value !== 'true' && value !== 'false') throw new Error(USAGE);
  return value === 'true';
};

function main(argv) {
  const [command, ...rest] = argv;
  const {values} = parseArgs({args: rest, strict: true, options: {json: {type: 'string'}, 'run-id': {type: 'string'}, repository: {type: 'string'},
    channel: {type: 'string'}, tag: {type: 'string'}, commit: {type: 'string'}, draft: {type: 'string'}, prerelease: {type: 'string'}, names: {type: 'string'}}});
  if (!values.json) throw new Error(USAGE);
  const answer = JSON.parse(readFileSync(path.resolve(values.json), 'utf8'));
  if (command === 'run') {
    const result = checkReleaseRun(answer, {runId: values['run-id'], repository: values.repository, channel: values.channel});
    console.log(`commit=${result.commit}\nattempt=${result.attempt}\nartifact=${result.artifact}`);
  } else if (command === 'release') {
    if (!values.tag || !values.commit || !values.names) throw new Error(USAGE);
    const result = checkRelease(answer, {tag: values.tag, commit: values.commit, draft: flag(values.draft), prerelease: flag(values.prerelease), names: values.names.split(',')});
    console.log(`id=${result.id}`);
  } else throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
