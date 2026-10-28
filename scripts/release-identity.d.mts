import type {BuildChannel, BuildIdentity, ResolvedBuild} from './build-channel.mjs';

export interface AuthenticodeResult {status: string; signer: string | null; thumbprint: string | null; timestamped: boolean}
export interface PeImage {path: string; size: number; sha256: string; machine: string}
export interface ForeignAddon {path: string; size: number; sha256: string; format: 'elf' | 'mach-o'}
export interface InstallerFacts {
  setup: string;
  nupkg: string;
  releases: string;
  projectedFiles: number;
  excludedPackageFiles: string[];
  additions: string[];
}
export type BuiltBy = {kind: 'github-actions'; runId: string} | {kind: 'local'; runId: null};
export interface ReleaseIdentity {
  format: 'ets2telemetry.release-identity';
  version: 1;
  createdUtc: string;
  channel: BuildChannel;
  builtBy: BuiltBy;
  source: {commit: string | null; sourceCommit: string | null; treeClean: boolean | null};
  versions: {app: string; nuget: string; electron: string; plugin: string};
  artifacts: Record<'setup' | 'nupkg' | 'releases', {name: string; size: number; sha256: string}>;
  package: {sha256: string; files: number; projectedFiles: number; excludedFromNupkg: string[]; nupkgAdditions: string[]};
  plugin: {file: string; sha256: string; size: number; appVersion: string; matchesManifest: true; known: number};
  broker: {file: string; sha256: string; size: number; matchesBuildEvidence: true};
  squirrel: {
    updateExe: {path: string; sha256: string; matchesVendor: true};
    executionStubs: {path: string; sha256: string}[];
    vendor: Record<'Squirrel.exe' | 'Setup.exe' | 'StubExecutable.exe', string>;
  };
  signing: {decision: string; summary: Record<string, number>};
  peImages: (PeImage & {location: 'package' | 'nupkg' | 'installer'; authenticode: AuthenticodeResult})[];
  foreignNodeAddons: ForeignAddon[];
}

export const IDENTITY_FORMAT: 'ets2telemetry.release-identity';
export const IDENTITY_FILE: string;
export const MAKE_DIRECTORY: string;
export const VENDOR_DIRECTORY: string;
export const RELEASES: string;
export function activeBuildIdentity(): BuildIdentity;
export function packageDirectoryOf(identity?: BuildIdentity): string;
export function nugetIdOf(identity?: BuildIdentity): string;
export function executableOf(identity?: BuildIdentity): string;
export const PRODUCT_NAME: 'Yukon Union Telemetry';
export const PUBLISHER: 'Yukon Union Telemetry contributors';
export const COMPANY_NAME: 'Artur Sianiuk';
export const VERSION_INFO_FIELDS: readonly ['ProductName', 'FileDescription', 'CompanyName', 'OriginalFilename'];
export const VERSION_INFO_SCRIPT: string;
export type VersionInfo = Record<'ProductName' | 'FileDescription' | 'CompanyName' | 'OriginalFilename', string | null>;
export const AUTHENTICODE_STATUSES: string[];
export const AUTHENTICODE_SCRIPT: string;
export const SIGNING_FAILURES: string[];
export function assertSigningStatuses(images: {location: string; path: string; authenticode: AuthenticodeResult}[]): void;
export function packedNativeEntries(archive: string): string[];
export function assertNoPackedNativeCode(archive: string): void;
export function setupExeName(version: string, identity?: BuildIdentity): string;
export function nugetVersion(version: string): string;
export function nupkgName(version: string, identity?: BuildIdentity): string;
export function hashFile(filename: string): {size: number; sha256: string};
export function listFiles(root: string): string[];
export function peMachine(read: (position: number, length: number) => Buffer): string | null;
export function foreignFormat(read: (position: number, length: number) => Buffer): 'elf' | 'mach-o' | null;
export function listNativeFiles(root: string): {pe: PeImage[]; foreign: ForeignAddon[]};
export function readZip(bytes: Buffer): {names: string[]; extract(name: string): Buffer};
export function projectPackageFile(relative: string, executable?: string): string | null;
export function knownAddition(name: string, stubs: ReadonlySet<string>, nugetId?: string): boolean;
export function parseReleases(text: string): {sha1: string; name: string; size: number};
export function inspectInstaller(options: {packageDirectory: string; makeDirectory: string; version: string; identity?: BuildIdentity}): InstallerFacts;
export function parseAuthenticodeOutput(stdout: string, count: number): AuthenticodeResult[];
export function windowsPowerShell(env?: Readonly<Record<string, string | undefined>>): {executable: string; env: Record<string, string | undefined>};
export function readAuthenticode(files: string[], env?: Readonly<Record<string, string | undefined>>): AuthenticodeResult[];
export function parseVersionInfoOutput(stdout: string): VersionInfo;
export function readVersionInfo(file: string, env?: Readonly<Record<string, string | undefined>>): VersionInfo;
export function assertVersionInfo(info: VersionInfo, identity?: BuildIdentity): void;
export function builtByOf(env?: Readonly<Record<string, string | undefined>>): BuiltBy;
export function releaseIdentity(options: {
  checkout?: string;
  build?: ResolvedBuild;
  packageDirectory?: string;
  makeDirectory?: string;
  vendorDirectory?: string;
  signatures?: (files: string[]) => AuthenticodeResult[];
  source?: {commit: string | null; sourceCommit: string | null; treeClean: boolean | null};
  environment?: Readonly<Record<string, string | undefined>>;
  now?: () => Date;
}): ReleaseIdentity;
