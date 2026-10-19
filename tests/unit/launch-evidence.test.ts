import {expect, it} from 'vitest';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// ET-019 PR-11: the runtime smoke's cold-launch phases and per-process memory. The helpers are CI JavaScript outside the
// application TypeScript project; the receipt rules that check their output are in tests/unit/runtime-receipt.test.ts.
type Row = {event: string; time: string};
type Observation = {processCreatedMs?: number | null; paint?: Record<string, number>; observationMs?: number; error?: string} | null;
const {coldLaunchPhases, summarizeProcessMemory} = await import(pathToFileURL(path.resolve('scripts/ci/launch-evidence.mjs')).href) as {
  coldLaunchPhases(input: {observation: Observation; driverPhases?: {phase: string; utc: string}[]; mainEvents?: Row[]; serviceEvents?: Row[]}): Record<string, unknown>;
  summarizeProcessMemory(metrics: {type: string; name?: string | null; serviceName?: string | null; peakWorkingSetKiB: number | null}[]): Record<string, unknown>;
};
const origin = Date.parse('2026-10-19T02:14:29.663Z');
const utc = (offsetMs: number) => new Date(origin + offsetMs).toISOString();
const row = (event: string, offsetMs: number): Row => ({event, time: utc(offsetMs)});
const driverPhases = [{phase: 'launch-requested', utc: utc(-27)}, {phase: 'launch-returned', utc: utc(120)}, {phase: 'dashboard-ready-visible', utc: utc(447)}];
const mainEvents = [row('PLUGIN_SETUP_MODE', 49), row('APP_START', 50), row('SERVICE_START_REQUESTED', 100), row('SERVICE_READY', 198),
  row('DASHBOARD_WINDOW_CREATED', 252), row('DASHBOARD_LOAD_FINISHED', 350),
  // A restarted service's second readiness is not the cold launch.
  row('SERVICE_READY', 5000)];
const serviceEvents = [row('SERVICE_BOOT', 150), row('STORAGE_VERIFIED', 198), row('HISTORY_STORAGE_OPENED', 202), row('STORAGE_VERIFIED', 5100)];
const paint = {'first-paint': origin + 396.6, 'first-contentful-paint': origin + 520.7};

it('measures each cold-launch phase from the main process creation, first occurrence each', () => {
  expect(coldLaunchPhases({observation: {processCreatedMs: origin, paint, observationMs: 4}, driverPhases, mainEvents, serviceEvents})).toEqual({
    origin: 'main-process-created', originUtc: '2026-10-19T02:14:29.663Z', launchRequestedToOriginMs: 27,
    phasesMs: {mainStarted: 50, mainReady: 100, serviceReady: 198, storageProbeVerified: 198, historyStorageOpened: 202, firstWindowShown: 252,
      dashboardLoaded: 350, rendererFirstPaint: 397, rendererFirstContentfulPaint: 521, dashboardReadyVisible: 447},
    unavailable: {}, observationMs: 4});
});
it('names every phase it could not observe instead of inventing a time', () => {
  // The refusal scenario opens no history database; a dashboard that never painted has no paint entries.
  const refused = coldLaunchPhases({observation: {processCreatedMs: origin, paint: {}}, driverPhases, mainEvents,
    serviceEvents: serviceEvents.filter(entry => entry.event !== 'HISTORY_STORAGE_OPENED')});
  expect(refused).toMatchObject({phasesMs: {historyStorageOpened: null, rendererFirstPaint: null, rendererFirstContentfulPaint: null, serviceReady: 198},
    unavailable: {historyStorageOpened: 'HISTORY_STORAGE_OPENED_NOT_LOGGED', rendererFirstPaint: 'FIRST_PAINT_NOT_RECORDED',
      rendererFirstContentfulPaint: 'FIRST_CONTENTFUL_PAINT_NOT_RECORDED'}});
  // A failed observation in the application leaves the paint phases unavailable for that reason; the log rows still count.
  const failed = coldLaunchPhases({observation: {error: 'OBSERVATION_FAILED'}, driverPhases, mainEvents, serviceEvents});
  expect(failed).toMatchObject({origin: 'launch-requested', originUtc: utc(-27), launchRequestedToOriginMs: 0,
    phasesMs: {mainStarted: 77, serviceReady: 225, rendererFirstPaint: null, dashboardReadyVisible: 474},
    unavailable: {rendererFirstPaint: 'OBSERVATION_FAILED', rendererFirstContentfulPaint: 'OBSERVATION_FAILED'}});
  // A main log without its timeline rows.
  expect(coldLaunchPhases({observation: {processCreatedMs: origin, paint}, driverPhases, mainEvents: mainEvents.slice(0, 4), serviceEvents}))
    .toMatchObject({phasesMs: {firstWindowShown: null, dashboardLoaded: null},
      unavailable: {firstWindowShown: 'DASHBOARD_WINDOW_CREATED_NOT_LOGGED', dashboardLoaded: 'DASHBOARD_LOAD_FINISHED_NOT_LOGGED'}});
});
it('reports no phase without an origin', () => {
  const none = coldLaunchPhases({observation: null, driverPhases: [], mainEvents, serviceEvents});
  expect(none).toMatchObject({origin: 'unavailable', originUtc: null, launchRequestedToOriginMs: null, observationMs: null});
  expect(Object.values(none.phasesMs as Record<string, unknown>).every(value => value === null)).toBe(true);
  expect(new Set(Object.values(none.unavailable as Record<string, unknown>))).toEqual(new Set(['ORIGIN_UNAVAILABLE']));
});
it('groups Electron process metrics by kind with the largest peak working set in bytes', () => {
  expect(summarizeProcessMemory([
    {type: 'Browser', peakWorkingSetKiB: 116636},
    {type: 'Tab', peakWorkingSetKiB: 119744}, {type: 'Tab', peakWorkingSetKiB: 90000},
    {type: 'Utility', name: 'ETS2Telemetry telemetry service', peakWorkingSetKiB: 81452},
    {type: 'Utility', name: 'Network Service', serviceName: 'network.mojom.NetworkService', peakWorkingSetKiB: 47156},
    {type: 'GPU', peakWorkingSetKiB: 111972},
    {type: 'Unknown', peakWorkingSetKiB: null}
  ])).toEqual({kinds: {main: {processes: 1, peakWorkingSetBytes: 119435264}, renderer: {processes: 2, peakWorkingSetBytes: 122617856},
    telemetryService: {processes: 1, peakWorkingSetBytes: 83406848}, otherUtility: {processes: 1, peakWorkingSetBytes: 48287744},
    gpu: {processes: 1, peakWorkingSetBytes: 114659328}, other: {processes: 1, peakWorkingSetBytes: 0}},
  unavailable: {storageWorker: 'WORKER_THREAD_OF_TELEMETRY_SERVICE'}});
  // Electron may report the utility process's service name instead of its display name.
  expect(summarizeProcessMemory([{type: 'Utility', name: null, serviceName: 'ETS2Telemetry telemetry service', peakWorkingSetKiB: 1}]))
    .toMatchObject({kinds: {telemetryService: {processes: 1, peakWorkingSetBytes: 1024}}});
});
