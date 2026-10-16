import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {recordingTextLog, startRecordingTextLog, waitForCurrentTelemetry, waitForRecordingText} from './renderer-observation.mjs';
import {closeDashboard, lifecycleState, newDashboardPage, until, waitForExit} from './lifecycle-observation.mjs';
import {startRecordingProxy} from './recording-proxy.mjs';

// ET-015a PR-4: the recording runtime journey. The service records the synthetic protocol v1 source into
// `<isolated LOCALAPPDATA>\ETS2Telemetry\synthetic\smoke.sqlite` (ETS2TELEMETRY_RECORDING=synthetic:smoke) while the
// reactive simulator serves normal-delivery with a journey transport (JOURNEY_TRANSPORT). A recording proxy between the
// service and the simulator (recording-proxy.mjs) forwards only durable hellos, one admitted connection at a time and
// none held longer than 2 s, and applies the scripted ACK policy: connection 1 delivers four ACKs and loses the fifth,
// so the restarted service receives a redelivery. The journey admits each connection itself, the first only after the
// dashboard shows current data. Every
// ACK it sees is written by the service only after the storage commit (E8), so ACKs are the in-run commit evidence; the
// rows are compared after exit with the hand-written tests/fixtures/recording/normal-delivery-runtime-journey.rows.expected.json.
// ET-015b PR-4: frames on connections 2 and 3 make the restarted service and run B each store one one-second sample,
// which their explicit exits flush (recording-flush) unless the 5 s sample flush already wrote it.
// ET-015c PR-4: the dashboard, the gated lifecycle state and main's opt-in RECORDING_STATUS timeline rows show the
// recording status along the journey (RECORDING_STATUS_* below); after the redelivery, run A's closed dashboard is
// reopened from the tray to show its loss totals and closed again, so the tray exit still runs with the main window
// closed. The dashboard's text logs (MutationObserver) are recorded, and the receipt checks them.

export const RECORDING_TARGET = 'synthetic:smoke';
export const RECORDING_SCENARIO = 'normal-delivery-runtime-journey';
const READY_TEXT = 'Telemetry service ready; isolated storage probe verified';
const PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const durable = Object.freeze({durable: true, commit: 'each', ack: 'each'});
/**
 * normal-delivery's steps are unchanged; its transport becomes three durable connections. The scripted disconnects of
 * connections 2 and 3 end them only when the journey has not ended them first by exiting; either order stores the same
 * rows. They are short so that a run that keeps a connection open does not wait out a long scripted tail.
 */
export const JOURNEY_TRANSPORT = Object.freeze([
  {atMs: 0, action: 'connect', client: {durable: true, commit: 'each', ack: 'dropAfter:4'}},
  {atMs: 350, action: 'disconnect'},
  {atMs: 360, action: 'connect', client: durable},
  {atMs: 2000, action: 'disconnect'},
  {atMs: 2010, action: 'connect', client: durable},
  {atMs: 4000, action: 'disconnect'}
]);
/**
 * ET-015b PR-4: the steps appended to normal-delivery. The source second of a snapshot is 1000 + floor(atMs / 1000), and
 * each connection's checkpoint is the baseline of a new recorder (H4). Connection 2 (the restarted service): second 1001
 * is sampled at 1,100 ms; 1,600 ms is the same second; the pause (eventSeq 10) is the tray exit's gate. Connection 3
 * (run B): after the resume (11), second 1002 is sampled at 2,100 ms; the frame at 3,100 ms is paused (12), so second
 * 1003 has no row; the resume (13) is run B's gate. Each gate is a connection's last step before its scripted
 * disconnect, so an exit right after its ACK cannot change what the simulator serves (matchesReplay), and that ACK, sent
 * after the commit, follows the observation of every earlier reading in the FIFO.
 */
const JOURNEY_STEPS = Object.freeze([
  {atMs: 1100, action: 'frame', channels: {speed: 0}},
  {atMs: 1600, action: 'frame', channels: {speed: 2.5}},
  {atMs: 1700, action: 'lifecycle', event: 'simulation.paused'},
  {atMs: 2050, action: 'lifecycle', event: 'simulation.started'},
  {atMs: 2100, action: 'frame', channels: {speed: 12.25, odometer: 1000.53125}},
  {atMs: 2900, action: 'lifecycle', event: 'simulation.paused'},
  {atMs: 3100, action: 'frame'},
  {atMs: 3200, action: 'lifecycle', event: 'simulation.started'}
]);
/** ACKs the proxy delivers per connection, as JOURNEY_TRANSPORT scripts them; later ones are lost on the way. */
const DELIVERED_ACKS = [4, Infinity, Infinity];
/** The last eventSeq of connections 2 and 3: the gates before the tray exit and before run B's exit. */
const TRAY_EXIT_GATE = '10', RUN_B_GATE = '13';
/**
 * H8: a pending sample is written by the 5 s flush at the earliest SAMPLE_FLUSH_MS after it was sampled. A service whose
 * recording-flush step was logged less than this long after its first connection (both from its own clock) sampled its
 * row later than that connection and stopped before the timer could fire, so its exit flush must have written the row.
 * The 500 ms below SAMPLE_FLUSH_MS absorb timer and clock granularity.
 */
const EXIT_FLUSH_CERTAIN_MS = 4500;

/** A wire uint64 or a stored 20-digit key in canonical decimal form. */
const key = value => value === null || value === undefined ? null : String(value).replace(/^0+(?=.)/, '');
const uuidOf = hex => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
/** The simulator's seeded identifiers (tools/telemetry-simulator/src/v1/source.ts `seededId`). */
const seededId = (seed, label) => uuidOf(createHash('sha256').update(`simulator-v1:${seed}:${label}`).digest('hex'));
/** T4: a trip UUID is derived from its plugin session and its job configuration eventSeq; labelled `trip@<eventSeq>`. */
const tripLabels = session => new Map(Array.from({length: 20}, (_, index) =>
  [uuidOf(createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${index + 1}`, 'utf8').digest('hex')), `trip@${index + 1}`]));

// ET-015c PR-4: the recording status along the journey, written by hand. Totals count since ETS2Telemetry started.
const NO_LOSSES = Object.freeze({lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0});
const SYNTHETIC_NOTE = 'Synthetic test database (never game history)';
const TEST_NOTICE = 'Prototype live display. Only a test database is recorded, never game history.';
/** A service whose connection has not recorded yet: before each admission, and after the service restart. */
const RECORDING_STATUS_WAITING = Object.freeze({state: 'waiting', target: 'synthetic', code: null, losses: NO_LOSSES, trip: null});
const RECORDING_TEXT_WAITING = Object.freeze({headline: 'Waiting for the recorded source to connect', detail: [SYNTHETIC_NOTE], losses: null, alert: null, notice: TEST_NOTICE});
/** Connection 1 recorded events 1-5 (the trip opened at eventSeq 3 at load, so it is partial) and ended. */
const RECORDING_STATUS_INTERRUPTED = Object.freeze({state: 'interrupted', target: 'synthetic', code: null, losses: NO_LOSSES,
  trip: {phase: 'active', completeness: 'partial', untrackedJob: false}});
const RECORDING_TEXT_INTERRUPTED = Object.freeze({headline: 'Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap',
  detail: [SYNTHETIC_NOTE, 'Current trip is partial'], losses: null, alert: null, notice: TEST_NOTICE});
/**
 * After connection 2: the restarted service committed the trip's consumer-restart interval (one not-connected interval);
 * the redelivered eventSeq 5 is a duplicate, not a loss, so no event is lost.
 */
const RECORDING_LOSSES_AFTER_REDELIVERY = Object.freeze({...NO_LOSSES, notConnected: 1});
const RECORDING_TEXT_LOSSES_AFTER_REDELIVERY = Object.freeze(['Gaps recorded since ETS2Telemetry started', 'Intervals without a connection: 1']);
/** The states in which the durable cursor is active with fresh v1 data: recording, or recording a paused game. */
const RECORDED_STATES = Object.freeze(['recording', 'paused']);
const RECORDED_HEADLINES = Object.freeze(['Recording', 'Game paused; recording continues when it resumes']);
/** Main's RECORDING_STATUS timeline rows as facts. */
const statusRows = rows => rows.filter(row => row.event === 'RECORDING_STATUS').map(row => row.facts);
/** main's current recording status once `accept` holds; a hang guard only. */
async function recordingHealth(application, accept, message) {
  return (await until(() => lifecycleState(application), state => accept(state.health.recording), message)).health.recording;
}
/** The dashboard's distinct recording texts since startRecordingTextLog once one satisfies `accept`; a hang guard only. */
const shownText = (page, accept, message) => until(() => recordingTextLog(page), texts => texts.some(accept), message, 5000);

/**
 * Starts the reactive simulator (`serve-v1`, the built CLI) on the journey scenario and the recording proxy
 * (recording-proxy.mjs) in front of it. The proxy's endpoint is what the service connects to (ETS2TELEMETRY_SOURCE_PIPE_V1).
 * The simulator child gets the run's isolated TEMP, APPDATA and LOCALAPPDATA, like every other process of the run.
 */
export async function startRecordingSource(config) {
  const {checkout, output} = config;
  const base = JSON.parse(await readFile(path.join(checkout, 'tests/fixtures/simulator-v1/normal-delivery.json'), 'utf8'));
  const scenario = {...base, id: RECORDING_SCENARIO,
    purpose: 'Runtime recording journey: normal-delivery through a killed and restarted telemetry service, close-to-tray, a tray exit and an application restart.',
    steps: [...base.steps, ...JOURNEY_STEPS], transport: JOURNEY_TRANSPORT};
  const scenarioFile = path.join(output, 'recording-scenario.json');
  await writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n');
  const simulator = spawn(process.execPath, [path.join(checkout, 'tools/telemetry-simulator/dist/cli.cjs'), 'serve-v1', scenarioFile],
    {cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: {...process.env, TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata}});
  const lines = [], stderr = [];
  let partial = '';
  const exited = new Promise(resolve => simulator.once('exit', (code, signal) => resolve({code, signal})));
  simulator.stderr.on('data', chunk => {if (stderr.join('').length < 8192) stderr.push(String(chunk));});
  const announced = new Promise((resolve, reject) => {
    simulator.stdout.on('data', chunk => {
      const text = partial + String(chunk), parts = text.split(/\r?\n/);
      partial = parts.pop();
      for (const line of parts.filter(Boolean)) {lines.push(line); if (lines.length === 1) resolve(line);}
    });
    void exited.then(() => reject(new Error(`Simulator exited before serving: ${stderr.join('').slice(0, 512)}`)));
  });
  // After a timeout the child is terminated and `announced` rejects later; that rejection is expected and handled here.
  announced.catch(() => undefined);
  let announceTimer, started;
  try {
    started = JSON.parse(await Promise.race([announced,
      new Promise((_, reject) => {announceTimer = setTimeout(() => reject(new Error('SIMULATOR_NOT_SERVING_WITHIN_10_SECONDS')), 10000);})]));
    assert.deepEqual({origin: started.origin, mode: started.mode, history: started.history}, {origin: 'synthetic', mode: 'reactive', history: false});
    assert.match(started.endpoint, PIPE_PATTERN_V1);
  } catch (error) {simulator.kill(); throw error;} finally {clearTimeout(announceTimer);}
  let proxy;
  try {proxy = await startRecordingProxy({upstream: started.endpoint, deliveredAcks: DELIVERED_ACKS});} catch (error) {simulator.kill(); throw error;}
  const statistics = () => proxy.statistics();
  return {
    endpoint: proxy.endpoint, scenario: RECORDING_SCENARIO, seed: scenario.seed, simulatorEndpoint: started.endpoint,
    /** Lets the next durable connection through; nothing is admitted before the first call. */
    admit: () => proxy.admit(),
    statistics,
    /** Polls the proxy's record until `accept` holds; a liveness bound only. */
    waitFor: (accept, message, timeoutMs) => until(async () => statistics(), accept, message, timeoutMs),
    /**
     * Closes the proxy, then waits up to `waitMs` for the simulator to finish its script and report. A simulator that does
     * not end in time is terminated and the run has no report. A failed run passes a short bound, so the driver still
     * writes its result inside the Job's 60 s.
     */
    stop: async ({waitMs = 10000} = {}) => {
      await proxy.stop();
      let timer;
      const outcome = await Promise.race([exited, new Promise(resolve => {timer = setTimeout(() => resolve(null), waitMs);})]);
      clearTimeout(timer);
      if (!outcome) {simulator.kill(); return {exit: null, report: null, stderr: stderr.join('').slice(0, 2048)};}
      if (partial) {lines.push(partial); partial = '';}
      const last = lines.length > 1 ? JSON.parse(lines.at(-1)) : null;
      return {exit: outcome, report: last, stderr: stderr.join('').slice(0, 2048)};
    }
  };
}

/** The read-only lifecycle facts with a new service PID once main reports the restarted service ready. */
async function restartedService(application, previousPid) {
  return until(() => lifecycleState(application), state => state.serviceReady && Number.isSafeInteger(state.servicePid) && state.servicePid !== previousPid,
    'SERVICE_NOT_RESTARTED', 15000);
}
/** A V1_SOURCE_STATUS row of this service process that reports durable delivery `active` for the synthetic selection. */
async function durableActiveRow(events, directory, pid) {
  const rows = await until(() => events(path.join(directory, 'service')),
    list => list.some(row => row.pid === pid && row.event === 'V1_SOURCE_STATUS' && row.facts?.durable === 'active' && row.facts?.selection === 'synthetic'),
    'DURABLE_ACTIVE_NOT_LOGGED', 10000);
  return rows.find(row => row.pid === pid && row.event === 'V1_SOURCE_STATUS' && row.facts?.durable === 'active').facts;
}

/**
 * Run A of the recording scenario; the caller relaunches (run B) after this returns. `record` receives every
 * observation, including partial evidence when an assertion fails.
 */
export async function runRecordingSmoke({application, launcher, dashboard, recording, config, events, stopTracing, record}) {
  Object.assign(record, {scope: 'isolated synthetic v1 source through a recording proxy into a synthetic-purpose database; tray via gated diagnostic action; no game, history or OS tray icon'});
  const mainEvents = () => events(config.diagnostics);
  record.initial = await waitForCurrentTelemetry(dashboard);
  const initial = await lifecycleState(application);
  assert.equal(initial.started, true); assert.equal(initial.tray, true); assert.equal(initial.serviceReady, true);
  assert.ok(Number.isSafeInteger(initial.servicePid) && initial.servicePid > 0, 'Service PID unavailable');
  record.servicePid = initial.servicePid;
  // ET-015c PR-4: before any connection the service waits for its recorded source, writing to the synthetic database.
  record.status = {beforeAdmission: {dashboard: await waitForRecordingText(dashboard, RECORDING_TEXT_WAITING, 'RECORDING_NOT_WAITING_BEFORE_ADMISSION'),
    health: await recordingHealth(application, status => status.state === 'waiting', 'RECORDING_NOT_WAITING_BEFORE_ADMISSION')}};
  assert.deepEqual(record.status.beforeAdmission.health, RECORDING_STATUS_WAITING);
  record.statusWaitingShown = true;
  await startRecordingTextLog(dashboard);
  // Connection 1 is admitted only now, with both windows up and current data shown, so the simulator's 1 s ACK waits
  // (quiesce) do not overlap the application's own startup.
  recording.admit();

  // 1. Commits become active: connection 1 commits events 1-5 (ACKs 1-4 reach the simulator, the ACK of 5 is lost) and
  // ends at its scripted disconnect; the service logs durable delivery `active`.
  const first = (await recording.waitFor(s => Boolean(s.connections[0]?.closedBy) && s.connections[0].acks.includes('5'),
    'FIRST_CONNECTION_DID_NOT_COMMIT_AND_END', 20000)).connections[0];
  record.firstConnection = first;
  assert.equal(first.closedBy, 'server');
  assert.deepEqual(first.events, ['1', '2', '3', '4', '5'].map(eventSeq => ({eventSeq, redelivered: false})));
  assert.deepEqual(first.forwardedAcks, ['1', '2', '3', '4']); assert.deepEqual(first.withheldAcks, ['5']);
  record.firstServiceDurable = await durableActiveRow(events, config.diagnostics, initial.servicePid);
  record.commitsActive = true;
  // ET-015c PR-4: connection 1 recorded, and the dashboard showed it with the synthetic target note; once it ended, the
  // status reads interrupted with the partial trip. Recording lasts only as long as the scenario's frames stay fresh, so
  // the dashboard's text log and main's timeline prove it rather than a poll.
  record.status.afterFirstConnection = {dashboard: await waitForRecordingText(dashboard, RECORDING_TEXT_INTERRUPTED, 'RECORDING_NOT_INTERRUPTED_AFTER_FIRST_CONNECTION'),
    health: await recordingHealth(application, status => status.state === 'interrupted', 'RECORDING_NOT_INTERRUPTED_AFTER_FIRST_CONNECTION')};
  assert.deepEqual(record.status.afterFirstConnection.health, RECORDING_STATUS_INTERRUPTED);
  record.status.firstConnectionTexts = await shownText(dashboard, text => text.headline === 'Recording' && text.detail?.[0] === SYNTHETIC_NOTE && text.notice === TEST_NOTICE,
    'RECORDING_NOT_SHOWN_DURING_FIRST_CONNECTION');
  record.status.firstConnectionRows = statusRows(await mainEvents());
  assert.ok(record.status.firstConnectionRows.some(row => row.state === 'recording' && row.target === 'synthetic' && row.code === null && row.lostEvents === 0),
    'Main never received recording during connection 1');
  record.statusRecordingShown = true;
  const beforeServiceExit = (await mainEvents()).length;

  // 2. A diagnostic service exit; main's supervisor restarts the service, which cold-starts its recorder from seeds.
  assert.equal(await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-service-exit')), true, 'Opt-in diagnostic event unavailable');
  const restarted = await restartedService(application, initial.servicePid);
  record.restartedServicePid = restarted.servicePid;
  record.afterRestart = await waitForCurrentTelemetry(dashboard);
  record.serviceRestartRecovered = true;
  // ET-015c PR-4: main reported unknown from the service exit until the restarted service's first status; the restarted
  // service waits again, with connection 1's totals (none) carried over.
  record.status.afterRestart = {dashboard: await waitForRecordingText(dashboard, RECORDING_TEXT_WAITING, 'RECORDING_NOT_WAITING_AFTER_SERVICE_RESTART'),
    health: await recordingHealth(application, status => status.state === 'waiting', 'RECORDING_NOT_WAITING_AFTER_SERVICE_RESTART')};
  assert.deepEqual(record.status.afterRestart.health, RECORDING_STATUS_WAITING);
  const restartRows = record.status.serviceRestartRows = statusRows((await mainEvents()).slice(beforeServiceExit));
  const unknownAt = restartRows.findIndex(row => row.state === 'unknown');
  assert.ok(unknownAt >= 0 && restartRows.slice(unknownAt + 1).some(row => row.state === 'waiting' && row.target === 'synthetic'),
    'Main did not report unknown between the terminated and the restarted service');
  record.status.serviceRestartTexts = await shownText(dashboard, text => text.headline === 'Not known: the telemetry service is not running or has not reported a valid status' && text.detail === null,
    'RECORDING_UNKNOWN_NOT_SHOWN_AFTER_SERVICE_EXIT');
  record.statusUnknownAfterServiceExit = true;
  // A dashboard reload subscribes again and gets the same status.
  await dashboard.reload();
  await waitForCurrentTelemetry(dashboard);
  record.status.afterReload = await waitForRecordingText(dashboard, RECORDING_TEXT_WAITING, 'RECORDING_STATUS_NOT_KEPT_AFTER_RELOAD');
  assert.deepEqual(record.status.afterReload, record.status.afterRestart.dashboard);
  assert.deepEqual((await lifecycleState(application)).health.recording, RECORDING_STATUS_WAITING);
  record.statusReloadKept = true;

  // 3. Close the main window to the tray, then admit the restarted service's durable connection: the redelivery, the
  // rest of the job and the sampled frames are recorded while no dashboard exists. The ACK of the gate (eventSeq 10)
  // follows the observation of the frames before it.
  const afterClose = await closeDashboard(application, dashboard);
  record.afterClose = afterClose;
  assert.equal(launcher.exitCode, null, 'Application exited after closing the dashboard');
  assert.equal(afterClose.servicePid, restarted.servicePid); assert.equal(afterClose.tray, true); assert.equal(afterClose.exiting, false);
  const beforeSecondConnection = (await mainEvents()).length;
  recording.admit();
  const second = (await recording.waitFor(s => s.connections[1]?.forwardedAcks.includes(TRAY_EXIT_GATE), 'SECOND_CONNECTION_DID_NOT_COMMIT_THE_JOB', 20000)).connections[1];
  record.secondConnection = second;
  assert.equal(second.checkpointAckedThrough, '4');
  assert.deepEqual(second.events, [{eventSeq: '5', redelivered: true}, ...['6', '7', '8', '9', '10'].map(eventSeq => ({eventSeq, redelivered: false}))]);
  assert.deepEqual(second.forwardedAcks, ['5', '6', '7', '8', '9', '10']);
  record.redelivered = second.events.filter(event => event.redelivered).map(event => event.eventSeq);
  record.restartedServiceDurable = await durableActiveRow(events, config.diagnostics, restarted.servicePid);
  const during = await lifecycleState(application);
  record.whileClosed = during;
  assert.equal(during.dashboard, false); assert.equal(during.servicePid, restarted.servicePid); assert.equal(during.exiting, false);
  assert.equal((await mainEvents()).filter(row => row.event === 'SERVICE_EXIT').length, 1, 'Only the terminated service may have exited');
  record.dashboardClosedRecordingContinued = true;
  // ET-015c PR-4: while the dashboard was closed, main received recording from the restarted service, and its totals
  // after the redelivery count the consumer-restart interval and no lost event.
  const closedRows = await until(mainEvents, rows => statusRows(rows.slice(beforeSecondConnection)).some(row => RECORDED_STATES.includes(row.state)),
    'RECORDING_NOT_REPORTED_WHILE_CLOSED');
  record.status.whileClosedRows = statusRows(closedRows.slice(beforeSecondConnection));
  assert.ok(record.status.whileClosedRows.some(row => row.state === 'recording' && row.target === 'synthetic' && row.code === null),
    'Main never received recording while the dashboard was closed');
  record.statusRecordedWhileClosed = true;
  const whileClosed = record.status.whileClosed = await recordingHealth(application,
    status => JSON.stringify(status.losses) === JSON.stringify(RECORDING_LOSSES_AFTER_REDELIVERY), 'RECORDING_LOSSES_NOT_REPORTED_AFTER_REDELIVERY');
  assert.deepEqual({target: whileClosed.target, code: whileClosed.code, losses: whileClosed.losses}, {target: 'synthetic', code: null, losses: RECORDING_LOSSES_AFTER_REDELIVERY});
  assert.ok(['recording', 'paused', 'interrupted'].includes(whileClosed.state), `Unexpected state ${whileClosed.state} after the redelivery`);
  assert.ok(statusRows(await mainEvents()).every(row => !('lostEvents' in row) || row.lostEvents === 0), 'A run A status counted a lost event');
  record.statusNoEventLoss = true;
  // The dashboard reopened from the tray gets the current status with the totals since ETS2Telemetry started.
  assert.equal(await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-tray-action', 'open')), true, 'Diagnostic tray action unavailable');
  const reopened = await newDashboardPage(application, [dashboard]);
  record.status.reopened = await waitForRecordingText(reopened, {losses: RECORDING_TEXT_LOSSES_AFTER_REDELIVERY, notice: TEST_NOTICE, alert: null},
    'RECORDING_LOSSES_NOT_SHOWN_AFTER_REOPEN');
  assert.equal(record.status.reopened.detail?.[0], SYNTHETIC_NOTE);
  record.statusReopenedLosses = true;
  // Close it again, so the tray exit below still runs with the main window closed (REG-012: close to the tray, then exit).
  const closedAgain = record.status.closedAgain = await closeDashboard(application, reopened);
  assert.equal(closedAgain.dashboard, false); assert.equal(closedAgain.servicePid, restarted.servicePid); assert.equal(closedAgain.exiting, false);
  record.dashboardClosedBeforeTrayExit = true;

  // 4. Explicit exit from the tray: the service's ordered stop runs `recording-flush`, which writes the pending sample of
  // second 1001 (H11), then closes the database.
  await stopTracing();
  const exitStarted = performance.now();
  const exited = waitForExit(launcher, 8000, 'TRAY_EXIT_DID_NOT_FINISH_WITHIN_8_SECONDS');
  // Main may exit before the evaluation returns; only the process exit is the outcome.
  await application.evaluate(({app}) => {app.emit('ets2telemetry:diagnostic-tray-action', 'exit'); return true;}).catch(() => undefined);
  const exit = await exited;
  record.trayExit = {launcherExit: exit.code, signal: exit.signal, exitMilliseconds: Math.round(performance.now() - exitStarted)};
  assert.equal(exit.code, 0); assert.equal(exit.signal, null);
  record.trayExit.requests = (await mainEvents()).filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason ?? null);
  assert.deepEqual(record.trayExit.requests, ['tray']);
  record.trayExitOrderly = true;
}

/**
 * Run B: the same profile and LOCALAPPDATA start again; the third connection appends to the same database. The ACK of its
 * gate (eventSeq 13) follows the observation of the frames before it, so the exit that follows flushes second 1002.
 */
export async function verifyRecordingRestart({application, record, rendererPages, recording, events, config}) {
  const {dashboard} = await rendererPages(application);
  await dashboard.getByText(READY_TEXT, {exact: true}).waitFor({state: 'visible', timeout: 10000});
  record.restart = {ready: await waitForCurrentTelemetry(dashboard)};
  const state = await lifecycleState(application);
  record.restart.servicePid = state.servicePid;
  assert.ok(Number.isSafeInteger(state.servicePid) && state.servicePid !== record.servicePid && state.servicePid !== record.restartedServicePid, 'Run B reused a service');
  // ET-015c PR-4: an application restart starts new totals: run B waits with none.
  record.restart.status = {beforeAdmission: {dashboard: await waitForRecordingText(dashboard, RECORDING_TEXT_WAITING, 'RUN_B_RECORDING_NOT_WAITING'),
    health: await recordingHealth(application, status => status.state === 'waiting', 'RUN_B_RECORDING_NOT_WAITING')}};
  assert.deepEqual(record.restart.status.beforeAdmission.health, RECORDING_STATUS_WAITING);
  await startRecordingTextLog(dashboard);
  // Run A has exited, so no earlier service can take this admission.
  recording.admit();
  const third = (await recording.waitFor(s => s.connections[2]?.forwardedAcks.includes(RUN_B_GATE), 'THIRD_CONNECTION_DID_NOT_COMMIT', 20000)).connections[2];
  record.thirdConnection = third;
  assert.equal(third.checkpointAckedThrough, '10');
  assert.deepEqual(third.events, ['11', '12', '13'].map(eventSeq => ({eventSeq, redelivered: false})));
  assert.deepEqual(third.forwardedAcks, ['11', '12', '13']);
  record.restart.durable = await durableActiveRow(events, config.diagnosticsRestart, state.servicePid);
  record.restartRecovered = true;
  // ET-015c PR-4: run B recorded again (its v1 data is fresh only while the game is paused, so it reads paused) with
  // fresh totals: no status of run B carries a loss, and its dashboard shows no loss line.
  const rows = await until(() => events(config.diagnosticsRestart), list => statusRows(list).some(row => RECORDED_STATES.includes(row.state)), 'RUN_B_NOT_RECORDED');
  record.restart.status.rows = statusRows(rows);
  assert.ok(record.restart.status.rows.every(row => !('lostEvents' in row) || Object.keys(NO_LOSSES).every(key => row[key] === 0)), 'Run B carried losses');
  record.restart.status.texts = await shownText(dashboard, text => RECORDED_HEADLINES.includes(text.headline) && text.detail?.[0] === SYNTHETIC_NOTE,
    'RUN_B_RECORDING_NOT_SHOWN');
  assert.ok(record.restart.status.texts.every(text => text.losses === null), 'Run B showed a loss line');
  record.statusRunBFresh = true;
}

const FAILURE_EVENTS = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
// ET-015b PR-4: no sample write is retried, dropped by the pending bound, discarded after a failure or skipped as stored.
const RECORDING_FAILURES = new Set(['V1_DURABLE_RETRY', 'V1_DURABLE_UNAVAILABLE', 'V1_DURABLE_ACK_AHEAD', 'V1_DURABLE_RESTORE_LOSS', 'V1_EVENT_CONFLICT',
  'RECORDING_TARGET_REJECTED', 'HISTORY_STORAGE_UNAVAILABLE', 'V1_SAMPLES_RETRY', 'V1_SAMPLES_DROPPED', 'V1_SAMPLES_DISCARDED', 'V1_SAMPLES_SKIPPED']);
/** Recording diagnostics of one run's service processes: target, openings, the flush step and no durable failure. */
function verifyServiceRecording(service, created) {
  assert.deepEqual(service.filter(row => row.event === 'RECORDING_TARGET').map(row => row.facts), created.map(() => ({purpose: 'synthetic'})));
  assert.deepEqual(service.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts.created), created);
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'recording-flush').map(row => row.facts.outcome), ['ok']);
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'history-storage').map(row => row.facts.outcome), ['ok']);
  assert.equal(service.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length, 1);
  assert.deepEqual(service.filter(row => RECORDING_FAILURES.has(row.event)).map(row => row.event), []);
}

/**
 * ET-015b PR-4 (H8, H11): the V1_SAMPLES_EXIT rows of one service process that stopped in order with one sample row
 * pending since its connection. Its exit flush must have written that row, logging {rows: 1, losses: 0, code: WRITTEN},
 * when its recording-flush step was logged less than EXIT_FLUSH_CERTAIN_MS after its first connection; later, the 5 s
 * flush may have written the row first and the exit then logs nothing. Both times come from the service's own log.
 */
function sampleExit(service, pid) {
  const rows = service.filter(row => row.pid === pid);
  const connected = rows.find(row => row.event === 'V1_SOURCE_STATUS' && row.facts?.status === 'connected');
  const flush = rows.find(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'recording-flush');
  assert.ok(connected && flush, `Service ${pid}: connection or recording-flush step not logged`);
  const flushAfterConnectMs = Date.parse(flush.time) - Date.parse(connected.time);
  assert.ok(Number.isFinite(flushAfterConnectMs), `Service ${pid}: diagnostic times unavailable`);
  const exits = rows.filter(row => row.event === 'V1_SAMPLES_EXIT').map(row => row.facts);
  const required = flushAfterConnectMs < EXIT_FLUSH_CERTAIN_MS;
  if (required || exits.length) assert.deepEqual(exits, [{rows: 1, losses: 0, code: 'WRITTEN'}], `Service ${pid}: the exit flush did not write the pending sample (recording-flush ${flushAfterConnectMs} ms after the first connection, required ${required})`);
  return {pid, required, flushAfterConnectMs, exits};
}

/** Reads a copy of the database with the checkout's Electron in Node mode (scripts/ci/recording-database.cjs). */
async function readDatabase(config, database) {
  const directory = path.join(config.output, 'recording-verify'), copy = path.join(directory, 'smoke.sqlite');
  await mkdir(directory, {recursive: true});
  await copyFile(database, copy);
  const electron = createRequire(path.join(config.checkout, 'package.json'))('electron');
  const child = spawn(electron, [path.join(config.checkout, 'scripts/ci/recording-database.cjs'), copy], {cwd: config.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata}});
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  let timer;
  const exit = await Promise.race([new Promise(resolve => child.once('exit', code => resolve(code))), new Promise(resolve => {timer = setTimeout(() => resolve('timeout'), 15000);})]);
  clearTimeout(timer);
  if (exit !== 0) {child.kill(); throw new Error(`DATABASE_READER_FAILED ${exit}: ${Buffer.concat(stderr).toString().slice(0, 512)}`);}
  return JSON.parse(Buffer.concat(stdout).toString());
}

/** The stored rows in the shape of the hand-written expectation, with trip UUIDs as `trip@<eventSeq>` labels. */
function rowsOf(raw, session) {
  const labels = tripLabels(session), label = value => value === null ? null : labels.get(value) ?? value;
  return {
    trips: raw.trips.map(t => ({trip: label(t.tripUuid), jobConfigurationEventSeq: key(t.jobSeq), truckConfigurationEventSeq: key(t.truckSeq),
      trailerConfigurationEventSeqs: t.trailerSeqs.map(key), openedEventSeq: key(t.openedSeq), gameMode: {mode: t.mode, method: t.method, confidence: t.confidence},
      gameModeAmbiguous: t.ambiguous === 1, outcome: t.outcome, outcomeEventSeq: key(t.outcomeSeq), closeReason: t.closeReason, recordingCompleteness: t.completeness,
      startedUtcMs: t.startedUtcMs, endedUtcMs: t.endedUtcMs,
      observedDistanceM: t.distanceState === 'available' ? {available: true, value: t.distance} : {available: false, reason: t.distanceState},
      // ET-016 PR-6 (S-1): fuel used is a stored trip value as well.
      fuelUsedL: t.fuelUsedState === 'available' ? {available: true, value: t.fuelUsed} : {available: false, reason: t.fuelUsedState}})),
    attributions: raw.attributions.map(a => ({eventSeq: key(a.eventSeq), trip: label(a.trip), attribution: a.attribution})),
    intervals: raw.intervals.map(i => {
      const row = {trip: label(i.trip), kind: i.kind};
      for (const name of ['startUtcMs', 'endUtcMs']) if (i[name] !== null) row[name] = Number(i[name]);
      for (const name of ['startMonotonicNs', 'endMonotonicNs', 'firstEventSeq', 'lastEventSeq']) if (i[name] !== null) row[name] = key(i[name]);
      if (i.sourceClockId !== null) row.sourceClockId = i.sourceClockId;
      if (i.detail !== null) row.detail = JSON.parse(i.detail);
      return row;
    }),
    events: raw.events.map(e => ({eventSeq: key(e.eventSeq), type: e.type, utcMs: e.utcMs === null ? null : Number(e.utcMs), firstRedelivered: e.firstRedelivered === 1})),
    gaps: raw.gaps, samples: raw.samples, coverage: {committedThroughEventSeq: key(raw.sessions[0]?.committedThrough)},
    // ET-015b: each stored sample with its source second, floor(monotonicNs / 1e9), and its trip label.
    sampleRows: raw.sampleRows.map(s => ({second: (BigInt(s.monotonicNs) / 1_000_000_000n).toString(), trip: label(s.trip), monotonicNs: key(s.monotonicNs),
      utcMs: s.utcMs, speedMps: s.speedMps, odometerM: s.odometerM}))
  };
}

/**
 * After both runs: the diagnostics of both runs, the simulator's report and the synthetic database, which must hold the
 * hand-written rows, while no history database was created and no WAL or shared-memory file is left.
 */
export async function verifyRecordingRun({config, record, recording, mainEvents, serviceEvents, restartMainEvents, restartServiceEvents, simulatorWaitMs}) {
  // Run A: a terminated service and its replacement; run B: one service. Both exits are orderly.
  verifyServiceRecording(serviceEvents, [true, false]);
  assert.equal(mainEvents.filter(row => row.event === 'DIAGNOSTIC_SERVICE_EXIT_REQUEST').length, 1);
  assert.deepEqual(mainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['tray']);
  for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
    const rows = restartMainEvents.filter(row => row.event === name);
    assert.equal(rows.length, 1); assert.equal(rows[0].detail.code, 0);
  }
  assert.deepEqual(restartServiceEvents.filter(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped').map(row => row.detail), [{type: 'stopped', clean: true}]);
  for (const service of [serviceEvents, restartServiceEvents]) {
    const lastPid = service.findLast(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped')?.pid;
    const steps = service.filter(row => row.event === 'SHUTDOWN_STEP' && row.pid === lastPid);
    assert.ok(steps.length >= 6 && steps.every(row => row.facts?.outcome === 'ok'), 'Every service shutdown step must finish cleanly');
  }
  assert.ok(![...restartMainEvents, ...restartServiceEvents].some(row => FAILURE_EVENTS.test(row.event)));
  verifyServiceRecording(restartServiceEvents, [false]);
  assert.deepEqual(restartMainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['app-quit']);
  record.shutdownClean = true;

  // The simulator served all three connections durable, closed none for a protocol error and matched its replay.
  const simulator = record.simulator = await recording.stop({waitMs: simulatorWaitMs});
  record.proxy = recording.statistics();
  // Recorded, never asserted, so hosted runs show their margins: live-only hellos refused while storage was still opening
  // (the R10 window this journey does not exercise), holds that expired before admission, and event-to-ACK latencies.
  record.refusedLiveOnly = record.proxy.refusedLiveOnly; record.expiredHolds = record.proxy.expiredHolds;
  record.maxAckLatencyMs = Math.max(0, ...record.proxy.connections.flatMap(c => c.ackLatencyMs.map(latency => latency.ms)));
  assert.deepEqual(simulator.exit, {code: 0, signal: null});
  const report = simulator.report;
  assert.equal(report?.scenario, RECORDING_SCENARIO); assert.equal(report.cancelled, false); assert.equal(report.history, false);
  assert.deepEqual(report.connections.map(c => c.durable), [true, true, true]);
  assert.equal(report.connections[0].closedBy, 'disconnect');
  for (const connection of report.connections.slice(1)) assert.ok(['client', 'disconnect'].includes(connection.closedBy), `Connection ${connection.connection} closed by ${connection.closedBy}`);
  assert.equal(report.matchesReplay, true, `Reactive run differs from the replay: ${report.differences?.join('; ')}`);
  record.simulatorMatchesReplay = true;
  assert.equal(record.proxy.connections.length, 3);
  assert.ok(record.proxy.connections.every(c => !c.decodeFailure && c.gaps === 0 && c.end === null));

  // Files: the synthetic database only, closed cleanly; no history database.
  const root = path.join(config.localappdata, 'ETS2Telemetry'), database = path.join(root, 'synthetic', 'smoke.sqlite');
  const header = Buffer.alloc(100), file = await open(database, 'r');
  try {await file.read(header, 0, 100, 0);} finally {await file.close();}
  const files = record.files = {magic: header.subarray(0, 15).toString('latin1'), applicationId: header.readInt32BE(68), userVersion: header.readUInt32BE(60),
    sidecars: ['-wal', '-shm', '-journal'].filter(suffix => existsSync(database + suffix)), syntheticBackups: existsSync(path.join(root, 'synthetic', 'backups')),
    historyDatabase: existsSync(path.join(root, 'data', 'telemetry.sqlite')), dataDirectory: existsSync(path.join(root, 'data'))};
  // Whether the empty `data` directory exists is recorded only; the history database file must not.
  assert.deepEqual({...files, dataDirectory: null}, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 2, sidecars: [], syntheticBackups: false,
    historyDatabase: false, dataDirectory: null});
  record.historyDatabaseAbsent = true; record.sidecarsAbsent = true;

  // Rows: integrity, purpose, one synthetic session of the simulator, and exactly the hand-written expectation.
  const raw = await readDatabase(config, database);
  const session = seededId(recording.seed, 'plugin-session');
  record.database = {integrity: raw.integrity, foreignKeyViolations: raw.foreignKeyViolations, purpose: raw.purpose, acceptedOrigin: raw.acceptedOrigin,
    journalMode: raw.journalMode, sessions: raw.sessions.map(s => ({game: s.game, origin: s.origin, committedThrough: key(s.committedThrough), endReason: s.endReason,
      simulatorSession: s.session === session}))};
  assert.deepEqual(raw.integrity, ['ok']); assert.equal(raw.foreignKeyViolations, 0);
  assert.deepEqual({purpose: raw.purpose, acceptedOrigin: raw.acceptedOrigin, applicationId: raw.applicationId, userVersion: raw.userVersion},
    {purpose: 'synthetic', acceptedOrigin: 'synthetic', applicationId: 1163154226, userVersion: 2});
  assert.deepEqual(record.database.sessions, [{game: 'ets2', origin: 'synthetic', committedThrough: '13', endReason: null, simulatorSession: true}]);
  assert.ok(raw.events.every(event => event.session === session) && raw.trips.every(trip => trip.session === session && trip.game === 'ets2'));
  assert.ok(raw.sampleRows.every(sample => sample.session === session), 'A sample belongs to another plugin session');
  const actual = record.database.rows = rowsOf(raw, session);
  const expected = JSON.parse(await readFile(path.join(config.checkout, 'tests/fixtures/recording', `${RECORDING_SCENARIO}.rows.expected.json`), 'utf8'));
  for (const name of ['trips', 'attributions', 'intervals', 'events', 'gaps', 'coverage']) assert.deepEqual(actual[name], expected[name], `Stored ${name} differ from the expectation`);
  // ET-015b PR-4: the sample rows in insertion order. Whether the optional second-1000 row was flushed before the
  // diagnostic kill depends on timing, so it may lead (its count is recorded); the required rows follow exactly.
  record.database.samples = actual.samples;
  assert.equal(actual.sampleRows.length, actual.samples);
  const optionalSamples = record.database.optionalSamples = actual.sampleRows.length - expected.samples.required.length;
  assert.ok(optionalSamples >= 0 && optionalSamples <= expected.samples.optional.length, `Unexpected sample count ${actual.sampleRows.length}`);
  assert.deepEqual(actual.sampleRows, [...expected.samples.optional.slice(0, optionalSamples), ...expected.samples.required], 'Stored samples differ from the expectation');
  // H11: run A's replacement service and run B's service each had one row pending at their explicit exits.
  record.sampleExits = [sampleExit(serviceEvents, record.restartedServicePid), sampleExit(restartServiceEvents, record.restart.servicePid)];
  assert.deepEqual(serviceEvents.filter(row => row.pid === record.servicePid && row.event === 'V1_SAMPLES_EXIT'), [], 'The terminated service logged an exit flush');
  record.samplesRecorded = true;
  // Each event once, and coverage at least every ACK the simulator received.
  assert.equal(new Set(actual.events.map(event => event.eventSeq)).size, actual.events.length);
  const acknowledged = record.proxy.connections.flatMap(c => c.forwardedAcks).reduce((max, through) => BigInt(through) > max ? BigInt(through) : max, 0n);
  record.database.acknowledgedThrough = acknowledged.toString();
  assert.ok(BigInt(actual.coverage.committedThroughEventSeq) >= acknowledged);
  record.databaseRowsMatch = true;
}
