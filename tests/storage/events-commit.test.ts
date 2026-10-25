import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {decodePayload, negotiateV1, validateClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {AckValidator, DurableAckCursor, V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import type {Storage, TripEffect} from '../../packages/storage/src/index';
import {canonicalJson} from '../../packages/storage/src/codec';
import {failed, ok, P1, PROTOCOL_V1, readOnly, v1, withEventSeq, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const T1 = '70000000-0000-4000-8000-000000000001', T2 = '70000000-0000-4000-8000-000000000002';
/** The shared welcome with the source identity of a given message. */
const welcomeFor = (m: ServerMessage) => ({...v1('welcome'), source: m.source});
async function session(welcome = v1('welcome'), file = ws.database): Promise<Storage> {
  const storage = await ws.open({path: file});
  ok(storage.upsertSession({message: welcome}));
  return storage;
}
const openTrip = (tripUuid: string): TripEffect => ({kind: 'trip.open', tripUuid, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
  jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1_791_676_800_000});

describe('REG-005/REG-009 event commits', () => {
  const valid = readFileSync(path.join(PROTOCOL_V1, 'manifest.txt'), 'utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([, result]) => result === 'valid').map(([file]) => file.replace(/\.json$/, ''))
    .filter(name => decodePayload(new Uint8Array(readFileSync(path.join(PROTOCOL_V1, `${name}.json`))), 'server').kind === 'event');
  it('covers every valid event fixture, including the large identifiers', () => {
    expect(valid.length).toBeGreaterThanOrEqual(39);
    expect(valid).toEqual(expect.arrayContaining(['money-int64-min', 'money-uint64-max', 'event-seq-last', 'event-seq-2pow53', 'event-worst', 'event-size-limit']));
  });
  // One case per fixture: each opens, migrates and closes its own database, which a slow hosted runner cannot fit
  // into one case timeout for all of them (TESTING.md section 6; docs/validation/et-019.md, storage suite headroom).
  it.each(valid)('round-trips the canonical occurred and record payload of the valid event fixture %s exactly', async name => {
    const message = v1(name);
    if (message.kind !== 'event') throw new Error('fixture');
    const storage = await session(welcomeFor(message), path.join(ws.directory, `${name}.sqlite`));
    expect(ok(storage.commitEvent({message})).status, name).toBe('committed');
    const row = ok(storage.getEvent(message.source.pluginSessionId, message.data.eventSeq))!;
    expect(row.eventSeq, name).toBe(message.data.eventSeq);
    expect(canonicalJson(row.record), name).toBe(canonicalJson(message.data.record));
    expect(canonicalJson(row.occurred), name).toBe(canonicalJson(message.data.occurred));
    expect(row.record, name).toEqual(message.data.record);
    storage.close();
  });
  it('keeps zero revenue distinct from unavailable revenue and exact 64-bit money', async () => {
    const stored = new Map<string, unknown>();
    for (const name of ['event-job-delivered-zero-revenue', 'event-job-delivered-unavailable-revenue', 'money-int64-min', 'money-uint64-max']) {
      const file = path.join(ws.directory, `${name}.sqlite`), storage = await session(v1('welcome'), file);
      ok(storage.commitEvent({message: v1(name)})); storage.close();
      stored.set(name, readOnly(file, db => ({
        amount: db.prepare('SELECT amount_raw AS raw, amount_sdk_type AS type, amount_state AS state FROM event_amounts').get(),
        income: db.prepare('SELECT expected_income_raw AS raw, expected_income_sdk_type AS type, expected_income_state AS state FROM job_configurations').get()
      })));
    }
    expect(stored.get('event-job-delivered-zero-revenue')).toMatchObject({amount: {raw: '0', type: 's64', state: 'available'}});
    expect(stored.get('event-job-delivered-unavailable-revenue')).toMatchObject({amount: {raw: null, type: null, state: 'not-observed'}});
    expect(stored.get('money-int64-min')).toMatchObject({amount: {raw: '-9223372036854775808', type: 's64', state: 'available'}});
    expect(stored.get('money-uint64-max')).toMatchObject({income: {raw: '18446744073709551615', type: 'u64', state: 'available'}});
  });
  it('stores a provided empty trailer text as available and an unsent one as not observed', async () => {
    const storage = await session(); ok(storage.commitEvent({message: v1('event-trailer-configured')})); storage.close();
    const row = readOnly(ws.database, db => db.prepare('SELECT slot_index, cargo_accessory_id, cargo_accessory_id_state, brand, brand_state, body_type FROM trailer_configurations').get());
    expect(row).toEqual({slot_index: 0, cargo_accessory_id: '', cargo_accessory_id_state: 'available', brand: null, brand_state: 'not-observed', body_type: 'dryvan'});
  });
  it('keeps the exact last eventSeq and does not advance coverage over a hole', async () => {
    const storage = await session();
    expect(ok(storage.commitEvent({message: v1('event-seq-last')}))).toEqual({status: 'committed', committedThroughEventSeq: '0'});
    expect(ok(storage.getEvent(P1, '18446744073709551614'))?.eventSeq).toBe('18446744073709551614');
    expect(ok(storage.commitEvent({message: v1('event-seq-2pow53')})).committedThroughEventSeq).toBe('0');
    expect(ok(storage.listEvents(P1)).map(e => e.eventSeq)).toEqual(['9007199254740993', '18446744073709551614']);
  });
});

describe('REG-005/REG-006 idempotent commits and atomic effects', () => {
  it('applies effects once: a duplicate or redelivered event never reapplies them', async () => {
    const storage = await session();
    expect(ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1), {kind: 'event.attribute', tripUuid: T1, attribution: 'trip'}]})))
      .toEqual({status: 'committed', committedThroughEventSeq: '1'});
    expect(ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T2)]}))).toEqual({status: 'duplicate', committedThroughEventSeq: '1'});
    ok(storage.commitEvent({message: v1('event-truck-configured-e2')}));
    expect(ok(storage.commitEvent({message: v1('event-truck-configured-redelivered'), effects: [openTrip(T2)]}))).toEqual({status: 'duplicate', committedThroughEventSeq: '2'});
    expect(ok(storage.listTrips()).trips.map(t => t.tripUuid)).toEqual([T1]);
    expect(ok(storage.getTrip(T2))).toBeUndefined();
    expect(ok(storage.getEvent(P1, '2'))?.firstRedelivered).toBe(false);
  });
  it('reports a conflicting redelivery and keeps the stored row', async () => {
    const storage = await session();
    ok(storage.commitEvent({message: v1('event-job-configured')}));
    expect(ok(storage.commitEvent({message: v1('event-job-configured-repeat'), effects: [openTrip(T1)]}))).toEqual({status: 'conflict', committedThroughEventSeq: '1'});
    const repeat = v1('event-job-configured-repeat'), original = v1('event-job-configured');
    if (repeat.kind !== 'event' || original.kind !== 'event') throw new Error('fixture');
    expect(repeat.data.occurred).not.toEqual(original.data.occurred);
    expect(ok(storage.getEvent(P1, '1'))?.occurred).toEqual(original.data.occurred);
    expect(ok(storage.listTrips()).trips).toEqual([]);
  });
  it('rolls back the event and every effect when one effect fails, then commits once on retry', async () => {
    const storage = await session();
    const bad: TripEffect = {kind: 'trip.close', tripUuid: T2, outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: 1};
    failed(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1), bad]}), 'UNKNOWN_TRIP');
    failed(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1), {kind: 'event.attribute', tripUuid: T1, attribution: 'free-driving'}]}), 'INVALID_INPUT');
    expect(ok(storage.getEvent(P1, '1'))).toBeUndefined();
    expect(ok(storage.listTrips()).trips).toEqual([]);
    expect(ok(storage.committedThrough(P1))).toBe('0');
    expect(ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]})).status).toBe('committed');
    expect(ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]})).status).toBe('duplicate');
    expect(ok(storage.listTrips()).trips).toHaveLength(1);
  });
  it('returns no commit result when the transaction fails just before COMMIT', async () => {
    const storage = await session();
    const crash = () => { throw new Error('injected before COMMIT'); };
    expect(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}, {testHooks: {beforeCommit: crash}}).ok).toBe(false);
    expect(ok(storage.getEvent(P1, '1'))).toBeUndefined();
    expect(ok(storage.committedThrough(P1))).toBe('0');
    expect(ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}))).toEqual({status: 'committed', committedThroughEventSeq: '1'});
  });
  it('opens, attributes and closes a trip only from the gameplay outcome event', async () => {
    const storage = await session();
    ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}));
    const delivered = withEventSeq('event-job-delivered', 2n);
    // A malformed availability object is refused, not stored as not observed.
    failed(storage.commitEvent({message: delivered, effects: [{kind: 'trip.update', tripUuid: T1, set: {observedDistanceM: {available: true} as never}}]}), 'INVALID_INPUT');
    failed(storage.commitEvent({message: withEventSeq('event-job-cleared', 2n), effects: [{kind: 'trip.close', tripUuid: T1, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: 1_791_676_900_000}]}), 'INVALID_INPUT');
    ok(storage.commitEvent({message: delivered, effects: [{kind: 'event.attribute', tripUuid: T1, attribution: 'trip'},
      {kind: 'trip.close', tripUuid: T1, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: 1_791_676_900_000}]}));
    expect(ok(storage.getTrip(T1))).toMatchObject({outcome: 'delivered', outcomeEventSeq: '2', closeReason: 'outcome', jobConfigurationEventSeq: '1', openedEventSeq: '1', endedUtcMs: 1_791_676_900_000});
  });
  it('refuses an event of an unknown session or a changed session identity', async () => {
    const storage = await ws.open();
    failed(storage.commitEvent({message: v1('event-job-configured')}), 'UNKNOWN_SESSION');
    ok(storage.upsertSession({message: v1('welcome')}));
    const foreign = structuredClone(v1('event-job-configured')); foreign.source.processId = 999;
    failed(storage.commitEvent({message: foreign}), 'SESSION_CONFLICT');
    failed(storage.commitEvent({message: v1('gap')}), 'INVALID_INPUT');
    failed(storage.commitEvent({message: {kind: 'event'}}), 'INVALID_INPUT');
  });
});

describe('trips belong to one game', () => {
  const P2 = '10000000-0000-4000-8000-000000000002', P3 = '10000000-0000-4000-8000-000000000003';
  /** A welcome and events of another plugin session, optionally of the other game. */
  const sourceOf = (pluginSessionId: string, game: 'ets2' | 'ats') => ({...v1('welcome').source, pluginSessionId, game});
  const welcome = (pluginSessionId: string, game: 'ets2' | 'ats') => ({...v1('welcome'), source: sourceOf(pluginSessionId, game)});
  const event = (pluginSessionId: string, game: 'ets2' | 'ats', seq: bigint, fixture = 'event-job-cleared') => ({...withEventSeq(fixture, seq), source: sourceOf(pluginSessionId, game)});
  const close: TripEffect = {kind: 'trip.close', tripUuid: T1, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: 1_791_676_900_000};
  async function ets2Trip() {
    const storage = await session();
    ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}));
    return storage;
  }
  it('refuses every reference from an ATS session to an ETS2 trip and rolls the event back', async () => {
    const storage = await ets2Trip();
    ok(storage.upsertSession({message: welcome(P2, 'ats')}));
    const refused: TripEffect[] = [
      {kind: 'event.attribute', tripUuid: T1, attribution: 'trip'},
      {kind: 'completeness.add', interval: {tripUuid: T1, kind: 'discontinuity'}},
      {kind: 'trip.update', tripUuid: T1, set: {recordingCompleteness: 'partial'}},
      close
    ];
    for (const effect of refused) failed(storage.commitEvent({message: event(P2, 'ats', 1n), effects: [effect]}), 'INVALID_INPUT');
    const sample = {tripUuid: T1, utcMs: 1_791_676_800_000, sourceClockId: '30000000-0000-4000-8000-000000000001', monotonicNs: '1000149000000', gameTime: null,
      speed: {available: true as const, value: 1}, fuel: {available: false as const, reason: 'not-observed' as const}, averageConsumption: {available: false as const, reason: 'not-observed' as const},
      estimatedRange: {available: false as const, reason: 'not-observed' as const}, engineRpm: {available: false as const, reason: 'not-observed' as const},
      gear: {available: false as const, reason: 'not-observed' as const}, odometer: {available: false as const, reason: 'not-observed' as const}, position: {available: false as const, reason: 'not-observed' as const}};
    failed(storage.appendSamples(P2, [sample]), 'INVALID_INPUT');
    expect(ok(storage.getEvent(P2, '1'))).toBeUndefined();
    expect(ok(storage.committedThrough(P2))).toBe('0');
    expect(ok(storage.listSamples({tripUuid: T1}))).toEqual([]);
    expect(ok(storage.getTrip(T1))).toMatchObject({outcome: 'open', recordingCompleteness: 'complete'});
    // The same sample from the trip's own session is accepted.
    expect(ok(storage.appendSamples(P1, [sample]))).toEqual({appended: 1, skipped: 0});
  });
  it('lets a later plugin session of the same game close the trip on restart', async () => {
    const storage = await ets2Trip();
    ok(storage.upsertSession({message: welcome(P3, 'ets2')}));
    expect(ok(storage.commitEvent({message: event(P3, 'ets2', 1n), effects: [close]})).status).toBe('committed');
    expect(ok(storage.getTrip(T1))).toMatchObject({pluginSessionId: P1, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial'});
  });
  it('keeps only recording completeness and observed distance mutable after a trip is closed', async () => {
    const storage = await ets2Trip();
    ok(storage.commitEvent({message: withEventSeq('event-job-cleared', 2n), effects: [{...close, closeReason: 'configuration-cleared'}]}));
    failed(storage.commitEvent({message: withEventSeq('event-job-cleared', 3n), effects: [{kind: 'trip.update', tripUuid: T1, set: {gameModeAmbiguous: true}}]}), 'INVALID_INPUT');
    failed(storage.commitEvent({message: withEventSeq('event-truck-configured', 3n), effects: [{kind: 'trip.update', tripUuid: T1, set: {truckConfiguration: 'this-event'}}]}), 'INVALID_INPUT');
    ok(storage.commitEvent({message: withEventSeq('event-job-cleared', 3n), effects: [{kind: 'trip.update', tripUuid: T1, set: {recordingCompleteness: 'unknown', observedDistanceM: {available: true, value: 1200.5}}}]}));
    expect(ok(storage.getTrip(T1))).toMatchObject({outcome: 'none', recordingCompleteness: 'unknown', gameModeAmbiguous: false, truckConfigurationEventSeq: null, observedDistanceM: {available: true, value: 1200.5}});
  });
});

// ET-050b B1: storage validates welcomes, events and gaps of either minor; the envelope minor is stored as before.
describe('ET-050b protocol v1 minor 1 in storage', () => {
  const minor1 = (name: string) => decodePayload(new Uint8Array(readFileSync(path.join(PROTOCOL_V1, 'minor1', `${name}.json`))), 'server', {maxMinor: 1}) as ServerMessage;
  it('stores a minor-1 session, event and gap with protocol minor 1', async () => {
    const storage = await session(minor1('welcome'));
    expect(ok(storage.commitEvent({message: minor1('event-job-configured')}))).toMatchObject({status: 'committed', committedThroughEventSeq: '1'});
    expect(ok(storage.commitGap({message: minor1('gap')})).status).toBe('committed');
    expect(ok(storage.getEvent(P1, '1'))).toMatchObject({type: 'job.configured', protocolMinor: 1});
    storage.close();
    expect(readOnly(ws.database, db => ({
      session: db.prepare('SELECT protocol_major AS major, protocol_minor AS minor FROM plugin_sessions').get(),
      events: db.prepare('SELECT protocol_minor AS minor FROM events').all()
    }))).toEqual({session: {major: 1, minor: 1}, events: [{minor: 1}]});
  });
  it('treats a later minor-0 welcome of the same plugin session as a changed session', async () => {
    // The session's minor is part of its stored identity, as its versions and capabilities are.
    const storage = await session(minor1('welcome'));
    failed(storage.upsertSession({message: minor1('welcome-minor-0')}), 'SESSION_CONFLICT');
    storage.close();
  });
});

describe('REG-006 committed coverage', () => {
  it('advances coverage over events and gap markers in any order', async () => {
    const storage = await session();
    expect(ok(storage.commitGap({message: v1('gap-queue-count')})).committedThroughEventSeq).toBe('0');
    expect(ok(storage.commitGap({message: v1('gap-encoding-failed-e4')})).committedThroughEventSeq).toBe('0');
    expect(ok(storage.commitEvent({message: v1('event-job-configured')})).committedThroughEventSeq).toBe('4');
    // A merged redelivered record wholly inside committed coverage stores nothing; committed rows keep their content.
    expect(ok(storage.commitGap({message: v1('gap-merged-redelivered')}))).toEqual({status: 'covered', committedThroughEventSeq: '4', previouslyCoveredThrough: '4'});
    expect(ok(storage.commitGap({message: v1('gap-merged-redelivered')}))).toEqual({status: 'covered', committedThroughEventSeq: '4', previouslyCoveredThrough: '4'});
    expect(ok(storage.getEvent(P1, '1'))?.type).toBe('job.configured');
  });
  it('never reapplies effects of a merged gap record redelivered after an ACK inside it', async () => {
    const storage = await session();
    ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}));
    const close: TripEffect = {kind: 'trip.close', tripUuid: T1, outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: 1_791_676_900_000};
    // First connection of stream ack-inside-gap-record: the gap closes the trip once.
    expect(ok(storage.commitGap({message: v1('gap-queue-count'), effects: [close]})).status).toBe('committed');
    ok(storage.commitGap({message: v1('gap-encoding-failed-e4')}));
    // Reconnection: the record [2, 4] is redelivered whole. Closing the closed trip again would fail with INVALID_INPUT.
    expect(ok(storage.commitGap({message: v1('gap-merged-redelivered'), effects: [close]}))).toEqual({status: 'covered', committedThroughEventSeq: '4', previouslyCoveredThrough: '4'});
    expect(ok(storage.getTrip(T1))).toMatchObject({outcome: 'none', closeReason: 'gap'});
    storage.close();
    expect(readOnly(ws.database, db => db.prepare('SELECT count(*) AS n FROM event_gaps').get())).toEqual({n: 2});
  });
  it('stores a gap that extends beyond committed coverage and applies its effects', async () => {
    const storage = await session();
    ok(storage.commitEvent({message: v1('event-job-configured')}));
    expect(ok(storage.commitGap({message: withEventSeq('gap', 1n, 3n)}))).toEqual({status: 'committed', committedThroughEventSeq: '3', previouslyCoveredThrough: '1'});
  });
  it('stores a redelivered merged gap record that extends past coverage once, beside the rows it overlaps', async () => {
    // Producer side (protocol v1 §9): event 1, gap [2, 2] queueCount and gap [3, 4] encodingFailed extend one trailing
    // record to [2, 4]; an ACK of 3 falls inside it (release point 1); offline events 5 and 6 extend it to [2, 6], which
    // the next connection redelivers whole.
    const storage = await session(), gap = (first: bigint, last: bigint, causes: Record<string, string>, redelivered = false) => {
      const m = withEventSeq('gap', first, last) as ServerMessage & {data: Record<string, unknown>};
      m.data.causes = {offline: '0', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0', ...causes};
      m.data.redelivered = redelivered;
      return m;
    };
    ok(storage.commitEvent({message: v1('event-job-configured'), effects: [openTrip(T1)]}));
    expect(ok(storage.commitGap({message: gap(2n, 2n, {queueCount: '1'})})).previouslyCoveredThrough).toBe('1');
    expect(ok(storage.commitGap({message: gap(3n, 4n, {encodingFailed: '2'})}))).toEqual({status: 'committed', committedThroughEventSeq: '4', previouslyCoveredThrough: '2'});
    // Caller rule: read coverage before committing and derive effects only for the new suffix (4, 6].
    const before = ok(storage.committedThrough(P1));
    const suffix: TripEffect = {kind: 'completeness.add', interval: {tripUuid: T1, kind: 'event-loss', firstEventSeq: (BigInt(before) + 1n).toString(), lastEventSeq: '6'}};
    const merged = gap(2n, 6n, {queueCount: '1', encodingFailed: '2', offline: '2'}, true);
    expect(ok(storage.commitGap({message: merged, effects: [suffix]}))).toEqual({status: 'committed', committedThroughEventSeq: '6', previouslyCoveredThrough: before});
    expect(before).toBe('4');
    // A further redelivery of the same record is a duplicate and applies nothing again.
    expect(ok(storage.commitGap({message: merged, effects: [suffix]}))).toEqual({status: 'duplicate', committedThroughEventSeq: '6', previouslyCoveredThrough: '6'});
    storage.close();
    readOnly(ws.database, db => {
      // Each row keeps its own message's counts; the overlapping prefix [2, 4] is counted in two rows.
      expect(db.prepare('SELECT first_event_seq AS f, last_event_seq AS l, cause_queue_count AS q, cause_encoding_failed AS e, cause_offline AS o, redelivered AS r FROM event_gaps ORDER BY id').all()).toEqual([
        {f: '00000000000000000002', l: '00000000000000000002', q: '00000000000000000001', e: '00000000000000000000', o: '00000000000000000000', r: 0},
        {f: '00000000000000000003', l: '00000000000000000004', q: '00000000000000000000', e: '00000000000000000002', o: '00000000000000000000', r: 0},
        {f: '00000000000000000002', l: '00000000000000000006', q: '00000000000000000001', e: '00000000000000000002', o: '00000000000000000002', r: 1}
      ]);
      expect(db.prepare('SELECT first_event_seq AS f, last_event_seq AS l FROM completeness_intervals').all()).toEqual([{f: '00000000000000000005', l: '00000000000000000006'}]);
      expect(db.prepare('SELECT committed_through_event_seq AS c FROM plugin_sessions').get()).toEqual({c: '00000000000000000006'});
    });
  });
  // One case per seed, each with its own database, for the same reason as the fixture round trip above.
  it.each([1, 7, 42, 1_234, 99_991])('matches a BigInt reference for seeded random commit orders with redeliveries (seed %i)', async seed => {
    let state = seed;
    const random = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
    const items: [bigint, bigint][] = [];
    for (let next = 1n; next <= 60n;) { const length = random() < 0.6 ? 1n : BigInt(1 + Math.floor(random() * 4)); items.push([next, next + length - 1n]); next += length; }
    const order = items.map((item, index) => ({item, key: random(), index})).sort((a, b) => a.key - b.key).map(x => x.item);
    for (let i = 0; i < 10; i++) order.splice(Math.floor(random() * order.length), 0, order[Math.floor(random() * order.length)]);
    const storage = await session(v1('welcome'), path.join(ws.directory, `seed-${seed}.sqlite`)), committed = new Set<bigint>();
    for (const [first, last] of order) {
      const message = first === last && Number(first) % 3 !== 0 ? withEventSeq('event-job-cleared', first) : withEventSeq('gap', first, last);
      const result = ok(message.kind === 'event' ? storage.commitEvent({message}) : storage.commitGap({message}));
      for (let n = first; n <= last; n++) committed.add(n);
      let reference = 0n; while (committed.has(reference + 1n)) reference++;
      expect(result.committedThroughEventSeq, `seed ${seed}`).toBe(reference.toString());
    }
    expect(ok(storage.committedThrough(P1))).toBe(items[items.length - 1][1].toString());
    storage.close();
  });
});

describe('REG-005/REG-006 shared delivery streams through real commits', () => {
  const streams = readFileSync(path.join(PROTOCOL_V1, 'streams.txt'), 'utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/))
    .filter(([, durable, , outcome]) => durable === '1' && outcome === 'accept');
  /**
   * Replays a shared stream: every event and gap is committed to the real database, and at every welcome a new
   * DurableAckCursor starts from the stored committedThrough, as after a service restart. `A:` steps must match the
   * cursor's ACK exactly; the producer-side AckValidator checks every ACK sent.
   */
  async function replay(name: string, steps: string[]) {
    const storage = await ws.open({path: path.join(ws.directory, `${name}.sqlite`)});
    let consumer = new V1Consumer(true), cursor: DurableAckCursor | undefined, validator: AckValidator | undefined;
    for (const step of steps) {
      if (step === 'R') { consumer = new V1Consumer(true); validator = undefined; continue; }
      if (step.startsWith('A:')) {
        const ack = cursor?.ack(), produced = ack?.data.throughEventSeq ?? '-';
        expect(produced, `${name} ${step}`).toBe(step.slice(2));
        if (ack) validator!.accept(ack);
        continue;
      }
      const [side, fixture] = step.split(':');
      if (side === 'C') {
        const m = validateClientMessage(decodePayload(new Uint8Array(readFileSync(path.join(PROTOCOL_V1, `${fixture}.json`))), 'client'));
        if (m.kind === 'hello') expect(negotiateV1(m).durableEvents).toBe(true);
        else if (m.kind === 'ack') validator!.accept(m);
        else consumer.expectClockReply(m.data.probeId);
        continue;
      }
      const applied = consumer.accept(v1(fixture)), m = applied.message;
      if (m.kind === 'welcome') {
        ok(storage.upsertSession({message: m}));
        cursor = new DurableAckCursor(m.source.pluginSessionId, ok(storage.committedThrough(m.source.pluginSessionId)));
        validator = new AckValidator(m.source.pluginSessionId, m.data.durableEvents);
      }
      if (m.kind === 'checkpoint') { cursor!.beginConnection(m.data.status.delivery.ackedThroughEventSeq); validator!.checkpoint(m.data.status.delivery.ackedThroughEventSeq); }
      if (applied.coverage) {
        validator!.sent(applied.coverage.lastEventSeq);
        cursor!.received(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
        const result = ok(m.kind === 'event' ? storage.commitEvent({message: m}) : storage.commitGap({message: m}));
        // The ACK cursor learns of a commit only after the storage transaction returned.
        cursor!.commit(applied.coverage.firstEventSeq, applied.coverage.lastEventSeq);
        expect(result.committedThroughEventSeq, `${name} ${step}`).toBe(cursor!.throughEventSeq);
      }
    }
    return {storage, cursor};
  }
  it('replays the normal, redelivery, lost-ACK, ACK-inside-gap and restart streams', () => {
    expect(streams.map(([name]) => name)).toEqual(expect.arrayContaining(['normal', 'reconnect-redelivery', 'lost-ack-reconnect', 'ack-inside-gap-record', 'plugin-restart']));
  });
  for (const [name, , steps, , expected] of streams) {
    it(`stream ${name} reproduces its hand-written ACK expectations`, async () => {
      const {storage, cursor} = await replay(name, steps.split(','));
      expect(cursor?.throughEventSeq ?? '0').toBe(expected);
      if (cursor) expect(ok(storage.committedThrough(cursor.pluginSessionId))).toBe(expected);
    });
  }
});
