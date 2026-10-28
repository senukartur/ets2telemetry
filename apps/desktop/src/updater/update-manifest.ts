import {createPublicKey, verify} from 'node:crypto';
import type {ChannelIdentity, ReleaseChannel} from '../channel';
import type {UpdatePublicKey} from './update-keys';
import {isAppVersion} from './update-view';
import {compareNugetVersions, isChannelTag, isNugetVersion, nugetVersionOf, releaseTag} from './update-version';

// The signed update manifest, format v1 (ET-055 UP4, UP5; docs/release.md, "Update manifest"). A release carries
// `update-manifest.json` and `update-manifest.json.sig`: the signature is Ed25519 over the exact manifest bytes, base64
// in the `.sig` file. The manifest is trusted only after that signature verified against a compiled key of this build's
// channel; then its channel, tag, package name and version must bind to this build and the release it came from. The
// package URL is never taken from the manifest: the feed rebuilds it from the verified tag and name, and the download's
// integrity comes from the size and both hashes here.

export const MANIFEST_FORMAT = 'ets2telemetry.update-manifest.v1';
export const MANIFEST_FILE = 'update-manifest.json';
export const SIGNATURE_FILE = 'update-manifest.json.sig';
/** The manifest and its signature are each at most 16 KiB (UP4). */
export const MANIFEST_MAX_BYTES = 16 * 1024;
/** The largest package the updater downloads (UP3). */
export const PACKAGE_MAX_BYTES = 400 * 1024 * 1024;

export interface UpdateManifest {
  readonly format: typeof MANIFEST_FORMAT;
  readonly channel: ReleaseChannel;
  readonly appVersion: string;
  readonly nugetVersion: string;
  readonly package: {readonly tag: string; readonly name: string; readonly size: number; readonly sha256: string; readonly sha1: string};
  readonly publishedUtc: string;
  readonly keyId: string;
}

/**
 * Why a manifest is not offered. `MANIFEST_MALFORMED`: not exactly the v1 shape. `SIGNATURE_INVALID`: no compiled key of
 * this channel has its keyId, or the signature does not verify (with no compiled key, every manifest). The binding codes
 * follow a verified signature; `NOT_NEWER` (the same version) and `DOWNGRADE` mean there is nothing to install.
 */
export type ManifestRefusal = 'MANIFEST_MALFORMED' | 'SIGNATURE_INVALID' | 'CHANNEL_MISMATCH' | 'TAG_MISMATCH' | 'NAME_MISMATCH' | 'NOT_NEWER' | 'DOWNGRADE';

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(record).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** The manifest of exactly these bytes in the v1 shape, or undefined. Nothing in it is trusted before the signature. */
export function parseUpdateManifest(bytes: Uint8Array): UpdateManifest | undefined {
  if (bytes.byteLength === 0 || bytes.byteLength > MANIFEST_MAX_BYTES) return undefined;
  let value: unknown;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return undefined;}
  if (!plainObject(value) || !exactKeys(value, ['format', 'channel', 'appVersion', 'nugetVersion', 'package', 'publishedUtc', 'keyId'])) return undefined;
  const {format, channel, appVersion, nugetVersion, publishedUtc, keyId} = value, pkg = value.package;
  if (format !== MANIFEST_FORMAT || (channel !== 'production' && channel !== 'staging')) return undefined;
  if (!isAppVersion(appVersion) || typeof nugetVersion !== 'string' || nugetVersion !== nugetVersionOf(appVersion) || !isNugetVersion(nugetVersion)) return undefined;
  if (typeof publishedUtc !== 'string' || !UTC.test(publishedUtc) || !Number.isFinite(Date.parse(publishedUtc))) return undefined;
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) return undefined;
  if (!plainObject(pkg) || !exactKeys(pkg, ['tag', 'name', 'size', 'sha256', 'sha1'])) return undefined;
  const {tag, name, size, sha256, sha1} = pkg;
  if (typeof tag !== 'string' || tag.length > 80 || typeof name !== 'string' || name.length > 160) return undefined;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > PACKAGE_MAX_BYTES) return undefined;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof sha1 !== 'string' || !/^[0-9a-f]{40}$/.test(sha1)) return undefined;
  return {format, channel, appVersion, nugetVersion, package: {tag, name, size, sha256, sha1}, publishedUtc, keyId};
}

/** The DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=$/;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;

/** Whether `value` is the base64 of a raw 32-byte Ed25519 public key, as UpdatePublicKey.publicKey holds it. */
export const isRawPublicKey = (value: unknown): value is string => typeof value === 'string' && BASE64_KEY.test(value) && Buffer.from(value, 'base64').length === 32;

/** Verifies the base64 Ed25519 signature (an optional final line break allowed) over the exact manifest bytes. */
export function verifyManifestSignature(manifestBytes: Uint8Array, signatureBytes: Uint8Array, publicKey: string): boolean {
  if (signatureBytes.byteLength > MANIFEST_MAX_BYTES || !isRawPublicKey(publicKey)) return false;
  let text: string;
  try {text = new TextDecoder('ascii', {fatal: true}).decode(signatureBytes).replace(/\r?\n$/, '');} catch {return false;}
  if (!BASE64_SIGNATURE.test(text)) return false;
  try {
    const key = createPublicKey({key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey, 'base64')]), format: 'der', type: 'spki'});
    return verify(null, manifestBytes, key, Buffer.from(text, 'base64'));
  } catch {return false;}
}

export interface ManifestBinding {
  /** This build's channel identity: the manifest's channel and the nupkg name must be its own. */
  readonly identity: ChannelIdentity;
  /** The compiled (or, in the test-root mode only, the test) public keys of this channel. */
  readonly keys: readonly UpdatePublicKey[];
  /** This build's application version. */
  readonly currentVersion: string;
  /**
   * The release tag the manifest was fetched from: the staging release chosen from the list. Production reads
   * `releases/latest`, whose tag the redirect does not reveal, so its expected tag is `v<appVersion>` of the manifest.
   */
  readonly sourceTag?: string;
}

export type ManifestResult = {readonly ok: true; readonly manifest: UpdateManifest} | {readonly ok: false; readonly code: ManifestRefusal};

/** The manifest of these bytes once it is signed and bound to this build and its source release; see ManifestRefusal. */
export function verifyUpdateManifest(manifestBytes: Uint8Array, signatureBytes: Uint8Array, binding: ManifestBinding): ManifestResult {
  const manifest = parseUpdateManifest(manifestBytes);
  if (!manifest) return {ok: false, code: 'MANIFEST_MALFORMED'};
  const key = binding.keys.find(entry => entry.keyId === manifest.keyId);
  if (!key || !verifyManifestSignature(manifestBytes, signatureBytes, key.publicKey)) return {ok: false, code: 'SIGNATURE_INVALID'};
  const channel = binding.identity.channel;
  if (manifest.channel !== channel) return {ok: false, code: 'CHANNEL_MISMATCH'};
  const tag = manifest.package.tag;
  if (!isChannelTag(channel, tag) || tag !== releaseTag(channel, manifest.appVersion) || (binding.sourceTag !== undefined && tag !== binding.sourceTag)) return {ok: false, code: 'TAG_MISMATCH'};
  // Exact equality: the staging Squirrel id starts with the production id, so a prefix test would accept the other channel.
  if (manifest.package.name !== `${binding.identity.squirrelId}-${manifest.nugetVersion}-full.nupkg`) return {ok: false, code: 'NAME_MISMATCH'};
  const order = compareNugetVersions(manifest.nugetVersion, nugetVersionOf(binding.currentVersion));
  if (order === 0) return {ok: false, code: 'NOT_NEWER'};
  if (order < 0) return {ok: false, code: 'DOWNGRADE'};
  return {ok: true, manifest};
}
