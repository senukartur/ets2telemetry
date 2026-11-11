// ET-112b2a: schema 9 membership decision rows, raw-close markers and per-session profile boundaries (REG-005, REG-008).
// The rows record b1's live decisions (packages/telemetry-core/src/trips/membership.ts) without changing any membership;
// trip-continuation.test.ts keeps the user-visible results. Expected rows are written by hand from those rules and the
// synthetic incident corpus (tests/shared/trip-continuation-incident.ts); every trip opens at eventSeq 1 of its session.
import type Database from 'better-sqlite3';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {Storage, type SampleInput, type TripEffect} from '../../packages/storage/src/index';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {attachTripUuidFor, tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {INCIDENT_JOB, INCIDENT_JOB_WITHOUT_DEADLINE, INCIDENT_OTHER_JOB, INCIDENT_OTHER_JOB_WITHOUT_DEADLINE, INCIDENT_SEGMENTS, incidentDelivered,
  type IncidentSegment} from '../shared/trip-continuation-incident';
import {ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, job, r, Script} from '../shared/trip-messages';
import {ok, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
const opened: Storage[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { for (const storage of opened.splice(0)) if (!storage.closed) storage.close(); await ws.dispose(); });

/** The storage core on its verified writer connection; `db` reads that same connection, so no second handle is needed. */
async function openDirect(): Promise<{storage: Storage; db: Database.Database}> {
  const conn = await openConnection(ws.options()), storage = new Storage(conn);
  opened.push(storage);
  return {storage, db: conn.writer()};
}
const plain = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]));
/** Every decision row, with `decided` reporting whether decided_revision is set (it is the revision watermark, not a fixed number). */
const decisions = (db: Database.Database) => (db.prepare(`SELECT trip_ref, plugin_session_ref, state, reason, raw_closed_event_seq, target_logical_ref,
  decided_revision IS NOT NULL AS decided FROM logical_membership_decisions ORDER BY trip_ref`).all() as Record<string, unknown>[]).map(plain);
const boundaries = (db: Database.Database) => (db.prepare('SELECT * FROM session_profile_boundaries ORDER BY plugin_session_ref').all() as Record<string, unknown>[]).map(plain);
const key = (eventSeq: number) => String(eventSeq).padStart(20, '0');
const row = (trip: number, session: number, state: string, reason: string, closed: number | null, target: number | null = null) =>
  ({trip_ref: trip, plugin_session_ref: session, state, reason, raw_closed_event_seq: closed === null ? null : key(closed), target_logical_ref: target, decided: state === 'pending' ? 0 : 1});

const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const absent = {available: false, reason: 'not-observed'} as const;
const scope = 'a'.repeat(64), otherScope = 'c'.repeat(64);
const extra = ['10000000-0000-4000-8000-000000112004', '10000000-0000-4000-8000-000000112005'] as const;
const atNs = (atMs: number) => (1_000_000_000_000n + BigInt(atMs) * 1_000_000n).toString();
const proofOf = (script: Script, profileScope = scope, afterMonotonicNs = '0'): ProfileObservation => ({version: 1, scope: profileScope, binding: 'b'.repeat(64), game: 'ets2',
  pluginSessionId: script.session, processInstanceId: script.welcome().source.processInstanceId, sourceClockId: script.clockId, afterMonotonicNs, loadGeneration: 1});
interface SegmentOptions {job?: JobConfiguration; scope?: string; readingJob?: (reading: number) => JobConfiguration; end?: IncidentSegment['end'] | 'open'; afterReading?: (reading: number) => void}
/**
 * One incident process through the storage API, as tests/storage/trip-continuation.test.ts drives it: job.configured opens
 * eventSeq 1 with proof only when the proof exists 999 ms into the process, readings follow, then a timers.restart (game
 * exit) or the delivery closes the trip as eventSeq 2.
 */
function drive(storage: Storage, segment: IncidentSegment, options: SegmentOptions = {}): string {
  const script = new Script(segment.session, 'ets2', {utcMs: segment.startUtcMs}), values = options.job ?? INCIDENT_JOB, process = script.welcome().source.processInstanceId;
  const profile = proofOf(script, options.scope ?? scope, atNs(segment.profileFromMs));
  ok(storage.upsertSession({message: script.welcome()}));
  const configured = script.event(r.jobConfigured(values)), uuid = tripUuidFor(script.session, configured.data.eventSeq);
  ok(storage.commitEvent({message: configured, ...(segment.profileFromMs <= 999 ? {profile} : {}), effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode,
    jobConfiguration: 'this-event', startedUtcMs: segment.startUtcMs + 1_000, recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: uuid, attribution: 'trip'}]}));
  for (const [index, reading] of segment.readings.entries()) {
    const sample: SampleInput = {tripUuid: uuid, utcMs: segment.startUtcMs + reading.atMs, sourceClockId: script.clockId, monotonicNs: atNs(reading.atMs),
      odometer: {available: true, value: reading.odometerM}, fuel: {available: true, value: reading.fuelL}, speed: {available: true, value: reading.speedMps},
      gameTime: {minutes: {available: true, value: reading.gameMinutes}, clockId: GAME_CLOCK_1}, position: {available: true, value: {x: reading.x, y: 0, z: 0}},
      averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent,
      recording: {...(reading.atMs >= segment.profileFromMs ? {profile} : {}), job: options.readingJob?.(index) ?? values, truck: 'verified-truck', processInstanceId: process,
        ...(index > 0 ? {previous: {tripUuid: uuid, sourceClockId: script.clockId, monotonicNs: atNs(segment.readings[index - 1].atMs)}} : {})}};
    ok(storage.appendSamples(script.session, [sample], {uniqueSeconds: true}));
    options.afterReading?.(index);
  }
  const end = options.end ?? segment.end, last = segment.readings.at(-1)!.atMs;
  if (end === 'open') return uuid;
  const delivered = end === 'delivered';
  ok(storage.commitEvent({message: script.event(delivered ? incidentDelivered() : r.timersRestart(), {advanceMs: last}), effects: [{kind: 'trip.close', tripUuid: uuid,
    outcome: delivered ? 'delivered' : 'none', closeReason: delivered ? 'outcome' : 'restart', ...(delivered ? {outcomeEvent: 'this-event' as const} : {}),
    recordingCompleteness: 'partial', endedUtcMs: segment.startUtcMs + last + 1_000}]}));
  return uuid;
}
const [S1, S2, S3] = INCIDENT_SEGMENTS;

describe('ET-112b2a membership decision rows for the b1 decisions', () => {
  it('M1 records the root, both joins and every raw close carrier; only the game-exit restarts are boundaries', async () => {
    const {storage, db} = await openDirect();
    drive(storage, S1); drive(storage, S2);
    let pending: unknown[] = [];
    // The last process reads without proof for 5,114 ms: its row stays pending until the first proof-bearing reading joins it.
    drive(storage, S3, {afterReading: reading => { if (reading === 1) pending = decisions(db).slice(2); }});
    expect(pending).toEqual([row(3, 3, 'pending', 'profile-unverified', null)]);
    expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 2, 'joined', 'matched', 2, 1), row(3, 3, 'joined', 'matched', 2, 1)]);
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(2)}, {plugin_session_ref: 2, through_event_seq: key(2)}]);
  });
  it.each([['deadline-unavailable', INCIDENT_OTHER_JOB_WITHOUT_DEADLINE], ['recorded-job-incomplete', {...INCIDENT_JOB, cargoId: absent}]] as const)(
    'M2 records an incomplete recorded job of the profile as its own root (%s) while the incident joins its candidate', async (reason, recorded) => {
      const {storage, db} = await openDirect();
      drive(storage, S1); drive(storage, {...S1, session: extra[0]}, {job: recorded}); drive(storage, S2); drive(storage, S3);
      expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 2, 'root', reason, 2), row(3, 3, 'joined', 'matched', 2, 1), row(4, 4, 'joined', 'matched', 2, 1)]);
    });
  it('M3 keeps the row pending with job-evidence-incomplete for a proof-bearing reading without a current deadline, then joins', async () => {
    const {storage, db} = await openDirect();
    drive(storage, S1); drive(storage, S2);
    let pending: unknown[] = [];
    drive(storage, S3, {readingJob: reading => reading === 2 ? INCIDENT_JOB_WITHOUT_DEADLINE : INCIDENT_JOB, afterReading: reading => { if (reading === 2) pending = decisions(db).slice(2); }});
    expect(pending).toEqual([row(3, 3, 'pending', 'job-evidence-incomplete', null)]);
    expect(decisions(db).at(-1)).toEqual(row(3, 3, 'joined', 'matched', 2, 1));
  });
  it('M9 records an identical new job after the delivery as a root without a candidate', async () => {
    const {storage, db} = await openDirect();
    drive(storage, S1); drive(storage, S2); drive(storage, S3); drive(storage, {...S3, session: extra[0]}, {end: 'open'});
    expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 2, 'joined', 'matched', 2, 1), row(3, 3, 'joined', 'matched', 2, 1),
      row(4, 4, 'root', 'no-candidate', null)]);
  });
  it('M10 records two matching candidates as ambiguous', async () => {
    const {storage, db} = await openDirect();
    drive(storage, S1); const second = drive(storage, {...S2, session: extra[0]}, {scope: otherScope});
    // As in trip-continuation.test.ts: the second root is moved into the first one's profile, so both match the last segment.
    db.prepare('UPDATE logical_trips SET profile_scope=? WHERE trip_uuid=?').run(scope, second);
    drive(storage, {...S3, session: extra[1]}, {end: 'open'});
    expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 2, 'root', 'no-candidate', 2), row(3, 3, 'root', 'ambiguous-candidates', null)]);
  });
  it('M11 records a verified different job as a root and a reading that contradicts its recorded job as a conflict', async () => {
    const {storage, db} = await openDirect();
    drive(storage, S1); drive(storage, S2);
    drive(storage, {...S3, session: extra[0]}, {job: INCIDENT_OTHER_JOB, end: 'open'});
    drive(storage, {...S3, session: extra[1]}, {readingJob: () => INCIDENT_OTHER_JOB, end: 'open'});
    expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 2, 'joined', 'matched', 2, 1), row(3, 3, 'root', 'no-candidate', null),
      row(4, 4, 'root', 'job-evidence-conflict', null)]);
  });
});

describe('ET-112b2a raw close markers and profile boundaries', () => {
  /** Opens a trip at eventSeq 1 of `script`'s session, with or without proof. */
  function openTrip(storage: Storage, script: Script, verified = false): string {
    ok(storage.upsertSession({message: script.welcome()}));
    const message = script.event(r.jobConfigured(job())), uuid = tripUuidFor(script.session, message.data.eventSeq);
    ok(storage.commitEvent({message, ...(verified ? {profile: proofOf(script)} : {}), effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode,
      jobConfiguration: 'this-event', startedUtcMs: 1000, recordingCompleteness: 'complete'}]}));
    return uuid;
  }
  const closeEffect = (tripUuid: string, closeReason: 'gap' | 'restart' | 'different-job'): TripEffect =>
    ({kind: 'trip.close', tripUuid, outcome: 'none', closeReason, recordingCompleteness: 'partial', endedUtcMs: 2000});

  it('marks a gap close with its first new eventSeq and the gap as a boundary; a covered or duplicate gap writes nothing', async () => {
    const {storage, db} = await openDirect(), script = new Script(ETS2_A), uuid = openTrip(storage, script);
    const gap = script.gap(2);
    expect(ok(storage.commitGap({message: gap, effects: [closeEffect(uuid, 'gap')]})).status).toBe('committed');
    expect(decisions(db)).toEqual([row(1, 1, 'pending', 'profile-unverified', 2)]);
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(3)}]);
    const before = contentDigest(db);
    expect(ok(storage.commitGap({message: script.gapRange(2n, 2n, {queueCount: '1'})})).status).toBe('covered');
    expect(ok(storage.commitGap({message: gap, effects: [closeEffect(uuid, 'gap')]})).status).toBe('duplicate');
    expect(contentDigest(db)).toEqual(before);
  });
  it('keeps the highest boundary of each event type, gap and hole across out-of-order commits; a duplicate or ordinary event writes nothing', async () => {
    const {storage, db} = await openDirect(), script = new Script(ETS2_A);
    openTrip(storage, script);
    ok(storage.commitEvent({message: script.event(r.fined())}));
    expect(boundaries(db)).toEqual([]);
    const regression = script.event(r.regression(script.gameTime.minutes, '100')), restart = script.event(r.timersRestart()), later = script.event(r.regression('100', '50', GAME_CLOCK_2, GAME_CLOCK_1));
    expect([regression, restart, later].map(m => m.data.eventSeq)).toEqual(['3', '4', '5']);
    ok(storage.commitEvent({message: regression}));
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(3)}]);
    ok(storage.commitEvent({message: later}));
    ok(storage.commitEvent({message: restart}));
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(5)}]);
    const before = contentDigest(db);
    expect(ok(storage.commitEvent({message: restart})).status).toBe('duplicate');
    expect(contentDigest(db)).toEqual(before);
    ok(storage.commitGap({message: script.gap(2)}));
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(7)}]);
    // A gap that starts beyond the coverage is stored and has a new suffix too.
    ok(storage.commitGap({message: script.gapRange(10n, 11n, {offline: '2'})}));
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(11)}]);
  });
  it('marks a verified profile-change attach close and boundary with its nextEventSeq', async () => {
    const {storage, db} = await openDirect(), script = new Script(ETS2_A), first = openTrip(storage, script, true), next = attachTripUuidFor(ETS2_A, '2');
    ok(storage.openAttachedTrip({pluginSessionId: ETS2_A, nextEventSeq: '2', job: job(), profile: proofOf(script, 'e'.repeat(64)), profileChange: true,
      sourceClockId: script.clockId, monotonicNs: '2000000000000', effects: [closeEffect(first, 'different-job'),
        {kind: 'trip.open', tripUuid: next, game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: 2000}]}));
    expect(decisions(db)).toEqual([row(1, 1, 'root', 'no-candidate', 2), row(2, 1, 'root', 'no-candidate', null)]);
    expect(boundaries(db)).toEqual([{plugin_session_ref: 1, through_event_seq: key(2)}]);
  });
  it('marks an attach restart close of an earlier session with the attaching session\'s nextEventSeq and no boundary', async () => {
    const {storage, db} = await openDirect(), a = new Script(ETS2_A), b = new Script(ETS2_B), first = openTrip(storage, a);
    ok(storage.upsertSession({message: b.welcome()}));
    ok(storage.openAttachedTrip({pluginSessionId: ETS2_B, nextEventSeq: '1', job: job(), effects: [closeEffect(first, 'restart'),
      {kind: 'trip.open', tripUuid: attachTripUuidFor(ETS2_B, '1'), game: 'ets2', gameMode: mode, jobConfiguration: 'this-event', recordingCompleteness: 'partial', startedUtcMs: 2000}]}));
    expect(decisions(db)).toEqual([row(1, 1, 'pending', 'profile-unverified', 1), row(2, 2, 'pending', 'profile-unverified', null)]);
    expect(boundaries(db)).toEqual([]);
  });
});
