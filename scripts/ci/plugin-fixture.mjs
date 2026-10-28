import {settingsPanel} from './ui-navigation.mjs';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {dialogCalls, stubSaveDialog} from './journal-observation.mjs';
import {checkDiagnosticsBundle} from './diagnostics-bundle-check.mjs';

// ET-017 PR-5: the fake Steam and game folders of the `plugin` runtime smoke scenario (REG-015, REG-017). Everything is
// created inside the run's isolated output folder, which also holds the test-root marker file, so the application's
// test-root mode confines every read and write to it. Nothing reads the Windows registry or touches a real Steam or game
// folder. Evidence names files by fixed labels only, never by path.

/** The marker file the test-root mode requires (apps/desktop/src/plugin-setup/mode.ts). */
export const PLUGIN_TEST_ROOT_MARKER = 'ets2telemetry-plugin-test-root.marker';
const GAMES = {
  ets2: {appId: '227300', folder: 'Euro Truck Simulator 2', executable: 'eurotrucks2.exe'},
  ats: {appId: '270880', folder: 'American Truck Simulator', executable: 'amtrucks.exe'}
};
const UNRELATED_DLL = Buffer.from('MZ unrelated plugin of another tool; never changed by ETS2Telemetry\n');
const UNRELATED_TEXT = 'Notes of the driver; never changed by ETS2Telemetry.\n';
const UNRECOGNIZED = Buffer.from('MZ a file with the plugin name that ETS2Telemetry did not install\n');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const vdfString = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * Fails loudly when ETS2, ATS or a TruckersMP process runs: plugin setup would then refuse every change, and the journey
 * must never run beside a real game. Reads the process list only.
 */
export function assertNoGameRunning() {
  const listing = execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tasklist.exe'), ['/fo', 'csv', '/nh'],
    {encoding: 'latin1', windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024});
  const names = listing.split(/\r?\n/).map(line => /^"([^"]*)"/.exec(line)?.[1]?.toLowerCase()).filter(Boolean);
  const running = names.filter(name => name === 'eurotrucks2.exe' || name === 'amtrucks.exe' || name.startsWith('truckersmp'));
  assert.deepEqual(running, [], 'ETS2, ATS or TruckersMP is running: close it before the plugin journey');
}

async function write(file, content) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, content);
}
async function gameFolder(root, game, plugins) {
  const win64 = path.join(root, 'bin', 'win_x64');
  await write(path.join(win64, GAMES[game].executable), 'fake executable\n');
  if (plugins) await mkdir(path.join(win64, 'plugins'), {recursive: true});
  return win64;
}
async function steamGame(library, game, plugins) {
  await write(path.join(library, 'steamapps', `appmanifest_${GAMES[game].appId}.acf`),
    `"AppState"\n{\n\t"appid"\t\t"${GAMES[game].appId}"\n\t"name"\t\t${vdfString(GAMES[game].folder)}\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t${vdfString(GAMES[game].folder)}\n}\n`);
  const root = path.join(library, 'steamapps', 'common', GAMES[game].folder);
  return {root, win64: await gameFolder(root, game, plugins)};
}

/**
 * Builds `<output>\plugin-root`: the marker, `Steam` with a library list naming LibraryA (ETS2, whose plugins folder holds
 * an unrelated DLL and a text file) and LibraryB (ATS, without a plugins folder), and a manual ETS2 folder holding an
 * unrecognized file with the plugin's name, chosen in a seeded install registry (the smoke cannot click the folder dialog).
 */
async function buildFixture(output, identity) {
  // ET-055: the plugin file and the registry's data root are the build channel's (scripts/ci/smoke-build.mjs).
  const PLUGIN_FILE = identity.pluginFileName;
  const root = path.join(output, 'plugin-root');
  await mkdir(root, {recursive: true});
  const canonical = await realpath(root);
  await writeFile(path.join(canonical, PLUGIN_TEST_ROOT_MARKER), 'Fake root of the ETS2Telemetry plugin smoke.\n');
  const steam = path.join(canonical, 'Steam'), libraryA = path.join(canonical, 'LibraryA'), libraryB = path.join(canonical, 'LibraryB');
  await mkdir(path.join(steam, 'steamapps', 'common'), {recursive: true});
  const entries = [steam, libraryA, libraryB].map((library, index) =>
    `\t"${index}"\n\t{\n\t\t"path"\t\t${vdfString(library)}\n\t\t"label"\t\t""\n\t\t"apps"\n\t\t{\n\t\t}\n\t}\n`).join('');
  await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n${entries}}\n`);
  await mkdir(path.join(libraryA, 'steamapps', 'common'), {recursive: true});
  await mkdir(path.join(libraryB, 'steamapps', 'common'), {recursive: true});
  const ets2 = await steamGame(libraryA, 'ets2', true), ats = await steamGame(libraryB, 'ats', false);
  await writeFile(path.join(ets2.win64, 'plugins', 'other-plugin.dll'), UNRELATED_DLL);
  await writeFile(path.join(ets2.win64, 'plugins', 'readme.txt'), UNRELATED_TEXT);
  const manualRoot = path.join(canonical, 'Manual ETS2');
  const manual = await gameFolder(manualRoot, 'ets2', true);
  await writeFile(path.join(manual, 'plugins', PLUGIN_FILE), UNRECOGNIZED);
  const registry = path.join(canonical, 'LocalAppData', identity.dataRootName, 'plugins', 'setup.json');
  await write(registry, JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
    games: {ets2: {excluded: false, manualRoot: path.win32.normalize(manualRoot)}, ats: {excluded: false, manualRoot: null}}, installs: [], pending: [], failures: []}, null, 2) + '\n');
  return {
    root: canonical,
    // ET-045b: the ATS Steam game root, which the stubbed folder dialog answers in run A. In memory only, never recorded.
    roots: {ats: ats.root},
    files: {
      ets2Plugin: path.join(ets2.win64, 'plugins', PLUGIN_FILE), atsPlugin: path.join(ats.win64, 'plugins', PLUGIN_FILE),
      atsPlugins: path.join(ats.win64, 'plugins'), manualPlugin: path.join(manual, 'plugins', PLUGIN_FILE),
      unrelatedDll: path.join(ets2.win64, 'plugins', 'other-plugin.dll'), unrelatedText: path.join(ets2.win64, 'plugins', 'readme.txt'), registry
    }
  };
}

/** The SHA-256 of the bundled plugin the application installs: the packaged resources' or the development stage's. */
async function readBundledHash(config) {
  const directory = config.mode !== 'development' ? path.join(path.dirname(config.executable), 'resources', 'telemetry-plugin')
    : path.join(config.checkout, '.local', 'package-native', 'telemetry-plugin');
  const manifest = JSON.parse(await readFile(path.join(directory, 'plugin-manifest.json'), 'utf8'));
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/);
  return manifest.sha256;
}

/** Each fixture file by label: its hash, size and modification time, or `absent`. No path is recorded. */
async function snapshotFixture(fixture) {
  const snapshot = {};
  for (const [label, file] of Object.entries(fixture.files)) {
    let item;
    try {item = await lstat(file);} catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      snapshot[label] = 'absent'; continue;
    }
    snapshot[label] = item.isDirectory() ? {directory: true, mtimeMs: item.mtimeMs}
      : {sha256: sha256(await readFile(file)), size: item.size, mtimeMs: (await stat(file)).mtimeMs};
  }
  return snapshot;
}

/**
 * Runs one fixture file-system step. A failure rethrows a fixed `PLUGIN_FIXTURE_<step>` error with the error code only,
 * so no fixture path reaches the receipt or the log.
 */
async function fixtureStep(step, work) {
  try {return await work();} catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'UNKNOWN';
    // eslint-disable-next-line preserve-caught-error -- the cause's message names a fixture path; only its code may leave.
    throw new Error(`PLUGIN_FIXTURE_${step}: ${code}`);
  }
}
/** Builds the fake root (see buildFixture). */
export const buildPluginFixture = (output, identity) => fixtureStep('BUILD', () => buildFixture(output, identity));
/** The SHA-256 of the bundled plugin the application installs: the packaged resources' or the development stage's. */
export const bundledPluginHash = config => fixtureStep('BUNDLE', () => readBundledHash(config));
/** Each fixture file by label: its hash, size and modification time, or `absent`. No path is recorded. */
export const snapshotPluginFixture = fixture => fixtureStep('SNAPSHOT', () => snapshotFixture(fixture));

const appPlugins = page => page.evaluate(() => globalThis.desktop.getAppState().then(state => state.plugins));
async function until(read, accept, message, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw new Error(`${message} within ${timeoutMs} ms; last ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const states = view => Object.fromEntries(['ets2', 'ats'].flatMap(game => view.games[game].targets.map(target => [target.id, [target.state, target.reason]])));
const settled = expected => view => view.mode === 'test-root' && !view.running && JSON.stringify(states(view)) === JSON.stringify(expected);
/** Card texts by target id, read from the renderer DOM. */
const cardStates = page => page.evaluate(() => Object.fromEntries([...globalThis.document.querySelectorAll('[data-testid^="plugin-target-"][data-testid$="-state"]')]
  .map(node => [node.getAttribute('data-testid'), node.innerText])));
const cardText = page => page.evaluate(() => globalThis.document.querySelector('[data-testid="plugin-card"]')?.innerText ?? null);
/** No path in the card: neither the fixture root nor any drive or UNC path. */
function assertNoPath(text, fixture) {
  assert.ok(typeof text === 'string' && text.length > 0, 'Game plugin card missing');
  assert.ok(!text.toLowerCase().includes(fixture.root.toLowerCase()), 'Game plugin card shows the fixture path');
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]|\\\\/, 'Game plugin card shows a path');
}

/** Replaces main's folder dialog, as stubSaveDialog replaces the Save dialog, and records each call without its path. */
async function stubOpenDialog(application, answer) {
  await application.evaluate(({dialog}, value) => {
    const calls = globalThis.__ets2telemetrySmokeOpenDialog = [];
    dialog.showOpenDialog = (window, options) => {
      calls.push({window: Boolean(window), properties: options?.properties ?? null});
      return Promise.resolve(value);
    };
  }, answer);
}
const openDialogCalls = application => application.evaluate(() => globalThis.__ets2telemetrySmokeOpenDialog ?? []);
/** The fixed duplicate answer (strings.ts PLUGIN_FOLDER_REFUSAL_TEXT.FOLDER_DUPLICATE). */
const FOLDER_DUPLICATE_TEXT = 'This game folder is already found through Steam; nothing changed.';
/**
 * ET-045b: one action result as the renderer shows it, read by its slot: severity, word, title, message, its place next to
 * its trigger (or the trigger's row with `inRow`) and inside its game, its live region, the icon, focus and aria-describedby. Null while no result is shown.
 */
const actionResult = (page, {slot, trigger, inRow = false}) => page.evaluate(({slot, trigger, inRow}) => {
  const document = globalThis.document, body = document.querySelector(`[data-testid="${slot}-result"]`);
  if (!body) return null;
  const control = document.getElementById(trigger), region = document.querySelector(`[data-testid="${slot}-result-region"]`);
  const polite = region?.querySelector('[role="status"]');
  const row = inRow ? control?.parentElement : control;
  return {severity: body.getAttribute('data-severity'), word: document.querySelector(`[data-testid="${slot}-result-severity"]`)?.textContent ?? null,
    title: document.querySelector(`[data-testid="${slot}-result-title"]`)?.textContent ?? null, message: document.querySelector(`[data-testid="${slot}-result-message"]`)?.textContent ?? null,
    game: body.closest('[data-testid="plugin-ets2"]') ? 'ets2' : body.closest('[data-testid="plugin-ats"]') ? 'ats' : null,
    nextToTrigger: Boolean(region && row?.nextElementSibling === region),
    polite: Boolean(polite?.contains(body) && polite.getAttribute('aria-live') === 'polite' && polite.getAttribute('aria-atomic') === 'true'),
    bodyRole: body.getAttribute('role'), alerts: region?.querySelectorAll('[role="alert"]').length ?? null,
    iconHidden: body.querySelector('svg')?.getAttribute('aria-hidden') ?? null,
    focused: document.activeElement === control, describedBy: control?.getAttribute('aria-describedby') ?? null, id: body.id,
    pending: control?.getAttribute('aria-disabled') ?? null,
    otherResults: [...document.querySelectorAll('[data-testid$="-result"][data-severity]')].filter(node => node !== body).length};
}, {slot, trigger, inRow});
export {actionResult as pluginActionResult};

const RUN_A = {'ets2:steam:0': ['installed', null], 'ets2:manual:0': ['blocked', 'UNRECOGNIZED_FILE'], 'ats:steam:0': ['installed', null]};
const RUN_A_EXCLUDED = {...RUN_A, 'ats:steam:0': ['excluded', null]};
const CARD_A = {'plugin-target-ets2-steam-0-state': 'Installed', 'plugin-target-ets2-manual-0-state': 'Blocked', 'plugin-target-ats-steam-0-state': 'Installed'};
const CARD_EXCLUDED = {...CARD_A, 'plugin-target-ats-steam-0-state': 'Not managed (game excluded)'};

/**
 * Run A: the launch run installs the bundled plugin into both Steam folders and leaves the unrelated and the unrecognized
 * files byte-identical; the card shows Installed / Blocked / Installed; switching ATS off in the card removes its plugin
 * and the plugins folder this application created for it.
 */
export async function runPluginJourney({application, dashboard, fixture, config, before, record, phase = () => undefined}) {
  await settingsPanel(dashboard, 'plugin');
  const bundled = await bundledPluginHash(config);
  record.view = await until(() => appPlugins(dashboard), settled(RUN_A), 'PLUGIN_SETUP_NOT_SETTLED', 30000);
  record.card = await until(() => cardStates(dashboard), value => JSON.stringify(value) === JSON.stringify(CARD_A), 'PLUGIN_CARD_NOT_SHOWN', 10000);
  phase('plugin-run-a-settled');
  assertNoPath(await cardText(dashboard), fixture);
  record.pluginCardShown = true; record.pluginNoPathShown = true;
  const after = await snapshotPluginFixture(fixture);
  assert.equal(after.ets2Plugin.sha256, bundled); assert.equal(after.atsPlugin.sha256, bundled);
  record.pluginSteamInstalled = true;
  assert.deepEqual([after.unrelatedDll, after.unrelatedText], [before.unrelatedDll, before.unrelatedText]);
  record.pluginUnrelatedUnchanged = true;
  assert.deepEqual(after.manualPlugin, before.manualPlugin);
  record.pluginUnrecognizedUnchanged = true;
  // ET-045b: choosing the ATS Steam folder again from the keyboard answers FOLDER_DUPLICATE beside "Choose game folder…" of
  // ATS, as information, inside the polite live region, with focus kept on the button and nothing written.
  await stubOpenDialog(application, {canceled: false, filePaths: [fixture.roots.ats]});
  await dashboard.getByTestId('plugin-ats-choose').focus();
  await dashboard.keyboard.press('Enter');
  const folderSlot = {slot: 'plugin-ats-choose', trigger: 'plugin-ats-choose'};
  record.folderResult = await until(() => actionResult(dashboard, folderSlot), value => value !== null && value.pending === null, 'PLUGIN_FOLDER_RESULT_NOT_SHOWN', 10000);
  assert.deepEqual(record.folderResult, {severity: 'info', word: 'Information', title: 'Information — Game folder for American Truck Simulator', message: FOLDER_DUPLICATE_TEXT,
    game: 'ats', nextToTrigger: true, polite: true, bodyRole: null, alerts: 0, iconHidden: 'true', focused: true, describedBy: 'plugin-ats-choose-result',
    id: 'plugin-ats-choose-result', pending: null, otherResults: 0});
  assert.deepEqual(await openDialogCalls(application), [{window: true, properties: ['openDirectory']}]);
  const registry = await fixtureStep('REGISTRY', async () => JSON.parse(await readFile(fixture.files.registry, 'utf8')));
  assert.equal(registry.games.ats.manualRoot, null);
  assertNoPath(await cardText(dashboard), fixture);
  await dashboard.getByTestId('plugin-ats-choose-result').scrollIntoViewIfNeeded();
  await dashboard.screenshot({path: path.join(config.output, 'plugin-folder-result.png')});
  record.pluginFolderResultContextual = true;
  phase('plugin-folder-result');
  // Switching ATS off goes through the card's switch and the plugin bridge, as a driver would.
  await dashboard.getByTestId('plugin-ats-managed').click();
  record.excludedView = await until(() => appPlugins(dashboard), view => view.games.ats.excluded && settled(RUN_A_EXCLUDED)(view), 'PLUGIN_EXCLUSION_NOT_APPLIED', 20000);
  record.excludedCard = await until(() => cardStates(dashboard), value => JSON.stringify(value) === JSON.stringify(CARD_EXCLUDED), 'PLUGIN_CARD_NOT_EXCLUDED', 10000);
  // The next card action cleared the folder result; a successful switch change shows none of its own.
  assert.equal(await actionResult(dashboard, folderSlot), null);
  assert.equal(await actionResult(dashboard, {slot: 'plugin-ats-managed', trigger: 'plugin-ats-managed', inRow: true}), null);
  const excluded = await snapshotPluginFixture(fixture);
  assert.equal(excluded.atsPlugin, 'absent'); assert.equal(excluded.atsPlugins, 'absent');
  assert.deepEqual([excluded.ets2Plugin, excluded.manualPlugin, excluded.unrelatedDll, excluded.unrelatedText],
    [after.ets2Plugin, after.manualPlugin, after.unrelatedDll, after.unrelatedText]);
  record.pluginExclusionRemoved = true;
  phase('plugin-excluded');
  // The click scrolled the card into view; return to the top of the Live tab for the screenshot and later reads.
  await dashboard.evaluate(() => globalThis.scrollTo(0, 0));
}

/** Run B: the restart reaches the same states without writing: every fixture file keeps its bytes and modification time. */
export async function verifyPluginRestart({dashboard, fixture, before, record, phase = () => undefined}) {
  await settingsPanel(dashboard, 'plugin');
  record.restartView = await until(() => appPlugins(dashboard), view => view.games.ats.excluded && settled(RUN_A_EXCLUDED)(view), 'PLUGIN_RESTART_NOT_SETTLED', 30000);
  record.restartCard = await until(() => cardStates(dashboard), value => JSON.stringify(value) === JSON.stringify(CARD_EXCLUDED), 'PLUGIN_RESTART_CARD_NOT_SHOWN', 10000);
  assertNoPath(await cardText(dashboard), fixture);
  record.pluginRestartStates = true;
  assert.deepEqual(await snapshotPluginFixture(fixture), before);
  record.pluginRestartUnchanged = true;
  phase('plugin-run-b-settled');
}

const EXPORT_SLOT = {slot: 'plugin-export-diagnostics', trigger: 'plugin-export-diagnostics'};
/** ET-045b: the export's answer beside its button, once the call settled. */
const exportResult = page => actionResult(page, EXPORT_SLOT).then(value => value && value.pending === null ? value : null);
const DIAGNOSTICS_CANCELLED = 'Export cancelled. Nothing was written.';
const DIAGNOSTICS_SAVED = 'Diagnostics saved.';

/**
 * ET-017 PR-6 (P17): "Export diagnostics…" in run B. Main's Save dialog is replaced through Playwright's main-process
 * evaluate, as in the journal export journey (journal-observation.mjs): a cancelled dialog writes nothing, then a target
 * in this run's output folder receives the bundle. The bundle must be the v1 format with the test-root plugin view and
 * the fixed diagnosis, hold log rows of both logs, and contain no path, no fixture root and no output folder. The user and
 * computer names are looked for only in runtime content (diagnostics-bundle-check.mjs), where the bundle redacts them.
 */
export async function runDiagnosticsExport({application, dashboard, config, fixture, record}) {
  await settingsPanel(dashboard, 'plugin');
  const directory = path.join(config.output, 'diagnostics-export'), file = path.join(directory, 'diagnostics.json');
  await mkdir(directory);
  const button = dashboard.getByTestId('plugin-export-diagnostics');
  await stubSaveDialog(application, {canceled: true, filePath: ''});
  await button.focus(); await dashboard.keyboard.press('Enter');
  const cancelled = await until(() => exportResult(dashboard), value => value?.message === DIAGNOSTICS_CANCELLED, 'DIAGNOSTICS_EXPORT_NOT_CANCELLED', 10000);
  assert.deepEqual([cancelled.severity, cancelled.polite, cancelled.focused, cancelled.nextToTrigger, cancelled.describedBy], ['info', true, true, true, 'plugin-export-diagnostics-result']);
  assert.deepEqual(await readdir(directory), []);
  await stubSaveDialog(application, {canceled: false, filePath: file});
  await button.focus(); await dashboard.keyboard.press('Enter');
  const saved = await until(() => exportResult(dashboard), value => value?.message === DIAGNOSTICS_SAVED, 'DIAGNOSTICS_EXPORT_NOT_SAVED', 10000);
  assert.deepEqual([saved.severity, saved.word, saved.title, saved.polite, saved.focused, saved.otherResults], ['success', 'Done', 'Done — Diagnostics export', true, true, 0]);
  record.diagnosticsResultSeverities = [cancelled.severity, saved.severity];
  const offered = await dialogCalls(application);
  assert.equal(offered.length, 1);
  assert.equal(offered[0].window, true);
  assert.match(offered[0].defaultName, /^ets2telemetry-diagnostics-\d{8}T\d{6}Z\.json$/);
  assert.deepEqual(offered[0].filters, [{name: 'JSON', extensions: ['json']}]);
  assert.deepEqual(await readdir(directory), ['diagnostics.json']);
  const text = await readFile(file, 'utf8');
  let user;
  try {user = os.userInfo().username;} catch {user = undefined;}
  const bundle = checkDiagnosticsBundle(text, {identities: [user, os.hostname(), process.env.USERNAME, process.env.COMPUTERNAME],
    runPaths: [fixture.root, config.output, config.localappdata], mainEvents: ['PLUGIN_SETUP_MODE', 'PLUGIN_ACTION']});
  assert.deepEqual([bundle.format, bundle.version, bundle.plugins.mode, bundle.diagnosis, bundle.live.selection],
    ['ets2telemetry.diagnostics', 1, 'test-root', {code: 'NO_GAME_SELECTED', notes: []}, 'game']);
  assert.deepEqual(states(bundle.plugins), RUN_A_EXCLUDED);
  await dashboard.evaluate(() => globalThis.scrollTo(0, 0));
  record.diagnosticsBundle = {bytes: Buffer.byteLength(text), mainRows: bundle.logs.main.length, serviceRows: bundle.logs.service.length, omitted: bundle.omittedLogRows};
  record.pluginDiagnosticsExported = true;
}

/** The plugin rows of one run's main log: the test-root mode, and no path refused outside the root. */
export function verifyPluginEvents(rows) {
  const modes = rows.filter(row => row.event === 'PLUGIN_SETUP_MODE').map(row => row.facts);
  assert.deepEqual(modes, [{mode: 'test-root', reason: null}]);
  assert.deepEqual(rows.filter(row => row.event === 'PLUGIN_TEST_ROOT_ESCAPE' || row.event === 'PLUGIN_SETUP_MODE_REJECTED'), []);
  return rows.filter(row => row.event === 'PLUGIN_ACTION').map(row => row.facts);
}

/** The text of the disabled mode's note in the card (strings.ts PLUGIN_MODE_TEXT.disabled). */
export const PLUGIN_DISABLED_NOTE = 'Plugin setup is off in this launch (a development, test or opt-out launch); no game folder is changed.';
/** The diagnosis line while no game is selected (strings.ts CONNECTION_DIAGNOSIS_TEXT.NO_GAME_SELECTED, ET-017 PR-6). */
export const NO_GAME_SELECTED_DIAGNOSIS = 'No game is selected as the source. Choose Euro Truck Simulator 2 or American Truck Simulator in Settings > Data.';
/** The card's controls that change setup; the disabled mode must disable each of them. */
const CHANGING_CONTROLS = ['plugin-ets2-managed', 'plugin-ets2-choose', 'plugin-ats-managed', 'plugin-ats-choose', 'plugin-retry'];
/** In the disabled mode the card shows its note and disables every control that would change nothing. */
export async function verifyDisabledPluginCard(dashboard) {
  await settingsPanel(dashboard, 'plugin');
  const note = dashboard.getByTestId('plugin-mode');
  await note.waitFor({state: 'attached', timeout: 10000});
  const record = {note: await note.innerText(), controls: {}};
  assert.equal(record.note, PLUGIN_DISABLED_NOTE);
  record.disabledNoteShown = true;
  for (const id of CHANGING_CONTROLS) record.controls[id] = await dashboard.getByTestId(id).isDisabled();
  assert.deepEqual(record.controls, Object.fromEntries(CHANGING_CONTROLS.map(id => [id, true])));
  record.controlsDisabled = true;
  // ET-017 PR-6 (P17): the scaffold launch selects no game, so the diagnosis line shows that fixed text; the diagnostics
  // export stays available in the disabled mode.
  record.diagnosis = await dashboard.getByTestId('plugin-diagnosis').innerText();
  assert.equal(record.diagnosis, NO_GAME_SELECTED_DIAGNOSIS);
  record.diagnosisShown = true;
  assert.equal(await dashboard.getByTestId('plugin-export-diagnostics').isEnabled(), true);
  record.exportAvailable = true;
  return record;
}
