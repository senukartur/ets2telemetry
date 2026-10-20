import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, open, readdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {recordingTextLog, startRecordingTextLog, waitForCurrentTelemetry, waitForRecordingText} from './renderer-observation.mjs';
import {closeDashboard, lifecycleState, newDashboardPage, until, waitForExit} from './lifecycle-observation.mjs';
import {startRecordingProxy} from './recording-proxy.mjs';
import {clickTestId, dialogCalls, exportTrip, exportValidator, listState, openDetail, openTable, stubSaveDialog, untilPage} from './journal-observation.mjs';

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
// ET-016 PR-8: after run B recorded, its dashboard opens the Journal tab while the recording runs, compares the list,
// the detail, the completeness intervals, the timeline and the samples of the recorded trip with hand-written texts,
// exports the trip through main's Save dialog (replaced through Playwright, as in the journal smoke) and cancels a second
// export. After both runs the export is checked with the shared validator and reconciled with the stored rows.

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
 *
 * `--await-scripted-acks`: connections 2 and 3 are scripted to acknowledge each commit, and the service writes each ACK
 * only after its storage commit (E8). Without the option the simulator waits at most 1,000 ms for those ACKs after each
 * action and then paces on to the scripted disconnect, so one commit slower than that bound (hosted run 39135729037: the
 * gate eventSeq 13 committed, its ACK never sent, the Job nearly idle) ended connection 3 before the gate's ACK and the
 * journey failed with THIRD_CONNECTION_DID_NOT_COMMIT. With it, the simulator waits until the service acknowledged
 * everything written to it or left (30 s liveness bound), as the ET-006b storage tests do. Connection 1 drops ACKs after
 * four (`dropAfter:4`), so it keeps the bounded wait.
 */
export async function startRecordingSource(config) {
  const {checkout, output} = config;
  const base = JSON.parse(await readFile(path.join(checkout, 'tests/fixtures/simulator-v1/normal-delivery.json'), 'utf8'));
  const scenario = {...base, id: RECORDING_SCENARIO,
    purpose: 'Runtime recording journey: normal-delivery through a killed and restarted telemetry service, close-to-tray, a tray exit and an application restart.',
    steps: [...base.steps, ...JOURNEY_STEPS], transport: JOURNEY_TRANSPORT};
  const scenarioFile = path.join(output, 'recording-scenario.json');
  await writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n');
  const simulator = spawn(process.execPath, [path.join(checkout, 'tools/telemetry-simulator/dist/cli.cjs'), 'serve-v1', scenarioFile, '--await-scripted-acks'],
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
  record.hardModeAdmissionUtcMs = Date.now();
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
  // Main writes its log asynchronously, so the row is awaited rather than read once.
  record.status.firstConnectionRows = statusRows(await until(mainEvents, rows => statusRows(rows).some(row => row.state === 'recording' && row.target === 'synthetic'),
    'RECORDING_ROW_NOT_LOGGED_DURING_FIRST_CONNECTION'));
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
  // Main writes its log asynchronously, so the rows are awaited rather than read once.
  const unknownThenWaiting = rows => {const at = rows.findIndex(row => row.state === 'unknown'); return at >= 0 && rows.slice(at + 1).some(row => row.state === 'waiting' && row.target === 'synthetic');};
  const restartRows = record.status.serviceRestartRows = statusRows((await until(mainEvents, rows => unknownThenWaiting(statusRows(rows.slice(beforeServiceExit))),
    'RECORDING_RESTART_ROWS_NOT_LOGGED')).slice(beforeServiceExit));
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
  // ET-016 PR-8: the journal and the export of the recorded trip, while run B's recording runs.
  await runRecordingJournal({application, dashboard, recording, config, record});
}

// ET-016 PR-8: the recorded trip in the Journal tab and its export. Every expected text and value below is written by
// hand from normal-delivery.json, the hand-written rows (normal-delivery-runtime-journey.rows.expected.json), J13 and
// the trip export format (docs/journal-export.md); none is read back from journal-view.ts or the exporter. ETS2 uses the
// metric profile (the journey never changes the settings), and the scenario's currency is unknown.
const JOURNAL_BANNER = 'Synthetic test database — never game history';
const NOT_OBSERVED = 'unavailable (not observed)';
const JOURNEY_ROUTE = `${NOT_OBSERVED} → ${NOT_OBSERVED}`;
/** The simulator's UTC label of a step: 1,800,000,000,000 + atMs. */
const labelAt = atMs => 1_800_000_000_000 + atMs;
/** A UTC label as the renderer's local clock time, written independently of journal-view.ts with Date's local getters. */
const localTime = utcMs => {
  const d = new Date(utcMs), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
/** T4: the UUID of the trip that the job configuration eventSeq 3 of the simulator's plugin session opened. */
const journeyTripUuid = session => uuidOf(createHash('sha256').update(`ets2telemetry-trip-v1:${session}:3`, 'utf8').digest('hex'));
/** trip@3's list row: delivered and partial (opened at load), observed 0 m, no fuel channel, no city or cargo names. */
const journalRow = trip => ({trip, started: localTime(labelAt(30)), game: 'ETS2', route: JOURNEY_ROUTE, outcome: 'Delivered', completeness: 'Partial',
  observed: '0.0 km', fuel: NOT_OBSERVED, cargo: NOT_OBSERVED});
/**
 * trip@3's detail: every field of the summary. The job of eventSeq 3 has ids, 152 km planned, income 12345 and cargo not
 * loaded; job.delivered (8) has revenue 12000, 250 XP, damage 0.03125, 152.5 km and 300 game minutes; the truck has a
 * brand id, a model id and 800 L; trailer 1 is a dryvan. One second-1000 sample belongs to the trip when it was stored.
 */
function journalDetail(session, trip, sampleCount) {
  const fields = {
    'trip-game': 'Euro Truck Simulator 2', 'trip-gameMode': 'Unknown', 'trip-outcome': 'Delivered', 'trip-completeness': 'Partial', 'trip-started': localTime(labelAt(30)),
    'trip-ended': localTime(labelAt(600)), 'trip-openedBy': 'job event 3', 'trip-session': session, 'trip-tripId': trip,
    'distance-plannedDistance': '152.0 km', 'distance-observedDistance': '0.0 km', 'distance-deliveredDistance': '152.5 km', 'fuel-fuelUsed': NOT_OBSERVED,
    'money-expectedIncome': '12345 (currency unknown)', 'money-revenue': '12000 (currency unknown)', 'money-fine': 'none recorded', 'money-toll': 'none recorded',
    'money-ferry': 'none recorded', 'money-train': 'none recorded',
    'job-sourceCity': NOT_OBSERVED, 'job-sourceCompany': NOT_OBSERVED, 'job-destinationCity': NOT_OBSERVED, 'job-destinationCompany': NOT_OBSERVED, 'job-cargo': NOT_OBSERVED,
    'job-cargoMass': NOT_OBSERVED, 'job-market': NOT_OBSERVED, 'job-specialJob': NOT_OBSERVED, 'job-cargoLoaded': 'no', 'job-deadline': NOT_OBSERVED, 'job-jobSource': 'job event 3',
    'delivery-earnedXp': '250', 'delivery-cargoDamage': '3%', 'delivery-deliveryDuration': '5 h 0 min', 'delivery-autoPark': 'no', 'delivery-autoLoad': 'no',
    'truck-brand': NOT_OBSERVED, 'truck-model': NOT_OBSERVED, 'truck-licensePlate': NOT_OBSERVED, 'truck-plateCountry': NOT_OBSERVED, 'truck-fuelCapacity': '800.0 L',
    'trailers-trailer-0-brand': NOT_OBSERVED, 'trailers-trailer-0-model': NOT_OBSERVED, 'trailers-trailer-0-body': 'dryvan', 'trailers-trailer-0-plate': NOT_OBSERVED,
    'samples-sampleCount': String(sampleCount),
    ...(sampleCount ? {'samples-firstSample': localTime(labelAt(100)), 'samples-lastSample': localTime(labelAt(100))} : {})
  };
  return {error: null, title: `ETS2: ${JOURNEY_ROUTE}`, outcome: 'Delivered', completeness: 'Partial', fields, banner: JOURNAL_BANNER,
    notes: {trip: ['Times are the recorded UTC labels shown in local time.'], money: ['Amounts are the exact game values. They are never converted, netted or added across currencies.']}};
}
/** The two completeness intervals (kind, cause, start, end, events): neither carries a UTC label or an eventSeq range. */
const JOURNAL_INTERVALS = {total: 'Completeness intervals recorded for this trip: 2.',
  rows: [['Discontinuity', 'opened while a save was loading', '—', '—', '—'], ['Not connected', 'telemetry service restarted', '—', '—', '—']]};
/** J7: from the job configuration (3) through job.delivered (8), which closed the trip; eventSeq 5 once despite its redelivery. */
const JOB_DETAIL = `${NOT_OBSERVED}, ${JOURNEY_ROUTE}`;
const journalTimeline = () => ({window: "Events of the trip's plugin session from eventSeq 3 through 8, the event that closed the trip.", rows: [
  ['3', localTime(labelAt(30)), 'Job configured', JOB_DETAIL, '—'], ['4', localTime(labelAt(40)), 'Game resumed', '', '—'],
  ['5', localTime(labelAt(300)), 'Job configured', JOB_DETAIL, '—'], ['6', localTime(labelAt(400)), 'Game paused', '', '—'],
  ['7', localTime(labelAt(500)), 'Game resumed', '', '—'], ['8', localTime(labelAt(600)), 'Delivered', 'Revenue 12000 (currency unknown), delivered distance 152.5 km', 'this trip']]});
/** The optional second-1000 sample: 25.5 m/s, odometer 1,000.5 km, game time 601 min; no other channel was sent. */
const journalSampleRow = () => [localTime(labelAt(100)), '91.8 km/h', NOT_OBSERVED, NOT_OBSERVED, NOT_OBSERVED, '1000.5 km', NOT_OBSERVED, NOT_OBSERVED, 'Day 1, 10:01', NOT_OBSERVED];
const NO_SAMPLES = 'No one-second samples were recorded for this trip.';
/** J16: the default name carries the start label in UTC (1,800,000,000,030 ms is 2027-01-15 08:00 UTC) and the UUID's first 8 digits. */
const exportDialog = trip => ({window: true, defaultName: `ets2telemetry-trip-ets2-20270115-0800-${trip.slice(0, 8)}.json`, absoluteDirectory: true,
  filters: [{name: 'JSON', extensions: ['json']}]});
const exportSavedText = samples => `Saved the trip as JSON: 6 events, 2 completeness intervals and ${samples} one-second samples.`;
const EXPORT_CANCELLED = 'Export cancelled. Nothing was written.';
const sha256Of = async file => createHash('sha256').update(await readFile(file)).digest('hex');

/**
 * Run B, after its recording: the Journal tab lists the one recorded trip; its detail, completeness intervals, timeline
 * and samples show their hand-written texts; Export saves it to `recording-export\trip.json` of the run directory through
 * the replaced Save dialog; a cancelled second export writes nothing and leaves the saved file unchanged. The stored rows
 * are read only after the exit, so the sample count shown decides whether the optional second-1000 row is expected here;
 * the reconciliation after the exit checks that count against the database.
 */
async function runRecordingJournal({application, dashboard, recording, config, record}) {
  const session = seededId(recording.seed, 'plugin-session'), trip = journeyTripUuid(session);
  const journal = record.journal = {tripUuid: trip, readStartedUtcMs: Date.now()};
  await clickTestId(dashboard, 'tab-journal');
  const list = await untilPage(dashboard, listState, {page: 1, count: 1, first: trip});
  journal.list = {rows: list.rows, banner: list.banner, error: list.error, next: list.next, previous: list.previous};
  assert.deepEqual(journal.list, {rows: [journalRow(trip)], banner: JOURNAL_BANNER, error: null, next: false, previous: false}, 'The journal list differs from the hand-written row');
  journal.listMatch = true;

  const detail = journal.detail = await openDetail(dashboard, trip);
  const sampleCount = journal.sampleCount = Number(detail.fields['samples-sampleCount']);
  assert.ok(sampleCount === 0 || sampleCount === 1, `Unexpected trip sample count ${detail.fields['samples-sampleCount']}`);
  assert.deepEqual(detail, journalDetail(session, trip, sampleCount), 'The journal detail differs from the hand-written texts');
  journal.detailMatch = true;
  const intervals = await openTable(dashboard, 'intervals', 2);
  journal.intervals = {total: intervals.header, rows: intervals.rows.map(row => row.cells), error: intervals.error, next: intervals.next};
  assert.deepEqual(journal.intervals, {...JOURNAL_INTERVALS, error: null, next: false}, 'The completeness intervals differ from the hand-written texts');
  journal.intervalsMatch = true;
  const timeline = await openTable(dashboard, 'timeline', 6);
  journal.timeline = {window: timeline.header, rows: timeline.rows.map(row => row.cells), eventSeqs: timeline.rows.map(row => row.eventSeq), error: timeline.error, next: timeline.next};
  const expectedTimeline = journalTimeline();
  assert.deepEqual(journal.timeline, {...expectedTimeline, eventSeqs: expectedTimeline.rows.map(row => row[0]), error: null, next: false},
    'The timeline differs from the hand-written texts');
  journal.timelineMatch = true;
  const samples = await openTable(dashboard, 'samples', sampleCount);
  journal.samples = {rows: samples.rows.map(row => ({kind: row.kind, cells: row.cells})), error: samples.error, next: samples.next,
    empty: sampleCount ? null : await dashboard.getByTestId('journal-samples-empty').textContent({timeout: 5000})};
  assert.deepEqual(journal.samples, {rows: sampleCount ? [{kind: 'sample', cells: journalSampleRow()}] : [], error: null, next: false, empty: sampleCount ? null : NO_SAMPLES},
    'The samples differ from the hand-written texts');
  journal.samplesMatch = true;

  // The export, then a cancelled export. Each Save dialog replacement is set anew and answers a fixed target in the run directory.
  const folder = path.join(config.output, 'recording-export'), file = path.join(folder, 'trip.json');
  await mkdir(folder);
  await stubSaveDialog(application, {canceled: false, filePath: file});
  const saved = await exportTrip(dashboard, trip, exportSavedText(sampleCount));
  journal.exportDialog = await dialogCalls(application);
  assert.equal(saved.failed, 'false');
  assert.deepEqual(journal.exportDialog, [exportDialog(trip)]);
  const savedHash = await sha256Of(file);
  journal.exportSaved = true;
  await stubSaveDialog(application, {canceled: true, filePath: ''});
  const cancelled = await exportTrip(dashboard, trip, EXPORT_CANCELLED);
  assert.equal(cancelled.failed, 'false');
  // The cancel must come from the Save dialog main offered again, not from a reply that skipped it.
  assert.deepEqual(await dialogCalls(application), [exportDialog(trip)], 'The cancelled export did not offer the Save dialog');
  journal.exportFolder = (await readdir(folder)).sort();
  journal.exportUnchangedByCancel = await sha256Of(file) === savedHash;
  assert.deepEqual(journal.exportFolder, ['trip.json'], 'The cancelled export left a file in the export folder');
  assert.equal(journal.exportUnchangedByCancel, true, 'The cancelled export changed the saved file');
  journal.exportCancelledWritesNothing = true;
}

/** The trip export rows main logged in run B, in order. */
const exportEvents = samples => [{event: 'JOURNAL_EXPORT_SAVED', facts: {events: 6, samples}}, {event: 'JOURNAL_EXPORT_CANCELLED', facts: null}];
/** The scenario's currency is unknown: every amount is `{raw, sdkType, currency: {status: 'unknown'}}`. */
const unknownMoney = (raw, sdkType) => ({available: true, value: {raw, sdkType, currency: {status: 'unknown'}}});
const absent = unit => unit ? {available: false, reason: 'not-observed', unit} : {available: false, reason: 'not-observed'};
/** The job values of eventSeq 3 in the protocol v1 job.configured shape (tools/telemetry-simulator: unsent attributes are not observed). */
const JOB_VALUES = {sourceCityId: {available: true, value: 'synthetic_city_a'}, sourceCity: absent(), sourceCompanyId: absent(), sourceCompany: absent(),
  destinationCityId: {available: true, value: 'synthetic_city_b'}, destinationCity: absent(), destinationCompanyId: absent(), destinationCompany: absent(),
  cargoId: {available: true, value: 'synthetic_cargo'}, cargo: absent(), market: absent(), cargoMass: absent('kg'), cargoUnitMass: absent('kg'), cargoUnitCount: absent(),
  isSpecialJob: absent(), cargoLoaded: {available: true, value: false}, plannedDistance: {available: true, value: 152000, unit: 'm'},
  expectedIncome: unknownMoney('12345', 'u64'), deliveryDeadline: absent('min')};
/** job.delivered (8): revenue 12000, 250 XP, damage 0.03125, 152.5 km, 300 game minutes, no auto park or load. */
const DELIVERED_RECORD = {type: 'job.delivered', revenue: unknownMoney('12000', 's64'), earnedXp: {available: true, value: 250},
  cargoDamage: {available: true, value: 0.03125, unit: 'fraction'}, distance: {available: true, value: 152500, unit: 'm'}, deliveryDuration: {available: true, value: '300', unit: 'min'},
  autoParkUsed: {available: true, value: false}, autoLoadUsed: {available: true, value: false}};
/** The trip section of the export: the hand-written trip row with its stable identifiers and the close carrier, job.delivered (8). */
const exportTripSection = (session, trip, audit) => ({is_hard_mode: false, hard_mode_details: audit, tripUuid: trip, pluginSessionId: session, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
  gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'partial', startedUtcMs: labelAt(30), endedUtcMs: labelAt(600),
  observedDistanceM: {available: true, value: 0}, fuelUsedL: {available: false, reason: 'not-observed'}, openedBy: 'event', openedEventSeq: '3', outcomeEventSeq: '8',
  closedBy: {pluginSessionId: session, eventSeq: '8'}});
/** Independent oracle: this journey has no config fixture/binding. The production recorder supplies evidence, so
 * opening/closing are explicitly unknown/historical, unlike old seeded rows with no observation metadata. Only the
 * real observation clock varies: validate it against the harness's admission/read bounds before building exact rows. */
function recordingHardModeAudit(document, record) {
  const opening = document.trip.hard_mode_details?.opening?.observedUtcMs;
  const latest = document.trip.hard_mode_details?.latest?.observedUtcMs;
  assert.ok(Number.isSafeInteger(opening) && Number.isSafeInteger(latest), 'Hard Mode observation clocks must be safe UTC milliseconds');
  assert.ok(record.hardModeAdmissionUtcMs <= opening && opening <= latest && latest <= record.journal.readStartedUtcMs,
    'Hard Mode observation clocks must be ordered within source admission and the journal read');
  const unknown = at => ({observedUtcMs: at, state: 'unknown', source: 'unknown', rules:
    ['fuel', 'air', 'police', 'fatigue', 'limiter', 'truck', 'trailer', 'parking', 'rain', 'events', 'braking', 'traffic']
      .map(id => ({id, state: 'unknown', values: id === 'parking' ? [null, null] : [null], reason: 'historical'}))});
  return {version: 1, binding: null, opening: unknown(opening), latest: unknown(latest),
    firstLoss: {atUtcMs: opening, reason: 'historical', rule: null, values: null}, manualDelivery: true};
}
/** The window's events as [eventSeq, type, attribution kind]: only job.delivered (8) is attributed, to the trip itself. */
const EXPORT_EVENTS = [['3', 'job.configured', null], ['4', 'simulation.started', null], ['5', 'job.configured', null], ['6', 'simulation.paused', null],
  ['7', 'simulation.started', null], ['8', 'job.delivered', 'trip']];

/**
 * After both runs: the export saved in run B, checked by the shared validator (tests/shared/trip-export-validator.ts),
 * against its hand-written sections and against the stored rows read by recording-database.cjs. It names the stored
 * trip, plugin session and database; it lists each eventSeq of the window once even though eventSeq 5 was redelivered,
 * and exactly the stored events of the window; its completeness intervals and samples are the trip's stored rows with
 * their row ids; and its bounds are coverage 13 and the trip's largest stored sample and interval ids.
 */
async function reconcileExport({config, record, raw, session, restartMainEvents}) {
  const journal = record.journal, trip = journeyTripUuid(session);
  journal.exportEvents = restartMainEvents.filter(row => row.event.startsWith('JOURNAL_EXPORT_')).map(row => ({event: row.event, facts: row.facts ?? null}));
  assert.deepEqual(journal.exportEvents, exportEvents(journal.sampleCount));
  const document = JSON.parse(await readFile(path.join(config.output, 'recording-export', 'trip.json'), 'utf8'));
  const problemsOf = await exportValidator(config);
  journal.exportProblems = problemsOf(document);
  assert.deepEqual(journal.exportProblems, [], 'The export is not a valid format version 2 document');
  journal.exportValidated = true;

  // Hand-written sections.
  assert.deepEqual({format: document.format, formatVersion: document.formatVersion, application: document.header.application, purpose: document.header.database.purpose,
    schemaVersion: document.header.database.schemaVersion, sessionOrigin: document.header.sessionOrigin},
  {format: 'ets2telemetry.trip-export', formatVersion: 2, application: {name: 'ETS2Telemetry', version: '0.1.0'}, purpose: 'synthetic', schemaVersion: 3, sessionOrigin: 'synthetic'});
  assert.deepEqual(document.trip, exportTripSection(session, trip, recordingHardModeAudit(document, record)), 'The exported trip differs from the hand-written row');
  assert.deepEqual(document.window, {known: true, pluginSessionId: session, fromEventSeq: '3', throughEventSeq: '8', end: 'close-event'});
  assert.deepEqual({source: document.job.source, eventSeq: document.job.eventSeq, checkpointNextEventSeq: document.job.checkpointNextEventSeq, values: document.job.values},
    {source: 'event', eventSeq: '3', checkpointNextEventSeq: null, values: JOB_VALUES}, 'The exported job differs from eventSeq 3');
  assert.deepEqual({eventSeq: document.truck?.eventSeq, brandId: document.truck?.values.brandId, id: document.truck?.values.id, fuelCapacity: document.truck?.values.fuelCapacity},
    {eventSeq: '1', brandId: {available: true, value: 'synthetic_brand'}, id: {available: true, value: 'vehicle.synthetic_truck'}, fuelCapacity: {available: true, value: 800, unit: 'L'}});
  assert.deepEqual({total: document.trailers.total, items: document.trailers.items.map(item => ({eventSeq: item.eventSeq, index: item.values.index, id: item.values.id, bodyType: item.values.bodyType}))},
    {total: 1, items: [{eventSeq: '2', index: 0, id: {available: true, value: 'trailer.synthetic_box'}, bodyType: {available: true, value: 'dryvan'}}]});
  assert.deepEqual(document.outcomeDetails, {eventSeq: '8', record: DELIVERED_RECORD}, 'The exported outcome differs from job.delivered (8)');
  assert.deepEqual(document.money, {incomplete: false, totals: [], unavailable: []});
  const exported = journal.exportRows = {eventSeqs: document.events.map(event => event.eventSeq), intervalIds: document.intervals.map(interval => interval.id),
    sampleIds: document.samples.map(sample => sample.id), bounds: document.bounds};
  assert.deepEqual(document.events.map(event => [event.eventSeq, event.type, event.attribution?.kind ?? null]), EXPORT_EVENTS, 'The exported events differ from the window');
  assert.equal(new Set(exported.eventSeqs).size, exported.eventSeqs.length, 'The export repeats an eventSeq');
  assert.ok(document.events.every(event => event.attribution === null || event.attribution.tripUuid === trip), 'An exported event is attributed to another trip');
  assert.deepEqual(document.intervals.map(interval => [interval.kind, interval.cause]), [['discontinuity', 'opened-at-load'], ['not-connected', 'consumer-restart']]);
  assert.equal(document.samples.length, journal.sampleCount, 'The export holds another number of samples than the journal showed');

  // Reconciliation with the stored rows (recording-database.cjs). Stable identifiers first.
  const storedTrip = raw.trips[0], tripIntervals = raw.intervals.filter(interval => interval.trip === trip), tripSamples = raw.sampleRows.filter(sample => sample.trip === trip);
  const stored = journal.storedRows = {tripUuid: storedTrip.tripUuid, pluginSessionId: storedTrip.session, databaseUuid: raw.databaseUuid,
    eventSeqs: raw.events.map(event => key(event.eventSeq)).filter(eventSeq => BigInt(eventSeq) >= 3n && BigInt(eventSeq) <= 8n),
    intervalIds: tripIntervals.map(interval => interval.id), sampleIds: tripSamples.map(sample => sample.id)};
  journal.exportIds = {tripUuid: document.trip.tripUuid, pluginSessionId: document.trip.pluginSessionId, databaseUuid: document.header.database.uuid};
  assert.equal(raw.trips.length, 1);
  assert.deepEqual(journal.exportIds, {tripUuid: stored.tripUuid, pluginSessionId: stored.pluginSessionId, databaseUuid: stored.databaseUuid}, 'The export names another trip, session or database');
  assert.match(stored.databaseUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  // Events: the stored rows of the window, each once, with their types and UTC labels.
  assert.deepEqual(exported.eventSeqs, stored.eventSeqs, 'The exported eventSeqs differ from the stored window');
  const storedEvents = raw.events.filter(event => stored.eventSeqs.includes(key(event.eventSeq))).map(event => [key(event.eventSeq), event.type, Number(event.utcMs)]);
  assert.deepEqual(document.events.map(event => [event.eventSeq, event.type, event.occurred.utcUnixMs.available ? Number(event.occurred.utcUnixMs.value) : null]), storedEvents);
  const attributed = raw.attributions.filter(row => stored.eventSeqs.includes(key(row.eventSeq))).map(row => [key(row.eventSeq), row.attribution, row.trip]);
  assert.deepEqual(document.events.filter(event => event.attribution !== null).map(event => [event.eventSeq, event.attribution.kind, event.attribution.tripUuid]), attributed);
  // Completeness intervals: the trip's stored rows with their ids, in insertion order.
  const intervalRow = i => ({id: i.id, kind: i.kind, startUtcMs: i.startUtcMs === null ? null : Number(i.startUtcMs), endUtcMs: i.endUtcMs === null ? null : Number(i.endUtcMs),
    startMonotonicNs: key(i.startMonotonicNs), endMonotonicNs: key(i.endMonotonicNs), sourceClockId: i.sourceClockId, firstEventSeq: key(i.firstEventSeq),
    lastEventSeq: key(i.lastEventSeq), detail: typeof i.detail === 'string' ? JSON.parse(i.detail) : i.detail});
  assert.deepEqual(document.intervals.map(intervalRow), tripIntervals.map(intervalRow), 'The exported intervals differ from the stored rows');
  // Samples: the trip's stored rows with their ids, monotonic time, UTC label, speed and odometer.
  const storedValue = value => value === null ? {available: false, reason: 'not-observed'} : {available: true, value};
  assert.deepEqual(document.samples.map(s => ({id: s.id, monotonicNs: s.monotonicNs, utcMs: s.utcMs, speed: s.speed, odometer: s.odometer})),
    tripSamples.map(s => ({id: s.id, monotonicNs: s.monotonicNs, utcMs: s.utcMs, speed: storedValue(s.speedMps), odometer: storedValue(s.odometerM)})), 'The exported samples differ from the stored rows');
  // Bounds: coverage 13 at the detail read, and the trip's largest stored ids.
  assert.deepEqual(exported.bounds, {committedThroughEventSeq: '13', lastSampleId: stored.sampleIds.at(-1) ?? null, lastIntervalId: stored.intervalIds.at(-1) ?? null, snapshot: false});
  journal.exportReconciled = true;
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
      trailerConfigurationEventSeqs: t.trailerSeqs.map(key), openedEventSeq: key(t.openedSeq),
      // ET-016 PR-7 (J9) columns, compared since ET-016 PR-8: where the job and the opening came from.
      jobSource: t.jobSource, checkpointNextEventSeq: key(t.checkpointSeq), openedBy: t.openedBy, gameMode: {mode: t.mode, method: t.method, confidence: t.confidence},
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
  assert.deepEqual({...files, dataDirectory: null}, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 3, sidecars: [], syntheticBackups: false,
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
    {purpose: 'synthetic', acceptedOrigin: 'synthetic', applicationId: 1163154226, userVersion: 3});
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

  // ET-016 PR-8: the sample count run B's journal showed is the trip's stored count (the optional second-1000 row or
  // none), and the export saved in run B reconciles with the stored rows.
  assert.ok(record.journal, 'Run B did not reach the journal');
  assert.equal(record.journal.sampleCount, actual.sampleRows.filter(sample => sample.trip === 'trip@3').length, 'The journal showed another sample count than was stored');
  record.journal.sampleCountMatch = true;
  await reconcileExport({config, record, raw, session, restartMainEvents});
}
