import {describe, expect, it} from 'vitest';
import type {AppHealth, LiveTelemetry, PluginBlockReason, PluginGameView, PluginSetupView, PluginTargetView, SourceSelection} from '../../packages/contracts/src';
import {CONNECTION_DIAGNOSIS_CODES, connectionDiagnosis, type ConnectionDiagnosisCode} from '../../apps/desktop/src/connection-diagnosis';

// REG-015, REG-017 (ET-017 PR-6, P17): the connection diagnosis. Every row of the hand-written precedence table below
// names its inputs and the one code that must win; the pair rows show that each code beats the one after it.

const READY: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
const target = (state: PluginTargetView['state'], reason: PluginBlockReason | null = null, id = 'ets2:steam:0'): PluginTargetView =>
  ({id, source: id.includes('manual') ? 'manual' : 'steam', ordinal: 0, state, reason, installed: null, lastFailure: null});
const game = (targets: PluginTargetView[], overrides: Partial<PluginGameView> = {}): PluginGameView =>
  ({excluded: false, discovery: 'found', manualFolder: 'none', targets, unlistedFolders: 0, ...overrides});
const INSTALLED = game([target('installed')]);
const view = (ets2: PluginGameView = INSTALLED, mode: PluginSetupView['mode'] = 'active', ats: PluginGameView = game([target('installed', null, 'ats:steam:0')])): PluginSetupView =>
  ({mode, bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {ets2, ats}});

interface Row {
  name: string;
  plugins?: PluginSetupView;
  status?: LiveTelemetry['status'];
  selection?: SourceSelection;
  health?: AppHealth;
  code: ConnectionDiagnosisCode;
}
const TABLE: Row[] = [
  // 1. SERVICE_UNAVAILABLE: the service is not ready, or the live status says it failed or restarts. It beats CONNECTED.
  {name: 'service starting', health: {...READY, service: 'starting'}, status: 'connected', code: 'SERVICE_UNAVAILABLE'},
  {name: 'service restarting', health: {...READY, service: 'restarting'}, code: 'SERVICE_UNAVAILABLE'},
  {name: 'service failed', health: {...READY, service: 'failed', lastError: 'SERVICE_RESTART_EXHAUSTED'}, code: 'SERVICE_UNAVAILABLE'},
  {name: 'service stopping', health: {...READY, service: 'stopping'}, code: 'SERVICE_UNAVAILABLE'},
  {name: 'live status service-failed', status: 'service-failed', code: 'SERVICE_UNAVAILABLE'},
  {name: 'live status restarting', status: 'restarting', code: 'SERVICE_UNAVAILABLE'},
  // 2. CONNECTED: connected or paused, for any selection and mode; it beats every plugin row.
  {name: 'connected', status: 'connected', code: 'CONNECTED'},
  {name: 'paused', status: 'paused', code: 'CONNECTED'},
  {name: 'connected beats an unrecognized file', status: 'connected', plugins: view(game([target('blocked', 'UNRECOGNIZED_FILE')])), code: 'CONNECTED'},
  {name: 'connected synthetic fixture', status: 'connected', selection: 'synthetic', code: 'CONNECTED'},
  {name: 'connected in the disabled mode', status: 'connected', plugins: view(game([], {discovery: 'pending'}), 'disabled'), code: 'CONNECTED'},
  // 3. NO_GAME_SELECTED: the placeholder or a fixture that is not connected; it beats SETUP_DISABLED.
  {name: 'the "Select a game" placeholder', selection: 'game', code: 'NO_GAME_SELECTED'},
  {name: 'a synthetic fixture waiting', selection: 'synthetic', code: 'NO_GAME_SELECTED'},
  {name: 'a replay fixture disconnected', selection: 'replay', status: 'disconnected', code: 'NO_GAME_SELECTED'},
  {name: 'placeholder beats the disabled mode', selection: 'game', plugins: view(game([], {discovery: 'pending'}), 'disabled'), code: 'NO_GAME_SELECTED'},
  // 4. SETUP_DISABLED: no folder was checked in this launch; it beats GAME_NOT_FOUND.
  {name: 'disabled mode', plugins: view(game([], {discovery: 'pending'}), 'disabled'), code: 'SETUP_DISABLED'},
  {name: 'disabled beats not found', plugins: view(game([], {discovery: 'not-found'}), 'disabled'), status: 'unavailable', code: 'SETUP_DISABLED'},
  // 5. GAME_NOT_FOUND: discovery finished without a folder of the selected game; the other game does not count.
  {name: 'not found', plugins: view(game([], {discovery: 'not-found'})), code: 'GAME_NOT_FOUND'},
  {name: 'no Steam', plugins: view(game([], {discovery: 'steam-not-found'})), code: 'GAME_NOT_FOUND'},
  {name: 'unreadable library list', plugins: view(game([], {discovery: 'steam-list-invalid'})), code: 'GAME_NOT_FOUND'},
  {name: 'ATS selected and not found while ETS2 is installed', selection: 'ats', plugins: view(INSTALLED, 'active', game([], {discovery: 'not-found'})), code: 'GAME_NOT_FOUND'},
  {name: 'the test-root mode as active', plugins: view(game([], {discovery: 'not-found'}), 'test-root'), code: 'GAME_NOT_FOUND'},
  // 6. PLUGIN_BLOCKED_PERMISSION beats PLUGIN_UNRECOGNIZED in another folder of the same game.
  {name: 'permission denied', plugins: view(game([target('missing', 'PERMISSION_DENIED')])), code: 'PLUGIN_BLOCKED_PERMISSION'},
  {name: 'read-only file', plugins: view(game([target('outdated', 'READ_ONLY_FILE')])), code: 'PLUGIN_BLOCKED_PERMISSION'},
  {name: 'permission beats unrecognized', plugins: view(game([target('blocked', 'UNRECOGNIZED_FILE', 'ets2:manual:0'), target('missing', 'PERMISSION_DENIED')])), code: 'PLUGIN_BLOCKED_PERMISSION'},
  // 7. PLUGIN_UNRECOGNIZED beats PLUGIN_OUTDATED, also when another folder is installed.
  {name: 'unrecognized file beside an installed folder', plugins: view(game([target('installed'), target('blocked', 'UNRECOGNIZED_FILE', 'ets2:manual:0')])), code: 'PLUGIN_UNRECOGNIZED'},
  {name: 'unrecognized beats outdated', plugins: view(game([target('outdated', 'GAME_RUNNING'), target('blocked', 'UNRECOGNIZED_FILE', 'ets2:manual:0')])), code: 'PLUGIN_UNRECOGNIZED'},
  // 8. PLUGIN_OUTDATED, from the hash on disk, beats PLUGIN_PENDING_GAME_CLOSE.
  {name: 'outdated', plugins: view(game([target('outdated', 'VERIFY_FAILED')])), code: 'PLUGIN_OUTDATED'},
  {name: 'outdated beats pending', plugins: view(game([target('missing', 'CLIENT_RUNNING', 'ets2:manual:0'), target('outdated', 'GAME_RUNNING')])), code: 'PLUGIN_OUTDATED'},
  // 9. PLUGIN_PENDING_GAME_CLOSE beats PLUGIN_MISSING.
  {name: 'game running', plugins: view(game([target('missing', 'GAME_RUNNING')])), code: 'PLUGIN_PENDING_GAME_CLOSE'},
  {name: 'TruckersMP running', plugins: view(game([target('missing', 'CLIENT_RUNNING')])), code: 'PLUGIN_PENDING_GAME_CLOSE'},
  {name: 'locked file', plugins: view(game([target('missing', 'TARGET_LOCKED')])), code: 'PLUGIN_PENDING_GAME_CLOSE'},
  {name: 'pending beats missing', plugins: view(game([target('missing', 'DISK_FULL', 'ets2:manual:0'), target('missing', 'GAME_RUNNING')])), code: 'PLUGIN_PENDING_GAME_CLOSE'},
  // 10. PLUGIN_MISSING beats TRANSPORT_FAILED.
  {name: 'missing without a reason', plugins: view(game([target('missing')])), code: 'PLUGIN_MISSING'},
  {name: 'blocked by a disk failure', plugins: view(game([target('blocked', 'IO_ERROR')])), code: 'PLUGIN_MISSING'},
  {name: 'missing bundle', plugins: view(game([target('blocked', 'BUNDLE_UNAVAILABLE')])), code: 'PLUGIN_MISSING'},
  {name: 'an excluded game', plugins: view(game([target('excluded')], {excluded: true})), code: 'PLUGIN_MISSING'},
  {name: 'missing beats transport', plugins: view(game([target('missing', 'RUNNING_CHECK_FAILED')])), status: 'incompatible', code: 'PLUGIN_MISSING'},
  // 11. TRANSPORT_FAILED: the plugin is in place, but the connection failed; it beats NO_RUNNING_SOURCE.
  {name: 'incompatible', status: 'incompatible', code: 'TRANSPORT_FAILED'},
  {name: 'unavailable', status: 'unavailable', code: 'TRANSPORT_FAILED'},
  // A current plugin whose record could not be saved is in place: it is not missing.
  {name: 'installed with an unsaved record', plugins: view(game([target('installed', 'REGISTRY_UNAVAILABLE')])), status: 'unavailable', code: 'TRANSPORT_FAILED'},
  // 12. NO_RUNNING_SOURCE: anything else.
  {name: 'waiting', status: 'waiting', code: 'NO_RUNNING_SOURCE'},
  {name: 'stale', status: 'stale', code: 'NO_RUNNING_SOURCE'},
  {name: 'disconnected', status: 'disconnected', code: 'NO_RUNNING_SOURCE'},
  {name: 'a folder still being set up', plugins: view(game([target('working')])), code: 'NO_RUNNING_SOURCE'},
  {name: 'discovery still pending', plugins: view(game([], {discovery: 'pending'})), code: 'NO_RUNNING_SOURCE'},
  {name: 'a problem in the other game only', selection: 'ats', plugins: view(game([target('blocked', 'UNRECOGNIZED_FILE')])), code: 'NO_RUNNING_SOURCE'}
];

describe('the precedence table (P17)', () => {
  it.each(TABLE)('$name: $code', row => {
    expect(connectionDiagnosis(row.plugins ?? view(), row.status ?? 'waiting', row.selection ?? 'ets2', row.health ?? READY)).toEqual({code: row.code, notes: []});
  });
  it('lists the twelve codes in the plan\'s order, and the table reaches every one', () => {
    expect(CONNECTION_DIAGNOSIS_CODES).toEqual(['SERVICE_UNAVAILABLE', 'CONNECTED', 'NO_GAME_SELECTED', 'SETUP_DISABLED', 'GAME_NOT_FOUND', 'PLUGIN_BLOCKED_PERMISSION',
      'PLUGIN_UNRECOGNIZED', 'PLUGIN_OUTDATED', 'PLUGIN_PENDING_GAME_CLOSE', 'PLUGIN_MISSING', 'TRANSPORT_FAILED', 'NO_RUNNING_SOURCE']);
    expect(new Set(TABLE.map(row => row.code))).toEqual(new Set(CONNECTION_DIAGNOSIS_CODES));
  });
});

describe('the connected note', () => {
  it('notes an older plugin on disk of the selected game while connected', () => {
    const outdated = view(game([target('installed'), target('outdated', 'GAME_RUNNING', 'ets2:manual:0')]));
    expect(connectionDiagnosis(outdated, 'connected', 'ets2', READY)).toEqual({code: 'CONNECTED', notes: ['PLUGIN_OUTDATED_ON_DISK']});
    expect(connectionDiagnosis(outdated, 'paused', 'ets2', READY)).toEqual({code: 'CONNECTED', notes: ['PLUGIN_OUTDATED_ON_DISK']});
    // Not for the other game, and not while not connected (the outdated row explains it then).
    expect(connectionDiagnosis(outdated, 'connected', 'ats', READY)).toEqual({code: 'CONNECTED', notes: []});
    expect(connectionDiagnosis(outdated, 'waiting', 'ets2', READY)).toEqual({code: 'PLUGIN_OUTDATED', notes: []});
  });
});
