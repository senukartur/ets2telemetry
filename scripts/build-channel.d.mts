export type BuildChannel = 'production' | 'staging';
export interface BuildIdentity {
  channel: BuildChannel;
  squirrelId: string;
  executableName: string;
  productName: string;
  appBundleId: string;
  displayName: string;
  setupFileTemplate: string;
  pluginFileName: string;
  releasedPluginsFile: string;
  dataRootName: string;
  pipePrefix: string;
  runOnceValue: string;
  receiptPrefix: string;
  legacyShortcutNames: readonly string[];
}
export interface ResolvedBuild {
  channel: BuildChannel;
  identity: BuildIdentity;
  baseVersion: string;
  version: string;
}
export interface BuiltBuild {
  channel: BuildChannel;
  identity: BuildIdentity;
  version: string;
}
export interface BuildNames {
  channel: BuildChannel;
  version: string;
  packageDirectory: string;
  executable: string;
  setup: string;
  plugin: string;
  squirrelId: string;
  productName: string;
  displayName: string;
  dataRootName: string;
  pipePrefix: string;
  runOnceValue: string;
  receiptPrefix: string;
  legacyShortcutNames: string[];
}
type Environment = Readonly<Record<string, string | undefined>>;
export const BUILD_CHANNEL_VARIABLE: 'ETS2TELEMETRY_BUILD_CHANNEL';
export const OWNER_PRODUCTION_BUILD_VARIABLE: 'ETS2TELEMETRY_OWNER_PRODUCTION_BUILD';
export const STAGING_RUN_NUMBER_VARIABLE: 'ETS2TELEMETRY_STAGING_RUN_NUMBER';
export const BUILD_CHANNELS: readonly BuildChannel[];
export const DEFAULT_BUILD_CHANNEL: BuildChannel;
export const DESKTOP_BUILD_EVIDENCE: 'apps/desktop/dist/build-evidence.json';
export const BUILD_IDENTITIES: Readonly<Record<BuildChannel, BuildIdentity>>;
export function productionBuildAllowed(env?: Environment): boolean;
export function resolveBuildChannel(env?: Environment): BuildChannel;
export function resolveBuildVersion(channel: BuildChannel, baseVersion: unknown, env?: Environment): string;
export function buildSetupFileName(identity: BuildIdentity, version: string): string;
export function resolveBuild(options?: {env?: Environment; root?: string}): ResolvedBuild;
export function cmakeChannelDefinition(channel: BuildChannel): string;
export function readCmakeCacheChannel(buildDirectory: string): string | null;
export function packageDirectoryName(identity: BuildIdentity): string;
export function readBuiltBuild(root?: string): BuiltBuild;
export function buildNames(build: BuiltBuild): BuildNames;
