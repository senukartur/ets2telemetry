import {describe, expect, it} from 'vitest';
import type {PluginBlockReason, PluginGameView, PluginSetupView, PluginTargetState, PluginTargetView} from '../../packages/contracts/src';
import {MANUAL_COPY_REASONS, pluginFolderChoiceText, pluginSetupText, pluginShowFileText} from '../../apps/desktop/src/plugin-setup-text';

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
    BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged; reinstall ETS2Telemetry.'
  };
  const MANUAL_COPY = 'To install it by hand: close the game, copy the plugin file into the game\'s plugins folder (Windows may ask for administrator rights), then press Retry.';
  it.each(Object.entries(REASONS))('explains the reason %s, with the manual copy only after permission, read-only, unrecognized and lock failures', (reason, text) => {
    const manual = ['PERMISSION_DENIED', 'READ_ONLY_FILE', 'UNRECOGNIZED_FILE', 'TARGET_LOCKED'].includes(reason);
    const line = firstTarget(target({state: 'missing', reason: reason as PluginBlockReason, installed: null}));
    expect(line.detail).toEqual(manual ? [text, MANUAL_COPY] : [text]);
    expect(line.manualCopy).toBe(manual);
  });
  it('offers the manual copy for exactly the P12 reasons', () => {
    expect([...MANUAL_COPY_REASONS].sort()).toEqual(['PERMISSION_DENIED', 'READ_ONLY_FILE', 'TARGET_LOCKED', 'UNRECOGNIZED_FILE']);
  });

  it('shows the installed version of a folder that is not current, and the last problem when it differs from the reason', () => {
    expect(firstTarget(target()).detail).toEqual([]);
    expect(firstTarget(target({state: 'outdated', reason: 'GAME_RUNNING', installed: {version: '0.1.0', sha256Prefix: 'aaaaaaaaaaaa'}})).detail).toEqual([
      'The game is running; the plugin is changed after you close it.', 'Installed plugin: 0.1.0 (aaaaaaaaaaaa)']);
    expect(firstTarget(target({state: 'blocked', reason: 'GAME_RUNNING', installed: {version: null, sha256Prefix: 'bbbbbbbbbbbb'}})).detail).toEqual([
      'The game is running; the plugin is changed after you close it.', 'Installed plugin: unknown version (bbbbbbbbbbbb)']);
    expect(firstTarget(target({lastFailure: 'TARGET_LOCKED'})).detail).toEqual(['Last problem: Another program is using the plugin file; it is tried again later.']);
    expect(firstTarget(target({state: 'blocked', reason: 'UNRECOGNIZED_FILE', installed: null, lastFailure: 'UNRECOGNIZED_FILE'})).detail).toEqual([
      REASONS.UNRECOGNIZED_FILE, MANUAL_COPY]);
  });
});

describe('call answers', () => {
  it('maps every folder choice and the show-file answer to a fixed text', () => {
    expect(pluginFolderChoiceText({outcome: 'chosen'})).toBe('Game folder saved; the plugin is being set up there.');
    expect(pluginFolderChoiceText({outcome: 'cancelled'})).toBe('No folder chosen; nothing changed.');
    const refusals = {
      FOLDER_UNSUPPORTED_PATH: 'This folder cannot be used: choose a local game folder outside the ETS2Telemetry folders.',
      FOLDER_NOT_GAME: 'This folder is not a game folder of this game.',
      FOLDER_WRONG_GAME: 'This folder holds the other game.',
      FOLDER_LINKED: 'The game\'s folders in this folder are linked elsewhere; it cannot be used.',
      FOLDER_DUPLICATE: 'This game folder is already found through Steam.',
      SETUP_DISABLED: 'Plugin setup is off in this launch.',
      REGISTRY_UNAVAILABLE: 'The plugin setup record could not be saved.',
      BUSY: 'A folder dialog is already open.'
    } as const;
    for (const [code, text] of Object.entries(refusals)) expect(pluginFolderChoiceText({outcome: 'refused', code: code as keyof typeof refusals})).toBe(text);
    expect(pluginShowFileText({outcome: 'shown'})).toBe('The plugin file is shown in Explorer.');
    expect(pluginShowFileText({outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'})).toBe('The bundled plugin file is not available; nothing was shown.');
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
