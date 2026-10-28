import {lstatSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {BUILD_IDENTITIES, buildSetupFileName} from '../build-channel.mjs';
import {compiledUpdateKeys, hashFile, isReleaseChannel, KEY_ID_PATTERN, MANIFEST_FORMAT, MANIFEST_MAX_BYTES, nugetVersionOf, PACKAGE_MAX_BYTES, releaseTag,
  releaseTitle, releaseVersionProblem} from './update-manifest-common.mjs';

// The update manifest writer (ET-055 PR-9, decisions UP4, UP13 and UP16; docs/release.md, "Release workflow"). It reads one
// installer artifact of Windows CI, exactly Setup, the full nupkg, RELEASES and release-identity.json, checks them against
// each other and against the CI run the release workflow downloaded them from, and writes update-manifest.json v1 in the
// shape apps/desktop/src/updater/update-manifest.ts verifies. It signs nothing: scripts/release/sign-update-manifest.mjs
// does, with the owner's offline key for production and the release-staging key for staging.
//
// Refusals: an artifact of another channel, a builder other than GitHub Actions or another run than the one downloaded, a
// dirty tree or another commit, a version the channel cannot release (a staging label in production, the local staging run
// number 000000), a NuGet version other than electron-winstaller's conversion, a nupkg not named exactly
// `<Squirrel id>-<NuGet version>-full.nupkg`, and any file whose size or hash differs from the identity or RELEASES.

export const IDENTITY_FILE = 'release-identity.json';
export const IDENTITY_FORMAT = 'ets2telemetry.release-identity';
export const RELEASES_FILE = 'RELEASES';
const IDENTITY_MAX_BYTES = 16 * 1024 * 1024;
const RELEASES_MAX_BYTES = 4 * 1024;
const RUN_ID = /^[1-9][0-9]{0,19}$/;
/** A run number zero-padded to 6 digits, never 000000. */
const RUN_NUMBER = /^(?!000000)\d{6}$/;
const COMMIT = /^[0-9a-f]{40}$/;

const refuse = message => {throw new Error(`Release artifact refused: ${message}`);};
const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The one RELEASES entry `<SHA-1> <name> <size>`, with an optional UTF-8 byte order mark. */
function parseReleases(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length !== 1) refuse('RELEASES must hold exactly one entry');
  const match = /^([0-9A-Fa-f]{40}) (\S+) (\d+)$/.exec(lines[0].trim());
  if (!match) refuse('RELEASES holds an invalid entry');
  return {sha1: match[1].toLowerCase(), name: match[2], size: Number(match[3])};
}

/**
 * Verifies the artifact folder of the CI run `runId` for `channel` and returns its facts: the channel, versions, tag,
 * title, commit and the name, size and hashes of every file. `commit`, when given, is the run's head commit. `runNumber`,
 * when given, is the run's number zero-padded to 6 digits (check-github-release.mjs run); a staging version must then
 * carry exactly that number, so an artifact is released only under the number of the run that built it.
 */
export function verifyReleaseArtifacts(folder, {channel, runId, commit, runNumber}) {
  if (!isReleaseChannel(channel)) refuse(`unknown channel ${JSON.stringify(channel)}`);
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) refuse('the CI run id must be a positive integer');
  if (commit !== undefined && (typeof commit !== 'string' || !COMMIT.test(commit))) refuse('the expected commit must be 40 lower-case hex digits');
  if (runNumber !== undefined && (typeof runNumber !== 'string' || !RUN_NUMBER.test(runNumber))) refuse('the CI run number must be 6 digits, from 000001');

  const identityFile = path.join(folder, IDENTITY_FILE);
  let identityStat;
  try {identityStat = lstatSync(identityFile);} catch {refuse(`${IDENTITY_FILE} is missing`);}
  if (!identityStat.isFile() || identityStat.size > IDENTITY_MAX_BYTES) refuse(`${IDENTITY_FILE} is not a plain file of at most 16 MiB`);
  let identity;
  try {identity = JSON.parse(readFileSync(identityFile, 'utf8'));} catch {refuse(`${IDENTITY_FILE} is not JSON`);}
  if (!plainObject(identity) || identity.format !== IDENTITY_FORMAT || identity.version !== 1) refuse(`${IDENTITY_FILE} is not a release identity of version 1`);

  if (identity.channel !== channel) refuse(`the artifact is a ${JSON.stringify(identity.channel)} build, not ${channel}`);
  const builtBy = identity.builtBy;
  if (!plainObject(builtBy) || builtBy.kind !== 'github-actions') refuse('the artifact was not built by GitHub Actions');
  if (builtBy.runId !== runId) refuse(`the artifact was built by run ${JSON.stringify(builtBy.runId)}, not run ${runId}`);
  const source = identity.source;
  if (!plainObject(source) || typeof source.commit !== 'string' || !COMMIT.test(source.commit)) refuse('the identity names no source commit');
  if (commit !== undefined && source.commit !== commit) refuse('the identity commit differs from the CI run head');
  if (source.treeClean !== true) refuse('the artifact was built from a tree with tracked changes');

  const versions = identity.versions;
  if (!plainObject(versions)) refuse('the identity has no versions');
  const appVersion = versions.app, problem = releaseVersionProblem(channel, appVersion);
  if (problem) refuse(`version ${JSON.stringify(appVersion)} ${problem}`);
  if (channel === 'staging' && runNumber !== undefined && !appVersion.endsWith(`-stg.${runNumber}`)) {
    refuse(`staging version ${appVersion} does not carry the run number ${runNumber} of the CI run it is released from`);
  }
  const nugetVersion = nugetVersionOf(appVersion);
  if (versions.nuget !== nugetVersion) refuse(`NuGet version ${JSON.stringify(versions.nuget)} is not ${nugetVersion}`);

  const build = BUILD_IDENTITIES[channel];
  const names = {setup: buildSetupFileName(build, appVersion), nupkg: `${build.squirrelId}-${nugetVersion}-full.nupkg`, releases: RELEASES_FILE};
  const artifacts = identity.artifacts;
  if (!plainObject(artifacts)) refuse('the identity has no artifacts');
  if (artifacts.nupkg?.name !== names.nupkg) refuse(`the nupkg is not exactly ${names.nupkg}`);
  if (artifacts.setup?.name !== names.setup) refuse(`Setup is not exactly ${names.setup}`);
  if (artifacts.releases?.name !== names.releases) refuse('the identity names no RELEASES file');

  const expected = [names.setup, names.nupkg, names.releases, IDENTITY_FILE].sort();
  const present = readdirSync(folder, {withFileTypes: true}).map(entry => entry.name).sort();
  if (present.length !== expected.length || present.some((name, index) => name !== expected[index])) {
    refuse(`the folder must hold exactly ${expected.join(', ')}`);
  }
  const files = {};
  for (const [kind, name] of Object.entries(names)) {
    const file = path.join(folder, name);
    if (!lstatSync(file).isFile()) refuse(`${name} is not a plain file`);
    const facts = hashFile(file), recorded = artifacts[kind];
    if (recorded.size !== facts.size || recorded.sha256 !== facts.sha256) refuse(`${name} differs from its size or SHA-256 in the identity`);
    files[kind] = {name, ...facts};
  }
  if (files.nupkg.size < 1 || files.nupkg.size > PACKAGE_MAX_BYTES) refuse('the nupkg is empty or larger than 400 MiB');
  if (files.releases.size > RELEASES_MAX_BYTES) refuse('RELEASES is larger than 4 KiB');
  const entry = parseReleases(readFileSync(path.join(folder, names.releases), 'utf8'));
  if (entry.name !== names.nupkg || entry.size !== files.nupkg.size || entry.sha1 !== files.nupkg.sha1) refuse('RELEASES does not name the nupkg with its SHA-1 and size');

  return {channel, appVersion, nugetVersion, tag: releaseTag(channel, appVersion), title: releaseTitle(channel, appVersion), commit: source.commit, runId,
    setup: files.setup, nupkg: files.nupkg, releases: files.releases};
}

/** The manifest v1 object of verified artifact facts, signed later by `keyId`. */
export function buildUpdateManifest(facts, {keyId, now = new Date()}) {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) throw new Error('The keyId must be 1 to 64 letters, digits, ".", "_" or "-"');
  const {nupkg} = facts;
  return {format: MANIFEST_FORMAT, channel: facts.channel, appVersion: facts.appVersion, nugetVersion: facts.nugetVersion,
    package: {tag: facts.tag, name: nupkg.name, size: nupkg.size, sha256: nupkg.sha256, sha1: nupkg.sha1},
    publishedUtc: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), keyId};
}

/** The exact bytes written and signed: two-space JSON with a final line break. */
export function manifestBytesOf(manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (bytes.length > MANIFEST_MAX_BYTES) throw new Error('The manifest exceeds 16 KiB');
  return bytes;
}

/** The release notes of verified artifact facts (docs/release.md, "Release checklist"). */
export function releaseNotesOf(facts, repository) {
  const run = `https://github.com/${repository}/actions/runs/${facts.runId}`;
  const lines = [
    facts.channel === 'staging'
      ? `Staging build ${facts.appVersion} for testing. It installs beside the production application, with its own data folder \`%LOCALAPPDATA%\\ETS2TelemetryStaging\`, plugin and pipes, and updates only from staging releases.`
      : `Yukon Union Telemetry ${facts.appVersion}, an unsigned internal alpha.`,
    '',
    `- Source commit: \`${facts.commit}\``,
    `- Built by Windows CI run ${run}`,
    `- \`${facts.setup.name}\` SHA-256: \`${facts.setup.sha256}\``,
    `- \`${facts.nupkg.name}\` SHA-256: \`${facts.nupkg.sha256}\``,
    '',
    'The installer and the application are not code-signed. Windows SmartScreen shows "Windows protected your PC" with an unknown publisher; choose "More info" and then "Run anyway". Smart App Control, when on, blocks the installer.',
    '',
    'Pending checks: real games (ETS2 and ATS, single-player and TruckersMP), a clean Windows machine, SmartScreen, Smart App Control and antivirus behaviour. See docs/release.md and the validation records in the repository.'
  ];
  return `${lines.join('\n')}\n`;
}

/** The keyId the manifest names: the given one, which must be a key the released build compiled, or its channel's only key. */
export function selectKeyId(keys, channel, requested) {
  if (requested) {
    if (!keys.some(key => key.keyId === requested)) throw new Error(`keyId ${JSON.stringify(requested)} is not a ${channel} key compiled into the released build (update-keys.ts)`);
    return requested;
  }
  if (keys.length === 0) throw new Error(`No compiled ${channel} update key in the released build: complete step 0 of the release checklist (docs/release.md) first`);
  if (keys.length > 1) throw new Error(`Several compiled ${channel} update keys: name the signing key with --key-id`);
  return keys[0].keyId;
}

const USAGE = 'Usage: node scripts/release/write-update-manifest.mjs --artifacts <folder> --channel <production|staging> --run-id <id> ' +
  '[--run-number <6 digits>, required for staging] [--commit <sha>] [--repository <owner/name>] [--facts <file>] ' +
  '[--out <manifest file> --notes <notes file> [--keys-file <update-keys.ts of the released commit>] [--key-id <id>]]';

/** The `--run-number` a staging release must give (the released run's number, check-github-release.mjs run). */
export function cliRunNumber(channel, runNumber) {
  if (channel === 'staging' && runNumber === undefined) throw new Error('A staging release needs --run-number: the run number of the CI run it is released from');
  return runNumber;
}

async function main(argv) {
  const {values} = parseArgs({args: argv, strict: true, options: {
    artifacts: {type: 'string'}, channel: {type: 'string'}, 'run-id': {type: 'string'}, 'run-number': {type: 'string'}, commit: {type: 'string'},
    repository: {type: 'string'}, 'key-id': {type: 'string'}, 'keys-file': {type: 'string'}, facts: {type: 'string'}, out: {type: 'string'}, notes: {type: 'string'}}});
  if (!values.artifacts || !values.channel || !values['run-id'] || (values.out === undefined) !== (values.notes === undefined)) throw new Error(USAGE);
  const facts = verifyReleaseArtifacts(path.resolve(values.artifacts), {channel: values.channel, runId: values['run-id'], commit: values.commit,
    runNumber: cliRunNumber(values.channel, values['run-number'])});
  if (values.out) {
    // The keys the released build compiled (the release workflow passes update-keys.ts of the run's commit), so a build
    // that ships without a key of its channel is never given a manifest it could not verify.
    const keyId = selectKeyId(await compiledUpdateKeys(facts.channel, values['keys-file']), facts.channel, values['key-id']);
    writeFileSync(values.out, manifestBytesOf(buildUpdateManifest(facts, {keyId})), {flag: 'wx'});
    writeFileSync(values.notes, releaseNotesOf(facts, values.repository ?? 'senukartur/ets2telemetry'), {flag: 'wx'});
  }
  if (values.facts) writeFileSync(values.facts, `${JSON.stringify(facts, null, 2)}\n`, {flag: 'wx'});
  console.log(JSON.stringify({channel: facts.channel, appVersion: facts.appVersion, tag: facts.tag, commit: facts.commit, setup: facts.setup.name,
    nupkg: facts.nupkg.name, nupkgSha256: facts.nupkg.sha256, manifest: values.out ? path.basename(values.out) : null}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;});
}
