import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {compareNugetVersions, isReleaseChannel, nugetVersionOf, releaseVersionProblem} from './update-manifest-common.mjs';

// The release workflow's checks of GitHub API answers (ET-055 PR-9, decisions UP13 and UP16; docs/release.md, "Release
// workflow"). `run` checks `GET /repos/{repo}/actions/runs/{id}`: only a completed, successful Windows CI run of this
// repository itself (never a fork), from a push or a dispatch (never a pull request), is released, and it names the
// installer artifact of its latest attempt for the channel. Production takes only a run on `main`; staging takes a run on
// any branch (owner decision of October 28, 2026; concept.md, "UP15 and UP16 amended"). A run's
// `head_branch` is only a name (a tag called `main` has it too), so for production `ancestry` checks
// `GET /repos/{repo}/compare/{head}...main`, made after the workflow proved that no tag `main` exists: the run's commit
// must be on the main branch. Staging has no ancestry check; its gate is the owner's approval of release-staging (UP16).
// Instead `run` names the run number its artifact's version must carry, and `staging-base` refuses a staging version whose
// base x.y.z is higher than main's package.json version, so a branch cannot strand staging installs above later main builds.
// `release` checks `GET /repos/{repo}/releases/{id}` or `/releases/tags/{tag}`: the tag, the target commit, the draft and
// pre-release flags and exactly the expected asset names, each fully uploaded. `newer` checks
// that a production version is higher than the tag of the current latest release, by the application's NuGet SemVer
// order, so no release is published that installed builds would refuse as a downgrade or that would not become latest.
// Each prints `key=value` lines for $GITHUB_OUTPUT and fails with a fixed reason otherwise.

export const CI_WORKFLOW = '.github/workflows/windows-ci.yml';
const RUN_ID = /^[1-9][0-9]{0,19}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);
const refuse = message => {throw new Error(`Release refused: ${message}`);};

/** The installer artifact a Windows CI run uploads for `channel` (scripts/ci and windows-ci.yml, ET-055 PR-4). */
export const installerArtifactName = (channel, runId, attempt) => `${channel === 'production' ? 'windows-installer' : 'windows-installer-staging'}-${runId}-${attempt}`;

/**
 * A branch name the job summary may show as is (it is printed before the owner approves the release): letters, digits,
 * `.`, `_`, `/` and `-` only.
 */
const BRANCH = /^[A-Za-z0-9._/-]{1,255}$/;
/** The largest run number a staging version can carry: 6 digits (UP15). */
const MAX_STAGING_RUN_NUMBER = 999999;

/**
 * Checks a workflow run object for `channel`; returns its head commit, latest attempt, the channel's installer artifact
 * name, its branch and its run number zero-padded to 6 digits, which a staging artifact's version must carry. Production:
 * a run on `main`. Staging: a run on any branch of this repository. Both: a push or a dispatch.
 */
export function checkReleaseRun(run, {runId, repository, channel}) {
  if (!isReleaseChannel(channel)) refuse(`unknown channel ${JSON.stringify(channel)}`);
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('the run id must be a positive integer');
  if (!plainObject(run) || String(run.id) !== runId) refuse(`the API answer is not run ${runId}`);
  if (run.path !== CI_WORKFLOW) refuse(`run ${runId} is not a ${CI_WORKFLOW} run`);
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) refuse(`run ${runId} did not build ${repository} itself`);
  if (channel === 'production' && run.head_branch !== 'main') refuse(`run ${runId} did not build main`);
  if (typeof run.head_branch !== 'string' || run.head_branch === '') refuse(`run ${runId} names no branch`);
  if (!BRANCH.test(run.head_branch)) refuse(`run ${runId} names a branch with characters other than letters, digits, ".", "_", "/" and "-"`);
  if (!Number.isSafeInteger(run.run_number) || run.run_number < 1 || run.run_number > MAX_STAGING_RUN_NUMBER) refuse(`run ${runId} names no run number of 1 to 6 digits`);
  if (run.event !== 'push' && run.event !== 'workflow_dispatch') {
    refuse(`run ${runId} was started by ${JSON.stringify(run.event)}, not a push or a dispatch${channel === 'production' ? ' on main' : ''}`);
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') refuse(`run ${runId} did not complete successfully`);
  if (typeof run.head_sha !== 'string' || !COMMIT.test(run.head_sha)) refuse(`run ${runId} names no head commit`);
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) refuse(`run ${runId} names no attempt`);
  return {commit: run.head_sha, attempt: run.run_attempt, artifact: installerArtifactName(channel, runId, run.run_attempt), branch: run.head_branch,
    runNumber: String(run.run_number).padStart(6, '0')};
}

const PLAIN_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const STAGING_BASE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})-stg\.\d{6}$/;
/**
 * Checks that the base `x.y.z` of the staging version `appVersion` is not higher than `mainVersion`, main's package.json
 * version at the dispatch checkout. Staging releases from every branch share one version order, and the base outranks the
 * run number, so a branch with a raised base would stay above every later main build in installed staging builds. To
 * release such a branch, raise main's version first.
 */
export function checkStagingBase(appVersion, mainVersion) {
  const base = typeof appVersion === 'string' ? STAGING_BASE.exec(appVersion) : null;
  if (!base) refuse(`version ${JSON.stringify(appVersion)} is not a staging version x.y.z-stg.<6 digits>`);
  const main = typeof mainVersion === 'string' ? PLAIN_VERSION.exec(mainVersion) : null;
  if (!main) refuse(`main's package.json version ${JSON.stringify(mainVersion)} is not a plain x.y.z version`);
  for (let index = 1; index <= 3; index++) {
    const difference = Number(base[index]) - Number(main[index]);
    if (difference < 0) break;
    if (difference > 0) {
      refuse(`staging version ${appVersion} has the base ${base.slice(1, 4).join('.')}, higher than main's package.json version ${mainVersion}; ` +
        'it would stay above every later main build in installed staging builds. Raise main\'s version to at least that base first');
    }
  }
  return {base: base.slice(1, 4).join('.'), main: mainVersion};
}

/**
 * Checks a compare object of `compare/{commit}...main`: main is identical to or ahead of `commit`, and their merge base
 * is the commit itself, so the commit is in main's history.
 */
export function checkMainAncestry(compare, commit) {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) refuse('the commit must be 40 lower-case hex digits');
  if (!plainObject(compare) || (compare.status !== 'identical' && compare.status !== 'ahead')) refuse(`commit ${commit} is not on the main branch`);
  if (compare.base_commit?.sha !== commit || compare.merge_base_commit?.sha !== commit) refuse(`commit ${commit} is not on the main branch`);
  return {status: compare.status};
}

const PRODUCTION_TAG = /^v(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?)$/;
/**
 * Checks that the production version `appVersion` is higher than the current latest release `latestTag` (`none` when the
 * repository has no latest release yet), with the NuGet versions compared as the application compares them.
 */
export function checkNewerThanLatest(latestTag, appVersion) {
  const problem = releaseVersionProblem('production', appVersion);
  if (problem) refuse(`version ${JSON.stringify(appVersion)} ${problem}`);
  if (latestTag === 'none') return {latest: null};
  const match = typeof latestTag === 'string' ? PRODUCTION_TAG.exec(latestTag) : null;
  if (!match || releaseVersionProblem('production', match[1])) refuse(`the latest release ${JSON.stringify(latestTag)} has no production tag v<version>`);
  if (compareNugetVersions(nugetVersionOf(appVersion), nugetVersionOf(match[1])) <= 0) refuse(`version ${appVersion} is not higher than the latest release ${latestTag}`);
  return {latest: latestTag};
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
  '       node scripts/release/check-github-release.mjs ancestry --json <compare file> --commit <sha>\n' +
  '       node scripts/release/check-github-release.mjs newer --latest <tag|none> --version <application version>\n' +
  '       node scripts/release/check-github-release.mjs staging-base --version <staging version> --main-version <main\'s package.json version>\n' +
  '       node scripts/release/check-github-release.mjs release --json <file> --tag <tag> --commit <sha> --draft <true|false> --prerelease <true|false> --names <a,b,...>';
const flag = value => {
  if (value !== 'true' && value !== 'false') throw new Error(USAGE);
  return value === 'true';
};

function main(argv) {
  const [command, ...rest] = argv;
  const {values} = parseArgs({args: rest, strict: true, options: {json: {type: 'string'}, 'run-id': {type: 'string'}, repository: {type: 'string'},
    channel: {type: 'string'}, tag: {type: 'string'}, commit: {type: 'string'}, draft: {type: 'string'}, prerelease: {type: 'string'}, names: {type: 'string'},
    latest: {type: 'string'}, version: {type: 'string'}, 'main-version': {type: 'string'}}});
  if (command === 'staging-base') {
    if (values.version === undefined || values['main-version'] === undefined) throw new Error(USAGE);
    const result = checkStagingBase(values.version, values['main-version']);
    console.log(`base=${result.base}\nmain=${result.main}`);
    return;
  }
  if (command === 'newer') {
    if (values.latest === undefined || values.version === undefined) throw new Error(USAGE);
    console.log(`latest=${checkNewerThanLatest(values.latest, values.version).latest ?? 'none'}`);
    return;
  }
  if (!values.json) throw new Error(USAGE);
  const answer = JSON.parse(readFileSync(path.resolve(values.json), 'utf8'));
  if (command === 'ancestry') {
    if (!values.commit) throw new Error(USAGE);
    console.log(`main=${checkMainAncestry(answer, values.commit).status}`);
  } else if (command === 'run') {
    const result = checkReleaseRun(answer, {runId: values['run-id'], repository: values.repository, channel: values.channel});
    console.log(`commit=${result.commit}\nattempt=${result.attempt}\nartifact=${result.artifact}\nbranch=${result.branch}\nrun_number=${result.runNumber}`);
  } else if (command === 'release') {
    if (!values.tag || !values.commit || !values.names) throw new Error(USAGE);
    const result = checkRelease(answer, {tag: values.tag, commit: values.commit, draft: flag(values.draft), prerelease: flag(values.prerelease), names: values.names.split(',')});
    console.log(`id=${result.id}`);
  } else throw new Error(USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
