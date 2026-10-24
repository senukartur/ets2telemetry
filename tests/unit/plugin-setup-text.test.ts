import {describe, expect, it} from 'vitest';
import type {PluginBlockReason, PluginGameView, PluginSetupView, PluginTargetState, PluginTargetView} from '../../packages/contracts/src';
import {connectionDiagnosisText, diagnosticsExportText, MANUAL_COPY_REASONS, pluginFolderChoiceText, pluginSetupText, pluginShowFileText} from '../../apps/desktop/src/plugin-setup-text';
import type {ConnectionDiagnosisCode} from '../../apps/desktop/src/connection-diagnosis';

// REG-015 (ET-017 PR-5, P16, P18): the text of the Game plugin card. Every mode, discovery outcome, folder state, target
// state, block reason and refusal has a hand-written expected text below; none of them may carry a path.

const NO_GAME: PluginGameView = {excluded: false, discovery: 'pending', manualFolder: 'none', targets: [], unlistedFolders: 0};
const view = (overrides: Partial<PluginSetupView> = {}, games: Partial<Record<'ets2' | 'ats', Partial<PluginGameView>>> = {}): PluginSetupView => ({
  mode: 'active', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false,
  games: {ets2: {...NO_GAME, ...games.ets2}, ats: {...NO_GAME, ...games.ats}}, ...overrides
});
const target = (overrides: Partial<PluginTargetView> = {}): PluginTargetView => ({id: 'ets2:steam:0', source: 'steam', ordinal: 0, state: 'installed', reason: null,
  installed: {version: '0.2.0', sha256Prefix: '0123456789ab'}, lastFailure: null, ...overrides});
const firstTarget = (value: PluginTargetView) => pluginSetupText(view({}, {ets2: {discovery: 'found', targets: [value]}})).games.ets2.targets[0];

describe('the card header', () => {
  it('describes each mode, the bundled plugin and a run in progress', () => {
    expect(pluginSetupText(view()).mode).toBeNull();
    expect(pluginSetupText(view({mode: 'test-root'})).mode).toBe('Test mode: plugin setup works only inside a test folder.');
    expect(pluginSetupText(view({mode: 'disabled'})).mode).toBe('Plugin setup is off in this launch (a development, test or opt-out launch); no game folder is changed.');
    expect(pluginSetupText(view({mode: 'disabled'})).actionable).toBe(false);
    expect(pluginSetupText(view({mode: 'test-root'})).actionable).toBe(true);
    expect(pluginSetupText(view()).bundled).toBe('Bundled plugin: 0.2.0 (0123456789ab)');
    expect(pluginSetupText(view({bundled: null})).bundled).toBe('Bundled plugin: not checked yet');
    expect(pluginSetupText(view()).running).toBeNull();
    expect(pluginSetupText(view({running: true})).running).toBe('Checking the game folders…');
  });
});

describe('a game', () => {
  it('names the game and states whether its plugin is managed', () => {
    const text = pluginSetupText(view({}, {ats: {excluded: true, discovery: 'found'}}));
    expect(text.games.ets2.title).toBe('Euro Truck Simulator 2');
    expect(text.games.ats.title).toBe('American Truck Simulator');
    expect(text.games.ets2.managed).toBe(true);
    expect(text.games.ats.managed).toBe(false);
  });

  it.each([
    ['pending', ['Looking for the game…']],
    ['found', ['Found through Steam.', 'No game folder found yet.']],
    ['not-found', ['Not found in the Steam libraries. Choose the game folder if it is installed elsewhere.', 'No game folder found yet.']],
    ['steam-not-found', ['Steam was not found. Choose the game folder if the game is installed.', 'No game folder found yet.']],
    ['steam-list-invalid', ['Steam\'s library list could not be read; only the main Steam folder was searched.', 'No game folder found yet.']]
  ] as const)('describes the discovery outcome %s', (discovery, notes) => {
    expect(pluginSetupText(view({}, {ets2: {discovery}})).games.ets2.notes).toEqual(notes);
  });

  // Review round 1 of PR-5: the disabled mode never discovers, so its pending discovery is not "Looking for the game…".
  it('says that the disabled mode does not search, for both games', () => {
    const text = pluginSetupText(view({mode: 'disabled', bundled: null}));
    expect(text.games.ets2.notes).toEqual(['Not searched in this launch.']);
    expect(text.games.ats.notes).toEqual(['Not searched in this launch.']);
    expect(text.games.ets2.targets).toEqual([]);
    expect(pluginSetupText(view({mode: 'test-root'})).games.ets2.notes).toEqual(['Looking for the game…']);
  });

  it('describes the chosen folder and the unlisted Steam folders', () => {
    const notes = (game: Partial<PluginGameView>) => pluginSetupText(view({}, {ets2: {discovery: 'found', targets: [target()], ...game}})).games.ets2.notes;
    expect(notes({manualFolder: 'none'})).toEqual(['Found through Steam.']);
    expect(notes({manualFolder: 'set'})).toEqual(['Found through Steam.', 'A chosen game folder is in use.']);
    expect(notes({manualFolder: 'invalid'})).toEqual(['Found through Steam.', 'The chosen game folder is no longer a separate, valid game folder; it is not changed.']);
    expect(notes({unlistedFolders: 1})).toEqual(['Found through Steam.',
      '1 more Steam folder of this game is not listed; the plugin is not installed there, but excluding the game removes it there too.']);
    expect(notes({unlistedFolders: 2})).toEqual(['Found through Steam.',
      '2 more Steam folders of this game are not listed; the plugin is not installed there, but excluding the game removes it there too.']);
  });
});

describe('a game folder', () => {
  it('labels a folder by its source and position only', () => {
    expect(firstTarget(target()).label).toBe('Steam folder 1');
    expect(firstTarget(target({id: 'ets2:steam:3', ordinal: 3})).label).toBe('Steam folder 4');
    expect(firstTarget(target({id: 'ets2:manual:0', source: 'manual'})).label).toBe('Chosen folder');
  });

  const STATES: Record<PluginTargetState, string> = {
    installed: 'Installed', outdated: 'Older version installed', missing: 'Not installed', excluded: 'Not managed (game excluded)', blocked: 'Blocked',
    working: 'Setting up…'
  };
  it.each(Object.entries(STATES))('names the state %s', (state, text) => {
    expect(firstTarget(target({state: state as PluginTargetState, installed: null})).status).toBe(text);
  });

  const REASONS: Record<PluginBlockReason, string> = {
    GAME_RUNNING: 'The game is running; the plugin is changed after you close it.',
    CLIENT_RUNNING: 'TruckersMP is running; the plugin is changed after you close it.',
    TARGET_LOCKED: 'Another program is using the plugin file; it is tried again later.',
    PERMISSION_DENIED: 'Windows denied access to the game\'s plugins folder.',
    READ_ONLY_FILE: 'The plugin file is read-only; it is left as it is.',
    UNRECOGNIZED_FILE: 'A file with the plugin\'s name that this application did not install is in the way; it is left as it is. Move it away, then press Retry.',
    LINKED_FOLDER: 'The game\'s folders are linked elsewhere; they are not changed.',
    DISK_FULL: 'The disk is full.',
    IO_ERROR: 'The game folder could not be read or written.',
    VERIFY_FAILED: 'The copied plugin did not match the bundled one; nothing was kept.',
    RUNNING_CHECK_FAILED: 'Running games could not be checked; it is tried again shortly.',
    REGISTRY_UNAVAILABLE: 'The plugin setup record could not be saved or is from a newer version.',
    BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged; reinstall Yukon Union Telemetry.'
  };
  const MANUAL_COPY = 'To install it by hand: close the game, copy the plugin file into the game\'s plugins folder (Windows may ask for administrator rights), then press Retry.';
  // PR #111 delta review: an unrecognized file shows only "Move it away, then press Retry", never the copy hint beside it.
  it.each(Object.entries(REASONS))('explains the reason %s, with the manual copy only after permission and read-only failures', (reason, text) => {
    const manual = ['PERMISSION_DENIED', 'READ_ONLY_FILE'].includes(reason);
    const line = firstTarget(target({state: 'missing', reason: reason as PluginBlockReason, installed: null}));
    expect(line.detail).toEqual(manual ? [text, MANUAL_COPY] : [text]);
    expect(line.manualCopy).toBe(manual);
    // "Open game plugins folder" also serves an unrecognized file, which the driver moves away by hand (P18).
    expect(line.openFolder).toBe(manual || reason === 'UNRECOGNIZED_FILE');
  });
  // PR #111 review: in an excluded game the change is a removal, so the card never suggests copying the plugin in.
  it('offers the manual removal instead of the copy in an excluded game, and nothing for an unrecognized file there', () => {
    const MANUAL_REMOVE = 'To remove it by hand: close the game, delete the plugin file from the game\'s plugins folder (Windows may ask for administrator rights), then press Retry.';
    const excludedTarget = (reason: PluginBlockReason) => pluginSetupText(view({}, {ets2: {excluded: true, discovery: 'found', targets: [target({state: 'blocked', reason,
      installed: {version: '0.2.0', sha256Prefix: '0123456789ab'}})]}})).games.ets2.targets[0];
    for (const reason of ['PERMISSION_DENIED', 'READ_ONLY_FILE'] as const) {
      const line = excludedTarget(reason);
      expect([line.detail, line.manualCopy, line.manualRemove, line.openFolder]).toEqual([[REASONS[reason], 'Installed plugin: 0.2.0 (0123456789ab)', MANUAL_REMOVE], false, true, true]);
      expect(JSON.stringify(line)).not.toContain('copy the plugin file into');
    }
    // PR #111 review: a file the installer could not read (PERMISSION_DENIED with no installed identity) may be someone
    // else's, so neither an excluded nor a managed game is told to delete or overwrite it.
    const UNREADABLE = 'The plugin file in this folder could not be read or checked, so it is left as it is.';
    const unreadable = (excluded: boolean) => pluginSetupText(view({}, {ets2: {excluded, discovery: 'found', targets: [target({state: 'blocked', reason: 'PERMISSION_DENIED',
      installed: null})]}})).games.ets2.targets[0];
    for (const excluded of [true, false]) {
      const line = unreadable(excluded);
      expect([line.detail, line.manualCopy, line.manualRemove, line.openFolder]).toEqual([[REASONS.PERMISSION_DENIED, UNREADABLE], false, false, false]);
      expect(JSON.stringify(line)).not.toMatch(/delete the plugin file|copy the plugin file into/);
    }
    // A managed game's folder whose own older plugin Windows protects still offers the copy over it.
    const owned = pluginSetupText(view({}, {ets2: {discovery: 'found', targets: [target({state: 'outdated', reason: 'PERMISSION_DENIED',
      installed: {version: '0.1.0', sha256Prefix: 'aaaaaaaaaaaa'}})]}})).games.ets2.targets[0];
    expect([owned.manualCopy, owned.manualRemove, owned.openFolder]).toEqual([true, false, true]);
    // An unrecognized file is never this application's, so the view carries no installed plugin for it.
    const unrecognized = pluginSetupText(view({}, {ets2: {excluded: true, discovery: 'found', targets: [target({state: 'blocked', reason: 'UNRECOGNIZED_FILE', installed: null})]}}))
      .games.ets2.targets[0];
    expect([unrecognized.manualCopy, unrecognized.manualRemove, unrecognized.openFolder]).toEqual([false, false, false]);
    // An excluded game installs nothing, so its unrecognized file gets no advice to move it, also as the last problem.
    const LEFT = 'A file with the plugin\'s name that this application did not install is in this folder; it is left as it is.';
    expect(unrecognized.detail).toEqual([LEFT]);
    const earlier = pluginSetupText(view({}, {ets2: {excluded: true, discovery: 'found', targets: [target({state: 'excluded', reason: null, installed: null,
      lastFailure: 'UNRECOGNIZED_FILE'})]}})).games.ets2.targets[0];
    expect(earlier.detail).toEqual([`Last problem: ${LEFT}`]);
    expect(JSON.stringify([unrecognized, earlier])).not.toContain('Move it away');
    // The same reasons in a managed game still offer the copy, never the removal.
    expect([firstTarget(target({state: 'missing', reason: 'PERMISSION_DENIED', installed: null})).manualRemove, firstTarget(target({state: 'missing', reason: 'PERMISSION_DENIED', installed: null})).manualCopy]).toEqual([false, true]);
  });
  it('offers the manual copy for exactly the P12 reasons', () => {
    // A locked file is retried automatically (review round 1 of PR-5), so it gets no manual-copy actions.
    expect([...MANUAL_COPY_REASONS].sort()).toEqual(['PERMISSION_DENIED', 'READ_ONLY_FILE']);
  });

  it('shows the installed version of a folder that is not current, and the last problem when it differs from the reason', () => {
    expect(firstTarget(target()).detail).toEqual([]);
    expect(firstTarget(target({state: 'outdated', reason: 'GAME_RUNNING', installed: {version: '0.1.0', sha256Prefix: 'aaaaaaaaaaaa'}})).detail).toEqual([
      'The game is running; the plugin is changed after you close it.', 'Installed plugin: 0.1.0 (aaaaaaaaaaaa)']);
    expect(firstTarget(target({state: 'blocked', reason: 'GAME_RUNNING', installed: {version: null, sha256Prefix: 'bbbbbbbbbbbb'}})).detail).toEqual([
      'The game is running; the plugin is changed after you close it.', 'Installed plugin: unknown version (bbbbbbbbbbbb)']);
    expect(firstTarget(target({lastFailure: 'TARGET_LOCKED'})).detail).toEqual(['Last problem: Another program is using the plugin file; it is tried again later.']);
    const unrecognized = firstTarget(target({state: 'blocked', reason: 'UNRECOGNIZED_FILE', installed: null, lastFailure: 'UNRECOGNIZED_FILE'}));
    // PR #111 delta review (P18): a managed game's unrecognized file offers only "Open game plugins folder", to move it away.
    expect([unrecognized.detail, unrecognized.manualCopy, unrecognized.manualRemove, unrecognized.openFolder]).toEqual([[REASONS.UNRECOGNIZED_FILE], false, false, true]);
  });
});

describe('call answers', () => {
  it('maps every folder choice and the show-file answer to a fixed text', () => {
    expect(pluginFolderChoiceText({outcome: 'chosen'})).toBe('Game folder saved; the plugin is being set up there.');
    expect(pluginFolderChoiceText({outcome: 'cancelled'})).toBe('No folder chosen; nothing changed.');
    const refusals = {
      FOLDER_UNSUPPORTED_PATH: 'This folder cannot be used: choose a local game folder outside the Yukon Union Telemetry folders: %LOCALAPPDATA%\\ETS2Telemetry and the program folder.',
      FOLDER_NOT_GAME: 'This folder is not a game folder of this game.',
      FOLDER_WRONG_GAME: 'This folder holds the other game.',
      FOLDER_LINKED: 'The game\'s folders in this folder are linked elsewhere; it cannot be used.',
      FOLDER_DUPLICATE: 'This game folder is already found through Steam; nothing changed.',
      SETUP_DISABLED: 'Plugin setup is off in this launch.',
      REGISTRY_UNAVAILABLE: 'The plugin setup record could not be saved.',
      BUSY: 'A folder dialog is already open.'
    } as const;
    for (const [code, text] of Object.entries(refusals)) expect(pluginFolderChoiceText({outcome: 'refused', code: code as keyof typeof refusals})).toBe(text);
    expect(pluginShowFileText({outcome: 'shown'})).toBe('The plugin file is shown in Explorer.');
    expect(pluginShowFileText({outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'})).toBe('The bundled plugin file is not available; nothing was shown.');
  });
});

// ET-017 PR-6 (P17): the card's connection diagnosis line and the answers of "Export diagnostics…".
describe('the connection diagnosis and the diagnostics export', () => {
  const DIAGNOSES: Record<ConnectionDiagnosisCode, string> = {
    SERVICE_UNAVAILABLE: 'The telemetry service is not running; see Application status.',
    CONNECTED: 'Receiving telemetry from the selected source.',
    NO_GAME_SELECTED: 'No game is selected as the source. Choose Euro Truck Simulator 2 or American Truck Simulator in Settings > Data.',
    SETUP_DISABLED: 'Not checked: plugin setup is off in this launch.',
    GAME_NOT_FOUND: 'The selected game was not found. Choose its game folder below.',
    PLUGIN_BLOCKED_PERMISSION: 'Windows did not allow the plugin file in a game folder to be read or changed. See the folder line below for what to do.',
    PLUGIN_UNRECOGNIZED: 'A file that this application did not install is in place of the plugin. Move it away, then press Retry.',
    // PR #111 review: an outdated folder may wait for the game (polled, changed automatically) or have failed with
    // VERIFY_FAILED, DISK_FULL or REGISTRY_UNAVAILABLE (not polled), so the text fits both and points to the folder line.
    PLUGIN_OUTDATED: 'An older plugin is installed. If its folder line below says it waits for the game, TruckersMP or another program, it is updated once that closes; otherwise resolve the problem shown there, then press Retry.',
    PLUGIN_PENDING_GAME_CLOSE: 'The plugin is changed automatically once the game, TruckersMP or the program using the file is closed. Then start the game again.',
    PLUGIN_BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged. Reinstall Yukon Union Telemetry.',
    PLUGIN_NOT_CHECKED: 'The plugin could not be checked in a game folder; see the folder line below.',
    PLUGIN_MISSING: 'The plugin is not installed in a game folder. Turn on "Manage the plugin for this game" or press Retry.',
    TRANSPORT_FAILED: 'The game\'s plugin could not be connected, or it is incompatible, and the connection is not tried again by itself. After the plugin is fixed, choose another source and then the game again in Settings > Data, or exit Yukon Union Telemetry from the tray and start it again.',
    NO_RUNNING_SOURCE: 'The plugin is in place. Start the game to connect.'
  };
  it.each(Object.entries(DIAGNOSES))('describes %s', (code, line) => {
    expect(connectionDiagnosisText({code: code as ConnectionDiagnosisCode, notes: []})).toEqual({line, notes: []});
  });
  it('adds the note of an older plugin on disk', () => {
    expect(connectionDiagnosisText({code: 'CONNECTED', notes: ['PLUGIN_OUTDATED_ON_DISK']})).toEqual({line: DIAGNOSES.CONNECTED,
      notes: ['A game folder still holds an older plugin. If its folder line says it waits for the game, TruckersMP or another program, it is updated once that closes; otherwise resolve the problem shown there, then press Retry.']});
  });
  // PR-6 review: another folder's problem beside a folder that holds the current plugin is a note.
  it('describes every other-folder note', () => {
    expect(connectionDiagnosisText({code: 'NO_RUNNING_SOURCE', notes: ['OTHER_FOLDER_BLOCKED_PERMISSION', 'OTHER_FOLDER_UNRECOGNIZED', 'OTHER_FOLDER_PENDING_GAME_CLOSE',
      'OTHER_FOLDER_BUNDLE_UNAVAILABLE', 'OTHER_FOLDER_NOT_CHECKED', 'OTHER_FOLDER_MISSING']})).toEqual({line: DIAGNOSES.NO_RUNNING_SOURCE, notes: [
      'Another folder of this game could not be changed because Windows denied access; see its line below.',
      'Another folder of this game holds a file that this application did not install; see its line below.',
      'Another folder of this game is changed once the game, TruckersMP or the program using the file is closed.',
      'The bundled plugin is missing or damaged, so another folder of this game was not set up. Reinstall Yukon Union Telemetry.',
      'The plugin could not be checked in another folder of this game; see its line below.',
      'Another folder of this game does not hold the plugin; see its line below.']});
  });
  it('maps every export answer to a fixed text', () => {
    expect(diagnosticsExportText({outcome: 'saved'})).toBe('Diagnostics saved.');
    expect(diagnosticsExportText({outcome: 'cancelled'})).toBe('Export cancelled. Nothing was written.');
    expect(diagnosticsExportText({outcome: 'refused', code: 'EXPORT_IN_PROGRESS'})).toBe('Another diagnostics export is still running.');
    expect(diagnosticsExportText({outcome: 'refused', code: 'EXPORT_INTERRUPTED'})).toBe('The export stopped because Yukon Union Telemetry is exiting. Nothing was written.');
    expect(diagnosticsExportText({outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'})).toBe('That location cannot be used. Choose a folder outside the Yukon Union Telemetry data folder, %LOCALAPPDATA%\\ETS2Telemetry.');
    expect(diagnosticsExportText({outcome: 'failed', code: 'BUNDLE_FAILED'})).toBe('The diagnostics could not be collected. Nothing was written.');
    expect(diagnosticsExportText({outcome: 'failed', code: 'DIALOG_FAILED'})).toBe('The Save dialog could not be opened. Nothing was written.');
    expect(diagnosticsExportText({outcome: 'failed', code: 'EXPORT_WRITE_FAILED'})).toBe('The file could not be written. A file that already had this name is unchanged.');
  });
  // PR-4 review nit: a current plugin whose install record could not be saved shows that next to Installed.
  it('shows Installed with the unsaved record for a current plugin', () => {
    const line = firstTarget(target({reason: 'REGISTRY_UNAVAILABLE'}));
    expect([line.status, line.detail, line.manualCopy]).toEqual(['Installed', ['The plugin setup record could not be saved or is from a newer version.'], false]);
  });
});

it('never puts a path into any text of a full view', () => {
  const every = (Object.keys({GAME_RUNNING: 1, UNRECOGNIZED_FILE: 1, PERMISSION_DENIED: 1}) as PluginBlockReason[]).map((reason, index) =>
    target({id: `ets2:steam:${index}`, ordinal: index, state: 'blocked', reason, lastFailure: 'IO_ERROR'}));
  const text = pluginSetupText(view({mode: 'test-root', running: true}, {
    ets2: {discovery: 'found', manualFolder: 'invalid', unlistedFolders: 2, targets: [...every, target({id: 'ets2:manual:0', source: 'manual'})]},
    ats: {excluded: true, discovery: 'steam-list-invalid', targets: [target({id: 'ats:steam:0', state: 'excluded', installed: null})]}
  }));
  expect(JSON.stringify(text)).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\|steamapps|win_x64/);
});

it('localizes static templates before inserting plugin identity and folder ordinals', () => {
  const text = pluginSetupText(view({}, {ets2: {discovery: 'found', targets: [target()]}}), 'ru');
  expect(text.bundled).toBe('Плагин в комплекте: 0.2.0 (0123456789ab)');
  expect(text.games.ets2.title).toBe('Euro Truck Simulator 2');
  expect(text.games.ets2.targets[0]).toMatchObject({id: 'ets2:steam:0', state: 'installed', label: 'Папка Steam 1', status: 'Установлен'});
  expect(pluginFolderChoiceText({outcome: 'cancelled'}, 'ru')).toBe('Папка не выбрана; ничего не изменено.');
  // ET-045b: the changed English duplicate text keeps its Russian translation (APP_COPY_KEYS follows the English text).
  expect(pluginFolderChoiceText({outcome: 'refused', code: 'FOLDER_DUPLICATE'}, 'ru')).toBe('Эта папка игры уже найдена через Steam; ничего не изменено.');
});


it.each(['NO_GAME_SELECTED', 'TRANSPORT_FAILED'] as const)('keeps effective source guidance localized after moving its selector: %s', code => {
  expect(connectionDiagnosisText({code, notes: []}, 'en').line).toContain('Settings > Data');
  expect(connectionDiagnosisText({code, notes: []}, 'en').line).not.toContain('above');
  expect(connectionDiagnosisText({code, notes: []}, 'ru').line).toContain('в разделе данных');
  expect(connectionDiagnosisText({code, notes: []}, 'ru').line).not.toContain('Settings');
});
