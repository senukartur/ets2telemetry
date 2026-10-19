import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {appendFile, copyFile, mkdir, open, readFile, stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {waitForCurrentTelemetry} from './renderer-observation.mjs';
import {lifecycleState, until} from './lifecycle-observation.mjs';
import {processKind} from './launch-evidence.mjs';
import {checkHistoryInvariants, formatViolations} from './history-invariants.mjs';
import {
  checkTail, compactSoakLogs, databaseGrowth, journalPageSizes, listDifferences, logBudget, seriesSummary, SOAK_FAILURE_EVENTS, SOAK_RECORDING_FAILURES, soakExpectation, soakSessionId,
  summarizeSoakMetrics, tripUuidOf
} from './soak-evidence.mjs';

// ET-019 PR-12b: the packaged application soak (scenario `soak`, docs/ci.md#et-019-recording-soak-workflow-dispatch-only).
// The application records the protocol v1 simulator's soak source (`serve-v1-soak --minutes <M>`, docs/simulator-v1.md)
// into `<isolated LOCALAPPDATA>\ETS2Telemetry\synthetic\soak.sqlite` (ETS2TELEMETRY_RECORDING=synthetic:soak) for M
// minutes of cycles, beside the v0 live smoke source of the other journeys. The driver spawns the source itself with a
// stdin pipe: BoundedProcess gives the Job's root process a NUL stdin, and only a `stop` line ends the source with its
// summary. The service connects to the source directly; the source refuses and counts live-only hellos while storage
// opens (`refusedLiveOnly`, R10).
//
// Every 30 s the driver probes the running application: Electron's per-process memory by kind, the main and renderer
// round trips, the recording state, the database and WAL sizes and the source's latest progress line. Once every cycle is
// served and acknowledged it checks the recording state and reads every journal page through the bridge, then stops the
// source 10 s into its tail and exits the application at once, so the exit's recording-flush writes the pending samples.
// After the exit the stored rows must equal the hand-written expectation (soak-evidence.mjs) and hold the history
// invariants. Memory, database growth and the log budget's projection are recorded, never gated (ET-019 plan decision D3).

export const SOAK_TARGET = 'synthetic:soak';
const PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The probe interval of the series. */
export const SOAK_PROBE_INTERVAL_MS = 30_000;
/** The source is stopped once its progress reaches this far into the 300 s tail. */
export const SOAK_TAIL_STOP_MS = 10_000;
/**
 * The driver's bound beyond the planned M minutes for the source to reach the stop point, so that a stalled run still
 * writes its receipt inside the Job's (M × 60 + 300) s. Scenario time runs ahead of wall time by about 3 s per reconnect
 * cycle and stands still only while a scripted connect waits for the service (docs/simulator-v1.md, drift).
 */
export const SOAK_SLACK_MS = 150_000;
/** The tail must hold at least this many contiguous samples: the source is stopped at least 10 s into it. */
const TAIL_MINIMUM_SECONDS = 10;
/** One probe's reads, each bounded so that a hung process fails the run instead of the Job. */
const PROBE_TIMEOUT_MS = 10_000;
const FAILURE_EVENTS = SOAK_FAILURE_EVENTS;
const RECORDING_FAILURES = new Set(SOAK_RECORDING_FAILURES);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, message) {
  let timer;
  try {return await Promise.race([promise, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error(message)), PROBE_TIMEOUT_MS);})]);}
  finally {clearTimeout(timer);}
}
const sizeOf = async file => {try {return (await stat(file)).size;} catch {return 0;}};
export const soakDatabasePath = config => path.join(config.localappdata, 'ETS2Telemetry', 'synthetic', 'soak.sqlite');

/**
 * Starts `serve-v1-soak --minutes <M>` (the built simulator CLI) with a stdin pipe and the run's isolated TEMP, APPDATA
 * and LOCALAPPDATA. Every stdout line is kept in `soak-source.jsonl`; the latest progress line is read by the probes.
 */
export async function startSoakSource(config) {
  const minutes = config.soakMinutes, log = path.join(config.output, 'soak-source.jsonl');
  const child = spawn(process.execPath, [path.join(config.checkout, 'tools/telemetry-simulator/dist/cli.cjs'), 'serve-v1-soak', '--minutes', String(minutes)],
    {cwd: config.checkout, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: {...process.env, TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata}});
  const stderr = [];
  let partial = '', latest = null, progressLines = 0, summary = null, invalidLines = 0, exit = null, writing = Promise.resolve();
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {exit = {code, signal}; resolve(exit);}));
  child.stdin.on('error', () => undefined);
  child.stderr.on('data', chunk => {if (stderr.join('').length < 8192) stderr.push(String(chunk));});
  const lines = text => {
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      writing = writing.then(() => appendFile(log, line + '\n')).catch(() => undefined);
      let value;
      try {value = JSON.parse(line);} catch {invalidLines++; continue;}
      if (value.type === 'serving') announce(value);
      else if (value.type === 'progress') {latest = value; progressLines++;}
      else if (value.type === 'summary') summary = value;
      else invalidLines++;
    }
  };
  let announce;
  const announced = new Promise((resolve, reject) => {
    announce = resolve;
    void exited.then(() => reject(new Error(`SOAK_SOURCE_EXITED_BEFORE_SERVING: ${stderr.join('').slice(0, 512)}`)));
  });
  child.stdout.on('data', chunk => {const text = partial + String(chunk), cut = text.lastIndexOf('\n'); partial = text.slice(cut + 1); lines(text.slice(0, cut + 1));});
  // After a timeout the child is terminated and `announced` rejects later; that rejection is expected and handled here.
  announced.catch(() => undefined);
  let timer, serving;
  try {
    serving = await Promise.race([announced, new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('SOAK_SOURCE_NOT_SERVING_WITHIN_10_SECONDS')), 10_000);})]);
    assert.deepEqual({origin: serving.origin, mode: serving.mode, minutes: serving.minutes, history: serving.history}, {origin: 'synthetic', mode: 'soak', minutes, history: false});
    assert.match(serving.endpoint, PIPE_PATTERN_V1);
  } catch (error) {child.kill(); throw error;} finally {clearTimeout(timer);}
  return {
    endpoint: serving.endpoint, minutes,
    latest: () => latest, exit: () => exit,
    /**
     * Writes `stop` and waits up to `waitMs` for the summary and the exit. A source that does not end in time is
     * terminated and the run has no summary.
     */
    stop: async ({waitMs}) => {
      if (!exit) {child.stdin.write('stop\n'); child.stdin.end();}
      let wait;
      const outcome = await Promise.race([exited, new Promise(resolve => {wait = setTimeout(() => resolve(null), waitMs);})]);
      clearTimeout(wait);
      if (!outcome) child.kill();
      if (partial) {lines(partial + '\n'); partial = '';}
      await writing;
      return {exit: outcome, summary: outcome ? summary : null, progressLines, invalidLines, stderr: stderr.join('').slice(0, 2048)};
    }
  };
}

/**
 * The soak while the application runs. `record` receives every observation, including partial evidence when an
 * assertion fails. Returns once the source is stopped; the shared close path then exits the application.
 */
export async function runSoakSmoke({application, dashboard, source, config, record, stopTracing, phase}) {
  const minutes = config.soakMinutes, plannedMs = minutes * 60_000, expected = soakExpectation(minutes), database = soakDatabasePath(config);
  Object.assign(record, {scope: 'isolated synthetic v1 soak source recorded into a synthetic-purpose database; no game, history or OS tray icon', minutes, target: SOAK_TARGET});
  record.initial = await waitForCurrentTelemetry(dashboard);
  // The first seconds are traced like every journey; a trace of the whole soak would grow without bound.
  await stopTracing();
  const series = record.series = [], seriesFile = path.join(config.output, 'soak-series.jsonl');
  const started = performance.now();
  record.startedUtc = new Date().toISOString();
  phase('soak-started');
  const elapsed = () => Math.round(performance.now() - started);
  const probe = async () => {
    const mainStart = performance.now();
    const metrics = await bounded(application.evaluate(({app}) => app.getAppMetrics().map(m => ({type: m.type, name: m.name ?? null, serviceName: m.serviceName ?? null,
      workingSetKiB: m.memory?.workingSetSize ?? null, privateKiB: m.memory?.privateBytes ?? null}))), 'SOAK_MAIN_PROBE_TIMEOUT');
    const mainProbeMs = Math.round(performance.now() - mainStart), rendererStart = performance.now();
    await bounded(dashboard.evaluate(() => globalThis.document.readyState), 'SOAK_RENDERER_PROBE_TIMEOUT');
    const rendererProbeMs = Math.round(performance.now() - rendererStart);
    const health = (await bounded(lifecycleState(application), 'SOAK_STATE_PROBE_TIMEOUT')).health.recording;
    const progress = source.latest();
    const row = {elapsedMs: elapsed(), scenarioMs: progress?.scenarioMs ?? null, lastEventSeq: progress?.lastEventSeq ?? null, ackThrough: progress?.maxAckThroughEventSeq ?? null,
      snapshots: progress?.snapshots ?? null, connections: progress?.connections ?? null, refusedLiveOnly: progress?.refusedLiveOnly ?? null, sourceHeapBytes: progress?.heapUsedBytes ?? null,
      mainProbeMs, rendererProbeMs, recording: health.state, recordingCode: health.code ?? null, databaseBytes: await sizeOf(database), walBytes: await sizeOf(`${database}-wal`),
      kinds: summarizeSoakMetrics(metrics, processKind)};
    series.push(row);
    await appendFile(seriesFile, JSON.stringify(row) + '\n');
    return row;
  };
  // Probes every 30 s until the source's progress reaches `atMs` (and, with `acked`, every event is acknowledged).
  let nextProbe = 0;
  const runUntil = async (atMs, acked, message) => {
    for (;;) {
      if (source.exit()) throw new Error(`SOAK_SOURCE_EXITED ${JSON.stringify(source.exit())}`);
      if (elapsed() >= nextProbe) {await probe(); nextProbe += SOAK_PROBE_INTERVAL_MS;}
      const progress = source.latest();
      if (progress && progress.scenarioMs >= atMs && (!acked || progress.maxAckThroughEventSeq === expected.coverage)) return progress;
      if (elapsed() > plannedMs + SOAK_SLACK_MS) throw new Error(`${message} within ${plannedMs + SOAK_SLACK_MS} ms`);
      await sleep(250);
    }
  };

  // 1. Every cycle served and acknowledged: the source is in its tail with the last eventSeq acknowledged.
  record.tailReached = await runUntil(plannedMs, true, 'SOAK_TAIL_NOT_REACHED');
  record.tailReachedMs = elapsed();
  phase('soak-tail-reached');
  // G6: one not-connected interval per reconnection and nothing else lost. G2: `trip` describes the game of the latest v1
  // observation, which is idle in the trip-free tail: no open trip and no untracked job.
  // Each read is bounded like a probe's, so one hung evaluation cannot hold the run until the Job's deadline.
  const health = await until(async () => (await bounded(lifecycleState(application), 'SOAK_STATE_PROBE_TIMEOUT')).health.recording, value => value.state === 'recording',
    'SOAK_NOT_RECORDING_IN_THE_TAIL');
  record.recordingAtTail = health;
  assert.deepEqual(health, {state: 'recording', target: 'synthetic', code: null, losses: expected.losses, trip: {phase: 'idle', completeness: null, untrackedJob: false}}, 'The recording status in the tail differs from the expectation');
  record.recordingStatusMatch = true;
  // 2. The journal through the bridge: every page of the trip list, newest first. A page carries a next cursor exactly when
  // it is full (the trip-page contract), so a multiple of 50 trips ends in an empty page.
  record.journal = await bounded(dashboard.evaluate(async () => {
    const pages = [];
    let cursor, database = null;
    for (let page = 0; page < 10; page++) {
      let answer;
      for (let attempt = 0; attempt < 50; attempt++) {
        answer = await globalThis.desktop.listJournalTrips(cursor === undefined ? {} : {cursor});
        if (answer.ok || answer.code !== 'DATABASE_OPENING') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!answer.ok) return {error: answer.code, database, pages};
      database = answer.value.database;
      pages.push(answer.value.trips.map(trip => ({tripUuid: trip.tripUuid, outcome: trip.outcome, recordingCompleteness: trip.recordingCompleteness, closeReason: trip.closeReason,
        startedUtcMs: trip.startedUtcMs, endedUtcMs: trip.endedUtcMs})));
      cursor = answer.value.nextCursor;
      if (cursor === null) return {error: null, database, pages};
    }
    return {error: 'TOO_MANY_PAGES', database, pages};
  }), 'SOAK_JOURNAL_READ_TIMEOUT');
  const session = soakSessionId();
  const trips = [...expected.trips].reverse().map(trip => ({tripUuid: tripUuidOf(session, trip.openedEventSeq), outcome: trip.outcome, recordingCompleteness: trip.recordingCompleteness,
    closeReason: 'outcome', startedUtcMs: trip.startedUtcMs, endedUtcMs: trip.endedUtcMs}));
  const pages = [];
  for (const size of journalPageSizes(trips.length)) pages.push(trips.slice(pages.length * 50, pages.length * 50 + size));
  assert.deepEqual(record.journal, {error: null, database: {purpose: 'synthetic', schemaVersion: 2}, pages}, 'The journal pages differ from the expectation');
  record.journal = {pages: pages.map(page => page.length), database: record.journal.database};
  record.journalMatch = true;
  phase('soak-journal-read');
  // 3. The stop, 10 s into the tail; the shared close path exits the application right after it.
  await runUntil(plannedMs + SOAK_TAIL_STOP_MS, true, 'SOAK_STOP_POINT_NOT_REACHED');
  await probe();
  record.stopRequestedMs = elapsed();
  record.stoppedUtc = new Date().toISOString();
  record.source = await source.stop({waitMs: 15_000});
  assert.ok(record.source.summary, 'SOAK_SOURCE_SUMMARY_MISSING');
  record.sourceStopped = true;
  phase('soak-source-stopped');
}

/** The diagnostic log files of one run directory: bytes, records, and the bytes and records written during the soak. */
async function logUse(file, fromUtc, toUtc) {
  const text = await readFile(file, 'utf8'), lines = text.split(/(?<=\n)/).filter(line => line.trim());
  const from = Date.parse(fromUtc), to = Date.parse(toUtc);
  let soakBytes = 0, soakRecords = 0;
  for (const line of lines) {
    const time = Date.parse(JSON.parse(line).time);
    if (time >= from && time <= to) {soakBytes += Buffer.byteLength(line); soakRecords++;}
  }
  return logBudget({bytes: Buffer.byteLength(text), records: lines.length, soakBytes, soakRecords, soakMs: to - from});
}
/**
 * The budget of main's and the service's log (256 KiB and 2,000 records each). A log that reached it may have dropped
 * rows, so the run fails with LOG_BUDGET_REACHED before any check that reads those rows. The projection to 90 minutes is
 * evidence only.
 */
export async function verifySoakLogs({config, record}) {
  const to = record.stoppedUtc ?? new Date().toISOString(), from = record.startedUtc ?? to;
  record.logs = {main: await logUse(path.join(config.diagnostics, 'startup.jsonl'), from, to),
    service: await logUse(path.join(config.diagnostics, 'service', 'startup.jsonl'), from, to)};
  assert.ok(!record.logs.main.reached && !record.logs.service.reached, 'LOG_BUDGET_REACHED');
  record.logBudgetKept = true;
}

/** Reads a copy of the database with the checkout's Electron in Node mode (scripts/ci/soak-database.cjs). */
async function readDatabase(config, database) {
  const directory = path.join(config.output, 'soak-verify'), copy = path.join(directory, 'soak.sqlite');
  await mkdir(directory, {recursive: true});
  await copyFile(database, copy);
  const electron = createRequire(path.join(config.checkout, 'package.json'))('electron');
  const child = spawn(electron, [path.join(config.checkout, 'scripts/ci/soak-database.cjs'), copy], {cwd: config.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ELECTRON_RUN_AS_NODE: '1', TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata}});
  const stdout = [], stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk));
  let timer;
  const exit = await Promise.race([new Promise(resolve => child.once('exit', code => resolve(code))), new Promise(resolve => {timer = setTimeout(() => resolve('timeout'), 30_000);})]);
  clearTimeout(timer);
  if (exit !== 0) {child.kill(); throw new Error(`DATABASE_READER_FAILED ${exit}: ${Buffer.concat(stderr).toString().slice(0, 512)}`);}
  return JSON.parse(Buffer.concat(stdout).toString());
}

/**
 * After the exit: the service's recording diagnostics, the source's summary, the database files and rows against the
 * hand-written expectation, the history invariants, and the recorded evidence (series, trend, growth).
 */
export async function verifySoakRun({config, record, mainEvents, serviceEvents}) {
  const minutes = config.soakMinutes, expected = soakExpectation(minutes), session = soakSessionId();
  // Diagnostics: one service, recording into the synthetic target and stopping in order; an explicit application quit.
  assert.deepEqual(serviceEvents.filter(row => row.event === 'RECORDING_TARGET').map(row => row.facts), [{purpose: 'synthetic'}]);
  assert.deepEqual(serviceEvents.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts.created), [true]);
  for (const name of ['recording-flush', 'history-storage']) assert.deepEqual(serviceEvents.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === name).map(row => row.facts.outcome), ['ok']);
  assert.equal(serviceEvents.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length, 1);
  assert.deepEqual(serviceEvents.filter(row => RECORDING_FAILURES.has(row.event)).map(row => row.event), []);
  const steps = serviceEvents.filter(row => row.event === 'SHUTDOWN_STEP');
  assert.ok(steps.length >= 6 && steps.every(row => row.facts?.outcome === 'ok'), 'Every service shutdown step must finish cleanly');
  assert.deepEqual(serviceEvents.filter(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped').map(row => row.detail), [{type: 'stopped', clean: true}]);
  assert.deepEqual(mainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['app-quit']);
  assert.ok(![...mainEvents, ...serviceEvents].some(row => FAILURE_EVENTS.test(row.event)));
  // H11: the exit flush writes what is pending, unless the 5 s flush already wrote it; recorded, and checked when present.
  record.sampleExits = serviceEvents.filter(row => row.event === 'V1_SAMPLES_EXIT').map(row => row.facts);
  assert.ok(record.sampleExits.length <= 1 && record.sampleExits.every(facts => facts.losses === 0 && facts.code === 'WRITTEN' && facts.rows >= 1),
    `Unexpected sample exit ${JSON.stringify(record.sampleExits)}`);
  record.shutdownClean = true;

  // The source: stopped in its tail with exactly the scheduled events acknowledged, closed as planned.
  const source = record.source;
  assert.ok(source?.summary, 'SOAK_SOURCE_SUMMARY_MISSING');
  assert.deepEqual(source.exit, {code: 0, signal: null});
  const s = source.summary;
  record.sourceFacts = {cancelled: s.cancelled, scenarioMs: s.scenarioMs, lastEventSeq: s.lastEventSeq, maxAckThroughEventSeq: s.maxAckThroughEventSeq, ackCount: s.ackCount,
    snapshots: s.snapshots, connections: s.connections, refusedLiveOnly: s.refusedLiveOnly, refusedClients: s.refusedClients, events: s.messages?.server?.event ?? 0,
    gaps: s.messages?.server?.gap ?? 0, ends: s.messages?.server?.end ?? 0, closes: (s.sessions ?? []).map(c => c.closedBy), heapUsedBytes: s.heapUsedBytes, progressLines: source.progressLines,
    invalidLines: source.invalidLines};
  delete record.source.summary.sessions;
  assert.deepEqual({cancelled: s.cancelled, minutes: s.minutes, mode: s.mode, history: s.history, lastEventSeq: s.lastEventSeq, maxAckThroughEventSeq: s.maxAckThroughEventSeq,
    events: record.sourceFacts.events, gaps: record.sourceFacts.gaps, ends: record.sourceFacts.ends, connections: s.connections, closes: record.sourceFacts.closes},
  {cancelled: true, minutes, mode: 'soak', history: false, lastEventSeq: expected.coverage, maxAckThroughEventSeq: expected.coverage, events: expected.counts.events, gaps: 0, ends: 1,
    connections: expected.connections, closes: expected.closes}, 'The soak source summary differs from the schedule');
  assert.ok(s.scenarioMs >= minutes * 60_000 + SOAK_TAIL_STOP_MS, 'The source was not stopped in its tail');
  record.sourceMatch = true;

  // Files: the synthetic database only, closed cleanly; no history database.
  const root = path.join(config.localappdata, 'ETS2Telemetry'), database = soakDatabasePath(config);
  const header = Buffer.alloc(100), file = await open(database, 'r');
  try {await file.read(header, 0, 100, 0);} finally {await file.close();}
  const files = record.files = {magic: header.subarray(0, 15).toString('latin1'), applicationId: header.readInt32BE(68), userVersion: header.readUInt32BE(60),
    sidecars: ['-wal', '-shm', '-journal'].filter(suffix => existsSync(database + suffix)), syntheticBackups: existsSync(path.join(root, 'synthetic', 'backups')),
    historyDatabase: existsSync(path.join(root, 'data', 'telemetry.sqlite'))};
  assert.deepEqual(files, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 2, sidecars: [], syntheticBackups: false, historyDatabase: false});
  record.historyDatabaseAbsent = true; record.sidecarsAbsent = true;

  // Rows against the hand-written expectation; trips as `trip@<job eventSeq>`.
  const raw = await readDatabase(config, database);
  const labels = new Map(expected.trips.map(trip => [tripUuidOf(session, trip.openedEventSeq), trip.trip]));
  const labelOf = uuid => uuid === null ? null : labels.get(uuid) ?? uuid;
  const samples = raw.samples.map(m => ({second: (BigInt(m.monotonicNs) / 1_000_000_000n).toString(), trip: labelOf(m.tripUuid), monotonicNs: m.monotonicNs, utcMs: m.utcMs,
    speedMps: m.speedMps, odometerM: m.odometerM}));
  const cycle = samples.filter(m => Number(m.second) < expected.tailFromSecond), tail = samples.filter(m => Number(m.second) >= expected.tailFromSecond);
  const actual = {
    events: raw.events.map(e => ({eventSeq: e.eventSeq, type: e.type, utcMs: e.utcMs})),
    trips: raw.trips.map(t => ({trip: labelOf(t.tripUuid), openedBy: t.openedBy, openedEventSeq: t.openedEventSeq, jobConfigurationEventSeq: t.jobConfigurationEventSeq,
      truckConfigurationEventSeq: t.truckConfigurationEventSeq, trailerConfigurationEventSeqs: t.trailerConfigurationEventSeqs, outcome: t.outcome, outcomeEventSeq: t.outcomeEventSeq,
      closeReason: t.closeReason, recordingCompleteness: t.recordingCompleteness, startedUtcMs: t.startedUtcMs, endedUtcMs: t.endedUtcMs, observedDistanceM: t.observedDistanceM,
      fuelUsedL: t.fuelUsedL})),
    attributions: raw.attributions.map(a => ({eventSeq: a.eventSeq, trip: labelOf(a.tripUuid), attribution: a.attribution})),
    intervals: raw.intervals.map(i => ({trip: labelOf(i.tripUuid), kind: i.kind, detail: i.detail}))
  };
  const tailCheck = checkTail(tail, {fromSecond: expected.tailFromSecond, stopScenarioMs: s.scenarioMs, minimumSeconds: TAIL_MINIMUM_SECONDS});
  const differences = [
    ...listDifferences('events', actual.events, expected.events), ...listDifferences('trips', actual.trips, expected.trips),
    ...listDifferences('attributions', actual.attributions, expected.attributions), ...listDifferences('intervals', actual.intervals, expected.intervals),
    ...listDifferences('cycle samples', cycle, expected.cycleSamples), ...tailCheck.problems];
  const sessions = raw.sessions.map(row => ({pluginSessionId: row.pluginSessionId === session ? 'simulator' : row.pluginSessionId, game: row.game, origin: row.origin,
    committedThroughEventSeq: row.committedThroughEventSeq}));
  if (!(JSON.stringify(sessions) === JSON.stringify([{pluginSessionId: 'simulator', game: 'ets2', origin: 'synthetic', committedThroughEventSeq: expected.coverage}]))) differences.push(`sessions ${JSON.stringify(sessions)}`);
  if (raw.gaps.length !== 0) differences.push(`${raw.gaps.length} gap rows, expected 0`);
  if (raw.events.some(e => e.firstRedelivered || e.pluginSessionId !== session)) differences.push('an event was redelivered or belongs to another session');
  if (new Set(raw.samples.map(m => `${m.pluginSessionId}#${m.sourceClockId}`)).size > 1) differences.push('samples of more than one session or clock');
  const violations = checkHistoryInvariants(raw, [{pluginSessionId: session, throughEventSeq: s.maxAckThroughEventSeq}]);
  record.database = {integrity: raw.integrity, foreignKeyViolations: raw.foreignKeys.length, purpose: raw.purpose, acceptedOrigin: raw.acceptedOrigin, applicationId: raw.applicationId,
    userVersion: raw.userVersion, journalMode: raw.journalMode, sessions, endReason: raw.sessions[0]?.endReason ?? null,
    counts: {events: raw.events.length, trips: raw.trips.length, cancelled: raw.trips.filter(t => t.outcome === 'cancelled').length,
      partial: raw.trips.filter(t => t.recordingCompleteness === 'partial').length, attributions: raw.attributions.length, intervals: raw.intervals.length,
      cycleSamples: cycle.length, tailSamples: tail.length, gaps: raw.gaps.length},
    expectedCounts: expected.counts, tail: tailCheck, differences: differences.slice(0, 20), violations: violations.length};
  assert.deepEqual({integrity: raw.integrity, foreignKeys: raw.foreignKeys.length, purpose: raw.purpose, acceptedOrigin: raw.acceptedOrigin},
    {integrity: 'ok', foreignKeys: 0, purpose: 'synthetic', acceptedOrigin: 'synthetic'});
  assert.deepEqual(differences, [], `The stored rows differ from the expectation:\n${differences.slice(0, 20).join('\n')}`);
  record.rowsMatch = true;
  assert.deepEqual(violations, [], `History invariants violated:\n${formatViolations(violations.slice(0, 5))}`);
  record.invariantsHold = true;

  // Evidence only (D3): the series per process kind and its trend, the database size per sample-hour and the WAL peak.
  record.seriesSummary = seriesSummary(record.series ?? [], {plannedMs: minutes * 60_000});
  record.growth = {...databaseGrowth({databaseBytes: (await stat(database)).size, samples: raw.samples.length}),
    walPeakBytes: Math.max(0, ...(record.series ?? []).map(row => row.walBytes))};
}

/** A soak receipt keeps the rows its checks name and the first failure rows of each log (soak-evidence.mjs, compactSoakLogs). */
export const compactSoakEvents = compactSoakLogs;
