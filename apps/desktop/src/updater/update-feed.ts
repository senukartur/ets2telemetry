import type {UpdateFailure} from '../../../../packages/contracts/src/app-state';
import type {ChannelIdentity, ReleaseChannel} from '../channel';
import type {UpdatePublicKey} from './update-keys';
import {MANIFEST_FILE, MANIFEST_MAX_BYTES, SIGNATURE_FILE, verifyUpdateManifest, type ManifestRefusal, type UpdateManifest} from './update-manifest';
import {compareNugetVersions, nugetVersionOf, tagVersion} from './update-version';

// The update feeds of the two channels (ET-055 UP4; docs/release.md, "Update feed"). Production reads the latest ordinary
// GitHub Release through `releases/latest/download/`, which never serves a pre-release. Staging reads the public REST list
// of releases and picks the highest NuGet version among published staging pre-releases that carry a manifest, whatever
// order the list has. Every request goes through the fetch port (Electron's net.fetch in main, so the system proxy
// applies), sends no identifier and, apart from the list's fixed `per_page`, no query string, and is bounded in time and
// size. 403 and 429 (GitHub's rate limits) are a quiet OFFLINE.

export const REPOSITORY = 'senukartur/ets2telemetry';
/** The origins of the real feed. Only the test-root mode replaces both with one loopback origin (update-context.ts). */
export interface FeedOrigins {readonly web: string; readonly api: string}
export const GITHUB_ORIGINS: FeedOrigins = Object.freeze({web: 'https://github.com', api: 'https://api.github.com'});
/** The staging list's bound and the per-request time limit of the list, the manifest and the signature. */
export const RELEASE_LIST_MAX_BYTES = 1024 * 1024;
export const FEED_REQUEST_TIMEOUT_MS = 10_000;
/** The REST list's page size: the staging releases of the last 30 published releases are considered. */
export const RELEASE_LIST_PAGE = 30;

/** The response fields the updater reads; Electron's and Node's `Response` satisfy it. */
export interface FetchResponse {readonly status: number; readonly body: ReadableStream<Uint8Array> | null}
/** One GET. `kind` selects the Accept header; redirects are followed. */
export type FetchPort = (url: string, init: {readonly signal: AbortSignal; readonly kind: 'json' | 'binary'}) => Promise<FetchResponse>;
/** Timers of the update controller; the controller's clock supplies them. */
export interface FeedTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const manifestUrls = (origins: FeedOrigins, tag?: string) => {
  const base = tag === undefined ? `${origins.web}/${REPOSITORY}/releases/latest/download` : `${origins.web}/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
  return {manifest: `${base}/${MANIFEST_FILE}`, signature: `${base}/${SIGNATURE_FILE}`};
};
export const releaseListUrl = (origins: FeedOrigins) => `${origins.api}/repos/${REPOSITORY}/releases?per_page=${RELEASE_LIST_PAGE}`;
/** The package URL, rebuilt from the verified tag and name; never a URL from the manifest. */
export const packageUrl = (origins: FeedOrigins, tag: string, name: string) => `${origins.web}/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;

export type BoundedRead = {readonly ok: true; readonly bytes: Buffer}
  | {readonly ok: false; readonly code: 'OFFLINE' | 'RATE_LIMITED' | 'HTTP_STATUS' | 'TOO_LARGE' | 'ABORTED'; readonly status?: number};

/**
 * One GET whose body is read to at most `maxBytes` within `timeoutMs`. A network error or timeout is OFFLINE, 403 and
 * 429 are RATE_LIMITED, any other status outside 200–299 is HTTP_STATUS, a larger body is TOO_LARGE (the read stops
 * there), and an abort of `signal` is ABORTED.
 */
export async function readBounded(fetch: FetchPort, url: string, options: {maxBytes: number; timeoutMs: number; kind: 'json' | 'binary'; timers: FeedTimers; signal?: AbortSignal}): Promise<BoundedRead> {
  if (options.signal?.aborted) return {ok: false, code: 'ABORTED'};
  const controller = new AbortController();
  let timedOut = false;
  const timer = options.timers.setTimeout(() => {timedOut = true; controller.abort();}, options.timeoutMs);
  const forward = () => controller.abort();
  options.signal?.addEventListener('abort', forward, {once: true});
  const stopped = () => options.signal?.aborted ? {ok: false as const, code: 'ABORTED' as const} : {ok: false as const, code: 'OFFLINE' as const};
  const aborted = new Promise<'aborted'>(resolve => controller.signal.addEventListener('abort', () => resolve('aborted'), {once: true}));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    let response: FetchResponse | 'aborted';
    try {response = await Promise.race([fetch(url, {signal: controller.signal, kind: options.kind}), aborted]);} catch {return stopped();}
    if (response === 'aborted') return stopped();
    if (response.status === 403 || response.status === 429) return {ok: false, code: 'RATE_LIMITED', status: response.status};
    if (response.status < 200 || response.status > 299) return {ok: false, code: 'HTTP_STATUS', status: response.status};
    if (!response.body) return {ok: true, bytes: Buffer.alloc(0)};
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      let next: ReadableStreamReadResult<Uint8Array> | 'aborted';
      try {next = await Promise.race([reader.read(), aborted]);} catch {return stopped();}
      if (next === 'aborted') return timedOut && !options.signal?.aborted ? {ok: false, code: 'OFFLINE'} : stopped();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > options.maxBytes) return {ok: false, code: 'TOO_LARGE'};
      chunks.push(Buffer.from(next.value));
    }
    return {ok: true, bytes: Buffer.concat(chunks, size)};
  } finally {
    options.timers.clearTimeout(timer);
    options.signal?.removeEventListener('abort', forward);
    if (!controller.signal.aborted) controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}

interface ListedRelease {readonly tag: string; readonly nugetVersion: string}

/**
 * The staging release to offer from a REST release list (UP4): the highest NuGet version among entries that are a
 * pre-release, not a draft, carry a tag `staging-v<x.y.z>-stg.<6 digits>` and an `update-manifest.json` asset. Malformed
 * entries are skipped; the list's order is never used. Undefined when the bytes are not a JSON array or nothing matches.
 */
export function selectStagingRelease(bytes: Uint8Array): {readonly tag: string} | undefined | 'invalid' {
  let value: unknown;
  try {value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));} catch {return 'invalid';}
  if (!Array.isArray(value)) return 'invalid';
  let best: ListedRelease | undefined;
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.prerelease !== true || record.draft !== false || typeof record.tag_name !== 'string' || !Array.isArray(record.assets)) continue;
    const version = tagVersion('staging', record.tag_name);
    if (!version) continue;
    const assets = record.assets as unknown[];
    if (!assets.some(asset => typeof asset === 'object' && asset !== null && (asset as Record<string, unknown>).name === MANIFEST_FILE)) continue;
    const candidate = {tag: record.tag_name, nugetVersion: nugetVersionOf(version)};
    if (!best || compareNugetVersions(candidate.nugetVersion, best.nugetVersion) > 0) best = candidate;
  }
  return best ? {tag: best.tag} : undefined;
}

export interface FeedRequest {
  readonly fetch: FetchPort;
  readonly origins: FeedOrigins;
  readonly identity: ChannelIdentity;
  readonly keys: readonly UpdatePublicKey[];
  readonly currentVersion: string;
  readonly timers: FeedTimers;
  readonly signal?: AbortSignal;
}
/**
 * A check's result. `available`: a verified offer with its package URL. `up-to-date`: no newer signed release
 * (`NO_RELEASE`, `NOT_NEWER`, `DOWNGRADE`). `failed`: a fixed failure for the update view and a detailed code for the log.
 */
export type FeedResult =
  | {readonly outcome: 'available'; readonly manifest: UpdateManifest; readonly packageUrl: string}
  | {readonly outcome: 'up-to-date'; readonly code: 'NO_RELEASE' | 'NOT_NEWER' | 'DOWNGRADE'}
  | {readonly outcome: 'failed'; readonly failure: UpdateFailure; readonly code: string}
  | {readonly outcome: 'aborted'};

const readFailure = (read: Exclude<BoundedRead, {ok: true}>, part: 'list' | 'manifest' | 'signature'): FeedResult => {
  if (read.code === 'ABORTED') return {outcome: 'aborted'};
  if (read.code === 'OFFLINE' || read.code === 'RATE_LIMITED' || part === 'list') return {outcome: 'failed', failure: 'OFFLINE', code: `${part.toUpperCase()}_${read.code}`};
  return {outcome: 'failed', failure: 'MANIFEST_INVALID', code: `${part.toUpperCase()}_${read.code}`};
};
const refusalResult = (code: ManifestRefusal): FeedResult => code === 'NOT_NEWER' || code === 'DOWNGRADE' ? {outcome: 'up-to-date', code}
  : {outcome: 'failed', failure: code === 'SIGNATURE_INVALID' ? 'SIGNATURE_INVALID' : 'MANIFEST_INVALID', code};

/** One check of `request.identity.channel`'s feed; see FeedResult. */
export async function checkFeed(request: FeedRequest): Promise<FeedResult> {
  const channel: ReleaseChannel = request.identity.channel;
  const bounded = (url: string, maxBytes: number, kind: 'json' | 'binary') =>
    readBounded(request.fetch, url, {maxBytes, timeoutMs: FEED_REQUEST_TIMEOUT_MS, kind, timers: request.timers, signal: request.signal});
  let sourceTag: string | undefined;
  if (channel === 'staging') {
    const list = await bounded(releaseListUrl(request.origins), RELEASE_LIST_MAX_BYTES, 'json');
    if (!list.ok) return readFailure(list, 'list');
    const selected = selectStagingRelease(list.bytes);
    if (selected === 'invalid') return {outcome: 'failed', failure: 'OFFLINE', code: 'LIST_INVALID'};
    if (!selected) return {outcome: 'up-to-date', code: 'NO_RELEASE'};
    sourceTag = selected.tag;
  }
  const urls = manifestUrls(request.origins, sourceTag);
  const manifest = await bounded(urls.manifest, MANIFEST_MAX_BYTES, 'binary');
  if (!manifest.ok) return readFailure(manifest, 'manifest');
  const signature = await bounded(urls.signature, MANIFEST_MAX_BYTES, 'binary');
  if (!signature.ok) return readFailure(signature, 'signature');
  const verified = verifyUpdateManifest(manifest.bytes, signature.bytes, {identity: request.identity, keys: request.keys, currentVersion: request.currentVersion, sourceTag});
  if (!verified.ok) return refusalResult(verified.code);
  return {outcome: 'available', manifest: verified.manifest, packageUrl: packageUrl(request.origins, verified.manifest.package.tag, verified.manifest.package.name)};
}
