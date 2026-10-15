import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {waitForCurrentTelemetry} from './renderer-observation.mjs';
import {waitForOverlay} from './overlay-observation.mjs';

// ET-011b settings evidence. Run A starts with a deliberately truncated settings file, which must stay byte-identical
// until the first save quarantines it; run B must load the saved file without writing.
const SETTINGS_SEED = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric",';
// ET-012a: every save writes settings format v2 with the overlay block (strip layout and every section by default).
const SETTINGS_SAVED = ['{', '  "format": "ets2telemetry.settings",', '  "version": 2,', '  "units": {', '    "ets2": "us-customary",', '    "ats": "us-customary"', '  },',
  '  "overlay": {', '    "layout": "strip",', '    "sections": {', '      "speed": true,', '      "gear": true,', '      "rpm": true,', '      "fuel": true,',
  '      "range": true,', '      "sdk-consumption": true,', '      "cargo": true,', '      "origin": true,', '      "destination": true,', '      "distance-driven": true,',
  '      "distance-remaining": true,', '      "deadline": true,', '      "expected-income": true,', '      "game-time": true', '    }', '  }', '}', ''].join('\n');
const DEFAULT_OVERLAY = {layout: 'strip', sections: {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true,
  'origin': true, 'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true}};
const QUARANTINE_NAME = /^settings\.rejected-\d{8}T\d{6}Z\.json$/;
// 25 m/s and 73 L in the us-customary profile.
const US_DASHBOARD = {speed: 'Speed: 55.9 mph', fuel: 'Fuel: 19.3 US gal'};
const settingsDirectory = config => path.join(config.localappdata, 'ETS2Telemetry', 'settings');

/** Seeds the isolated LOCALAPPDATA before run A launches. */
export async function seedLifecycleSettings(config) {
  await mkdir(settingsDirectory(config), {recursive: true});
  await writeFile(path.join(settingsDirectory(config), 'settings.json'), SETTINGS_SEED);
}
async function settingsFiles(config) {
  const directory = settingsDirectory(config), names = (await readdir(directory)).sort();
  return Promise.all(names.map(async name => ({name, content: await readFile(path.join(directory, name), 'utf8')})));
}

// Self-contained browser callback: the dashboard's current speed and fuel rows in the expected units.
function dashboardReadings(expected) {
  const read = id => {
    const nodes = globalThis.document.querySelectorAll(`[data-testid="${id}"]`);
    return nodes.length === 1 ? nodes[0].innerText : undefined;
  };
  const observation = {status: read('telemetry-status'), speed: read('speed'), fuel: read('fuel')};
  return /^connected:/.test(observation.status ?? '') && observation.speed === expected.speed && observation.fuel === expected.fuel ? observation : false;
}
async function waitForDashboardUnits(page, expected) {
  const handle = await page.waitForFunction(dashboardReadings, expected, {timeout: 10000, polling: 50});
  try {return await handle.jsonValue();} finally {await handle.dispose();}
}

// ET-011a tray lifecycle journey against the isolated synthetic source. The tray icon itself cannot be
// clicked here: the gated diagnostic tray action calls the same main handlers as the tray menu.
const READY_TEXT = 'Telemetry service ready; isolated storage probe verified';
const dashboardUrl = url => {
  if (!url.startsWith('file:')) return false;
  const parsed = new URL(url);
  return /\/renderer\/index\.html$/.test(parsed.pathname) && parsed.search === '';
};

// Read-only main-process facts, published only under the isolated live-smoke configuration.
export async function lifecycleState(application) {
  const state = await application.evaluate(({app}) => {
    let value = null;
    app.emit('ets2telemetry:diagnostic-lifecycle-state', facts => {value = facts;});
    return value;
  });
  assert.ok(state, 'Diagnostic lifecycle state unavailable');
  return state;
}

async function until(read, accept, message, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (performance.now() >= deadline) throw new Error(`${message} within ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

// Exactly one open dashboard page that is not one of the retired pages.
export async function newDashboardPage(application, retired) {
  return until(async () => application.windows().filter(page => !page.isClosed() && !retired.includes(page) && dashboardUrl(page.url())),
    pages => pages.length === 1, 'EXPECTED_ONE_NEW_DASHBOARD').then(pages => pages[0]);
}

async function readyDashboard(page) {
  await page.getByText(READY_TEXT, {exact: true}).waitFor({state: 'visible', timeout: 10000});
  return waitForCurrentTelemetry(page);
}

async function closeDashboard(application, page) {
  const closed = page.isClosed() ? Promise.resolve() : page.waitForEvent('close', {timeout: 5000});
  const requested = await application.evaluate(({BrowserWindow}) => {
    const targets = BrowserWindow.getAllWindows().filter(window => {
      const url = window.webContents.mainFrame.url;
      return url.startsWith('file:') && /\/renderer\/index\.html$/.test(new URL(url).pathname) && new URL(url).search === '';
    });
    if (targets.length !== 1) return targets.length;
    targets[0].close();
    return true;
  });
  assert.equal(requested, true, 'Expected exactly one dashboard window to close');
  await closed;
  return until(() => lifecycleState(application), state => state.dashboard === false, 'DASHBOARD_NOT_RETIRED', 5000);
}

function waitForExit(child, timeoutMs, message) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    child.once('exit', (code, signal) => {clearTimeout(timer); resolve({code, signal});});
  });
}

/**
 * Run A of the lifecycle scenario. The caller relaunches (run B) after this returns.
 * `record` receives every observation, including partial evidence when an assertion fails.
 */
export async function runLifecycleSmoke({application, launcher, dashboard, overlay, source, config, environment, events, stopTracing, record}) {
  Object.assign(record, {scope: 'isolated synthetic source; tray via gated diagnostic action; OS tray icon, menu and foreground unverified'});
  const mainEvents = () => events(config.diagnostics);
  const serviceExits = async () => (await mainEvents()).filter(row => row.event === 'SERVICE_EXIT').length;
  record.initial = await readyDashboard(dashboard);
  const initial = await lifecycleState(application);
  record.initialState = initial;
  assert.equal(initial.started, true); assert.equal(initial.tray, true); assert.equal(initial.overlay, true);
  assert.ok(Number.isSafeInteger(initial.servicePid) && initial.servicePid > 0, 'Service PID unavailable');
  record.servicePid = initial.servicePid;
  // 0. The seeded invalid settings file yields defaults and is neither changed nor joined by any file on startup.
  // A CPU-starved start (hosted run 38755116140) may open the windows while the read is still pending (`loading`,
  // read-only defaults); main applies the same read when it settles, so wait for that before the exact checks.
  record.settingsInitialPending = initial.settings.state === 'loading';
  const settled = await until(() => lifecycleState(application), state => state.settings.state !== 'loading', 'SETTINGS_READ_STILL_PENDING');
  const stateText = await until(() => dashboard.getByTestId('settings-state').innerText(),
    text => !text.startsWith('Saved settings are still being read'), 'DASHBOARD_SETTINGS_STILL_PENDING');
  record.settingsInitial = {view: settled.settings, files: await settingsFiles(config), stateText};
  assert.deepEqual(settled.settings, {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: null});
  record.settingsSeededInvalidFile = true;
  assert.deepEqual(record.settingsInitial.files, [{name: 'settings.json', content: SETTINGS_SEED}]);
  assert.match(record.settingsInitial.stateText, /^The settings file is invalid; defaults are in use\./);
  record.settingsStartupUnchanged = true;
  const retired = [dashboard];

  // 1. Closing the main window keeps the application, service, source connection, overlay and tray.
  const afterClose = await closeDashboard(application, dashboard);
  record.afterClose = afterClose;
  assert.equal(launcher.exitCode, null, 'Application exited after closing the dashboard');
  assert.equal(afterClose.servicePid, initial.servicePid); assert.equal(await serviceExits(), 0);
  record.dashboardClosedServiceAlive = true;
  assert.equal(afterClose.overlay, true); assert.equal(afterClose.upstream, true); assert.equal(afterClose.exiting, false);
  record.overlayAliveAfterClose = true;
  assert.equal(afterClose.tray, true); record.trayPresentAfterClose = true;
  const expected = {source: 'ETS2', origin: 'synthetic', statuses: ['connected'], freshness: 'current', speedUnit: 'km/h', fuelUnit: 'L'};
  source.setReading(20, 71);
  record.overlayChanged = await waitForOverlay(overlay, {...expected, speed: '72.0', fuel: '71.0'});
  source.setReading(25, 73);
  record.overlayRestored = await waitForOverlay(overlay, {...expected, speed: '90.0', fuel: '73.0'});
  record.overlayCurrentAfterClose = true;
  assert.equal(source.statistics().connections, 1); record.sourceConnectionPreserved = true;

  // 2. A second launch with the same profile exits 0 without logging and reopens the running dashboard.
  const executable = config.mode === 'packaged' ? config.executable : await application.evaluate(() => process.execPath);
  const started = performance.now();
  const second = spawn(executable, config.mode === 'packaged' ? [] : [config.checkout], {cwd: config.cwd, env: environment, stdio: 'ignore', windowsHide: true});
  const secondExit = await waitForExit(second, 10000, 'SECOND_INSTANCE_DID_NOT_EXIT_WITHIN_10_SECONDS');
  record.secondInstance = {pid: second.pid ?? null, exitCode: secondExit.code, signal: secondExit.signal, exitMilliseconds: Math.round(performance.now() - started)};
  assert.equal(secondExit.code, 0); assert.equal(secondExit.signal, null);
  const reopened = await until(mainEvents, rows => rows.some(row => row.event === 'SECOND_INSTANCE'), 'PRIMARY_DID_NOT_RECORD_SECOND_INSTANCE');
  record.secondInstance.wroteLog = reopened.some(row => row.pid === second.pid);
  record.secondInstance.primaryActions = reopened.filter(row => row.event === 'SECOND_INSTANCE').map(row => row.facts?.action ?? null);
  assert.equal(record.secondInstance.wroteLog, false); assert.deepEqual(record.secondInstance.primaryActions, ['created']);
  const secondDashboard = await newDashboardPage(application, retired);
  record.afterSecondInstance = await readyDashboard(secondDashboard);
  assert.equal((await lifecycleState(application)).servicePid, initial.servicePid);
  record.secondInstanceRestoredDashboard = true;
  retired.push(secondDashboard);

  // 3. Close again; the tray's Open action creates a fresh dashboard with current data.
  await closeDashboard(application, secondDashboard);
  assert.equal(await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-tray-action', 'open')), true, 'Diagnostic tray action unavailable');
  const trayDashboard = await newDashboardPage(application, retired);
  record.afterTrayOpen = await readyDashboard(trayDashboard);
  const beforeExit = await lifecycleState(application);
  assert.equal(beforeExit.servicePid, initial.servicePid); assert.equal(beforeExit.dashboard, true); assert.equal(await serviceExits(), 0);
  assert.equal(source.statistics().connections, 1);
  record.trayOpenRestoredDashboard = true;

  // 3b. Saving ETS2's US customary profile quarantines the seeded file unchanged, writes the exact v1 content and
  // switches both the dashboard and the overlay to mph and US gallons.
  record.settingsSaveView = await trayDashboard.evaluate(() => globalThis.desktop.setUnitProfile('ets2', 'us-customary'));
  assert.deepEqual(record.settingsSaveView, {units: {ets2: 'us-customary', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  const saved = await settingsFiles(config);
  record.settingsAfterSave = saved.map(({name}) => name);
  const quarantined = saved.filter(file => QUARANTINE_NAME.test(file.name));
  record.settingsQuarantined = quarantined.length;
  assert.equal(quarantined.length, 1); assert.equal(quarantined[0].content, SETTINGS_SEED);
  record.settingsQuarantinePreserved = true;
  assert.deepEqual(saved.filter(file => !QUARANTINE_NAME.test(file.name)), [{name: 'settings.json', content: SETTINGS_SAVED}]);
  record.settingsSavedExact = true;
  record.dashboardUnits = await waitForDashboardUnits(trayDashboard, US_DASHBOARD);
  record.overlayUnits = await waitForOverlay(overlay, {...expected, speed: '55.9', fuel: '19.3', speedUnit: 'mph', fuelUnit: 'US gal'});
  assert.equal((await lifecycleState(application)).settings.units.ets2, 'us-customary');
  record.unitsApplied = true;

  // 4. Explicit exit from the renderer: one orderly sequence, normal service stop, exit 0.
  await trayDashboard.screenshot({path: path.join(config.output, 'ready.png')});
  await stopTracing();
  const exitStarted = performance.now();
  const exited = waitForExit(launcher, 8000, 'EXPLICIT_EXIT_DID_NOT_FINISH_WITHIN_8_SECONDS');
  // The renderer may be torn down before its evaluation returns; only the process exit is the outcome.
  await trayDashboard.evaluate(() => {void globalThis.desktop.exitApplication(); return true;}).catch(() => undefined);
  const exit = await exited;
  record.explicitExit = {launcherExit: exit.code, signal: exit.signal, exitMilliseconds: Math.round(performance.now() - exitStarted)};
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  const finalEvents = await mainEvents();
  record.explicitExit.requests = finalEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason ?? null);
  assert.deepEqual(record.explicitExit.requests, ['renderer']);
  record.explicitExitOrderly = true;
}

/** Run B: the same profile and LOCALAPPDATA start again after the orderly exit. */
export async function verifyLifecycleRestart({application, record, rendererPages, config}) {
  const {dashboard} = await rendererPages(application);
  await dashboard.getByText(READY_TEXT, {exact: true}).waitFor({state: 'visible', timeout: 10000});
  // The saved ETS2 profile applies from the first current reading.
  record.restart = {ready: await waitForDashboardUnits(dashboard, US_DASHBOARD)};
  record.restart.dashboardUnits = {speed: record.restart.ready.speed, fuel: record.restart.ready.fuel};
  const state = await lifecycleState(application);
  assert.equal(state.started, true); assert.equal(state.tray, true);
  record.restart.servicePid = state.servicePid;
  assert.notEqual(state.servicePid, record.servicePid);
  record.restartRecovered = true;
  record.restart.settingsState = state.settings.state;
  assert.deepEqual(state.settings, {units: {ets2: 'us-customary', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  // Loading wrote nothing: the saved file and the single quarantined file are unchanged.
  const files = await settingsFiles(config);
  assert.deepEqual(files.map(file => file.name), record.settingsAfterSave);
  assert.equal(files.find(file => file.name === 'settings.json').content, SETTINGS_SAVED);
  assert.equal(files.find(file => QUARANTINE_NAME.test(file.name)).content, SETTINGS_SEED);
  record.settingsRestartLoaded = true;
}
