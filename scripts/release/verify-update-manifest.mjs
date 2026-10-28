import {lstatSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {compiledUpdateKeys, MANIFEST_MAX_BYTES, parseManifestBytes, verifySignatureBytes} from './update-manifest-common.mjs';
import {verifyReleaseArtifacts} from './write-update-manifest.mjs';

// The release workflow's check of a signed manifest before publication (ET-055 PR-9, decisions UP4, UP5 and UP16;
// docs/release.md, "Release workflow"). The signature must verify against a public key compiled into
// apps/desktop/src/updater/update-keys.ts for the channel, chosen by the manifest's keyId, exactly as an installed build of
// this commit verifies it; and the manifest must name the verified artifacts of the same CI run: the channel, both versions,
// the tag and the nupkg's exact name, size, SHA-256 and SHA-1. Any difference fails, so a manifest signed for other bytes, a
// wrong channel or another release is never published.

const refuse = message => {throw new Error(`Signed manifest refused: ${message}`);};

/** Checks the signed manifest bytes against `keys` and the artifact `facts`; returns the manifest. */
export function verifySignedManifest({manifestBytes, signatureBytes, facts, keys}) {
  const manifest = parseManifestBytes(manifestBytes);
  if (!manifest) refuse('not an update manifest v1');
  const key = keys.find(entry => entry.keyId === manifest.keyId);
  if (!key) refuse(`keyId ${manifest.keyId} is not a compiled ${facts.channel} key`);
  if (!verifySignatureBytes(manifestBytes, signatureBytes, key.publicKey)) refuse('the signature does not verify');
  const expected = {channel: facts.channel, appVersion: facts.appVersion, nugetVersion: facts.nugetVersion,
    package: {tag: facts.tag, name: facts.nupkg.name, size: facts.nupkg.size, sha256: facts.nupkg.sha256, sha1: facts.nupkg.sha1}};
  for (const field of ['channel', 'appVersion', 'nugetVersion']) if (manifest[field] !== expected[field]) refuse(`${field} differs from the artifact`);
  for (const field of ['tag', 'name', 'size', 'sha256', 'sha1']) if (manifest.package[field] !== expected.package[field]) refuse(`package.${field} differs from the artifact`);
  return manifest;
}

const readBounded = (file, what) => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) refuse(`${what} is not a plain file of at most 16 KiB`);
  return readFileSync(file);
};

const USAGE = 'Usage: node scripts/release/verify-update-manifest.mjs --manifest <file> --signature <file> --artifacts <folder> --channel <production|staging> --run-id <id> [--commit <sha>]';

async function main(argv) {
  const {values} = parseArgs({args: argv, strict: true, options: {manifest: {type: 'string'}, signature: {type: 'string'}, artifacts: {type: 'string'},
    channel: {type: 'string'}, 'run-id': {type: 'string'}, commit: {type: 'string'}}});
  if (!values.manifest || !values.signature || !values.artifacts || !values.channel || !values['run-id']) throw new Error(USAGE);
  const facts = verifyReleaseArtifacts(path.resolve(values.artifacts), {channel: values.channel, runId: values['run-id'], commit: values.commit});
  const manifest = verifySignedManifest({manifestBytes: readBounded(path.resolve(values.manifest), 'The manifest'),
    signatureBytes: readBounded(path.resolve(values.signature), 'The signature'), facts, keys: await compiledUpdateKeys(facts.channel)});
  console.log(JSON.stringify({verified: true, channel: manifest.channel, appVersion: manifest.appVersion, tag: manifest.package.tag, keyId: manifest.keyId}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;});
}
