import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {waitForCurrentTelemetry} from './renderer-observation.mjs';
import {waitForOverlay} from './overlay-observation.mjs';

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
export async function verifyLifecycleRestart({application, record, rendererPages}) {
  const {dashboard} = await rendererPages(application);
  record.restart = {ready: await readyDashboard(dashboard)};
  const state = await lifecycleState(application);
  assert.equal(state.started, true); assert.equal(state.tray, true);
  record.restart.servicePid = state.servicePid;
  assert.notEqual(state.servicePid, record.servicePid);
  record.restartRecovered = true;
}
