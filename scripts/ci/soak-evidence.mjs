import {createHash} from 'node:crypto';

// ET-019 PR-12b: the packaged application soak's oracle and evidence, as pure functions over plain values. The driver
// (soak-observation.mjs) compares the stored rows with soakExpectation(minutes); tests/unit/soak-evidence.test.ts pins
// the closed forms with literal values for one, three and thirty minutes. Nothing here launches a process or reads a file.
//
// Every expected value is written from the documents, never read back from the code under test:
// - the schedule: docs/simulator-v1.md, "Soak source (ET-019 PR-12a)" (its table, the frame values, "Clocks, identities
//   and ordering": source time 10^12 ns + atMs × 10^6 and UTC 1.8 × 10^12 ms + atMs);
// - event types: protocol v1 §6 as the simulator maps them (a truck and a `trailer.0` configuration are `truck.configured`
//   and `trailer.configured`, an empty job configuration is `job.cleared`);
// - trips, attributions and completeness: docs/trips.md, "States and transitions", "Attribution (T14)", "Identity" (T4),
//   "What complete means (T13)" and "Readings accounting (T16, T17)";
// - samples: docs/trips.md, "One-second sampler" (H3 tick, H4 decisions: the first reading of the plugin session is a
//   baseline, a paused reading is `not-running`, a reconnection's checkpoint of the same recorder is a reading like any
//   other) and the trip reference rule (R17, H7);
// - the recording losses: docs/telemetry-service-v1.md, "Losses (G6)".
//
// Memory, database growth and the log budget are evidence only (ET-019 plan decision D3, measure, then gate): nothing
// here turns them into a pass condition, except that a log that reached its budget has lost rows (LOG_BUDGET_REACHED).

/** The documented schedule, encoded independently of tools/telemetry-simulator/src/v1/soak.ts. */
export const SOAK_SCHEDULE = Object.freeze({
  seed: 'soak-v1', frameMs: 50, cycleMs: 60_000, tailMs: 300_000, startAtMs: 25,
  offsets: Object.freeze({job: 25, toll: 5_025, paused: 20_025, started: 30_025, disconnect: 35_025, reconnect: 38_025, outcome: 45_025, cleared: 45_525}),
  reconnect: Object.freeze({every: 10, at: 1}), cancel: Object.freeze({every: 4, at: 2})
});
const SOURCE_BASE_NS = 1_000_000_000_000n;
const UTC_BASE_MS = 1_800_000_000_000;
/** Frame n carries speed 19.53125 m/s, odometer 1,000 + n / 1,024 km and fuel 400 − n / 4,096 L. */
const SPEED_MPS = 19.53125;
const METERS_PER_FRAME = 1000 / 1024;
const LITERS_PER_FRAME = 1 / 4096;
/** docs/storage.md, "Measured size": 53,436,416 bytes per 100 hours of 1 Hz history, and the planning allowance. */
export const MEASURED_BYTES_PER_SAMPLE_HOUR = 534_364;
export const ALLOWANCE_BYTES_PER_SAMPLE_HOUR = 1_000_000;
/** docs/app-lifecycle.md: each log holds at most 256 KiB and 2,000 records per process. */
export const LOG_BUDGET = Object.freeze({bytes: 262_144, records: 2_000, marginBytes: 8_192});
/** The leak trend's warm-up: the larger of five minutes and a fifth of the planned run; fewer than six points give no slope. */
export const LEAK_WARM_UP_MIN_MS = 300_000;
export const LEAK_WARM_UP_FRACTION = 0.2;
export const LEAK_MIN_POINTS = 6;

const uuidOf = hex => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
/** The simulator's seeded identifiers (docs/simulator-v1.md, "Clocks, identities and ordering"). */
export const soakSessionId = () => uuidOf(sha256(`simulator-v1:${SOAK_SCHEDULE.seed}:plugin-session`));
/** T4: a trip UUID from its plugin session and the eventSeq of its job configuration. */
export const tripUuidOf = (session, eventSeq) => uuidOf(sha256(`ets2telemetry-trip-v1:${session}:${eventSeq}`));

const isReconnect = k => k % SOAK_SCHEDULE.reconnect.every === SOAK_SCHEDULE.reconnect.at;
const isCancel = k => k % SOAK_SCHEDULE.cancel.every === SOAK_SCHEDULE.cancel.at;
const minutesOf = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 90) throw new Error('Soak minutes must be an integer 1..90');
  return value;
};
/** The number of reconnect cycles k < M with k % 10 = 1: ⌊(M + 8) / 10⌋. */
export const reconnectCycles = minutes => Math.floor((minutesOf(minutes) + 8) / 10);
const label = eventSeq => `trip@${eventSeq}`;
const odometerAt = atMs => 1_000_000 + (atMs / SOAK_SCHEDULE.frameMs) * METERS_PER_FRAME;

/**
 * The stored history a soak of `minutes` must leave, up to its tail. Trips are labelled `trip@<job eventSeq>`; the
 * caller maps labels to T4 UUIDs. The tail's samples depend on when the driver stopped the source and are checked by
 * checkTail instead.
 */
export function soakExpectation(minutes) {
  const m = minutesOf(minutes), o = SOAK_SCHEDULE.offsets;
  const events = [], trips = [], attributions = [], intervals = [], cycleSamples = [];
  const event = (eventSeq, type, atMs) => events.push({eventSeq: String(eventSeq), type, utcMs: UTC_BASE_MS + atMs});
  event(1, 'simulation.started', SOAK_SCHEDULE.startAtMs); event(2, 'truck.configured', SOAK_SCHEDULE.startAtMs); event(3, 'trailer.configured', SOAK_SCHEDULE.startAtMs);
  // A sample's time is its message's capture time, its UTC label that of the frame that published the state
  // (docs/telemetry-service-v1.md, one-second samples). The 50 ms snapshot interval starts at each connection's checkpoint
  // (docs/simulator-v1.md, "Clocks, identities and ordering"): the first connection's checkpoint is at 0, so a frame's
  // snapshot leaves at the frame's own time; a reconnection's checkpoint is at b + 38,025, so from then on each snapshot
  // leaves 25 ms after its frame, and the checkpoint itself 25 ms after the frame it carries.
  let messageDelayMs = 0;
  for (let k = 0; k < m; k++) {
    const b = k * SOAK_SCHEDULE.cycleMs, e = 3 + 6 * k, trip = label(e + 1), reconnect = isReconnect(k);
    event(e + 1, 'job.configured', b + o.job); event(e + 2, 'player.tollgate.paid', b + o.toll); event(e + 3, 'simulation.paused', b + o.paused);
    event(e + 4, 'simulation.started', b + o.started); event(e + 5, isCancel(k) ? 'job.cancelled' : 'job.delivered', b + o.outcome); event(e + 6, 'job.cleared', b + o.cleared);
    // Readings accounting (T16): steps count only while the trip is active at both readings, from the first reading after
    // the opening (frame b + 50) to the last before the outcome (frame b + 45,000). A reconnection drops the last reading,
    // so the steps across the offline window (frames b + 35,000 to b + 38,000) count nothing.
    const steps = reconnect ? (35_000 - 50) / 50 + (45_000 - 38_000) / 50 : (45_000 - 50) / 50;
    trips.push({trip, openedBy: 'event', openedEventSeq: String(e + 1), jobConfigurationEventSeq: String(e + 1), truckConfigurationEventSeq: '2', trailerConfigurationEventSeqs: ['3'],
      outcome: isCancel(k) ? 'cancelled' : 'delivered', outcomeEventSeq: String(e + 5), closeReason: 'outcome', recordingCompleteness: reconnect ? 'partial' : 'complete',
      startedUtcMs: UTC_BASE_MS + b + o.job, endedUtcMs: UTC_BASE_MS + b + o.outcome,
      observedDistanceM: {available: true, value: steps * METERS_PER_FRAME}, fuelUsedL: {available: true, value: steps * LITERS_PER_FRAME}});
    attributions.push({eventSeq: String(e + 2), trip, attribution: 'trip'}, {eventSeq: String(e + 5), trip, attribution: 'trip'});
    // The reconnection's not-connected interval, with the odometer change from the last reading before the disconnection
    // (frame b + 35,000) to the checkpoint of the new connection (frame b + 38,000): 60 frames.
    if (reconnect) intervals.push({trip, kind: 'not-connected', detail: {cause: 'disconnected', odometerDeltaM: 60 * METERS_PER_FRAME}});
    for (let s = 0; s < 60; s++) {
      // Seconds 21..29 have only paused frames; 36 and 37 of a reconnect cycle are offline.
      if ((s >= 21 && s <= 29) || (reconnect && (s === 36 || s === 37))) continue;
      // The first qualifying reading of the second: the checkpoint at 0 is the session's baseline, so second 0 is frame 50;
      // frame b + 30,000 is still paused, so second 30 is frame b + 30,050.
      const atMs = k === 0 && s === 0 ? 50 : s === 30 ? b + 30_050 : b + s * 1000;
      if (reconnect && s === 38) messageDelayMs = 25;
      // R17: only while the trip is active. Frame b + 0 of a later cycle precedes its job configuration at b + 25, and
      // frame b + 45,000 precedes the outcome at b + 45,025 (a snapshot due at an event's time leaves before the event).
      cycleSamples.push({second: String(1000 + 60 * k + s), trip: (k > 0 && s === 0) || s > 45 ? null : trip,
        monotonicNs: (SOURCE_BASE_NS + BigInt(atMs + messageDelayMs) * 1_000_000n).toString(), utcMs: UTC_BASE_MS + atMs, speedMps: SPEED_MPS, odometerM: odometerAt(atMs)});
    }
  }
  const r = reconnectCycles(m), connections = 1 + r;
  return {minutes: m, events, trips, attributions, intervals, cycleSamples, gaps: 0, coverage: String(3 + 6 * m),
    tailFromSecond: 1000 + 60 * m, connections, closes: [...Array(connections - 1).fill('disconnect'), 'end'],
    /** G6: one not-connected interval per reconnection; nothing else is lost. */
    losses: {lostEvents: 0, eventLoss: 0, notConnected: r, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0},
    counts: {events: 3 + 6 * m, trips: m, cancelled: Math.floor((m + 1) / 4), partial: r, attributions: 2 * m, intervals: r, cycleSamples: 51 * m - 2 * r}};
}

/**
 * The tail's sample seconds: contiguous from the tail's first second through the last one the service received. The
 * source stopped at scenario time `stopScenarioMs`; its last delivered frame lies within the last 100 ms before it
 * (a frame is applied at its time, and after a reconnection its snapshot leaves 25 ms later), so the last second is
 * ⌊(stopScenarioMs − 100) / 1000⌋ or ⌊stopScenarioMs / 1000⌋ in source seconds, and at least `minimumSeconds` long.
 */
export function checkTail(samples, {fromSecond, stopScenarioMs, minimumSeconds}) {
  const seconds = samples.map(s => Number(s.second)), problems = [];
  seconds.forEach((second, index) => { if (second !== fromSecond + index) problems.push(`tail second ${second} at position ${index}, expected ${fromSecond + index}`); });
  if (samples.some(s => s.trip !== null)) problems.push('a tail sample names a trip');
  const last = seconds.at(-1) ?? null, lower = 1000 + Math.floor((stopScenarioMs - 100) / 1000), upper = 1000 + Math.floor(stopScenarioMs / 1000);
  if (seconds.length < minimumSeconds) problems.push(`${seconds.length} tail samples, expected at least ${minimumSeconds}`);
  if (last === null || last < lower || last > upper) problems.push(`last tail second ${last}, expected ${lower}..${upper}`);
  return {fromSecond, lastSecond: last, samples: seconds.length, expectedLastSecond: [lower, upper], problems: problems.slice(0, 8)};
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Up to `limit` differences between two row lists, by position: the first rows that differ, extra rows and missing rows. */
export function listDifferences(name, actual, expected, limit = 5) {
  const out = [];
  for (let i = 0; i < Math.max(actual.length, expected.length) && out.length < limit; i++) {
    if (i >= actual.length) out.push(`${name}[${i}] missing: ${JSON.stringify(expected[i])}`);
    else if (i >= expected.length) out.push(`${name}[${i}] unexpected: ${JSON.stringify(actual[i])}`);
    else if (!same(actual[i], expected[i])) out.push(`${name}[${i}] is ${JSON.stringify(actual[i])}, expected ${JSON.stringify(expected[i])}`);
  }
  if (actual.length !== expected.length) out.push(`${name}: ${actual.length} rows, expected ${expected.length}`);
  return out;
}

/** The least-squares line through (hours, bytes): slope in bytes per hour, intercept and r². */
function leastSquares(points) {
  const n = points.length, xs = points.map(p => p.elapsedMs / 3_600_000), ys = points.map(p => p.bytes);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return {slope, intercept: my - slope * mx, r2: syy === 0 ? 1 : sxx === 0 ? 0 : (sxy * sxy) / (sxx * syy)};
}
/**
 * Evidence only: the memory trend of one series after the warm-up (the larger of five minutes and 20% of the planned
 * run). With fewer than six points after it, `TOO_FEW_POINTS`. Otherwise the least-squares slope in bytes per hour, r²
 * and the means of four quarters of the points in time order.
 */
export function leakTrend(points, {plannedMs}) {
  const warmUpMs = Math.max(LEAK_WARM_UP_MIN_MS, Math.round(LEAK_WARM_UP_FRACTION * plannedMs));
  const used = points.filter(p => p.elapsedMs >= warmUpMs && Number.isFinite(p.bytes));
  if (used.length < LEAK_MIN_POINTS) return {status: 'TOO_FEW_POINTS', warmUpMs, points: used.length};
  const {slope, r2} = leastSquares(used);
  const quarter = i => used.slice(Math.floor((i * used.length) / 4), Math.floor(((i + 1) * used.length) / 4));
  const mean = rows => Math.round(rows.reduce((a, p) => a + p.bytes, 0) / rows.length);
  return {status: 'MEASURED', warmUpMs, points: used.length, fromMs: used[0].elapsedMs, toMs: used.at(-1).elapsedMs, slopeBytesPerHour: Math.round(slope),
    r2: Math.round(r2 * 1000) / 1000, quarterMeansBytes: [0, 1, 2, 3].map(i => mean(quarter(i)))};
}

/** Per process kind: first, minimum, maximum and last of the summed private bytes and working sets, and the trend. */
export function seriesSummary(series, {plannedMs}) {
  const kinds = [...new Set(series.flatMap(row => Object.keys(row.kinds ?? {})))].sort();
  const out = {};
  for (const kind of kinds) {
    const rows = series.filter(row => row.kinds?.[kind]);
    const stat = field => {
      const values = rows.map(row => row.kinds[kind][field]).filter(Number.isFinite);
      return values.length ? {first: values[0], min: Math.min(...values), max: Math.max(...values), last: values.at(-1)} : null;
    };
    const processes = rows.map(row => row.kinds[kind].processes);
    out[kind] = {points: rows.length, processes: {min: Math.min(...processes), max: Math.max(...processes)}, privateBytes: stat('privateBytes'),
      workingSetBytes: stat('workingSetBytes'), trend: leakTrend(rows.map(row => ({elapsedMs: row.elapsedMs, bytes: row.kinds[kind].privateBytes})), {plannedMs})};
  }
  return out;
}

/** Electron's process metrics of one probe summed per kind, in bytes (Electron reports KiB). */
export function summarizeSoakMetrics(metrics, kindOf) {
  const kinds = {};
  for (const metric of metrics) {
    const entry = kinds[kindOf(metric)] ??= {processes: 0, workingSetBytes: 0, privateBytes: 0};
    entry.processes++;
    if (Number.isFinite(metric.workingSetKiB)) entry.workingSetBytes += Math.round(metric.workingSetKiB * 1024);
    if (Number.isFinite(metric.privateKiB)) entry.privateBytes += Math.round(metric.privateKiB * 1024);
  }
  return kinds;
}

/**
 * One diagnostic log's use of its budget, and the use projected to `targetMinutes` of soak at the rate of this run:
 * the rows written before the soak plus the soak's rows scaled to the target length. `reached` means a record may have
 * been dropped: 2,000 records, or less than 8 KiB left (the margin diagnostics.ts uses for rotation).
 */
export function logBudget({bytes, records, soakBytes, soakRecords, soakMs}, {targetMinutes = 90} = {}) {
  const scale = soakMs > 0 ? (targetMinutes * 60_000) / soakMs : 0;
  const projectedBytes = Math.round(bytes - soakBytes + soakBytes * scale), projectedRecords = Math.round(records - soakRecords + soakRecords * scale);
  return {bytes, records, budgetBytes: LOG_BUDGET.bytes, budgetRecords: LOG_BUDGET.records, reached: records >= LOG_BUDGET.records || bytes > LOG_BUDGET.bytes - LOG_BUDGET.marginBytes,
    soak: {bytes: soakBytes, records: soakRecords, ms: soakMs},
    projected: {minutes: targetMinutes, bytes: projectedBytes, records: projectedRecords, headroomBytes: LOG_BUDGET.bytes - projectedBytes,
      headroomRecords: LOG_BUDGET.records - projectedRecords, wouldReach: projectedRecords >= LOG_BUDGET.records || projectedBytes > LOG_BUDGET.bytes - LOG_BUDGET.marginBytes}};
}

/** The journal's trip page size (packages/contracts/src/journal.ts, JOURNAL_TRIP_PAGE). */
export const JOURNAL_TRIP_PAGE = 50;
/**
 * The trip counts of the journal list's pages for `count` trips, as the trip-page contract answers them
 * (packages/contracts/src/journal.ts, `page`): a page carries a next cursor exactly when it is full, so full pages are
 * followed by one more page, and `count` a multiple of 50 ends in an empty page. 30 trips: [30]; 50: [50, 0]; 51: [50, 1].
 */
export function journalPageSizes(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Trip count must be a non-negative integer');
  return [...Array(Math.floor(count / JOURNAL_TRIP_PAGE)).fill(JOURNAL_TRIP_PAGE), count % JOURNAL_TRIP_PAGE];
}

/** Failure event codes of every smoke (runtime-smoke.mjs) and the recording failures of the recording journey. */
export const SOAK_FAILURE_EVENTS = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
export const SOAK_RECORDING_FAILURES = Object.freeze(['V1_DURABLE_RETRY', 'V1_DURABLE_UNAVAILABLE', 'V1_DURABLE_ACK_AHEAD', 'V1_DURABLE_RESTORE_LOSS', 'V1_EVENT_CONFLICT',
  'RECORDING_TARGET_REJECTED', 'HISTORY_STORAGE_UNAVAILABLE', 'V1_SAMPLES_RETRY', 'V1_SAMPLES_DROPPED', 'V1_SAMPLES_DISCARDED', 'V1_SAMPLES_SKIPPED']);
/** The rows a soak receipt keeps of each log besides the failure rows; the rest is counted by event. */
const KEPT_MAIN = new Set(['APP_START', 'SERVICE_START_REQUESTED', 'SERVICE_READY', 'DASHBOARD_WINDOW_CREATED', 'DASHBOARD_LOAD_FINISHED', 'APP_EXIT_REQUESTED', 'SERVICE_EXIT', 'APP_EXIT']);
const KEPT_SERVICE = new Set(['STORAGE_VERIFIED', 'RECORDING_TARGET', 'HISTORY_STORAGE_OPENED', 'HISTORY_STORAGE_CLOSED', 'SHUTDOWN_STEP', 'SERVICE_REPORT', 'V1_SAMPLES_EXIT']);
/** At most this many failure rows of each log are kept; `logEvents` still counts every one. */
export const SOAK_KEPT_FAILURE_ROWS = 16;
const isFailure = event => SOAK_FAILURE_EVENTS.test(event) || SOAK_RECORDING_FAILURES.includes(event);
/**
 * A soak's logs can hold hundreds of rows, so its receipt keeps the rows its checks name, plus the first 16 failure rows of
 * each log (a failure event code or a recording failure), and counts every row by event in `soak.logEvents`. The receipt
 * rule then rejects a failure row or a failure count independently of the driver.
 */
export function compactSoakLogs(result) {
  const count = rows => Object.fromEntries([...rows.reduce((map, row) => map.set(row.event, (map.get(row.event) ?? 0) + 1), new Map())].sort());
  const keep = (rows, kept) => {
    let failures = 0;
    return rows.filter(row => kept.has(row.event) || (isFailure(row.event) && ++failures <= SOAK_KEPT_FAILURE_ROWS));
  };
  if (result.soak) result.soak.logEvents = {main: count(result.mainEvents ?? []), service: count(result.serviceEvents ?? [])};
  if (result.mainEvents) result.mainEvents = keep(result.mainEvents, KEPT_MAIN);
  if (result.serviceEvents) result.serviceEvents = keep(result.serviceEvents, KEPT_SERVICE);
}

/** Evidence only: the closed database's size per hour of one-second samples, against the measured size and the allowance. */
export function databaseGrowth({databaseBytes, samples}) {
  const perHour = samples > 0 ? Math.round((databaseBytes * 3600) / samples) : null;
  const ratio = value => perHour === null ? null : Math.round((perHour / value) * 1000) / 1000;
  return {databaseBytes, samples, bytesPerSampleHour: perHour, measuredBytesPerSampleHour: MEASURED_BYTES_PER_SAMPLE_HOUR, ratioToMeasured: ratio(MEASURED_BYTES_PER_SAMPLE_HOUR),
    allowanceBytesPerSampleHour: ALLOWANCE_BYTES_PER_SAMPLE_HOUR, ratioToAllowance: ratio(ALLOWANCE_BYTES_PER_SAMPLE_HOUR)};
}
