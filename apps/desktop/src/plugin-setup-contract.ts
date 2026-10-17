// The plugin setup IPC contract between the dashboard and main (ET-017 P16; docs/plugin-setup.md, "IPC"). It holds the
// fixed invoke channels and the strict checks of every bridge argument, used by the preload and again by main.
// Renderer-safe: no Node or Electron API, so the sandboxed preload can import it.
import type {PluginGame} from '../../../packages/contracts/src';

/** The five fixed invoke channels of plugin setup. */
export const PLUGIN_CHANNELS = {
  retry: 'plugin:retry', chooseFolder: 'plugin:choose-folder', setExcluded: 'plugin:set-excluded', showFile: 'plugin:show-file',
  openFolder: 'plugin:open-folder'
} as const;

/** ET-017 PR-6 (P17): the diagnostic bundle export; it takes no argument. */
export const DIAGNOSTICS_EXPORT_CHANNEL = 'diagnostics:export';

/** A listed game folder: `<game>:<source>:<ordinal>`, never a path. */
export const PLUGIN_TARGET_ID = /^(ets2|ats):(steam|manual):[0-3]$/;

export const isPluginGame = (value: unknown): value is PluginGame => value === 'ets2' || value === 'ats';
export const isPluginTargetId = (value: unknown): value is string => typeof value === 'string' && PLUGIN_TARGET_ID.test(value);
/** The target id of one game folder. */
export const pluginTargetId = (game: PluginGame, source: 'steam' | 'manual', ordinal: number) => `${game}:${source}:${ordinal}`;
