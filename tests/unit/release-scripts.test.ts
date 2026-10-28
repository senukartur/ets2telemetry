import {spawnSync} from 'node:child_process';
import {createHash, generateKeyPairSync, sign as cryptoSign} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES, type ReleaseChannel} from '../../apps/desktop/src/channel';
import {UPDATE_PUBLIC_KEYS} from '../../apps/desktop/src/updater/update-keys';
import {parseUpdateManifest, verifyManifestSignature, verifyUpdateManifest, type ManifestBinding} from '../../apps/desktop/src/updater/update-manifest';
import {compareNugetVersions as appCompareNugetVersions, nugetVersionOf as appNugetVersionOf} from '../../apps/desktop/src/updater/update-version';
import {BUILD_IDENTITIES, buildSetupFileName} from '../../scripts/build-channel.mjs';
import {checkMainAncestry, checkNewerThanLatest, checkRelease, checkReleaseRun, checkStagingBase} from '../../scripts/release/check-github-release.mjs';
import {generateUpdateKey, updateKeyEntry, writeUpdateKey} from '../../scripts/release/generate-update-key.mjs';
import {loadSigningKey, privateKeyOf, signManifestBytes} from '../../scripts/release/sign-update-manifest.mjs';
import {assertKeyPathOutsideRepository, compareNugetVersions, compiledUpdateKeys, nugetVersionOf, parseManifestBytes, parseUpdateKeysSource, REPOSITORY_ROOT, verifySignatureBytes}
  from '../../scripts/release/update-manifest-common.mjs';
import {verifySignedManifest} from '../../scripts/release/verify-update-manifest.mjs';
import {buildUpdateManifest, cliRunNumber, manifestBytesOf, releaseNotesOf, selectKeyId, verifyReleaseArtifacts, type ReleaseFacts}
  from '../../scripts/release/write-update-manifest.mjs';

// ET-055 PR-9 (UP4, UP5, UP13, UP16; REG-019, release part): the release scripts write, sign and check update manifests
// that the application's own verifier (apps/desktop/src/updater/update-manifest.ts) accepts. Every key is generated inside
// the run into a temporary folder outside the repository; no private key is committed and no test reaches GitHub. Artifact
// folders are synthetic bytes with a hand-written release identity, never a real build. Expected outcomes are written by
// hand from the plan's refusal list.

const RUN = '41000000001';
const COMMIT = 'a'.repeat(40);
let scratch: string;
beforeEach(() => {scratch = mkdtempSync(path.join(tmpdir(), 'ets2telemetry-release-scripts-'));});
afterEach(() => {rmSync(scratch, {recursive: true, force: true});});

const sha = (algorithm: 'sha256' | 'sha1', bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex');

interface IdentityFixture {
  format: string; version: number; createdUtc: string; channel: string;
  builtBy: {kind: string; runId: string | null};
  source: {commit: string; sourceCommit: string; treeClean: boolean};
  versions: {app: string; nuget: string; electron: string; plugin: string};
  artifacts: Record<'setup' | 'nupkg' | 'releases', {name: string; size: number; sha256: string}>;
}
interface FixtureOptions {
  channel?: ReleaseChannel;
  version?: string;
  identity?: (identity: IdentityFixture) => void;
  releases?: (line: string) => string;
}
/** A synthetic CI installer artifact folder: Setup, the full nupkg, RELEASES and release-identity.json. */
function artifactFolder(options: FixtureOptions = {}) {
  const channel = options.channel ?? 'production', version = options.version ?? (channel === 'production' ? '0.2.0' : '0.2.0-stg.000042');
  const build = BUILD_IDENTITIES[channel], nuget = nugetVersionOf(version);
  const folder = path.join(scratch, `artifact-${channel}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(folder);
  const setup = Buffer.from(`synthetic setup ${channel} ${version}`), nupkg = Buffer.alloc(4096, 7), setupName = buildSetupFileName(build, version);
  const nupkgName = `${build.squirrelId}-${nuget}-full.nupkg`;
  writeFileSync(path.join(folder, setupName), setup);
  writeFileSync(path.join(folder, nupkgName), nupkg);
  const line = `${sha('sha1', nupkg).toUpperCase()} ${nupkgName} ${nupkg.length}`;
  const releases = Buffer.from(`\uFEFF${(options.releases ?? (text => text))(line)}`, 'utf8');
  writeFileSync(path.join(folder, 'RELEASES'), releases);
  const identity: IdentityFixture = {
    format: 'ets2telemetry.release-identity', version: 1, createdUtc: '2026-10-28T10:00:00.000Z', channel, builtBy: {kind: 'github-actions', runId: RUN},
    source: {commit: COMMIT, sourceCommit: COMMIT, treeClean: true}, versions: {app: version, nuget, electron: '44.7.0', plugin: version},
    artifacts: {setup: {name: setupName, size: setup.length, sha256: sha('sha256', setup)}, nupkg: {name: nupkgName, size: nupkg.length, sha256: sha('sha256', nupkg)},
      releases: {name: 'RELEASES', size: releases.length, sha256: sha('sha256', releases)}}
  };
  options.identity?.(identity);
  writeFileSync(path.join(folder, 'release-identity.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return {folder, setupName, nupkgName, nupkg};
}

/** A generated key of `channel` whose private PEM lies in the scratch folder, as an owner would keep it outside the repository. */
function ownerKey(channel: ReleaseChannel) {
  const file = path.join(scratch, `${channel}-${Math.random().toString(16).slice(2)}.pem`);
  const entry = writeUpdateKey(channel, file);
  return {file, entry, privateKey: loadSigningKey({keyPath: file, channel})};
}

const binding = (channel: ReleaseChannel, keys: {keyId: string; publicKey: string}[], currentVersion: string, sourceTag?: string): ManifestBinding =>
  ({identity: CHANNEL_IDENTITIES[channel], keys, currentVersion, sourceTag});

function writtenAndSigned(channel: ReleaseChannel, options: FixtureOptions = {}) {
  const artifact = artifactFolder({channel, ...options});
  const key = ownerKey(channel);
  const facts = verifyReleaseArtifacts(artifact.folder, {channel, runId: RUN, commit: COMMIT});
  const bytes = manifestBytesOf(buildUpdateManifest(facts, {keyId: key.entry.keyId, now: new Date('2026-10-28T12:34:56.789Z')}));
  const {signature} = signManifestBytes(bytes, key.privateKey);
  return {artifact, key, facts, bytes, signature};
}

describe('round trip through the application verifier', () => {
  it('accepts a production manifest written and signed by the scripts with the matching public key', () => {
    const {bytes, signature, key, artifact} = writtenAndSigned('production');
    const result = verifyUpdateManifest(bytes, signature, binding('production', [key.entry], '0.1.1'));
    expect(result).toEqual({ok: true, manifest: {format: 'ets2telemetry.update-manifest.v1', channel: 'production', appVersion: '0.2.0', nugetVersion: '0.2.0',
      package: {tag: 'v0.2.0', name: 'ETS2TelemetryDesktop-0.2.0-full.nupkg', size: 4096, sha256: sha('sha256', artifact.nupkg), sha1: sha('sha1', artifact.nupkg)},
      publishedUtc: '2026-10-28T12:34:56Z', keyId: key.entry.keyId}});
    expect(signature.toString('ascii')).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
  });
  it('accepts a staging manifest bound to the release it came from', () => {
    const {bytes, signature, key} = writtenAndSigned('staging');
    expect(verifyUpdateManifest(bytes, signature, binding('staging', [key.entry], '0.2.0-stg.000041', 'staging-v0.2.0-stg.000042'))).toMatchObject({ok: true,
      manifest: {appVersion: '0.2.0-stg.000042', nugetVersion: '0.2.0-stg000042', package: {tag: 'staging-v0.2.0-stg.000042', name: 'ETS2TelemetryStagingDesktop-0.2.0-stg000042-full.nupkg'}}});
  });
  it('refuses the manifest after any single byte changes', () => {
    const {bytes, signature, key} = writtenAndSigned('production');
    const keys = [key.entry];
    for (const index of [0, 10, Math.floor(bytes.length / 2), bytes.length - 2, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[index] ^= 0x01;
      const result = verifyUpdateManifest(changed, signature, binding('production', keys, '0.1.1'));
      expect(result.ok, `byte ${index}`).toBe(false);
      expect(['SIGNATURE_INVALID', 'MANIFEST_MALFORMED']).toContain(result.ok ? '' : result.code);
    }
    const signatureChanged = Buffer.from(signature);
    signatureChanged[5] = signatureChanged[5] === 0x41 ? 0x42 : 0x41;
    expect(verifyUpdateManifest(bytes, signatureChanged, binding('production', keys, '0.1.1'))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
  });
  it('refuses the manifest with a wrong key: another key under the same keyId, or the staging key for a production build', () => {
    const {bytes, signature, key} = writtenAndSigned('production');
    const other = generateUpdateKey('production');
    expect(verifyUpdateManifest(bytes, signature, binding('production', [{keyId: key.entry.keyId, publicKey: other.publicKey}], '0.1.1'))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
    const staging = ownerKey('staging');
    expect(verifyUpdateManifest(bytes, signature, binding('production', [staging.entry], '0.1.1'))).toEqual({ok: false, code: 'SIGNATURE_INVALID'});
  });
  it('refuses the manifest in a build of the other channel, even with the signing key compiled in', () => {
    const production = writtenAndSigned('production');
    expect(verifyUpdateManifest(production.bytes, production.signature, binding('staging', [production.key.entry], '0.1.1-stg.000001', 'staging-v0.2.0-stg.000042')))
      .toEqual({ok: false, code: 'CHANNEL_MISMATCH'});
    const staging = writtenAndSigned('staging');
    expect(verifyUpdateManifest(staging.bytes, staging.signature, binding('production', [staging.key.entry], '0.1.1'))).toEqual({ok: false, code: 'CHANNEL_MISMATCH'});
  });
  it('agrees with the application on parsing, signatures and NuGet versions', () => {
    const {bytes, signature, key} = writtenAndSigned('production');
    expect(parseManifestBytes(bytes)).toEqual(parseUpdateManifest(bytes));
    expect(verifySignatureBytes(bytes, signature, key.entry.publicKey)).toBe(verifyManifestSignature(bytes, signature, key.entry.publicKey));
    expect(verifySignatureBytes(Buffer.concat([bytes, Buffer.from(' ')]), signature, key.entry.publicKey)).toBe(false);
    for (const version of ['0.2.0', '0.2.0-stg.000042', '1.0.0-alpha.1', '1.0.0-alpha.1+build.5']) expect(nugetVersionOf(version), version).toBe(appNugetVersionOf(version));
  });
});

describe('manifest writer refusals', () => {
  const refused = (options: FixtureOptions, pattern: RegExp, verify: {channel?: string; runId?: string; commit?: string} = {}) => {
    const {folder} = artifactFolder(options);
    expect(() => verifyReleaseArtifacts(folder, {channel: verify.channel ?? options.channel ?? 'production', runId: verify.runId ?? RUN, commit: verify.commit ?? COMMIT})).toThrow(pattern);
  };
  it('refuses an artifact of the other channel', () => {
    refused({channel: 'staging'}, /is a "staging" build, not production/, {channel: 'production'});
    refused({channel: 'production'}, /is a "production" build, not staging/, {channel: 'staging'});
  });
  it('refuses an artifact not built by GitHub Actions or built by another run', () => {
    refused({identity: identity => {identity.builtBy = {kind: 'local', runId: null};}}, /not built by GitHub Actions/);
    refused({}, /built by run "41000000001", not run 41000000002/, {runId: '41000000002'});
    refused({}, /CI run id must be a positive integer/, {runId: '0'});
  });
  it('refuses another commit than the run head and a tree with tracked changes', () => {
    refused({}, /identity commit differs from the CI run head/, {commit: 'b'.repeat(40)});
    refused({identity: identity => {identity.source.treeClean = false;}}, /tree with tracked changes/);
  });
  it('refuses versions the channel cannot release and a NuGet version that is not the conversion', () => {
    refused({channel: 'staging', version: '0.2.0-stg.000000'}, /local staging run number 000000/);
    refused({channel: 'staging', version: '0.2.0'}, /is not a staging version/);
    refused({channel: 'production', version: '0.2.0-stg.000042'}, /carries a staging label/);
    refused({identity: identity => {identity.versions.nuget = '0.2.0.0';}}, /NuGet version "0.2.0.0" is not 0.2.0/);
  });
  // Review of October 28, 2026: a staging artifact is released only under the number of the run that built it.
  it('requires a staging version to carry the released run\'s number', () => {
    const {folder} = artifactFolder({channel: 'staging', version: '0.2.0-stg.000042'});
    expect(verifyReleaseArtifacts(folder, {channel: 'staging', runId: RUN, commit: COMMIT, runNumber: '000042'}).appVersion).toBe('0.2.0-stg.000042');
    expect(() => verifyReleaseArtifacts(folder, {channel: 'staging', runId: RUN, commit: COMMIT, runNumber: '000043'}))
      .toThrow('Release artifact refused: staging version 0.2.0-stg.000042 does not carry the run number 000043 of the CI run it is released from');
    expect(() => verifyReleaseArtifacts(folder, {channel: 'staging', runId: RUN, commit: COMMIT, runNumber: '000420'})).toThrow(/does not carry the run number 000420/);
    for (const runNumber of ['42', '000000', '0000042', 'abcdef']) {
      expect(() => verifyReleaseArtifacts(folder, {channel: 'staging', runId: RUN, commit: COMMIT, runNumber}), runNumber).toThrow('the CI run number must be 6 digits, from 000001');
    }
    // A production version carries no run number; the released run's number does not change its check.
    expect(verifyReleaseArtifacts(artifactFolder().folder, {channel: 'production', runId: RUN, commit: COMMIT, runNumber: '000043'}).appVersion).toBe('0.2.0');
    expect(cliRunNumber('production', undefined)).toBeUndefined();
    expect(cliRunNumber('staging', '000042')).toBe('000042');
    expect(() => cliRunNumber('staging', undefined)).toThrow('A staging release needs --run-number');
  });
  it('refuses a nupkg that is not named exactly <Squirrel id>-<NuGet version>-full.nupkg', () => {
    // A name that only starts with the production id (the staging id before the October 28, 2026 amendment) must still be
    // refused: only exact equality tells such names apart.
    const {folder, nupkgName} = artifactFolder();
    const wrong = 'ETS2TelemetryDesktopStaging-0.2.0-full.nupkg';
    renameSync(path.join(folder, nupkgName), path.join(folder, wrong));
    const identityFile = path.join(folder, 'release-identity.json');
    const identity = JSON.parse(readFileSync(identityFile, 'utf8')) as IdentityFixture;
    identity.artifacts.nupkg.name = wrong;
    writeFileSync(identityFile, JSON.stringify(identity));
    expect(() => verifyReleaseArtifacts(folder, {channel: 'production', runId: RUN, commit: COMMIT})).toThrow(/nupkg is not exactly ETS2TelemetryDesktop-0.2.0-full.nupkg/);
    refused({releases: line => line.replace('-full.nupkg', '-delta.nupkg')}, /RELEASES does not name the nupkg/);
  });
  it('refuses a file whose bytes differ from the identity or RELEASES, a missing file and an extra file', () => {
    const changed = artifactFolder();
    writeFileSync(path.join(changed.folder, changed.nupkgName), Buffer.alloc(4096, 8));
    expect(() => verifyReleaseArtifacts(changed.folder, {channel: 'production', runId: RUN})).toThrow(/ETS2TelemetryDesktop-0.2.0-full.nupkg differs from its size or SHA-256/);
    refused({releases: line => line.replace(/^[0-9A-F]{40}/, '0'.repeat(40))}, /differs from its size or SHA-256|RELEASES does not name the nupkg/);
    const extra = artifactFolder();
    writeFileSync(path.join(extra.folder, 'notes.txt'), 'x');
    expect(() => verifyReleaseArtifacts(extra.folder, {channel: 'production', runId: RUN})).toThrow(/must hold exactly/);
    const missing = artifactFolder();
    rmSync(path.join(missing.folder, missing.setupName));
    expect(() => verifyReleaseArtifacts(missing.folder, {channel: 'production', runId: RUN})).toThrow(/must hold exactly/);
  });
  it('names a compiled key: the requested one, or the only one, and fails without one', () => {
    const keys = [{keyId: 'production-0123456789abcdef', publicKey: generateUpdateKey('production').publicKey}];
    expect(selectKeyId(keys, 'production')).toBe('production-0123456789abcdef');
    expect(selectKeyId(keys, 'production', 'production-0123456789abcdef')).toBe('production-0123456789abcdef');
    expect(() => selectKeyId(keys, 'production', 'production-ffffffffffffffff')).toThrow(/is not a production key compiled into the released build/);
    expect(() => selectKeyId([], 'production')).toThrow(/No compiled production update key/);
    expect(() => selectKeyId([...keys, {...keys[0], keyId: 'production-1'}], 'production')).toThrow(/Several compiled production update keys/);
  });
  it('writes the release title and notes of the owner decision', () => {
    const production = verifyReleaseArtifacts(artifactFolder().folder, {channel: 'production', runId: RUN});
    const staging = verifyReleaseArtifacts(artifactFolder({channel: 'staging'}).folder, {channel: 'staging', runId: RUN});
    expect(production.title).toBe('Yukon Union Telemetry 0.2.0 – unsigned internal alpha');
    expect(staging.title).toBe('Staging 0.2.0-stg.000042 – unsigned, for testing');
    expect(staging.tag).toBe('staging-v0.2.0-stg.000042');
    const notes = releaseNotesOf(production, 'senukartur/ets2telemetry');
    expect(notes).toContain(`\`${production.setup.name}\` SHA-256: \`${production.setup.sha256}\``);
    expect(notes).toContain(`https://github.com/senukartur/ets2telemetry/actions/runs/${RUN}`);
    expect(notes).toContain('not code-signed');
  });
});

describe('signer', () => {
  it('refuses a key other than the one the manifest names, before signing', () => {
    const artifact = artifactFolder();
    const facts = verifyReleaseArtifacts(artifact.folder, {channel: 'production', runId: RUN});
    const named = ownerKey('production'), other = ownerKey('production');
    const bytes = manifestBytesOf(buildUpdateManifest(facts, {keyId: named.entry.keyId}));
    expect(() => signManifestBytes(bytes, other.privateKey)).toThrow(`The manifest names key ${named.entry.keyId}, but this production key is ${other.entry.keyId}`);
    // The same key pair under the other channel has another keyId, so a staging key never signs as a production one.
    const staging = ownerKey('staging');
    expect(() => signManifestBytes(manifestBytesOf(buildUpdateManifest(facts, {keyId: staging.entry.keyId})), staging.privateKey)).toThrow(/but this production key is production-/);
    expect(() => signManifestBytes(Buffer.from('{}'), named.privateKey)).toThrow('The manifest is not an update manifest v1');
  });
  it('reads a key from the environment only for a staging manifest in GitHub Actions', () => {
    const pem = generateUpdateKey('staging').privatePem;
    expect(loadSigningKey({keyEnv: 'UPDATE_SIGNING_KEY_STAGING', channel: 'staging', env: {GITHUB_ACTIONS: 'true', UPDATE_SIGNING_KEY_STAGING: pem}}).asymmetricKeyType).toBe('ed25519');
    expect(() => loadSigningKey({keyEnv: 'UPDATE_SIGNING_KEY_STAGING', channel: 'production', env: {GITHUB_ACTIONS: 'true', UPDATE_SIGNING_KEY_STAGING: pem}})).toThrow(/signs only a staging manifest in GitHub Actions/);
    expect(() => loadSigningKey({keyEnv: 'UPDATE_SIGNING_KEY_STAGING', channel: 'staging', env: {UPDATE_SIGNING_KEY_STAGING: pem}})).toThrow(/signs only a staging manifest in GitHub Actions/);
    expect(() => loadSigningKey({keyEnv: 'UPDATE_SIGNING_KEY_STAGING', channel: 'staging', env: {GITHUB_ACTIONS: 'true'}})).toThrow(/is empty/);
    expect(() => loadSigningKey({channel: 'staging'})).toThrow(/exactly one of/);
  });
  it('refuses a key that is not an unencrypted PKCS#8 Ed25519 PEM, without echoing it', () => {
    const rsa = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({format: 'pem', type: 'pkcs8'}).toString();
    expect(() => privateKeyOf(rsa)).toThrow('The signing key is not an Ed25519 key');
    const encrypted = generateKeyPairSync('ed25519').privateKey.export({format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'x'}).toString();
    expect(() => privateKeyOf(encrypted)).toThrow('The signing key is not an unencrypted PKCS#8 PEM private key');
    const garbage = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n';
    expect(() => privateKeyOf(garbage)).toThrow('The signing key could not be read as a PKCS#8 PEM private key');
  });
  it('signs from the command line, prints what it signed and never the key', () => {
    const artifact = artifactFolder({channel: 'staging'});
    const facts = verifyReleaseArtifacts(artifact.folder, {channel: 'staging', runId: RUN});
    const key = ownerKey('staging'), pem = readFileSync(key.file, 'utf8');
    const manifest = path.join(scratch, 'update-manifest.json');
    writeFileSync(manifest, manifestBytesOf(buildUpdateManifest(facts, {keyId: key.entry.keyId})));
    const run = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/sign-update-manifest.mjs'), '--manifest', manifest, '--key', key.file], {encoding: 'utf8'});
    expect(run.status, run.stderr).toBe(0);
    const body = pem.split(/\r?\n/).filter(line => line && !line.startsWith('-----'));
    for (const output of [run.stdout, run.stderr]) {
      expect(output).not.toContain('PRIVATE KEY');
      for (const line of body) expect(output).not.toContain(line);
    }
    expect(JSON.parse(run.stdout)).toMatchObject({signature: 'update-manifest.json.sig', channel: 'staging', tag: 'staging-v0.2.0-stg.000042', keyId: key.entry.keyId});
    const signature = readFileSync(path.join(scratch, 'update-manifest.json.sig'));
    expect(verifyUpdateManifest(readFileSync(manifest), signature, binding('staging', [key.entry], '0.2.0-stg.000041', 'staging-v0.2.0-stg.000042')).ok).toBe(true);
    // A second run never overwrites the signature.
    expect(spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/sign-update-manifest.mjs'), '--manifest', manifest, '--key', key.file], {encoding: 'utf8'}).status).toBe(1);
  });
});

describe('key generator', () => {
  it('prints only the public entry in the form update-keys.ts lists, and writes a usable private key once', () => {
    const file = path.join(scratch, 'owner.pem');
    const run = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/generate-update-key.mjs'), '--channel', 'production', '--out', file], {encoding: 'utf8'});
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toBe('');
    const match = /^\{keyId: '(production-[0-9a-f]{16})', publicKey: '([A-Za-z0-9+/]{43}=)'\}\n$/.exec(run.stdout);
    expect(match, run.stdout).not.toBeNull();
    const pem = readFileSync(file, 'utf8');
    expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(run.stdout).not.toContain(pem.split('\n')[1]);
    const key = privateKeyOf(pem);
    const entry = {keyId: match![1], publicKey: match![2]};
    expect(updateKeyEntry(entry)).toBe(run.stdout.trim());
    const facts = verifyReleaseArtifacts(artifactFolder().folder, {channel: 'production', runId: RUN});
    const bytes = manifestBytesOf(buildUpdateManifest(facts, {keyId: entry.keyId}));
    expect(verifyUpdateManifest(bytes, signManifestBytes(bytes, key).signature, binding('production', [entry], '0.1.1')).ok).toBe(true);
    const again = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/generate-update-key.mjs'), '--channel', 'production', '--out', file], {encoding: 'utf8'});
    expect(again.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(pem);
  });
  it('refuses a key path inside the repository or inside any Git working tree', () => {
    expect(() => writeUpdateKey('production', path.join(REPOSITORY_ROOT, 'owner.pem'))).toThrow('A private key must be kept outside the repository');
    expect(() => writeUpdateKey('production', path.join(REPOSITORY_ROOT, 'scripts', 'owner.pem'))).toThrow(/outside the repository|outside every Git working tree/);
    const tree = path.join(scratch, 'other-tree');
    mkdirSync(path.join(tree, '.git'), {recursive: true});
    mkdirSync(path.join(tree, 'keys'));
    expect(() => assertKeyPathOutsideRepository(path.join(tree, 'keys', 'owner.pem'))).toThrow('A private key must be kept outside every Git working tree');
    expect(() => loadSigningKey({keyPath: path.join(REPOSITORY_ROOT, 'owner.pem'), channel: 'production'})).toThrow('A private key must be kept outside the repository');
    expect(() => assertKeyPathOutsideRepository(path.join(scratch, 'missing', 'owner.pem'))).toThrow('The key folder does not exist');
  });
});

describe('workflow verification of a signed manifest', () => {
  const signedFacts = (): {facts: ReleaseFacts; bytes: Buffer; signature: Buffer; keys: {keyId: string; publicKey: string}[]} => {
    const {facts, bytes, signature, key} = writtenAndSigned('production');
    return {facts, bytes, signature, keys: [key.entry]};
  };
  it('accepts the signed manifest of the same artifacts and refuses any other binding', () => {
    const {facts, bytes, signature, keys} = signedFacts();
    expect(verifySignedManifest({manifestBytes: bytes, signatureBytes: signature, facts, keys}).package.tag).toBe('v0.2.0');
    expect(() => verifySignedManifest({manifestBytes: bytes, signatureBytes: signature, facts, keys: []})).toThrow(/is not a compiled production key/);
    expect(() => verifySignedManifest({manifestBytes: bytes, signatureBytes: Buffer.from(`${'A'.repeat(86)}==\n`), facts, keys})).toThrow(/signature does not verify/);
    const otherBytes = {...facts, nupkg: {...facts.nupkg, sha256: '0'.repeat(64)}};
    expect(() => verifySignedManifest({manifestBytes: bytes, signatureBytes: signature, facts: otherBytes, keys})).toThrow(/package.sha256 differs from the artifact/);
    expect(() => verifySignedManifest({manifestBytes: bytes, signatureBytes: signature, facts: {...facts, channel: 'staging'}, keys})).toThrow(/channel differs from the artifact/);
  });
  it('reads the compiled keys of update-keys.ts under plain Node as the workflow does', async () => {
    expect(await compiledUpdateKeys('production')).toEqual([...UPDATE_PUBLIC_KEYS.production]);
    expect(await compiledUpdateKeys('staging')).toEqual([...UPDATE_PUBLIC_KEYS.staging]);
    const {folder} = artifactFolder();
    const out = path.join(scratch, 'manifest.json'), notes = path.join(scratch, 'notes.md');
    const run = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/write-update-manifest.mjs'), '--artifacts', folder, '--channel', 'production',
      '--run-id', RUN, '--commit', COMMIT, '--out', out, '--notes', notes], {encoding: 'utf8', env: {...process.env, NODE_OPTIONS: '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'}});
    // The owner's keys are compiled, so each channel's unsigned manifest names its key.
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({channel: 'production', keyId: 'production-611eb870520f2b0f'});
    // Since the review of October 28, 2026 a staging release names the released run's number, which its version must carry.
    const stagingFolder = artifactFolder({channel: 'staging'}).folder;
    const writeStaging = (extra: string[], name: string) => spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/write-update-manifest.mjs'),
      '--artifacts', stagingFolder, '--channel', 'staging', '--run-id', RUN, ...extra, '--commit', COMMIT, '--out', path.join(scratch, `${name}.json`),
      '--notes', path.join(scratch, `${name}.md`)], {encoding: 'utf8'});
    const staging = writeStaging(['--run-number', '000042'], 'staging-manifest');
    expect(staging.status, staging.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(scratch, 'staging-manifest.json'), 'utf8'))).toMatchObject({channel: 'staging', keyId: 'staging-9a83aca3ea8c5402'});
    const unnumbered = writeStaging([], 'unnumbered');
    expect(unnumbered.status).toBe(1);
    expect(unnumbered.stderr).toContain('A staging release needs --run-number: the run number of the CI run it is released from');
    const otherRun = writeStaging(['--run-number', '000043'], 'other-run');
    expect(otherRun.status).toBe(1);
    expect(otherRun.stderr).toContain('Release artifact refused: staging version 0.2.0-stg.000042 does not carry the run number 000043 of the CI run it is released from');
    const verifyOnly = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/write-update-manifest.mjs'), '--artifacts', folder, '--channel', 'production',
      '--run-id', RUN, '--commit', COMMIT], {encoding: 'utf8'});
    expect(verifyOnly.status, verifyOnly.stderr).toBe(0);
    expect(JSON.parse(verifyOnly.stdout)).toMatchObject({channel: 'production', tag: 'v0.2.0', manifest: null});
  });
});

// Review of October 28, 2026: a staging release may come from any branch, so update-keys.ts of the released commit can be
// unreviewed code, and the publish job holds a token with contents: write. The release scripts therefore read it as data
// (parseUpdateKeysSource) and never import it; only the exact shape of the shipped file is accepted.
describe('the key list read as data', () => {
  const shippedText = () => readFileSync(path.join(REPOSITORY_ROOT, 'apps/desktop/src/updater/update-keys.ts'), 'utf8').replaceAll('\r\n', '\n');
  const keysFile = (text: string) => {
    const file = path.join(scratch, `update-keys-${Math.random().toString(16).slice(2)}.ts`);
    writeFileSync(file, text);
    return file;
  };
  const SHAPE = 'apps/desktop/src/updater/update-keys.ts does not have the shape of the shipped key list (it is read as data, never run)';
  // Code outside the two lists breaks the file's shape; code inside a list breaks an entry's literal form.
  const REFUSED = /^apps\/desktop\/src\/updater\/update-keys\.ts (does not have the shape of the shipped key list \(it is read as data, never run\)|holds a malformed (production|staging) key)$/;
  const PRODUCTION = {keyId: 'production-611eb870520f2b0f', publicKey: 'xNO3Nk8zVa8Cs4xTB7/leXn4THF9TS/7+1rJaFDR52U='};
  const STAGING = {keyId: 'staging-9a83aca3ea8c5402', publicKey: '05JXyVluihJE37cRR891+feApSdZTpDiJN2hRJAQdRs='};

  it('parses the shipped file to exactly the owner\'s keys, with LF or CRLF line ends', async () => {
    expect(parseUpdateKeysSource(shippedText())).toEqual({production: [PRODUCTION], staging: [STAGING]});
    expect(parseUpdateKeysSource(shippedText().replace(/\r?\n/g, '\r\n'))).toEqual({production: [PRODUCTION], staging: [STAGING]});
    expect(await compiledUpdateKeys('staging', keysFile(shippedText()))).toEqual([STAGING]);
  });
  // Follow-up review: JavaScript ends a line at a lone CR, U+2028 and U+2029, so a "comment" line holding one could hide
  // compiled lists from the parser. Every such file is refused before any line is read.
  it('refuses a lone CR, U+2028, U+2029 or any other character outside printable ASCII', () => {
    const hidden = (terminator: string) => `// x${terminator}production: Object.freeze([]), staging: Object.freeze([]) /*\n${shippedText()}// y${terminator}*/\n`;
    for (const terminator of ['\r', '\u2028', '\u2029']) {
      expect(() => parseUpdateKeysSource(hidden(terminator)), JSON.stringify(terminator)).toThrow('holds a character other than printable ASCII, tab or a line break');
    }
    for (const text of [shippedText().replace('// The compiled', '// Thé compiled'), shippedText().replace('// The compiled', '// The\u0000compiled'), `${shippedText()}\r`]) {
      expect(() => parseUpdateKeysSource(text)).toThrow('holds a character other than printable ASCII, tab or a line break');
    }
    expect(parseUpdateKeysSource(`\uFEFF${shippedText().replace(/\n/g, '\r\n')}`)).toEqual({production: [PRODUCTION], staging: [STAGING]});
  });
  it('reads empty lists and several keys in one list, as during a rotation', () => {
    const other = {keyId: 'production-0123456789abcdef', publicKey: generateUpdateKey('production').publicKey};
    const rotated = shippedText().replace(/production: Object\.freeze\(\[[^\]]*\]\)/, `production: Object.freeze([\n    ${updateKeyEntry(PRODUCTION)},\n    ${updateKeyEntry(other)}\n  ])`)
      .replace(/staging: Object\.freeze\(\[[^\]]*\]\)/, 'staging: Object.freeze([])');
    expect(parseUpdateKeysSource(rotated)).toEqual({production: [PRODUCTION, other], staging: []});
  });
  it('refuses extra code, a computed value, another shape and an oversized file', async () => {
    const text = shippedText();
    const changed = (from: RegExp | string, to: string) => {
      const result = text.replace(from, to);
      expect(result, String(from)).not.toBe(text);
      return result;
    };
    for (const variant of [
      `${text}\nglobalThis.leak = 1;\n`,
      `console.log('x');\n${text}`,
      changed("import type {ReleaseChannel} from '../channel';", "import type {ReleaseChannel} from '../channel';\nimport '../tamper';"),
      changed(`publicKey: '${PRODUCTION.publicKey}'`, `publicKey: atob('${PRODUCTION.publicKey}')`),
      changed(`publicKey: '${PRODUCTION.publicKey}'`, `publicKey: '${PRODUCTION.publicKey.slice(0, 20)}' + '${PRODUCTION.publicKey.slice(20)}'`),
      changed(`{keyId: '${STAGING.keyId}'`, `{...globalThis.extra, keyId: '${STAGING.keyId}'`),
      changed(/production: Object\.freeze\(\[([^\]]*)\]\),\n {2}staging: Object\.freeze\(\[([^\]]*)\]\)/, 'staging: Object.freeze([$2]),\n  production: Object.freeze([$1])'),
      changed('production: Object.freeze([', 'production: ['),
      changed(`${updateKeyEntry(PRODUCTION)}]`, `${updateKeyEntry(PRODUCTION)},]`),
      changed('readonly publicKey: string;', 'readonly publicKey: string;\n  readonly extra: string;'),
      changed('/** Base64 of the raw 32-byte Ed25519 public key. */', '/* a block\n comment */'),
      text.replace('export const UPDATE_PUBLIC_KEYS', 'export let UPDATE_PUBLIC_KEYS')
    ]) expect(() => parseUpdateKeysSource(variant), variant.slice(0, 80)).toThrow(REFUSED);
    // An entry in the right place but of the wrong form, a key that is not 32 bytes, and one keyId listed twice.
    expect(() => parseUpdateKeysSource(changed(`keyId: '${STAGING.keyId}'`, 'keyId: "staging-9a83aca3ea8c5402"'))).toThrow('holds a malformed staging key');
    expect(() => parseUpdateKeysSource(changed(`publicKey: '${STAGING.publicKey}'`, `publicKey: '${'A'.repeat(43)}'`))).toThrow('holds a malformed staging key');
    expect(() => parseUpdateKeysSource(changed(`keyId: '${STAGING.keyId}'`, `keyId: '${PRODUCTION.keyId}'`))).toThrow('lists a keyId twice');
    const oversized = `// ${'x'.repeat(64 * 1024)}\n${text}`;
    expect(() => parseUpdateKeysSource(oversized)).toThrow('is not a text of at most 64 KiB');
    await expect(compiledUpdateKeys('production', keysFile(oversized))).rejects.toThrow('is not a plain file of at most 64 KiB');
  });
  it('never runs the file: a side effect in it does not happen, and the file is refused', async () => {
    const marker = path.join(scratch, 'ran.txt');
    const effect = `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\n`;
    const file = keysFile(`${effect}${shippedText()}`);
    await expect(compiledUpdateKeys('production', file)).rejects.toThrow(SHAPE);
    // The same effect inside a key value, where an import would evaluate it.
    const inValue = keysFile(shippedText().replace(`publicKey: '${PRODUCTION.publicKey}'`,
      `publicKey: (await import('node:fs')).writeFileSync(${JSON.stringify(marker)}, 'ran') ?? '${PRODUCTION.publicKey}'`));
    await expect(compiledUpdateKeys('production', inValue)).rejects.toThrow('holds a malformed production key');
    const cli = spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release/write-update-manifest.mjs'), '--artifacts', artifactFolder().folder, '--channel', 'production',
      '--run-id', RUN, '--commit', COMMIT, '--out', path.join(scratch, 'm.json'), '--notes', path.join(scratch, 'n.md'), '--keys-file', file], {encoding: 'utf8'});
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(SHAPE);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('GitHub answers', () => {
  const run = (overrides: Record<string, unknown> = {}) => ({id: Number(RUN), path: '.github/workflows/windows-ci.yml', head_branch: 'main', event: 'push', status: 'completed',
    conclusion: 'success', head_sha: COMMIT, run_attempt: 2, run_number: 42, repository: {full_name: 'senukartur/ets2telemetry'}, head_repository: {full_name: 'senukartur/ets2telemetry'}, ...overrides});
  const options = (channel = 'production') => ({runId: RUN, repository: 'senukartur/ets2telemetry', channel});
  it('accepts a successful Windows CI run on main and names its latest attempt\'s artifact', () => {
    // Since the review of October 28, 2026 the answer also names the run's branch and its 6-digit run number.
    expect(checkReleaseRun(run(), options())).toEqual({commit: COMMIT, attempt: 2, artifact: `windows-installer-${RUN}-2`, branch: 'main', runNumber: '000042'});
    expect(checkReleaseRun(run({event: 'workflow_dispatch'}), options('staging')))
      .toEqual({commit: COMMIT, attempt: 2, artifact: `windows-installer-staging-${RUN}-2`, branch: 'main', runNumber: '000042'});
  });
  it('names the run number zero-padded to 6 digits and refuses one a staging version cannot carry', () => {
    expect(checkReleaseRun(run({run_number: 1}), options('staging')).runNumber).toBe('000001');
    expect(checkReleaseRun(run({run_number: 999999}), options('staging')).runNumber).toBe('999999');
    for (const runNumber of [undefined, 0, -1, 1000000, 1.5, '42']) {
      expect(() => checkReleaseRun(run({run_number: runNumber}), options('staging')), String(runNumber)).toThrow('Release refused: run 41000000001 names no run number of 1 to 6 digits');
    }
  });
  it('refuses a branch name the job summary could not show as is', () => {
    expect(checkReleaseRun(run({head_branch: 'fix/a.b_c-1'}), options('staging')).branch).toBe('fix/a.b_c-1');
    for (const branch of ['feat/`x`', 'feat x', 'feat|x', 'a'.repeat(256)]) {
      expect(() => checkReleaseRun(run({head_branch: branch}), options('staging')), branch)
        .toThrow('Release refused: run 41000000001 names a branch with characters other than letters, digits, ".", "_", "/" and "-"');
    }
  });
  it('refuses another branch, event, workflow, repository, outcome or run', () => {
    for (const [overrides, reason] of [
      [{head_branch: 'feat/x'}, /did not build main/], [{event: 'pull_request'}, /started by "pull_request"/], [{path: '.github/workflows/windows-soak.yml'}, /is not a .github\/workflows\/windows-ci.yml run/],
      [{head_repository: {full_name: 'fork/ets2telemetry'}}, /did not build senukartur\/ets2telemetry itself/], [{conclusion: 'failure'}, /did not complete successfully/],
      [{status: 'in_progress', conclusion: null}, /did not complete successfully/], [{id: 1}, /is not run 41000000001/]
    ] as const) expect(() => checkReleaseRun(run(overrides), options()), String(reason)).toThrow(reason);
  });
  // Owner decision of October 28, 2026 (DESIGN-DECISIONS.md, "UP15 and UP16 amended"): staging takes a push or a
  // dispatch run of this repository on any branch; production still takes main only.
  it('accepts a staging run dispatched on a feature branch and still refuses it for production', () => {
    const branch = run({head_branch: 'feat/staging-check', event: 'workflow_dispatch'});
    const accepted = {commit: COMMIT, attempt: 2, artifact: `windows-installer-staging-${RUN}-2`, branch: 'feat/staging-check', runNumber: '000042'};
    expect(checkReleaseRun(branch, options('staging'))).toEqual(accepted);
    expect(checkReleaseRun(run({head_branch: 'feat/staging-check'}), options('staging'))).toEqual(accepted);
    expect(() => checkReleaseRun(branch, options('production'))).toThrow('Release refused: run 41000000001 did not build main');
    // A run whose branch name is main still passes this check for production; the workflow then refuses a tag named main
    // and requires the commit to be on the main branch (checkMainAncestry, tests/unit/release-workflow.test.ts).
    expect(checkReleaseRun(run({event: 'workflow_dispatch'}), options('production')))
      .toEqual({commit: COMMIT, attempt: 2, artifact: `windows-installer-${RUN}-2`, branch: 'main', runNumber: '000042'});
  });
  // Review of October 28, 2026: a staging base above main's package.json version would stay above every later main build.
  it('refuses a staging base version higher than main\'s package.json version', () => {
    expect(checkStagingBase('0.1.1-stg.000042', '0.1.1')).toEqual({base: '0.1.1', main: '0.1.1'});
    expect(checkStagingBase('0.1.0-stg.000042', '0.1.1')).toEqual({base: '0.1.0', main: '0.1.1'});
    expect(checkStagingBase('0.9.9-stg.000042', '1.0.0')).toEqual({base: '0.9.9', main: '1.0.0'});
    expect(checkStagingBase('1.2.9-stg.000042', '1.10.0')).toEqual({base: '1.2.9', main: '1.10.0'});
    for (const [version, main] of [['0.1.2-stg.000042', '0.1.1'], ['0.2.0-stg.000042', '0.1.9'], ['1.0.0-stg.000042', '0.9.9'], ['1.10.0-stg.000042', '1.9.0']]) {
      expect(() => checkStagingBase(version, main), version).toThrow(`Release refused: staging version ${version} has the base ${version.split('-')[0]}, higher than ` +
        `main's package.json version ${main}; it would stay above every later main build in installed staging builds. Raise main's version to at least that base first`);
    }
    expect(() => checkStagingBase('0.1.1', '0.1.1')).toThrow('Release refused: version "0.1.1" is not a staging version x.y.z-stg.<6 digits>');
    expect(() => checkStagingBase('0.1.1-stg.000042', '0.1.1-alpha.1')).toThrow('Release refused: main\'s package.json version "0.1.1-alpha.1" is not a plain x.y.z version');
    expect(() => checkStagingBase('0.1.1-stg.000042', 'null')).toThrow(/is not a plain x\.y\.z version/);
  });
  it('refuses a staging run from a pull request, a fork, another workflow or without a branch name', () => {
    for (const [overrides, reason] of [
      [{head_branch: 'feat/x', event: 'pull_request'}, 'Release refused: run 41000000001 was started by "pull_request", not a push or a dispatch'],
      [{head_branch: 'feat/x', event: 'pull_request_target'}, 'Release refused: run 41000000001 was started by "pull_request_target", not a push or a dispatch'],
      [{head_branch: 'feat/x', event: 'workflow_run'}, 'Release refused: run 41000000001 was started by "workflow_run", not a push or a dispatch'],
      [{head_branch: 'feat/x', event: 'workflow_dispatch', head_repository: {full_name: 'fork/ets2telemetry'}}, 'Release refused: run 41000000001 did not build senukartur/ets2telemetry itself'],
      [{head_branch: 'main', event: 'pull_request', head_repository: {full_name: 'fork/ets2telemetry'}}, 'Release refused: run 41000000001 did not build senukartur/ets2telemetry itself'],
      [{head_branch: 'feat/x', event: 'workflow_dispatch', repository: {full_name: 'fork/ets2telemetry'}}, 'Release refused: run 41000000001 did not build senukartur/ets2telemetry itself'],
      [{head_branch: 'feat/x', path: '.github/workflows/release.yml'}, 'Release refused: run 41000000001 is not a .github/workflows/windows-ci.yml run'],
      [{head_branch: 'feat/x', conclusion: 'cancelled'}, 'Release refused: run 41000000001 did not complete successfully'],
      [{head_branch: null}, 'Release refused: run 41000000001 names no branch'],
      [{head_branch: ''}, 'Release refused: run 41000000001 names no branch'],
      [{head_branch: 'feat/x', head_sha: 'feat/x'}, 'Release refused: run 41000000001 names no head commit']
    ] as const) expect(() => checkReleaseRun(run(overrides), options('staging')), JSON.stringify(overrides)).toThrow(reason);
    expect(() => checkReleaseRun(run({event: 'pull_request'}), options('production'))).toThrow('Release refused: run 41000000001 was started by "pull_request", not a push or a dispatch on main');
  });
  it('checks a release\'s tag, commit, flags and exact assets', () => {
    const names = ['a.exe', 'b.nupkg', 'RELEASES'];
    const release = (overrides: Record<string, unknown> = {}) => ({id: 7, tag_name: 'v0.2.0', target_commitish: COMMIT, draft: true, prerelease: false,
      assets: names.map(name => ({name, state: 'uploaded'})), ...overrides});
    const expected = {tag: 'v0.2.0', commit: COMMIT, draft: true, prerelease: false, names};
    expect(checkRelease(release(), expected)).toEqual({id: 7});
    expect(() => checkRelease(release({draft: false}), expected)).toThrow(/is not a draft/);
    expect(() => checkRelease(release({prerelease: true}), expected)).toThrow(/is a pre-release/);
    expect(() => checkRelease(release({target_commitish: 'main'}), expected)).toThrow(/does not target commit/);
    expect(() => checkRelease(release({assets: [...names, 'extra'].map(name => ({name, state: 'uploaded'}))}), expected)).toThrow(/must carry exactly/);
    expect(() => checkRelease(release({assets: names.map(name => ({name, state: 'starter'}))}), expected)).toThrow(/not fully uploaded/);
  });
});

describe('the released commit\'s keys', () => {
  // The release workflow writes update-keys.ts of the CI run's commit to a temporary file (git show) and passes it with
  // --keys-file; the dispatch checkout's keys are never used. This copy is the shipped file with its production list replaced by one test key and its staging list emptied, as a
  // released build without a staging key.
  const releasedKeys = (entry: {keyId: string; publicKey: string}) => {
    const shipped = readFileSync(path.join(REPOSITORY_ROOT, 'apps/desktop/src/updater/update-keys.ts'), 'utf8');
    const changed = shipped.replace(/production: Object\.freeze\(\[[^\]]*\]\)/, `production: Object.freeze([${updateKeyEntry(entry)}])`)
      .replace(/staging: Object\.freeze\(\[[^\]]*\]\)/, 'staging: Object.freeze([])');
    expect(changed).not.toBe(shipped);
    expect(changed).toContain('staging: Object.freeze([])');
    const folder = path.join(scratch, 'released-keys');
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'update-keys.ts'), changed);
    return path.join(folder, 'update-keys.ts');
  };
  const node = (script: string, args: string[]) => spawnSync(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts/release', script), ...args],
    {encoding: 'utf8', env: {...process.env, NODE_OPTIONS: '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'}});

  it('writes and verifies with the keys of the released commit, and refuses keys the released build did not compile', () => {
    const key = ownerKey('production'), keysFile = releasedKeys(key.entry);
    const {folder} = artifactFolder();
    const manifest = path.join(scratch, 'update-manifest.json'), notes = path.join(scratch, 'notes.md');
    const common = ['--artifacts', folder, '--channel', 'production', '--run-id', RUN, '--commit', COMMIT];
    const written = node('write-update-manifest.mjs', [...common, '--out', manifest, '--notes', notes, '--keys-file', keysFile]);
    expect(written.status, written.stderr).toBe(0);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({keyId: key.entry.keyId});
    const signature = path.join(scratch, 'update-manifest.json.sig');
    writeFileSync(signature, signManifestBytes(readFileSync(manifest), key.privateKey).signature);
    const verified = node('verify-update-manifest.mjs', ['--manifest', manifest, '--signature', signature, ...common, '--keys-file', keysFile]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({verified: true, keyId: key.entry.keyId});
    // This checkout ships only the owner's key, so the same signed manifest is refused against it.
    const shipped = node('verify-update-manifest.mjs', ['--manifest', manifest, '--signature', signature, ...common]);
    expect(shipped.status).toBe(1);
    expect(shipped.stderr).toContain(`keyId ${key.entry.keyId} is not a compiled production key`);
    // A requested keyId the released build did not compile is refused before anything is written.
    const other = node('write-update-manifest.mjs', [...common, '--out', path.join(scratch, 'm2.json'), '--notes', path.join(scratch, 'n2.md'), '--keys-file', keysFile,
      '--key-id', 'production-ffffffffffffffff']);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain('is not a production key compiled into the released build');
    // The staging list of the same file is empty.
    const staging = node('write-update-manifest.mjs', ['--artifacts', artifactFolder({channel: 'staging'}).folder, '--channel', 'staging', '--run-id', RUN, '--run-number', '000042', '--commit', COMMIT,
      '--out', path.join(scratch, 'm3.json'), '--notes', path.join(scratch, 'n3.md'), '--keys-file', keysFile]);
    expect(staging.status).toBe(1);
    expect(staging.stderr).toContain('No compiled staging update key in the released build');
  });
});

describe('main ancestry and the latest release', () => {
  const compare = (status: string, sha = COMMIT) => ({status, base_commit: {sha}, merge_base_commit: {sha}});
  it('accepts a commit that main contains and refuses one main does not', () => {
    expect(checkMainAncestry(compare('identical'), COMMIT)).toEqual({status: 'identical'});
    expect(checkMainAncestry(compare('ahead'), COMMIT)).toEqual({status: 'ahead'});
    for (const status of ['behind', 'diverged']) expect(() => checkMainAncestry(compare(status), COMMIT), status).toThrow(`commit ${COMMIT} is not on the main branch`);
    expect(() => checkMainAncestry({status: 'ahead', base_commit: {sha: COMMIT}, merge_base_commit: {sha: 'b'.repeat(40)}}, COMMIT)).toThrow(/is not on the main branch/);
    expect(() => checkMainAncestry(compare('ahead', 'b'.repeat(40)), COMMIT)).toThrow(/is not on the main branch/);
    expect(() => checkMainAncestry(compare('ahead'), 'main')).toThrow(/40 lower-case hex digits/);
  });
  it('requires a production version higher than the latest release by NuGet SemVer order', () => {
    expect(checkNewerThanLatest('none', '0.1.1')).toEqual({latest: null});
    expect(checkNewerThanLatest('v0.1.1', '0.2.0')).toEqual({latest: 'v0.1.1'});
    // NuGet drops the label's dots, so alpha10 sorts below alpha9 as text, as the application compares it (docs/release.md, step 1).
    expect(() => checkNewerThanLatest('v0.1.0-alpha.9', '0.1.0-alpha.10')).toThrow(/is not higher than the latest release v0.1.0-alpha.9/);
    expect(checkNewerThanLatest('v0.1.0-alpha.9', '0.1.1-alpha.1')).toEqual({latest: 'v0.1.0-alpha.9'});
    expect(checkNewerThanLatest('v0.1.0-alpha.2', '0.1.0')).toEqual({latest: 'v0.1.0-alpha.2'});
    expect(() => checkNewerThanLatest('v0.2.0', '0.2.0')).toThrow('version 0.2.0 is not higher than the latest release v0.2.0');
    expect(() => checkNewerThanLatest('v0.2.0', '0.1.9')).toThrow(/is not higher than the latest release v0.2.0/);
    expect(() => checkNewerThanLatest('v0.2.0', '0.2.0-alpha.1')).toThrow(/is not higher/);
    expect(() => checkNewerThanLatest('staging-v0.2.0-stg.000042', '0.3.0')).toThrow(/has no production tag/);
    expect(() => checkNewerThanLatest('v0.2.0-stg.000042', '0.3.0')).toThrow(/has no production tag/);
    expect(() => checkNewerThanLatest('v0.1.1', '0.2.0-stg.000042')).toThrow(/carries a staging label/);
  });
  it('orders NuGet versions exactly as the application does', () => {
    const versions = ['0.1.1', '0.2.0', '0.10.0', '1.0.0', '1.0.0-alpha1', '1.0.0-alpha2', '1.0.0-alpha10', '1.0.0-ALPHA2', '1.0.0-alpha.1', '1.0.0-alpha.10',
      '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-1', '1.0.0-01', '0.2.0-stg000041', '0.2.0-stg000042', '00.2.0', '999999999.0.0'];
    for (const a of versions) for (const b of versions) expect(Math.sign(compareNugetVersions(a, b)), `${a} vs ${b}`).toBe(Math.sign(appCompareNugetVersions(a, b)));
    expect(() => compareNugetVersions('0.2', '0.2.0')).toThrow('Not a NuGet version');
  });
});

describe('malformed manifests and signatures', () => {
  // One corpus through both the release scripts' parser and signature check and the application's: they must agree on
  // every input, so the workflow never accepts what an installed build refuses, nor the reverse.
  const pkg = {bytes: Buffer.alloc(64, 1), sha256: sha('sha256', Buffer.alloc(64, 1)), sha1: sha('sha1', Buffer.alloc(64, 1))};
  interface ManifestFixture {package: Record<string, unknown>; [key: string]: unknown}
  const base = (): ManifestFixture => ({format: 'ets2telemetry.update-manifest.v1', channel: 'production', appVersion: '0.2.0', nugetVersion: '0.2.0',
    package: {tag: 'v0.2.0', name: 'ETS2TelemetryDesktop-0.2.0-full.nupkg', size: 64, sha256: pkg.sha256, sha1: pkg.sha1}, publishedUtc: '2026-10-28T12:00:00Z', keyId: 'production-0123456789abcdef'});
  const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const changed = (change: (manifest: ManifestFixture) => void) => {const manifest = base(); change(manifest); return json(manifest);};
  const manifests: [string, Buffer][] = [
    ['valid', json(base())],
    ['valid staging', changed(m => {Object.assign(m, {channel: 'staging', appVersion: '0.2.0-stg.000042', nugetVersion: '0.2.0-stg000042'}); m.package.tag = 'staging-v0.2.0-stg.000042';})],
    ['empty', Buffer.alloc(0)], ['null', Buffer.from('null')], ['array', Buffer.from('[]')], ['string', Buffer.from('"x"')], ['empty object', Buffer.from('{}')],
    ['extra key', changed(m => {m.extra = 1;})], ['__proto__ key', Buffer.from(json(base()).toString().replace('{', '{"__proto__": {},'))],
    ['missing keyId', changed(m => {delete m.keyId;})], ['wrong format', changed(m => {m.format = 'ets2telemetry.update-manifest.v2';})],
    ['channel case', changed(m => {m.channel = 'Production';})], ['short version', changed(m => {m.appVersion = '0.2'; m.nugetVersion = '0.2';})],
    ['nuget keeps dots', changed(m => {m.appVersion = '0.2.0-stg.000042'; m.nugetVersion = '0.2.0-stg.000042';})],
    ['space in time', changed(m => {m.publishedUtc = '2026-10-28 12:00:00Z';})], ['impossible date', changed(m => {m.publishedUtc = '2026-13-40T12:00:00Z';})],
    ['four-digit milliseconds', changed(m => {m.publishedUtc = '2026-10-28T12:00:00.1234Z';})], ['keyId space', changed(m => {m.keyId = 'a b';})],
    ['keyId 65', changed(m => {m.keyId = 'k'.repeat(65);})], ['package extra', changed(m => {m.package.url = 'https://example.invalid';})],
    ['size 0', changed(m => {m.package.size = 0;})], ['size fraction', changed(m => {m.package.size = 1.5;})], ['size string', changed(m => {m.package.size = '64';})],
    ['size over 400 MiB', changed(m => {m.package.size = 400 * 1024 * 1024 + 1;})], ['sha256 upper case', changed(m => {m.package.sha256 = pkg.sha256.toUpperCase();})],
    ['sha1 short', changed(m => {m.package.sha1 = pkg.sha1.slice(1);})], ['tag 81', changed(m => {m.package.tag = `v${'1'.repeat(80)}`;})],
    ['name 161', changed(m => {m.package.name = 'n'.repeat(161);})], ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(base())])],
    ['over 16 KiB', Buffer.concat([json(base()), Buffer.alloc(16 * 1024, 0x20)])]
  ];
  it('parses every manifest of the corpus as the application does', () => {
    for (const [name, bytes] of manifests) expect(parseManifestBytes(bytes), name).toEqual(parseUpdateManifest(bytes));
    expect(parseManifestBytes(manifests[0][1])).toBeDefined();
    expect(parseManifestBytes(manifests[1][1])).toBeDefined();
  });
  it('checks every signature of the corpus as the application does', () => {
    const {privateKey} = generateKeyPairSync('ed25519');
    const publicKey = Buffer.from(privateKey.export({format: 'jwk'}).x as string, 'base64url').toString('base64');
    const bytes = manifests[0][1];
    const signed = (text: string) => Buffer.from(text, 'latin1');
    const good = cryptoSign(null, bytes, privateKey).toString('base64');
    const other = Buffer.from(cryptoSign(null, manifests[1][1], privateKey).toString('base64'));
    const signatures: [string, Buffer][] = [
      ['valid', signed(good)], ['line break', signed(`${good}\n`)], ['CRLF', signed(`${good}\r\n`)], ['two line breaks', signed(`${good}\n\n`)], ['leading space', signed(` ${good}`)],
      ['one padding', signed(good.slice(0, -1))], ['87 characters', signed(`A${good}`)], ['base64url', signed(good.replace(/\+/g, '-').replace(/\//g, '_'))],
      ['non-ASCII', Buffer.concat([Buffer.from(good.slice(0, -2)), Buffer.from([0xc3, 0xa9])])], ['empty', Buffer.alloc(0)],
      ['of another manifest', other], ['over 16 KiB', Buffer.alloc(16 * 1024 + 1, 0x41)]
    ];
    for (const [manifestName, manifestBytes] of manifests) {
      for (const [signatureName, signatureBytes] of signatures) {
        for (const key of [publicKey, publicKey.slice(0, -2), `${publicKey.slice(0, -1)}A`]) {
          expect(verifySignatureBytes(manifestBytes, signatureBytes, key), `${manifestName} / ${signatureName}`)
            .toBe(verifyManifestSignature(manifestBytes, signatureBytes, key));
        }
      }
    }
    expect(verifySignatureBytes(bytes, signed(`${good}\n`), publicKey)).toBe(true);
    expect(verifySignatureBytes(bytes, signed(`${good}\n\n`), publicKey)).toBe(false);
  });
});
