// The result of one Game plugin card action (ET-045b), shown next to the control that started it. A pure, renderer-safe
// model: it names the action and its game from the call site's closure, classifies the bridge's fixed answer into a
// severity and builds the localized text from fixed strings only. No IPC, path or raw error text enters it. See
// docs/plugin-setup.md#the-game-plugin-card.
import type {AppLanguage, DiagnosticsExportFailure, DiagnosticsExportRefusal, DiagnosticsExportResult, PluginFolderChoice, PluginFolderRefusal, PluginGame,
  PluginShowFileResult} from '../../../packages/contracts/src';
import {t, type I18nKey} from './i18n';
import {diagnosticsExportText, pluginFolderChoiceText, pluginShowFileText} from './plugin-setup-text';
import * as BASE_COPY from './strings';
import {copyTable} from './screens/app-copy';

/** How a result reads: never an error for an informational answer, and never colour alone (icon and word too). */
export type ActionSeverity = 'info' | 'success' | 'refused' | 'failed';
/** The card action that produced a result, with its game and listed folder where it has one. */
export type PluginAction =
  | {kind: 'manage'; game: PluginGame}
  | {kind: 'choose-folder'; game: PluginGame}
  | {kind: 'show-file'; game: PluginGame; targetId: string}
  | {kind: 'open-folder'; game: PluginGame; targetId: string}
  | {kind: 'retry'}
  | {kind: 'export-diagnostics'};
/** The bridge's fixed answer, or a rejected call. */
export type PluginActionOutcome =
  | {kind: 'folder-choice'; choice: PluginFolderChoice}
  | {kind: 'show-file'; result: PluginShowFileResult}
  | {kind: 'diagnostics-export'; result: DiagnosticsExportResult}
  | {kind: 'request-failed'};
export interface PluginActionResult {action: PluginAction; outcome: PluginActionOutcome}
export interface ActionResultText {
  severity: ActionSeverity;
  /** "Information", "Done", "Refused" or "Failed" in the selected language. */
  severityWord: string;
  /** "{severity} — {action}", such as "Information — Game folder for American Truck Simulator". */
  title: string;
  message: string;
}

/**
 * Every folder refusal by severity. A folder Steam already lists changes nothing and is information; a record that could
 * not be saved is a failure; every other code is a refused request. A new contract code fails to compile until classified.
 */
export const FOLDER_REFUSAL_SEVERITY: Readonly<Record<PluginFolderRefusal, ActionSeverity>> = Object.freeze({
  FOLDER_DUPLICATE: 'info', REGISTRY_UNAVAILABLE: 'failed',
  FOLDER_UNSUPPORTED_PATH: 'refused', FOLDER_NOT_GAME: 'refused', FOLDER_WRONG_GAME: 'refused', FOLDER_LINKED: 'refused', SETUP_DISABLED: 'refused', BUSY: 'refused'
});
/** Every refused or failed diagnostics export by severity. */
export const EXPORT_PROBLEM_SEVERITY: Readonly<Record<DiagnosticsExportRefusal | DiagnosticsExportFailure, ActionSeverity>> = Object.freeze({
  EXPORT_IN_PROGRESS: 'refused', EXPORT_INTERRUPTED: 'refused', EXPORT_TARGET_REFUSED: 'refused',
  DIALOG_FAILED: 'failed', BUNDLE_FAILED: 'failed', EXPORT_WRITE_FAILED: 'failed'
});
/** Every refused "Show plugin file" answer by severity: the bundled file the driver needs is not available. */
export const SHOW_FILE_REFUSAL_SEVERITY: Readonly<Record<Extract<PluginShowFileResult, {outcome: 'refused'}>['code'], ActionSeverity>> = Object.freeze({
  BUNDLE_UNAVAILABLE: 'failed'
});
const SEVERITY_WORD: Readonly<Record<ActionSeverity, I18nKey>> = Object.freeze({
  info: 'act.sev.info', success: 'act.sev.success', refused: 'act.sev.refused', failed: 'act.sev.failed'
});

/** The severity of one answer. */
export function pluginActionSeverity(outcome: PluginActionOutcome): ActionSeverity {
  switch (outcome.kind) {
    case 'folder-choice':
      return outcome.choice.outcome === 'chosen' ? 'success' : outcome.choice.outcome === 'cancelled' ? 'info' : FOLDER_REFUSAL_SEVERITY[outcome.choice.code];
    case 'show-file':
      return outcome.result.outcome === 'shown' ? 'success' : SHOW_FILE_REFUSAL_SEVERITY[outcome.result.code];
    case 'diagnostics-export':
      return outcome.result.outcome === 'saved' ? 'success' : outcome.result.outcome === 'cancelled' ? 'info' : EXPORT_PROBLEM_SEVERITY[outcome.result.code];
    case 'request-failed':
      return 'failed';
  }
}

/**
 * The shown outcome of each action's successful bridge answer, or null for none. A managed-switch change and Retry answer
 * with the new view, which the switch, the badges and "Checking the game folders…" already show; opening a folder answers
 * nothing that proves it opened. None of them gets an invented success line. A rejected call is `request-failed`.
 */
export const PLUGIN_ACTION_ANSWERS = Object.freeze({
  manage: (): PluginActionOutcome | null => null,
  retry: (): PluginActionOutcome | null => null,
  openFolder: (): PluginActionOutcome | null => null,
  chooseFolder: (choice: PluginFolderChoice): PluginActionOutcome => ({kind: 'folder-choice', choice}),
  showFile: (result: PluginShowFileResult): PluginActionOutcome => ({kind: 'show-file', result}),
  exportDiagnostics: (result: DiagnosticsExportResult): PluginActionOutcome => ({kind: 'diagnostics-export', result})
});

/** A test id from a target id such as `ets2:steam:0`. */
export const pluginTargetTestId = (id: string) => `plugin-target-${id.replaceAll(':', '-')}`;
/**
 * The slot of an action's result: the base of its region's ids. The region follows the trigger, or the trigger's row,
 * as its next element sibling; a folder's two manual buttons share their row's slot.
 */
export function pluginActionSlot(action: PluginAction): string {
  switch (action.kind) {
    case 'manage': return `plugin-${action.game}-managed`;
    case 'choose-folder': return `plugin-${action.game}-choose`;
    case 'show-file': case 'open-folder': return pluginTargetTestId(action.targetId);
    case 'retry': return 'plugin-retry';
    case 'export-diagnostics': return 'plugin-export-diagnostics';
  }
}
/** The element id of the control that starts an action (equal to its test id). */
export function pluginActionTriggerId(action: PluginAction): string {
  switch (action.kind) {
    case 'show-file': return `${pluginTargetTestId(action.targetId)}-show-file`;
    case 'open-folder': return `${pluginTargetTestId(action.targetId)}-open-folder`;
    default: return pluginActionSlot(action);
  }
}
/** The id of a slot's result body, which its trigger names in aria-describedby while it is shown. */
export const actionResultId = (slot: string) => `${slot}-result`;

function actionText(action: PluginAction, folder: string | null, language: AppLanguage): string | null {
  const game = (value: PluginGame) => BASE_COPY.getUnitGameText(value, language);
  switch (action.kind) {
    case 'manage': return t('act.plugin.manage', {game: game(action.game)}, language);
    case 'choose-folder': return t('act.plugin.chooseFolder', {game: game(action.game)}, language);
    case 'show-file': return folder === null ? null : t('act.plugin.showFile', {game: game(action.game), folder}, language);
    case 'open-folder': return folder === null ? null : t('act.plugin.openFolder', {game: game(action.game), folder}, language);
    case 'retry': return t('act.plugin.retry', undefined, language);
    case 'export-diagnostics': return t('act.diagnostics.export', undefined, language);
  }
}

function messageText(result: PluginActionResult, language: AppLanguage): string {
  const {outcome} = result;
  switch (outcome.kind) {
    case 'folder-choice': return pluginFolderChoiceText(outcome.choice, language);
    case 'show-file': return pluginShowFileText(outcome.result, language);
    case 'diagnostics-export': return diagnosticsExportText(outcome.result, language);
    case 'request-failed':
      return result.action.kind === 'export-diagnostics' ? copyTable(BASE_COPY.DIAGNOSTICS_EXPORT_STRINGS, language).failed
        : copyTable(BASE_COPY.PLUGIN_STRINGS, language).requestFailed;
  }
}

/**
 * The localized text of a result. `folder` is the already-localized label of the listed folder a show-file or open-folder
 * action used ("Steam folder 1", "Chosen folder"); null when that folder is no longer listed, and then nothing is shown.
 * Built at render time from the stored codes, so a language switch re-localizes a visible result.
 */
export function pluginActionResultText(result: PluginActionResult, folder: string | null, language: AppLanguage = 'en'): ActionResultText | null {
  const action = actionText(result.action, folder, language);
  if (action === null) return null;
  const severity = pluginActionSeverity(result.outcome);
  const severityWord = t(SEVERITY_WORD[severity], undefined, language);
  return {severity, severityWord, title: t('act.title', {severity: severityWord, action}, language), message: messageText(result, language)};
}

/** What the card action controller needs from React and the DOM, injected so that it runs and is tested without either. */
export interface PluginActionControllerPorts {
  setPending(pending: boolean): void;
  setResult(result: PluginActionResult | null): void;
  /** The focused element, or null. */
  activeElement(): unknown;
  /** The document body. */
  body(): unknown;
  /** Focuses the element with this id when it exists. */
  focus(id: string): void;
}
/** Starts one card action; answers null when another action is still pending and this one was ignored. */
export type PluginActionRun = <T>(action: PluginAction, start: () => Promise<T>, answer: (value: T) => PluginActionOutcome | null) => Promise<void> | null;

/**
 * The Game plugin card's action controller (ET-045b). One action at a time: while one is pending a further press or switch
 * toggle is ignored and starts no bridge call. Starting an action clears the shown result; its answer, or
 * `request-failed` for a rejected call, becomes the one current result. After the answer focus returns to the trigger
 * only when it was lost (the active element is the body or none, for example after a native dialog closed); it is never
 * taken from an element the user moved to. Because a new action cannot start while one is pending, no answer can belong
 * to a superseded action.
 */
export function createPluginActionController(ports: PluginActionControllerPorts): {run: PluginActionRun} {
  let pending = false;
  const run = <T,>(action: PluginAction, start: () => Promise<T>, answer: (value: T) => PluginActionOutcome | null): Promise<void> | null => {
    if (pending) return null;
    pending = true;
    ports.setPending(true); ports.setResult(null);
    const settle = (outcome: PluginActionOutcome | null) => {
      pending = false;
      ports.setPending(false); ports.setResult(outcome ? {action, outcome} : null);
      const active = ports.activeElement();
      if (active === null || active === undefined || active === ports.body()) ports.focus(pluginActionTriggerId(action));
    };
    let started: Promise<T>;
    try {started = start();} catch {started = Promise.reject(new Error('PLUGIN_ACTION_START_FAILED'));}
    return started.then(value => settle(answer(value)), () => settle({kind: 'request-failed'}));
  };
  return {run};
}
