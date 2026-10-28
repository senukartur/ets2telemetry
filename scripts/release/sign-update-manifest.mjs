import {createPrivateKey, sign} from 'node:crypto';
import {lstatSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {assertKeyPathOutsideRepository, keyIdOf, MANIFEST_MAX_BYTES, parseManifestBytes, rawPublicKeyOf, SIGNATURE_FILE, verifySignatureBytes} from './update-manifest-common.mjs';

// The update manifest signer (ET-055 PR-9, decision UP5; docs/release.md, "Release workflow"). It signs the exact bytes of
// one update-manifest.json with Ed25519 (node:crypto) and writes update-manifest.json.sig beside it: the base64 signature
// and a line break, the format apps/desktop/src/updater/update-manifest.ts accepts.
//
// The private key is an unencrypted PKCS#8 PEM Ed25519 key made by scripts/release/generate-update-key.mjs, given either by
// a path outside every Git working tree (the owner's offline production key) or, in GitHub Actions only and for a staging
// manifest only, by the name of an environment variable that holds it (the release-staging environment's secret). The key
// must be the one the manifest names: its keyId is derived from the public key, so a manifest written for another key is
// refused before anything is signed. The script never prints, logs or writes the key; its errors are fixed texts.

const PEM_MAX_BYTES = 16 * 1024;
const PKCS8_PEM = /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----$/;

/** The Ed25519 private key of PKCS#8 PEM text; a fixed error otherwise, without any part of the text. */
export function privateKeyOf(pem) {
  if (typeof pem !== 'string' || pem.length === 0 || pem.length > PEM_MAX_BYTES || !PKCS8_PEM.test(pem.trim())) {
    throw new Error('The signing key is not an unencrypted PKCS#8 PEM private key');
  }
  let key;
  try {key = createPrivateKey({key: pem, format: 'pem'});} catch {throw new Error('The signing key could not be read as a PKCS#8 PEM private key');}
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The signing key is not an Ed25519 key');
  return key;
}

/**
 * Loads the signing key for a manifest of `channel`: from `keyPath` (outside every Git working tree), or from the
 * environment variable `keyEnv`, which only a staging manifest in GitHub Actions may use. Exactly one of them is given.
 */
export function loadSigningKey({keyPath, keyEnv, channel, env = process.env}) {
  if ((keyPath === undefined) === (keyEnv === undefined)) throw new Error('Give exactly one of --key <path> and --key-env <variable>');
  if (keyEnv !== undefined) {
    if (env.GITHUB_ACTIONS !== 'true' || channel !== 'staging') throw new Error('--key-env signs only a staging manifest in GitHub Actions; production is signed with the owner\'s offline key file');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(keyEnv)) throw new Error('--key-env names an invalid environment variable');
    const pem = env[keyEnv];
    if (typeof pem !== 'string' || pem.length === 0) throw new Error(`The environment variable ${keyEnv} is empty`);
    return privateKeyOf(pem);
  }
  const real = assertKeyPathOutsideRepository(keyPath);
  let stat;
  try {stat = lstatSync(real);} catch {throw new Error('The signing key file does not exist');}
  if (!stat.isFile() || stat.size > PEM_MAX_BYTES) throw new Error('The signing key is not a plain file of at most 16 KiB');
  return privateKeyOf(readFileSync(real, 'utf8'));
}

/**
 * Signs the exact manifest bytes. The bytes must be a v1 manifest whose keyId is this key's keyId for the manifest's
 * channel; the signature is checked against the key's own public half before it is returned. Returns the `.sig` bytes.
 */
export function signManifestBytes(manifestBytes, privateKey) {
  const manifest = parseManifestBytes(manifestBytes);
  if (!manifest) throw new Error('The manifest is not an update manifest v1');
  const raw = rawPublicKeyOf(privateKey), keyId = keyIdOf(manifest.channel, raw);
  if (manifest.keyId !== keyId) throw new Error(`The manifest names key ${manifest.keyId}, but this ${manifest.channel} key is ${keyId}`);
  const signature = Buffer.from(`${sign(null, manifestBytes, privateKey).toString('base64')}\n`, 'ascii');
  if (!verifySignatureBytes(manifestBytes, signature, raw.toString('base64'))) throw new Error('The new signature does not verify');
  return {manifest, signature};
}

const USAGE = 'Usage: node scripts/release/sign-update-manifest.mjs --manifest <update-manifest.json> (--key <private key file> | --key-env <variable>) [--out <file>]';

function main(argv) {
  const {values} = parseArgs({args: argv, strict: true, options: {manifest: {type: 'string'}, key: {type: 'string'}, 'key-env': {type: 'string'}, out: {type: 'string'}}});
  if (!values.manifest) throw new Error(USAGE);
  const manifestFile = path.resolve(values.manifest);
  const stat = lstatSync(manifestFile);
  if (!stat.isFile() || stat.size > MANIFEST_MAX_BYTES) throw new Error('The manifest is not a plain file of at most 16 KiB');
  const bytes = readFileSync(manifestFile);
  const parsed = parseManifestBytes(bytes);
  if (!parsed) throw new Error('The manifest is not an update manifest v1');
  const key = loadSigningKey({keyPath: values.key, keyEnv: values['key-env'], channel: parsed.channel});
  const {manifest, signature} = signManifestBytes(bytes, key);
  const out = path.resolve(values.out ?? path.join(path.dirname(manifestFile), SIGNATURE_FILE));
  writeFileSync(out, signature, {flag: 'wx'});
  // What was signed, for the owner to compare with the release before publishing; never the key.
  console.log(JSON.stringify({signed: path.basename(manifestFile), signature: path.basename(out), channel: manifest.channel, appVersion: manifest.appVersion,
    tag: manifest.package.tag, package: manifest.package.name, size: manifest.package.size, sha256: manifest.package.sha256, keyId: manifest.keyId}, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
