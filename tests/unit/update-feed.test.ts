import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CHANNEL_IDENTITIES, type ReleaseChannel} from '../../apps/desktop/src/channel';
import {checkFeed, FEED_REQUEST_TIMEOUT_MS, GITHUB_ORIGINS, readBounded, RELEASE_LIST_MAX_BYTES, selectStagingRelease, type FeedRequest} from '../../apps/desktop/src/updater/update-feed';
import {API_LIST, GITHUB, listedRelease, manifestObject, packageBytes, routedFetch, signManifest, testKey, type Route} from '../shared/update-fixtures';

// ET-055 UP4 (REG-019, unit part): the two feeds. Every request goes to a routed fake; no test reaches GitHub. The URLs,
// the staging selection and the failure mapping are written by hand from the plan.

const KEY = testKey('feed');
const PKG = packageBytes(4096);
const timers = {setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)};
beforeEach(() => vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']}));
afterEach(() => vi.useRealTimers());
const request = (channel: ReleaseChannel, routes: Record<string, Route>, currentVersion = channel === 'staging' ? '0.2.0-stg.000040' : '0.1.1') => {
  const fetch = routedFetch(routes);
  const input: FeedRequest = {fetch, origins: GITHUB_ORIGINS, identity: CHANNEL_IDENTITIES[channel], keys: [KEY.publicKey], currentVersion, timers};
  return {fetch, input};
};
const signedRoutes = (base: string, manifest: Record<string, unknown>): Record<string, Route> => {
  const signed = signManifest(manifest, KEY);
  return {[`${base}/update-manifest.json`]: {body: signed.bytes}, [`${base}/update-manifest.json.sig`]: {body: signed.signature}};
};
const LATEST = `${GITHUB}/releases/latest/download`;
const tagged = (tag: string) => `${GITHUB}/releases/download/${tag}`;

describe('production', () => {
  it('reads only releases/latest/download, without a query string, and rebuilds the package URL from tag and name', async () => {
    const {fetch, input} = request('production', signedRoutes(LATEST, manifestObject('production', '0.2.0', PKG, KEY.keyId)));
    const result = await checkFeed(input);
    expect(result).toMatchObject({outcome: 'available', packageUrl: `${GITHUB}/releases/download/v0.2.0/ETS2TelemetryDesktop-0.2.0-full.nupkg`, manifest: {appVersion: '0.2.0'}});
    expect(fetch.requests).toEqual([{url: `${LATEST}/update-manifest.json`, kind: 'binary'}, {url: `${LATEST}/update-manifest.json.sig`, kind: 'binary'}]);
    for (const {url} of fetch.requests) expect(url).not.toContain('?');
  });
  it('reports the same version as up to date and a release without a manifest as a silent manifest failure', async () => {
    expect(await checkFeed(request('production', signedRoutes(LATEST, manifestObject('production', '0.1.1', PKG, KEY.keyId))).input)).toEqual({outcome: 'up-to-date', code: 'NOT_NEWER'});
    expect(await checkFeed(request('production', {}).input)).toEqual({outcome: 'failed', failure: 'MANIFEST_INVALID', code: 'MANIFEST_HTTP_STATUS'});
  });
  it('maps 403, 429, a network error and the 10 s limit to a quiet OFFLINE', async () => {
    for (const route of [{status: 403}, {status: 429}, 'network-error'] as Route[]) {
      expect(await checkFeed(request('production', {[`${LATEST}/update-manifest.json`]: route}).input)).toMatchObject({outcome: 'failed', failure: 'OFFLINE'});
    }
    const pending = checkFeed(request('production', {[`${LATEST}/update-manifest.json`]: 'hang'}).input);
    await vi.advanceTimersByTimeAsync(FEED_REQUEST_TIMEOUT_MS - 1);
    let settled = false; void pending.then(() => {settled = true;});
    await Promise.resolve(); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({outcome: 'failed', failure: 'OFFLINE', code: 'MANIFEST_OFFLINE'});
  });
  it('refuses a manifest or signature above 16 KiB and a bad signature', async () => {
    const signed = signManifest(manifestObject('production', '0.2.0', PKG, KEY.keyId), KEY);
    expect(await checkFeed(request('production', {[`${LATEST}/update-manifest.json`]: {body: Buffer.alloc(16 * 1024 + 1, 0x20)}}).input))
      .toEqual({outcome: 'failed', failure: 'MANIFEST_INVALID', code: 'MANIFEST_TOO_LARGE'});
    expect(await checkFeed(request('production', {[`${LATEST}/update-manifest.json`]: {body: signed.bytes}, [`${LATEST}/update-manifest.json.sig`]: {body: Buffer.alloc(16 * 1024 + 1, 0x41)}}).input))
      .toEqual({outcome: 'failed', failure: 'MANIFEST_INVALID', code: 'SIGNATURE_TOO_LARGE'});
    const other = testKey(KEY.keyId);
    expect(await checkFeed(request('production', {[`${LATEST}/update-manifest.json`]: {body: signed.bytes}, [`${LATEST}/update-manifest.json.sig`]: {body: signManifest(manifestObject('production', '0.2.0', PKG, KEY.keyId), other).signature}}).input))
      .toEqual({outcome: 'failed', failure: 'SIGNATURE_INVALID', code: 'SIGNATURE_INVALID'});
  });
});

describe('staging', () => {
  const LIST = [
    listedRelease('staging-v0.2.0-stg.000041'),
    listedRelease('staging-v0.2.0-stg.000044', {draft: true}),
    listedRelease('v0.3.0', {prerelease: false}),
    listedRelease('v0.3.0-stg.000050'),
    listedRelease('staging-v0.2.0-stg.000045', {prerelease: false}),
    listedRelease('staging-v0.2.0-stg.000046', {assets: ['YukonUnionTelemetry-Staging-Setup-0.2.0-stg.000046.exe']}),
    listedRelease('staging-v0.2.0-stg.47'),
    listedRelease('staging-v0.2.0-stg.000043'),
    listedRelease('staging-v0.2.0-stg.000042'),
    'not an object', null, {tag_name: 'staging-v0.2.0-stg.000049', prerelease: true, draft: false}
  ];
  it('picks the highest NuGet version among published staging pre-releases with a manifest, whatever the order', () => {
    for (let rotation = 0; rotation < LIST.length; rotation++) {
      const rotated = [...LIST.slice(rotation), ...LIST.slice(0, rotation)];
      expect(selectStagingRelease(Buffer.from(JSON.stringify(rotated)))).toEqual({tag: 'staging-v0.2.0-stg.000043'});
      expect(selectStagingRelease(Buffer.from(JSON.stringify([...rotated].reverse())))).toEqual({tag: 'staging-v0.2.0-stg.000043'});
    }
    expect(selectStagingRelease(Buffer.from('[]'))).toBeUndefined();
    expect(selectStagingRelease(Buffer.from(JSON.stringify([listedRelease('v0.2.0', {prerelease: false})])))).toBeUndefined();
    expect(selectStagingRelease(Buffer.from('{"message":"Not Found"}'))).toBe('invalid');
    expect(selectStagingRelease(Buffer.from('<html>'))).toBe('invalid');
  });
  it('reads the fixed REST list, then the manifest and signature of the chosen tag', async () => {
    const {fetch, input} = request('staging', {[API_LIST]: {body: JSON.stringify(LIST)},
      ...signedRoutes(tagged('staging-v0.2.0-stg.000043'), manifestObject('staging', '0.2.0-stg.000043', PKG, KEY.keyId))});
    expect(await checkFeed(input)).toMatchObject({outcome: 'available',
      packageUrl: `${GITHUB}/releases/download/staging-v0.2.0-stg.000043/ETS2TelemetryDesktopStaging-0.2.0-stg000043-full.nupkg`});
    expect(fetch.requests).toEqual([{url: API_LIST, kind: 'json'}, {url: `${tagged('staging-v0.2.0-stg.000043')}/update-manifest.json`, kind: 'binary'},
      {url: `${tagged('staging-v0.2.0-stg.000043')}/update-manifest.json.sig`, kind: 'binary'}]);
  });
  it('binds the manifest to the chosen tag', async () => {
    // The release staging-v0.2.0-stg.000043 serves a correctly signed manifest of 000042.
    const {input} = request('staging', {[API_LIST]: {body: JSON.stringify(LIST)},
      ...signedRoutes(tagged('staging-v0.2.0-stg.000043'), manifestObject('staging', '0.2.0-stg.000042', PKG, KEY.keyId))});
    expect(await checkFeed(input)).toEqual({outcome: 'failed', failure: 'MANIFEST_INVALID', code: 'TAG_MISMATCH'});
  });
  it('treats no staging release as up to date and a rate-limited, oversized or unreadable list as a quiet OFFLINE', async () => {
    expect(await checkFeed(request('staging', {[API_LIST]: {body: '[]'}}).input)).toEqual({outcome: 'up-to-date', code: 'NO_RELEASE'});
    for (const route of [{status: 403}, {status: 429}, 'network-error'] as Route[])
      expect(await checkFeed(request('staging', {[API_LIST]: route}).input)).toMatchObject({outcome: 'failed', failure: 'OFFLINE'});
    expect(await checkFeed(request('staging', {[API_LIST]: {status: 500}}).input)).toEqual({outcome: 'failed', failure: 'OFFLINE', code: 'LIST_HTTP_STATUS'});
    expect(await checkFeed(request('staging', {[API_LIST]: {body: Buffer.alloc(RELEASE_LIST_MAX_BYTES + 1, 0x20)}}).input)).toEqual({outcome: 'failed', failure: 'OFFLINE', code: 'LIST_TOO_LARGE'});
    expect(await checkFeed(request('staging', {[API_LIST]: {body: '{"message":"x"}'}}).input)).toEqual({outcome: 'failed', failure: 'OFFLINE', code: 'LIST_INVALID'});
  });
});

describe('bounded reads', () => {
  it('stops reading at the bound and reports an abort of the caller as ABORTED', async () => {
    const fetch = routedFetch({'https://x.invalid/a': {body: Buffer.alloc(100)}, 'https://x.invalid/b': 'hang'});
    expect(await readBounded(fetch, 'https://x.invalid/a', {maxBytes: 99, timeoutMs: 1000, kind: 'binary', timers})).toEqual({ok: false, code: 'TOO_LARGE'});
    expect(await readBounded(fetch, 'https://x.invalid/a', {maxBytes: 100, timeoutMs: 1000, kind: 'binary', timers})).toMatchObject({ok: true});
    const abort = new AbortController();
    const pending = readBounded(fetch, 'https://x.invalid/b', {maxBytes: 100, timeoutMs: 1000, kind: 'binary', timers, signal: abort.signal});
    abort.abort();
    expect(await pending).toEqual({ok: false, code: 'ABORTED'});
    expect(vi.getTimerCount()).toBe(0);
  });
});
