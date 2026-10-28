import {createHash, randomBytes} from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES, type ReleaseChannel} from '../../apps/desktop/src/channel';
import {TEST_KEY_ID} from '../../apps/desktop/src/updater/update-context';
import {downloadPackage} from '../../apps/desktop/src/updater/update-download';
import {checkFeed, manifestUrls, packageUrl, releaseListUrl, REPOSITORY} from '../../apps/desktop/src/updater/update-feed';
import {productionUpdatePorts, UPDATE_USER_AGENT} from '../../apps/desktop/src/updater/update-ports';
import {checkFeedRequests, closedLoopbackOrigin, createTestSigningKey, FEED_REPOSITORY, FEED_USER_AGENT, feedRelease, feedRoutes, fixturePackage, startUpdateFeed,
  TEST_KEY_ID as FIXTURE_KEY_ID} from '../../scripts/installer/update-feed-fixture.mjs';
import {temporaryResources} from '../shared/resources';

// ET-055 PR-8 (REG-019): the loopback feed of the hosted update-from-feed lifecycle, checked locally against the product's
// own feed reader, manifest verifier and downloader over a real 127.0.0.1 socket. No installer, Update.exe or Electron
// runs; the package is random bytes in a temporary folder. The key is generated in the test and never written.

const sha = (algorithm: string, bytes: Buffer) => createHash(algorithm).update(bytes).digest('hex');
const timers = {setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)};
// The production port's request shape (fixed User-Agent, no cookies, Accept per kind) over Node's fetch.
const ports = (channel: ReleaseChannel) => productionUpdatePorts({fetch: globalThis.fetch, packaged: false, executable: process.execPath, env: {},
  identity: CHANNEL_IDENTITIES[channel]});

async function fixtureFeed(directory: string, channel: ReleaseChannel, appVersion: string) {
  const bytes = randomBytes(256 * 1024 + 17), identity = CHANNEL_IDENTITIES[channel];
  const feedFolder = path.join(directory, 'feed');
  await mkdir(feedFolder, {recursive: true});
  const name = `${identity.squirrelId}-${appVersion.replace(/^(\d+\.\d+\.\d+)-(.*)$/, (_m, main: string, label: string) => `${main}-${label.replace(/\./g, '')}`)}-full.nupkg`;
  await writeFile(path.join(feedFolder, name), bytes);
  await writeFile(path.join(feedFolder, 'RELEASES'), `\uFEFF${sha('sha1', bytes).toUpperCase()} ${name} ${bytes.length}`);
  const pkg = await fixturePackage(feedFolder);
  const key = createTestSigningKey();
  const release = feedRelease({channel, appVersion, squirrelId: identity.squirrelId, size: pkg.size, sha256: pkg.sha256, sha1: pkg.sha1,
    publishedUtc: '2026-10-28T12:00:00.000Z', key});
  return {bytes, pkg, key, release};
}

it('names the product\'s repository, key id and User-Agent', () => {
  expect(FEED_REPOSITORY).toBe(REPOSITORY);
  expect(FIXTURE_KEY_ID).toBe(TEST_KEY_ID);
  expect(FEED_USER_AGENT).toBe(UPDATE_USER_AGENT);
});

it('serves the paths the product builds for both feeds', () => {
  const origin = 'http://127.0.0.1:4567', origins = {web: origin, api: origin};
  const routes = feedRoutes({tag: 'staging-v0.1.1-stg.000042', name: 'ETS2TelemetryDesktopStaging-0.1.1-stg000042-full.nupkg'});
  expect(`${origin}${routes.manifest}`).toBe(manifestUrls(origins, 'staging-v0.1.1-stg.000042').manifest);
  expect(`${origin}${routes.signature}`).toBe(manifestUrls(origins, 'staging-v0.1.1-stg.000042').signature);
  expect(`${origin}${routes.latestManifest}`).toBe(manifestUrls(origins).manifest);
  expect(`${origin}${routes.latestSignature}`).toBe(manifestUrls(origins).signature);
  expect(`${origin}${routes.list}`).toBe(releaseListUrl(origins));
  expect(`${origin}${routes.package}`).toBe(packageUrl(origins, 'staging-v0.1.1-stg.000042', 'ETS2TelemetryDesktopStaging-0.1.1-stg000042-full.nupkg'));
});

describe.each([['production', '0.1.0', '0.1.1'], ['staging', '0.1.0-stg.000042', '0.1.1-stg.000042']] as const)('the %s feed', (channel, current, offered) => {
  it('offers the signed release to the product\'s check, and the product downloads exactly the package bytes', async () => {
    const resources = await temporaryResources();
    let feed: Awaited<ReturnType<typeof startUpdateFeed>> | undefined;
    try {
      const {bytes, pkg, key, release} = await fixtureFeed(resources.directory, channel, offered);
      const live = await startUpdateFeed({channel, release, packageFile: pkg.file});
      feed = live;
      const origins = {web: live.origin, api: live.origin}, port = ports(channel);
      live.setPhase('offer');
      const result = await checkFeed({fetch: port.fetch, origins, identity: CHANNEL_IDENTITIES[channel], keys: [{keyId: TEST_KEY_ID, publicKey: key.publicKey}],
        currentVersion: current, timers});
      expect(result).toMatchObject({outcome: 'available', packageUrl: `${live.origin}${live.routes.package}`, manifest: {appVersion: offered, channel}});
      if (result.outcome !== 'available') throw new Error('not available');
      // Another key does not verify the same bytes: the generated key is the only one that signs.
      expect(await checkFeed({fetch: port.fetch, origins, identity: CHANNEL_IDENTITIES[channel], keys: [{keyId: TEST_KEY_ID, publicKey: createTestSigningKey().publicKey}],
        currentVersion: current, timers})).toMatchObject({outcome: 'failed', failure: 'SIGNATURE_INVALID'});
      live.setPhase('update');
      const dataRoot = path.join(resources.directory, 'data-root');
      await mkdir(dataRoot);
      const download = await downloadPackage({fetch: port.fetch, fs: fsPromises, timers, dataRoot, manifest: result.manifest,
        packageUrl: result.packageUrl, signal: new AbortController().signal, progress: () => undefined});
      expect(download).toMatchObject({ok: true});
      if (!download.ok) throw new Error('download failed');
      expect(await readFile(path.join(download.folder, release.name))).toEqual(bytes);
      // The first offer check, the refused-key check and the download; production follows the two redirects.
      const failures = checkFeedRequests(live.requests, {channel, routes: live.routes, size: pkg.size, downloadPhase: 'update', before: ['offer']});
      expect(failures).toEqual([]);
      expect(live.requests.every(row => row.userAgent === FEED_USER_AGENT && !row.cookie && !row.authorization)).toBe(true);
      if (channel === 'production') {
        expect(live.requests.filter(row => row.path === live.routes.latestManifest).map(row => row.status)).toEqual([302, 302]);
        expect(live.requests.some(row => row.path === live.routes.list)).toBe(false);
      } else {
        expect(live.requests.filter(row => row.path === live.routes.list).map(row => row.status)).toEqual([200, 200]);
        expect(live.requests.some(row => row.path === live.routes.latestManifest)).toBe(false);
      }
    } finally {
      await feed?.close();
      await resources.dispose();
    }
  }, 30000);
});

it('names what the request check refuses', () => {
  const routes = feedRoutes({tag: 'v0.1.1', name: 'ETS2TelemetryDesktop-0.1.1-full.nupkg'});
  const row = (changes: Record<string, unknown>) => ({phase: 'update', method: 'GET', path: routes.latestManifest, status: 302, userAgent: FEED_USER_AGENT, accept: null,
    cookie: false, authorization: false, bytes: 0, ...changes});
  const good = [row({}), row({path: routes.latestSignature}), row({path: routes.package, status: 200, bytes: 10})];
  const check = (requests: ReturnType<typeof row>[]) => checkFeedRequests(requests, {channel: 'production', routes, size: 10, downloadPhase: 'update', before: ['refusal']});
  expect(check(good)).toEqual([]);
  expect(check([...good, row({path: routes.list})])).toEqual([`UNEXPECTED_PATH ${routes.list}`]);
  expect(check([...good, row({path: routes.package, phase: 'refusal', status: 200, bytes: 10})])).toEqual(['PACKAGE_WITHOUT_CLICK']);
  expect(check([row({userAgent: 'node'}), ...good.slice(1)])).toEqual([`USER_AGENT ${routes.latestManifest}`]);
  expect(check([row({cookie: true}), ...good.slice(1)])).toEqual([`CREDENTIALS ${routes.latestManifest}`]);
  expect(check(good.slice(0, 2))).toEqual(['PACKAGE_DOWNLOADS 0']);
  expect(check([row({path: routes.package, status: 200, bytes: 9})])).toEqual(['PACKAGE_DOWNLOADS 1', `NOT_READ ${routes.latestManifest}`, `NOT_READ ${routes.latestSignature}`]);
});

it('gives a loopback origin where nothing listens', async () => {
  const origin = await closedLoopbackOrigin();
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d{1,5}$/);
  await expect(fetch(`${origin}/`)).rejects.toThrow();
});
