import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat, mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

// ET-017 PR-5: the fake Steam and game folders of the `plugin` runtime smoke scenario (REG-015, REG-017). Everything is
// created inside the run's isolated output folder, which also holds the test-root marker file, so the application's
// test-root mode confines every read and write to it. Nothing reads the Windows registry or touches a real Steam or game
// folder. Evidence names files by fixed labels only, never by path.

/** The marker file the test-root mode requires (apps/desktop/src/plugin-setup/mode.ts). */
export const PLUGIN_TEST_ROOT_MARKER = 'ets2telemetry-plugin-test-root.marker';
const PLUGIN_FILE = 'ets2telemetry-plugin.dll';
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
async function buildFixture(output) {
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
  const registry = path.join(canonical, 'LocalAppData', 'ETS2Telemetry', 'plugins', 'setup.json');
  await write(registry, JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
    games: {ets2: {excluded: false, manualRoot: path.win32.normalize(manualRoot)}, ats: {excluded: false, manualRoot: null}}, installs: [], pending: [], failures: []}, null, 2) + '\n');
  return {
    root: canonical,
    files: {
      ets2Plugin: path.join(ets2.win64, 'plugins', PLUGIN_FILE), atsPlugin: path.join(ats.win64, 'plugins', PLUGIN_FILE),
      atsPlugins: path.join(ats.win64, 'plugins'), manualPlugin: path.join(manual, 'plugins', PLUGIN_FILE),
      unrelatedDll: path.join(ets2.win64, 'plugins', 'other-plugin.dll'), unrelatedText: path.join(ets2.win64, 'plugins', 'readme.txt'), registry
    }
  };
}

/** The SHA-256 of the bundled plugin the application installs: the packaged resources' or the development stage's. */
async function readBundledHash(config) {
  const directory = config.mode === 'packaged' ? path.join(path.dirname(config.executable), 'resources', 'telemetry-plugin')
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
export const buildPluginFixture = output => fixtureStep('BUILD', () => buildFixture(output));
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

const RUN_A = {'ets2:steam:0': ['installed', null], 'ets2:manual:0': ['blocked', 'UNRECOGNIZED_FILE'], 'ats:steam:0': ['installed', null]};
const RUN_A_EXCLUDED = {...RUN_A, 'ats:steam:0': ['excluded', null]};
const CARD_A = {'plugin-target-ets2-steam-0-state': 'Installed', 'plugin-target-ets2-manual-0-state': 'Blocked', 'plugin-target-ats-steam-0-state': 'Installed'};
const CARD_EXCLUDED = {...CARD_A, 'plugin-target-ats-steam-0-state': 'Not managed (game excluded)'};

/**
 * Run A: the launch run installs the bundled plugin into both Steam folders and leaves the unrelated and the unrecognized
 * files byte-identical; the card shows Installed / Blocked / Installed; switching ATS off in the card removes its plugin
 * and the plugins folder this application created for it.
 */
export async function runPluginJourney({dashboard, fixture, config, before, record, phase = () => undefined}) {
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
  // Switching ATS off goes through the card's switch and the plugin bridge, as a driver would.
  await dashboard.getByTestId('plugin-ats-managed').click();
  record.excludedView = await until(() => appPlugins(dashboard), view => view.games.ats.excluded && settled(RUN_A_EXCLUDED)(view), 'PLUGIN_EXCLUSION_NOT_APPLIED', 20000);
  record.excludedCard = await until(() => cardStates(dashboard), value => JSON.stringify(value) === JSON.stringify(CARD_EXCLUDED), 'PLUGIN_CARD_NOT_EXCLUDED', 10000);
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
  record.restartView = await until(() => appPlugins(dashboard), view => view.games.ats.excluded && settled(RUN_A_EXCLUDED)(view), 'PLUGIN_RESTART_NOT_SETTLED', 30000);
  record.restartCard = await until(() => cardStates(dashboard), value => JSON.stringify(value) === JSON.stringify(CARD_EXCLUDED), 'PLUGIN_RESTART_CARD_NOT_SHOWN', 10000);
  assertNoPath(await cardText(dashboard), fixture);
  record.pluginRestartStates = true;
  assert.deepEqual(await snapshotPluginFixture(fixture), before);
  record.pluginRestartUnchanged = true;
  phase('plugin-run-b-settled');
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
export const NO_GAME_SELECTED_DIAGNOSIS = 'No game is selected as the source. Choose Euro Truck Simulator 2 or American Truck Simulator above.';
/** The card's controls that change setup; the disabled mode must disable each of them. */
const CHANGING_CONTROLS = ['plugin-ets2-managed', 'plugin-ets2-choose', 'plugin-ats-managed', 'plugin-ats-choose', 'plugin-retry'];
/** In the disabled mode the card shows its note and disables every control that would change nothing. */
export async function verifyDisabledPluginCard(dashboard) {
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
