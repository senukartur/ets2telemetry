import assert from 'node:assert/strict';

// ET-017 PR-6: the plugin smoke's checks of a saved diagnostic bundle (REG-015, REG-017), kept apart from the Playwright
// journey so that unit tests can run them on bundles built for any user or computer name. The bundle redacts the names
// only in runtime content (apps/desktop/src/diagnostic-bundle.ts), so the checks look for them only there: fact keys,
// string fact values and the OS release. A name such as `main` or `diagnostics` therefore matches the preserved schema
// without being a leak, and a name such as `mode` or `root` legitimately redacts a fact key or value (PR #111 review).
// The bundle must also fit its version 1 structure exactly: an unknown field fails, and only known keys and fixed values
// at their locations are schema tokens, so no unexpected content can vouch for a name.

/** The marker the bundle writes in place of a path or a name. */
export const REDACTED = '<redacted>';
export const DIAGNOSTIC_BUNDLE_LIMIT_BYTES = 2 * 1024 * 1024;

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word and case-insensitive, as the bundle redacts; names shorter than two characters are never redacted. */
function containsName(text, name) {
  if (typeof name !== 'string' || name.trim().length < 2) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(name.trim())}(?![A-Za-z0-9])`, 'i').test(text.replaceAll(REDACTED, ' '));
}

/** The runtime strings of a parsed bundle: every log row's fact keys and string fact values, and the OS release. */
export function runtimeStrings(bundle) {
  const strings = [bundle.app?.osRelease];
  for (const rows of [bundle.logs?.main, bundle.logs?.service]) {
    for (const row of rows ?? []) {
      for (const [key, value] of Object.entries(row.facts ?? {})) strings.push(key, ...(typeof value === 'string' ? [value] : []));
    }
  }
  return strings.filter(value => typeof value === 'string');
}

const FORMAT = 'ets2telemetry.diagnostics';
/**
 * An application, Electron, Node or plugin version, with at most an alpha, beta or rc pre-release, or the staging suffix
 * `-stg.<6 digits>` of a staging build (ET-055 UP15), which pull-request smokes run since ET-055 PR-4.
 */
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:(?:alpha|beta|rc)(?:\.\d{1,9})?|stg\.\d{6}))?$/;
/** A fixed upper-case code at a code location (an error, block reason, diagnosis code or note). */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVENT = /^[A-Z0-9_]{1,64}$/;
const HASH_PREFIX = /^[0-9a-f]{12}$/;
const TARGET_ID = /^(ets2|ats):(steam|manual):[0-3]$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * The lower-case enums of the contract types the bundle's views carry (packages/contracts/src), by name. The unit test
 * requires each list to equal its contract union, which the typecheck keeps complete.
 */
export const ENUMS = Object.freeze({
  serviceHealth: ['starting', 'ready', 'restarting', 'failed', 'stopping'],
  storageHealth: ['pending', 'verified', 'failed'],
  recordingState: ['disabled', 'unknown', 'opening', 'waiting', 'recording', 'paused', 'interrupted', 'retrying', 'not-recorded-source', 'live-only', 'stopped'],
  recordingTarget: ['history', 'synthetic', 'replay'],
  tripPhase: ['idle', 'active', 'awaiting-outcome', 'reload-check'],
  tripCompleteness: ['unknown', 'partial', 'complete'],
  language: ['en', 'ru'],
  unitProfile: ['metric', 'us-customary'],
  gearDisplay: ['automatic', 'manual', 'crawler'],
  overlayLayout: ['strip', 'card', 'cluster', 'hud'],
  overlaySection: ['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining',
    'deadline', 'expected-income', 'game-time', 'mandatory-break'],
  settingsState: ['loading', 'defaults', 'loaded', 'loaded-with-fallbacks', 'invalid-file', 'unsupported-older', 'newer-version', 'unreadable', 'unavailable'],
  pluginMode: ['active', 'test-root', 'disabled'],
  pluginGame: ['ets2', 'ats'],
  discovery: ['pending', 'found', 'not-found', 'steam-not-found', 'steam-list-invalid'],
  manualFolder: ['none', 'set', 'invalid'],
  targetState: ['installed', 'outdated', 'missing', 'excluded', 'blocked', 'working'],
  targetSource: ['steam', 'manual'],
  selection: ['game', 'ets2', 'ats', 'synthetic', 'replay'],
  liveStatus: ['waiting', 'connected', 'paused', 'stale', 'incompatible', 'disconnected', 'unavailable', 'service-failed', 'restarting']
});

// The bundle's version 1 structure (apps/desktop/src/diagnostic-bundle.ts). Every key at its known path and every fixed
// string value, validated against its location's form, is a schema token; nothing else is (PR #111 review). Objects list
// their known keys; maps accept only keys of a fixed enum; runtime content (a log row's facts and the OS release) is
// neither checked nor a token.
const pattern = form => ({kind: 'string', test: value => form.test(value)});
const exact = text => ({kind: 'string', test: value => value === text});
const oneOf = words => ({kind: 'string', test: value => words.includes(value)});
const number = {kind: 'number'};
const boolean = {kind: 'boolean'};
const runtime = {kind: 'runtime'};
const nullable = inner => ({kind: 'nullable', inner});
const object = fields => ({kind: 'object', fields});
const map = (keys, value) => ({kind: 'map', keys, value});
const array = item => ({kind: 'array', item});
const fileView = object({version: nullable(pattern(VERSION)), sha256Prefix: pattern(HASH_PREFIX)});
const logRow = object({time: pattern(ISO_TIME), event: pattern(EVENT), facts: runtime});
const BUNDLE_SCHEMA = object({
  format: exact(FORMAT),
  version: number,
  createdUtc: pattern(ISO_TIME),
  app: object({version: pattern(VERSION), electron: pattern(VERSION), node: pattern(VERSION), packaged: boolean, osRelease: runtime}),
  health: object({
    service: oneOf(ENUMS.serviceHealth), storage: oneOf(ENUMS.storageHealth), lastError: nullable(pattern(CODE)),
    recording: object({
      state: oneOf(ENUMS.recordingState), target: oneOf(ENUMS.recordingTarget), code: nullable(pattern(CODE)),
      losses: object({lostEvents: number, eventLoss: number, notConnected: number, sampleLoss: number, restoreLoss: number, droppedSamples: number}),
      trip: nullable(object({phase: oneOf(ENUMS.tripPhase), completeness: nullable(oneOf(ENUMS.tripCompleteness)), untrackedJob: boolean}))
    })
  }),
  settings: object({
    nowPlaying: object({enabled: boolean, style: oneOf(['minimal', 'full']), backgroundOpacity: number, position: object({displayId: nullable(pattern(/^-?\d{1,16}$/)), x: number, y: number})}),
    language: oneOf(ENUMS.language),
    autostart: boolean,
    units: map(ENUMS.pluginGame, oneOf(ENUMS.unitProfile)),
    gearDisplay: map(ENUMS.pluginGame, oneOf(ENUMS.gearDisplay)),
    overlay: object({enabled: boolean, backgroundOpacity: number, layout: oneOf(ENUMS.overlayLayout), sections: map(ENUMS.overlaySection, boolean),
      placements: map(ENUMS.overlayLayout, object({x: number, y: number, scale: number}))}),
    state: oneOf(ENUMS.settingsState), writable: boolean, saveError: nullable(pattern(CODE))
  }),
  plugins: object({
    mode: oneOf(ENUMS.pluginMode), bundled: nullable(fileView), running: boolean,
    games: map(ENUMS.pluginGame, object({
      excluded: boolean, discovery: oneOf(ENUMS.discovery), manualFolder: oneOf(ENUMS.manualFolder), unlistedFolders: number,
      targets: array(object({id: pattern(TARGET_ID), source: oneOf(ENUMS.targetSource), ordinal: number, state: oneOf(ENUMS.targetState),
        reason: nullable(pattern(CODE)), installed: nullable(fileView), lastFailure: nullable(pattern(CODE))}))
    }))
  }),
  bundledPlugin: nullable(fileView),
  live: object({status: oneOf(ENUMS.liveStatus), selection: oneOf(ENUMS.selection)}),
  diagnosis: object({code: pattern(CODE), notes: array(pattern(CODE))}),
  logs: object({main: array(logRow), service: array(logRow)}),
  omittedLogRows: object({main: number, service: number})
});

/**
 * Validates a parsed bundle against its version 1 structure and returns its schema tokens: the keys at their known paths
 * and the fixed string values that passed their location's check. An unknown key fails as an unexpected field, and a
 * value that does not fit its location fails as an unexpected value, so nothing outside the known structure can stand for
 * the schema. Messages name the location only, never the content.
 */
export function schemaTokens(bundle) {
  const tokens = new Set();
  const walk = (value, spec, where) => {
    if (spec.kind === 'runtime') return;
    if (spec.kind === 'nullable') { if (value !== null) walk(value, spec.inner, where); return; }
    if (spec.kind === 'string') {
      assert.ok(typeof value === 'string' && spec.test(value), `Bundle has an unexpected value at ${where}`);
      tokens.add(value);
      return;
    }
    if (spec.kind === 'number' || spec.kind === 'boolean') { assert.equal(typeof value, spec.kind, `Bundle has an unexpected value at ${where}`); return; }
    if (spec.kind === 'array') {
      assert.ok(Array.isArray(value), `Bundle has an unexpected value at ${where}`);
      value.forEach((item, index) => walk(item, spec.item, `${where}[${index}]`));
      return;
    }
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `Bundle has an unexpected value at ${where}`);
    for (const [key, entry] of Object.entries(value)) {
      const known = spec.kind === 'object' ? Object.hasOwn(spec.fields, key) : spec.keys.includes(key);
      assert.ok(known, `Bundle has an unexpected field in ${where}`);
      tokens.add(key);
      walk(entry, spec.kind === 'object' ? spec.fields[key] : spec.value, `${where}.${key}`);
    }
  };
  walk(bundle, BUNDLE_SCHEMA, 'bundle');
  // Current settings always carry visibility; an old input cannot pass merely by omitting the new field.
  assert.equal(typeof bundle.settings?.overlay?.enabled, 'boolean', 'Bundle misses boolean bundle.settings.overlay.enabled');
  const opacity = bundle.settings?.overlay?.backgroundOpacity;
  assert.ok(Number.isInteger(opacity) && opacity >= 40 && opacity <= 100, 'Bundle misses valid background opacity');
  // ET-050: current settings always carry both games' gear display modes.
  for (const game of ENUMS.pluginGame) {
    assert.ok(ENUMS.gearDisplay.includes(bundle.settings?.gearDisplay?.[game]), `Bundle misses valid bundle.settings.gearDisplay.${game}`);
  }
  return [...tokens];
}

/**
 * Checks a saved bundle's text. `identities` are the user and computer names that must not appear in runtime content,
 * `runPaths` the run's folders that must appear nowhere, and `mainEvents` the fixed event codes the main log must hold.
 * Throws an assertion error naming the failed check; returns the parsed bundle.
 */
export function checkDiagnosticsBundle(text, {identities, runPaths, mainEvents}) {
  assert.ok(Buffer.byteLength(text) <= DIAGNOSTIC_BUNDLE_LIMIT_BYTES, 'Diagnostic bundle over 2 MiB');
  const bundle = JSON.parse(text);
  // The structure first: an unknown field or a value that does not fit its location fails here.
  const tokens = schemaTokens(bundle);
  assert.ok(Array.isArray(bundle.logs?.main) && Array.isArray(bundle.logs?.service), 'Bundle misses its logs');
  for (const event of mainEvents) assert.ok(bundle.logs.main.some(row => row.event === event), `Bundle misses the main log row ${event}`);
  assert.ok(bundle.logs.service.length > 0, 'Bundle misses the service log rows');
  assert.ok([...bundle.logs.main, ...bundle.logs.service].every(row => !('detail' in row) && !('pid' in row)), 'Bundle keeps a log detail');
  // A path's backslashes are doubled in JSON text, so each run folder is looked for as written and as JSON escapes it.
  for (const value of runPaths) {
    for (const form of [value, JSON.stringify(value).slice(1, -1)]) assert.ok(!text.toLowerCase().includes(form.toLowerCase()), 'Diagnostic bundle carries a run path');
  }
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\\\/, 'Diagnostic bundle carries a path');
  // Layer 1: the runtime strings, where the bundle redacts the names.
  const strings = runtimeStrings(bundle);
  for (const name of identities) assert.ok(!strings.some(value => containsName(value, name)), 'Diagnostic bundle carries the user or computer name');
  // Layer 2 (PR #111 delta review): a free-text field added outside the redaction scope would escape layer 1. A name
  // that is not a whole word of any schema token, such as `main` or the `root` of `test-root`, must not appear anywhere
  // in the text either.
  for (const name of identities) {
    if (tokens.some(token => containsName(token, name))) continue;
    assert.ok(!containsName(text, name), 'Diagnostic bundle carries the user or computer name outside its runtime strings');
  }
  return bundle;
}
