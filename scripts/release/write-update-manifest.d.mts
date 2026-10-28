import type {CompiledUpdateKey, ReleaseChannel, UpdateManifestV1} from './update-manifest-common.mjs';

export interface ReleaseFile {name: string; size: number; sha256: string; sha1: string}
export interface ReleaseFacts {
  channel: ReleaseChannel;
  appVersion: string;
  nugetVersion: string;
  tag: string;
  title: string;
  commit: string;
  runId: string;
  setup: ReleaseFile;
  nupkg: ReleaseFile;
  releases: ReleaseFile;
}
export const IDENTITY_FILE: 'release-identity.json';
export const IDENTITY_FORMAT: 'ets2telemetry.release-identity';
export const RELEASES_FILE: 'RELEASES';
export function verifyReleaseArtifacts(folder: string, options: {channel: string; runId: string; commit?: string; runNumber?: string}): ReleaseFacts;
export function cliRunNumber(channel: string, runNumber: string | undefined): string | undefined;
export function buildUpdateManifest(facts: ReleaseFacts, options: {keyId: string; now?: Date}): UpdateManifestV1;
export function manifestBytesOf(manifest: unknown): Buffer;
export function releaseNotesOf(facts: ReleaseFacts, repository: string): string;
export function selectKeyId(keys: readonly CompiledUpdateKey[], channel: ReleaseChannel, requested?: string): string;
