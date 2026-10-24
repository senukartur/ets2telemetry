import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFile, lstat, mkdir, open, readdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {_electron as electron} from '@playwright/test';
import {rendererPages} from '../ci/overlay-observation.mjs';
import {settingsPanel, waitForStartup} from '../ci/ui-navigation.mjs';
import {assertVersionInfo, readVersionInfo} from '../release-identity.mjs';
import {checkedPaths, checkInstalled, checkLaunchEnvironment, checkRunPlan, checkRunSignal, FACTS_VARIABLE, factsEvidence, InstallerGuardError, installedEnvironment, normalizePath,
  checkDataRootUnchanged, checkDecoyUnchanged, checkUninstallResidue, checkRegistrationIcon, classifyRegistrationIcon, electronRuntimeNames, ownsRegistration, parseUninstallString, resolveRealLocation, RUN_ONCE_KEY, RUN_ROOT_NAME,
  checkProductLinks, checkRegistrationNames, checkUninstallEntries, classifyProductLinks, PRODUCT_EXECUTABLE, ROOT_ICON_FILE, runLayout, steamLibraryPaths,
  uninstallEnvironment} from './installer-guard.mjs';

// ET-018 PR-1, PR-3 and PR-4 (REG-013, REG-015, REG-017; plan U8, U10-U13): the Node driver of the installer lifecycle in a marked test root. The
// PowerShell harness scripts/installer/Invoke-InstallerLifecycle.ps1 orchestrates the steps and runs every command below
// that starts a process under a BoundedProcess Job; this file never runs an installer by itself except through `step`,
// which the harness calls only after the guards passed. See docs/installer-testing.md.
//
// Commands (all paths come from the harness's config file; evidence goes to config.evidence):
//   signal [--allow-local]                    the CI signal (checkRunSignal); first, before anything is read
//   guard <config> <plan|ready>               the fail-closed preflight (checkRunPlan) on the harness's facts
//   installed <config> <label> <version>      checkInstalled on the facts the harness read after an installer step; ET-045g
//                                             also records icon-<label>.json (the DisplayIcon shape and the root and packaged
//                                             app.ico hashes) and applies checkRegistrationIcon
//   legacy-icon <config> <label> <location per view...>
//                                             ET-045g: writes a synthetic legacy app.ico into R's binary root and decides per
//                                             registry view whether the harness may point DisplayIcon at it (ownsRegistration)
//   installed (ET-045h)                       also checks the DisplayName and Publisher (checkRegistrationNames) and the one
//                                             Uninstall entry in R (checkUninstallEntries)
//   version-info <config> <label> <version>   ET-045h: the installed app-<version> executable's version resource, which
//                                             names the shortcuts (assertVersionInfo); read with FileVersionInfo, never run
//   legacy-names <config> <label> <location per view...>
//                                             ET-045h: after checkInstalled, decides per registry view whether the harness
//                                             may plant the old DisplayName and Publisher (ownsRegistration)
//   links <config> <label> <installed|none> [<location>|<folder>|<name>...]
//                                             ET-045h: checks the harness's product shortcuts, names only
//                                             (classifyProductLinks, checkProductLinks)
//   seed <config>                             writes the synthetic data root, the settings, the registry and the export
//   snapshot <config> <label>                 hashes every file of the data root and the export folder
//   compare <config> <before> <after>         an installer hook must leave both byte-identical (no data write)
//   step <config> <label> <exe> [args...]     runs one installer program and waits until no process image under R is left
//   launch <config> <label> <exe> <1|none>    a data launch of the installed application with LOCALAPPDATA = R\LocalAppData
//   verify <config> <label> <exe>             reads the upgraded database with the installed Electron and better-sqlite3
//   games <config>                            PR-3: the fake Steam and ETS2 folder in R, the plugin registry and the decoy
//   plugin-launch <config> <label> <exe> <installed|adopted>
//                                             PR-3: a launch whose test-root plugin setup installs or adopts the plugin
//   windows-uninstall <config> <label> <exe|-> <complete|deferred> [--rehearse]
//                                             PR-3: the exact registered UninstallString with the decoy LOCALAPPDATA, while
//                                             the application runs (complete) or the fake game host runs (deferred);
//                                             --rehearse stops before the UninstallString (a local check of the driver
//                                             against a fake layout; the harness never passes it)
//   app-uninstall <config> <label> <exe> <complete|blocked>
//                                             PR-4: the in-app uninstall through the smoke-only dialog seam, with the plugin
//                                             installed: complete (the data wipe, then Update.exe --uninstall, drained) or
//                                             blocked while the fake game host runs; records only, within 55 s
//   app-uninstall-verify <config> <label>     PR-4: asserts what app-uninstall recorded and what the files say now
//   run-once <config> <label> <blocked|complete>
//                                             PR-5: runs the deferred-cleanup executor as Windows runs a RunOnce entry at
//                                             sign-in: the registered command is read from this run's own test RunOnce key
//                                             and checked, the value deleted, the command started (blocked: while the fake
//                                             game host runs, which it must survive and register itself again; complete:
//                                             the plugin and the data root are removed and no value is left)
//   residue <config> <label>                  PR-3: checks the harness's residue-listing-<label>.json listing of the binary root
//   cleanup <config> <location per view...>   deletes R (never following links) after the harness kept the evidence

const here = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(here, '..', '..');
/** The synthetic recording target: the version 1 fixture is a `synthetic` database, so it migrates as `synthetic\upgrade.sqlite`. */
export const RECORDING_NAME = 'upgrade';
const FIXTURE = 'schema-v1-representative.sqlite';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FAILURE_EVENT = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;

// Seeded files, written by hand. Settings format 2 with non-default values, so a rewrite as format 3 or a fallback shows.
const ALL_SECTIONS = ['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining',
  'deadline', 'expected-income', 'game-time'];
export const SEED_SETTINGS = JSON.stringify({format: 'ets2telemetry.settings', version: 2, units: {ets2: 'us-customary', ats: 'metric'},
  overlay: {layout: 'hud', sections: Object.fromEntries(ALL_SECTIONS.map(id => [id, id !== 'rpm']))}}) + '\n';
// The plugin install registry: both games excluded and nothing installed, so the test-root setup run has nothing to change.
export const SEED_REGISTRY = JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
  games: {ets2: {excluded: true, manualRoot: null}, ats: {excluded: true, manualRoot: null}}, installs: [], pending: [], failures: []}, null, 2) + '\n';
// A trip export the user saved outside the data root; uninstall and upgrade must never touch it.
export const SEED_EXPORT = JSON.stringify({format: 'ets2telemetry.trip-export', note: 'Synthetic export of the ET-018 installer lifecycle; kept outside the data root.'}, null, 2) + '\n';

// The upgraded database, written by hand from the frozen version-1 fixture and migrations 0002-journal/0003-hard-mode
// (docs/storage.md); `backup` is filled from the one manifest the migration wrote.
export function expectedDatabase(backup) {
  const counts = {plugin_sessions: 1, clocks: 2, events: 5, event_gaps: 1, job_configurations: 1, truck_configurations: 1, trailer_configurations: 1,
    event_amounts: 1, trips: 1, trip_trailers: 1, event_attributions: 4, completeness_intervals: 1, samples: 3};
  return {
    userVersion: 3, applicationId: 1163154226, integrity: ['ok'], foreignKeyViolations: 0,
    info: [{database_uuid: 'f0000000-0000-4000-8000-000000000001', purpose: 'synthetic', accepted_origin: 'synthetic', created_utc_ms: 1791676800000, created_app_version: '0.1.0'}],
    counts,
    migrations: [{version: 1, name: '0001-initial', app_version: '0.1.0', backup_file_name: null, backup_sha256: null},
      {version: 2, name: '0002-journal', app_version: '0.1.0', backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 3, name: '0003-hard-mode', app_version: '0.1.0', backup_file_name: backup.fileName, backup_sha256: backup.fileSha256}],
    sessions: [{plugin_session_uuid: '10000000-0000-4000-8000-000000000001', game: 'ets2', origin: 'synthetic', committed_through_event_seq: '00000000000000000006'}],
    events: [{id: 1, event_seq: '00000000000000000001', type: 'job.configured'}, {id: 2, event_seq: '00000000000000000002', type: 'truck.configured'},
      {id: 3, event_seq: '00000000000000000003', type: 'trailer.configured'}, {id: 4, event_seq: '00000000000000000006', type: 'job.cancelled'},
      {id: 5, event_seq: '00009007199254740993', type: 'job.cleared'}],
    trips: [{id: 1, trip_uuid: '70000000-0000-4000-8000-000000000001', outcome: 'cancelled', recording_completeness: 'partial', opened_event_ref: 1, opened_by: 'event',
      observed_distance_m: 1500.5, fuel_used_l: null, fuel_used_l_state: 'not-observed', closed_by_session_ref: null, closed_by_event_seq: null}],
    jobSources: [{id: 1, plugin_session_ref: 1, source: 'event', event_ref: 1}]
  };
}
/** The pre-migration backup: the version 1 content, unchanged row counts and a manifest that matches its file. */
export const EXPECTED_BACKUP_COUNTS = {plugin_sessions: 1, clocks: 2, events: 5, event_gaps: 1, job_configurations: 1, truck_configurations: 1, trailer_configurations: 1,
  event_amounts: 1, trips: 1, trip_trailers: 1, event_attributions: 4, completeness_intervals: 1, samples: 3};
const BACKUP_NAME = /^telemetry-f0000000-v1-\d{8}T\d{9}Z\.sqlite$/;

async function readJson(file, maximum = 1024 * 1024) {
  const handle = await open(file, 'r');
  try {
    const {size} = await handle.stat();
    if (size > maximum) throw new Error('JSON_TOO_LARGE');
    return JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, ''));
  } finally {await handle.close();}
}
async function writeEvidence(config, name, value) {
  await mkdir(config.evidence, {recursive: true});
  await writeFile(path.join(config.evidence, name), JSON.stringify(value, null, 2) + '\n');
}
// The harness passes its machine facts (known folders, Steam libraries, registration, processes) in FACTS_VARIABLE, never in
// a file. It is read once and removed from this process's environment, so no installer or launch inherits it, and the
// evidence keeps only factsEvidence(): booleans, counts and matched image names.
const factsText = process.env[FACTS_VARIABLE];
delete process.env[FACTS_VARIABLE];
function machineFacts() {
  assert.ok(typeof factsText === 'string' && factsText.length > 0, 'FACTS_MISSING');
  // A JSON syntax error message quotes part of its input, which could carry a machine path into evidence.
  try {return JSON.parse(factsText);} catch {throw new Error('FACTS_INVALID');}
}
const failure = error => ({name: error?.name, code: error?.code ?? null, message: String(error?.message ?? error)});

/** The real location of every checked path, keyed by normalized raw path. */
async function resolvedMap(paths) {
  const map = {};
  for (const candidate of paths) map[normalizePath(candidate)] = await resolveRealLocation(candidate, realpath);
  return map;
}
async function regularFile(file) {
  try {const item = await lstat(file); return item.isFile() && !item.isSymbolicLink();} catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function guard(config, phase) {
  const facts = machineFacts();
  const steamLibraries = [...(facts.steamPath ? [facts.steamPath] : []), ...steamLibraryPaths(facts.libraryFolders ?? '')];
  const base = {runRoot: config.runRoot, paths: [config.evidence], decoy: decoyOf(config.runRoot), real: facts.real, steamLibraries};
  const plan = {...base, resolved: await resolvedMap(checkedPaths(base)), realBinaryRootExists: facts.realBinaryRootExists,
    registrationExists: facts.registrationExists, processes: facts.processes, steamLibrariesUnreadable: facts.libraryFoldersState === 'unreadable', markers: null};
  if (phase === 'ready') {
    const layout = runLayout(config.runRoot);
    plan.markers = {pluginMarker: await regularFile(layout.pluginMarker),
      installTest: await regularFile(layout.installTest) ? await readJson(layout.installTest, 16 * 1024) : null};
  } else assert.equal(phase, 'plan');
  checkRunPlan(plan);
  return {phase, facts: factsEvidence({...facts, steamLibrariesUnreadable: plan.steamLibrariesUnreadable}, config.runRoot)};
}

async function installed(config, label, version) {
  assert.match(String(label), /^[a-z0-9.-]{1,40}$/, 'INSTALLED_LABEL_INVALID');
  assert.match(String(version), /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/, 'INSTALLED_VERSION_INVALID');
  const facts = machineFacts();
  const layout = runLayout(config.runRoot);
  const registration = facts.registration ?? {};
  checkInstalled({runRoot: config.runRoot, installLocation: registration.installLocation, binaryRoot: layout.binaryRoot,
    resolvedInstallLocation: typeof registration.installLocation === 'string' ? await resolveRealLocation(registration.installLocation, realpath) : null,
    resolvedBinaryRoot: await resolveRealLocation(layout.binaryRoot, realpath), realBinaryRootExists: facts.realBinaryRootExists});
  // The registered uninstall command runs the Update.exe inside R.
  const uninstallInsideRunRoot = typeof registration.uninstallString === 'string' &&
    registration.uninstallString.toLowerCase().includes(normalizePath(path.win32.join(layout.binaryRoot, 'Update.exe')));
  assert.ok(uninstallInsideRunRoot, 'UNINSTALL_STRING_OUTSIDE_RUN_ROOT');
  // ET-045g: the observation goes to the evidence first, so a refusal can be read beside it.
  const icon = await iconObservation(layout, registration, label, version);
  await writeEvidence(config, `icon-${label}.json`, icon);
  checkRegistrationIcon(icon);
  // ET-045h: the Installed apps names, and one entry for one installation. Names only reach the evidence.
  const names = checkRegistrationNames(registration);
  const uninstallEntries = checkUninstallEntries(facts.uninstallEntries, config.runRoot);
  return {uninstallInsideRunRoot, iconChecked: true, names, uninstallEntries, facts: factsEvidence(facts, config.runRoot)};
}

/**
 * ET-045h: the installed executable's version resource. Squirrel names the shortcuts after its ProductName and the Start
 * menu folder after its CompanyName; one bounded Windows PowerShell call reads it (release-identity.mjs).
 */
function versionInfo(config, label, version) {
  assert.match(String(label), /^[a-z0-9.-]{1,40}$/, 'VERSION_INFO_LABEL_INVALID');
  assert.match(String(version), /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/, 'VERSION_INFO_VERSION_INVALID');
  const info = readVersionInfo(path.win32.join(runLayout(config.runRoot).binaryRoot, `app-${version}`, PRODUCT_EXECUTABLE), process.env);
  assertVersionInfo(info);
  return {versionInfo: info};
}

/**
 * ET-045h, before an update: the harness plants the old DisplayName and Publisher of an install made before ET-045h. After
 * checkInstalled, this decides for each registry view whether its key points into R (ownsRegistration; `-` for a view
 * without the key); only those keys get the values, and the update that follows must replace them.
 */
async function legacyNames(config, label, locations) {
  const facts = machineFacts();
  const layout = runLayout(config.runRoot);
  const registration = facts.registration ?? {};
  checkInstalled({runRoot: config.runRoot, installLocation: registration.installLocation, binaryRoot: layout.binaryRoot,
    resolvedInstallLocation: typeof registration.installLocation === 'string' ? await resolveRealLocation(registration.installLocation, realpath) : null,
    resolvedBinaryRoot: await resolveRealLocation(layout.binaryRoot, realpath), realBinaryRootExists: facts.realBinaryRootExists});
  assert.match(String(label), /^[a-z0-9.-]{1,40}$/, 'LEGACY_NAMES_LABEL_INVALID');
  return {ownsRegistration: locations.map(location => location !== '-' && ownsRegistration(config.runRoot, location))};
}

/** ET-045h: the product shortcuts the harness found, as names only; `installed` or `none` (checkProductLinks). */
function links(label, expectation, rows) {
  assert.match(String(label), /^[a-z0-9.-]{1,40}$/, 'LINKS_LABEL_INVALID');
  const classification = classifyProductLinks(rows);
  checkProductLinks(classification, expectation);
  return {expectation, classification};
}

/** The tracked product icon (resources/icon/app.ico), which forge.config.cjs embeds in the executable and Setup.exe. */
const TRACKED_ICON = path.join(checkout, 'resources', 'icon', 'app.ico');
const ICON_READ_LIMIT = 4 * 1024 * 1024;
/** The kind, size and SHA-256 of one icon file, compared with the tracked icon; never its path. */
async function iconFileState(file, trackedSha256) {
  const state = {present: false, regularFile: false, bytes: null, sha256: null, equalsTracked: false, readError: null};
  try {
    const item = await lstat(file);
    state.present = true;
    state.regularFile = item.isFile() && !item.isSymbolicLink();
    state.bytes = item.size;
    if (state.regularFile && item.size <= ICON_READ_LIMIT) {
      state.sha256 = sha256(await readFile(file));
      state.equalsTracked = state.sha256 === trackedSha256;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') state.readError = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  }
  return state;
}
/**
 * ET-045g: what the Installed apps entry shows after an installer step, without a path: the DisplayIcon value's shape
 * (classifyRegistrationIcon), Squirrel's `<binaryRoot>\app.ico` and the installed version's packaged
 * `app-<version>\resources\icon\app.ico`, each compared with the tracked icon. checkRegistrationIcon judges it.
 */
async function iconObservation(layout, registration, label, version) {
  const trackedSha256 = sha256(await readFile(TRACKED_ICON));
  return {label, version, displayIcon: classifyRegistrationIcon({displayIcon: registration.displayIcon, binaryRoot: layout.binaryRoot, version}),
    rootIcon: await iconFileState(path.win32.join(layout.binaryRoot, ROOT_ICON_FILE), trackedSha256),
    bundledIcon: await iconFileState(path.win32.join(layout.binaryRoot, `app-${version}`, 'resources', 'icon', ROOT_ICON_FILE), trackedSha256),
    trackedSha256};
}

/**
 * A synthetic one-entry icon (a 1x1 32-bit image of fixed bytes), distinct from the product icon: the stand-in for the
 * Electron icon that Squirrel downloaded into an existing install before ET-045g.
 */
function legacyIconBytes() {
  const bytes = Buffer.alloc(22 + 8, 0x5a);
  bytes.writeUInt16LE(0, 0); bytes.writeUInt16LE(1, 2); bytes.writeUInt16LE(1, 4);
  bytes.writeUInt8(1, 6); bytes.writeUInt8(1, 7); bytes.writeUInt8(0, 8); bytes.writeUInt8(0, 9); bytes.writeUInt16LE(1, 10); bytes.writeUInt16LE(32, 12);
  bytes.writeUInt32LE(8, 14); bytes.writeUInt32LE(22, 18);
  return bytes;
}
/**
 * ET-045g, before the update: plants the state of an install made before the fix. After checkInstalled, the binary
 * root's app.ico becomes legacyIconBytes() (a link there refuses), and for each registry view whose InstallLocation
 * points into R (ownsRegistration; `-` for a view without the key) the harness may then set DisplayIcon to that file.
 * The update must replace both.
 */
async function legacyIcon(config, label, locations) {
  const facts = machineFacts();
  const layout = runLayout(config.runRoot);
  const registration = facts.registration ?? {};
  checkInstalled({runRoot: config.runRoot, installLocation: registration.installLocation, binaryRoot: layout.binaryRoot,
    resolvedInstallLocation: typeof registration.installLocation === 'string' ? await resolveRealLocation(registration.installLocation, realpath) : null,
    resolvedBinaryRoot: await resolveRealLocation(layout.binaryRoot, realpath), realBinaryRootExists: facts.realBinaryRootExists});
  assert.match(String(label), /^[a-z0-9.-]{1,40}$/, 'LEGACY_ICON_LABEL_INVALID');
  const file = path.win32.join(layout.binaryRoot, ROOT_ICON_FILE);
  const before = await lstat(file).catch(error => {if (error?.code === 'ENOENT') return null; throw error;});
  assert.ok(before === null || (before.isFile() && !before.isSymbolicLink()), 'LEGACY_ICON_TARGET_INVALID');
  const bytes = legacyIconBytes();
  await writeFile(file, bytes);
  assert.equal(sha256(await readFile(file)), sha256(bytes), 'LEGACY_ICON_WRITE_FAILED');
  return {legacySha256: sha256(bytes), replacedExisting: before !== null, ownsRegistration: locations.map(location => location !== '-' && ownsRegistration(config.runRoot, location))};
}

/** The fixture's committed SHA-256 from tests/fixtures/storage/manifest.txt; the fixture itself is never written. */
async function fixtureHash() {
  const manifest = await readFile(path.join(checkout, 'tests', 'fixtures', 'storage', 'manifest.txt'), 'utf8');
  const row = manifest.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(([, name]) => name === FIXTURE);
  assert.ok(row && /^[0-9a-f]{64}$/.test(row[0]), 'FIXTURE_HASH_MISSING');
  return row[0];
}
async function seed(config) {
  const layout = runLayout(config.runRoot);
  const fixture = path.join(checkout, 'tests', 'fixtures', 'storage', FIXTURE), expected = await fixtureHash();
  assert.equal(sha256(await readFile(fixture)), expected, 'FIXTURE_CHANGED');
  const files = {
    database: path.join(layout.dataRoot, 'synthetic', `${RECORDING_NAME}.sqlite`),
    settings: path.join(layout.dataRoot, 'settings', 'settings.json'),
    registry: path.join(layout.dataRoot, 'plugins', 'setup.json'),
    export: path.join(layout.exports, 'trip-export.json')
  };
  for (const file of Object.values(files)) {
    await mkdir(path.dirname(file), {recursive: true});
    await assert.rejects(lstat(file), {code: 'ENOENT'}, 'SEED_TARGET_EXISTS');
  }
  await copyFile(fixture, files.database);
  await writeFile(files.settings, SEED_SETTINGS, {flag: 'wx'});
  await writeFile(files.registry, SEED_REGISTRY, {flag: 'wx'});
  await writeFile(files.export, SEED_EXPORT, {flag: 'wx'});
  assert.equal(sha256(await readFile(fixture)), expected, 'FIXTURE_CHANGED');
  const seeded = {};
  for (const [label, file] of Object.entries(files)) {const bytes = await readFile(file); seeded[label] = {sha256: sha256(bytes), size: bytes.length};}
  assert.equal(seeded.database.sha256, expected, 'SEED_COPY_DIFFERS');
  return seeded;
}

/** Every file and folder under `root` by relative path; a link or junction fails the snapshot. */
async function tree(root) {
  const entries = {};
  async function walk(directory) {
    let names;
    try {names = await readdir(directory);} catch (error) {
      if (error?.code === 'ENOENT' && directory === root) return;
      throw error;
    }
    for (const name of names.sort()) {
      const file = path.join(directory, name), item = await lstat(file), relative = path.relative(root, file);
      if (item.isSymbolicLink()) throw new Error('SNAPSHOT_LINK');
      if (item.isDirectory()) {entries[`${relative}\\`] = {directory: true}; await walk(file);}
      else {const bytes = await readFile(file); entries[relative] = {size: bytes.length, sha256: sha256(bytes)};}
    }
  }
  await walk(root);
  return entries;
}
async function snapshot(config) {
  const layout = runLayout(config.runRoot);
  return {dataRoot: await tree(layout.dataRoot), exports: await tree(layout.exports)};
}
async function compare(config, before, after) {
  const read = label => readJson(path.join(config.evidence, `snapshot-${label}.json`), 16 * 1024 * 1024);
  const [a, b] = [(await read(before)).result, (await read(after)).result];
  assert.deepEqual(b, a, 'HOOK_WROTE_DATA');
  return {files: Object.keys(a.dataRoot).length + Object.keys(a.exports).length};
}

/** Image paths of the running processes, through Windows PowerShell's Get-Process (System32, outside the run root). */
async function processImages() {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const {stdout} = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-Process | Where-Object { $_.Path } | ForEach-Object { $_.Path }'], {encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 8 * 1024 * 1024});
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}
/**
 * Runs one installer program (Setup.exe or Update.exe) with the harness's environment, then waits until no process whose
 * image lies under R is left: Squirrel's `--updateSelf` helper outlives its parent by design. Exit 0 only when the program
 * exited 0 and everything under R drained within the budget.
 */
async function step(config, label, executable, args) {
  const layout = runLayout(config.runRoot);
  // The only command that runs an installer repeats the CI signal, so a direct local call refuses as well.
  checkRunSignal(process.env, {allowLocal: config.allowLocal === true});
  // Only the reviewed Setup.exe of the make output or the installed Update.exe inside the run root may run here.
  assert.ok(normalizePath(executable) === normalizePath(config.setup) || normalizePath(executable) === normalizePath(path.join(layout.binaryRoot, 'Update.exe')),
    'STEP_EXECUTABLE_UNEXPECTED');
  checkLaunchEnvironment(process.env, {runRoot: config.runRoot, real: machineFacts().real});
  return runAndDrain(config, label, executable, args, process.env);
}
/** Runs one program in R's working folder, keeps its bounded output, and waits until no process image under R is left. */
async function runAndDrain(config, label, executable, args, env, budget = config.stepBudgetMs ?? 50000) {
  const layout = runLayout(config.runRoot);
  const started = performance.now();
  const child = spawn(executable, args, {cwd: layout.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const output = {stdout: [], stderr: []};
  child.stdout.on('data', chunk => output.stdout.push(chunk)); child.stderr.on('data', chunk => output.stderr.push(chunk));
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error('STEP_TIMEOUT'));}, budget);
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('exit', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
  });
  await writeFile(path.join(config.evidence, `step-${label}-stdout.log`), Buffer.concat(output.stdout).subarray(0, 1 << 20));
  await writeFile(path.join(config.evidence, `step-${label}-stderr.log`), Buffer.concat(output.stderr).subarray(0, 1 << 20));
  const exitMilliseconds = Math.round(performance.now() - started);
  let remaining;
  for (;;) {
    remaining = (await processImages()).filter(image => normalizePath(image).startsWith(`${normalizePath(config.runRoot)}\\`));
    if (!remaining.length || performance.now() - started > budget) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = {exit, exitMilliseconds, drainedMilliseconds: Math.round(performance.now() - started),
    remaining: remaining.map(image => path.relative(config.runRoot, image))};
  assert.deepEqual({code: exit.code, signal: exit.signal}, {code: 0, signal: null}, 'STEP_EXIT_NONZERO');
  assert.deepEqual(result.remaining, [], 'STEP_PROCESSES_REMAIN');
  return result;
}

async function serviceEvents(directory) {
  try {
    return (await readFile(path.join(directory, 'startup.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}
async function until(read, accept, code, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() > deadline) throw new Error(code);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
/**
 * A data launch: the installed application with LOCALAPPDATA = R\LocalAppData, the synthetic recording target `upgrade`
 * and the test-root plugin setup. The first launch after install A migrates the version 1 database; the launch on B
 * reopens it. Waits for the history open and the plugin setup's first discovery, then closes orderly.
 */
async function launch(config, label, executable, migratedFrom) {
  const layout = runLayout(config.runRoot);
  const diagnostics = path.join(layout.diagnostics, `launch-${label}`);
  await mkdir(diagnostics, {recursive: true});
  const env = installedEnvironment(process.env, {LOCALAPPDATA: layout.base, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp,
    ETS2TELEMETRY_PROFILE_DIR: layout.profile, ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostics, ETS2TELEMETRY_PLUGIN_SETUP_ROOT: config.runRoot,
    ETS2TELEMETRY_RECORDING: `synthetic:${RECORDING_NAME}`});
  checkLaunchEnvironment(env, {runRoot: config.runRoot, real: machineFacts().real});
  assert.ok(normalizePath(executable).startsWith(`${normalizePath(layout.binaryRoot)}\\app-`), 'LAUNCH_EXECUTABLE_NOT_INSTALLED');
  const record = {label};
  let application, closeError;
  try {
    application = await electron.launch({executablePath: executable, cwd: layout.cwd, env, timeout: 20000});
    const launcher = application.process();
    const {dashboard} = await rendererPages(application);
    await waitForStartup(dashboard, undefined, 15000);
    // Compared here; the evidence keeps the outcome only, never the path.
    const runtime = await application.evaluate(({app}) => ({executable: process.execPath, packaged: app.isPackaged, version: app.getVersion()}));
    record.runtime = {executableMatches: normalizePath(runtime.executable) === normalizePath(executable), packaged: runtime.packaged, version: runtime.version};
    await until(() => serviceEvents(path.join(diagnostics, 'service')), rows => rows.some(row => row.event === 'HISTORY_STORAGE_OPENED' || row.event === 'HISTORY_STORAGE_UNAVAILABLE'),
      'HISTORY_OPEN_NOT_LOGGED', 15000);
    await until(() => serviceEvents(diagnostics), rows => rows.some(row => row.event === 'PLUGIN_DISCOVERY'), 'PLUGIN_DISCOVERY_NOT_LOGGED', 15000);
    let timer;
    try {
      await Promise.race([application.close(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('APP_CLOSE_TIMEOUT_8_SECONDS')), 8000);})]);
    } finally {clearTimeout(timer);}
    application = undefined;
    record.exit = {code: launcher.exitCode, signal: launcher.signalCode};
  } catch (error) {closeError = error;} finally {
    if (application) await application.close().catch(() => undefined);
  }
  if (closeError) throw closeError;
  const main = await serviceEvents(diagnostics), service = await serviceEvents(path.join(diagnostics, 'service'));
  record.events = {
    opened: service.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts),
    target: service.filter(row => row.event === 'RECORDING_TARGET').map(row => row.facts),
    closed: service.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length,
    settings: main.filter(row => row.event.startsWith('SETTINGS_') && row.event !== 'SETTINGS_LOAD_PENDING').map(row => ({event: row.event, facts: row.facts ?? null})),
    pluginMode: main.filter(row => row.event === 'PLUGIN_SETUP_MODE').map(row => row.facts?.mode),
    pluginActions: main.filter(row => row.event === 'PLUGIN_ACTION').length,
    escapes: main.filter(row => row.event === 'PLUGIN_TEST_ROOT_ESCAPE').length,
    failures: [...main, ...service].filter(row => FAILURE_EVENT.test(row.event)).map(row => row.event),
    appExit: main.filter(row => row.event === 'APP_EXIT').map(row => row.detail?.code),
    serviceExit: main.filter(row => row.event === 'SERVICE_EXIT').map(row => row.detail?.code)
  };
  assert.deepEqual(record.exit, {code: 0, signal: null}, 'LAUNCH_EXIT_NONZERO');
  assert.equal(record.runtime.executableMatches, true, 'LAUNCH_EXECUTABLE_DIFFERS');
  assert.equal(record.runtime.packaged, true);
  assert.deepEqual(record.events.opened, [{schemaVersion: 3, created: false, migratedFrom: migratedFrom === 'none' ? null : Number(migratedFrom)}], 'HISTORY_OPEN_UNEXPECTED');
  assert.deepEqual(record.events.target, [{purpose: 'synthetic'}], 'RECORDING_TARGET_UNEXPECTED');
  assert.equal(record.events.closed, 1, 'HISTORY_NOT_CLOSED');
  // The format 2 settings load as migrated in memory, and nothing saves or quarantines them.
  assert.deepEqual(record.events.settings, [{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 2}}], 'SETTINGS_EVENTS_UNEXPECTED');
  assert.deepEqual(record.events.pluginMode, ['test-root'], 'PLUGIN_MODE_UNEXPECTED');
  assert.equal(record.events.pluginActions, 0, 'PLUGIN_ACTION_UNEXPECTED');
  assert.equal(record.events.escapes, 0, 'PLUGIN_TEST_ROOT_ESCAPE');
  assert.deepEqual(record.events.failures, [], 'FAILURE_EVENT_LOGGED');
  assert.deepEqual({app: record.events.appExit, service: record.events.serviceExit}, {app: [0], service: [0]}, 'EXIT_EVENTS_UNEXPECTED');
  return record;
}

/**
 * Reads the database with the installed runtime (ELECTRON_RUN_AS_NODE) and compares it with the hand-written values. The
 * reader opens copies in R\temp: a read-only connection to a WAL database leaves `-wal` and `-shm` files behind, which
 * must not appear in the data root the next installer step is compared against.
 */
async function verify(config, label, executable) {
  const layout = runLayout(config.runRoot);
  assert.ok(normalizePath(executable).startsWith(`${normalizePath(layout.binaryRoot)}\\app-`), 'VERIFY_EXECUTABLE_NOT_INSTALLED');
  const database = path.join(layout.dataRoot, 'synthetic', `${RECORDING_NAME}.sqlite`), backups = path.join(layout.dataRoot, 'synthetic', 'backups');
  // The application closed the database without sidecars, and created no production history database beside it.
  const sidecars = [];
  for (const suffix of ['-wal', '-shm', '-journal']) if (await regularFile(database + suffix)) sidecars.push(suffix);
  assert.deepEqual(sidecars, [], 'HISTORY_SIDECARS_LEFT');
  assert.equal(await regularFile(path.join(layout.dataRoot, 'data', 'telemetry.sqlite')), false, 'PRODUCTION_HISTORY_CREATED');
  const work = path.join(layout.temp, `verify-${label}`), workBackups = path.join(work, 'backups');
  await mkdir(workBackups, {recursive: true});
  await copyFile(database, path.join(work, `${RECORDING_NAME}.sqlite`));
  for (const name of await readdir(backups)) {
    assert.ok(await regularFile(path.join(backups, name)), 'BACKUP_ENTRY_NOT_A_FILE');
    await copyFile(path.join(backups, name), path.join(workBackups, name));
  }
  const output = path.join(config.evidence, `history-${label}.json`);
  const env = installedEnvironment(process.env, {ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: layout.base, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp});
  await promisify(execFile)(executable, [path.join(here, 'read-upgraded-history.cjs'), path.join(work, `${RECORDING_NAME}.sqlite`), workBackups, output, executable],
    {cwd: layout.cwd, env, timeout: 20000, windowsHide: true, encoding: 'utf8'});
  const facts = await readJson(output, 4 * 1024 * 1024);
  // The installed runtime and its own native binding did the read.
  assert.equal(facts.runtime.execPathMatches, true, 'VERIFY_RUNTIME_DIFFERS');
  assert.equal(facts.runtime.electron, '44.7.0');
  // The module cache names the binding by its ASAR path; Electron loads that file from app.asar.unpacked, which must exist.
  assert.deepEqual(facts.runtime.nativeBindings.map(name => name.toLowerCase()), ['resources\\app.asar\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node'],
    'VERIFY_NATIVE_BINDING_DIFFERS');
  assert.ok(await regularFile(path.join(path.dirname(executable), 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds', 'win32-x64.node')),
    'VERIFY_NATIVE_BINDING_MISSING');
  // Exactly one verified pre-migration backup with its manifest, written last.
  assert.equal(facts.manifests.length, 1, 'BACKUP_MANIFEST_COUNT');
  const [{manifest, file, content}] = facts.manifests;
  assert.match(manifest.fileName, BACKUP_NAME, 'BACKUP_NAME_UNEXPECTED');
  assert.deepEqual(facts.backups, [manifest.fileName.replace(/\.sqlite$/, '.json'), manifest.fileName].sort(), 'BACKUP_FILES_UNEXPECTED');
  assert.deepEqual({format: manifest.format, databaseUuid: manifest.databaseUuid, fromVersion: manifest.fromVersion, reason: manifest.reason, appVersion: manifest.appVersion},
    {format: 'ets2telemetry-backup-1', databaseUuid: 'f0000000-0000-4000-8000-000000000001', fromVersion: 1, reason: 'pre-migration', appVersion: '0.1.0'}, 'BACKUP_MANIFEST_UNEXPECTED');
  assert.deepEqual({sha256: file.sha256, size: file.size}, {sha256: manifest.fileSha256, size: manifest.size}, 'BACKUP_FILE_DIFFERS');
  assert.deepEqual(content, {userVersion: 1, applicationId: 1163154226, integrity: ['ok'], foreignKeyViolations: 0,
    info: expectedDatabase(manifest).info, counts: EXPECTED_BACKUP_COUNTS}, 'BACKUP_CONTENT_UNEXPECTED');
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.rowCounts).filter(([table]) => table in EXPECTED_BACKUP_COUNTS)), EXPECTED_BACKUP_COUNTS, 'BACKUP_ROW_COUNTS_UNEXPECTED');
  // The upgraded database itself.
  assert.deepEqual(facts.database, expectedDatabase(manifest), 'HISTORY_CONTENT_UNEXPECTED');
  // Settings, plugin registry and export keep the seeded bytes.
  const seeded = (await readJson(path.join(config.evidence, 'seed.json'))).result;
  const now = {};
  for (const [labelName, file] of Object.entries({settings: path.join(layout.dataRoot, 'settings', 'settings.json'),
    registry: path.join(layout.dataRoot, 'plugins', 'setup.json'), export: path.join(layout.exports, 'trip-export.json')})) {
    const bytes = await readFile(file); now[labelName] = {sha256: sha256(bytes), size: bytes.length};
  }
  assert.deepEqual(now, {settings: seeded.settings, registry: seeded.registry, export: seeded.export}, 'SEEDED_FILES_CHANGED');
  return {backup: manifest.fileName, preserved: Object.keys(now)};
}

// ET-018 PR-3 (REG-017; plan U6, U7, U12): the Windows-initiated uninstall scenarios. Squirrel's UninstallString runs
// with LOCALAPPDATA = R\decoy, which holds sentinel ETS2Telemetry files, and with no ETS2TELEMETRY_ variable: the hook
// must take its roots from the install location inside R and leave the decoy byte-identical. Every record keeps fixed
// labels, hashes and counts only, never a path.
const PLUGIN_FILE = 'ets2telemetry-plugin.dll';
const RECEIPT_NAME = /^ETS2Telemetry-uninstall-\d{8}T\d{9}Z\.json$/;
const decoyOf = runRoot => path.win32.join(runRoot, 'decoy');
/** The uninstall program and its drain get this long, so the whole command stays inside its 60 s Job with a launch before it. */
const UNINSTALL_RUN_BUDGET_MS = 35000;
/** The fake ETS2 folder in R's fake Steam library, and the files the uninstall must keep or remove there. */
function gameLayout(runRoot) {
  const library = path.win32.join(runRoot, 'LibraryA'), root = path.win32.join(library, 'steamapps', 'common', 'Euro Truck Simulator 2');
  const win64 = path.win32.join(root, 'bin', 'win_x64'), plugins = path.win32.join(win64, 'plugins');
  return {steam: path.win32.join(runRoot, 'Steam'), library, root, plugins, dll: path.win32.join(plugins, PLUGIN_FILE),
    kept: {executable: path.win32.join(win64, 'eurotrucks2.exe'), unrelatedDll: path.win32.join(plugins, 'other-plugin.dll'), unrelatedText: path.win32.join(plugins, 'readme.txt')}};
}
const vdfString = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
async function fileState(file) {
  try {
    const item = await lstat(file);
    if (!item.isFile() || item.isSymbolicLink()) return 'not-a-file';
    const bytes = await readFile(file);
    return {sha256: sha256(bytes), size: bytes.length, mtimeMs: item.mtimeMs};
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
}
async function keptStates(runRoot) {
  const {kept} = gameLayout(runRoot), layout = runLayout(runRoot), states = {};
  for (const [label, file] of Object.entries(kept)) states[label] = await fileState(file);
  states.export = await fileState(path.join(layout.exports, 'trip-export.json'));
  return states;
}
async function bundledHash(executable) {
  const manifest = await readJson(path.join(path.dirname(executable), 'resources', 'telemetry-plugin', 'plugin-manifest.json'), 64 * 1024);
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/, 'BUNDLE_HASH_INVALID');
  return manifest.sha256;
}

/**
 * The fake Steam root `R\Steam` with a library list naming `R\LibraryA`, the fake ETS2 folder there with an unrelated DLL
 * and a text file in its plugins folder, a plugin registry that manages ETS2 and excludes ATS, and the decoy
 * LOCALAPPDATA with sentinel data and binary roots. Runs after the PR-1 upgrade checks, which need the seeded registry.
 */
async function games(config) {
  const runRoot = await realpath(config.runRoot);
  const game = gameLayout(runRoot), layout = runLayout(runRoot);
  const write = async (file, content) => {await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, content, {flag: 'wx'});};
  const entries = [game.steam, game.library].map((library, index) => `\t"${index}"\n\t{\n\t\t"path"\t\t${vdfString(library)}\n\t\t"label"\t\t""\n\t\t"apps"\n\t\t{\n\t\t}\n\t}\n`).join('');
  await mkdir(path.join(game.steam, 'steamapps', 'common'), {recursive: true});
  await write(path.join(game.steam, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"\n{\n${entries}}\n`);
  await write(path.join(game.library, 'steamapps', 'appmanifest_227300.acf'),
    '"AppState"\n{\n\t"appid"\t\t"227300"\n\t"name"\t\t"Euro Truck Simulator 2"\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t"Euro Truck Simulator 2"\n}\n');
  await write(game.kept.executable, 'fake executable of the installer lifecycle\n');
  await write(game.kept.unrelatedDll, 'MZ unrelated plugin of another tool; never changed by ETS2Telemetry\n');
  await write(game.kept.unrelatedText, 'Notes of the driver; never changed by ETS2Telemetry.\n');
  // The seeded registry excluded both games for the upgrade checks; ETS2 is managed from now on.
  await writeFile(path.join(layout.dataRoot, 'plugins', 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
    games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: true, manualRoot: null}}, installs: [], pending: [], failures: []}, null, 2) + '\n');
  const decoy = decoyOf(runRoot);
  await write(path.join(decoy, 'ETS2Telemetry', 'data', 'telemetry.sqlite'), 'decoy history: an uninstall must never touch this file\n');
  await write(path.join(decoy, 'ETS2Telemetry', 'settings', 'settings.json'), '{"decoy":true}\n');
  await write(path.join(decoy, 'ETS2TelemetryDesktop', 'sentinel.txt'), 'decoy binary root\n');
  return {kept: await keptStates(runRoot), decoyFiles: Object.keys(await tree(decoy)).length};
}

/** The launch environment of PR-3's launches: as a data launch, without a recording target. */
function pluginEnvironment(config, label, extra = {}) {
  const layout = runLayout(config.runRoot);
  const diagnostics = path.join(layout.diagnostics, `plugin-${label}`);
  const env = installedEnvironment(process.env, {LOCALAPPDATA: layout.base, APPDATA: layout.appData, TEMP: layout.temp, TMP: layout.temp,
    ETS2TELEMETRY_PROFILE_DIR: layout.profile, ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostics, ETS2TELEMETRY_PLUGIN_SETUP_ROOT: config.runRoot, ...extra});
  checkLaunchEnvironment(env, {runRoot: config.runRoot, real: machineFacts().real});
  return {env, diagnostics};
}
/** Starts the installed application and waits until its test-root plugin setup recorded the ETS2 install with the bundled hash. */
/** `left(cap)` cuts each wait to the caller's remaining budget (the default keeps the fixed waits). */
async function startWithPlugin(config, label, executable, extra = {}, left = cap => cap) {
  const layout = runLayout(config.runRoot), game = gameLayout(await realpath(config.runRoot));
  assert.ok(normalizePath(executable).startsWith(`${normalizePath(layout.binaryRoot)}\\app-`), 'LAUNCH_EXECUTABLE_NOT_INSTALLED');
  const {env, diagnostics} = pluginEnvironment(config, label, extra);
  await mkdir(diagnostics, {recursive: true});
  const bundled = await bundledHash(executable);
  const application = await electron.launch({executablePath: executable, cwd: layout.cwd, env, timeout: left(20000)});
  try {
    const {dashboard} = await rendererPages(application);
    await waitForStartup(dashboard, left, 15000);
    const registry = path.join(layout.dataRoot, 'plugins', 'setup.json');
    await until(async () => {
      const document = await readJson(registry, 256 * 1024).catch(() => null);
      const install = document?.installs?.find(row => row.game === 'ets2' && normalizePath(row.root) === normalizePath(game.root));
      const dll = await fileState(game.dll);
      return install?.sha256 === bundled && typeof dll === 'object' && dll.sha256 === bundled;
    }, Boolean, 'PLUGIN_NOT_INSTALLED', left(30000));
    return {application, launcher: application.process(), bundled, diagnostics};
  } catch (error) {
    await application.close().catch(() => undefined);
    throw error;
  }
}
async function closeOrderly(application) {
  let timer;
  try {
    await Promise.race([application.close(), new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('APP_CLOSE_TIMEOUT_8_SECONDS')), 8000);})]);
  } finally {clearTimeout(timer);}
}

/**
 * A launch whose plugin setup installs the bundled plugin into the fake ETS2 folder (`installed`), or adopts the plugin a
 * deferred uninstall left there after the reinstall cancelled the deferral (`adopted`: the intent and README are gone
 * before the launch, and the DLL keeps its bytes and modification time).
 */
async function pluginLaunch(config, label, executable, expectation) {
  assert.ok(expectation === 'installed' || expectation === 'adopted', 'PLUGIN_EXPECTATION_INVALID');
  const runRoot = await realpath(config.runRoot);
  const layout = runLayout(runRoot), game = gameLayout(runRoot);
  const record = {label, expectation};
  const before = await fileState(game.dll);
  if (expectation === 'adopted') {
    assert.equal(typeof before, 'object', 'ADOPTED_PLUGIN_MISSING');
    assert.equal(await fileState(path.join(layout.dataRoot, 'uninstall', 'pending.json')), 'absent', 'DEFERRAL_NOT_CANCELLED');
    assert.equal(await fileState(path.join(layout.dataRoot, 'uninstall', 'README.txt')), 'absent', 'DEFERRAL_NOT_CANCELLED');
    // PR-5: the reinstall's hook also removed the copied executor and its RunOnce value.
    assert.equal(await fileState(path.join(layout.dataRoot, 'uninstall', EXECUTOR_FILE)), 'absent', 'DEFERRAL_NOT_CANCELLED');
    assert.equal(await readRunOnce(config), null, 'RUN_ONCE_NOT_CANCELLED');
    record.deferralCancelled = true;
  }
  const keptBefore = await keptStates(runRoot);
  const started = await startWithPlugin(config, label, executable);
  await closeOrderly(started.application);
  record.exit = {code: started.launcher.exitCode, signal: started.launcher.signalCode};
  assert.deepEqual(record.exit, {code: 0, signal: null}, 'LAUNCH_EXIT_NONZERO');
  const after = await fileState(game.dll);
  if (expectation === 'adopted') {
    assert.deepEqual(after, before, 'ADOPTED_PLUGIN_REWRITTEN');
    record.adoptedUnchanged = true;
  }
  record.pluginInstalled = typeof after === 'object' && after.sha256 === started.bundled;
  assert.deepEqual(await keptStates(runRoot), keptBefore, 'UNRELATED_FILES_CHANGED');
  const main = await serviceEvents(started.diagnostics);
  record.failures = main.filter(row => FAILURE_EVENT.test(row.event)).map(row => row.event);
  record.pluginMode = main.filter(row => row.event === 'PLUGIN_SETUP_MODE').map(row => row.facts?.mode);
  assert.deepEqual(record.failures, [], 'FAILURE_EVENT_LOGGED');
  assert.deepEqual(record.pluginMode, ['test-root'], 'PLUGIN_MODE_UNEXPECTED');
  return record;
}

const FAKE_HOST = path.join(checkout, 'native', 'telemetry-plugin', 'build', 'cap0-host', 'Release', 'eurotrucks2.exe');
const TEST_PLUGIN = path.join(checkout, 'native', 'telemetry-plugin', 'build', 'Release', 'snapshot-transport-test-plugin.dll');
/**
 * The tests-only fake SDK host, named eurotrucks2.exe, with the isolated test plugin DLL and a transport folder inside R.
 * The production DLL is never loaded: it would write `transport\` into the real LocalAppData.
 */
async function startFakeGame(config, readyMs = 15000) {
  assert.ok(await regularFile(FAKE_HOST) && await regularFile(TEST_PLUGIN), 'FAKE_GAME_HOST_MISSING');
  // The host secures and creates only the transport folder and its parent, as the plugin does under its data root, so
  // the folder above them must exist.
  const transport = path.join(config.runRoot, 'fake-game', 'transport', 'v0');
  await mkdir(path.dirname(path.dirname(transport)), {recursive: true});
  const host = spawn(FAKE_HOST, ['host', TEST_PLUGIN, transport], {cwd: runLayout(config.runRoot).cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let output = '', errors = '';
  host.stdout.on('data', chunk => {output += chunk.toString('utf8');});
  host.stderr.on('data', chunk => {if (errors.length < 1024) errors += chunk.toString('utf8');});
  await until(async () => output.includes('"ready":true') || host.exitCode !== null, Boolean, 'FAKE_GAME_NOT_READY', readyMs);
  // The host's failure line names a failed requirement; any path in it is removed before it reaches the evidence.
  assert.equal(host.exitCode, null, `FAKE_GAME_EXITED ${errors.replace(/[A-Za-z]:\\[^\s"]*/g, '<path>').trim().slice(0, 200)}`.trim());
  return host;
}
async function stopFakeGame(host) {
  if (host.exitCode !== null) return;
  host.stdin.end('exit\n');
  await until(async () => host.exitCode !== null, Boolean, 'FAKE_GAME_NOT_STOPPED', 5000).catch(() => {host.kill();});
}
const receiptNames = async directory => (await readdir(directory).catch(() => [])).filter(name => RECEIPT_NAME.test(name));

// ET-018 PR-5 (U7): the deferred-cleanup executor and its registration. The run's test file names this run's own
// HKCU\Software\ETS2Telemetry-Test-<id>\RunOnce key (config.runOnceKey); the driver reads and deletes only that key's one
// value, through the fixed reg.exe, and never the real RunOnce key. The harness deletes the whole test key at the end.
const RUN_ONCE_VALUE = 'ETS2TelemetryUninstall';
const EXECUTOR_FILE = 'Complete-ETS2TelemetryUninstall.ps1';
const EXECUTOR_RECEIPT_NAME = /^ETS2Telemetry-deferred-cleanup-\d{8}T\d{9}Z\.json$/;
const reg = () => path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
function testRunOnceKey(config) {
  assert.ok(typeof config.runOnceKey === 'string' && RUN_ONCE_KEY.test(config.runOnceKey), 'RUN_ONCE_KEY_INVALID');
  return config.runOnceKey;
}
const EXECUTOR_ARGUMENTS = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File';
/**
 * The registered command the application writes (executor.ts executorCommand): the absolute, quoted powershell.exe under
 * %SystemRoot% when the command fits 260 characters, otherwise the PATH form `powershell.exe`. The run root on a hosted
 * runner makes the script path 126 characters, so the lifecycle registers the PATH form (139 + 126 > 260).
 */
function executorCommand(dataRoot) {
  const windows = /^[A-Za-z]:\\[^\\/:*?"<>|]+(\\[^\\/:*?"<>|]+)*$/.test(process.env.SystemRoot ?? '') ? path.win32.normalize(process.env.SystemRoot) : 'C:\\Windows';
  const script = `"${path.win32.join(dataRoot, 'uninstall', EXECUTOR_FILE)}"`;
  for (const program of [`"${path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')}"`, 'powershell.exe']) {
    const command = `${program} ${EXECUTOR_ARGUMENTS} ${script}`;
    if (command.length <= 260) return command;
  }
  return null;
}
/** The test key's value, or null when it is absent (reg.exe exits 1). */
async function readRunOnce(config) {
  let stdout;
  try {({stdout} = await promisify(execFile)(reg(), ['query', testRunOnceKey(config), '/v', RUN_ONCE_VALUE], {encoding: 'utf8', windowsHide: true, timeout: 10000}));}
  catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}REG_SZ {4}(.*)$/.exec(line);
    if (match && match[1] === RUN_ONCE_VALUE) return match[2];
  }
  throw new Error('RUN_ONCE_QUERY_UNPARSED');
}
async function deleteRunOnce(config) {
  await promisify(execFile)(reg(), ['delete', testRunOnceKey(config), '/v', RUN_ONCE_VALUE, '/f'], {windowsHide: true, timeout: 10000});
}
const executorReceipts = async directory => (await readdir(directory).catch(() => [])).filter(name => EXECUTOR_RECEIPT_NAME.test(name));

/**
 * Runs the exact registered UninstallString as Windows Settings would, with LOCALAPPDATA = R\decoy and no ETS2TELEMETRY_
 * variable. `complete`: the application runs from `exe` with the plugin installed; afterwards it has exited, the DLL and
 * the data root are gone, and the unrelated files, the game files, the export and the decoy are unchanged. `deferred`:
 * the fake ETS2 runs; the DLL stays, only `plugins` and `uninstall` (with the intent and README.txt) remain. The receipt
 * in R\temp must say the same. The harness checks the registration, the shortcuts and the vendor residue afterwards.
 * `rehearse` runs everything up to the UninstallString, which it parses but never starts, and returns the record.
 */
async function windowsUninstall(config, label, executable, expectation, rehearse = false) {
  assert.ok(expectation === 'complete' || expectation === 'deferred', 'UNINSTALL_EXPECTATION_INVALID');
  checkRunSignal(process.env, {allowLocal: config.allowLocal === true});
  const runRoot = await realpath(config.runRoot);
  const layout = runLayout(runRoot), game = gameLayout(runRoot), decoy = decoyOf(runRoot), facts = machineFacts();
  const {program, args} = parseUninstallString(facts.registration?.uninstallString, runRoot);
  const env = uninstallEnvironment(process.env, {runRoot, real: facts.real, decoy});
  const record = {label, expectation, args};
  const decoyBefore = await tree(decoy), keptBefore = await keptStates(runRoot);
  const receiptsBefore = new Set(await receiptNames(layout.temp));
  let started, host, dllBefore;
  try {
    // In `complete` the launch itself installs the plugin (the registry has no install before it), so the plugin is
    // checked only once the application or the fake game runs, right before the UninstallString.
    if (expectation === 'complete') started = await startWithPlugin(config, label, executable);
    else host = await startFakeGame(config);
    dllBefore = await fileState(game.dll);
    assert.equal(typeof dllBefore, 'object', 'PLUGIN_NOT_INSTALLED_BEFORE_UNINSTALL');
    record.pluginInstalledBefore = true;
    if (rehearse) record.rehearsal = true;
    else record.run = await runAndDrain(config, `uninstall-${label}`, program, args, env, UNINSTALL_RUN_BUDGET_MS).catch(error => ({failure: failure(error)}));
    if (started && !rehearse) {
      // The instance must be gone: Squirrel ends the processes under its root, or the hook's lock request makes it exit.
      await until(async () => started.launcher.exitCode !== null || started.launcher.signalCode !== null, Boolean, 'INSTANCE_DID_NOT_EXIT', 10000);
      record.instanceExit = {code: started.launcher.exitCode, signal: started.launcher.signalCode};
    }
  } finally {
    if (started) await started.application.close().catch(() => undefined);
    if (host) await stopFakeGame(host);
  }
  if (rehearse) return record;
  assert.equal(record.run.failure, undefined, `UNINSTALL_RUN_FAILED ${record.run.failure?.message ?? ''}`.trim());
  const receipts = (await receiptNames(layout.temp)).filter(name => !receiptsBefore.has(name));
  assert.equal(receipts.length, 1, 'UNINSTALL_RECEIPT_COUNT');
  const text = await readFile(path.join(layout.temp, receipts[0]), 'utf8');
  assert.doesNotMatch(text, /[A-Za-z]:\\|\\\\/, 'UNINSTALL_RECEIPT_HAS_PATH');
  record.receipt = JSON.parse(text);
  // What the uninstall left, recorded before any assertion so a failing run still shows the receipt and the state.
  const decoyAfter = await tree(decoy), kept = await keptStates(runRoot), dllAfter = await fileState(game.dll);
  const dataEntries = await readdir(layout.dataRoot).catch(error => {if (error?.code === 'ENOENT') return null; throw error;});
  const runOnce = await readRunOnce(config);
  record.after = {dataEntries, plugin: typeof dllAfter === 'string' ? dllAfter : 'present', unrelatedUnchanged: JSON.stringify(kept) === JSON.stringify(keptBefore),
    runOnce: runOnce === null ? 'absent' : runOnce === executorCommand(layout.dataRoot) ? 'executor' : 'unexpected'};
  await writeEvidence(config, `windows-uninstall-${label}-observed.json`, record).catch(() => undefined);
  // Windows may add its own Microsoft folder under the decoy (DECOY_OS_FOLDER); everything else must stay as it was.
  record.decoyOsEntries = checkDecoyUnchanged(decoyBefore, decoyAfter);
  record.decoyUnchanged = true;
  assert.deepEqual(kept, keptBefore, 'UNRELATED_FILES_CHANGED');
  record.unrelatedUnchanged = true;
  if (expectation === 'complete') {
    assert.equal(dllAfter, 'absent', 'PLUGIN_NOT_REMOVED');
    assert.equal(dataEntries, null, 'DATA_ROOT_REMAINS');
    assert.equal(record.receipt.outcome, 'complete', 'RECEIPT_NOT_COMPLETE');
    assert.equal(record.receipt.code, null);
    assert.equal(record.receipt.mode, 'test-root');
    assert.equal(record.receipt.plugins.removed, 1, 'RECEIPT_PLUGIN_COUNT');
    assert.equal(record.receipt.data.rootRemoved, true);
    assert.ok(['none', 'exited'].includes(record.receipt.instance), 'RECEIPT_INSTANCE_UNEXPECTED');
    // PR-5: registered before the first deletion, removed last.
    assert.equal(record.receipt.executor, 'removed', 'RECEIPT_EXECUTOR_NOT_REMOVED');
    assert.equal(record.after.runOnce, 'absent', 'RUN_ONCE_LEFT_AFTER_COMPLETE');
  } else {
    assert.deepEqual(dllAfter, dllBefore, 'DEFERRED_PLUGIN_CHANGED');
    assert.deepEqual(dataEntries?.sort(), ['plugins', 'uninstall'], 'DEFERRED_DATA_ENTRIES_UNEXPECTED');
    assert.deepEqual((await readdir(path.join(layout.dataRoot, 'uninstall'))).sort(), [EXECUTOR_FILE, 'README.txt', 'pending.json'], 'DEFERRED_UNINSTALL_FOLDER_UNEXPECTED');
    assert.deepEqual({outcome: record.receipt.outcome, code: record.receipt.code, readme: record.receipt.readme, executor: record.receipt.executor},
      {outcome: 'deferred', code: 'GAME_RUNNING', readme: true, executor: 'registered'}, 'RECEIPT_NOT_DEFERRED');
    // PR-5: the packaged executor was copied byte-identically and registered under this run's test key.
    assert.deepEqual(await fileState(path.join(layout.dataRoot, 'uninstall', EXECUTOR_FILE)).then(state => typeof state === 'object' ? state.sha256 : state),
      sha256(await readFile(path.join(checkout, 'resources', 'uninstall', EXECUTOR_FILE))), 'EXECUTOR_COPY_DIFFERS');
    assert.equal(record.after.runOnce, 'executor', 'RUN_ONCE_NOT_REGISTERED');
  }
  return record;
}

/**
 * ET-018 PR-5 (U7): the deferred-cleanup executor at the next sign-in. Windows deletes a RunOnce value before it starts
 * its command; this does the same with this run's test key: the value must be exactly the executor command for R's data
 * root, it is deleted, and the command is started (powershell.exe from System32 with the parsed arguments) with the
 * uninstall environment (LOCALAPPDATA = the decoy, TEMP inside R, no ETS2TELEMETRY_ variable). `blocked`: the fake game
 * host runs, so the executor must keep the DLL, count the attempt and register itself again. `complete`: the host is not
 * running, so the DLL, the data root and the registration must be gone. The unrelated files, the export and the decoy
 * stay unchanged either way, and the executor's receipt names no path.
 */
async function runOnce(config, label, expectation) {
  assert.ok(expectation === 'blocked' || expectation === 'complete', 'RUN_ONCE_EXPECTATION_INVALID');
  assert.match(label, /^[a-z0-9-]{1,40}$/, 'RUN_ONCE_LABEL_INVALID');
  checkRunSignal(process.env, {allowLocal: config.allowLocal === true});
  const runRoot = await realpath(config.runRoot);
  const layout = runLayout(runRoot), game = gameLayout(runRoot), decoy = decoyOf(runRoot), facts = machineFacts();
  const env = uninstallEnvironment(process.env, {runRoot, real: facts.real, decoy});
  const command = await readRunOnce(config);
  assert.equal(command, executorCommand(layout.dataRoot), 'RUN_ONCE_COMMAND_UNEXPECTED');
  // Either form of the program (the absolute, quoted System32 path or the PATH form); the driver starts System32's.
  const match = /^(?:"[A-Za-z]:\\[^"]+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe"|powershell\.exe) (-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden) -File "([^"]+)"$/
    .exec(command);
  assert.ok(match && normalizePath(match[2]).startsWith(`${normalizePath(layout.dataRoot)}\\`), 'RUN_ONCE_COMMAND_OUTSIDE_RUN_ROOT');
  const attemptsBefore = (await readJson(path.join(layout.dataRoot, 'uninstall', 'pending.json'), 128 * 1024)).attempts;
  const record = {label, expectation, attemptsBefore, before: {kept: await keptStates(runRoot), plugin: await fileState(game.dll)}};
  const decoyBefore = await tree(decoy), receiptsBefore = new Set(await executorReceipts(layout.temp));
  await deleteRunOnce(config);
  let host;
  try {
    if (expectation === 'blocked') host = await startFakeGame(config);
    const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const started = performance.now();
    const child = spawn(powershell, [...match[1].split(' '), '-File', match[2]], {cwd: layout.cwd, env, stdio: 'ignore', windowsHide: true});
    record.exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {child.kill(); reject(new Error('RUN_ONCE_TIMEOUT'));}, 30000);
      child.on('error', error => {clearTimeout(timer); reject(error);});
      child.on('exit', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
    });
    record.milliseconds = Math.round(performance.now() - started);
  } finally {
    if (host) await stopFakeGame(host);
  }
  const receipts = (await executorReceipts(layout.temp)).filter(name => !receiptsBefore.has(name));
  assert.equal(receipts.length, 1, 'EXECUTOR_RECEIPT_COUNT');
  const text = await readFile(path.join(layout.temp, receipts[0]), 'utf8');
  assert.doesNotMatch(text, /[A-Za-z]:\\|\\\\/, 'EXECUTOR_RECEIPT_HAS_PATH');
  record.receipt = JSON.parse(text);
  const value = await readRunOnce(config), dllAfter = await fileState(game.dll);
  const dataEntries = await readdir(layout.dataRoot).catch(error => {if (error?.code === 'ENOENT') return null; throw error;});
  record.after = {dataEntries, plugin: typeof dllAfter === 'string' ? dllAfter : 'present', runOnce: value === null ? 'absent' : value === command ? 'executor' : 'unexpected',
    kept: await keptStates(runRoot)};
  await writeEvidence(config, `run-once-${label}-observed.json`, record).catch(() => undefined);
  record.decoyOsEntries = checkDecoyUnchanged(decoyBefore, await tree(decoy));
  assert.deepEqual(record.after.kept, record.before.kept, 'UNRELATED_FILES_CHANGED');
  if (expectation === 'blocked') {
    assert.deepEqual({outcome: record.receipt.outcome, code: record.receipt.code, attempts: record.receipt.attempts, runOnce: record.receipt.runOnce, mode: record.receipt.mode},
      {outcome: 'deferred', code: 'GAME_RUNNING', attempts: attemptsBefore + 1, runOnce: 'registered', mode: 'test-root'}, 'EXECUTOR_NOT_DEFERRED');
    assert.deepEqual(dllAfter, record.before.plugin, 'BLOCKED_PLUGIN_CHANGED');
    assert.deepEqual(dataEntries?.sort(), ['plugins', 'uninstall'], 'BLOCKED_DATA_ENTRIES_UNEXPECTED');
    assert.equal(record.after.runOnce, 'executor', 'EXECUTOR_NOT_REGISTERED_AGAIN');
    assert.equal((await readJson(path.join(layout.dataRoot, 'uninstall', 'pending.json'), 128 * 1024)).attempts, attemptsBefore + 1, 'ATTEMPT_NOT_COUNTED');
  } else {
    assert.deepEqual({outcome: record.receipt.outcome, code: record.receipt.code, runOnce: record.receipt.runOnce, mode: record.receipt.mode, removed: record.receipt.plugins.removed,
      rootRemoved: record.receipt.data.rootRemoved}, {outcome: 'complete', code: null, runOnce: 'removed', mode: 'test-root', removed: 1, rootRemoved: true}, 'EXECUTOR_NOT_COMPLETE');
    assert.equal(dllAfter, 'absent', 'PLUGIN_NOT_REMOVED');
    assert.equal(dataEntries, null, 'DATA_ROOT_REMAINS');
    assert.equal(record.after.runOnce, 'absent', 'RUN_ONCE_LEFT_AFTER_COMPLETE');
    assert.deepEqual(record.exit, {code: 0, signal: null}, 'EXECUTOR_EXIT_NONZERO');
  }
  return record;
}

// ET-018 PR-4 (REG-015; plan U8): the in-app uninstall. The application runs with the diagnostic gate
// (ETS2TELEMETRY_LIVE_SMOKE=1, a diagnostic and a profile folder in R), so the app event
// `ets2telemetry:diagnostic-uninstall-dialogs` answers its confirmation and result dialogs; no renderer can reach it. The
// button on the dashboard's uninstall card is pressed as a user would. Records keep fixed codes, hashes and counts only.
//
// Each scenario is two driver commands, each in its own BoundedProcess Job of at most 60 s: `app-uninstall` runs the
// application and the in-app flow and, for `complete`, waits until Update.exe and Squirrel's hook have ended (they are in
// that command's Job, which would end them when it closes); it records what it saw and asserts nothing about the outcome.
// `app-uninstall-verify` then reads that record and the files and asserts the outcome.
/** Everything `app-uninstall` does stays within this, below the 60 s Job; every wait is cut to what is left of it. */
const APP_UNINSTALL_RUN_BUDGET_MS = 55000;
/** What the blocked run keeps of that budget for its closing waits: closeOrderly's 8 s and stopFakeGame's 5 s. */
const APP_UNINSTALL_CLOSE_RESERVE_MS = 13000;
/**
 * Every entry of the data root by relative name, with its size and hash, as recorded; `checkDataRootUnchanged`
 * (installer-guard.mjs, unit-tested) decides what a blocked run may change: only the history database's SQLite sidecars
 * and pages, which the running application and its orderly close checkpoint.
 */
const dataRootState = dataRoot => tree(dataRoot);
/** Waits until no process image under R is left, or the budget ends; returns the images still there, relative to R. */
async function drainRunRoot(config, budget) {
  const started = performance.now();
  for (;;) {
    const remaining = (await processImages()).filter(image => normalizePath(image).startsWith(`${normalizePath(config.runRoot)}\\`));
    if (!remaining.length || performance.now() - started > budget) return {drainedMilliseconds: Math.round(performance.now() - started), remaining: remaining.map(image => path.relative(config.runRoot, image))};
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}
const observedFile = (config, label) => path.join(config.evidence, `app-uninstall-${label}-observed.json`);
/**
 * The in-app uninstall of the installed application from `exe`, whose plugin a preceding `plugin-launch` installed into
 * the fake ETS2 folder. `blocked`: the fake game host runs; the button is pressed, the card's answer is read, and the
 * application is closed orderly. `complete`: the button is pressed; the application removes the plugin, exits, wipes its
 * data root and starts Update.exe --uninstall, and the command waits until every process under R has ended. Writes
 * `app-uninstall-<label>-observed.json` with the states before and after; `app-uninstall-verify` asserts them.
 */
async function appUninstall(config, label, executable, expectation) {
  assert.ok(expectation === 'complete' || expectation === 'blocked', 'APP_UNINSTALL_EXPECTATION_INVALID');
  assert.match(label, /^[a-z0-9-]{1,40}$/, 'APP_UNINSTALL_LABEL_INVALID');
  checkRunSignal(process.env, {allowLocal: config.allowLocal === true});
  const clockStarted = performance.now();
  // The blocked run ends with fixed waits of its own (the orderly close, 8 s; the fake game's stop, 5 s), kept in reserve.
  const budget = APP_UNINSTALL_RUN_BUDGET_MS - (expectation === 'blocked' ? APP_UNINSTALL_CLOSE_RESERVE_MS : 0);
  // At least 1 ms: Playwright and electron.launch read a timeout of 0 as no timeout at all.
  const left = (cap = budget) => Math.max(1, Math.min(cap, budget - (performance.now() - clockStarted)));
  const runRoot = await realpath(config.runRoot);
  const layout = runLayout(runRoot), game = gameLayout(runRoot);
  const record = {label, expectation, before: {kept: await keptStates(runRoot), receipts: await receiptNames(layout.temp)}};
  // The plugin is already installed, so this returns as soon as the dashboard is ready and the registry names it.
  record.before.plugin = await fileState(game.dll);
  assert.equal(typeof record.before.plugin, 'object', 'PLUGIN_NOT_INSTALLED_BEFORE_UNINSTALL');
  const started = await startWithPlugin(config, label, executable, {ETS2TELEMETRY_LIVE_SMOKE: '1'}, left);
  let host, closed = false;
  try {
    if (expectation === 'blocked') host = await startFakeGame(config, left(15000));
    record.before.pluginAtClick = await fileState(game.dll);
    record.before.dataRoot = await dataRootState(layout.dataRoot);
    await started.application.evaluate(({app}) => {app.emit('ets2telemetry:diagnostic-uninstall-dialogs', 'uninstall');});
    const {dashboard} = await rendererPages(started.application);
    await settingsPanel(dashboard, 'about', left);
    await dashboard.getByTestId('uninstall-warning').waitFor({state: 'visible', timeout: left(10000)});
    const warning = await dashboard.getByTestId('uninstall-warning').innerText({timeout: left(10000)});
    record.warningShown = /trip history/.test(warning) && /captures/.test(warning) && /exports/i.test(warning);
    await dashboard.getByTestId('uninstall-button').click({timeout: left(10000)});
    if (expectation === 'blocked') {
      const result = dashboard.getByTestId('uninstall-result');
      await result.waitFor({state: 'visible', timeout: left(20000)});
      const text = await result.innerText();
      record.blockedShown = text.includes('was not uninstalled, and nothing was changed');
      record.blockedFolders = await dashboard.getByTestId('uninstall-blocked-folder').count();
      record.pathShown = /[A-Za-z]:\\/.test(text);
      await closeOrderly(started.application);
      closed = true;
      record.exit = {code: started.launcher.exitCode, signal: started.launcher.signalCode};
    } else {
      // The application closes itself: the explicit exit, the wipe, the handover to Update.exe, app.exit(0).
      await until(async () => started.launcher.exitCode !== null || started.launcher.signalCode !== null, Boolean, 'APP_DID_NOT_EXIT', left(30000));
      closed = true;
      record.exit = {code: started.launcher.exitCode, signal: started.launcher.signalCode};
      // Update.exe and Squirrel's hook run in this command's Job: it must not end before they have.
      record.drain = await drainRunRoot(config, left());
    }
  } finally {
    if (!closed) await started.application.close().catch(() => undefined);
    if (host) await stopFakeGame(host);
  }
  if (expectation === 'blocked') {
    record.after = {plugin: await fileState(game.dll), dataRoot: await dataRootState(layout.dataRoot)};
  }
  record.diagnostics = path.relative(runRoot, started.diagnostics);
  record.elapsedMs = Math.round(performance.now() - clockStarted);
  await writeEvidence(config, path.basename(observedFile(config, label)), record);
  return {elapsedMs: record.elapsedMs, exit: record.exit, drain: record.drain ?? null};
}

/** Asserts what `app-uninstall` recorded and what the files say now; see installer-testing.md, "In-app uninstall scenarios". */
async function appUninstallVerify(config, label) {
  assert.match(label, /^[a-z0-9-]{1,40}$/, 'APP_UNINSTALL_LABEL_INVALID');
  const runRoot = await realpath(config.runRoot);
  const layout = runLayout(runRoot), game = gameLayout(runRoot);
  const observed = await readJson(observedFile(config, label), 4 * 1024 * 1024);
  const {expectation, before} = observed;
  const main = await serviceEvents(path.join(runRoot, observed.diagnostics));
  const events = {
    dialogs: main.filter(row => row.event === 'DIAGNOSTIC_UNINSTALL_DIALOG').map(row => row.facts),
    uninstall: main.filter(row => row.event === 'APP_UNINSTALL').map(row => ({outcome: row.facts?.outcome, code: row.facts?.code ?? null})),
    finished: main.filter(row => row.event === 'APP_UNINSTALL_FINISHED').map(row => ({removed: row.facts?.removed, rootRemoved: row.facts?.rootRemoved, failed: row.facts?.failed})),
    failures: main.filter(row => FAILURE_EVENT.test(row.event)).map(row => row.event)
  };
  const kept = await keptStates(runRoot), dllAfter = await fileState(game.dll);
  const receipts = (await receiptNames(layout.temp)).filter(name => !before.receipts.includes(name));
  const record = {label, expectation, events, plugin: typeof dllAfter === 'string' ? dllAfter : 'present', unrelatedUnchanged: JSON.stringify(kept) === JSON.stringify(before.kept),
    receipts: receipts.length};
  if (receipts.length === 1) {
    const text = await readFile(path.join(layout.temp, receipts[0]), 'utf8');
    assert.doesNotMatch(text, /[A-Za-z]:\\|\\\\/, 'UNINSTALL_RECEIPT_HAS_PATH');
    record.receipt = JSON.parse(text);
  }
  // What the run left, recorded before any assertion so a failing run still shows it.
  await writeEvidence(config, `app-uninstall-${label}-verified.json`, record).catch(() => undefined);
  assert.equal(observed.warningShown, true, 'UNINSTALL_WARNING_MISSING');
  assert.deepEqual(kept, before.kept, 'UNRELATED_FILES_CHANGED');
  assert.deepEqual(events.failures, [], 'FAILURE_EVENT_LOGGED');
  assert.deepEqual(events.dialogs.slice(0, 1), [{dialog: 'confirm', answer: 'uninstall'}], 'CONFIRM_NOT_ANSWERED');
  if (expectation === 'blocked') {
    assert.deepEqual({shown: observed.blockedShown, folders: observed.blockedFolders, path: observed.pathShown}, {shown: true, folders: 1, path: false}, 'BLOCKED_NOT_SHOWN');
    assert.deepEqual(events.uninstall, [{outcome: 'blocked', code: 'GAME_RUNNING'}], 'APP_UNINSTALL_NOT_BLOCKED');
    assert.deepEqual(observed.exit, {code: 0, signal: null}, 'LAUNCH_EXIT_NONZERO');
    // Nothing changed: the plugin keeps its bytes and time, the data root its entries, and no intent was written.
    assert.deepEqual(observed.after.plugin, observed.before.pluginAtClick, 'BLOCKED_PLUGIN_CHANGED');
    assert.deepEqual(dllAfter, observed.before.pluginAtClick, 'BLOCKED_PLUGIN_CHANGED');
    // The before state is taken while the application runs (its WAL may exist), the after state once it closed.
    record.dataSidecarsIgnored = checkDataRootUnchanged(observed.before.dataRoot, observed.after.dataRoot);
    assert.equal(await fileState(path.join(layout.dataRoot, 'uninstall', 'pending.json')), 'absent', 'BLOCKED_INTENT_WRITTEN');
    assert.equal(events.dialogs.length, 1, 'BLOCKED_RESULT_DIALOG');
    assert.equal(receipts.length, 0, 'BLOCKED_HOOK_RAN');
  } else {
    assert.deepEqual(observed.drain.remaining, [], 'APP_UNINSTALL_PROCESSES_REMAIN');
    assert.deepEqual(events.uninstall, [{outcome: 'started', code: null}], 'APP_UNINSTALL_NOT_STARTED');
    assert.deepEqual(events.finished, [{removed: 1, rootRemoved: true, failed: 0}], 'APP_UNINSTALL_NOT_FINISHED');
    assert.deepEqual(events.dialogs, [{dialog: 'confirm', answer: 'uninstall'}, {dialog: 'result', rootRemoved: true, failed: 0}], 'RESULT_DIALOG_NOT_ANSWERED');
    assert.equal(dllAfter, 'absent', 'PLUGIN_NOT_REMOVED');
    assert.equal(await fileState(layout.dataRoot), 'absent', 'DATA_ROOT_REMAINS');
    // Squirrel's hook ran after the handover and found nothing left to do.
    assert.equal(receipts.length, 1, 'UNINSTALL_RECEIPT_COUNT');
    assert.deepEqual({outcome: record.receipt.outcome, code: record.receipt.code, mode: record.receipt.mode, removed: record.receipt.plugins.removed},
      {outcome: 'complete', code: null, mode: 'test-root', removed: 0}, 'HOOK_RECEIPT_UNEXPECTED');
  }
  return record;
}

/**
 * The binary-root residue after an uninstall (checkUninstallResidue), from the listing the harness wrote and the Electron
 * runtime names of this checkout's `node_modules/electron/dist`. Records the tolerated runtime files.
 */
async function residue(config, label) {
  assert.match(label, /^[a-z0-9-]{1,40}$/, 'RESIDUE_LABEL_INVALID');
  const listing = await readJson(path.join(config.evidence, `residue-listing-${label}.json`), 1024 * 1024);
  const dist = path.join(checkout, 'node_modules', 'electron', 'dist');
  const entries = (await readdir(dist, {withFileTypes: true})).map(entry => ({name: entry.name, directory: entry.isDirectory()}));
  const runtime = electronRuntimeNames(entries, await readdir(path.join(dist, 'locales')));
  const result = checkUninstallResidue(Array.isArray(listing) ? listing : listing ? [listing] : [], runtime);
  return {entries: Array.isArray(listing) ? listing.length : listing ? 1 : 0, vendorFiles: result.vendorFiles, toleratedRuntimeResidue: result.tolerated,
    toleratedRuntimeResidueCount: result.tolerated.length};
}

/**
 * Deletes R without following any link (fs.rm unlinks a junction or symbolic link instead of entering it), and decides
 * for each registry view whether the HKCU uninstall key the harness read there may be deleted: only when that view's
 * InstallLocation points into R (ownsRegistration). `locations` holds one argument per view, `-` for a view without the
 * key (Windows PowerShell 5.1 drops empty arguments).
 */
async function cleanup(config, locations) {
  assert.ok(RUN_ROOT_NAME.test(path.win32.basename(config.runRoot)), 'CLEANUP_ROOT_INVALID');
  await rm(config.runRoot, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  return {removed: true, ownsRegistration: locations.map(location => location !== '-' && ownsRegistration(config.runRoot, location))};
}

const [command, ...rest] = process.argv.slice(2);
const result = {command, passed: false, startedUtc: new Date().toISOString()};
let config;
try {
  if (command === 'signal') {
    checkRunSignal(process.env, {allowLocal: rest.includes('--allow-local')});
    result.passed = true;
  } else {
    config = await readJson(rest[0], 64 * 1024);
    assert.ok(RUN_ROOT_NAME.test(path.win32.basename(config.runRoot)), 'CONFIG_RUN_ROOT_INVALID');
    const label = rest[1];
    switch (command) {
      case 'guard': result.result = await guard(config, label); break;
      case 'installed': result.result = await installed(config, label, rest[2]); break;
      case 'legacy-icon': result.result = await legacyIcon(config, label, rest.slice(2)); break;
      case 'legacy-names': result.result = await legacyNames(config, label, rest.slice(2)); break;
      case 'links': result.result = links(label, rest[2], rest.slice(3)); break;
      case 'version-info': result.result = versionInfo(config, label, rest[2]); break;
      case 'seed': result.result = await seed(config); break;
      case 'snapshot': result.result = await snapshot(config); break;
      case 'compare': result.result = await compare(config, rest[1], rest[2]); break;
      case 'step': result.result = await step(config, label, rest[2], rest.slice(3)); break;
      case 'launch': result.result = await launch(config, label, rest[2], rest[3]); break;
      case 'verify': result.result = await verify(config, label, rest[2]); break;
      case 'games': result.result = await games(config); break;
      case 'plugin-launch': result.result = await pluginLaunch(config, label, rest[2], rest[3]); break;
      case 'windows-uninstall': result.result = await windowsUninstall(config, label, rest[2], rest[3], rest[4] === '--rehearse'); break;
      case 'app-uninstall': result.result = await appUninstall(config, label, rest[2], rest[3]); break;
      case 'app-uninstall-verify': result.result = await appUninstallVerify(config, label); break;
      case 'run-once': result.result = await runOnce(config, label, rest[2]); break;
      case 'residue': result.result = await residue(config, label); break;
      case 'cleanup': result.result = await cleanup(config, rest.slice(1)); break;
      default: throw new Error('UNKNOWN_COMMAND');
    }
    result.passed = true;
  }
} catch (error) {
  result.failure = error instanceof InstallerGuardError ? {name: error.name, code: error.code, message: error.message} : failure(error);
}
result.finishedUtc = new Date().toISOString();
if (config) {
  // Evidence file names use fixed labels only; the cleanup argument is a path and never becomes part of a name.
  const name = command === 'seed' || command === 'cleanup' || command === 'games' ? `${command}.json` : command === 'compare' ? `compare-${rest[1]}-${rest[2]}.json` : `${command}-${rest[1]}.json`;
  try {await writeEvidence(config, name, result);} catch (error) {result.evidenceFailure = failure(error);}
}
// One JSON line for the harness; `cleanup` also reports whether the uninstall key may be deleted.
process.stdout.write(`${JSON.stringify({command, passed: result.passed, failure: result.failure ?? null,
  ...(command === 'cleanup' ? {ownsRegistration: Array.isArray(result.result?.ownsRegistration) ? result.result.ownsRegistration : []} : {})})}\n`);
process.exitCode = result.passed ? 0 : 1;
