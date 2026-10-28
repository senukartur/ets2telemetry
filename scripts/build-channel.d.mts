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
}
export interface ResolvedBuild {
  channel: BuildChannel;
  identity: BuildIdentity;
  baseVersion: string;
  version: string;
}
type Environment = Readonly<Record<string, string | undefined>>;
export const BUILD_CHANNEL_VARIABLE: 'ETS2TELEMETRY_BUILD_CHANNEL';
export const STAGING_RUN_NUMBER_VARIABLE: 'ETS2TELEMETRY_STAGING_RUN_NUMBER';
export const BUILD_CHANNELS: readonly BuildChannel[];
export const DEFAULT_BUILD_CHANNEL: BuildChannel;
export const BUILD_IDENTITIES: Readonly<Record<BuildChannel, BuildIdentity>>;
export function resolveBuildChannel(env?: Environment): BuildChannel;
export function resolveBuildVersion(channel: BuildChannel, baseVersion: unknown, env?: Environment): string;
export function buildSetupFileName(identity: BuildIdentity, version: string): string;
export function resolveBuild(options?: {env?: Environment; root?: string}): ResolvedBuild;
export function cmakeChannelDefinition(channel: BuildChannel): string;
export function readCmakeCacheChannel(buildDirectory: string): string | null;
