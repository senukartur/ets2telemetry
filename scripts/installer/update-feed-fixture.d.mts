export const FEED_REPOSITORY: string;
export const MANIFEST_FORMAT: string;
export const MANIFEST_FILE: string;
export const SIGNATURE_FILE: string;
export const TEST_KEY_ID: string;
export const FEED_USER_AGENT: string;
export const RELEASE_LIST_PAGE: number;
export interface TestSigningKey {readonly publicKey: string; sign(bytes: Uint8Array): string}
export function createTestSigningKey(): TestSigningKey;
export function releaseTagOf(channel: string, appVersion: string): string;
export interface FeedManifest {
  format: string; channel: 'production' | 'staging'; appVersion: string; nugetVersion: string;
  package: {tag: string; name: string; size: number; sha256: string; sha1: string}; publishedUtc: string; keyId: string;
}
export interface FeedRelease {manifest: FeedManifest; bytes: Buffer; signature: Buffer; tag: string; name: string}
export function feedRelease(input: {channel: string; appVersion: string; squirrelId: string; size: number; sha256: string; sha1: string; publishedUtc: string;
  key: TestSigningKey}): FeedRelease;
export interface FeedRoutes {manifest: string; signature: string; package: string; latestManifest: string; latestSignature: string; list: string}
export function feedRoutes(release: {tag: string; name: string}): FeedRoutes;
export function stagingReleaseList(release: {tag: string; name: string}): {tag_name: string; prerelease: boolean; draft: boolean; assets: {name: string}[]}[];
export function fixturePackage(feedFolder: string): Promise<{file: string; name: string; size: number; sha1: string; sha256: string}>;
export interface FeedRequestRow {phase: string; method: string | undefined; path: string | undefined; status: number; userAgent: string | null; accept: string | null;
  cookie: boolean; authorization: boolean; bytes: number}
export interface UpdateFeed {
  readonly origin: string; readonly routes: FeedRoutes; readonly requests: FeedRequestRow[]; readonly dropped: number;
  setPhase(phase: string): void; close(): Promise<void>;
}
export function startUpdateFeed(input: {channel: string; release: FeedRelease; packageFile: string}): Promise<UpdateFeed>;
export function closedLoopbackOrigin(): Promise<string>;
export function checkFeedRequests(requests: readonly FeedRequestRow[], expectation: {channel: string; routes: FeedRoutes; size: number; downloadPhase: string;
  before: readonly string[]}): string[];
