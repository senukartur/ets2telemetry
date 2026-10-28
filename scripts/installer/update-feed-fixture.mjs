import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {open, stat} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {nugetVersion} from '../release-identity.mjs';

// ET-055 PR-8 (REG-019; UP4, UP5, UP19): the loopback update feed of the hosted update-from-feed installer lifecycle
// (docs/installer-testing.md, "Update-from-feed scenario"). It imitates the two GitHub feeds the updater reads
// (apps/desktop/src/updater/update-feed.ts) on one `http://127.0.0.1:<port>` origin, the only origin the test-root mode
// accepts (update-context.ts, ETS2TELEMETRY_UPDATE_TEST_FEED):
//
// | Channel | Served |
// | --- | --- |
// | production | `/<repo>/releases/latest/download/update-manifest.json` and `.sig`, each a 302 to the release's download path, as GitHub redirects |
// | staging | `/repos/<repo>/releases?per_page=30`, a REST list with decoys before the one staging release that matches |
// | both | `/<repo>/releases/download/<tag>/update-manifest.json`, `.sig` and `<Squirrel id>-<NuGet version>-full.nupkg` |
//
// Anything else is a 404, so a production build that read the list or a staging build that read `/latest` fails its
// check. The manifest is signed with an Ed25519 key that createTestSigningKey generates for one run: the private half
// stays inside its closure and is never exported, written or logged; only the public half goes to the application, as
// ETS2TELEMETRY_UPDATE_TEST_PUBLIC_KEY with key id `test`. Every request is recorded without its body: the phase, method,
// path, status, the User-Agent and Accept headers, whether a cookie or an authorization header came, and the bytes sent.

/** apps/desktop/src/updater/update-feed.ts REPOSITORY; tests/unit/update-feed-fixture.test.ts compares the URLs. */
export const FEED_REPOSITORY = 'senukartur/ets2telemetry';
export const MANIFEST_FORMAT = 'ets2telemetry.update-manifest.v1';
export const MANIFEST_FILE = 'update-manifest.json';
export const SIGNATURE_FILE = 'update-manifest.json.sig';
/** update-context.ts TEST_KEY_ID: the only key id the test-root mode verifies with. */
export const TEST_KEY_ID = 'test';
/** update-ports.ts UPDATE_USER_AGENT: the fixed User-Agent of every update request. */
export const FEED_USER_AGENT = 'YukonUnionTelemetry-Updater';
/** The REST list's page size (update-feed.ts RELEASE_LIST_PAGE). */
export const RELEASE_LIST_PAGE = 30;
/** At most this many requests are recorded; later ones are counted only. */
const REQUEST_RECORD_LIMIT = 256;

/** A per-run Ed25519 key: the base64 raw public key and a signer over exact bytes. The private key never leaves here. */
export function createTestSigningKey() {
  const {publicKey, privateKey} = generateKeyPairSync('ed25519');
  const der = publicKey.export({format: 'der', type: 'spki'});
  return Object.freeze({publicKey: Buffer.from(der.subarray(der.length - 32)).toString('base64'), sign: bytes => sign(null, bytes, privateKey).toString('base64')});
}

/** The release tag of `appVersion` in `channel` (update-version.ts releaseTag). */
export const releaseTagOf = (channel, appVersion) => channel === 'staging' ? `staging-v${appVersion}` : `v${appVersion}`;

/**
 * The release one fixture package becomes: its signed v1 manifest (exact bytes), the tag and the package name. `channel`,
 * `appVersion` and `squirrelId` are the build's; `size`, `sha256` and `sha1` the package's.
 */
export function feedRelease({channel, appVersion, squirrelId, size, sha256, sha1, publishedUtc, key}) {
  assert.ok(channel === 'production' || channel === 'staging', 'FEED_CHANNEL_INVALID');
  assert.ok(Number.isSafeInteger(size) && size > 0 && /^[0-9a-f]{64}$/.test(sha256) && /^[0-9a-f]{40}$/.test(sha1), 'FEED_PACKAGE_INVALID');
  const nuget = nugetVersion(appVersion), tag = releaseTagOf(channel, appVersion), name = `${squirrelId}-${nuget}-full.nupkg`;
  const manifest = {format: MANIFEST_FORMAT, channel, appVersion, nugetVersion: nuget, package: {tag, name, size, sha256, sha1}, publishedUtc, keyId: TEST_KEY_ID};
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return {manifest, bytes, signature: Buffer.from(`${key.sign(bytes)}\n`, 'ascii'), tag, name};
}

/** The feed's paths for one release (update-feed.ts manifestUrls, releaseListUrl, packageUrl without the origin). */
export function feedRoutes({tag, name}) {
  const releases = `/${FEED_REPOSITORY}/releases`, download = `${releases}/download/${encodeURIComponent(tag)}`;
  return {manifest: `${download}/${MANIFEST_FILE}`, signature: `${download}/${SIGNATURE_FILE}`, package: `${download}/${encodeURIComponent(name)}`,
    latestManifest: `${releases}/latest/download/${MANIFEST_FILE}`, latestSignature: `${releases}/latest/download/${SIGNATURE_FILE}`,
    list: `/repos/${FEED_REPOSITORY}/releases?per_page=${RELEASE_LIST_PAGE}`};
}

/**
 * The staging REST list: decoys that update-feed.ts selectStagingRelease must skip (a draft and a manifest-less
 * pre-release of higher versions, a production release, a malformed tag), then the release itself last, so the list's
 * order never picks it. Only the fields the updater reads, and the asset names.
 */
export function stagingReleaseList({tag, name}) {
  const assets = names => names.map(asset => ({name: asset}));
  const full = assets([MANIFEST_FILE, SIGNATURE_FILE, name]);
  return [
    {tag_name: 'staging-v9.9.9-stg.999999', prerelease: true, draft: true, assets: full},
    {tag_name: 'staging-v9.9.8-stg.999999', prerelease: true, draft: false, assets: assets([name])},
    {tag_name: 'v9.9.9', prerelease: false, draft: false, assets: full},
    {tag_name: 'staging-9.9.7', prerelease: true, draft: false, assets: full},
    {tag_name: tag, prerelease: true, draft: false, assets: full}
  ];
}

/** The single RELEASES line of a fixture feed folder: the SHA-1, the package name and its size (build-upgrade-fixture.mjs). */
export async function fixturePackage(feedFolder) {
  const line = (await readSmall(path.join(feedFolder, 'RELEASES'), 64 * 1024)).toString('utf8').replace(/^\uFEFF/, '').trim();
  const match = /^([0-9A-Fa-f]{40}) (\S+-full\.nupkg) (\d+)$/.exec(line);
  assert.ok(match, 'FIXTURE_RELEASES_INVALID');
  const file = path.join(feedFolder, match[2]);
  const item = await stat(file);
  assert.ok(item.isFile() && item.size === Number(match[3]), 'FIXTURE_PACKAGE_SIZE_DIFFERS');
  const sha256 = createHash('sha256'), sha1 = createHash('sha1');
  for await (const chunk of createReadStream(file)) {sha256.update(chunk); sha1.update(chunk);}
  const digest = sha1.digest('hex');
  assert.equal(digest, match[1].toLowerCase(), 'FIXTURE_PACKAGE_SHA1_DIFFERS');
  return {file, name: match[2], size: item.size, sha1: digest, sha256: sha256.digest('hex')};
}
async function readSmall(file, maximum) {
  const handle = await open(file, 'r');
  try {
    const {size} = await handle.stat();
    assert.ok(size <= maximum, 'FILE_TOO_LARGE');
    return await handle.readFile();
  } finally {await handle.close();}
}

/**
 * Starts the feed of one release on 127.0.0.1 with a free port. `phase` labels the recorded requests (setPhase changes
 * it), so the caller can tell the offer, a refused click and the download apart. close() ends every open connection.
 */
export async function startUpdateFeed({channel, release, packageFile}) {
  const routes = feedRoutes(release), requests = [];
  let phase = 'start', dropped = 0;
  const listBytes = Buffer.from(JSON.stringify(stagingReleaseList(release)), 'utf8');
  const server = http.createServer((request, response) => {
    const row = {phase, method: request.method, path: request.url, status: 404, userAgent: request.headers['user-agent'] ?? null,
      accept: request.headers.accept ?? null, cookie: 'cookie' in request.headers, authorization: 'authorization' in request.headers, bytes: 0};
    if (requests.length < REQUEST_RECORD_LIMIT) requests.push(row); else dropped++;
    const send = (status, body, type, headers = {}) => {
      row.status = status; row.bytes = body.length;
      response.writeHead(status, {'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers});
      response.end(body);
    };
    if (request.method !== 'GET') return send(405, Buffer.alloc(0), 'text/plain');
    const origin = `http://${request.headers.host}`;
    const url = request.url;
    if (channel === 'production' && (url === routes.latestManifest || url === routes.latestSignature)) {
      return send(302, Buffer.alloc(0), 'text/plain', {Location: `${origin}${url === routes.latestManifest ? routes.manifest : routes.signature}`});
    }
    if (channel === 'staging' && url === routes.list) return send(200, listBytes, 'application/json');
    if (url === routes.manifest) return send(200, release.bytes, 'application/octet-stream');
    if (url === routes.signature) return send(200, release.signature, 'application/octet-stream');
    if (url === routes.package) {
      row.status = 200;
      response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': release.manifest.package.size, 'Cache-Control': 'no-store'});
      const stream = createReadStream(packageFile);
      stream.on('data', chunk => {row.bytes += chunk.length;});
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
      return undefined;
    }
    return send(404, Buffer.alloc(0), 'text/plain');
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const {port} = server.address();
  return {
    origin: `http://127.0.0.1:${port}`, routes, requests,
    get dropped() {return dropped;},
    setPhase(next) {phase = next;},
    close: () => new Promise(resolve => {server.closeAllConnections(); server.close(() => resolve());})
  };
}

/** An origin on 127.0.0.1 where nothing listens: a port bound and released at once (no feed, a check fails quietly). */
export async function closedLoopbackOrigin() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const {port} = server.address();
  await new Promise(resolve => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

/**
 * Judges the recorded requests of one update (update-from-feed verify): every request is a GET with the fixed
 * User-Agent and no cookie or authorization header; the channel read only its own feed paths; nothing else was asked
 * for; the package came exactly once, in `downloadPhase`, with all its bytes, and never in a phase of `before`
 * (PACKAGE_WITHOUT_CLICK). Returns the list of failures (empty when it passes).
 */
export function checkFeedRequests(requests, {channel, routes, size, downloadPhase, before}) {
  const failures = [];
  const allowed = channel === 'production' ? [routes.latestManifest, routes.latestSignature, routes.manifest, routes.signature, routes.package]
    : [routes.list, routes.manifest, routes.signature, routes.package];
  for (const row of requests) {
    if (row.method !== 'GET') failures.push(`METHOD ${row.method} ${row.path}`);
    if (row.userAgent !== FEED_USER_AGENT) failures.push(`USER_AGENT ${row.path}`);
    if (row.cookie || row.authorization) failures.push(`CREDENTIALS ${row.path}`);
    if (!allowed.includes(row.path)) failures.push(`UNEXPECTED_PATH ${row.path}`);
  }
  const packages = requests.filter(row => row.path === routes.package);
  if (packages.some(row => before.includes(row.phase))) failures.push('PACKAGE_WITHOUT_CLICK');
  const downloads = packages.filter(row => row.phase === downloadPhase);
  if (downloads.length !== 1 || downloads[0].status !== 200 || downloads[0].bytes !== size) failures.push(`PACKAGE_DOWNLOADS ${downloads.length}`);
  const reads = channel === 'production' ? [routes.latestManifest, routes.latestSignature] : [routes.list];
  for (const read of reads) if (!requests.some(row => row.path === read)) failures.push(`NOT_READ ${read}`);
  return failures;
}
