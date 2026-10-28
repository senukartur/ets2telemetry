import type {BuildChannel, ResolvedBuild} from './build-channel.mjs';

export interface KnownPlugin {
  appVersion: string;
  sha256: string;
}
export interface PluginBundleManifest {
  format: 'ets2telemetry.plugin-bundle';
  version: 1;
  appVersion: string;
  file: string;
  size: number;
  sha256: string;
  pluginSources: Record<string, string>;
  known: KnownPlugin[];
}
export interface PluginBundleNames {
  channel: BuildChannel;
  file: string;
  built: string;
  released: string;
}
export const PLUGIN_BUNDLE_FORMAT: 'ets2telemetry.plugin-bundle';
export const RELEASED_PLUGINS_FORMAT: 'ets2telemetry.released-plugins';
export const PLUGIN_MANIFEST: 'plugin-manifest.json';
export const PLUGIN_STAGE: string;
export const MAX_PLUGIN_BYTES: number;
export const MAX_MANIFEST_BYTES: number;
export function pluginBundleNames(channel?: BuildChannel): PluginBundleNames;
export function pluginSourceHashes(root?: string): Record<string, string>;
export function readReleasedPlugins(filename?: string): KnownPlugin[];
export function assertX64Dll(bytes: Buffer, label?: string): void;
export function verifyPluginBundle(directory: string, channel?: BuildChannel): PluginBundleManifest;
export function verifyPluginBundleAgainstTree(directory: string, root?: string, build?: ResolvedBuild): PluginBundleManifest;
export function writePluginBundle(directory: string, options: {
  dll: Buffer;
  appVersion: string;
  pluginSources: Record<string, string>;
  known: KnownPlugin[];
  channel?: BuildChannel;
}): PluginBundleManifest;
