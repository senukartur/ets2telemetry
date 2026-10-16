import assert from 'node:assert/strict';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile, mkdir, open, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {waitForCurrentTelemetry} from './renderer-observation.mjs';
import {closeDashboard, lifecycleState, until, waitForExit} from './lifecycle-observation.mjs';

// ET-015a PR-4: the recording runtime journey. The service records the synthetic protocol v1 source into
// `<isolated LOCALAPPDATA>\ETS2Telemetry\synthetic\smoke.sqlite` (ETS2TELEMETRY_RECORDING=synthetic:smoke) while the
// reactive simulator serves normal-delivery with a journey transport (JOURNEY_TRANSPORT). A recording proxy between the
// service and the simulator forwards only durable hellos, one admitted connection at a time, and applies the scripted
// ACK policy: connection 1 delivers four ACKs and loses the fifth, so the restarted service receives a redelivery. Every
// ACK it sees is written by the service only after the storage commit (E8), so ACKs are the in-run commit evidence; the
// rows are compared after exit with the hand-written tests/fixtures/recording/normal-delivery-runtime-journey.rows.expected.json.

export const RECORDING_TARGET = 'synthetic:smoke';
export const RECORDING_SCENARIO = 'normal-delivery-runtime-journey';
const READY_TEXT = 'Telemetry service ready; isolated storage probe verified';
const CLIENT_FRAME_BYTES = 4096, SERVER_FRAME_BYTES = 65536;
const PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const durable = Object.freeze({durable: true, commit: 'each', ack: 'each'});
/**
 * normal-delivery's steps are unchanged; its transport becomes three durable connections. The scripted disconnects of
 * connections 2 and 3 end them only when the journey has not ended them first by exiting; either order stores the same
 * rows. They are short because the reactive server paces each wait in real time, also after its client left.
 */
export const JOURNEY_TRANSPORT = Object.freeze([
  {atMs: 0, action: 'connect', client: {durable: true, commit: 'each', ack: 'dropAfter:4'}},
  {atMs: 350, action: 'disconnect'},
  {atMs: 360, action: 'connect', client: durable},
  {atMs: 2000, action: 'disconnect'},
  {atMs: 2010, action: 'connect', client: durable},
  {atMs: 3000, action: 'disconnect'}
]);
const JOURNEY_STEPS = Object.freeze([{atMs: 2100, action: 'lifecycle', event: 'simulation.paused'}]);
/** ACKs the proxy delivers per connection, as JOURNEY_TRANSPORT scripts them; later ones are lost on the way. */
const DELIVERED_ACKS = [4, Infinity, Infinity];

/** A wire uint64 or a stored 20-digit key in canonical decimal form. */
const key = value => value === null || value === undefined ? null : String(value).replace(/^0+(?=.)/, '');
const uuidOf = hex => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
/** The simulator's seeded identifiers (tools/telemetry-simulator/src/v1/source.ts `seededId`). */
const seededId = (seed, label) => uuidOf(createHash('sha256').update(`simulator-v1:${seed}:${label}`).digest('hex'));
/** T4: a trip UUID is derived from its plugin session and its job configuration eventSeq; labelled `trip@<eventSeq>`. */
const tripLabels = session => new Map(Array.from({length: 20}, (_, index) =>
  [uuidOf(createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${index + 1}`, 'utf8').digest('hex')), `trip@${index + 1}`]));

/** Splits length-prefixed frames; `onFrame` gets each whole frame with its decoded JSON payload. */
function frameReader(limit, onFrame) {
  let input = Buffer.alloc(0);
  return bytes => {
    input = Buffer.concat([input, bytes]);
    while (input.length >= 4) {
      const length = input.readUInt32LE(0);
      if (length < 1 || length > limit) throw new Error('Invalid frame length');
      if (input.length < 4 + length) return;
      const frame = input.subarray(0, 4 + length);
      input = input.subarray(4 + length);
      onFrame(frame, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(frame.subarray(4))));
    }
  };
}

/**
 * Starts the reactive simulator (`serve-v1`, the built CLI) on the journey scenario and the recording proxy in front of
 * it. The proxy's endpoint is what the service connects to (ETS2TELEMETRY_SOURCE_PIPE_V1).
 */
export async function startRecordingSource(checkout, output) {
  const base = JSON.parse(await readFile(path.join(checkout, 'tests/fixtures/simulator-v1/normal-delivery.json'), 'utf8'));
  const scenario = {...base, id: RECORDING_SCENARIO,
    purpose: 'Runtime recording journey: normal-delivery through a killed and restarted telemetry service, close-to-tray, a tray exit and an application restart.',
    steps: [...base.steps, ...JOURNEY_STEPS], transport: JOURNEY_TRANSPORT};
  const scenarioFile = path.join(output, 'recording-scenario.json');
  await writeFile(scenarioFile, JSON.stringify(scenario, null, 2) + '\n');
  const simulator = spawn(process.execPath, [path.join(checkout, 'tools/telemetry-simulator/dist/cli.cjs'), 'serve-v1', scenarioFile],
    {cwd: checkout, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
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
  const started = JSON.parse(await Promise.race([announced, new Promise((_, reject) => setTimeout(() => reject(new Error('SIMULATOR_NOT_SERVING_WITHIN_10_SECONDS')), 10000))]));
  assert.deepEqual({origin: started.origin, mode: started.mode, history: started.history}, {origin: 'synthetic', mode: 'reactive', history: false});
  assert.match(started.endpoint, PIPE_PATTERN_V1);

  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  const connections = [], sockets = new Set();
  // The first connection is admitted from the start; the journey admits each later one (`admit`).
  let admissions = 1, attempts = 0, refusedLiveOnly = 0, stopped = false, held, active;
  // Starts the held connection once it is admitted and no other connection is open (the simulator serves one at a time).
  const startHeld = () => {
    if (!held || active || admissions < 1 || stopped) return;
    const {socket, hello} = held; held = undefined;
    if (socket.destroyed) return;
    admissions--;
    const index = connections.length;
    const record = {connection: index + 1, checkpointAckedThrough: null, events: [], gaps: 0, end: null, acks: [], forwardedAcks: [], withheldAcks: [], closedBy: null};
    connections.push(record);
    const upstream = active = net.connect(started.endpoint);
    sockets.add(upstream);
    const finish = by => {record.closedBy ??= by; if (active === upstream) active = undefined; socket.destroy(); upstream.destroy(); startHeld();};
    const observe = frameReader(SERVER_FRAME_BYTES, (_frame, message) => {
      if (message.kind === 'checkpoint') record.checkpointAckedThrough = key(message.data.status.delivery.ackedThroughEventSeq);
      else if (message.kind === 'event') record.events.push({eventSeq: key(message.data.eventSeq), redelivered: message.data.redelivered});
      else if (message.kind === 'gap') record.gaps++;
      else if (message.kind === 'end') record.end = message.data.reason;
    });
    upstream.on('connect', () => upstream.write(hello));
    // Server bytes pass unchanged; a copy is decoded for the record.
    upstream.on('data', bytes => {try {observe(bytes);} catch {record.decodeFailure = true;} socket.write(bytes);});
    upstream.on('end', () => {record.closedBy ??= 'server'; socket.end();});
    upstream.on('close', () => finish('server'));
    upstream.on('error', () => undefined);
    socket.removeAllListeners('data');
    const forward = frameReader(CLIENT_FRAME_BYTES, (frame, message) => {
      if (message.kind !== 'ack') {upstream.write(frame); return;}
      const through = key(message.data.throughEventSeq);
      record.acks.push(through);
      if (record.forwardedAcks.length < DELIVERED_ACKS[index]) {record.forwardedAcks.push(through); upstream.write(frame);}
      else record.withheldAcks.push(through);
    });
    socket.on('data', bytes => {try {forward(bytes);} catch {record.decodeFailure = true; finish('proxy');}});
    socket.on('close', () => finish('client'));
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    if (stopped) {socket.destroy(); return;}
    attempts++;
    // The hello decides: a live-only hello (storage not open yet) is refused, so the simulator only ever serves durable
    // clients as its script expects; a durable one waits for its admission inside the client's 5 s handshake deadline.
    const read = frameReader(CLIENT_FRAME_BYTES, (frame, message) => {
      if (message.kind !== 'hello') {socket.destroy(); return;}
      if (message.data.durableEvents !== true) {refusedLiveOnly++; socket.destroy(); return;}
      if (held) held.socket.destroy();
      held = {socket, hello: frame};
      socket.once('close', () => {if (held?.socket === socket) held = undefined;});
      startHeld();
    });
    socket.on('data', bytes => {try {read(bytes);} catch {socket.destroy();}});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
  const statistics = () => ({attempts, refusedLiveOnly, admissionsPending: admissions, held: Boolean(held), connections: structuredClone(connections)});
  return {
    endpoint, scenario: RECORDING_SCENARIO, seed: scenario.seed, simulatorEndpoint: started.endpoint,
    /** Lets the next durable connection through. */
    admit: () => {admissions++; startHeld();},
    statistics,
    /** Polls the proxy's record until `accept` holds; a liveness bound only. */
    waitFor: (accept, message, timeoutMs) => until(async () => statistics(), accept, message, timeoutMs),
    /**
     * Closes the proxy, then waits for the simulator to finish its script and report. A simulator that does not end in
     * time is terminated and the run has no report.
     */
    stop: async () => {
      if (!stopped) {
        stopped = true; held?.socket.destroy();
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
      }
      let timer;
      const outcome = await Promise.race([exited, new Promise(resolve => {timer = setTimeout(() => resolve(null), 10000);})]);
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

  // 2. A diagnostic service exit; main's supervisor restarts the service, which cold-starts its recorder from seeds.
  assert.equal(await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-service-exit')), true, 'Opt-in diagnostic event unavailable');
  const restarted = await restartedService(application, initial.servicePid);
  record.restartedServicePid = restarted.servicePid;
  record.afterRestart = await waitForCurrentTelemetry(dashboard);
  record.serviceRestartRecovered = true;

  // 3. Close the main window to the tray, then admit the restarted service's durable connection: the redelivery and the
  // rest of the job are recorded while no dashboard exists.
  const afterClose = await closeDashboard(application, dashboard);
  record.afterClose = afterClose;
  assert.equal(launcher.exitCode, null, 'Application exited after closing the dashboard');
  assert.equal(afterClose.servicePid, restarted.servicePid); assert.equal(afterClose.tray, true); assert.equal(afterClose.exiting, false);
  recording.admit();
  const second = (await recording.waitFor(s => s.connections[1]?.forwardedAcks.includes('9'), 'SECOND_CONNECTION_DID_NOT_COMMIT_THE_JOB', 20000)).connections[1];
  record.secondConnection = second;
  assert.equal(second.checkpointAckedThrough, '4');
  assert.deepEqual(second.events, [{eventSeq: '5', redelivered: true}, ...['6', '7', '8', '9'].map(eventSeq => ({eventSeq, redelivered: false}))]);
  assert.deepEqual(second.forwardedAcks, ['5', '6', '7', '8', '9']);
  record.redelivered = second.events.filter(event => event.redelivered).map(event => event.eventSeq);
  record.restartedServiceDurable = await durableActiveRow(events, config.diagnostics, restarted.servicePid);
  const during = await lifecycleState(application);
  record.whileClosed = during;
  assert.equal(during.dashboard, false); assert.equal(during.servicePid, restarted.servicePid); assert.equal(during.exiting, false);
  assert.equal((await mainEvents()).filter(row => row.event === 'SERVICE_EXIT').length, 1, 'Only the terminated service may have exited');
  record.dashboardClosedRecordingContinued = true;

  // 4. Explicit exit from the tray: the service's ordered stop runs `recording-flush`, then closes the database.
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

/** Run B: the same profile and LOCALAPPDATA start again; the third connection appends to the same database. */
export async function verifyRecordingRestart({application, record, rendererPages, recording, events, config}) {
  const {dashboard} = await rendererPages(application);
  await dashboard.getByText(READY_TEXT, {exact: true}).waitFor({state: 'visible', timeout: 10000});
  record.restart = {ready: await waitForCurrentTelemetry(dashboard)};
  const state = await lifecycleState(application);
  record.restart.servicePid = state.servicePid;
  assert.ok(Number.isSafeInteger(state.servicePid) && state.servicePid !== record.servicePid && state.servicePid !== record.restartedServicePid, 'Run B reused a service');
  // Run A has exited, so no earlier service can take this admission.
  recording.admit();
  const third = (await recording.waitFor(s => s.connections[2]?.forwardedAcks.includes('10'), 'THIRD_CONNECTION_DID_NOT_COMMIT', 20000)).connections[2];
  record.thirdConnection = third;
  assert.equal(third.checkpointAckedThrough, '9');
  assert.deepEqual(third.events, [{eventSeq: '10', redelivered: false}]); assert.deepEqual(third.forwardedAcks, ['10']);
  record.restart.durable = await durableActiveRow(events, config.diagnosticsRestart, state.servicePid);
  record.restartRecovered = true;
}

const FAILURE_EVENTS = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
const RECORDING_FAILURES = new Set(['V1_DURABLE_RETRY', 'V1_DURABLE_UNAVAILABLE', 'V1_DURABLE_ACK_AHEAD', 'V1_DURABLE_RESTORE_LOSS', 'V1_EVENT_CONFLICT',
  'RECORDING_TARGET_REJECTED', 'HISTORY_STORAGE_UNAVAILABLE']);
/** Recording diagnostics of one run's service processes: target, openings, the flush step and no durable failure. */
function verifyServiceRecording(service, created) {
  assert.deepEqual(service.filter(row => row.event === 'RECORDING_TARGET').map(row => row.facts), created.map(() => ({purpose: 'synthetic'})));
  assert.deepEqual(service.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts.created), created);
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'recording-flush').map(row => row.facts.outcome), ['ok']);
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'history-storage').map(row => row.facts.outcome), ['ok']);
  assert.equal(service.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length, 1);
  assert.deepEqual(service.filter(row => RECORDING_FAILURES.has(row.event)).map(row => row.event), []);
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
      observedDistanceM: t.distanceState === 'available' ? {available: true, value: t.distance} : {available: false, reason: t.distanceState}})),
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
    gaps: raw.gaps, samples: raw.samples, coverage: {committedThroughEventSeq: key(raw.sessions[0]?.committedThrough)}
  };
}

/**
 * After both runs: the diagnostics of both runs, the simulator's report and the synthetic database, which must hold the
 * hand-written rows, while no history database was created and no WAL or shared-memory file is left.
 */
export async function verifyRecordingRun({config, record, recording, mainEvents, serviceEvents, restartMainEvents, restartServiceEvents}) {
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
  const simulator = record.simulator = await recording.stop();
  record.proxy = recording.statistics();
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
  assert.deepEqual({...files, dataDirectory: null}, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 1, sidecars: [], syntheticBackups: false,
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
    {purpose: 'synthetic', acceptedOrigin: 'synthetic', applicationId: 1163154226, userVersion: 1});
  assert.deepEqual(record.database.sessions, [{game: 'ets2', origin: 'synthetic', committedThrough: '10', endReason: null, simulatorSession: true}]);
  assert.ok(raw.events.every(event => event.session === session) && raw.trips.every(trip => trip.session === session && trip.game === 'ets2'));
  const actual = record.database.rows = rowsOf(raw, session);
  const expected = JSON.parse(await readFile(path.join(config.checkout, 'tests/fixtures/recording', `${RECORDING_SCENARIO}.rows.expected.json`), 'utf8'));
  for (const name of ['trips', 'attributions', 'intervals', 'events', 'gaps', 'samples', 'coverage']) assert.deepEqual(actual[name], expected[name], `Stored ${name} differ from the expectation`);
  // Each event once, and coverage at least every ACK the simulator received.
  assert.equal(new Set(actual.events.map(event => event.eventSeq)).size, actual.events.length);
  const acknowledged = record.proxy.connections.flatMap(c => c.forwardedAcks).reduce((max, through) => BigInt(through) > max ? BigInt(through) : max, 0n);
  record.database.acknowledgedThrough = acknowledged.toString();
  assert.ok(BigInt(actual.coverage.committedThroughEventSeq) >= acknowledged);
  record.databaseRowsMatch = true;
}
