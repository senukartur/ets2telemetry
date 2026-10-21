import type {AppLanguage, AppUninstallResult, PluginGame} from '../../../packages/contracts/src';
import {UNINSTALL_TARGET_ID} from '../../../packages/contracts/src/uninstall';
import * as BASE_COPY from './strings';
import {copyTable} from './screens/app-copy';
import type {DataEntry, WipeFailureCode} from './uninstall/data-wipe';
import type {FolderNote} from './uninstall/plugin-cleanup';

// The in-app uninstall's texts (ET-018 PR-4, plan U8 and U9): the card's answer to every result, and the result dialog
// after the data wipe. Built from fixed strings, target ids, counts and allowlisted entry names; never a path. Main and
// the dashboard both use it, so it imports no Node or Electron API.

export interface FinishedUninstallSummary {
  readonly data: {readonly kept: number; readonly failed: readonly {readonly entry: DataEntry; readonly code: WipeFailureCode}[]; readonly rootRemoved: boolean};
  readonly notes: readonly {readonly game: PluginGame; readonly note: FolderNote}[];
  readonly removed: number;
  readonly unrecognized: number;
}
function createUninstallText(language: AppLanguage) {
 const {UNINSTALL_DATA_ENTRY_TEXT, UNINSTALL_FAILURE_TEXT, UNINSTALL_NOTE_TEXT, UNINSTALL_REASON_TEXT, UNINSTALL_STRINGS, UNINSTALL_TARGET_TEXT, UNIT_GAME_TEXT} = copyTable(BASE_COPY, language);
const fill = (template: string, values: Readonly<Record<string, string | number>>) => template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key] ?? ''));
const gameText = (game: PluginGame) => UNIT_GAME_TEXT[game];

/** A blocked folder's name from its target id: `ets2:steam:0` is Steam folder 1, `ats:other` a folder no longer listed. */
function uninstallTargetText(targetId: string): string {
  if (!UNINSTALL_TARGET_ID.test(targetId)) return targetId.startsWith('ats') ? gameText('ats') : gameText('ets2');
  const [game, source, ordinal] = targetId.split(':') as [PluginGame, 'steam' | 'manual' | 'other', string | undefined];
  if (source === 'steam') return fill(UNINSTALL_TARGET_TEXT.steam, {game: gameText(game), number: Number(ordinal) + 1});
  return fill(source === 'manual' ? UNINSTALL_TARGET_TEXT.manual : UNINSTALL_TARGET_TEXT.other, {game: gameText(game)});
}

const blockedFolderLines = (blocked: readonly {targetId: string; reason: keyof typeof UNINSTALL_REASON_TEXT}[]) =>
  blocked.map(entry => fill(UNINSTALL_STRINGS.blockedFolder, {target: uninstallTargetText(entry.targetId), reason: UNINSTALL_REASON_TEXT[entry.reason]}));

/** The card's text for one result: a headline and, for a blocked or interrupted uninstall, one line per blocked folder. */
function appUninstallResultText(result: AppUninstallResult): {line: string; folders: string[]} {
  switch (result.outcome) {
    case 'cancelled': return {line: UNINSTALL_STRINGS.cancelled, folders: []};
    case 'not-installed': return {line: UNINSTALL_STRINGS.notInstalled, folders: []};
    case 'started': return {line: UNINSTALL_STRINGS.started, folders: []};
    case 'blocked': return {line: fill(UNINSTALL_STRINGS.blocked, {reason: UNINSTALL_REASON_TEXT[result.code]}),
      folders: blockedFolderLines(result.blocked)};
    case 'interrupted': return {line: fill(UNINSTALL_STRINGS.interrupted, {reason: UNINSTALL_REASON_TEXT[result.code], count: result.removed}),
      folders: blockedFolderLines(result.blocked)};
    case 'failed': return {line: fill(UNINSTALL_STRINGS.failed, {reason: UNINSTALL_FAILURE_TEXT[result.code]}), folders: []};
  }
}

/** One note as fixed text for the result dialog (PR-2 and PR-3 promised that the notes reach the user). */
const uninstallNoteText = (game: PluginGame, note: FolderNote) => fill(UNINSTALL_NOTE_TEXT[note], {game: gameText(game)});


/**
 * The error dialog when Update.exe could not be started after the wipe. It claims that the data is gone only when the
 * wipe removed every allowlisted entry and the data root; otherwise the intent stays, and an uninstall from Windows
 * Settings runs the uninstall hook, which reads that intent and wipes the rest.
 */
function handoverFailedText(summary: FinishedUninstallSummary | undefined): string {
  return summary && !summary.data.failed.length && summary.data.rootRemoved ? UNINSTALL_STRINGS.spawnFailed : UNINSTALL_STRINGS.spawnFailedPartial;
}

/**
 * The result dialog after the data wipe: what was removed and what remains, with every note. An entry the wipe did not
 * reach in its time (BUDGET_EXPIRED) stays with the intent, and the uninstall hook of the handover finishes it, so it is
 * not left to the user; only a real failure asks for deletion by hand.
 */
function finishedUninstallText(summary: FinishedUninstallSummary): {title: string; message: string; detail: string} {
  const entries = (failed: FinishedUninstallSummary['data']['failed']) => [...new Set(failed.map(entry => UNINSTALL_DATA_ENTRY_TEXT[entry.entry]))].join(', ');
  const expired = summary.data.failed.filter(entry => entry.code === 'BUDGET_EXPIRED'), failed = summary.data.failed.filter(entry => entry.code !== 'BUDGET_EXPIRED');
  const lines = [fill(UNINSTALL_STRINGS.finishedRemoved, {count: summary.removed})];
  if (summary.unrecognized) lines.push(fill(UNINSTALL_STRINGS.finishedUnrecognized, {count: summary.unrecognized}));
  for (const note of summary.notes) lines.push(uninstallNoteText(note.game, note.note));
  if (summary.data.kept) lines.push(fill(UNINSTALL_STRINGS.finishedKept, {count: summary.data.kept}));
  if (failed.length) lines.push(fill(UNINSTALL_STRINGS.finishedFailed, {entries: entries(failed)}));
  if (expired.length) lines.push(fill(UNINSTALL_STRINGS.finishedExpired, {entries: entries(expired)}));
  const message = failed.length ? UNINSTALL_STRINGS.finishedPartial : expired.length ? UNINSTALL_STRINGS.finishedPending : UNINSTALL_STRINGS.finishedMessage;
  return {title: UNINSTALL_STRINGS.finishedTitle, message, detail: lines.join('\n')};
}

 return {uninstallTargetText, appUninstallResultText, uninstallNoteText, handoverFailedText, finishedUninstallText};
}
const texts = {en: createUninstallText('en'), ru: createUninstallText('ru')};
export const uninstallTargetText = (value: Parameters<typeof texts.en.uninstallTargetText>[0], language: AppLanguage = 'en'): ReturnType<typeof texts.en.uninstallTargetText> => texts[language].uninstallTargetText(value);
export const appUninstallResultText = (value: Parameters<typeof texts.en.appUninstallResultText>[0], language: AppLanguage = 'en'): ReturnType<typeof texts.en.appUninstallResultText> => texts[language].appUninstallResultText(value);
export const uninstallNoteText = (game: PluginGame, note: FolderNote, language: AppLanguage = 'en'): string => texts[language].uninstallNoteText(game, note);
export const handoverFailedText = (value: Parameters<typeof texts.en.handoverFailedText>[0], language: AppLanguage = 'en'): ReturnType<typeof texts.en.handoverFailedText> => texts[language].handoverFailedText(value);
export const finishedUninstallText = (value: Parameters<typeof texts.en.finishedUninstallText>[0], language: AppLanguage = 'en'): ReturnType<typeof texts.en.finishedUninstallText> => texts[language].finishedUninstallText(value);
