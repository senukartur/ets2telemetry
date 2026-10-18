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
import {checkedPaths, checkInstalled, checkLaunchEnvironment, checkRunPlan, checkRunSignal, FACTS_VARIABLE, factsEvidence, InstallerGuardError, installedEnvironment, normalizePath,
  ownsRegistration, resolveRealLocation, RUN_ROOT_NAME, runLayout, steamLibraryPaths} from './installer-guard.mjs';

// ET-018 PR-1 (REG-013, REG-017; plan U10-U13): the Node driver of the installer lifecycle in a marked test root. The
// PowerShell harness scripts/installer/Invoke-InstallerLifecycle.ps1 orchestrates the steps and runs every command below
// that starts a process under a BoundedProcess Job; this file never runs an installer by itself except through `step`,
// which the harness calls only after the guards passed. See docs/installer-testing.md.
//
// Commands (all paths come from the harness's config file; evidence goes to config.evidence):
//   signal [--allow-local]                    the CI signal (checkRunSignal); first, before anything is read
//   guard <config> <plan|ready>               the fail-closed preflight (checkRunPlan) on the harness's facts
//   installed <config> <label>                checkInstalled on the facts the harness read after an installer step
//   seed <config>                             writes the synthetic data root, the settings, the registry and the export
//   snapshot <config> <label>                 hashes every file of the data root and the export folder
//   compare <config> <before> <after>         an installer hook must leave both byte-identical (no data write)
//   step <config> <label> <exe> [args...]     runs one installer program and waits until no process image under R is left
//   launch <config> <label> <exe> <1|none>    a data launch of the installed application with LOCALAPPDATA = R\LocalAppData
//   verify <config> <label> <exe>             reads the upgraded database with the installed Electron and better-sqlite3
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

// The upgraded database, written by hand from tests/fixtures/storage/schema-v1-representative.sql and the 0002-journal
// migration (docs/storage.md, J6); `backup` is filled from the one manifest the migration wrote.
export function expectedDatabase(backup) {
  const counts = {plugin_sessions: 1, clocks: 2, events: 5, event_gaps: 1, job_configurations: 1, truck_configurations: 1, trailer_configurations: 1,
    event_amounts: 1, trips: 1, trip_trailers: 1, event_attributions: 4, completeness_intervals: 1, samples: 3};
  return {
    userVersion: 2, applicationId: 1163154226, integrity: ['ok'], foreignKeyViolations: 0,
    info: [{database_uuid: 'f0000000-0000-4000-8000-000000000001', purpose: 'synthetic', accepted_origin: 'synthetic', created_utc_ms: 1791676800000, created_app_version: '0.1.0'}],
    counts,
    migrations: [{version: 1, name: '0001-initial', app_version: '0.1.0', backup_file_name: null, backup_sha256: null},
      {version: 2, name: '0002-journal', app_version: '0.1.0', backup_file_name: backup.fileName, backup_sha256: backup.fileSha256}],
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
  return JSON.parse(factsText);
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
  const base = {runRoot: config.runRoot, paths: [config.evidence], real: facts.real, steamLibraries};
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

async function installed(config) {
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
  return {uninstallInsideRunRoot, facts: factsEvidence(facts, config.runRoot)};
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
  checkRunSignal(process.env);
  // Only the reviewed Setup.exe of the make output or the installed Update.exe inside the run root may run here.
  assert.ok(normalizePath(executable) === normalizePath(config.setup) || normalizePath(executable) === normalizePath(path.join(layout.binaryRoot, 'Update.exe')),
    'STEP_EXECUTABLE_UNEXPECTED');
  checkLaunchEnvironment(process.env, {runRoot: config.runRoot, real: machineFacts().real});
  const started = performance.now(), budget = config.stepBudgetMs ?? 50000;
  const child = spawn(executable, args, {cwd: layout.cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
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
    await dashboard.getByText('Telemetry service ready; isolated storage probe verified', {exact: true}).waitFor({state: 'visible', timeout: 15000});
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
  assert.deepEqual(record.events.opened, [{schemaVersion: 2, created: false, migratedFrom: migratedFrom === 'none' ? null : Number(migratedFrom)}], 'HISTORY_OPEN_UNEXPECTED');
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
      case 'installed': result.result = await installed(config); break;
      case 'seed': result.result = await seed(config); break;
      case 'snapshot': result.result = await snapshot(config); break;
      case 'compare': result.result = await compare(config, rest[1], rest[2]); break;
      case 'step': result.result = await step(config, label, rest[2], rest.slice(3)); break;
      case 'launch': result.result = await launch(config, label, rest[2], rest[3]); break;
      case 'verify': result.result = await verify(config, label, rest[2]); break;
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
  const name = command === 'seed' || command === 'cleanup' ? `${command}.json` : command === 'compare' ? `compare-${rest[1]}-${rest[2]}.json` : `${command}-${rest[1]}.json`;
  try {await writeEvidence(config, name, result);} catch (error) {result.evidenceFailure = failure(error);}
}
// One JSON line for the harness; `cleanup` also reports whether the uninstall key may be deleted.
process.stdout.write(`${JSON.stringify({command, passed: result.passed, failure: result.failure ?? null,
  ...(command === 'cleanup' ? {ownsRegistration: Array.isArray(result.result?.ownsRegistration) ? result.result.ownsRegistration : []} : {})})}\n`);
process.exitCode = result.passed ? 0 : 1;
