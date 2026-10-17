// The user-visible text of the Game plugin card (ET-017 PR-5, P18). A pure builder over AppState.plugins and the answers of
// the plugin bridge methods: main validated the view, and this module only picks fixed texts from strings.ts. The view
// never carries a path, and neither does any text here: a game folder is named by its source and position. Renderer-safe:
// type imports and strings only. See docs/plugin-setup.md#the-game-plugin-card.
import type {PluginBlockReason, PluginFolderChoice, PluginGame, PluginGameView, PluginSetupView, PluginShowFileResult, PluginTargetState, PluginTargetView} from '../../../packages/contracts/src';
import {
  PLUGIN_DISCOVERY_TEXT, PLUGIN_FOLDER_REFUSAL_TEXT, PLUGIN_MANUAL_FOLDER_TEXT, PLUGIN_MODE_TEXT, PLUGIN_REASON_TEXT, PLUGIN_STATE_TEXT, PLUGIN_STRINGS, UNIT_GAME_TEXT
} from './strings';

/**
 * Block reasons after which the card offers the manual copy (P12): "Show plugin file" and "Open game plugins folder". A
 * locked file (TARGET_LOCKED) is retried automatically, so it shows only that text.
 */
export const MANUAL_COPY_REASONS: readonly PluginBlockReason[] = Object.freeze(['PERMISSION_DENIED', 'READ_ONLY_FILE', 'UNRECOGNIZED_FILE']);

export interface PluginTargetText {
  /** The target id, for the bridge's openPluginFolder only. */
  id: string;
  /** "Steam folder 1" or "Chosen folder". */
  label: string;
  state: PluginTargetState;
  /** The state headline, such as "Installed". */
  status: string;
  /** Lines under it: why a change did not happen, the installed version, the last problem and the manual-copy hint. */
  detail: string[];
  /** Whether the card offers "Show plugin file" and "Open game plugins folder" for this folder. */
  manualCopy: boolean;
}
export interface PluginGameText {
  title: string;
  /** Not excluded: the "Manage the plugin for this game" switch is on. */
  managed: boolean;
  /** Discovery, the chosen folder's state and the unlisted Steam folders. */
  notes: string[];
  targets: PluginTargetText[];
}
export interface PluginSetupText {
  /** A note for the disabled or test-root mode; null in the active mode. */
  mode: string | null;
  bundled: string;
  /** Shown while a setup run is in progress. */
  running: string | null;
  /** False in the disabled mode: the switch, the folder dialog and Retry change nothing then. */
  actionable: boolean;
  games: Readonly<Record<PluginGame, PluginGameText>>;
}

const fill = (template: string, values: Readonly<Record<string, string>>) => template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '');
const fileText = (template: string, file: {version: string | null; sha256Prefix: string}) =>
  fill(template, {version: file.version ?? PLUGIN_STRINGS.unknownVersion, hash: file.sha256Prefix});

function targetText(target: PluginTargetView): PluginTargetText {
  const detail: string[] = [];
  if (target.reason) detail.push(PLUGIN_REASON_TEXT[target.reason]);
  if (target.installed && target.state !== 'installed') detail.push(fileText(PLUGIN_STRINGS.installedVersion, target.installed));
  if (target.lastFailure && target.lastFailure !== target.reason) detail.push(fill(PLUGIN_STRINGS.lastFailure, {reason: PLUGIN_REASON_TEXT[target.lastFailure]}));
  const manualCopy = target.reason !== null && MANUAL_COPY_REASONS.includes(target.reason);
  if (manualCopy) detail.push(PLUGIN_STRINGS.manualCopy);
  return {
    id: target.id,
    label: target.source === 'manual' ? PLUGIN_STRINGS.manualFolder : fill(PLUGIN_STRINGS.steamFolder, {number: String(target.ordinal + 1)}),
    state: target.state,
    status: PLUGIN_STATE_TEXT[target.state],
    detail,
    manualCopy
  };
}

function gameText(game: PluginGame, view: PluginGameView, disabled: boolean): PluginGameText {
  // The disabled mode never discovers anything: "Looking for the game…" would stay forever.
  if (disabled) return {title: UNIT_GAME_TEXT[game], managed: !view.excluded, notes: [PLUGIN_STRINGS.notSearched], targets: view.targets.map(targetText)};
  const notes = [PLUGIN_DISCOVERY_TEXT[view.discovery]];
  const manual = PLUGIN_MANUAL_FOLDER_TEXT[view.manualFolder];
  if (manual) notes.push(manual);
  if (view.unlistedFolders === 1) notes.push(PLUGIN_STRINGS.unlistedOne);
  else if (view.unlistedFolders > 1) notes.push(fill(PLUGIN_STRINGS.unlistedMany, {count: String(view.unlistedFolders)}));
  if (!view.targets.length && view.discovery !== 'pending') notes.push(PLUGIN_STRINGS.noFolders);
  return {title: UNIT_GAME_TEXT[game], managed: !view.excluded, notes, targets: view.targets.map(targetText)};
}

/** The texts of one plugin setup view. Every mode, outcome, state and reason has a fixed text. */
export function pluginSetupText(view: PluginSetupView): PluginSetupText {
  return {
    mode: PLUGIN_MODE_TEXT[view.mode],
    bundled: view.bundled ? fileText(PLUGIN_STRINGS.bundled, view.bundled) : PLUGIN_STRINGS.bundledUnknown,
    running: view.running ? PLUGIN_STRINGS.running : null,
    actionable: view.mode !== 'disabled',
    games: {ets2: gameText('ets2', view.games.ets2, view.mode === 'disabled'), ats: gameText('ats', view.games.ats, view.mode === 'disabled')}
  };
}

/** The answer of the folder dialog: saved, cancelled (nothing written) or a fixed refusal. */
export function pluginFolderChoiceText(choice: PluginFolderChoice): string {
  if (choice.outcome === 'chosen') return PLUGIN_STRINGS.folderChosen;
  if (choice.outcome === 'cancelled') return PLUGIN_STRINGS.folderCancelled;
  return PLUGIN_FOLDER_REFUSAL_TEXT[choice.code];
}

/** The answer of "Show plugin file". */
export function pluginShowFileText(result: PluginShowFileResult): string {
  return result.outcome === 'shown' ? PLUGIN_STRINGS.fileShown : PLUGIN_STRINGS.fileUnavailable;
}
