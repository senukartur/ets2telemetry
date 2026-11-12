// ET-112c engine 1 distance and fuel in storage (REG-003, REG-005, REG-006, REG-008, REG-014): the hand-written corpus
// of tests/shared/quantity-scenarios.ts recorded through the storage API, live and equal to the read-only reconstruction,
// across live joins at the opening event, joins after pre-join samples (the splice) and retroactive joins. Origin:
// synthetic; every expected value is written by hand in the corpus or below.
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MAX_SAMPLE_BATCH, type SampleInput, type Storage} from '../../packages/storage/src';
import {reconstructQuantities, SPLICE_SAMPLE_LIMIT} from '../../packages/storage/src/sqlite/quantities';
import {mapUploadProjection, UPLOAD_PAGE_KINDS, type UploadProjectionPage} from '../../packages/storage/src/upload-projection';
import {QUANTITY_FLAGS, tripUuidFor, type ProfileObservation, type QuantityPoint} from '../../packages/telemetry-core/src';
import {validateJournalTripDetail} from '../../packages/contracts/src/journal';
import {CLOCK_A, CLOCK_B, INCIDENT_QUANTITIES, incidentReadings, QUANTITY_SCENARIOS, s, type QuantityEvent, type QuantityExpectation, type QuantityFlagName,
  type QuantityReading} from '../shared/quantity-scenarios';
import {ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, job, r, Script} from '../shared/trip-messages';
import {ok, uploadGame, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
/** Upload projections need game-origin sources; the other cases keep the synthetic origin. */
let gameOrigin = false;
/**
 * Observed coverage and clean load windows: the root opens after a simulation start, and each later member opens at a
 * paused job event with the simulation starting before its readings.
 */
let pausedOpen = false;
beforeEach(async () => {ws = await workspace(); gameOrigin = false; pausedOpen = false;});
const shaped = <T extends {source: {origin: string}}>(message: T): T => gameOrigin ? uploadGame(message) : message;
afterEach(async () => {await ws.dispose();});

const F = QUANTITY_FLAGS, CUMULATIVE = 0x3fff, GAP = F.distanceGap | F.fuelBoundary;
const GAP_ANNOTATION = {annotation: true, cause: 'accounting-chain-break', version: 2, engine: 1, distanceFlags: F.distanceGap, fuelFlags: F.fuelBoundary};
const bits = (names: readonly QuantityFlagName[]) => names.reduce((sum, name) => sum | F[name], 0);
const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const absent = {available: false, reason: 'not-observed'} as const;
const SESSIONS: Record<string, string> = {A: ETS2_A, B: ETS2_B, C: '10000000-0000-4000-8000-0000000000d4'};
const GAME_CLOCKS: Record<string, string> = {[CLOCK_A]: GAME_CLOCK_1, [CLOCK_B]: GAME_CLOCK_2};
const gameClock = (name: string) => GAME_CLOCKS[name] ??= `40000000-0000-4000-8000-${String(Object.keys(GAME_CLOCKS).length + 1).padStart(12, '0')}`;
/** Reading time t is 10 s after the opening event of its member, on that member's capture clock. */
const ns = (t: number) => (1_000_000_000_000n + BigInt(Math.round((t + 10) * 1e9))).toString();
function proof(script: Script): ProfileObservation {
  const source = script.welcome().source;
  return {version: 1, scope: 'a'.repeat(64), binding: 'b'.repeat(64), game: source.game, pluginSessionId: source.pluginSessionId,
    processInstanceId: source.processInstanceId, sourceClockId: script.clockId, afterMonotonicNs: '0', loadGeneration: 1};
}

/**
 * How a member after the first joins: `open` with proof at its opening event; `pre-join` with proof only at its last
 * reading, so its earlier readings are spliced; `retro` (the last member only, as in M4) without proof, delivered, then
 * resolved by a later proof of its session. A member before the last one joins at its opening event in `retro`.
 */
type Join = 'open' | 'pre-join' | 'retro';
/** `at` is the script's capture clock: an event occurs 1 ms before it. */
interface Member {member: string; script: Script; uuid: string; join: Join | 'root'; previous?: QuantityReading; events: QuantityEvent[]; at: bigint}
function openMember(storage: Storage, member: string, join: Member['join'], events: readonly QuantityEvent[]): Member {
  const script = new Script(SESSIONS[member] ?? member);
  ok(storage.upsertSession({message: shaped(script.welcome())}));
  if (pausedOpen && join === 'root') ok(storage.commitEvent({message: shaped(script.event(r.started()))}));
  const message = shaped(script.event(r.jobConfigured(job()), pausedOpen && join !== 'root' ? {simulation: 'paused'} : {})), uuid = tripUuidFor(script.session, message.data.eventSeq);
  ok(storage.commitEvent({message, ...(join === 'root' || join === 'open' ? {profile: proof(script)} : {}), effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode,
    jobConfiguration: 'this-event', startedUtcMs: 1000, recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: uuid, attribution: 'trip'}]}));
  if (pausedOpen && join !== 'root') ok(storage.commitEvent({message: shaped(script.event(r.started()))}));
  return {member, script, uuid, join, events: events.filter(event => event.member === member).sort((a, b) => a.t - b.t), at: 1_001_000_000_000n};
}
function sampleOf(m: Member, reading: QuantityReading, withProof: boolean): SampleInput {
  const value = <T>(v: T | null) => v === null ? absent : {available: true as const, value: v};
  return {tripUuid: m.uuid, utcMs: 1_000 + Math.round(reading.t * 1000), sourceClockId: m.script.clockId, monotonicNs: ns(reading.t),
    odometer: value(reading.odometerM), fuel: value(reading.fuelL), speed: value(reading.speedMps), gameTime: {minutes: {available: true, value: reading.minutes}, clockId: gameClock(reading.gameClock)},
    position: {available: true, value: {x: reading.x, y: 0, z: 0}}, averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent,
    recording: {...(withProof ? {profile: proof(m.script)} : {}), job: job(), truck: reading.truck, processInstanceId: m.script.welcome().source.processInstanceId,
      ...(reading.linked && m.previous ? {previous: {tripUuid: m.uuid, sourceClockId: m.script.clockId, monotonicNs: ns(m.previous.t)}} : {})}};
}
/** Ends a member with a restart close; a retroactive member is delivered and then resolved by a later admitted proof of its session. */
function closeMember(storage: Storage, m: Member) {
  const retro = m.join === 'retro', message = shaped(m.script.event(retro ? r.delivered() : r.timersRestart(), {advanceMs: 100_000}));
  ok(storage.commitEvent({message, effects: [{kind: 'trip.close', tripUuid: m.uuid, outcome: retro ? 'delivered' : 'none', closeReason: retro ? 'outcome' : 'restart',
    ...(retro ? {outcomeEvent: 'this-event' as const} : {}), recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
  if (!retro) return;
  const at = ns(1_000);
  expect(ok(storage.resolvePendingMemberships({pluginSessionId: m.script.session, nextEventSeq: m.script.next.toString(), profile: {...proof(m.script), afterMonotonicNs: at},
    sourceClockId: m.script.clockId, monotonicNs: at}))).toEqual({status: 'resolved', resolved: 1, remaining: 0});
}
/** Records `readings` member by member; a member's ferry or train events commit before its first reading after them. */
function record(storage: Storage, readings: readonly QuantityReading[], join: Join = 'open', events: readonly QuantityEvent[] = [], proofless: ReadonlySet<QuantityReading> = new Set()) {
  const members: Member[] = [], order = [...new Set(readings.map(reading => reading.member))];
  readings.forEach((reading, index) => {
    let m = members.at(-1);
    if (m?.member !== reading.member) {
      if (m) closeMember(storage, m);
      const position = order.indexOf(reading.member);
      m = openMember(storage, reading.member, position === 0 ? 'root' : join === 'retro' && position < order.length - 1 ? 'open' : join, events);
      members.push(m);
    }
    while (m.events.length && m.events[0].t <= reading.t) {
      const event = m.events.shift()!, at = BigInt(ns(event.t)) + 1_000_000n;
      ok(storage.commitEvent({message: shaped(m.script.event(event.type === 'player.use.ferry' ? r.ferry() : r.train(), {advanceMs: Number((at - m.at) / 1_000_000n)}))}));
      m.at = at;
    }
    const last = readings.slice(index + 1).every(next => next.member !== reading.member);
    ok(storage.appendSamples(m.script.session, [sampleOf(m, reading, !proofless.has(reading) && (m.join === 'root' || m.join === 'open' || m.join === 'pre-join' && last))], {uniqueSeconds: true}));
    m.previous = reading;
  });
  if (members.at(-1)!.join === 'retro') closeMember(storage, members.at(-1)!);
  return {root: members[0].uuid, members};
}

interface Ledger {logical: bigint; head: {distance: number | null; fuel: number | null; flags: number} | null; reconstructed: QuantityPoint | null; engine: bigint;
  unknown: bigint; rows: number; annotations: Record<string, unknown>[]}
/** Reads the live head and the reconstruction of the root's group on a separate connection and checks the reconstruction writes nothing. */
function ledger(storage: Storage, root: string): Ledger {
  ok(storage.close());
  const db = new Database(ws.database);
  try {
    db.defaultSafeIntegers(true);
    const logical = db.prepare('SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?').pluck().get(root) as bigint;
    const group = db.prepare('SELECT * FROM logical_trips WHERE id=?').get(logical) as Record<string, bigint | null>;
    const head = group.progress_head === null ? undefined : db.prepare('SELECT * FROM logical_progress WHERE id=?').get(group.progress_head) as Record<string, unknown>;
    const changes = () => db.prepare('SELECT total_changes()').pluck().get();
    const before = changes(), reconstructed = reconstructQuantities(db, logical);
    expect(changes()).toBe(before);
    const annotations = (db.prepare(`SELECT detail_json FROM completeness_intervals WHERE json_extract(detail_json,'$.cause')='accounting-chain-break' ORDER BY id`).pluck().all() as string[])
      .map(detail => JSON.parse(detail) as Record<string, unknown>);
    return {logical, engine: group.accounting_engine!, unknown: group.reconciliation_unknown!, rows: Number(db.prepare('SELECT count(*) FROM logical_progress').pluck().get()), annotations,
      head: head ? {distance: head.distance_m === null ? null : Number(head.distance_m), fuel: head.fuel_used_l === null ? null : Number(head.fuel_used_l), flags: Number(head.quantity_flags)} : null,
      reconstructed};
  } finally { db.close(); }
}
const near = (value: number | null) => value === null ? null : expect.closeTo(value, 9);
/** The live head has the expected values and exact cumulative flags, and the reconstruction equals it. */
function expectLedger(found: Ledger, expected: QuantityExpectation) {
  expect(found.engine).toBe(1n);
  expect(found.head).toEqual({distance: near(expected.distanceM), fuel: near(expected.fuelUsedL), flags: expect.any(Number)});
  expect(found.head!.flags & CUMULATIVE).toBe(bits(expected.flags));
  expect(found.reconstructed).not.toBeNull();
  expect([found.reconstructed!.distanceM, found.reconstructed!.fuelUsedL]).toEqual([near(found.head!.distance), near(found.head!.fuel)]);
  expect(found.reconstructed!.flags & CUMULATIVE).toBe(found.head!.flags & CUMULATIVE);
}
/** The Journal shows the head values; a cut or an unproven quantity marks the money totals incomplete. */
function expectJournal(storage: Storage, root: string, expected: QuantityExpectation) {
  const detail = validateJournalTripDetail(ok(storage.journalTrip(root)));
  expect(detail.trip.observedDistanceM).toEqual(expected.distanceM === null ? absent : {available: true, value: near(expected.distanceM)});
  expect(detail.trip.fuelUsedL).toEqual(expected.fuelUsedL === null ? absent : {available: true, value: near(expected.fuelUsedL)});
  expect(detail.money.incomplete).toBe(expected.cut || expected.distanceM === null);
}
async function recorded(readings: readonly QuantityReading[], expected: QuantityExpectation, join: Join = 'open', events: readonly QuantityEvent[] = []) {
  const storage = await ws.open(), {root} = record(storage, readings, join, events);
  expectJournal(storage, root, expected);
  const found = ledger(storage, root);
  expectLedger(found, expected);
  return found;
}

const multiMember = QUANTITY_SCENARIOS.filter(scenario => new Set(scenario.readings.map(reading => reading.member)).size > 1);
/**
 * Note (1) of the ET-112c2 review: A drives 1000 to 1060 m and stops; B loads that save point (the run continues), drives to
 * 1100 m, loads 1020 m inside its own process and drives 20 m. The continued run holds 1020 m: 100 - 80 = 20 m restored, the
 * moving k1 is the same save point (0.01 L), then +20 m and +0.01 L.
 */
const LOAD_INSIDE_CONTINUED_RUN: QuantityReading[] = [s(0), s(1), s(2), s(3, {speedMps: 0}),
  s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false}), s(1, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80}),
  s(2, {member: 'B', odometerM: 1100, fuelL: 399.95, x: 100}), s(3, {member: 'B', odometerM: 1020, fuelL: 399.99, x: 20, gameClock: CLOCK_B, linked: false}),
  s(4, {member: 'B', odometerM: 1040, fuelL: 399.98, x: 40, gameClock: CLOCK_B})];
const LOAD_INSIDE_CONTINUED_RUN_QUANTITIES: QuantityExpectation = {distanceM: 40, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: ['distanceRestored'], cut: true};

describe('REG-008 engine 1 corpus recorded live and reconstructed', () => {
  it.each(QUANTITY_SCENARIOS.map(scenario => [scenario.id, scenario] as const))('%s', async (_id, scenario) => {
    await recorded(scenario.readings, scenario.expected, 'open', scenario.events);
  });
  it.each(multiMember.flatMap(scenario => (['pre-join', 'retro'] as const).map(join => [scenario.id, join, scenario] as const)))('%s with a %s join', async (_id, join, scenario) => {
    await recorded(scenario.readings, scenario.expected, join, scenario.events);
  });
  it.each(['open', 'pre-join', 'retro'] as const)('restores a load inside a run continued across the member junction: %s', async join => {
    await recorded(LOAD_INSIDE_CONTINUED_RUN, LOAD_INSIDE_CONTINUED_RUN_QUANTITIES, join);
  });
  it.each(['open', 'pre-join', 'retro'] as const)('continues the incident across both game restarts: %s', async join => {
    await recorded(incidentReadings(), INCIDENT_QUANTITIES, join);
  });
  it('Q1 at storage level: a reading without predecessor and with a coalesced-snapshot reset is an ordinary step without annotation', async () => {
    const storage = await ws.open(), readings = QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q1')!.readings, {members} = record(storage, readings.slice(0, 2));
    const m = members[0], k2 = sampleOf(m, readings[2], true);
    ok(storage.appendSamples(m.script.session, [{...k2, recording: {...k2.recording!, predecessorReset: 'snapshot-coalesced'}}], {uniqueSeconds: true}));
    m.previous = readings[2];
    ok(storage.appendSamples(m.script.session, [sampleOf(m, readings[3], true)], {uniqueSeconds: true}));
    const found = ledger(storage, m.uuid);
    expectLedger(found, QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q1')!.expected);
    expect(found.annotations).toEqual([]);
  });
});


/** Upload facts and evidence reasons of a trip through the bounded projection preparation and its pages. */
function upload(storage: Storage, tripUuid: string) {
  const pinId = randomUUID();
  let state = ok(storage.beginUploadProjection({pinId, tripUuid}));
  for (let turn = 0; state.state === 'preparing' && turn < 1000; turn++) state = ok(storage.advanceUploadProjection(pinId));
  const projection = state.projection!, pages: UploadProjectionPage[] = [];
  for (const kind of UPLOAD_PAGE_KINDS) {
    let cursor: string | undefined;
    do { const page = ok(storage.readUploadProjectionPage({snapshot: projection.snapshot, kind, cursor, limit: 50})); pages.push(page); cursor = page.nextCursor ?? undefined; } while (cursor);
  }
  const mapped = mapUploadProjection(projection, pages);
  if (mapped.status !== 'projected') throw new Error(`Upload projection ${mapped.status}: ${JSON.stringify(mapped)}`);
  return {moneyIncomplete: projection.facts.moneyIncomplete, reasons: mapped.summary.snapshot.evidence.reasons};
}
function deliver(storage: Storage, m: Member) {
  ok(storage.commitEvent({message: shaped(m.script.event(r.delivered(), {advanceMs: 100_000})), effects: [{kind: 'trip.close', tripUuid: m.uuid, outcome: 'delivered', closeReason: 'outcome',
    outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
}
/** Resolves the closed pending segments of `m`'s session with a later admitted proof at reading time `t`. */
function resolveAt(storage: Storage, m: Member, t: number) {
  const at = ns(t);
  return ok(storage.resolvePendingMemberships({pluginSessionId: m.script.session, nextEventSeq: m.script.next.toString(), profile: {...proof(m.script), afterMonotonicNs: at},
    sourceClockId: m.script.clockId, monotonicNs: at}));
}
const scenario = (id: string) => QUANTITY_SCENARIOS.find(candidate => candidate.id === id)!;
/**
 * Records `count` linked readings of member B from A's s(1) save point at 1020 m, 20 m and 0.1 ml apart, at reading
 * times from `from` on, in sample batches; the last one carries proof when `proofAtLast`.
 */
function longMember(storage: Storage, b: Member, count: number, proofAtLast = true, from = 0) {
  const rows: SampleInput[] = [];
  for (let i = 0; i < count; i++) {
    const reading = s(from + i, {member: 'B', odometerM: 1020 + 20 * i, x: 20 + 20 * i, fuelL: 399.99 - 0.0001 * i, linked: i > 0});
    rows.push(sampleOf(b, reading, proofAtLast && i === count - 1));
    b.previous = reading;
  }
  for (let from = 0; from < rows.length; from += MAX_SAMPLE_BATCH) ok(storage.appendSamples(b.script.session, rows.slice(from, from + MAX_SAMPLE_BATCH), {uniqueSeconds: true}));
}

describe('REG-003/005/006/014 engine 1 storage lifecycle', () => {
  it('F1a: a reading without proof right after each live join keeps both quantities', async () => {
    const readings = incidentReadings(), firsts = new Set(readings.filter((reading, index) => index > 0 && readings[index - 1].member !== reading.member));
    expect(firsts.size).toBe(2);
    const storage = await ws.open(), {root} = record(storage, readings, 'open', [], firsts);
    expectJournal(storage, root, INCIDENT_QUANTITIES);
    expectLedger(ledger(storage, root), INCIDENT_QUANTITIES);
  });
  it('adds no row for duplicate samples or a resolve replay, and keeps the totals after reopening', async () => {
    let storage = await ws.open();
    const {root, members} = record(storage, incidentReadings(), 'retro'), first = ledger(storage, root), last = members.at(-1)!;
    expectLedger(first, INCIDENT_QUANTITIES);
    storage = await ws.open();
    expectJournal(storage, root, INCIDENT_QUANTITIES);
    for (const reading of incidentReadings().filter(reading => reading.member === last.member)) {
      expect(ok(storage.appendSamples(last.script.session, [sampleOf(last, reading, true)], {uniqueSeconds: true}))).toEqual({appended: 0, skipped: 1});
    }
    const at = ns(1_000);
    expect(ok(storage.resolvePendingMemberships({pluginSessionId: last.script.session, nextEventSeq: last.script.next.toString(), profile: {...proof(last.script), afterMonotonicNs: at},
      sourceClockId: last.script.clockId, monotonicNs: at}))).toEqual({status: 'none', resolved: 0, remaining: 0});
    const again = ledger(storage, root);
    expect([again.rows, again.head, again.annotations]).toEqual([first.rows, first.head, first.annotations]);
    storage = await ws.open();
    expectJournal(storage, root, INCIDENT_QUANTITIES);
  });
  it('keeps a legacy engine-0 group on engine 0 after a reopen with the default engine, also for a member that joins it', async () => {
    let storage = await ws.open({accountingEngine: 0});
    const a = openMember(storage, 'A', 'root', []), readings = scenario('Q10').readings;
    for (const reading of readings.slice(0, 2)) { ok(storage.appendSamples(a.script.session, [sampleOf(a, reading, true)], {uniqueSeconds: true})); a.previous = reading; }
    ok(storage.close());
    storage = await ws.open();
    for (const reading of readings.slice(2, 4)) { ok(storage.appendSamples(a.script.session, [sampleOf(a, reading, true)], {uniqueSeconds: true})); a.previous = reading; }
    closeMember(storage, a);
    const b = openMember(storage, 'B', 'open', []);
    for (const reading of readings.slice(4)) { ok(storage.appendSamples(b.script.session, [sampleOf(b, reading, true)], {uniqueSeconds: true})); b.previous = reading; }
    expect(ok(storage.journalTrips()).trips.map(trip => trip.tripUuid)).toEqual([a.uuid]);
    ok(storage.close());
    const db = new Database(ws.database, {readonly: true});
    try {
      expect(db.prepare('SELECT t.trip_uuid,l.accounting_engine FROM logical_trips l JOIN trips t ON t.id=l.id ORDER BY l.id').all()).toEqual([
        {trip_uuid: a.uuid, accounting_engine: 0}, {trip_uuid: b.uuid, accounting_engine: 1}]);
      // Every ledger row of the group, including the joined member's, is an engine-0 row.
      expect(db.prepare('SELECT t.trip_uuid,count(*) AS n,count(p.quantity_flags) AS flagged FROM logical_progress p JOIN trips t ON t.id=p.trip_ref GROUP BY p.trip_ref ORDER BY p.trip_ref').all())
        .toEqual([{trip_uuid: a.uuid, n: 4, flagged: 0}, {trip_uuid: b.uuid, n: 3, flagged: 0}]);
    } finally { db.close(); }
  });
  it.each([
    ['a partial engine-1 distance', 1, scenario('Q13').readings, true],
    ['complete engine-1 quantities', 1, scenario('Q1').readings, false],
    // Four linked readings: complete engine-0 accounting, whose rows carry no quantity flags.
    ['engine 0', 0, [s(0), s(1), s(2), s(3)], false]
  ] as const)('reports accounting-unavailable to the upload only for a partial or unavailable quantity: %s', async (_name, accountingEngine, readings, incomplete) => {
    gameOrigin = true;
    const storage = await ws.open({accountingEngine, purpose: 'history'}), {members} = record(storage, readings);
    deliver(storage, members[0]);
    const found = upload(storage, members[0].uuid);
    expect(found.moneyIncomplete).toBe(incomplete);
    expect(found.reasons.includes('accounting-unavailable')).toBe(incomplete);
  });
  it.each([
    ['Q5', 'open', [{distanceFlags: F.distanceTruck, fuelFlags: F.fuelTruck}]],
    ['Q2-unlinked', 'open', [{distanceFlags: F.distanceHole, fuelFlags: F.fuelHole}]],
    ['Q10', 'open', [{distanceFlags: F.distanceGap, fuelFlags: F.fuelBoundary}]],
    ['Q10', 'pre-join', [{distanceFlags: F.distanceGap, fuelFlags: F.fuelBoundary}]],
    ['Q10', 'retro', [{distanceFlags: F.distanceGap, fuelFlags: F.fuelBoundary}]],
    ['Q9', 'open', [{distanceFlags: F.distanceUnproven, fuelFlags: F.fuelUnproven}]],
    ['Q8', 'open', []]
  ] as const)('writes one version 2 annotation for each step that sets new break bits: %s, %s join', async (id, join, expected) => {
    const storage = await ws.open(), {root} = record(storage, scenario(id).readings, join);
    expect((ledger(storage, root)).annotations).toEqual(expected.map(flags => ({annotation: true, cause: 'accounting-chain-break', version: 2, engine: 1, ...flags})));
  });
  // Budget: 28,804 recorded samples in sample batches, each through its full projection; it bounds work, not timing.
  it('keeps the target subtotal as partial when a joining member recorded more than SPLICE_SAMPLE_LIMIT samples before its join', {timeout: 600_000}, async () => {
    expect(SPLICE_SAMPLE_LIMIT).toBe(28_800);
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'pre-join', []);
    longMember(storage, b, SPLICE_SAMPLE_LIMIT + 2);
    // A's 20 m and 0.01 L kept at B's last reading before the join, with the gap bits; B's linked joining reading adds 20 m and 0.1 ml.
    const expected: QuantityExpectation = {distanceM: 40, distance: 'partial', fuelUsedL: 0.0101, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false};
    expectJournal(storage, root, expected);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    const found = ledger(storage, root);
    expectLedger(found, expected);
    expect(found.head!.flags).toBe(F.distanceGap | F.fuelBoundary | F.linked);
    expect(found.reconstructed!.flags).toBe(found.head!.flags);
    expect(found.unknown).toBe(0n);
    expect(found.annotations).toEqual([GAP_ANNOTATION]);
  });
  // Budget: 28,802 recorded samples, then one resolve call that writes a single gap row; it bounds work, not timing.
  it('keeps the target subtotal as partial when a retroactively joined member recorded more than SPLICE_SAMPLE_LIMIT samples', {timeout: 600_000}, async () => {
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'retro', []);
    longMember(storage, b, SPLICE_SAMPLE_LIMIT + 2, false);
    deliver(storage, b);
    expect(resolveAt(storage, b, SPLICE_SAMPLE_LIMIT + 1_000)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    // A's 20 m and 0.01 L kept at B's last reading, with the gap bits; nothing of B is replayed.
    const expected: QuantityExpectation = {distanceM: 20, distance: 'partial', fuelUsedL: 0.01, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false};
    expectJournal(storage, root, expected);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    const found = ledger(storage, root);
    expectLedger(found, expected);
    expect(found.head!.flags).toBe(GAP);
    expect(found.reconstructed!.flags).toBe(found.head!.flags);
    expect(found.unknown).toBe(0n);
    expect(found.annotations).toEqual([GAP_ANNOTATION]);
  });
  // Budget: 56,800 recorded samples; the first resolve call replays 28,000 and the second 28,800. It bounds work, not timing.
  it('resolves the first pending segment of a call and leaves one that would exceed SPLICE_SAMPLE_LIMIT to the next call', {timeout: 600_000}, async () => {
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'retro', []);
    longMember(storage, b, 28_000, false);
    deliver(storage, b);
    // A second closed pending segment of B's session with 28,800 readings of its own, after B's delivery.
    const message = b.script.event(r.jobConfigured(job())), second = tripUuidFor(b.script.session, message.data.eventSeq);
    ok(storage.commitEvent({message, effects: [{kind: 'trip.open', tripUuid: second, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', startedUtcMs: 3000,
      recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: second, attribution: 'trip'}]}));
    longMember(storage, {...b, uuid: second, previous: undefined}, SPLICE_SAMPLE_LIMIT, false, 28_000);
    ok(storage.commitEvent({message: b.script.event(r.delivered(), {advanceMs: 1_000}), effects: [{kind: 'trip.close', tripUuid: second, outcome: 'delivered', closeReason: 'outcome',
      outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: 4000}]}));
    // 28,000 + 28,800 exceeds the budget: the second segment waits for the next call.
    expect(resolveAt(storage, b, 60_000)).toEqual({status: 'resolved', resolved: 1, remaining: 1});
    expect(resolveAt(storage, b, 60_000)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    // B continues A at A's save point (20 m, 0.01 L), then 27,999 linked steps of 20 m and 0.1 ml each.
    const expected: QuantityExpectation = {distanceM: 560_000, distance: 'complete', fuelUsedL: 2.8099, fuel: 'complete', flags: [], cut: false};
    expectJournal(storage, root, expected);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    expectLedger(ledger(storage, root), expected);
  });
});

describe('REG-005/006 engine 1 junction coverage', () => {
  /** A stops at 1060 m with 60 m and 0.03 L; B's first reading is the junction, then B drives 20 m on 10 ml. */
  const readings = (b0: Partial<QuantityReading> = {}, b1: Partial<QuantityReading> = {}) => [s(0), s(1), s(2), s(3, {speedMps: 0}),
    s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false, ...b0}), s(1, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80, ...b1})];
  const same: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'complete', flags: [], cut: false};
  // Not the same save point: no fuel is credited across the junction, and fuel carries with the boundary bit.
  const boundary: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'partial', flags: ['fuelBoundary'], cut: false};
  it.each([
    ['an open join at the same save point with proof and a clean load window', 'open', readings(), false, same, 'complete'],
    ['an open join 25 ml of fuel away from the save point', 'open', readings({fuelL: 399.945}, {fuelL: 399.935}), false, boundary, 'partial'],
    ['an open join 0.1 m away from the save point', 'open', readings({x: 60.1}), false, boundary, 'partial'],
    ['a pre-join splice at the same save point', 'pre-join', readings(), false, same, 'complete'],
    ['an open join whose junction reading has no proof (F1a)', 'open', readings(), true, same, 'partial'],
    ['a retroactive join at the same save point (E6)', 'retro', readings(), false, same, 'partial']
  ] as const)('%s', async (_name, join, rs, proofless, expected, completeness) => {
    pausedOpen = true;
    const storage = await ws.open(), {root} = record(storage, rs, join, [], new Set(proofless ? [rs[4]] : []));
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe(completeness);
    expectJournal(storage, root, expected);
    expectLedger(ledger(storage, root), expected);
  });
});

describe('ET-112c engine 1 member whose samples before the join are not replayed', () => {
  // B stands at A's save point before its join, and its proof-bearing joining reading stands there too.
  const before = s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false}), joining = s(1, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0});
  // Live: the joining reading is the junction at A's save point, so A's 60 m and 0.03 L continue without flags.
  const same: QuantityExpectation = {distanceM: 60, distance: 'complete', fuelUsedL: 0.03, fuel: 'complete', flags: [], cut: false};
  // Retroactive: A's 60 m and 0.03 L kept with the gap bits, because the unreplayed reading could have moved the truck.
  const kept: QuantityExpectation = {distanceM: 60, distance: 'partial', fuelUsedL: 0.03, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false};
  it.each((['an engine-0 member', 'a member without a complete reading'] as const).flatMap(variant => (['pre-join', 'retro'] as const).map(join => [variant, join] as const)))(
    '%s with a %s join', async (variant, join) => {
      let storage = await ws.open();
      const {root, members} = record(storage, [s(0), s(1), s(2), s(3, {speedMps: 0})]);
      closeMember(storage, members[0]);
      if (variant === 'an engine-0 member') { ok(storage.close()); storage = await ws.open({accountingEngine: 0}); }
      const b = openMember(storage, 'B', join, []);
      ok(storage.appendSamples(b.script.session, [sampleOf(b, variant === 'an engine-0 member' ? before : {...before, odometerM: null}, false)], {uniqueSeconds: true}));
      b.previous = before;
      if (join === 'pre-join') ok(storage.appendSamples(b.script.session, [sampleOf(b, joining, true)], {uniqueSeconds: true}));
      else closeMember(storage, b);
      const expected = join === 'retro' ? kept : same;
      expectJournal(storage, root, expected);
      const found = ledger(storage, root);
      expectLedger(found, expected);
      expect(found.head!.flags).toBe(join === 'retro' ? GAP : 0);
      expect(found.reconstructed!.flags).toBe(found.head!.flags);
      expect(found.annotations).toEqual(join === 'retro' ? [GAP_ANNOTATION] : []);
      if (join === 'pre-join') return;
      const db = new Database(ws.database, {readonly: true});
      try {
        db.defaultSafeIntegers(true);
        const trip = (uuid: string) => db.prepare('SELECT id FROM trips WHERE trip_uuid=?').pluck().get(uuid);
        // The gap row stays at A's last reading; its annotation is at B's latest sample, in B's session, clock and trip.
        expect(db.prepare(`SELECT s.trip_ref FROM logical_progress p JOIN samples s ON s.id=p.anchor_sample_ref WHERE p.trip_ref=? AND p.sample_ref IS NULL`).pluck().all(trip(b.uuid)))
          .toEqual([trip(root)]);
        expect(db.prepare(`SELECT c.plugin_session_ref,c.source_clock_ref,c.trip_ref,c.end_monotonic_ns,c.end_utc_ms FROM completeness_intervals c
          WHERE json_extract(c.detail_json,'$.cause')='accounting-chain-break'`).all()).toEqual([{
          plugin_session_ref: db.prepare('SELECT id FROM plugin_sessions WHERE plugin_session_uuid=?').pluck().get(b.script.session),
          source_clock_ref: db.prepare('SELECT id FROM clocks WHERE clock_uuid=?').pluck().get(b.script.clockId),
          trip_ref: trip(b.uuid), end_monotonic_ns: ns(before.t).padStart(20, '0'), end_utc_ms: 1_000n}]);
      } finally { db.close(); }
    });
  it('lets the first complete reading decide after a live join at the opening event and samples without recording input', async () => {
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1), s(2), s(3, {speedMps: 0})]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'open', []);
    for (const t of [0, 1]) {
      const bare: SampleInput = {...sampleOf(b, s(t, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0}), false)};
      delete bare.recording;
      ok(storage.appendSamples(b.script.session, [bare], {uniqueSeconds: true}));
    }
    // B's first recorded reading is the junction at A's save point; then B drives 20 m on 10 ml.
    const k2 = s(2, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false}), k3 = s(3, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80});
    ok(storage.appendSamples(b.script.session, [sampleOf(b, k2, true)], {uniqueSeconds: true}));
    b.previous = k2;
    ok(storage.appendSamples(b.script.session, [sampleOf(b, k3, true)], {uniqueSeconds: true}));
    const expected: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'complete', flags: [], cut: false};
    expectJournal(storage, root, expected);
    const found = ledger(storage, root);
    expectLedger(found, expected);
    expect(found.head!.flags).toBe(F.linked);
    expect(found.reconstructed!.flags).toBe(found.head!.flags);
    expect(found.annotations).toEqual([]);
  });
});
