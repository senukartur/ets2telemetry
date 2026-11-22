// ET-112c engine 1 distance and fuel in storage (REG-003, REG-005, REG-006, REG-008, REG-014): the hand-written corpus
// of tests/shared/quantity-scenarios.ts recorded through the storage API, live and equal to the read-only reconstruction,
// across live joins at the opening event, joins after pre-join samples (the splice) and retroactive joins. Origin:
// synthetic; every expected value is written by hand in the corpus or below. ET-112g2 adds a legacy engine-0 group
// recalculated with engine 1 (upgradeQuantities) whose rollback must read engine-1 rows only. ET-112j (REG-002) adds the
// paused within-session reconnect, whose junction at the same save point keeps the recording coverage. ET-112k adds the
// junction that waits at the same save point for the reload's later admitted proof.
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MAX_SAMPLE_BATCH, type SampleInput, type Storage, type TripEffect} from '../../packages/storage/src';
import {pausedReconnect, validCoverage} from '../../packages/storage/src/sqlite/logical-coverage';
import {revise} from '../../packages/storage/src/sqlite/logical-trips';
import {reconstructQuantities, SPLICE_SAMPLE_LIMIT, upgradeQuantities} from '../../packages/storage/src/sqlite/quantities';
import {mapUploadProjection, UPLOAD_PAGE_KINDS, type UploadProjectionPage} from '../../packages/storage/src/upload-projection';
import {attachTripUuidFor, QUANTITY_FLAGS, tripUuidFor, type ProfileObservation, type QuantityPoint} from '../../packages/telemetry-core/src';
import {validateJournalTripDetail} from '../../packages/contracts/src/journal';
import type {EventRecord} from '../../packages/contracts/src/protocol-v1';
import {EUR, USD} from '../shared/journal-seed';
import {CLOCK_A, CLOCK_B, INCIDENT_QUANTITIES, incidentReadings, QUANTITY_SCENARIOS, s, type QuantityEvent, type QuantityExpectation, type QuantityFlagName,
  type QuantityReading} from '../shared/quantity-scenarios';
import {ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, job, money, r, Script} from '../shared/trip-messages';
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

it.each([
  {name: 'diesel after driving away', powertrain: 'diesel', levels: [100, 120, 160, 120, 130], expected: 30, droveAway: true},
  {name: 'charge at the same odometer', powertrain: 'electric', levels: [20, 30, 50, 30, 36], expected: 16},
  {name: 'charge when the saved level was not sampled', powertrain: 'electric', levels: [20, 30, 50, 31, 36], expected: 5},
  {name: 'charge after restarting the game', powertrain: 'electric', levels: [20, 30, 50, 30, 36], expected: 16, restart: true}
] as const)('keeps the measured part of a refill across a save load: $name', async ({powertrain, levels: [before, saved, discarded, loaded, after], expected, ...scenario}) => {
  const storage = await ws.open(), member = openMember(storage, 'A', 'root', []);
  const append = (owner: Member, reading: QuantityReading) => {
    ok(storage.appendSamples(owner.script.session, [sampleOf(owner, reading, true)], {uniqueSeconds: true}));
    owner.previous = reading;
  };
  const mark = (owner: Member, gameClockId: string, measurements: [number, number][], addedLiters: number): TripEffect => ({
    kind: 'completeness.add', interval: {kind: 'discontinuity', tripUuid: owner.uuid, detail: {
      annotation: true, cause: 'refuel', powertrain, addedLiters, atMonotonicNs: ns(measurements[1][0]),
      readingClock: owner.script.clockId, readingGameClock: gameClockId, refuelReadings: measurements.map(([time, level]) => [ns(time), level])
    }}
  });
  const pump = {odometerM: 1_000, x: 0, speedMps: 0};
  append(member, s(0, {...pump, fuelL: before}));
  append(member, s(1, {...pump, fuelL: saved}));
  append(member, s(2, {...pump, fuelL: discarded}));
  if ('droveAway' in scenario) append(member, s(3, {fuelL: discarded - 1}));
  const first = mark(member, GAME_CLOCK_1, [[0, before], [1, saved], [2, discarded]], discarded - before);
  ok(storage.commitEvent({message: member.script.event(r.fined()), effects: [first]}));
  expect(validateJournalTripDetail(ok(storage.journalTrip(member.uuid))).refuels).toEqual({
    dieselL: powertrain === 'diesel' ? discarded - before : 0, electricKWh: powertrain === 'electric' ? discarded - before : 0, omitted: false
  });

  let resumed = member, t = 4;
  if ('restart' in scenario) { closeMember(storage, member); resumed = openMember(storage, 'B', 'open', []); t = 0; }
  append(resumed, s(t, {...pump, member: resumed.member, fuelL: loaded, gameClock: CLOCK_B, linked: false}));
  append(resumed, s(t + 1, {...pump, member: resumed.member, fuelL: after, gameClock: CLOCK_B}));
  const second = mark(resumed, GAME_CLOCK_2, [[t, loaded], [t + 1, after]], after - loaded);
  const wrongClock = mark(resumed, GAME_CLOCK_1, [[t, loaded], [t + 1, after]], after - loaded);
  const legacy: TripEffect = {kind: 'completeness.add', interval: {kind: 'discontinuity', tripUuid: resumed.uuid,
    detail: {annotation: true, cause: 'refuel', powertrain, addedLiters: 42, atMonotonicNs: ns(1)}}};
  ok(storage.commitEvent({message: resumed.script.event(r.fined()), effects: [second, wrongClock, legacy]}));

  const detail = validateJournalTripDetail(ok(storage.journalTrip(member.uuid)));
  expect(detail.refuels).toEqual({dieselL: powertrain === 'diesel' ? expected : 0, electricKWh: powertrain === 'electric' ? expected : 0, omitted: true});
  const history = ok(storage.journalIntervals(member.uuid, {limit: 100})).intervals;
  expect(history.filter(interval => interval.cause === 'refuel').map(interval => interval.detail?.addedLiters))
    .toEqual([discarded - before, after - loaded, after - loaded, 42]);
});

describe('Journal refill verification limits', () => {
  function markRefill(storage: Storage, member: Member) {
    ok(storage.recordCompleteness(member.script.session, {kind: 'discontinuity', tripUuid: member.uuid, detail: {
      annotation: true, cause: 'refuel', powertrain: 'diesel', addedLiters: 10, atMonotonicNs: ns(1),
      readingClock: member.script.clockId, readingGameClock: GAME_CLOCK_1, refuelReadings: [[ns(0), 100], [ns(1), 110]]
    }}));
  }

  it('keeps the original amount when a new trip has no accounting head', async () => {
    const storage = await ws.open(), member = openMember(storage, 'A', 'root', []);
    markRefill(storage, member);
    const detail = validateJournalTripDetail(ok(storage.journalTrip(member.uuid)));
    expect(detail.exportBounds.snapshot).toBeDefined();
    expect(detail.exportBounds.accountingHead).toBeNull();
    expect(detail.refuels).toEqual({dieselL: 0, electricKWh: 0, omitted: true, unavailableReason: 'retained-path-unproven'});
    expect(detail.intervals.items).toContainEqual(expect.objectContaining({cause: 'refuel', detail: expect.objectContaining({addedLiters: 10})}));
  });

  it('withholds the subtotal after a load outside the recorded path, even with no money events', async () => {
    const storage = await ws.open();
    const {root, members: [member]} = record(storage, [s(0, {fuelL: 100}), s(1, {fuelL: 110})]);
    markRefill(storage, member);
    expect(ok(storage.journalTrip(root)).refuels?.dieselL).toBe(10);
    const loaded = s(2, {odometerM: 900, x: -100, fuelL: 100, gameClock: CLOCK_B, linked: false});
    ok(storage.appendSamples(member.script.session, [sampleOf(member, loaded, true)], {uniqueSeconds: true}));
    const detail = validateJournalTripDetail(ok(storage.journalTrip(root)));
    expect(detail.exportBounds.accountingHead).toEqual(expect.any(String));
    expect(detail.refuels).toEqual({dieselL: 0, electricKWh: 0, omitted: true, unavailableReason: 'retained-path-unproven'});
  });

  it('withholds the subtotal at 5,001 annotations and keeps the timeline pageable', async () => {
    let storage = await ws.open();
    const {root, members: [member]} = record(storage, [s(0, {fuelL: 100}), s(1, {fuelL: 110})]);
    markRefill(storage, member);
    ok(storage.close());
    const db = new Database(ws.database);
    try {
      const copies = db.prepare(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<4999)
        INSERT INTO completeness_intervals (plugin_session_ref,trip_ref,kind,detail_json,created_utc_ms)
        SELECT c.plugin_session_ref,c.trip_ref,c.kind,'{"annotation":true,"cause":"refuel","addedLiters":1}',c.created_utc_ms
        FROM n,completeness_intervals c WHERE c.id=(SELECT min(id) FROM completeness_intervals WHERE json_extract(detail_json,'$.cause')='refuel')`).run();
      expect(copies.changes).toBe(4_999);
    } finally { db.close(); }
    storage = await ws.open();
    // The next sample revises the snapshot with the new interval watermark.
    ok(storage.appendSamples(member.script.session, [sampleOf(member, s(2, {fuelL: 110}), true)], {uniqueSeconds: true}));
    expect(ok(storage.journalTrip(root)).refuels).toEqual({dieselL: 10, electricKWh: 0, omitted: true});
    markRefill(storage, member);
    const detail = validateJournalTripDetail(ok(storage.journalTrip(root)));
    expect(detail.refuels).toEqual({dieselL: 0, electricKWh: 0, omitted: true, unavailableReason: 'annotation-limit'});
    expect(detail.intervals.total).toBe(5_001);
    expect(detail.intervals.items[0].detail?.addedLiters).toBe(10);
    expect(ok(storage.journalIntervals(root, {limit: 100, cursor: detail.intervals.nextCursor!})).intervals).toHaveLength(100);
  });
});

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
/** ET-112e: the Journal name of each cumulative bit, written by hand from the contract. */
const JOURNAL_NAMES: Record<QuantityFlagName, ['distance' | 'fuel', 'breaks' | 'quality', string]> = {
  distanceTruck: ['distance', 'breaks', 'truck-change'], distanceJump: ['distance', 'breaks', 'position-jump'], distanceTransfer: ['distance', 'breaks', 'transfer'],
  distanceHole: ['distance', 'breaks', 'reading-hole'], distanceGap: ['distance', 'breaks', 'recording-gap'], distanceUnproven: ['distance', 'breaks', 'unsupported'],
  distanceBridged: ['distance', 'quality', 'bridged'], distanceRestored: ['distance', 'quality', 'restored'], fuelTruck: ['fuel', 'breaks', 'truck-change'],
  fuelHole: ['fuel', 'breaks', 'reading-hole'], fuelTransfer: ['fuel', 'breaks', 'transfer'], fuelBoundary: ['fuel', 'breaks', 'recording-boundary'],
  fuelUnproven: ['fuel', 'breaks', 'unsupported'], fuelRefuelExcluded: ['fuel', 'quality', 'refuel-excluded']
};
/**
 * The expected trip provenance: the corpus statuses with the names of the expected bits in contract order. A complete
 * trip distance by the odometer difference has no distance breaks.
 */
function accountingOf(expected: QuantityExpectation) {
  const names = (quantity: 'distance' | 'fuel', kind: 'breaks' | 'quality') => (Object.keys(JOURNAL_NAMES) as QuantityFlagName[])
    .filter(flag => expected.flags.includes(flag) && JOURNAL_NAMES[flag][0] === quantity && JOURNAL_NAMES[flag][1] === kind)
    .filter(() => !(expected.trip && quantity === 'distance' && kind === 'breaks')).map(flag => JOURNAL_NAMES[flag][2]);
  return {engine: 1, distance: {status: expected.trip?.distance ?? expected.distance, breaks: names('distance', 'breaks'), quality: names('distance', 'quality')},
    fuel: {status: expected.fuel, breaks: names('fuel', 'breaks'), quality: names('fuel', 'quality')}};
}
/**
 * The Journal shows the trip distance (the head value, or the odometer difference where it covers a break), the head's
 * fuel used and their provenance, the same on the list row and the detail; a cut or an unproven quantity marks the money
 * totals incomplete.
 */
function expectJournal(storage: Storage, root: string, expected: QuantityExpectation) {
  const detail = validateJournalTripDetail(ok(storage.journalTrip(root))), distanceM = expected.trip?.distanceM ?? expected.distanceM;
  expect(detail.trip.observedDistanceM).toEqual(distanceM === null ? absent : {available: true, value: near(distanceM)});
  expect(detail.trip.fuelUsedL).toEqual(expected.fuelUsedL === null ? absent : {available: true, value: near(expected.fuelUsedL)});
  expect(detail.money.incomplete).toBe(expected.cut || expected.distanceM === null);
  expect(detail.trip.accounting).toEqual(accountingOf(expected));
  const listed = ok(storage.journalTrips()).trips.find(trip => trip.tripUuid === root)!;
  expect([listed.accounting, listed.observedDistanceM, listed.fuelUsedL]).toEqual([detail.trip.accounting, detail.trip.observedDistanceM, detail.trip.fuelUsedL]);
}
async function recorded(readings: readonly QuantityReading[], expected: QuantityExpectation, join: Join = 'open', events: readonly QuantityEvent[] = []) {
  const storage = await ws.open(), {root} = record(storage, readings, join, events);
  expectJournal(storage, root, expected);
  const found = ledger(storage, root);
  expectLedger(found, expected);
  return found;
}

describe('REG-008 retained money after a saved-game cut', () => {
  it.each(['physical match', 'odometer only', 'same-session suffix', 'two cuts', 'empty subtotal'] as const)('shows the bounded fine subtotal (%s)', async variant => {
    const storage = await ws.open(), a = openMember(storage, 'A', 'root', []);
    const append = (m: Member, reading: QuantityReading) => {
      ok(storage.appendSamples(m.script.session, [sampleOf(m, reading, true)], {uniqueSeconds: true}));
      m.previous = reading;
    };
    const charge = (m: Member, t: number, record: EventRecord, knownTime = true) => {
      const at = BigInt(ns(t)) + 1_000_000n;
      const message = m.script.event(record, {advanceMs: Number((at - m.at) / 1_000_000n)});
      if (!knownTime) message.data.occurred.monotonicNs = {available: false, reason: 'not-observed'};
      m.at = at;
      ok(storage.commitEvent({message, effects: [{kind: 'event.attribute', tripUuid: m.uuid, attribution: 'trip'}]}));
    };
    const fine = (m: Member, t: number, amount: string, knownTime = true) => {
      const record = r.fined(amount) as Extract<EventRecord, {type: 'player.fined'}>;
      record.amount = money(amount, 's64', EUR);
      charge(m, t, record, knownTime);
    };
    append(a, s(0));
    fine(a, 0.5, '100'); // Proven before the save only when its physical point is retained.
    append(a, s(1));
    fine(a, 1.5, '900'); // Between the safe prefix boundary and the save.
    append(a, s(2, {speedMps: 0}));
    fine(a, 2.5, '800'); // In the abandoned suffix of the original drive.
    append(a, s(3));
    append(a, s(4));
    const x = variant === 'odometer only' || variant === 'empty subtotal' ? 50.7 : 40;
    append(a, s(5, {odometerM: 1040, fuelL: 399.98, x, speedMps: 0, gameClock: CLOCK_B, linked: false}));
    fine(a, 5, '600'); // The same source instant as the loaded sample has no strict order.
    if (variant === 'two cuts') fine(a, 5.5, '50'); // On the new path after the first load and before the second save.
    append(a, s(6, {odometerM: 1060, fuelL: 399.97, x: x + 20, speedMps: variant === 'two cuts' ? 20 : 0, gameClock: CLOCK_B}));
    let terminal = a;
    if (variant === 'same-session suffix') {
      fine(a, 6.1, '500', false);
      fine(a, 6.2, '300');
      fine(a, 6.3, '400');
      const ferry = r.ferry() as Extract<EventRecord, {type: 'player.use.ferry'}>;
      charge(a, 6.4, {...ferry, amount: money('125', 's64', USD)});
      const train = r.train() as Extract<EventRecord, {type: 'player.use.train'}>;
      charge(a, 6.5, {...train, amount: absent});
    } else if (variant === 'two cuts') {
      fine(a, 6.1, '500'); // Kept by the first cut alone, but not proven by the second.
      append(a, s(7, {odometerM: 1080, fuelL: 399.96, x: 80, speedMps: 0, gameClock: CLOCK_B}));
      append(a, s(8, {odometerM: 1100, fuelL: 399.95, x: 100, gameClock: CLOCK_B}));
      append(a, s(9, {odometerM: 1080, fuelL: 399.96, x: 80, speedMps: 0, gameClock: 'third-clock', linked: false}));
      fine(a, 9.1, '300');
      fine(a, 9.2, '400');
    } else if (variant !== 'empty subtotal') {
      closeMember(storage, a);
      const b = openMember(storage, 'B', 'open', []);
      append(b, s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: x + 20, speedMps: 0, linked: false}));
      // New capture clock and overlapping numeric source times. The two amounts belong to the later member.
      fine(b, 0.1, '300');
      fine(b, 0.2, '400');
      terminal = b;
    }
    deliver(storage, terminal);
    const detail = validateJournalTripDetail(ok(storage.journalTrip(a.uuid)));
    if (variant === 'empty subtotal') {
      expect(detail.money).toEqual({incomplete: true, totals: [], unavailable: []});
      storage.close();
      return;
    }
    const [raw, count, eventCount] = variant === 'odometer only' ? ['700', 2, 6] : variant === 'two cuts' ? ['850', 4, 8]
      : ['800', 3, variant === 'same-session suffix' ? 7 : 6];
    const mixed = variant === 'same-session suffix';
    expect(detail.money).toEqual({incomplete: true, totals: [], unavailable: [], retainedSubtotal: {
      totals: [{category: 'fine', currency: EUR, sdkType: 's64', raw, count},
        ...(mixed ? [{category: 'ferry', currency: USD, sdkType: 's64', raw: '125', count: 1}] : [])],
      unavailable: mixed ? [{category: 'train', reason: 'not-observed', count: 1}] : []
    }});
    expect(ok(storage.journalEvents(a.uuid, {limit: 100})).events.filter(event => event.type === 'player.fined')).toHaveLength(eventCount);
    storage.close();
  });
  it.each(['open', 'retro'] as const)('includes an earlier member before a physical save match after a %s join', async join => {
    const storage = await ws.open(), a = openMember(storage, 'A', 'root', []);
    const append = (m: Member, reading: QuantityReading, withProof: boolean) => {
      ok(storage.appendSamples(m.script.session, [sampleOf(m, reading, withProof)], {uniqueSeconds: true}));
      m.previous = reading;
    };
    const fine = (m: Member, t: number, amount: string) => {
      const at = BigInt(ns(t)) + 1_000_000n;
      const message = m.script.event(r.fined(amount), {advanceMs: Number((at - m.at) / 1_000_000n)});
      m.at = at;
      ok(storage.commitEvent({message, effects: [{kind: 'event.attribute', tripUuid: m.uuid, attribution: 'trip'}]}));
    };
    append(a, s(0), true);
    fine(a, 0.5, '50');
    append(a, s(1, {speedMps: 0}), true);
    closeMember(storage, a);
    const b = openMember(storage, 'B', join, []), admit = join === 'open';
    const point = (i: number, overrides: Partial<QuantityReading> = {}) => s(i + 1, {t: i, member: 'B', ...overrides});
    append(b, point(0, {speedMps: 0, linked: false}), admit);
    append(b, point(1), admit);
    append(b, point(2, {speedMps: 0}), admit);
    fine(b, 2.5, '900');
    append(b, point(3), admit);
    append(b, point(4, {odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, gameClock: CLOCK_B, linked: false}), admit);
    fine(b, 4.5, '300');
    if (join === 'retro') closeMember(storage, b); else deliver(storage, b);
    const detail = ok(storage.journalTrip(a.uuid));
    expect(detail.window.sourceCount).toBe(2);
    expect(detail.money.retainedSubtotal?.totals).toEqual([expect.objectContaining({category: 'fine', raw: '350', count: 2})]);
    storage.close();
  });
  it.each([false,true])('keeps money unavailable when the path exceeds its bound (visible cut %s)', async visibleCut => {
    const storage = await ws.open(), a = openMember(storage, 'A', 'root', []);
    const rows = Array.from({length: 259}, (_, i) => {
      // Each game-clock change with forward odometer movement creates a separate retained run.
      const reading = s(i, {gameClock: i % 2 === 0 ? CLOCK_A : CLOCK_B, linked: false});
      return sampleOf(a, reading, true);
    });
    if (visibleCut) rows.push(sampleOf(a, s(259, {odometerM: 6140, fuelL: 397.43, x: 5140, gameClock: 'late-cut', linked: false}), true));
    ok(storage.appendSamples(a.script.session, rows, {uniqueSeconds: true}));
    const fine = a.script.event(r.fined(), {advanceMs: 300_000});
    ok(storage.commitEvent({message: fine, effects: [{kind: 'event.attribute', tripUuid: a.uuid, attribution: 'trip'}]}));
    deliver(storage, a);
    const detail = ok(storage.journalTrip(a.uuid));
    expect(detail.money).toEqual({incomplete: true, totals: [], unavailable: []});
    expect(detail.trip.accounting?.distance.quality.includes('restored')).toBe(visibleCut);
    storage.close();
  });
});

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
  // REG-002: A drives 1000 to 1020 m and pauses 0.2 s later for almost three minutes. The first reading after the
  // resume is 6 ms after the start, 2 m on with unchanged fuel, without the recorder link (a paused reading ends it).
  // Protocol v1 lets a snapshot's state lead the plugin's event store, and the emergency journal stores each sample
  // right after its snapshot, so that reading can reach storage before its `simulation.started` event. Either order is
  // 0.2 s of running time, no reading hole: both quantities stay complete, and the reconstruction equals the live head.
  it.each(['start first', 'reading first'] as const)('treats a pause as no reading hole when the resumed reading is stored %s', async order => {
    const storage = await ws.open(), a = openMember(storage, 'A', 'root', []);
    const append = (reading: QuantityReading) => { ok(storage.appendSamples(a.script.session, [sampleOf(a, reading, true)], {uniqueSeconds: true})); a.previous = reading; };
    const lifecycle = (record: EventRecord, t: number, simulation: 'running' | 'paused') => {
      const at = BigInt(ns(t)) + 1_000_000n;
      ok(storage.commitEvent({message: a.script.event(record, {simulation, advanceMs: Number((at - a.at) / 1_000_000n)})}));
      a.at = at;
    };
    append(s(0));
    append(s(1));
    lifecycle(r.paused(), 1.2, 'paused');
    const resumed = s(173, {odometerM: 1022, x: 22, fuelL: 399.99, linked: false});
    if (order === 'start first') { lifecycle(r.started(), 172.994, 'running'); append(resumed); }
    else { append(resumed); lifecycle(r.started(), 172.994, 'running'); }
    append(s(174, {odometerM: 1042, x: 42, fuelL: 399.98}));
    const expected: QuantityExpectation = {distanceM: 42, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: [], cut: false};
    expectJournal(storage, a.uuid, expected);
    const found = ledger(storage, a.uuid);
    expectLedger(found, expected);
    expect(found.annotations).toEqual([]);
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
  return {moneyIncomplete: projection.facts.moneyIncomplete, reasons: mapped.summary.snapshot.evidence.reasons, facts: projection.facts.accounting, summary: mapped.summary.snapshot.accounting,
    observedDistance: mapped.summary.snapshot.observedDistance};
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
    // ET-112e: an engine-0 group carries no provenance on the list or the detail.
    expect(ok(storage.journalTrips()).trips[0]).not.toHaveProperty('accounting');
    expect(ok(storage.journalTrip(a.uuid)).trip).not.toHaveProperty('accounting');
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
  // ET-113: the same head row gives the v1.2 accounting status; an unavailable quantity and an engine-0 group are unknown.
  it.each([
    ['a partial engine-1 distance', 1, scenario('Q13').readings, true, {distance: 'partial', fuel: 'complete'}],
    ['a partial engine-1 fuel', 1, scenario('Q2-linked').readings, true, {distance: 'complete', fuel: 'partial'}],
    ['complete engine-1 quantities', 1, scenario('Q1').readings, false, {distance: 'complete', fuel: 'complete'}],
    // The odometer difference covers the reading hole; fuel stays partial.
    ['an unlinked reading hole', 1, scenario('Q2-unlinked').readings, true, {distance: 'complete', fuel: 'partial'}],
    ['unavailable engine-1 quantities', 1, scenario('Q9').readings, true, {distance: 'unknown', fuel: 'unknown'}],
    // Four linked readings: complete engine-0 accounting, whose rows carry no quantity flags.
    ['engine 0', 0, [s(0), s(1), s(2), s(3)], false, {distance: 'unknown', fuel: 'unknown'}]
  ] as const)('reports accounting-unavailable to the upload only for a partial or unavailable quantity: %s', async (_name, accountingEngine, readings, incomplete, accounting) => {
    gameOrigin = true;
    // Dashboard accepts liters only when the recorded model establishes diesel. Keep the corpus's truck changes.
    const dieselReadings = readings.map(reading => ({...reading, truck: JSON.stringify([
      {state: 'value', value: 'fixture-brand'},
      {state: 'value', value: 'vehicle.fixture.diesel'},
      {state: 'value', value: reading.truck}
    ])}));
    const storage = await ws.open({accountingEngine, purpose: 'history'}), {members} = record(storage, dieselReadings);
    deliver(storage, members[0]);
    const found = upload(storage, members[0].uuid);
    expect(found.moneyIncomplete).toBe(incomplete);
    expect(found.reasons.includes('accounting-unavailable')).toBe(incomplete);
    expect(found.facts).toEqual(accounting);
    expect(found.summary).toEqual(accounting);
  });
  // A delivered trip whose readings stopped for 8 s mid-trip without the recorder link, as after a reconnect: the upload
  // carries the whole odometer difference 1220 - 1000 m as complete, not the 60 m before the hole as partial.
  it('uploads the odometer difference across a reading hole as complete distance', async () => {
    gameOrigin = true;
    const storage = await ws.open({purpose: 'history'}), {members} = record(storage, scenario('Q2-unlinked').readings);
    deliver(storage, members[0]);
    const found = upload(storage, members[0].uuid);
    expect(found.observedDistance).toEqual({available: true, value: 220, unit: 'm'});
    expect(found.summary?.distance).toBe('complete');
  });
  // Each guard of the odometer difference, made to fail on Q2-unlinked's stored ledger: the trip then keeps the ledger's
  // 60 m before the hole as partial. `first` is the row the head's prefix points at: the end of the first run.
  it.each([
    ['a lower end odometer', 'UPDATE samples SET odometer_m=900 WHERE id=@anchor'],
    ['a first run that is itself a gap point', 'UPDATE logical_progress SET quantity_flags=quantity_flags|16 WHERE id=@first'],
    ['a different truck at the two ends', `INSERT INTO logical_trucks(identity_key) VALUES('tampered');
      UPDATE logical_progress SET truck_ref=(SELECT id FROM logical_trucks WHERE identity_key='tampered') WHERE id=@first`],
    ['a prefix cycle, cut off at 256 steps', 'UPDATE logical_progress SET prefix_ref=@head WHERE id=@first']
  ] as const)('keeps the ledger subtotal when the odometer difference is not supported: %s', async (_name, tamper) => {
    let storage = await ws.open();
    const {root} = record(storage, scenario('Q2-unlinked').readings);
    ok(storage.close());
    const db = new Database(ws.database);
    try {
      const {logical} = db.prepare('SELECT m.logical_ref AS logical FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?').get(root) as {logical: number};
      const head = db.prepare('SELECT p.id,p.prefix_ref,p.anchor_sample_ref FROM logical_trips l JOIN logical_progress p ON p.id=l.progress_head WHERE l.id=?').get(logical) as Record<string, number>;
      const values = {head: head.id, first: head.prefix_ref, anchor: head.anchor_sample_ref};
      for (const sql of tamper.split(';')) db.prepare(sql).run(...(sql.includes('@') ? [values] : []));
    } finally { db.close(); }
    storage = await ws.open();
    const detail = validateJournalTripDetail(ok(storage.journalTrip(root)));
    expect(detail.trip.observedDistanceM).toEqual({available: true, value: near(60)});
    expect(detail.trip.accounting?.distance).toEqual({status: 'partial', breaks: ['reading-hole'], quality: []});
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
  it('keeps the ledger subtotal partial and shows the odometer difference when a joining member recorded more than SPLICE_SAMPLE_LIMIT samples before its join', {timeout: 600_000}, async () => {
    expect(SPLICE_SAMPLE_LIMIT).toBe(28_800);
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'pre-join', []);
    longMember(storage, b, SPLICE_SAMPLE_LIMIT + 2);
    // A's 20 m and 0.01 L kept at B's last reading before the join, with the gap bits; B's linked joining reading adds 20 m and 0.1 ml.
    // The trip shows B's last odometer 1020 + 20 × 28,801 = 577,040 m minus A's start of 1,000 m.
    const expected: QuantityExpectation = {distanceM: 40, distance: 'partial', fuelUsedL: 0.0101, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false,
      trip: {distanceM: 576_040, distance: 'complete'}};
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
  it('keeps the ledger subtotal partial and shows the odometer difference when a retroactively joined member recorded more than SPLICE_SAMPLE_LIMIT samples', {timeout: 600_000}, async () => {
    const storage = await ws.open(), {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'retro', []);
    longMember(storage, b, SPLICE_SAMPLE_LIMIT + 2, false);
    deliver(storage, b);
    expect(resolveAt(storage, b, SPLICE_SAMPLE_LIMIT + 1_000)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    // A's 20 m and 0.01 L kept at B's last reading, with the gap bits; nothing of B is replayed. The trip shows B's
    // last odometer 577,040 m minus A's start of 1,000 m.
    const expected: QuantityExpectation = {distanceM: 20, distance: 'partial', fuelUsedL: 0.01, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false,
      trip: {distanceM: 576_040, distance: 'complete'}};
    expectJournal(storage, root, expected);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    const found = ledger(storage, root);
    expectLedger(found, expected);
    expect(found.head!.flags).toBe(GAP);
    expect(found.reconstructed!.flags).toBe(found.head!.flags);
    expect(found.unknown).toBe(0n);
    expect(found.annotations).toEqual([GAP_ANNOTATION]);
  });
  /**
   * Two closed pending segments of B's session after A's s(0) and s(1): B with one reading at A's save point, delivered,
   * then `second` with 28,800 readings of its own, delivered.
   */
  function pendingSegments(storage: Storage) {
    const {root, members} = record(storage, [s(0), s(1)]);
    closeMember(storage, members[0]);
    const b = openMember(storage, 'B', 'retro', []);
    longMember(storage, b, 1, false);
    deliver(storage, b);
    const message = b.script.event(r.jobConfigured(job())), second = tripUuidFor(b.script.session, message.data.eventSeq);
    ok(storage.commitEvent({message, effects: [{kind: 'trip.open', tripUuid: second, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', startedUtcMs: 3000,
      recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: second, attribution: 'trip'}]}));
    longMember(storage, {...b, uuid: second, previous: undefined}, SPLICE_SAMPLE_LIMIT, false, 1);
    ok(storage.commitEvent({message: b.script.event(r.delivered(), {advanceMs: 1_000}), effects: [{kind: 'trip.close', tripUuid: second, outcome: 'delivered', closeReason: 'outcome',
      outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: 4000}]}));
    return {root, b, second};
  }
  // B continues A at A's save point: A's 20 m and 0.01 L, complete.
  const continued: QuantityExpectation = {distanceM: 20, distance: 'complete', fuelUsedL: 0.01, fuel: 'complete', flags: [], cut: false};
  // Budget: 28,801 recorded samples; the second resolve call charges 28,800. It bounds work, not timing.
  it('resolves the first pending segment of a call and leaves one that would exceed SPLICE_SAMPLE_LIMIT to the next call', {timeout: 600_000}, async () => {
    const storage = await ws.open(), {root, b} = pendingSegments(storage);
    // 1 + 28,800 exceeds the budget: the second segment waits for the next call.
    expect(resolveAt(storage, b, 60_000)).toEqual({status: 'resolved', resolved: 1, remaining: 1});
    expect(resolveAt(storage, b, 60_000)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    expectJournal(storage, root, continued);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    expectLedger(ledger(storage, root), continued);
  });
  // Budget: 28,805 recorded samples; one appendSamples transaction charges 1 and defers 28,800. It bounds work, not timing.
  it('shares one replay budget among the resolutions of one appendSamples transaction and defers the rest to a later call', {timeout: 600_000}, async () => {
    let storage = await ws.open();
    const {root, b, second} = pendingSegments(storage);
    // The session's next trip R; each reading of one batch carries proof, so each one runs I4.
    const message = b.script.event(r.jobConfigured(job())), open = tripUuidFor(b.script.session, message.data.eventSeq);
    ok(storage.commitEvent({message, effects: [{kind: 'trip.open', tripUuid: open, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', startedUtcMs: 5000,
      recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: open, attribution: 'trip'}]}));
    const r0: Member = {...b, uuid: open, previous: undefined}, batch: SampleInput[] = [];
    for (let i = 0; i < 3; i++) {
      const reading = s(30_000 + i, {member: 'B', odometerM: 5000 + 20 * i, x: 5000 + 20 * i, linked: i > 0});
      batch.push(sampleOf(r0, reading, true));
      r0.previous = reading;
    }
    expect(ok(storage.appendSamples(b.script.session, batch, {uniqueSeconds: true}))).toEqual({appended: 3, skipped: 0});
    // The batch resolved B (1 sample) and deferred the second segment: the next call resolves it and nothing is left.
    expect(resolveAt(storage, b, 60_000)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    const last = s(30_003, {member: 'B', odometerM: 5060, x: 5060});
    ok(storage.appendSamples(b.script.session, [sampleOf(r0, last, true)], {uniqueSeconds: true}));
    expectJournal(storage, root, continued);
    ok(storage.close());
    const db = new Database(ws.database, {readonly: true});
    try {
      const state = (uuid: string) => db.prepare('SELECT d.state FROM logical_membership_decisions d JOIN trips t ON t.id=d.trip_ref WHERE t.trip_uuid=?').pluck().get(uuid);
      expect(state(b.uuid)).toBe('joined');
      expect(state(second)).not.toBe('pending');
      expect(state(open)).not.toBe('pending');
    } finally { db.close(); }
    storage = await ws.open();
    expectLedger(ledger(storage, root), continued);
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

describe('ET-112c engine 1 captured pause before a reload', () => {
  // Engine 1 stores no paused endpoint: the reload's first complete reading is compared with A's last running sample.
  const stopped = [s(0), s(1), s(2), s(3, {speedMps: 0}), s(4, {odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0})];
  const moving = [s(0), s(1), s(2), s(3, {speedMps: 1})];
  // A stood still for a second before the pause: the reload at the paused point is A's save point, then B drives 20 m on 10 ml.
  const resumed: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'complete', flags: [], cut: false};
  // A moved 1 m after its last sample: the reload at 1061 m is a forward gap; A's 60 m and 0.03 L carry, then B adds 20 m and 10 ml.
  // The trip shows the odometer difference 1081 - 1000 m, which includes that metre.
  const gapped: QuantityExpectation = {distanceM: 80, distance: 'partial', fuelUsedL: 0.04, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false,
    trip: {distanceM: 81, distance: 'complete'}};
  it.each([
    ['stopped for a second before the pause', stopped, 4.5, {odometerM: 1060, x: 60}, resumed, 'complete'],
    ['moving at 1 m/s in the last second before the pause', moving, 3.5, {odometerM: 1061, x: 61}, gapped, 'partial']
  ] as const)('%s', async (_name, readings, pausedAt, paused, expected, completeness) => {
    pausedOpen = true;
    const storage = await ws.open(), a = openMember(storage, 'A', 'root', []);
    for (const reading of readings) { ok(storage.appendSamples(a.script.session, [sampleOf(a, reading, true)], {uniqueSeconds: true})); a.previous = reading; }
    const at = BigInt(ns(pausedAt));
    ok(storage.commitEvent({message: a.script.event(r.paused(), {simulation: 'paused', advanceMs: Number((at - a.at) / 1_000_000n)})}));
    ok(storage.openAttachedTrip({pluginSessionId: a.script.session, nextEventSeq: a.script.next.toString(), job: job(), effects: [], observeTripUuid: a.uuid, profile: proof(a.script),
      sourceClockId: a.script.clockId, monotonicNs: (at + 1_000_000n).toString(), endpoint: {version: 1, simulation: 'paused', truck: 'T1', odometerM: paused.odometerM, fuelL: 399.97,
        speedMps: 0, gameClockId: gameClock(CLOCK_A), gameMinutes: '600', position: {x: paused.x, y: 0, z: 0}}}));
    closeMember(storage, a);
    const b = openMember(storage, 'B', 'open', []);
    for (const reading of [s(0, {member: 'B', ...paused, fuelL: 399.97, speedMps: 0, linked: false}),
      s(1, {member: 'B', odometerM: paused.odometerM + 20, x: paused.x + 20, fuelL: 399.96})]) {
      ok(storage.appendSamples(b.script.session, [sampleOf(b, reading, true)], {uniqueSeconds: true}));
      b.previous = reading;
    }
    expect(ok(storage.journalTrip(a.uuid)).trip.recordingCompleteness).toBe(completeness);
    expectJournal(storage, a.uuid, expected);
    const found = ledger(storage, a.uuid);
    expectLedger(found, expected);
    expect(found.reconstructed!.flags).toBe(found.head!.flags);
  });
});

describe('ET-112g2 a legacy engine-0 group recalculated with engine 1', () => {
  // A drives 1000 to 1100 m on one run; its reading at 1050 m has no fuel, so engine 1 holds there while engine 0 keeps
  // a self-anchored row of the same run. B then loads 1055 m, where no point matches: the newest retained engine-1 point
  // at or below 1055 m is A's 1040 m reading (0.02 L), so 100 - (1100 - 1055) = 55 m and 0.02 L with the boundary bit,
  // then B drives 20 + 20 m on 10 + 10 ml.
  const fuelless = s(3, {odometerM: 1050, x: 50, speedMps: 10});
  const a = [s(0), s(1), s(2), fuelless, s(4, {odometerM: 1060, x: 60, fuelL: 399.97, speedMps: 0}), s(5, {odometerM: 1080, x: 80, fuelL: 399.96}),
    s(6, {odometerM: 1100, x: 100, fuelL: 399.95})];
  const b = [s(0, {member: 'B', odometerM: 1055, x: 55, fuelL: 399.9, speedMps: 0, gameClock: CLOCK_B, linked: false}),
    s(1, {member: 'B', odometerM: 1075, x: 75, fuelL: 399.89, gameClock: CLOCK_B}), s(2, {member: 'B', odometerM: 1095, x: 95, fuelL: 399.88, gameClock: CLOCK_B})];
  const expected: QuantityExpectation = {distanceM: 95, distance: 'complete', fuelUsedL: 0.04, fuel: 'partial', flags: ['distanceRestored', 'fuelBoundary'], cut: true};
  /** Replays the closed engine-0 group of `uuid` with engine 1 and revises it, as the history repair's action does. */
  function upgrade(uuid: string) {
    const db = new Database(ws.database);
    try {
      db.defaultSafeIntegers(true);
      db.transaction(() => {
        const logical = db.prepare('SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?').pluck().get(uuid) as bigint;
        expect(upgradeQuantities(db, logical)).toEqual({status: 'upgraded'});
        revise(db, logical);
      })();
    } finally { db.close(); }
  }
  // The points of a rollback are engine-1 rows only: with A's engine-0 rows among them, the 1050 m row would be kept.
  it.each(['native', 'upgraded'] as const)('restores a later member\'s load inside the root\'s run from engine-1 rows only: %s root', async root => {
    let storage = await ws.open(root === 'upgraded' ? {accountingEngine: 0} : {});
    const m = openMember(storage, 'A', 'root', []);
    for (const reading of a) {
      const sample = sampleOf(m, reading, true);
      ok(storage.appendSamples(m.script.session, [reading === fuelless ? {...sample, fuel: absent} : sample], {uniqueSeconds: true}));
      m.previous = reading;
    }
    closeMember(storage, m);
    ok(storage.close());
    if (root === 'upgraded') upgrade(m.uuid);
    storage = await ws.open();
    const later = openMember(storage, 'B', 'open', []);
    for (const reading of b) { ok(storage.appendSamples(later.script.session, [sampleOf(later, reading, true)], {uniqueSeconds: true})); later.previous = reading; }
    expectJournal(storage, m.uuid, expected);
    expectLedger(ledger(storage, m.uuid), expected);
  });
  // B records with engine 1 in its own group until its proof joins it to A's engine-0 group, where nothing is spliced.
  // A: 1000 to 1060 m on 0.03 L, stopping at its save point. B starts there (the junction continues), drives 20 m on
  // 10 ml, then after an 8 s hole without the recorder link at 1240 m (both quantities break, hole bits) drives 20 m on
  // 10 ml more with its joining reading: 80 + 20 = 100 m and 0.04 + 0.01 = 0.05 L, both partial.
  it('annotates a joined engine-1 member\'s own break once when its engine-0 group is recalculated', async () => {
    let storage = await ws.open({accountingEngine: 0});
    const {root, members} = record(storage, [s(0), s(1), s(2), s(3, {speedMps: 0})]);
    closeMember(storage, members[0]);
    ok(storage.close());
    storage = await ws.open();
    const later = openMember(storage, 'B', 'pre-join', []);
    const readings = [s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false}), s(1, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80}),
      s(9, {member: 'B', odometerM: 1240, fuelL: 399.95, x: 240, linked: false}), s(10, {member: 'B', odometerM: 1260, fuelL: 399.94, x: 260})];
    readings.forEach((reading, index) => {
      ok(storage.appendSamples(later.script.session, [sampleOf(later, reading, index === readings.length - 1)], {uniqueSeconds: true}));
      later.previous = reading;
    });
    closeMember(storage, later);
    const engineOne = (annotation: Record<string, unknown>) => annotation.engine === 1;
    const hole = {annotation: true, cause: 'accounting-chain-break', version: 2, engine: 1, distanceFlags: F.distanceHole, fuelFlags: F.fuelHole};
    const before = ledger(storage, root);
    expect(before.engine).toBe(0n);
    // B's own chain annotated its hole when it was recorded (engine 0 annotates its own version 1 breaks).
    expect(before.annotations.filter(engineOne)).toEqual([hole]);
    upgrade(root);
    storage = await ws.open();
    const after = ledger(storage, root);
    expectLedger(after, {distanceM: 100, distance: 'partial', fuelUsedL: 0.05, fuel: 'partial', flags: ['distanceHole', 'fuelHole'], cut: false});
    expect(after.annotations.filter(engineOne)).toEqual([hole]);
  });
});

describe('REG-002/003 ET-112j paused within-session reconnect', () => {
  /**
   * One plugin session: A opens after a start and drives 1000 to 1060 m on 0.03 L, stopping there. The game pauses and
   * re-sends the same job, the truck and the trailer, and a timer reset closes A without an outcome. The consumer
   * reconnects, and the checkpoint's late-attach recording B opens at nextEventSeq N with the reducer's late-attach and
   * not-merged continuation intervals; the event at N starts the simulation. B's first reading is the junction at A's
   * save point, then B drives 20 m on 10 ml and is delivered. Each option flips one condition of the paused reconnect.
   */
  interface Reconnect {
    /** `attach`: proof at the attach and every B reading; `pre-join`: proof from B's second reading; `retro`: none, resolved after delivery. */
    join: 'attach' | 'pre-join' | 'retro';
    /**
     * The window after A's readings: as described; `gap` loses the truck re-send with a session-level event-loss interval
     * and keeps A open for the timer reset, so only the lost event differs; `no-pause` has a fine instead of the pause;
     * `started` and `fined` add that event after the job re-send; `closed-early` moves the timer reset that closes A
     * before the pause; `gap-row` stores a gap marker without effects over the truck re-send, whose event still arrives.
     */
    window: 'clean' | 'gap' | 'no-pause' | 'started' | 'fined' | 'closed-early' | 'gap-row';
    /** A's close reason at the timer reset. */
    closeReason: 'discontinuity' | 'gap';
    /** The event at N. */
    atNext: 'started' | 'fined';
    junction: Partial<QuantityReading>; following: Partial<QuantityReading>;
    /** The checkpoint job has another deadline: another job key, so the reducer adds no continuation interval. */
    deadline: boolean;
    junctionProof: boolean;
    /** The game restarted: B attaches in a new plugin session with the restart close and continuation. */
    newSession: boolean;
    accountingEngine?: 0;
  }
  const base: Reconnect = {join: 'attach', window: 'clean', closeReason: 'discontinuity', atNext: 'started', junction: {}, following: {}, deadline: false, junctionProof: true, newSession: false};
  const paused = {simulation: 'paused'} as const;
  async function reconnect(options: Partial<Reconnect> = {}) {
    const v = {...base, ...options};
    pausedOpen = true;
    const storage = await ws.open(v.accountingEngine === undefined ? {} : {accountingEngine: v.accountingEngine}), a = openMember(storage, 'A', 'root', []);
    for (const reading of [s(0), s(1), s(2), s(3, {speedMps: 0})]) { ok(storage.appendSamples(a.script.session, [sampleOf(a, reading, true)], {uniqueSeconds: true})); a.previous = reading; }
    const event = (record: EventRecord, advanceMs = 1_000) =>
      ok(storage.commitEvent({message: a.script.event(record, v.window === 'no-pause' ? {advanceMs} : {...paused, advanceMs})}));
    const close = {kind: 'trip.close', tripUuid: a.uuid, outcome: 'none', closeReason: v.closeReason, recordingCompleteness: 'partial', endedUtcMs: 2000} as const;
    // The first event follows A's last reading at 13 s on the shared capture clock.
    if (v.window === 'closed-early') ok(storage.commitEvent({message: a.script.event(r.timersRestart(), {advanceMs: 12_000}), effects: [close]}));
    event(v.window === 'no-pause' ? r.fined() : r.paused(), v.window === 'closed-early' ? 1_000 : 12_000);
    event(r.jobConfigured());
    if (v.window === 'started') ok(storage.commitEvent({message: a.script.event(r.started())}));
    if (v.window === 'fined') event(r.fined());
    if (v.window === 'gap') {
      const gap = a.script.gap(1), {firstEventSeq, lastEventSeq} = gap.data;
      ok(storage.commitGap({message: gap, effects: [{kind: 'completeness.add', interval: {tripUuid: null, kind: 'event-loss', firstEventSeq, lastEventSeq,
        detail: {cause: 'gap', causes: {...gap.data.causes}, firstEventSeq, lastEventSeq, redelivered: false}}}]}));
    } else if (v.window === 'gap-row') {
      const truck = a.script.event(r.truckConfigured(), {...paused, advanceMs: 1_000}), seq = BigInt(truck.data.eventSeq);
      ok(storage.commitGap({message: a.script.gapRange(seq, seq, {queueCount: '1'})}));
      ok(storage.commitEvent({message: truck}));
    } else event(r.truckConfigured());
    event(r.trailerConfigured());
    let script = a.script;
    const effects: TripEffect[] = [];
    if (v.newSession) {
      script = new Script(ETS2_B);
      ok(storage.upsertSession({message: script.welcome()}));
      effects.push({...close, closeReason: 'restart'});
    } else if (v.window !== 'closed-early') ok(storage.commitEvent({message: a.script.event(r.timersRestart(), paused), effects: [close]}));
    const next = script.next.toString(), uuid = attachTripUuidFor(script.session, next), at = {source: 'checkpoint', nextEventSeq: next};
    const checkpointJob = v.deadline ? job({deliveryDeadline: {available: true, value: '13060', unit: 'min'}}) : job();
    effects.push({kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: 2000},
      {kind: 'completeness.add', interval: {tripUuid: uuid, kind: 'not-connected', detail: {cause: 'late-attach', ...at}}});
    if (!v.deadline) effects.push({kind: 'completeness.add', interval: {tripUuid: uuid, kind: 'discontinuity',
      detail: {cause: v.newSession ? 'restart' : 'discontinuity', continuationOf: a.uuid, decision: 'not-merged', ...at}}});
    expect(ok(storage.openAttachedTrip({pluginSessionId: script.session, nextEventSeq: next, job: checkpointJob, effects,
      ...(v.join === 'attach' ? {profile: proof(script), sourceClockId: script.clockId, monotonicNs: ns(9)} : {})}))).toEqual({status: 'committed'});
    ok(storage.commitEvent({message: script.event(v.atNext === 'started' ? r.started() : r.fined(), v.atNext === 'started' ? {} : paused)}));
    const b: Member = {member: 'B', script, uuid, join: 'open', events: [], at: 0n};
    [s(11, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, linked: false, ...v.junction}), s(12, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80, ...v.following})]
      .forEach((reading, index) => {
        const sample = sampleOf(b, reading, v.join === 'attach' ? index > 0 || v.junctionProof : v.join === 'pre-join' && index > 0);
        ok(storage.appendSamples(script.session, [{...sample, recording: {...sample.recording!, job: checkpointJob}}], {uniqueSeconds: true}));
        b.previous = reading;
      });
    deliver(storage, b);
    if (v.join === 'retro') expect(resolveAt(storage, b, 100)).toEqual({status: 'resolved', resolved: 1, remaining: 0});
    // B joined A's group: one Journal trip.
    expect(ok(storage.journalTrips()).trips.map(trip => trip.tripUuid)).toEqual([a.uuid]);
    return {storage, root: a.uuid, attached: uuid, next, completeness: ok(storage.journalTrip(a.uuid)).trip.recordingCompleteness};
  }
  /** Closes `storage` and evaluates pausedReconnect for the attached recording, with and without the start at N. */
  function probe(storage: Storage, attached: string) {
    ok(storage.close());
    const db = new Database(ws.database, {readonly: true});
    try {
      db.defaultSafeIntegers(true);
      const row = db.prepare('SELECT * FROM trips WHERE trip_uuid=?').get(attached) as Record<string, unknown>;
      return [pausedReconnect(db, row), pausedReconnect(db, row, false)];
    } finally { db.close(); }
  }
  // A's 60 m and 0.03 L continue at the save point, then B adds 20 m and 10 ml.
  const same: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'complete', flags: [], cut: false};
  // B's junction 1 m ahead of the save point: a forward gap; A's totals carry and B adds its 20 m and 10 ml. The trip
  // shows the odometer difference 1081 - 1000 m, which includes the metre before the junction.
  const gapped: QuantityExpectation = {distanceM: 80, distance: 'partial', fuelUsedL: 0.04, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false,
    trip: {distanceM: 81, distance: 'complete'}};
  // B's junction 25 ml of fuel away: no fuel is credited across it, and fuel carries with the boundary bit.
  const boundary: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'partial', flags: ['fuelBoundary'], cut: false};
  it.each([
    ['a join at the attach', {}],
    ['a pre-join splice whose proof follows the junction reading', {join: 'pre-join'}]
  ] as const)('keeps the coverage complete: %s', async (_name, options) => {
    const {storage, root, attached, next, completeness} = await reconnect(options);
    expect(completeness).toBe('complete');
    expectJournal(storage, root, same);
    expectLedger(ledger(storage, root), same);
    // The control of the isolated conditions below: both checks find the reconnect.
    expect(probe(await ws.open(), attached)).toEqual([{continuationOf: root, nextEventSeq: next}, {continuationOf: root, nextEventSeq: next}]);
  });
  it.each([
    ['an event lost in the window', {window: 'gap'}, same],
    ['no pause in the window', {window: 'no-pause'}, same],
    ['a simulation start inside the window', {window: 'started'}, same],
    ['another event type inside the window', {window: 'fined'}, same],
    ['an event at nextEventSeq that is not a start', {atNext: 'fined'}, same],
    ['a junction 1 m ahead of the save point', {junction: {odometerM: 1061, x: 61}, following: {odometerM: 1081, x: 81}}, gapped],
    ['a junction 25 ml of fuel away', {junction: {fuelL: 399.945}, following: {fuelL: 399.935}}, boundary],
    ['the same continuation job with another deadline', {deadline: true}, same],
    ['a junction reading without proof', {junctionProof: false}, same],
    ['a retroactive join after the delivery (E6)', {join: 'retro'}, same],
    ['an attach in a new plugin session after a game restart', {newSession: true}, same]
  ] as const)('records the loss as before: %s', async (_name, options, expected) => {
    const {storage, root, completeness} = await reconnect(options);
    expect(completeness).toBe('partial');
    expectJournal(storage, root, expected);
    expectLedger(ledger(storage, root), expected);
  });
  // Each case differs from the clean control above in one fact that pausedReconnect checks and adds no loss interval,
  // so the partial coverage comes from that check alone: both forms of the check reject the reconnect.
  it.each([
    ['A closed for a gap rather than as a discontinuity', {closeReason: 'gap'}],
    ['A closed by the timer reset before the pause', {window: 'closed-early'}],
    ['a fine inside the window, which adds no loss interval', {window: 'fined'}],
    ['a stored gap marker over the window without a loss interval, its event stored later', {window: 'gap-row'}]
  ] as const)('records the loss when one reconnect condition fails: %s', async (_name, options) => {
    const {storage, root, attached, completeness} = await reconnect(options);
    expect(completeness).toBe('partial');
    expectJournal(storage, root, same);
    expectLedger(ledger(storage, root), same);
    const db = new Database(ws.database, {readonly: true});
    try {
      expect(db.prepare("SELECT count(*) FROM completeness_intervals WHERE kind IN ('event-loss','sample-loss','restore-loss')").pluck().get()).toBe(0);
    } finally { db.close(); }
    expect(probe(await ws.open(), attached)).toEqual([null, null]);
  });
  it('records the loss as before in an engine-0 group', async () => {
    expect((await reconnect({accountingEngine: 0})).completeness).toBe('partial');
  });
});

describe('REG-003/005 ET-112k engine 1 junction that waits for the profile proof', () => {
  /**
   * A drives 1000 to 1060 m on 0.03 L, stopping there, and closes with a game restart. B opens at a paused job event whose
   * admitted proof joins it to A, then the simulation starts. A save load admits its new proof only after the first
   * running reading, so B's first reading at 0.5 s is the junction at A's save point without an admitted proof. B stands
   * there in the steps below until a reading with proof decides, then drives 20 m on 10 ml.
   */
  interface Step {reading: QuantityReading; proof: boolean; before?: (storage: Storage, m: Member) => void}
  const at = (t: number, overrides: Partial<QuantityReading> = {}) => s(t, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, ...overrides});
  const junction: Step = {reading: at(0.5, {linked: false}), proof: false};
  const drive = (t: number): Step => ({reading: s(t, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80}), proof: true});
  const standing = (t: number, proof: boolean, overrides: Partial<QuantityReading> = {}, before?: Step['before']): Step => ({reading: at(t, overrides), proof, before});
  /** The owner's case: the proof arrives with the next stationary reading, 0.75 s after the junction. */
  const replica: Step[] = [junction, standing(1.25, true), drive(2.25)];
  /** A third session C that waits the same way at B's last reading (1080 m), then drives 20 m on 10 ml. */
  const third: Step[] = [{reading: at(0.5, {member: 'C', odometerM: 1080, fuelL: 399.96, x: 80, linked: false}), proof: false},
    {reading: at(1.25, {member: 'C', odometerM: 1080, fuelL: 399.96, x: 80}), proof: true}, {reading: s(2.25, {member: 'C', odometerM: 1100, fuelL: 399.95, x: 100}), proof: true}];
  /** B only stands at A's save point; C's proven junction is there too, then C drives 20 m on 10 ml. */
  const afterStanding: Step[] = [{reading: at(0.5, {member: 'C', linked: false}), proof: true}, {reading: at(1.25, {member: 'C'}), proof: true},
    {reading: s(2.25, {member: 'C', odometerM: 1080, fuelL: 399.96, x: 80}), proof: true}];
  /** A reload of A's older retained save point at 1020 m, a restore junction, then B drives 20 m on 10 ml. */
  const restore = (proof: boolean): Step => ({reading: at(0.5, {odometerM: 1020, fuelL: 399.99, x: 20, linked: false}), proof});
  const atRestore = (t: number, proof: boolean): Step => standing(t, proof, {odometerM: 1020, fuelL: 399.99, x: 20});
  /** A stationary proof-bearing reading one game minute after the junction's (the save-point rule's one forward tick). */
  const ticked: Step[] = [junction, standing(1.25, true, {minutes: 601}), {reading: s(2.25, {member: 'B', odometerM: 1080, fuelL: 399.96, x: 80, minutes: 601}), proof: true}];
  // A's 60 m and 0.03 L continue at the save point, then B adds 20 m and 10 ml; C adds 20 m and 10 ml more.
  const same: QuantityExpectation = {distanceM: 80, distance: 'complete', fuelUsedL: 0.04, fuel: 'complete', flags: [], cut: false};
  // The restore keeps A's 20 m and 0.01 L at 1020 m (a cut), then B adds 20 m and 10 ml.
  const restored: QuantityExpectation = {distanceM: 40, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: ['distanceRestored'], cut: true};
  const sameThird: QuantityExpectation = {distanceM: 100, distance: 'complete', fuelUsedL: 0.05, fuel: 'complete', flags: [], cut: false};
  interface Options {c?: readonly Step[]; accountingEngine?: 0; reopenBefore?: number; whileClosed?: (root: string) => void; end?: (storage: Storage, m: Member) => void}
  function append(storage: Storage, m: Member, step: Step) {
    expect(ok(storage.appendSamples(m.script.session, [sampleOf(m, step.reading, step.proof)], {uniqueSeconds: true}))).toEqual({appended: 1, skipped: 0});
    m.previous = step.reading;
  }
  /** Records A, then B's steps and C's; `reopenBefore` closes and reopens the database before that step, counted over B and C. */
  async function waited(b: readonly Step[], options: Options = {}) {
    pausedOpen = true;
    const engine = options.accountingEngine === undefined ? {} : {accountingEngine: options.accountingEngine};
    let storage = await ws.open(engine);
    const a = openMember(storage, 'A', 'root', []);
    for (const reading of [s(0), s(1), s(2), s(3, {speedMps: 0})]) append(storage, a, {reading, proof: true});
    let last = a, index = 0;
    const members: [string, readonly Step[]][] = [['B', b], ...(options.c ? [['C', options.c] as [string, readonly Step[]]] : [])];
    for (const [name, steps] of members) {
      closeMember(storage, last);
      const m = last = openMember(storage, name, 'open', []);
      for (const step of steps) {
        if (index++ === options.reopenBefore) { ok(storage.close()); options.whileClosed?.(a.uuid); storage = await ws.open(engine); }
        step.before?.(storage, m);
        append(storage, m, step);
      }
    }
    options.end?.(storage, last);
    return {storage, root: a.uuid};
  }
  /** The private coverage of the root's group at its latest revision, read while the storage is closed. */
  function storedCoverage(root: string): Record<string, unknown> {
    const db = new Database(ws.database, {readonly: true});
    try {
      const json = db.prepare(`SELECT s.row_json FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id JOIN logical_revisions r ON r.logical_ref=m.logical_ref
        JOIN logical_projection_states s ON s.id=r.state_ref WHERE t.trip_uuid=? ORDER BY r.id DESC LIMIT 1`).pluck().get(root) as string;
      return (JSON.parse(json) as {_coverage: Record<string, unknown>})._coverage;
    } finally { db.close(); }
  }
  it.each([
    ['the owner\'s case: the proof arrives with the next stationary reading, 0.75 s after the junction', replica, {}, same],
    ['the junction reading itself with proof, without a wait (the same totals)', [{...junction, proof: true}, standing(1.25, true), drive(2.25)], {}, same],
    ['a third session that waits too', replica, {c: third}, sameThird],
    ['a third session after B\'s wait was decided', [junction, standing(1.25, true)], {c: afterStanding}, same],
    // The controls of the bounds below: exactly 10 s after the junction, 4.5 s after the previous reading, 40 mm away.
    ['the proof exactly 10 s after the junction', [junction, standing(4.5, false), standing(8.5, false), standing(10.5, true), drive(11.5)], {}, same],
    ['a proof-bearing reading 4.5 s after the junction', [junction, standing(5, true), drive(6)], {}, same],
    ['a stationary reading 40 mm from the save point', [junction, standing(1.25, true, {x: 60.04}), drive(2.25)], {}, same],
    ['a stationary proof-bearing reading one game minute later', ticked, {}, same],
    // The control of the restore below: the same reload of an older retained save point, with proof at its junction.
    ['a reload of an older retained save point with proof', [restore(true), atRestore(1.25, true),
      {reading: s(2.25, {member: 'B', odometerM: 1040, fuelL: 399.98, x: 40}), proof: true}], {}, restored]
  ] as const)('keeps the coverage complete: %s', async (_name, steps, options, expected) => {
    const {storage, root} = await waited(steps, options);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('complete');
    expectJournal(storage, root, expected);
    expectLedger(ledger(storage, root), expected);
    const coverage = storedCoverage(root);
    expect(coverage).toMatchObject({phase: 'resumed', losses: 0});
    expect(Object.hasOwn(coverage, 'proofPending')).toBe(false);
  });
  const eventLoss: Step['before'] = (storage, m) => {
    const gap = m.script.gap(1), {firstEventSeq, lastEventSeq} = gap.data;
    ok(storage.commitGap({message: gap, effects: [{kind: 'completeness.add', interval: {tripUuid: m.uuid, kind: 'event-loss', firstEventSeq, lastEventSeq,
      detail: {cause: 'gap', causes: {...gap.data.causes}, firstEventSeq, lastEventSeq, redelivered: false}}}]}));
  };
  const sampleLoss: Step['before'] = (storage, m) => { ok(storage.recordCompleteness(m.script.session, {tripUuid: m.uuid, kind: 'sample-loss'})); };
  // A stored gap marker without a loss interval: only the clean load window, checked at the proof-bearing reading, fails.
  const gapMarker: Step['before'] = (storage, m) => { ok(storage.commitGap({message: m.script.gap(1)})); };
  // Loss bits: 1 event, 2 sample, 16 unknown.
  const lost = {phase: 'pending', losses: 16};
  // Each case differs in one fact from a control above, the owner's case unless named; `waiting` is whether the flag stays.
  it.each([
    ['the proof never arrives before the delivery', [junction, standing(1.25, false), standing(2.25, false)], {end: deliver}, {phase: 'pending', losses: 0}, true],
    ['the proof 10.25 s after the junction (control: exactly 10 s)', [junction, standing(4.5, false), standing(8.5, false), standing(10.75, true), drive(11.75)], {}, lost, false],
    ['no proof 10.25 s after the junction (control: exactly 10 s)', [junction, standing(4.5, false), standing(8.5, false), standing(10.75, false)], {}, lost, false],
    ['the odometer moves before the proof', [junction, standing(1.25, true, {odometerM: 1060.5, x: 60.5}), drive(2.25)], {}, lost, false],
    ['the position moves 100 mm before the proof (control: 40 mm)', [junction, standing(1.25, true, {x: 60.1}), drive(2.25)], {}, lost, false],
    ['the truck rolls at 1 m/s before the proof', [junction, standing(1.25, true, {speedMps: 1}), drive(2.25)], {}, lost, false],
    ['the proof-bearing reading 5.5 s after the junction (control: 4.5 s)', [junction, standing(6, true), drive(7)], {}, lost, false],
    ['the proof-bearing reading on another game clock', [junction, standing(1.25, true, {gameClock: CLOCK_B}), drive(2.25)], {}, lost, false],
    ['the proof-bearing reading without the recorder link', [junction, standing(1.25, true, {linked: false}), drive(2.25)], {}, lost, false],
    ['the proof-bearing reading two game minutes after the junction\'s (control: one minute)', [junction, standing(1.25, true, {minutes: 602}), drive(2.25)], {}, lost, false],
    ['the proof-bearing reading one game minute before the junction\'s (control: one minute later)', [junction, standing(1.25, true, {minutes: 599}), drive(2.25)], {}, lost, false],
    ['an incomplete reading without an odometer while waiting', [junction, standing(1.25, false, {odometerM: null}), standing(2.25, true), drive(3.25)], {}, lost, false],
    ['a sample loss while waiting', [junction, standing(1.25, true, {}, sampleLoss), drive(2.25)], {}, {phase: 'resumed', losses: 2}, false],
    ['an event loss while waiting', [junction, standing(1.25, true, {}, eventLoss), drive(2.25)], {}, {phase: 'pending', losses: 17}, false],
    ['the proof-bearing reading fails the clean load window', [junction, standing(1.25, true, {}, gapMarker), drive(2.25)], {}, lost, false],
    // Control: the third session after B's wait was decided. B still waits when the game restarts, so C's proven junction
    // cannot complete the trip.
    ['B still waits when C joins (control: B\'s wait decided)', [junction, standing(1.25, false)], {c: afterStanding}, {phase: 'resumed', losses: 16}, false]
  ] as const)('records the loss: %s', async (_name, steps, options, expected, waiting) => {
    const {storage, root} = await waited(steps, options);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    ok(storage.close());
    const coverage = storedCoverage(root);
    expect(coverage).toMatchObject(expected);
    expect(Object.hasOwn(coverage, 'proofPending')).toBe(waiting);
  });
  // These junctions decide at once, as before: the stored coverage right after the junction reading alone has the loss and
  // no flag, and the following proof-bearing reading at the same point cannot change it.
  it.each([
    ['a junction 25 ml of fuel away from the save point (control: the owner\'s case)', {reading: at(0.5, {fuelL: 399.945, linked: false}), proof: false},
      standing(1.25, true, {fuelL: 399.945})],
    ['a reload of an older retained save point without proof (control: the same reload with proof)', restore(false), atRestore(1.25, true)]
  ] as const)('decides at once without a wait: %s', async (_name, first, next) => {
    let after: Record<string, unknown> = {};
    const {storage, root} = await waited([first, next], {reopenBefore: 1, whileClosed: root => { after = storedCoverage(root); }});
    expect(after).toMatchObject(lost);
    expect(Object.hasOwn(after, 'proofPending')).toBe(false);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    ok(storage.close());
    expect(storedCoverage(root)).toMatchObject(lost);
  });
  it('leaves an engine-0 group unchanged: no wait, and the owner\'s case stays partial', async () => {
    const {storage, root} = await waited(replica, {accountingEngine: 0});
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('partial');
    ok(storage.close());
    expect(Object.hasOwn(storedCoverage(root), 'proofPending')).toBe(false);
  });
  it('keeps the wait across a database reopen and decides after it; validCoverage rejects an invalid flag', async () => {
    let stored: Record<string, unknown> = {};
    const {storage, root} = await waited([junction, standing(1.25, false), standing(2, true), drive(3)], {reopenBefore: 2, whileClosed: root => { stored = storedCoverage(root); }});
    // Two readings without proof: no loss yet, and the flag holds the junction reading's source time.
    expect(stored).toMatchObject({phase: 'pending', losses: 0, proofPending: ns(0.5)});
    expect(validCoverage(stored)).toBe(true);
    const without = {...stored};
    delete without.proofPending;
    expect(validCoverage(without)).toBe(true);
    for (const invalid of [{proofPending: true}, {proofPending: 1}, {proofPending: ''}, {proofPending: '01'}, {phase: 'active', window: null}]) expect(validCoverage({...stored, ...invalid})).toBe(false);
    // These shapes are valid without the flag; the flag needs a pending window and an endpoint.
    for (const shape of [{window: null}, {endpoint: null}]) expect([validCoverage({...without, ...shape}), validCoverage({...stored, ...shape})]).toEqual([true, false]);
    expect(ok(storage.journalTrip(root)).trip.recordingCompleteness).toBe('complete');
    expectJournal(storage, root, same);
    expectLedger(ledger(storage, root), same);
  });
});
