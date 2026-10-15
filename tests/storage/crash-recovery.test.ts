// REG-006 at the process boundary: a telemetry service process that dies at any point of a commit leaves a database
// whose committed coverage covers every reported commit, where every stored event or gap has exactly its effect rows,
// and which a redelivery completes without duplicates. The child is terminated with TerminateProcess, never closed.
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {openStorage, type TripEffect} from '../../packages/storage/src/index';
import {ok, P1, readOnly, v1, withEventSeq, workspace} from './helpers';

const CHILD = path.resolve('tests/storage/fixtures/crash-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

interface Item {kind: 'event' | 'gap'; last: string; message: ServerMessage; effects: TripEffect[]}
const tripUuid = (cycle: number) => `70000000-0000-4000-8000-${String(cycle + 1).padStart(12, '0')}`;
const attribute = (cycle: number | null): TripEffect => cycle === null ? {kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'} : {kind: 'event.attribute', tripUuid: tripUuid(cycle), attribution: 'trip'};
/**
 * Synthetic trips of six eventSeqs each: job configured (opens the trip), simulation started, a fine, a lost eventSeq
 * (gap: completeness interval, trip downgraded to partial), delivery (closes the trip) and a free-driving pause.
 * Every effect depends on earlier commits, so a lost or reordered commit would show up as a missing or extra row.
 */
function stream(cycles: number): Item[] {
  const items: Item[] = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const base = BigInt(cycle * 6);
    const event = (name: string, offset: bigint, effects: TripEffect[]): Item => ({kind: 'event', last: String(base + offset), message: withEventSeq(name, base + offset), effects});
    items.push(
      event('event-job-configured', 1n, [{kind: 'trip.open', tripUuid: tripUuid(cycle), game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
        jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1_791_676_800_000 + cycle}, attribute(cycle)]),
      event('event-simulation-started', 2n, [attribute(cycle)]),
      event('event-player-fined', 3n, [attribute(cycle)]),
      {kind: 'gap', last: String(base + 4n), message: withEventSeq('gap', base + 4n), effects: [
        {kind: 'completeness.add', interval: {tripUuid: tripUuid(cycle), kind: 'event-loss', firstEventSeq: String(base + 4n), lastEventSeq: String(base + 4n)}},
        {kind: 'trip.update', tripUuid: tripUuid(cycle), set: {recordingCompleteness: 'partial'}}]},
      event('event-job-delivered', 5n, [attribute(cycle), {kind: 'trip.close', tripUuid: tripUuid(cycle), outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event',
        recordingCompleteness: 'partial', endedUtcMs: 1_791_680_400_000 + cycle}]),
      event('event-simulation-paused', 6n, [attribute(null)]));
  }
  return items;
}

/** Runs the child until it ends itself, or until `terminateAfterAck` acks were read, then terminates it. */
async function runChild(mode: 'before-commit' | 'after-commit' | 'worker', items: Item[], killAt: number, terminateAfterAck?: number) {
  const config = path.join(ws.directory, `crash-${mode}.json`);
  writeFileSync(config, JSON.stringify({open: {path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}, welcome: v1('welcome'), stream: items, killAt}));
  const child = spawn(process.execPath, [CHILD, mode, config], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  // 'close' comes after the process exited and its stdout and stderr ended, so the last ack line and any late error output
  // are always read; 'exit' can arrive while piped output is still unread.
  const closed = once(child, 'close');
  const acks: {last: bigint; through: bigint}[] = [];
  let stdout = '', stderr = '', done = false;
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    const lines = stdout.split('\n'); stdout = lines.pop() ?? '';
    for (const line of lines) {
      const [word, last, through] = line.trim().split(' ');
      if (word === 'done') done = true;
      if (word !== 'ack') continue;
      acks.push({last: BigInt(last), through: BigInt(through)});
      // Terminated at a seeded ack; the worker is wherever it happens to be, usually inside a later commit.
      if (acks.length === terminateAfterAck) child.kill();
    }
  });
  const [code] = await closed as [number | null];
  expect(stderr).toBe('');
  return {code, acks, done};
}

/**
 * The child stamps its rows with the real clock, which the worker cannot replace. The reopening test process must use
 * the real clock as well: the workspace's fixed clock would date a redelivered trip update before the trip's creation by
 * the child (trips CHECK updated_utc_ms >= created_utc_ms) whenever the suite runs after that fixed time.
 */
const parentOptions = () => ws.options({now: () => Date.now()});

/** Reopens the database in this process and checks every crash-recovery invariant against the stream. */
async function verify(items: Item[]) {
  const storage = ok(await openStorage(parentOptions()));
  const through = BigInt(ok(storage.committedThrough(P1)));
  storage.close();
  const facts = readOnly(ws.database, db => ({
    integrity: db.pragma('integrity_check', {simple: true}),
    foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    events: (db.prepare('SELECT event_seq AS seq, type FROM events ORDER BY event_seq').all() as {seq: string; type: string}[]).map(row => ({seq: BigInt(row.seq), type: row.type})),
    gaps: (db.prepare('SELECT first_event_seq AS first FROM event_gaps ORDER BY first_event_seq').all() as {first: string}[]).map(row => BigInt(row.first)),
    attributionsPerEvent: db.prepare('SELECT count(a.event_ref) AS n FROM events e LEFT JOIN event_attributions a ON a.event_ref = e.id GROUP BY e.id').pluck().all(),
    attributions: db.prepare('SELECT count(*) FROM event_attributions').pluck().get(),
    trips: db.prepare(`SELECT t.trip_uuid AS trip, o.event_seq AS opened, t.outcome, d.event_seq AS delivered, t.recording_completeness AS completeness
      FROM trips t JOIN events o ON o.id = t.opened_event_ref LEFT JOIN events d ON d.id = t.outcome_event_ref ORDER BY o.event_seq`).all() as {trip: string; opened: string; outcome: string; delivered: string | null; completeness: string}[],
    intervals: (db.prepare('SELECT first_event_seq AS first FROM completeness_intervals ORDER BY first_event_seq').all() as {first: string}[]).map(row => BigInt(row.first))
  }));
  expect(facts.integrity).toBe('ok');
  expect(facts.foreignKeys).toEqual([]);
  const stored = new Set([...facts.events.map(event => event.seq), ...facts.gaps]);
  // Contiguous coverage: exactly the longest stored prefix 1..n.
  let contiguous = 0n;
  while (stored.has(contiguous + 1n)) contiguous++;
  expect(through).toBe(contiguous);
  // Every stored event has exactly its one attribution; every stored gap exactly its one completeness interval.
  expect(facts.attributionsPerEvent.every(count => count === 1)).toBe(true);
  expect(facts.attributions).toBe(facts.events.length);
  expect(facts.intervals).toEqual(facts.gaps);
  // One trip per stored job configuration; closed exactly when its delivery is stored; partial exactly when its gap is.
  const configured = facts.events.filter(event => event.type === 'job.configured');
  expect(facts.trips.map(trip => BigInt(trip.opened))).toEqual(configured.map(event => event.seq));
  for (const trip of facts.trips) {
    const opened = BigInt(trip.opened);
    expect(trip.outcome === 'delivered', trip.trip).toBe(stored.has(opened + 4n));
    expect(trip.delivered === null ? null : BigInt(trip.delivered), trip.trip).toBe(stored.has(opened + 4n) ? opened + 4n : null);
    expect(trip.completeness, trip.trip).toBe(stored.has(opened + 3n) ? 'partial' : 'complete');
  }
  expect(stored.size).toBeLessThanOrEqual(items.length);
  return {through, stored};
}

/** Redelivers the whole stream in order, as a reconnected producer would, and checks the completed database. */
async function redeliver(items: Item[], stored: Set<bigint>) {
  const storage = ok(await openStorage(parentOptions()));
  for (const item of items) {
    const input = {message: item.message, effects: item.effects};
    const result = ok(item.kind === 'gap' ? storage.commitGap(input) : storage.commitEvent(input));
    // Already stored items are duplicates and never reapply their effects; a gap inside coverage is covered.
    expect(result.status, item.last).toBe(stored.has(BigInt(item.last)) ? 'duplicate' : 'committed');
  }
  expect(ok(storage.committedThrough(P1))).toBe(items.at(-1)!.last);
  storage.close();
  await verify(items);
}

/** Small deterministic generator for the seeded kill points (mulberry32). */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('REG-006 killed service process', () => {
  it.each([[2, 'an event'], [3, 'a gap'], [4, 'a trip close']])('terminated inside the transaction of item %i (%s) stores none of it and returns no commit result', async killAt => {
    const items = stream(2);
    const {code, acks, done} = await runChild('before-commit', items, killAt);
    expect(code).not.toBe(0);
    expect(done).toBe(false);
    // Every item before the kill was acknowledged; the killed one never was.
    expect(acks.map(ack => ack.last)).toEqual(items.slice(0, killAt).map(item => BigInt(item.last)));
    const {through, stored} = await verify(items);
    expect(through).toBe(BigInt(killAt));
    expect(stored.has(BigInt(items[killAt].last))).toBe(false);
    await redeliver(items, stored);
  });

  it('terminated through the worker after COMMIT but before the ack keeps the commit, and redelivery is a duplicate', async () => {
    const items = stream(2), killAt = 4;
    const {code, acks} = await runChild('after-commit', items, killAt);
    expect(code).not.toBe(0);
    expect(acks.map(ack => ack.last)).toEqual(items.slice(0, killAt).map(item => BigInt(item.last)));
    const {through, stored} = await verify(items);
    // The unacknowledged commit is durable: the producer redelivers it and storage reports a duplicate.
    expect(through).toBe(BigInt(killAt + 1));
    expect(stored.has(BigInt(items[killAt].last))).toBe(true);
    await redeliver(items, stored);
  });

  it.each([1, 2, 3, 4, 5])('terminated through the worker at a seeded point (seed %i) never loses an acknowledged commit', async seed => {
    const items = stream(6), random = seeded(seed);
    const terminateAfterAck = 1 + Math.floor(random() * (items.length - 1));
    const {code, acks} = await runChild('worker', items, -1, terminateAfterAck);
    expect(code).not.toBe(0);
    expect(acks.length).toBeGreaterThanOrEqual(terminateAfterAck);
    const {through, stored} = await verify(items);
    // A durable ACK built from any reported result is never ahead of what storage holds after the crash.
    for (const ack of acks) expect(through).toBeGreaterThanOrEqual(ack.through);
    expect(through).toBeGreaterThanOrEqual(acks.at(-1)!.last);
    await redeliver(items, stored);
  });
});
