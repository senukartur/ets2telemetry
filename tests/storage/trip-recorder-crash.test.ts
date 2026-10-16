// S3 (ET-015a PR-2, REG-006 at the process boundary): a telemetry-service process running V1Ingestion with the trip
// recorder is terminated with TerminateProcess at a barrier counted in commits, then a new process on the same database
// cold-starts against the same reactive simulator over actual pipes. Child: tests/storage/fixtures/trip-recorder-child.cjs.
// Expected rows are written by hand: the crash scenarios' tests/fixtures/simulator-v1/<id>.trip.expected.json, and
// tests/fixtures/recording/<id>.rows.expected.json where a derived transport adds the reconnection the kill needs.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveDifferences, serveV1Reactive, type ReactiveServeOptions} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, workspace} from './helpers';
import {recordingExpected, storedRows, tripExpected, withTransport} from './recording-helpers';

/** Liveness bound for a child line; never a measured duration. */
const CHILD_LIVENESS_MS = 20_000;
const CHILD = path.resolve('tests/storage/fixtures/trip-recorder-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');
type Json = Record<string, unknown>;

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

type Barrier = {kind: 'before' | 'after'; eventSeq?: string; commit?: number} | {kind: 'inside'; eventSeq: string} | null;
interface ChildConfig {barrier: Barrier; mode?: 'worker' | 'in-process'; maxConnections?: number; commitAfterFirstEnd?: boolean}
/** One service process. `until` resolves at the first stdout line that matches; stderr must stay empty. */
function service(endpoint: string, config: ChildConfig, name: string) {
  const file = path.join(ws.directory, `${name}.json`);
  writeFileSync(file, JSON.stringify({endpoint, mode: 'worker', ...config, open: {path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}}));
  const child = spawn(process.execPath, [CHILD, file], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
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
async function crash(input: Json, first: ChildConfig, options: {serve?: ReactiveServeOptions; between?: () => Promise<void>} = {}) {
  const server = await serveV1Reactive(input, {scale: 0, awaitScriptedAcks: true, ...options.serve}), children: Child[] = [];
  try {
    const one = service(server.endpoint, {maxConnections: 1, ...first}, 'first'); children.push(one);
    await one.until(line => line.startsWith('barrier '));
    await one.terminate();
    await options.between?.();
    const two = service(server.endpoint, {barrier: null}, 'second'); children.push(two);
    await two.until(line => line === 'disconnected');
    await two.terminate();
    const report = await server.done;
    for (const child of children) expectAcksAfterCommits(child);
    return {report, one, two};
  } finally {
    // No child outlives its test, whatever failed.
    await Promise.all(children.map(c => c.terminate().catch(() => undefined)));
    await server.stop();
  }
}
const committedThrough = async (session: string) => { const reader = await ws.open(); const through = ok(reader.committedThrough(session)); reader.close(); return BigInt(through); };
const checks = () => readOnly(ws.database, db => ({integrity: db.pragma('integrity_check', {simple: true}), foreignKeys: db.prepare('PRAGMA foreign_key_check').all()}));

describe('S3 killed recording process (REG-006)', () => {
  it('(a) terminated before committing eventSeq 2: the new process resumes the stored trip, as crash-before-commit expects', async () => {
    const input = readFixtureFile(scenarioPath('crash-before-commit')) as Json, replay = replayV1(input), session = scenarioSource(replay.scenario).pluginSessionId;
    const {report, one, two} = await crash(input, {barrier: {kind: 'before', eventSeq: '2'}});
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
    expect(one.lines.filter(l => l !== 'ready').slice(-3)).toEqual(['committed 7 7', 'ack 7', 'barrier inside 8']);
    expect(between).toEqual({through: '7', events: ['1', '2', '3', '4', '5', '6', '7'], delivered: null, trips: [['open', 'partial']], attributions: 0});
    expect(two.lines.filter(l => l.startsWith('committed'))).toEqual(['committed 8 8', 'committed 9 9']);
    const expected = recordingExpected('normal-delivery-kill-in-commit');
    expect(await storedRows(ws, seed)).toEqual({trips: expected.trips, attributions: expected.attributions, intervals: expected.intervals});
    expect((await committedThrough(session)).toString()).toBe(expected.coverage.committedThroughEventSeq);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);

  // (d) Fixed kill points over two scenarios, counted in commit commands of the first process: before the k-th commit
  // starts, or after its result. The first connection's client is scripted not to wait for ACKs and the first process
  // commits only after that connection ended, so the server has written the whole stream to it and retains everything
  // unacknowledged; the second process receives all of it again (A = 0). The final trips, as [job eventSeq, outcome,
  // close reason], are written by hand from docs/trips.md for each kill point:
  // - normal-delivery: the delivery closes the trip of job 3 whatever the first process committed (a replayed opening,
  //   a resumed seed, or a trip already closed).
  // - save-load, killed before commit 2: nothing of the trip was stored; the replayed job 3 continues through the reload
  //   check and the save load (O10), so trip@3 stays open.
  // - save-load, killed after commit 7: the seed resumes awaiting its outcome after the clear (6) without its
  //   cargoLoaded, so the re-send (9) never matches and opens a not-merged continuation (docs/trips.md, cold start).
  // - save-load, killed before commit 12: the seed resumes active, because the re-send (9) after the clear cancelled
  //   awaitingOutcome, without its reload-check phase; the regression (13) then closes it as a discontinuity.
  const KILLS: [string, number, 'before' | 'after', [string, string, string | null][]][] = [
    ['normal-delivery', 3, 'before', [['3', 'delivered', 'outcome']]], ['normal-delivery', 5, 'after', [['3', 'delivered', 'outcome']]],
    ['normal-delivery', 8, 'after', [['3', 'delivered', 'outcome']]], ['save-load', 2, 'before', [['3', 'open', null]]],
    ['save-load', 7, 'after', [['3', 'none', 'configuration-cleared'], ['9', 'open', null]]], ['save-load', 12, 'before', [['3', 'none', 'discontinuity']]]];
  const SECOND: Record<string, [number, number, number]> = {'normal-delivery': [1100, 1200, 1300], 'save-load': [300, 400, 500]};
  for (const [id, commit, kind, final] of KILLS) it(`(d) ${id}: killed ${kind} commit ${commit} keeps every invariant after redelivery`, async () => {
    const base = readFixtureFile(scenarioPath(id)) as Json, [end, reconnect, last] = SECOND[id];
    const input = withTransport(base, `${id}-kill-${kind}-${commit}`, [{atMs: 0, action: 'connect', client: {durable: true, ack: 'withhold'}}, {atMs: end, action: 'disconnect'},
      {atMs: reconnect, action: 'connect', client: {durable: true}}, {atMs: last, action: 'disconnect'}]);
    const session = scenarioSource(replayV1(input).scenario).pluginSessionId;
    const {one, two} = await crash(input, {barrier: {kind, commit}, commitAfterFirstEnd: true}, {serve: {quiesceMs: 0}});
    expect(one.lines.at(-1)).toBe(`barrier ${kind} ${commit}`);
    // Hand-written from the scenarios: 9 events (normal-delivery) and 13 events (save-load), no gap.
    const total = id === 'normal-delivery' ? 9 : 13;
    const through = await committedThrough(session);
    for (const ack of [...one.acks(), ...two.acks()]) expect(through).toBeGreaterThanOrEqual(ack);
    const reader = await ws.open();
    const events = ok(reader.listEvents(session)).map(e => [e.eventSeq, e.type]), trips = ok(reader.listTrips()).trips;
    reader.close();
    const db = readOnly(ws.database, d => ({
      gaps: d.prepare('SELECT count(*) FROM event_gaps').pluck().get(),
      perEvent: d.prepare(`SELECT e.event_seq AS eventSeq, e.type, count(a.event_ref) AS n FROM events e LEFT JOIN event_attributions a ON a.event_ref = e.id GROUP BY e.id ORDER BY e.event_seq`).all() as {eventSeq: string; type: string; n: number}[]
    }));
    expect({through, events: events.length, distinct: new Set(events.map(([seq]) => seq)).size, gaps: db.gaps}).toEqual({through: BigInt(total), events: total, distinct: total, gaps: 0});
    // Every gameplay event has exactly one attribution, every other event none.
    const gameplay = new Set(['job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train']);
    for (const row of db.perEvent) expect(row.n, `${row.eventSeq} ${row.type}`).toBe(gameplay.has(row.type) ? 1 : 0);
    // At most one open trip per game; storage refuses a second close of a trip, so no trip is closed twice.
    expect(trips.filter(t => t.outcome === 'open').length).toBeLessThanOrEqual(1);
    expect(trips.map(t => [t.jobConfigurationEventSeq, t.outcome, t.closeReason])).toEqual(final);
    if (id === 'normal-delivery') expect(trips[0].outcomeEventSeq).toBe('8');
    expect(two.lines.filter(l => l.startsWith('committed')).at(-1)).toBe(`committed ${total} ${total}`);
    expect(checks()).toEqual({integrity: 'ok', foreignKeys: []});
  }, 60_000);
});
