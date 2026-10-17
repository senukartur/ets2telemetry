import assert from 'node:assert/strict';

// ET-017 PR-6: the plugin smoke's checks of a saved diagnostic bundle (REG-015, REG-017), kept apart from the Playwright
// journey so that unit tests can run them on bundles built for any user or computer name. The bundle redacts the names
// only in runtime content (apps/desktop/src/diagnostic-bundle.ts), so the checks look for them only there: fact keys,
// string fact values and the OS release. A name such as `main` or `diagnostics` therefore matches the preserved schema
// without being a leak, and a name such as `mode` or `root` legitimately redacts a fact key or value (PR #111 review).

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
/** Upper-case codes with at least one underscore, such as `UNRECOGNIZED_FILE`; a single upper-case word could be a name. */
const CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** An application, Electron, Node or plugin version, with at most an alpha, beta or rc pre-release. */
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:alpha|beta|rc)(?:\.\d{1,9})?)?$/;
const HASH_PREFIX = /^[0-9a-f]{12}$/;
const TARGET_ID = /^(ets2|ats):(steam|manual):[0-3]$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/**
 * The lower-case enum words of the contract types the bundle's views carry (packages/contracts/src). The unit test ties
 * this set to those types at compile time, so a new enum member fails the test until it is listed here.
 */
export const ENUM_WORDS = Object.freeze(new Set([
  // ServiceHealth, StorageHealth, RecordingHealth state and target, RecordingTrip phase and completeness
  'starting', 'ready', 'restarting', 'failed', 'stopping', 'pending', 'verified', 'disabled', 'unknown', 'opening', 'waiting', 'recording', 'paused',
  'interrupted', 'retrying', 'not-recorded-source', 'live-only', 'stopped', 'history', 'synthetic', 'replay', 'idle', 'active', 'awaiting-outcome',
  'reload-check', 'partial', 'complete',
  // UnitProfile, OverlayLayout, SettingsState
  'metric', 'us-customary', 'strip', 'card', 'cluster', 'hud', 'loading', 'defaults', 'loaded', 'loaded-with-fallbacks', 'invalid-file',
  'unsupported-older', 'newer-version', 'unreadable', 'unavailable',
  // PluginSetupMode, PluginGame, PluginDiscoveryOutcome, PluginManualFolderState, PluginTargetState, folder source
  'test-root', 'ets2', 'ats', 'found', 'not-found', 'steam-not-found', 'steam-list-invalid', 'none', 'set', 'invalid', 'installed', 'outdated',
  'missing', 'excluded', 'blocked', 'working', 'steam', 'manual',
  // SourceSelection and the live status
  'game', 'connected', 'stale', 'incompatible', 'disconnected', 'service-failed'
]));
/** Whether a string value at `path` has one of the bundle's fixed forms, so it may stand for the schema. */
const fixedValue = (value, path) => value === FORMAT || CODE.test(value) || ENUM_WORDS.has(value) || VERSION.test(value) || HASH_PREFIX.test(value)
  || TARGET_ID.test(value) || ISO_TIME.test(value) || (path.length === 4 && path[0] === 'logs' && path[3] === 'event');

/**
 * The schema tokens of a parsed bundle: every key, and every string value outside the runtime strings that has one of the
 * bundle's fixed forms: the format, upper-case codes, log event codes, the contract's lower-case enum words, versions, hash
 * prefixes, target ids and ISO times. Any other value, such as a whitespace-free identifier in a future field, is never
 * a token, so it cannot vouch for itself in the whole-text scan (PR #111 delta review).
 */
export function schemaTokens(bundle) {
  const tokens = new Set();
  const walk = (value, path) => {
    // A log row's facts object (its keys and values) and the OS release are runtime strings, not schema.
    if ((path.length === 4 && path[0] === 'logs' && path[3] === 'facts') || (path.length === 2 && path[0] === 'app' && path[1] === 'osRelease')) return;
    if (typeof value === 'string') { if (fixedValue(value, path)) tokens.add(value); }
    else if (Array.isArray(value)) value.forEach((entry, index) => walk(entry, [...path, index]));
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) { tokens.add(key); walk(entry, [...path, key]); }
    }
  };
  walk(bundle, []);
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
  const tokens = schemaTokens(bundle);
  for (const name of identities) {
    if (tokens.some(token => containsName(token, name))) continue;
    assert.ok(!containsName(text, name), 'Diagnostic bundle carries the user or computer name outside its runtime strings');
  }
  return bundle;
}
