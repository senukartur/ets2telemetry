import {describe, expect, it} from 'vitest';
import type {UninstallBlockCode, UninstallFailureCode} from '../../packages/contracts/src';
import {JOURNAL_EXPORT_STRINGS, UNINSTALL_DATA_ENTRY_TEXT, UNINSTALL_FAILURE_TEXT, UNINSTALL_NOTE_TEXT, UNINSTALL_REASON_TEXT, UNINSTALL_STRINGS} from '../../apps/desktop/src/strings';
import {appUninstallResultText, finishedUninstallText, uninstallNoteText, uninstallTargetText} from '../../apps/desktop/src/uninstall-text';
import {DATA_ALLOWLIST} from '../../apps/desktop/src/uninstall/data-wipe';

// ET-018 PR-4 (U8, U9): every in-app uninstall answer, reason, note and the warning have fixed text without a path.

const BLOCK_CODES: UninstallBlockCode[] = ['GAME_RUNNING', 'CLIENT_RUNNING', 'TARGET_LOCKED', 'PERMISSION_DENIED', 'READ_ONLY_FILE', 'UNRECOGNIZED_FILE', 'LINKED_FOLDER',
  'DISK_FULL', 'IO_ERROR', 'VERIFY_FAILED', 'RUNNING_CHECK_FAILED', 'REGISTRY_UNAVAILABLE', 'BUNDLE_UNAVAILABLE', 'FOLDER_UNAVAILABLE', 'BUDGET_EXPIRED',
  'REGISTRY_INVALID', 'REGISTRY_NEWER', 'REGISTRY_UNREADABLE'];
const FAILURES: UninstallFailureCode[] = ['ROOT_MISMATCH', 'LAYOUT_INVALID', 'DATA_ROOT_LINKED', 'TEST_ROOT_INVALID', 'BUSY', 'DIALOG_FAILED', 'INTENT_FAILED', 'ENGINE_FAILED'];
const NO_PATH = /[A-Za-z]:\\/;

describe('the warning (U9)', () => {
  it('names everything the owner\'s rule deletes, what stays and when the plugin goes', () => {
    const warning = UNINSTALL_STRINGS.warning.join(' ');
    for (const word of ['trip history', 'not synchronized', 'backups', 'settings', 'logs', 'captures', 'synthetic recordings']) expect(warning).toContain(word);
    expect(warning).toContain('Trip exports you saved elsewhere stay');
    expect(warning).toContain('game plugin is removed from your game folders while the games are closed');
  });
  it('the journal\'s export note names history and settings and keeps "cannot be imported"', () => {
    expect(JOURNAL_EXPORT_STRINGS.note).toContain('trip history and settings');
    expect(JOURNAL_EXPORT_STRINGS.note).toContain('cannot be imported');
  });
});

describe('answers', () => {
  it('has a fixed text for every outcome', () => {
    expect(appUninstallResultText({outcome: 'cancelled'})).toEqual({line: UNINSTALL_STRINGS.cancelled, folders: []});
    expect(appUninstallResultText({outcome: 'not-installed'}).line).toContain('available only in an installed copy');
    expect(appUninstallResultText({outcome: 'started'}).line).toBe(UNINSTALL_STRINGS.started);
  });
  it.each(BLOCK_CODES)('explains the block reason %s, with every blocked folder', code => {
    expect(UNINSTALL_REASON_TEXT[code]).toMatch(/\S/);
    const text = appUninstallResultText({outcome: 'blocked', code, blocked: [{targetId: 'ets2:steam:1', reason: code === 'REGISTRY_INVALID' ? 'GAME_RUNNING' : code as never},
      {targetId: 'ats:other', reason: 'CLIENT_RUNNING'}]});
    expect(text.line).toContain(UNINSTALL_REASON_TEXT[code]);
    expect(text.folders).toHaveLength(2);
    expect(text.folders[0]).toMatch(/^Euro Truck Simulator 2 \(Steam folder 2\): /);
    expect(text.folders[1]).toMatch(/^American Truck Simulator \(a folder that is no longer listed\): TruckersMP is running/);
    expect(JSON.stringify(text)).not.toMatch(NO_PATH);
  });
  it.each(FAILURES)('explains the failure %s', code => {
    const text = appUninstallResultText({outcome: 'failed', code});
    expect(text.line).toContain(UNINSTALL_FAILURE_TEXT[code]);
  });
  it('tells the in-app path to run the uninstall again after ENGINE_FAILED', () => {
    expect(UNINSTALL_FAILURE_TEXT.ENGINE_FAILED).toContain('run the uninstall again');
  });
  it('names a target by game and folder kind', () => {
    expect(uninstallTargetText('ets2:steam:0')).toBe('Euro Truck Simulator 2 (Steam folder 1)');
    expect(uninstallTargetText('ats:manual:0')).toBe('American Truck Simulator (chosen folder)');
    expect(uninstallTargetText('ets2:other')).toBe('Euro Truck Simulator 2 (a folder that is no longer listed)');
  });
});

describe('the result dialog', () => {
  it('shows every note as fixed text (plugins.notes reach the user)', () => {
    for (const note of Object.keys(UNINSTALL_NOTE_TEXT) as (keyof typeof UNINSTALL_NOTE_TEXT)[]) {
      const text = finishedUninstallText({data: {kept: 0, failed: [], rootRemoved: true}, notes: [{game: 'ats', note}], removed: 1, unrecognized: 0});
      expect(text.detail).toContain(uninstallNoteText('ats', note));
      expect(text.detail).toContain('American Truck Simulator');
    }
  });
  it('says what remains: unknown entries, failed entries and unrecognized plugin files', () => {
    const text = finishedUninstallText({data: {kept: 2, failed: [{entry: 'logs', code: 'TARGET_LOCKED'}, {entry: 'captures', code: 'READ_ONLY_FILE'}], rootRemoved: false},
      notes: [], removed: 1, unrecognized: 1});
    expect(text.message).toBe(UNINSTALL_STRINGS.finishedPartial);
    expect(text.detail).toContain('Plugin files removed: 1.');
    expect(text.detail).toContain('did not install were left as they are: 1');
    expect(text.detail).toContain('does not know were kept: 2');
    expect(text.detail).toContain('Could not be deleted: logs, captures.');
  });
  it('a complete wipe says so', () => {
    expect(finishedUninstallText({data: {kept: 0, failed: [], rootRemoved: true}, notes: [], removed: 2, unrecognized: 0}).message).toBe(UNINSTALL_STRINGS.finishedMessage);
  });
  it('has a name for every allowlisted data entry', () => {
    for (const entry of DATA_ALLOWLIST) expect(UNINSTALL_DATA_ENTRY_TEXT[entry]).toMatch(/\S/);
  });
});
