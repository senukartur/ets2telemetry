export interface KnownPlugin {
  appVersion: string;
  sha256: string;
}
export interface PluginBundleManifest {
  format: 'ets2telemetry.plugin-bundle';
  version: 1;
  appVersion: string;
  file: 'ets2telemetry-plugin.dll';
  size: number;
  sha256: string;
  pluginSources: Record<string, string>;
  known: KnownPlugin[];
}
export const PLUGIN_BUNDLE_FORMAT: 'ets2telemetry.plugin-bundle';
export const RELEASED_PLUGINS_FORMAT: 'ets2telemetry.released-plugins';
export const PLUGIN_FILE: 'ets2telemetry-plugin.dll';
export const PLUGIN_MANIFEST: 'plugin-manifest.json';
export const PLUGIN_STAGE: string;
export const BUILT_PLUGIN: string;
export const RELEASED_PLUGINS: string;
export const MAX_PLUGIN_BYTES: number;
export const MAX_MANIFEST_BYTES: number;
export function pluginSourceHashes(root?: string): Record<string, string>;
export function readReleasedPlugins(filename?: string): KnownPlugin[];
export function assertX64Dll(bytes: Buffer, label?: string): void;
export function verifyPluginBundle(directory: string): PluginBundleManifest;
export function verifyPluginBundleAgainstTree(directory: string, root?: string): PluginBundleManifest;
export function writePluginBundle(directory: string, options: {
  dll: Buffer;
  appVersion: string;
  pluginSources: Record<string, string>;
  known: KnownPlugin[];
}): PluginBundleManifest;
