import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {assertKeyPathOutsideRepository, isReleaseChannel, keyIdOf, rawPublicKeyOf} from './update-manifest-common.mjs';

// The update key generator (ET-055 PR-9, decision UP5; docs/release.md, release checklist step 0). The owner runs it once
// per channel, offline for production: it makes an Ed25519 key pair, writes the private key as unencrypted PKCS#8 PEM to
// a new file at a path the owner chooses outside every Git working tree (it never overwrites a file), and prints only the
// public half as the `{keyId, publicKey}` entry that apps/desktop/src/updater/update-keys.ts lists for that channel. The
// keyId is `<channel>-<16 hex digits of the SHA-256 of the public key>`, so the signer can tell which key a manifest names.
// Agents never run it for a real key; tests run it only into temporary folders.

/** A new key pair of `channel`: the PKCS#8 PEM private key and the public entry of update-keys.ts. */
export function generateUpdateKey(channel) {
  if (!isReleaseChannel(channel)) throw new Error('--channel must be production or staging');
  const {privateKey} = generateKeyPairSync('ed25519');
  const raw = rawPublicKeyOf(privateKey);
  return {privatePem: privateKey.export({format: 'pem', type: 'pkcs8'}).toString(), keyId: keyIdOf(channel, raw), publicKey: raw.toString('base64')};
}

/** The entry exactly as update-keys.ts lists it. */
export const updateKeyEntry = ({keyId, publicKey}) => `{keyId: '${keyId}', publicKey: '${publicKey}'}`;

/** Generates a key of `channel` and writes its private key to the new file `out`, outside every Git working tree. */
export function writeUpdateKey(channel, out) {
  const target = assertKeyPathOutsideRepository(out);
  const key = generateUpdateKey(channel);
  writeFileSync(target, key.privatePem, {flag: 'wx', mode: 0o600});
  return {keyId: key.keyId, publicKey: key.publicKey};
}

const USAGE = 'Usage: node scripts/release/generate-update-key.mjs --channel <production|staging> --out <new private key file outside the repository>';

function main(argv) {
  const {values} = parseArgs({args: argv, strict: true, options: {channel: {type: 'string'}, out: {type: 'string'}}});
  if (!values.channel || !values.out) throw new Error(USAGE);
  console.log(updateKeyEntry(writeUpdateKey(values.channel, values.out)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {main(process.argv.slice(2));} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
}
