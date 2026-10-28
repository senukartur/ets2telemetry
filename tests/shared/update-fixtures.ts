import {createHash, generateKeyPairSync, sign, type KeyObject} from 'node:crypto';
import {CHANNEL_IDENTITIES, type ReleaseChannel} from '../../apps/desktop/src/channel';
import type {FetchPort, FetchResponse} from '../../apps/desktop/src/updater/update-feed';
import type {UpdatePublicKey} from '../../apps/desktop/src/updater/update-keys';
import {nugetVersionOf, releaseTag} from '../../apps/desktop/src/updater/update-version';

// ET-055 update fixtures: Ed25519 keys generated inside the test run (never a committed private key), signed manifests
// in the v1 shape, synthetic package bytes and a fetch port that serves fixed URLs. No test reaches the network.

export interface TestKey {readonly keyId: string; readonly privateKey: KeyObject; readonly publicKey: UpdatePublicKey}
export function testKey(keyId = 'test-2026'): TestKey {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  // The SPKI DER of an Ed25519 key is a 12-byte prefix followed by the 32 raw key bytes.
  const raw = publicKey.export({format: 'der', type: 'spki'}).subarray(12);
  return {keyId, privateKey, publicKey: {keyId, publicKey: raw.toString('base64')}};
}

export interface PackageFixture {readonly bytes: Buffer; readonly sha256: string; readonly sha1: string}
export function packageBytes(size = 200_000, seed = 7): PackageFixture {
  const bytes = Buffer.alloc(size);
  for (let index = 0, value = seed; index < size; index++) {value = (value * 1103515245 + 12345) >>> 0; bytes[index] = value >>> 24;}
  return {bytes, sha256: createHash('sha256').update(bytes).digest('hex'), sha1: createHash('sha1').update(bytes).digest('hex')};
}

/** A manifest object for `appVersion` in `channel`, bound to its tag and nupkg name; `overrides` replace any field. */
export function manifestObject(channel: ReleaseChannel, appVersion: string, pkg: PackageFixture, keyId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nugetVersion = nugetVersionOf(appVersion);
  return {format: 'ets2telemetry.update-manifest.v1', channel, appVersion, nugetVersion,
    package: {tag: releaseTag(channel, appVersion), name: `${CHANNEL_IDENTITIES[channel].squirrelId}-${nugetVersion}-full.nupkg`, size: pkg.bytes.length, sha256: pkg.sha256, sha1: pkg.sha1},
    publishedUtc: '2026-10-28T12:00:00Z', keyId, ...overrides};
}
export interface SignedManifest {readonly bytes: Buffer; readonly signature: Buffer}
/** The manifest's exact bytes and the base64 signature file over them, as the release workflow writes them. */
export function signManifest(manifest: unknown, key: TestKey, options: {newline?: boolean} = {}): SignedManifest {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const signature = sign(null, bytes, key.privateKey).toString('base64');
  return {bytes, signature: Buffer.from(signature + (options.newline ? '\n' : ''), 'ascii')};
}

/** A body stream that yields `bytes` in chunks of `chunk` bytes, then ends unless `hangAfter` chunks were sent. */
export function chunkedBody(bytes: Uint8Array, chunk = 16_384, hangAfter?: number): ReadableStream<Uint8Array> {
  let offset = 0, sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (hangAfter !== undefined && sent >= hangAfter) return new Promise<void>(() => undefined);
      if (offset >= bytes.length) {controller.close(); return;}
      controller.enqueue(bytes.slice(offset, offset + chunk)); offset += chunk; sent++;
    }
  });
}
const bodyOf = (value: Uint8Array | string): ReadableStream<Uint8Array> => chunkedBody(typeof value === 'string' ? Buffer.from(value, 'utf8') : value);

export type Route = {status?: number; body?: Uint8Array | string; stream?: () => ReadableStream<Uint8Array>} | 'network-error' | 'hang';
/** A fetch port serving `routes` by exact URL; every request is recorded, and an unknown URL answers 404. */
export function routedFetch(routes: Record<string, Route>): FetchPort & {readonly requests: {url: string; kind: string}[]} {
  const requests: {url: string; kind: string}[] = [];
  const port = (url: string, init: {signal: AbortSignal; kind: 'json' | 'binary'}): Promise<FetchResponse> => {
    requests.push({url, kind: init.kind});
    const route = routes[url];
    if (route === undefined) return Promise.resolve({status: 404, body: bodyOf('Not Found')});
    if (route === 'network-error') return Promise.reject(new TypeError('fetch failed'));
    if (route === 'hang') return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
    return Promise.resolve({status: route.status ?? 200, body: route.stream ? route.stream() : route.body === undefined ? null : bodyOf(route.body)});
  };
  return Object.assign(port, {requests});
}

export const GITHUB = 'https://github.com/senukartur/ets2telemetry';
export const API_LIST = 'https://api.github.com/repos/senukartur/ets2telemetry/releases?per_page=30';
/** One REST release-list entry with the fields the updater reads. */
export function listedRelease(tag: string, options: {prerelease?: boolean; draft?: boolean; assets?: string[]} = {}): Record<string, unknown> {
  return {tag_name: tag, prerelease: options.prerelease ?? true, draft: options.draft ?? false, name: `Staging ${tag}`,
    assets: (options.assets ?? ['update-manifest.json', 'update-manifest.json.sig']).map(name => ({name, browser_download_url: `${GITHUB}/releases/download/${tag}/${name}`}))};
}
