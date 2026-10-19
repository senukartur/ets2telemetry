import {performance} from 'node:perf_hooks';

// ET-019 PR-11: cold-launch phases and per-process memory for the runtime smoke receipt. Observation only: nothing here
// waits on the product, retries or fails the journey, and no product code is involved. The receipt validator
// (RuntimeReceipt.ps1, Test-ResourceEvidence) checks only the shape: present, non-negative values in plausible units.

/** Every phase of `coldLaunch.phasesMs`, in milliseconds after the main process was created. */
export const COLD_LAUNCH_PHASES = ['mainStarted', 'mainReady', 'serviceReady', 'storageProbeVerified', 'historyStorageOpened', 'firstWindowShown',
  'dashboardLoaded', 'rendererFirstPaint', 'rendererFirstContentfulPaint', 'dashboardReadyVisible'];
// The phases read from rows the first main and service processes already log, first occurrence each:
// - APP_START is written when main's module runs;
// - SERVICE_START_REQUESTED is the first row of the app's whenReady handler (after the tray and the plugin setup start). Under
//   Playwright, Electron's ready event waits until Playwright has attached, so this includes the harness's attach time;
// - SERVICE_READY is main's record of the service's ready message;
// - DASHBOARD_WINDOW_CREATED: the dashboard window is created visible (`show` is not false), so this is the first window shown;
// - DASHBOARD_LOAD_FINISHED is the dashboard document's load event (the smokes' opt-in timeline);
// - STORAGE_VERIFIED is the service's isolated storage probe; HISTORY_STORAGE_OPENED its history (or recording) database.
const MAIN_ROWS = {mainStarted: 'APP_START', mainReady: 'SERVICE_START_REQUESTED', serviceReady: 'SERVICE_READY',
  firstWindowShown: 'DASHBOARD_WINDOW_CREATED', dashboardLoaded: 'DASHBOARD_LOAD_FINISHED'};
const SERVICE_ROWS = {storageProbeVerified: 'STORAGE_VERIFIED', historyStorageOpened: 'HISTORY_STORAGE_OPENED'};
const TELEMETRY_SERVICE_NAME = 'ETS2Telemetry telemetry service';
const PAINT_WAIT_MS = 2000;

/**
 * Read right after the dashboard first shows readiness: the main process's creation time (Electron's
 * `process.getCreationTime()`) and the dashboard document's paint timing entries as wall-clock milliseconds. A paint that
 * has not happened yet is awaited for at most 2 s through a buffered PerformanceObserver.
 */
export async function observeColdLaunch(application, dashboard) {
  const started = performance.now();
  const processCreatedMs = await application.evaluate(() => process.getCreationTime());
  const paint = await dashboard.evaluate(waitMs => new Promise(resolve => {
    const read = () => Object.fromEntries(globalThis.performance.getEntriesByType('paint')
      .map(entry => [entry.name, globalThis.performance.timeOrigin + entry.startTime]));
    if (read()['first-contentful-paint'] !== undefined) {resolve(read()); return;}
    let timer;
    const observer = new globalThis.PerformanceObserver(() => {
      if (read()['first-contentful-paint'] === undefined) return;
      clearTimeout(timer); observer.disconnect(); resolve(read());
    });
    observer.observe({type: 'paint', buffered: true});
    timer = setTimeout(() => {observer.disconnect(); resolve(read());}, waitMs);
  }), PAINT_WAIT_MS);
  return {processCreatedMs, paint, observationMs: Math.round(performance.now() - started)};
}

const first = (rows, event) => rows.find(row => row?.event === event);
const at = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The receipt's `coldLaunch`: each phase in whole milliseconds after the origin, or null with a fixed reason in
 * `unavailable`. The origin is the main process's creation time; without it, the driver's launch request.
 * `launchRequestedToOriginMs` is the time from the driver's launch request to that origin, as measured (the request's Date is
 * coarse to the timer tick, so it can be slightly negative); `observationMs` is the time the
 * observation itself took in the driver (its cost to the smoke), or null.
 */
export function coldLaunchPhases({observation, driverPhases = [], mainEvents = [], serviceEvents = []}) {
  const launchRequested = at(driverPhases.find(row => row.phase === 'launch-requested')?.utc);
  const created = Number.isFinite(observation?.processCreatedMs) ? observation.processCreatedMs : null;
  const origin = created ?? launchRequested;
  const phasesMs = {}, unavailable = {};
  const set = (name, time, reason) => {
    if (origin === null || time === null) {phasesMs[name] = null; unavailable[name] = origin === null ? 'ORIGIN_UNAVAILABLE' : reason; return;}
    phasesMs[name] = Math.round(time - origin);
  };
  for (const [name, event] of Object.entries(MAIN_ROWS)) set(name, at(first(mainEvents, event)?.time), `${event}_NOT_LOGGED`);
  for (const [name, event] of Object.entries(SERVICE_ROWS)) set(name, at(first(serviceEvents, event)?.time), `${event}_NOT_LOGGED`);
  const paint = observation?.paint ?? {}, failed = observation?.error === 'OBSERVATION_FAILED';
  set('rendererFirstPaint', Number.isFinite(paint['first-paint']) ? paint['first-paint'] : null, failed ? 'OBSERVATION_FAILED' : 'FIRST_PAINT_NOT_RECORDED');
  set('rendererFirstContentfulPaint', Number.isFinite(paint['first-contentful-paint']) ? paint['first-contentful-paint'] : null,
    failed ? 'OBSERVATION_FAILED' : 'FIRST_CONTENTFUL_PAINT_NOT_RECORDED');
  set('dashboardReadyVisible', at(driverPhases.find(row => row.phase === 'dashboard-ready-visible')?.utc), 'DASHBOARD_READY_NOT_OBSERVED');
  return {origin: created !== null ? 'main-process-created' : launchRequested !== null ? 'launch-requested' : 'unavailable',
    originUtc: origin === null ? null : new Date(origin).toISOString(),
    launchRequestedToOriginMs: origin === null || launchRequested === null ? null : Math.round(origin - launchRequested),
    phasesMs: Object.fromEntries(COLD_LAUNCH_PHASES.map(name => [name, phasesMs[name]])), unavailable,
    observationMs: Number.isFinite(observation?.observationMs) ? observation.observationMs : null};
}

/** Electron's own process metrics of the running application, read once (working sets are KiB there), and the read's duration. */
export async function observeProcessMemory(application) {
  const started = performance.now();
  const metrics = await application.evaluate(({app}) => app.getAppMetrics().map(metric => ({type: metric.type,
    name: metric.name ?? null, serviceName: metric.serviceName ?? null, peakWorkingSetKiB: metric.memory?.peakWorkingSetSize ?? null})));
  return {...summarizeProcessMemory(metrics), observationMs: Math.round(performance.now() - started)};
}

/**
 * Per process kind: the number of processes and the largest peak working set in bytes since each started. The storage
 * worker is a worker thread of the telemetry service, so its memory is inside `telemetryService` and is not separable.
 */
export function summarizeProcessMemory(metrics) {
  const kind = metric => metric.type === 'Browser' ? 'main' : metric.type === 'Tab' ? 'renderer' : metric.type === 'GPU' ? 'gpu' :
    metric.type === 'Utility' && (metric.name === TELEMETRY_SERVICE_NAME || metric.serviceName === TELEMETRY_SERVICE_NAME) ? 'telemetryService' :
      metric.type === 'Utility' ? 'otherUtility' : 'other';
  const kinds = {};
  for (const metric of metrics) {
    const entry = kinds[kind(metric)] ??= {processes: 0, peakWorkingSetBytes: 0};
    entry.processes++;
    if (Number.isFinite(metric.peakWorkingSetKiB)) entry.peakWorkingSetBytes = Math.max(entry.peakWorkingSetBytes, Math.round(metric.peakWorkingSetKiB * 1024));
  }
  return {kinds, unavailable: {storageWorker: 'WORKER_THREAD_OF_TELEMETRY_SERVICE'}};
}
