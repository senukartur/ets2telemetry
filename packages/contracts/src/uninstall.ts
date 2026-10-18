import type {PluginBlockReason, PluginGame} from './app-state';

// The in-app uninstall's result (ET-018 PR-4, plan U8; docs/uninstall.md, "In-app uninstall"). Fixed codes, target ids and
// counts only, never a path.

/** Why one game folder stops the in-app uninstall: the ET-017 block reasons, an unavailable folder or a failed listing. */
export type UninstallBlockReason = PluginBlockReason | 'FOLDER_UNAVAILABLE' | 'RUNNING_CHECK_FAILED' | 'BUDGET_EXPIRED';
/** The primary reason of a blocked uninstall: a folder's reason, or an install registry that cannot be used. */
export type UninstallBlockCode = UninstallBlockReason | 'REGISTRY_INVALID' | 'REGISTRY_NEWER' | 'REGISTRY_UNREADABLE';
/**
 * Why the in-app uninstall failed before it changed anything: the install location could not be confirmed (the roots
 * refusals), another uninstall runs, the dialog could not open, the intent could not be written, or the cleanup threw.
 */
export type UninstallFailureCode = 'ROOT_MISMATCH' | 'LAYOUT_INVALID' | 'DATA_ROOT_LINKED' | 'TEST_ROOT_INVALID' | 'BUSY' | 'DIALOG_FAILED' | 'INTENT_FAILED'
  | 'ENGINE_FAILED';
/** A blocked game folder: its listed target id (`<game>:<source>:<ordinal>`), or `<game>:other` when it is not listed. */
export interface UninstallBlockedFolder {targetId: string; reason: UninstallBlockReason}
/**
 * `cancelled`: the confirmation was declined; nothing changed. `not-installed`: a portable or development copy, which
 * Windows does not uninstall. `blocked`: a game folder or the install registry stops it; nothing changed. `interrupted`:
 * a game folder stopped the plugin removal after `removed` plugin files were already removed (a game started after the
 * check); the data is kept and plugin setup puts the plugin back. `started`: the plugin is removed and the application
 * exits to remove its data and hand over to Windows' uninstall. `failed`: see code.
 */
export type AppUninstallResult = {outcome: 'cancelled'} | {outcome: 'not-installed'} | {outcome: 'started'}
  | {outcome: 'blocked'; code: UninstallBlockCode; blocked: UninstallBlockedFolder[]}
  | {outcome: 'interrupted'; code: UninstallBlockCode; removed: number; blocked: UninstallBlockedFolder[]}
  | {outcome: 'failed'; code: UninstallFailureCode};
/** A target id in a blocked list. */
export const UNINSTALL_TARGET_ID = /^(ets2|ats):((steam|manual):[0-3]|other)$/;
export const uninstallOtherTarget = (game: PluginGame) => `${game}:other`;
