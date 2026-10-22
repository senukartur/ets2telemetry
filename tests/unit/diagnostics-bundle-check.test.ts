import {describe, expect, it} from 'vitest';
import type {AppHealth, AppLanguage, LiveTelemetry, OverlayLayout, OverlaySectionId, PluginDiscoveryOutcome, PluginGame, PluginManualFolderState, PluginSetupMode, PluginSetupView, PluginTargetState,
  PluginTargetView, RecordingHealth, RecordingTarget, RecordingTrip, ServiceHealth, SettingsState, SettingsView, SourceSelection, StorageHealth, UnitProfile} from '../../packages/contracts/src';
import {DEFAULT_OVERLAY_SETTINGS} from '../../apps/desktop/src/overlay-sections';
import {buildDiagnosticBundle, type DiagnosticBundleInput} from '../../apps/desktop/src/diagnostic-bundle';
import {checkDiagnosticsBundle, ENUMS, runtimeStrings, schemaTokens} from '../../scripts/ci/diagnostics-bundle-check.mjs';

// REG-015, REG-017 (ET-017 PR-6, PR #111 review): the plugin smoke's bundle checks. They run on bundles that the real
// builder made for simulated user and computer names, including names that equal schema words or redact a fact the
// smoke reads (`mode`, `root`). The names and paths are invented.

const HEALTH: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
const SETTINGS: SettingsView = {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY_SETTINGS, state: 'defaults', writable: true, saveError: null};
const PLUGINS: PluginSetupView = {mode: 'test-root', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
  ets2: {excluded: false, discovery: 'found', manualFolder: 'set', unlistedFolders: 0, targets: []},
  ats: {excluded: true, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: []}}};
const line = (value: unknown) => JSON.stringify(value);
const RUN = 'D:\\Smoke\\.local\\ci\\packaged-0123';
/** A bundle like the plugin smoke's run B: the real builder, the given identities and the run's main and service rows. */
function bundle(identities: string[], extraFacts: Record<string, string> = {}, overrides: Partial<DiagnosticBundleInput> = {}): string {
  const input: DiagnosticBundleInput = {
    createdMs: Date.UTC(2026, 9, 17, 8, 30, 15), app: {version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: '10.0.26200'},
    health: HEALTH, settings: SETTINGS, plugins: PLUGINS, live: {status: 'waiting', selection: 'game'}, diagnosis: {code: 'NO_GAME_SELECTED', notes: []},
    logs: {main: {current: [
      line({time: '2026-10-17T08:30:00.000Z', pid: 1, event: 'PLUGIN_SETUP_MODE', facts: {mode: 'test-root', reason: null}, detail: `${RUN}\\diagnostics`}),
      line({time: '2026-10-17T08:30:02.000Z', pid: 1, event: 'PLUGIN_ACTION', facts: {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', ...extraFacts}})
    ].join('\n')}, service: {current: line({time: '2026-10-17T08:30:01.000Z', pid: 2, event: 'SERVICE_READY'})}},
    identities, ...overrides
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
  // PR #111 review: tokens come only from known keys and fixed values at their locations, and any other field fails, so
  // no leak can vouch for itself, whatever its form.
  it.each([['a computer-style identifier', 'trucker-pc7'], ['the bare name', 'jane.doe'], ['a name-pc identifier', 'jane.doe-pc']])('refuses %s in a new whitespace-free field', (_label, value) => {
    const hidden = JSON.parse(bundle(['Jane.Doe', 'TRUCKER-PC7'])) as Record<string, unknown>;
    hidden.owner = value;
    expect(() => schemaTokens(hidden)).toThrow(/unexpected field in bundle$/);
    expect(() => check(JSON.stringify(hidden), ['Jane.Doe', 'TRUCKER-PC7'])).toThrow(/unexpected field/);
  });
  it.each([['a single-token name', 'Jane.Doe', 'Jane.Doe'], ['a code-shaped computer name', 'MY_PC', 'MY_PC'], ['a name equal to an enum word', 'ready', 'ready']])(
    'refuses %s in an unexpected field', (_label, value, identity) => {
      const hidden = JSON.parse(bundle([identity])) as Record<string, unknown>;
      hidden.supportNote = value;
      expect(() => check(JSON.stringify(hidden), [identity])).toThrow(/unexpected field in bundle$/);
    });
  it('refuses an unexpected key equal to the identity, also nested and in a map of fixed keys', () => {
    const top = JSON.parse(bundle(['MY_PC'])) as Record<string, unknown>; top.MY_PC = true;
    expect(() => check(JSON.stringify(top), ['MY_PC'])).toThrow(/unexpected field in bundle$/);
    const nested = JSON.parse(bundle(['MY_PC'])) as {live: Record<string, unknown>}; nested.live.MY_PC = 'waiting';
    expect(() => check(JSON.stringify(nested), ['MY_PC'])).toThrow(/unexpected field in bundle\.live$/);
    const mapped = JSON.parse(bundle(['MY_PC'])) as {plugins: {games: Record<string, unknown>}}; mapped.plugins.games.MY_PC = mapped.plugins.games.ets2;
    expect(() => check(JSON.stringify(mapped), ['MY_PC'])).toThrow(/unexpected field in bundle\.plugins\.games$/);
  });
  it('refuses a fixed field whose value does not fit its location', () => {
    const wrong = JSON.parse(bundle(['MY_PC'])) as {live: {status: string}}; wrong.live.status = 'MY_PC';
    expect(() => check(JSON.stringify(wrong), ['MY_PC'])).toThrow(/unexpected value at bundle\.live\.status$/);
  });
  it('keeps each enum list equal to its contract union', () => {
    // Each record must name every member of its union, so a new member fails the typecheck until it is added here and to
    // ENUMS.
    const unions: Record<keyof typeof ENUMS, Record<string, true>> = {
      serviceHealth: {starting: true, ready: true, restarting: true, failed: true, stopping: true} satisfies Record<ServiceHealth, true>,
      storageHealth: {pending: true, verified: true, failed: true} satisfies Record<StorageHealth, true>,
      recordingState: {disabled: true, unknown: true, opening: true, waiting: true, recording: true, paused: true, interrupted: true, retrying: true, 'not-recorded-source': true,
        'live-only': true, stopped: true} satisfies Record<RecordingHealth['state'], true>,
      recordingTarget: {history: true, synthetic: true, replay: true} satisfies Record<RecordingTarget, true>,
      tripPhase: {idle: true, active: true, 'awaiting-outcome': true, 'reload-check': true} satisfies Record<RecordingTrip['phase'], true>,
      tripCompleteness: {unknown: true, partial: true, complete: true} satisfies Record<NonNullable<RecordingTrip['completeness']>, true>,
      language: {en: true, ru: true} satisfies Record<AppLanguage, true>,
      unitProfile: {metric: true, 'us-customary': true} satisfies Record<UnitProfile, true>,
      overlayLayout: {strip: true, card: true, cluster: true, hud: true} satisfies Record<OverlayLayout, true>,
      settingsState: {loading: true, defaults: true, loaded: true, 'loaded-with-fallbacks': true, 'invalid-file': true, 'unsupported-older': true, 'newer-version': true,
        unreadable: true, unavailable: true} satisfies Record<SettingsState, true>,
      pluginMode: {active: true, 'test-root': true, disabled: true} satisfies Record<PluginSetupMode, true>,
      pluginGame: {ets2: true, ats: true} satisfies Record<PluginGame, true>,
      discovery: {pending: true, found: true, 'not-found': true, 'steam-not-found': true, 'steam-list-invalid': true} satisfies Record<PluginDiscoveryOutcome, true>,
      manualFolder: {none: true, set: true, invalid: true} satisfies Record<PluginManualFolderState, true>,
      targetState: {installed: true, outdated: true, missing: true, excluded: true, blocked: true, working: true} satisfies Record<PluginTargetState, true>,
      targetSource: {steam: true, manual: true} satisfies Record<PluginTargetView['source'], true>,
      selection: {game: true, ets2: true, ats: true, synthetic: true, replay: true} satisfies Record<SourceSelection, true>,
      liveStatus: {waiting: true, connected: true, paused: true, stale: true, incompatible: true, disconnected: true, unavailable: true, 'service-failed': true,
        restarting: true} satisfies Record<LiveTelemetry['status'], true>
,
      overlaySection: {speed: true, gear: true, rpm: true, fuel: true, range: true, 'sdk-consumption': true, cargo: true, origin: true, destination: true,
        'distance-driven': true, 'distance-remaining': true, deadline: true, 'expected-income': true, 'game-time': true} satisfies Record<OverlaySectionId, true>
    };
    for (const [name, union] of Object.entries(unions)) expect([...ENUMS[name as keyof typeof ENUMS]].sort(), name).toEqual(Object.keys(union).sort());
    expect(Object.keys(ENUMS).sort()).toEqual(Object.keys(unions).sort());
  });
  it('refuses a name hidden in a free-text field outside the runtime strings', () => {
    const hidden = JSON.parse(bundle(['Jane.Doe', 'TRUCKER-PC7'])) as Record<string, unknown>;
    hidden.supportNote = 'exported by jane.doe on trucker-pc7';
    expect(() => check(JSON.stringify(hidden), ['Jane.Doe', 'TRUCKER-PC7'])).toThrow(/unexpected field in bundle$/);
  });
  it.each(['main', 'logs', 'diagnostics', 'mode', 'root'])('still accepts a colliding name %s, which is a whole word of a schema token', name => {
    const text = bundle([name, name], {owner: name});
    expect(() => check(text, [name, name])).not.toThrow();
  });
});

// PR #111 delta review: other product-built variants of the views also fit the version 1 structure.
describe('current settings visibility contract', () => {
  it.each([false, true])('accepts a production-built diagnostic bundle with enabled=%s', enabled => {
    const text = bundle([], {}, {settings: {...SETTINGS, overlay: {...SETTINGS.overlay, enabled}}});
    expect(() => check(text, [])).not.toThrow();
    expect(schemaTokens(JSON.parse(text))).toContain('enabled');
    expect(JSON.parse(text)).toMatchObject({settings: {overlay: {enabled}}});
  });
  it.each([undefined, null, 0, 1, 'false', {}, []])('rejects missing or nonboolean enabled=%j', enabled => {
    const value = JSON.parse(bundle([])) as {settings: {overlay: Record<string, unknown>}};
    if (enabled === undefined) delete value.settings.overlay.enabled; else value.settings.overlay.enabled = enabled;
    expect(() => check(JSON.stringify(value), [])).toThrow(/bundle\.settings\.overlay\.enabled/);
  });
  it.each([null, 0, 'true', {}])('validates the accepted autostart boolean %j independently of visibility', autostart => {
    const value = JSON.parse(bundle([])) as {settings: Record<string, unknown>};
    value.settings.autostart = autostart;
    expect(() => check(JSON.stringify(value), [])).toThrow(/bundle\.settings\.autostart/);
  });
  it('accepts true autostart and false visibility together from the production bundle builder', () => {
    const text = bundle([], {}, {settings: {...SETTINGS, autostart: true, overlay: {...SETTINGS.overlay, enabled: false}}});
    expect(() => check(text, [])).not.toThrow();
    expect(JSON.parse(text)).toMatchObject({settings: {autostart: true, overlay: {enabled: false}}});
  });
  it('rejects unrelated overlay keys beside a valid visibility flag', () => {
    const value = JSON.parse(bundle([])) as {settings: {overlay: Record<string, unknown>}};
    value.settings.overlay.windowPath = 'invented';
    expect(() => check(JSON.stringify(value), [])).toThrow(/unexpected field in bundle\.settings\.overlay/);
  });
});

describe('other valid variants', () => {
  it('accepts the full recording health variant with losses and a trip', () => {
    const health: AppHealth = {service: 'ready', storage: 'verified', lastError: null, recording: {state: 'recording', target: 'synthetic', code: null,
      losses: {lostEvents: 2, eventLoss: 1, notConnected: 1, sampleLoss: 0, restoreLoss: 0, droppedSamples: 3},
      trip: {phase: 'active', completeness: 'partial', untrackedJob: false}}};
    const text = bundle(['Jane.Doe'], {}, {health});
    expect(() => check(text, ['Jane.Doe'])).not.toThrow();
    expect(schemaTokens(JSON.parse(text))).toEqual(expect.arrayContaining(['recording', 'synthetic', 'losses', 'droppedSamples', 'trip', 'active', 'partial']));
    const retrying: AppHealth = {...health, recording: {...health.recording, state: 'retrying', code: 'DATABASE_LOCKED', trip: null} as AppHealth['recording']};
    expect(() => check(bundle(['Jane.Doe'], {}, {health: retrying}), ['Jane.Doe'])).not.toThrow();
  });
  it('accepts a disabled plugin view without targets or a bundled plugin', () => {
    const none = {excluded: false, discovery: 'pending', manualFolder: 'none', targets: [], unlistedFolders: 0} as const;
    const plugins: PluginSetupView = {mode: 'disabled', bundled: null, running: false, games: {ets2: none, ats: none}};
    const text = bundle(['Jane.Doe'], {}, {plugins});
    expect(() => check(text, ['Jane.Doe'])).not.toThrow();
    expect(JSON.parse(text)).toMatchObject({plugins: {mode: 'disabled', bundled: null}, bundledPlugin: null});
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
    // A kept detail is an unknown field of the log row, so the structure check refuses it first.
    const detail = valid(); detail.logs.main[0].detail = 'x'; fails(detail, /unexpected field in bundle\.logs\.main\[0\]/);
  });
  it('refuses a drive path or a run folder anywhere in the text', () => {
    const drive = valid(); drive.logs.main[1].facts!.where = 'C:\\Users'; fails(drive, /carries a path/);
    const run = valid(); run.logs.main[1].facts!.where = RUN; fails(run, /run path/);
  });
});
