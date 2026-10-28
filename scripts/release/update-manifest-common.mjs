import {createHash, createPublicKey, verify} from 'node:crypto';
import {closeSync, existsSync, openSync, readSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Shared rules of the release scripts (ET-055 PR-9, decisions UP4 and UP5; docs/release.md, "Release workflow"). The
// application verifies a manifest in apps/desktop/src/updater/update-manifest.ts. These scripts run under plain Node in the
// release workflow, without npm ci or the TypeScript build, so the few rules they need are restated here.
// tests/unit/release-scripts.test.ts proves that every manifest they write and sign is accepted by the application's own
// verifier, and that this module's parser, signature check and version conversion agree with the application's.
//
// The compiled public keys are read from a copy of apps/desktop/src/updater/update-keys.ts taken at the released CI run's
// commit (`git show <commit>:<path>` in the release workflow), through Node's type stripping (that file holds only
// erasable type syntax). The workflow therefore checks a signature against exactly the keys the released build compiled,
// never the keys of the dispatch checkout. No private key is ever read here.

export const MANIFEST_FORMAT = 'ets2telemetry.update-manifest.v1';
export const MANIFEST_FILE = 'update-manifest.json';
export const SIGNATURE_FILE = 'update-manifest.json.sig';
/** The manifest and its signature are each at most 16 KiB, as the application reads them. */
export const MANIFEST_MAX_BYTES = 16 * 1024;
/** The largest package the application downloads. */
export const PACKAGE_MAX_BYTES = 400 * 1024 * 1024;
export const RELEASE_CHANNELS = Object.freeze(['production', 'staging']);
/** The checkout these scripts belong to. */
export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const UPDATE_KEYS_MODULE = 'apps/desktop/src/updater/update-keys.ts';

export const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const APP_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
const NUGET_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,60})?$/;
/** A staging application version (UP15): `x.y.z-stg.<6-digit staging run number>`. */
export const STAGING_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}-stg\.\d{6}$/;
/** The staging version of a local build (UP15); never released, because every such build carries the same version. */
export const LOCAL_STAGING_SUFFIX = '-stg.000000';
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const isReleaseChannel = value => RELEASE_CHANNELS.includes(value);

/** electron-winstaller's convertVersion: NuGet takes the prerelease label without dots and drops build metadata. */
export function nugetVersionOf(appVersion) {
  const [main, ...prerelease] = appVersion.split('+')[0].split('-');
  return prerelease.length ? `${main}-${prerelease.join('-').replace(/\./g, '')}` : main;
}
/** The release tag of `appVersion` in `channel` (UP4). */
export const releaseTag = (channel, appVersion) => channel === 'staging' ? `staging-v${appVersion}` : `v${appVersion}`;
/** The release title (owner decision of October 28, 2026). */
export const releaseTitle = (channel, appVersion) =>
  channel === 'staging' ? `Staging ${appVersion} – unsigned, for testing` : `Yukon Union Telemetry ${appVersion} – unsigned internal alpha`;

/**
 * Why `appVersion` cannot be released in `channel`, or undefined. Production takes a release version without a staging
 * label; staging takes `x.y.z-stg.<6 digits>` with a real staging run number, never the local `-stg.000000`.
 */
export function releaseVersionProblem(channel, appVersion) {
  if (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion)) return 'is not an application version';
  if (channel === 'production') return /-stg/i.test(appVersion) ? 'carries a staging label' : undefined;
  if (!STAGING_VERSION.test(appVersion)) return 'is not a staging version x.y.z-stg.<6 digits>';
  if (appVersion.endsWith(LOCAL_STAGING_SUFFIX)) return 'carries the local staging run number 000000';
  return undefined;
}

export const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
/** Size, SHA-256 and SHA-1 of a file, read in 1 MiB blocks. */
export function hashFile(filename) {
  const sha256 = createHash('sha256'), sha1 = createHash('sha1'), block = Buffer.alloc(1024 * 1024), fd = openSync(filename, 'r');
  let size = 0;
  try {
    for (let read; (read = readSync(fd, block, 0, block.length, null)) > 0; size += read) {
      sha256.update(block.subarray(0, read));
      sha1.update(block.subarray(0, read));
    }
  } finally {closeSync(fd);}
  return {size, sha256: sha256.digest('hex'), sha1: sha1.digest('hex')};
}

const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (record, keys) => Object.keys(record).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));

/** The manifest of exactly these bytes in the v1 shape, or undefined; the same rules as the application's parser. */
export function parseManifestBytes(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > MANIFEST_MAX_BYTES) return undefined;
  let value;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return undefined;}
  if (!plainObject(value) || !exactKeys(value, ['format', 'channel', 'appVersion', 'nugetVersion', 'package', 'publishedUtc', 'keyId'])) return undefined;
  const {format, channel, appVersion, nugetVersion, publishedUtc, keyId} = value, pkg = value.package;
  if (format !== MANIFEST_FORMAT || !isReleaseChannel(channel)) return undefined;
  if (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion) || nugetVersion !== nugetVersionOf(appVersion) || !NUGET_VERSION.test(nugetVersion)) return undefined;
  if (typeof publishedUtc !== 'string' || !UTC.test(publishedUtc) || !Number.isFinite(Date.parse(publishedUtc))) return undefined;
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) return undefined;
  if (!plainObject(pkg) || !exactKeys(pkg, ['tag', 'name', 'size', 'sha256', 'sha1'])) return undefined;
  const {tag, name, size, sha256, sha1} = pkg;
  if (typeof tag !== 'string' || tag.length > 80 || typeof name !== 'string' || name.length > 160) return undefined;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > PACKAGE_MAX_BYTES) return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(sha1)) return undefined;
  return {format, channel, appVersion, nugetVersion, package: {tag, name, size, sha256, sha1}, publishedUtc, keyId};
}

/** Whether `value` is the base64 of a raw 32-byte Ed25519 public key, as update-keys.ts holds it. */
export const isRawPublicKey = value => typeof value === 'string' && BASE64_KEY.test(value) && Buffer.from(value, 'base64').length === 32;

/** The raw 32 public key bytes of an Ed25519 KeyObject, public or private. */
export function rawPublicKeyOf(key) {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Not an Ed25519 key');
  const der = publicKey.export({format: 'der', type: 'spki'});
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) throw new Error('Unexpected Ed25519 key encoding');
  return der.subarray(ED25519_SPKI_PREFIX.length);
}
/**
 * The keyId of a key generated by scripts/release/generate-update-key.mjs: the channel and the first 16 hex digits of the
 * SHA-256 of the raw public key. It binds the id to the key, so the signer refuses to sign a manifest that names another key.
 */
export const keyIdOf = (channel, rawPublicKey) => `${channel}-${sha256Hex(rawPublicKey).slice(0, 16)}`;

/** Verifies the base64 Ed25519 signature (an optional final line break allowed) over the exact manifest bytes. */
export function verifySignatureBytes(manifestBytes, signatureBytes, publicKey) {
  if (signatureBytes.byteLength > MANIFEST_MAX_BYTES || !isRawPublicKey(publicKey)) return false;
  let text;
  try {text = new TextDecoder('ascii', {fatal: true}).decode(signatureBytes).replace(/\r?\n$/, '');} catch {return false;}
  if (!BASE64_SIGNATURE.test(text)) return false;
  try {
    const key = createPublicKey({key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki'});
    return verify(null, manifestBytes, key, Buffer.from(text, 'base64'));
  } catch {return false;}
}

/**
 * The compiled public keys of `channel` in the update-keys.ts file `keysFile`, each checked for its shape. The release
 * workflow passes the file of the released commit; without it, this checkout's file is read (tests, local checks).
 */
export async function compiledUpdateKeys(channel, keysFile = path.join(REPOSITORY_ROOT, UPDATE_KEYS_MODULE)) {
  if (!isReleaseChannel(channel)) throw new Error(`Unknown release channel ${JSON.stringify(channel)}`);
  const module = await import(pathToFileURL(path.resolve(keysFile)).href);
  const keys = module.UPDATE_PUBLIC_KEYS?.[channel];
  if (!Array.isArray(keys)) throw new Error(`${UPDATE_KEYS_MODULE} has no key list for ${channel}`);
  for (const key of keys) {
    if (!plainObject(key) || !exactKeys(key, ['keyId', 'publicKey']) || typeof key.keyId !== 'string' || !KEY_ID_PATTERN.test(key.keyId) || !isRawPublicKey(key.publicKey)) {
      throw new Error(`${UPDATE_KEYS_MODULE} holds a malformed ${channel} key`);
    }
  }
  return keys.map(key => ({keyId: key.keyId, publicKey: key.publicKey}));
}

function compareIdentifier(a, b) {
  const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
  if (numericA && numericB) {const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0;}
  if (numericA !== numericB) return numericA ? -1 : 1;
  const lowerA = a.toLowerCase(), lowerB = b.toLowerCase();
  return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
}
const NUGET_PARTS = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,60}))?$/;
/**
 * Compares two NuGet versions by SemVer 2.0 precedence, prerelease labels case-insensitively, exactly as the application's
 * update-version.ts compares them: negative, zero or positive. Throws for a value that is not a NuGet version.
 */
export function compareNugetVersions(a, b) {
  const left = NUGET_PARTS.exec(a), right = NUGET_PARTS.exec(b);
  if (!left || !right) throw new Error('Not a NuGet version');
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  const [preA, preB] = [left[4], right[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split('.'), partsB = preB.split('.');
  for (let index = 0; index < Math.min(partsA.length, partsB.length); index++) {
    const difference = compareIdentifier(partsA[index], partsB[index]);
    if (difference !== 0) return difference;
  }
  return partsA.length - partsB.length;
}

const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (parent, child) => {
  const relative = path.relative(comparable(parent), comparable(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
/**
 * Refuses a private-key path inside this checkout or inside any Git working tree, so a key can never be committed or
 * picked up by a build. The folder must exist; links are resolved before the comparison.
 */
export function assertKeyPathOutsideRepository(target, root = REPOSITORY_ROOT) {
  const absolute = path.resolve(target), folder = path.dirname(absolute);
  if (!existsSync(folder)) throw new Error('The key folder does not exist');
  const real = path.join(realpathSync.native(folder), path.basename(absolute));
  const roots = [path.resolve(root)];
  if (existsSync(root)) roots.push(realpathSync.native(root));
  if (roots.some(repository => inside(repository, absolute) || inside(repository, real))) throw new Error('A private key must be kept outside the repository');
  for (let directory = path.dirname(real); ; directory = path.dirname(directory)) {
    if (existsSync(path.join(directory, '.git'))) throw new Error('A private key must be kept outside every Git working tree');
    if (path.dirname(directory) === directory) break;
  }
  return real;
}
