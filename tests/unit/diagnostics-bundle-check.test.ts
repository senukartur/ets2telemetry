import {describe, expect, it} from 'vitest';
import type {AppHealth, PluginSetupView, SettingsView} from '../../packages/contracts/src';
import {buildDiagnosticBundle, type DiagnosticBundleInput} from '../../apps/desktop/src/diagnostic-bundle';
import {checkDiagnosticsBundle, runtimeStrings, schemaTokens} from '../../scripts/ci/diagnostics-bundle-check.mjs';

// REG-015, REG-017 (ET-017 PR-6, PR #111 review): the plugin smoke's bundle checks. They run on bundles that the real
// builder made for simulated user and computer names, including names that equal schema words or redact a fact the
// smoke reads (`mode`, `root`). The names and paths are invented.

const HEALTH: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
const SETTINGS = {units: {ets2: 'metric', ats: 'us-customary'}, overlay: {layout: 'strip', sections: {}, placements: {}}, state: 'defaults', writable: true, saveError: null} as unknown as SettingsView;
const PLUGINS: PluginSetupView = {mode: 'test-root', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
  ets2: {excluded: false, discovery: 'found', manualFolder: 'set', unlistedFolders: 0, targets: []},
  ats: {excluded: true, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: []}}};
const line = (value: unknown) => JSON.stringify(value);
const RUN = 'D:\\Smoke\\.local\\ci\\packaged-0123';
/** A bundle like the plugin smoke's run B: the real builder, the given identities and the run's main and service rows. */
function bundle(identities: string[], extraFacts: Record<string, string> = {}): string {
  const input: DiagnosticBundleInput = {
    createdMs: Date.UTC(2026, 9, 17, 8, 30, 15), app: {version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: '10.0.26200'},
    health: HEALTH, settings: SETTINGS, plugins: PLUGINS, live: {status: 'waiting', selection: 'game'}, diagnosis: {code: 'NO_GAME_SELECTED', notes: []},
    logs: {main: {current: [
      line({time: '2026-10-17T08:30:00.000Z', pid: 1, event: 'PLUGIN_SETUP_MODE', facts: {mode: 'test-root', reason: null}, detail: `${RUN}\\diagnostics`}),
      line({time: '2026-10-17T08:30:02.000Z', pid: 1, event: 'PLUGIN_ACTION', facts: {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', ...extraFacts}})
    ].join('\n')}, service: {current: line({time: '2026-10-17T08:30:01.000Z', pid: 2, event: 'SERVICE_READY'})}},
    identities
  };
  return buildDiagnosticBundle(input);
}
const check = (text: string, identities: string[]) => checkDiagnosticsBundle(text, {identities, runPaths: [RUN], mainEvents: ['PLUGIN_SETUP_MODE', 'PLUGIN_ACTION']});

describe('valid bundles for names that collide with the schema or the smoke facts', () => {
  it.each(['main', 'logs', 'diagnostics', 'mode', 'root'])('accepts the bundle when the user and the computer name are %s', name => {
    const text = bundle([name, name], {owner: name});
    expect(() => check(text, [name, name])).not.toThrow();
    // The name is still gone from every runtime string.
    expect(runtimeStrings(JSON.parse(text)).some(value => new RegExp(`(?<![A-Za-z0-9])${name}(?![A-Za-z0-9])`, 'i').test(value.replaceAll('<redacted>', ' ')))).toBe(false);
  });
  it('accepts an ordinary bundle', () => {
    expect(() => check(bundle(['Jane.Doe', 'TRUCKER-PC7'], {owner: 'Jane.Doe'}), ['Jane.Doe', 'TRUCKER-PC7'])).not.toThrow();
  });
});

// PR #111 delta review: the second layer scans the whole text for every name that is not a whole word of a schema token.
describe('names outside the runtime strings', () => {
  it('derives the schema tokens from the bundle: keys and fixed values, but no fact key, fact value or OS release', () => {
    const tokens = schemaTokens(JSON.parse(bundle(['Jane.Doe'], {owner: 'jane.doe', note: 'free text'})));
    for (const token of ['format', 'ets2telemetry.diagnostics', 'logs', 'main', 'service', 'facts', 'event', 'PLUGIN_SETUP_MODE', 'test-root', 'NO_GAME_SELECTED', '0123456789ab',
      '0.2.0', '2026-10-17T08:30:15.000Z', 'osRelease']) expect(tokens).toContain(token);
    // `mode` is still a token: the plugin view has a `mode` key. Free text with whitespace is never a token.
    expect(tokens).toContain('mode');
    for (const runtime of ['owner', 'note', 'free text', '<redacted>', 'outcome', '10.0.26200']) expect(tokens).not.toContain(runtime);
  });
  it('refuses a name hidden in a free-text field outside the runtime strings', () => {
    const hidden = JSON.parse(bundle(['Jane.Doe', 'TRUCKER-PC7'])) as Record<string, unknown>;
    hidden.supportNote = 'exported by jane.doe on trucker-pc7';
    expect(() => check(JSON.stringify(hidden), ['Jane.Doe', 'TRUCKER-PC7'])).toThrow(/outside its runtime strings/);
  });
  it.each(['main', 'logs', 'diagnostics', 'mode', 'root'])('still accepts a colliding name %s, which is a whole word of a schema token', name => {
    const text = bundle([name, name], {owner: name});
    expect(() => check(text, [name, name])).not.toThrow();
  });
});

describe('leaks and broken bundles', () => {
  const valid = () => JSON.parse(bundle(['Jane.Doe', 'TRUCKER-PC7'])) as {app: {osRelease: string}; logs: {main: {event: string; facts?: Record<string, unknown>; detail?: unknown}[]; service: unknown[]}};
  const fails = (value: unknown, message: RegExp) => expect(() => check(JSON.stringify(value), ['Jane.Doe', 'TRUCKER-PC7'])).toThrow(message);
  it('refuses a name in a fact value, a fact key or the OS release', () => {
    const inValue = valid(); inValue.logs.main[1].facts!.owner = 'jane.doe'; fails(inValue, /user or computer name/);
    const inKey = valid(); inKey.logs.main[1].facts!['TRUCKER-PC7'] = 1; fails(inKey, /user or computer name/);
    const inRelease = valid(); inRelease.app.osRelease = '10.0 trucker-pc7'; fails(inRelease, /user or computer name/);
  });
  it('refuses a missing main row, an empty service log and a kept detail', () => {
    const missing = valid(); missing.logs.main = missing.logs.main.filter(row => row.event !== 'PLUGIN_ACTION'); fails(missing, /PLUGIN_ACTION/);
    const empty = valid(); empty.logs.service = []; fails(empty, /service log rows/);
    const detail = valid(); detail.logs.main[0].detail = 'x'; fails(detail, /log detail/);
  });
  it('refuses a drive path or a run folder anywhere in the text', () => {
    const drive = valid(); drive.logs.main[1].facts!.where = 'C:\\Users'; fails(drive, /carries a path/);
    const run = valid(); run.logs.main[1].facts!.where = RUN; fails(run, /run path/);
  });
});
