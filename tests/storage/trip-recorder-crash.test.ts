// S3 (ET-015a PR-2, REG-006 at the process boundary): a telemetry-service process running V1Ingestion with the trip
// recorder is terminated with TerminateProcess at a barrier counted in commits, then a new process on the same database
// cold-starts against the same reactive simulator over actual pipes. Child: tests/storage/fixtures/trip-recorder-child.cjs.
// Expected rows are written by hand: the crash scenarios' tests/fixtures/simulator-v1/<id>.trip.expected.json, and
// tests/fixtures/recording/<id>.rows.expected.json where a derived transport adds the reconnection the kill needs.
// ET-019 (REG-005, REG-006, REG-012): every case also checks the history invariants I1–I5 of
// scripts/ci/history-invariants.mjs over the closed database and every ACK the processes wrote, more hand-written kill
// rows cover further scenarios, and a seeded campaign (ETS2TELEMETRY_RECOVERY_SEEDS) picks scenario, kill kind and kill
// point and asserts the invariants only. The children run under a temporary LOCALAPPDATA in which no history database
// may appear.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {checkHistoryInvariants, formatViolations, type HistoryAck} from '../../scripts/ci/history-invariants.mjs';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveDifferences, serveV1Reactive, type ReactiveServeOptions} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {between, campaignRandom, pick} from '../shared/seeded-random';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, workspace} from './helpers';
import {readHistoryRows} from './history-rows';
import {recordingExpected, storedRows, storedSamples, tripExpected, withTransport} from './recording-helpers';

/** Liveness bound for a child line; never a measured duration. */
const CHILD_LIVENESS_MS = 20_000;
const CHILD = path.resolve('tests/storage/fixtures/trip-recorder-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');
type Json = Record<string, unknown>;

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

type Barrier = {kind: 'before' | 'after'; eventSeq?: string; commit?: number} | {kind: 'inside'; eventSeq: string} | {kind: 'after'; attach: true} | null;
/** `attach` (ET-019) runs the recorder's late-attach op (J9) in the child, as the service does. */
interface ChildConfig {barrier: Barrier; mode?: 'worker' | 'in-process'; maxConnections?: number; commitAfterFirstEnd?: boolean; sampleFlushMs?: number; stopAfterDisconnect?: boolean; attach?: boolean}
/** The children's LOCALAPPDATA: a directory of the test's workspace, never the user's. */
const localAppData = () => path.join(ws.directory, 'localappdata');
/**
 * ET-019: game sources record no history yet (R3), and no process of the case created a history database under the
 * children's LOCALAPPDATA; every case calls it before it starts processes and after they ended.
 */
function expectNoGameHistory() {
  expect(GAME_HISTORY_RECORDING).toBe(false);
  expect(existsSync(path.join(localAppData(), 'ETS2Telemetry', 'data', 'telemetry.sqlite'))).toBe(false);
}
/** One service process. `until` resolves at the first stdout line that matches; stderr must stay empty. */
function service(endpoint: string, config: ChildConfig, name: string) {
  const file = path.join(ws.directory, `${name}.json`);
  writeFileSync(file, JSON.stringify({endpoint, mode: 'worker', ...config, open: {path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}}));
  const child = spawn(process.execPath, [CHILD, file], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', LOCALAPPDATA: localAppData()}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  // 'close' follows the exit and the end of both pipes, so every line written before the kill has been read.
  const closed = once(child, 'close');
  const lines: string[] = [], waiters: {match: (line: string) => boolean; resolve: () => void}[] = [];
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    const parts = stdout.split('\n'); stdout = parts.pop() ?? '';
    for (const line of parts.map(p => p.trim())) {
      lines.push(line);
      for (const w of waiters.splice(0)) if (w.match(line)) w.resolve(); else waiters.push(w);
    }
  });
  // A liveness bound only: a cooperative child reaches each line within milliseconds; on failure the lines are reported.
  const until = (match: (line: string) => boolean) => lines.some(match) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: expected line not reached; stdout ${JSON.stringify(lines)}; stderr ${JSON.stringify(stderr)}`)), CHILD_LIVENESS_MS);
    waiters.push({match, resolve: () => { clearTimeout(timer); resolve(); }});
  });
  // TerminateProcess on Windows: no exit handlers, no SQLite close, no checkpoint.
  let terminated = false;
  const terminate = async () => { if (!terminated) { terminated = true; child.kill(); } await closed; expect(stderr).toBe(''); };
  return {lines, until, terminate, acks: () => lines.filter(l => l.startsWith('ack ')).map(l => BigInt(l.slice(4)))};
}
type Child = ReturnType<typeof service>;

/**
 * Every ACK line of a process follows a commit line of the same process whose coverage covers it: the pipe was never
 * handed an ACK beyond what storage had reported (REG-005, REG-006).
 */
function expectAcksAfterCommits(child: Child) {
  let coverage = 0n;
  for (const line of child.lines) {
    if (line.startsWith('committed ')) { const through = BigInt(line.split(' ')[2]); if (through > coverage) coverage = through; }
    if (line.startsWith('ack ')) expect(BigInt(line.slice(4)), `${line} after coverage ${coverage}`).toBeLessThanOrEqual(coverage);
  }
}

/**
 * The first process runs until its barrier and is terminated there; a second process then runs until its first
 * connection ends at the scripted disconnect, and is terminated before it reconnects. `between` runs while neither
 * process holds the database.
 */
async function crash(input: Json, first: ChildConfig, options: {serve?: ReactiveServeOptions; between?: () => Promise<void>; attach?: boolean} = {}) {
  expectNoGameHistory();
  const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true, ...options.serve}), children: Child[] = [];
  try {
    const one = service(server.endpoint, {maxConnections: 1, attach: options.attach, ...first}, 'first'); children.push(one);
    await one.until(line => line.startsWith('barrier '));
    await one.terminate();
    await options.between?.();
    const two = service(server.endpoint, {barrier: null, attach: options.attach}, 'second'); children.push(two);
    await two.until(line => line === 'disconnected');
    await two.terminate();
    const report = await server.done;
    for (const child of children) expectAcksAfterCommits(child);
    expectNoGameHistory();
    return {report, one, two};
  } finally {
    // No child outlives its test, whatever failed.
    await Promise.all(children.map(c => c.terminate().catch(() => undefined)));
    await server.stop();
  }
}
const committedThrough = async (session: string) => { const reader = await ws.open(); const through = ok(reader.committedThrough(session)); reader.close(); return BigInt(through); };
const checks = () => readOnly(ws.database, db => ({integrity: db.pragma('integrity_check', {simple: true}), foreignKeys: db.prepare('PRAGMA foreign_key_check').all()}));
/**
 * ET-019: the invariants I1–I5 over the closed database and every ACK the processes wrote, all of them for the
 * scenario's one plugin session. A failure names the invariant, the offending rows, `context` and every row read.
 */
function expectInvariants(session: string, children: Child[], context = '') {
  const rows = readHistoryRows(ws.database);
  const acks: HistoryAck[] = children.flatMap(child => child.acks()).map(through => ({pluginSessionId: session, throughEventSeq: through.toString()}));
  const violations = checkHistoryInvariants(rows, acks);
  expect(violations, `${context}${formatViolations(violations)}\nacks ${JSON.stringify(acks)}\nrows ${JSON.stringify(rows)}`).toEqual([]);
}

/**
 * ET-019: the scenarios of the (d) kill rows and the seeded campaign. The first connection withholds its ACKs and ends
 * after the scenario's last step, the second connection reconnects after it. `coverage` is the committed coverage after
 * the second process, `commits` the number of commit commands of the first process (its connection's events and gaps),
 * both counted by hand from the scenario fixtures and their expectations. `gapFree` scenarios store every eventSeq as an
 * event. `attach` runs the recorder's late-attach op in both processes.
 */
interface KillScenario {base: string; steps?: Json[]; transport: Json[]; coverage: number; commits: number; gapFree: boolean; attach: boolean}
const withheld = (connectMs: number, endMs: number, reconnectMs: number, lastMs: number): Json[] => [{atMs: connectMs, action: 'connect', client: {durable: true, ack: 'withhold'}},
  {atMs: endMs, action: 'disconnect'}, {atMs: reconnectMs, action: 'connect', client: {durable: true}}, {atMs: lastMs, action: 'disconnect'}];
/**
 * A second job configured while the simulation runs (since 500 ms), delivered and cleared, then a frame (two-jobs). The
 * frame after the clear is deliberate: a checkpoint carries the state of the last frame (simulator OD-5 S7), so without
 * it the reconnection's checkpoint would still show job 10 and J9 would open a late-attach trip for that finished job
 * (finding F1 in docs/validation/et-019.md, tracked by the fix on branch fix/late-attach-stale-checkpoint).
 */
const SECOND_JOB: Json[] = [
  {atMs: 700, action: 'configuration', id: 'job', attributes: [{name: 'cargo.id', sdkType: 'string', value: 'synthetic_cargo_2'},
    {name: 'source.city.id', sdkType: 'string', value: 'synthetic_city_b'}, {name: 'destination.city.id', sdkType: 'string', value: 'synthetic_city_c'},
    {name: 'planned_distance.km', sdkType: 'u32', value: 80}, {name: 'income', sdkType: 'u64', value: '5000'}, {name: 'cargo.loaded', sdkType: 'bool', value: true}]},
  {atMs: 750, action: 'frame', channels: {speed: 20}},
  {atMs: 800, action: 'frame', channels: {speed: 21}},
  {atMs: 900, action: 'gameplay', id: 'job.delivered', attributes: [{name: 'revenue', sdkType: 's64', value: '5000'}, {name: 'earned.xp', sdkType: 's32', value: 100},
    {name: 'cargo.damage', sdkType: 'float', value: 0}, {name: 'distance.km', sdkType: 'float', value: 80}, {name: 'delivery.time', sdkType: 'u32', value: 120},
    {name: 'auto.park.used', sdkType: 'bool', value: false}, {name: 'auto.load.used', sdkType: 'bool', value: false}]},
  {atMs: 910, action: 'configuration', id: 'job', attributes: []},
  {atMs: 950, action: 'frame', channels: {speed: 0}}];
const SCENARIOS: Record<string, KillScenario> = {
  // Events 1–9 (normal-delivery.expected.json); last step 610 ms.
  'normal-delivery': {base: 'normal-delivery', transport: withheld(0, 1100, 1200, 1300), coverage: 9, commits: 9, gapFree: true, attach: false},
  // Events 1–13 (save-load.expected.json).
  'save-load': {base: 'save-load', transport: withheld(0, 300, 400, 500), coverage: 13, commits: 13, gapFree: true, attach: false},
  // Truck (1), timers.restart (2), truck (3); the refuel reading at 500 ms.
  'timers-truck-refuel': {base: 'timers-truck-refuel', transport: withheld(0, 600, 700, 800), coverage: 3, commits: 3, gapFree: true, attach: true},
  // Events 1–9; last step 140 ms.
  'quick-job-profile-change': {base: 'quick-job-profile-change', transport: withheld(0, 200, 300, 400), coverage: 9, commits: 9, gapFree: true, attach: true},
  // Ferry (1), train (2), toll (3).
  'ferry-train': {base: 'ferry-train', transport: withheld(0, 100, 200, 300), coverage: 3, commits: 3, gapFree: true, attach: true},
  // Job (1) and truck (2) on the first connection; after 300,000 ms they are one retentionExpired gap record 1–2.
  'retention-expired': {base: 'retention-expired', transport: withheld(0, 50, 400_100, 400_200), coverage: 2, commits: 2, gapFree: false, attach: true},
  // The first connection at 100 ms as in the scenario: gap 1–3, gap 4–4 at 150 ms and job.cleared (5) at 200 ms.
  'app-absent-hydration': {base: 'app-absent-hydration', transport: withheld(100, 300, 400, 500), coverage: 5, commits: 3, gapFree: false, attach: true},
  // normal-delivery's events 1–9, then job (10), job.delivered (11) and job.cleared (12).
  'two-jobs': {base: 'normal-delivery', steps: SECOND_JOB, transport: withheld(0, 1100, 1200, 1300), coverage: 12, commits: 12, gapFree: true, attach: true}
};
const killInput = (id: string, name: string): Json => {
  const scenario = SCENARIOS[id];
  return withTransport(readFixtureFile(scenarioPath(scenario.base)) as Json, name, scenario.transport, scenario.steps);
};

describe('S3 killed recording process (REG-006)', () => {
  it('(a) terminated before committing eventSeq 2: the new process resumes the stored trip, as crash-before-commit expects', async () => {
    const input = readFixtureFile(scenarioPath('crash-before-commit')) as Json, replay = replayV1(input), session = scenarioSource(replay.scenario).pluginSessionId;
    const {report, one, two} = await crash(input, {barrier: {kind: 'before', eventSeq: '2'}});
    expectInvariants(session, [one, two]);
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(one.lines.filter(l => l !== 'ready')).toEqual(['committed 1 1', 'ack 1', 'barrier before 2']);
    expect(two.acks()).toEqual([2n, 3n]);
    const expected = tripExpected('crash-before-commit');
    expect(await storedRows(ws, replay.scenario.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    const through = await committedThrough(session);
    expect(through.toString()).toBe(expected.coverage.committedThroughEventSeq);
    for (const ack of [...one.acks(), ...two.acks()]) expect(through).toBeGreaterThanOrEqual(ack);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);

  it('(b) terminated after committing eventSeq 2 before its ACK: the redelivery is a duplicate, as crash-after-commit expects', async () => {
    const input = readFixtureFile(scenarioPath('crash-after-commit')) as Json, replay = replayV1(input), session = scenarioSource(replay.scenario).pluginSessionId;
    const {report, one, two} = await crash(input, {barrier: {kind: 'after', eventSeq: '2'}});
    expectInvariants(session, [one, two]);
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(one.lines.filter(l => l !== 'ready')).toEqual(['committed 1 1', 'ack 1', 'committed 2 2', 'barrier after 2']);
    // The second process's cursor starts from storage (C = 2) and acknowledges the duplicate once it is redelivered.
    expect(two.lines.filter(l => l.startsWith('committed') || l.startsWith('ack'))).toEqual(['committed 2 2', 'ack 2']);
    const expected = tripExpected('crash-after-commit');
    expect(await storedRows(ws, replay.scenario.seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    expect((await committedThrough(session)).toString()).toBe(expected.coverage.committedThroughEventSeq);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);

  it('(c) terminated inside the transaction of job.delivered: event and effects are atomic, and the redelivery adds them once', async () => {
    // normal-delivery with a second connection after the delivery (606 ms), so the redelivery reaches a new process.
    const base = readFixtureFile(scenarioPath('normal-delivery')) as Json;
    const input = withTransport(base, 'normal-delivery-kill-in-commit', [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 605, action: 'disconnect'},
      {atMs: 606, action: 'connect', client: {durable: true}}, {atMs: 1100, action: 'disconnect'}]);
    const session = scenarioSource(replayV1(input).scenario).pluginSessionId, seed = (base as {seed: string}).seed;
    let between: unknown;
    const {one, two} = await crash(input, {mode: 'in-process', barrier: {kind: 'inside', eventSeq: '8'}}, {between: async () => {
      // After the kill and before any redelivery: no job.delivered row, no attribution, the trip still open.
      const reader = await ws.open();
      between = {through: ok(reader.committedThrough(session)), events: ok(reader.listEvents(session)).map(e => e.eventSeq), delivered: ok(reader.getEvent(session, '8')) ?? null,
        trips: ok(reader.listTrips()).trips.map(t => [t.outcome, t.recordingCompleteness])};
      reader.close();
      between = {...between as object, attributions: readOnly(ws.database, db => db.prepare('SELECT count(*) FROM event_attributions').pluck().get())};
    }});
    expectInvariants(session, [one, two]);
    expect(one.lines.filter(l => l !== 'ready').slice(-3)).toEqual(['committed 7 7', 'ack 7', 'barrier inside 8']);
    expect(between).toEqual({through: '7', events: ['1', '2', '3', '4', '5', '6', '7'], delivered: null, trips: [['open', 'partial']], attributions: 0});
    expect(two.lines.filter(l => l.startsWith('committed'))).toEqual(['committed 8 8', 'committed 9 9']);
    const expected = recordingExpected('normal-delivery-kill-in-commit');
    expect(await storedRows(ws, seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    expect((await committedThrough(session)).toString()).toBe(expected.coverage.committedThroughEventSeq);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);

  // (d) Fixed kill points, counted in commit commands of the first process (or its attach op): before the k-th commit
  // starts, or after its result. The first connection's client is scripted not to wait for ACKs and the first process
  // commits only after that connection ended, so the server has written the whole stream to it and retains everything
  // unacknowledged; the second process receives all of it again (A = 0). The final trips, as [job eventSeq, outcome,
  // close reason, recording completeness], are written by hand from docs/trips.md for each kill point:
  // - normal-delivery: the delivery closes the trip of job 3 whatever the first process committed (a replayed opening,
  //   a resumed seed, or a trip already closed). It is partial at every kill point: job 3 is configured before the
  //   session's first simulation.started, so the trip opens with an opened-at-load interval (T12).
  // - save-load, killed before commit 2: nothing of the trip was stored; the replayed job 3 continues through the reload
  //   check and the save load (O10), so trip@3 stays open.
  // - save-load, killed after commit 7: the seed resumes awaiting its outcome after the clear (6) without its
  //   cargoLoaded, so the re-send (9) never matches and opens a not-merged continuation (docs/trips.md, cold start).
  // - save-load, killed before commit 12: the seed resumes active, because the re-send (9) after the clear cancelled
  //   awaitingOutcome, without its reload-check phase; the regression (13) then closes it as a discontinuity.
  //   Every save-load trip is partial: opened at load (T12), a not-merged continuation or a save load.
  // These two scenarios run without the recorder's late-attach op, as they did before ET-019: their reconnection
  // checkpoints carry the state of the last frame (simulator OD-5 S7), which still shows job 3, while the replay already
  // holds its delivery or clear, so J9 would open a late-attach trip for that job (docs/validation/et-019.md, findings).
  //
  // ET-019 rows, from the same documents; every other scenario runs with the late-attach op, as the service does:
  // - timers-truck-refuel, killed before and after commit 3 (the second truck, after which only the refuel reading
  //   arrives): no job event, so no trip; the refuel and odometer changes belong to no trip (T16).
  // - quick-job-profile-change, killed after commit 5 (the clear): the seed of trip@2 resumes awaiting its outcome
  //   (awaitingOutcome: the clear is the last job event after its opening) and partial; the replayed timers.restart (7)
  //   outside any load window (a seed keeps none) closes it {none, discontinuity, partial}. It is partial anyway: the
  //   quick job (2) came before the first start (T12).
  // - ferry-train, killed after commit 2: no job, so no trip; each transfer and the toll is free-driving (T14), which the
  //   invariants check through the one attribution per gameplay event.
  // - retention-expired: the job (1) opens at load, partial. Killed before commit 1, nothing is stored: the redelivered
  //   retentionExpired gap 1–2 is a session-level interval, and the checkpoint job then opens a late-attach trip that
  //   stays open (J9). Killed after commit 1, the seed of trip@1 resumes; the gap's new suffix (2) closes it
  //   {none, gap, partial} (T10), and no late attach is pending because the slot was not idle at the checkpoint. Killed
  //   after commit 2, the gap is wholly covered (storage `covered`), so the resumed trip stays open.
  // - app-absent-hydration, killed after the attach op (the first connection attaches at 100 ms as in the scenario): the
  //   late-attach trip is stored; the second process resumes it from its seed, and the redelivered gap 4–4, newly
  //   covered, closes it {none, gap, partial} (T10).
  // - two-jobs: normal-delivery followed by a second job (10) configured while the simulation runs, delivered (11) and
  //   cleared (12), then a frame. trip@3 is partial as above. trip@10 has no cause interval, so it is complete when the
  //   first process committed its whole window (killed after commit 11, T13). Killed after commit 10, its seed resumes
  //   partial with a consumer-restart interval; killed before commit 10, its configuration is replayed from before the
  //   attach (opened-before-attach), partial.
  type Final = [string | null, string, string | null, string][];
  const D3 = ['3', 'delivered', 'outcome', 'partial'] as const;
  const KILLS: [string, number | 'attach', 'before' | 'after', Final][] = [
    ['normal-delivery', 3, 'before', [[...D3]]], ['normal-delivery', 5, 'after', [[...D3]]], ['normal-delivery', 8, 'after', [[...D3]]],
    ['save-load', 2, 'before', [['3', 'open', null, 'partial']]], ['save-load', 7, 'after', [['3', 'none', 'configuration-cleared', 'partial'], ['9', 'open', null, 'partial']]],
    ['save-load', 12, 'before', [['3', 'none', 'discontinuity', 'partial']]],
    ['timers-truck-refuel', 3, 'before', []], ['timers-truck-refuel', 3, 'after', []],
    ['quick-job-profile-change', 5, 'after', [['2', 'none', 'discontinuity', 'partial']]],
    ['ferry-train', 2, 'after', []],
    ['retention-expired', 1, 'before', [[null, 'open', null, 'partial']]], ['retention-expired', 1, 'after', [['1', 'none', 'gap', 'partial']]],
    ['retention-expired', 2, 'after', [['1', 'open', null, 'partial']]],
    ['app-absent-hydration', 'attach', 'after', [[null, 'none', 'gap', 'partial']]],
    ['two-jobs', 10, 'before', [[...D3], ['10', 'delivered', 'outcome', 'partial']]], ['two-jobs', 10, 'after', [[...D3], ['10', 'delivered', 'outcome', 'partial']]],
    ['two-jobs', 11, 'after', [[...D3], ['10', 'delivered', 'outcome', 'complete']]]];
  for (const [id, commit, kind, final] of KILLS) it(`(d) ${id}: killed ${kind} ${commit === 'attach' ? 'the attach op' : `commit ${commit}`} keeps every invariant after redelivery`, async () => {
    const scenario = SCENARIOS[id], input = killInput(id, `${id}-kill-${kind}-${commit}`), session = scenarioSource(replayV1(input).scenario).pluginSessionId;
    const barrier: Barrier = commit === 'attach' ? {kind: 'after', attach: true} : {kind, commit};
    const {one, two} = await crash(input, {barrier, commitAfterFirstEnd: true}, {serve: {quiesceMs: 0}, attach: scenario.attach});
    expectInvariants(session, [one, two]);
    expect(one.lines.at(-1)).toBe(`barrier ${kind} ${commit}`);
    const total = scenario.coverage;
    const through = await committedThrough(session);
    for (const ack of [...one.acks(), ...two.acks()]) expect(through).toBeGreaterThanOrEqual(ack);
    const reader = await ws.open();
    const events = ok(reader.listEvents(session)).map(e => [e.eventSeq, e.type]), trips = ok(reader.listTrips()).trips;
    reader.close();
    const db = readOnly(ws.database, d => ({
      gaps: d.prepare('SELECT count(*) FROM event_gaps').pluck().get(),
      perEvent: d.prepare(`SELECT e.event_seq AS eventSeq, e.type, count(a.event_ref) AS n FROM events e LEFT JOIN event_attributions a ON a.event_ref = e.id GROUP BY e.id ORDER BY e.event_seq`).all() as {eventSeq: string; type: string; n: number}[]
    }));
    if (scenario.gapFree) expect({through, events: events.length, distinct: new Set(events.map(([seq]) => seq)).size, gaps: db.gaps}).toEqual({through: BigInt(total), events: total, distinct: total, gaps: 0});
    else expect({through, distinct: new Set(events.map(([seq]) => seq)).size}).toEqual({through: BigInt(total), distinct: events.length});
    // Every gameplay event has exactly one attribution, every other event none.
    const gameplay = new Set(['job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train']);
    for (const row of db.perEvent) expect(row.n, `${row.eventSeq} ${row.type}`).toBe(gameplay.has(row.type) ? 1 : 0);
    // At most one open trip per game; storage refuses a second close of a trip, so no trip is closed twice.
    expect(trips.filter(t => t.outcome === 'open').length).toBeLessThanOrEqual(1);
    expect(trips.map(t => [t.jobConfigurationEventSeq, t.outcome, t.closeReason, t.recordingCompleteness])).toEqual(final);
    if (id === 'normal-delivery') expect(trips[0].outcomeEventSeq).toBe('8');
    if (id === 'two-jobs') expect(trips.map(t => t.outcomeEventSeq)).toEqual(['8', '11']);
    expect(two.lines.filter(l => l.startsWith('committed')).at(-1)).toBe(`committed ${total} ${total}`);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);

  // (e) ET-015b (H9, REG-006): one-second samples across a killed process. The first process flushes samples after 1 ms,
  // so some of seconds 1000-1005 may be stored when it is terminated before committing eventSeq 6 (simulation.started at
  // 9,000 ms); which ones depends on timing, and the rest are lost with the process, as H9 allows. Every stored row must
  // equal its hand-written row in one-second-samples.rows.expected.json. The cold-started second process takes the
  // reconnection at 15,500 ms, whose checkpoint is its baseline, and its orderly stop after that connection stores 1016
  // (in the resumed trip@3) and 1017 (after the delivery).
  it('(e) one-second samples: a killed process loses at most its pending rows, and the restarted one appends later seconds once', async () => {
    const input = readFixtureFile(path.resolve('tests/fixtures/recording/one-second-samples.json')) as Json, replay = replayV1(input);
    const session = scenarioSource(replay.scenario).pluginSessionId, seed = (input as {seed: string}).seed;
    const expected = (JSON.parse(readFileSync(path.resolve('tests/fixtures/recording/one-second-samples.rows.expected.json'), 'utf8')) as {samples: {monotonicNs: string}[]}).samples;
    expectNoGameHistory();
    const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true}), children: Child[] = [];
    try {
      const one = service(server.endpoint, {barrier: {kind: 'before', eventSeq: '6'}, maxConnections: 1, sampleFlushMs: 1}, 'first'); children.push(one);
      await one.until(line => line === 'barrier before 6');
      await one.terminate();
      const two = service(server.endpoint, {barrier: null, stopAfterDisconnect: true}, 'second'); children.push(two);
      await two.until(line => line === 'stopped');
      await two.terminate();
      await server.done;
      for (const child of children) expectAcksAfterCommits(child);
    } finally {
      await Promise.all(children.map(c => c.terminate().catch(() => undefined)));
      await server.stop();
    }
    expectNoGameHistory();
    expectInvariants(session, children);
    const shaped = await storedSamples(ws, seed, session) as {monotonicNs: string}[];
    const second = (row: {monotonicNs: string}) => BigInt(row.monotonicNs) / 1_000_000_000n;
    const first = shaped.filter(row => second(row) <= 1005n), later = shaped.filter(row => second(row) > 1005n);
    // The first process's rows are a prefix of 1000-1005, in order; the second process's rows are exactly 1016 and 1017.
    expect(first).toEqual(expected.slice(0, first.length));
    expect(later).toEqual(expected.filter(row => ['1016', '1017'].includes(String(second(row)))));
    expect(readOnly(ws.database, db => db.prepare(`SELECT count(*) FROM (SELECT source_clock_ref, monotonic_ns / 1000000000 AS s FROM samples GROUP BY source_clock_ref, s HAVING count(*) > 1)`)
      .pluck().get())).toBe(0);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);
});

// ET-019 seeded campaign: ETS2TELEMETRY_RECOVERY_SEEDS cases (default 4, the PR run), seeds 1 to N. Each seed picks a
// scenario, a kill kind (before or after the k-th commit of the first process, inside the transaction of the commit
// that covers an eventSeq, or after the attach op where the first process attaches) and its point, kills the first
// process there through the same barriers, lets a second process take the redelivery, and asserts the invariants only.
// A failure prints the seed, scenario, kill point, the broken invariant and every row. Reproduce one seed with
// `npm run test:storage -- tests/storage/trip-recorder-crash.test.ts -t "seed <n>:"` and a large enough seed count.
const RECOVERY_SEEDS = (() => {
  const raw = process.env.ETS2TELEMETRY_RECOVERY_SEEDS ?? '4';
  if (!/^\d{1,4}$/.test(raw)) throw new Error('ETS2TELEMETRY_RECOVERY_SEEDS must be a count from 0 to 9999');
  return Number(raw);
})();
type SeededKill = {id: string; barrier: Barrier & object; mode: 'worker' | 'in-process'; label: string};
/** The kill a seed picks; deterministic for its seed. */
function seededKill(seed: number): SeededKill {
  const random = campaignRandom(seed), id = pick(random, Object.keys(SCENARIOS)), scenario = SCENARIOS[id];
  // Only app-absent-hydration attaches on its first connection.
  const kind = pick(random, id === 'app-absent-hydration' ? ['before', 'after', 'inside', 'attach'] as const : ['before', 'after', 'inside'] as const);
  if (kind === 'attach') return {id, barrier: {kind: 'after', attach: true}, mode: 'worker', label: 'after the attach op'};
  if (kind === 'inside') {
    const eventSeq = String(between(random, 1, scenario.coverage));
    return {id, barrier: {kind: 'inside', eventSeq}, mode: 'in-process', label: `inside the commit of eventSeq ${eventSeq}`};
  }
  const commit = between(random, 1, scenario.commits);
  return {id, barrier: {kind, commit}, mode: 'worker', label: `${kind} commit ${commit}`};
}
describe(`ET-019 seeded kill campaign (${RECOVERY_SEEDS} seeds)`, () => {
  for (let seed = 1; seed <= RECOVERY_SEEDS; seed++) {
    const kill = seededKill(seed);
    it(`seed ${seed}: ${kill.id} killed ${kill.label} keeps the history invariants`, async () => {
      const input = killInput(kill.id, `${kill.id}-seed-${seed}`), session = scenarioSource(replayV1(input).scenario).pluginSessionId;
      const {one, two} = await crash(input, {barrier: kill.barrier, mode: kill.mode, commitAfterFirstEnd: true}, {serve: {quiesceMs: 0}, attach: true});
      expectInvariants(session, [one, two], `seed ${seed}, scenario ${kill.id}, killed ${kill.label}\n`);
    }, 60_000);
  }
});
