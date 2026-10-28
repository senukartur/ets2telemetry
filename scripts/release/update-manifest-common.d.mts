import type {KeyObject} from 'node:crypto';

export type ReleaseChannel = 'production' | 'staging';
export interface UpdateManifestV1 {
  format: 'ets2telemetry.update-manifest.v1';
  channel: ReleaseChannel;
  appVersion: string;
  nugetVersion: string;
  package: {tag: string; name: string; size: number; sha256: string; sha1: string};
  publishedUtc: string;
  keyId: string;
}
export interface CompiledUpdateKey {keyId: string; publicKey: string}

export const MANIFEST_FORMAT: 'ets2telemetry.update-manifest.v1';
export const MANIFEST_FILE: 'update-manifest.json';
export const SIGNATURE_FILE: 'update-manifest.json.sig';
export const MANIFEST_MAX_BYTES: number;
export const PACKAGE_MAX_BYTES: number;
export const RELEASE_CHANNELS: readonly ReleaseChannel[];
export const REPOSITORY_ROOT: string;
export const UPDATE_KEYS_MODULE: string;
export const KEY_ID_PATTERN: RegExp;
export const STAGING_VERSION: RegExp;
export const LOCAL_STAGING_SUFFIX: '-stg.000000';
export function isReleaseChannel(value: unknown): value is ReleaseChannel;
export function nugetVersionOf(appVersion: string): string;
export function releaseTag(channel: ReleaseChannel, appVersion: string): string;
export function releaseTitle(channel: ReleaseChannel, appVersion: string): string;
export function releaseVersionProblem(channel: ReleaseChannel, appVersion: unknown): string | undefined;
export function sha256Hex(bytes: Uint8Array | string): string;
export function hashFile(filename: string): {size: number; sha256: string; sha1: string};
export function parseManifestBytes(bytes: Uint8Array): UpdateManifestV1 | undefined;
export function isRawPublicKey(value: unknown): value is string;
export function rawPublicKeyOf(key: KeyObject): Buffer;
export function keyIdOf(channel: ReleaseChannel, rawPublicKey: Uint8Array): string;
export function verifySignatureBytes(manifestBytes: Uint8Array, signatureBytes: Uint8Array, publicKey: string): boolean;
export function compiledUpdateKeys(channel: ReleaseChannel, keysFile?: string): Promise<CompiledUpdateKey[]>;
export function compareNugetVersions(a: string, b: string): number;
export function assertKeyPathOutsideRepository(target: string, root?: string): string;
