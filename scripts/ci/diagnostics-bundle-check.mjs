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
  const strings = runtimeStrings(bundle);
  for (const name of identities) assert.ok(!strings.some(value => containsName(value, name)), 'Diagnostic bundle carries the user or computer name');
  return bundle;
}
