import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, type Storage} from '../../packages/storage/src/index';
import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {EVENT_OPENED, expectRepresentative, failed, files, ok, readOnly, REPRESENTATIVE, sha256, STORAGE_FIXTURES, v1, withEventSeq, workspace} from './helpers';

const manifest = readFileSync(path.join(STORAGE_FIXTURES, 'manifest.txt'), 'utf8').split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(' ') as [string, string]);
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });
// Every test in this suite reads fixtures only through temporary copies.
afterAll(() => { for (const [hash, name] of manifest) expect(sha256(path.join(STORAGE_FIXTURES, name)), name).toBe(hash); });

const schemaOf = (file: string) => readOnly(file, db => db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all());
/** The production list up to version 1: opens a version 1 copy without migrating it (ET-016 made version 2 current). */
const UP_TO_V1 = MIGRATIONS.slice(0, 1);
const UP_TO_V2 = MIGRATIONS.slice(0, 2);
const REPRESENTATIVE_V2 = 'schema-v2-representative.sqlite';

/**
 * Checks an opened copy of the version 2 fixture against its hand-written expected content through the read API, then
 * closes it and checks the version 2 columns, gaps, attributions, completeness and row counts with plain SQL.
 */
function expectRepresentativeV2(storage: Storage, file: string) {
  const expected = JSON.parse(readFileSync(path.join(STORAGE_FIXTURES, 'schema-v2-representative.expected.json'), 'utf8'));
  expect(storage.summary.databaseUuid).toBe(expected.databaseUuid);
  expect(storage.summary.purpose).toBe(expected.purpose);
  for (const session of expected.sessions) {
    expect(ok(storage.getSession(session.pluginSessionId))).toEqual(session);
    const events = ok(storage.listEvents(session.pluginSessionId));
    expect(events.map(({eventSeq, type, firstRedelivered, protocolMinor, committedUtcMs}) => ({eventSeq, type, firstRedelivered, protocolMinor, committedUtcMs})))
      .toEqual(expected.events[session.pluginSessionId]);
    expect(ok(storage.listSamples({pluginSessionId: session.pluginSessionId}))).toEqual(expected.samples[session.pluginSessionId]);
  }
  const first = ok(storage.listEvents(expected.sessions[0].pluginSessionId));
  for (const [eventSeq, values] of Object.entries(expected.recordValues)) expect(first.find(e => e.eventSeq === eventSeq)?.record, eventSeq).toMatchObject(values as object);
  // ET-016 PR-6: TripRecord gained fuelUsedL after this immutable expectation was written. The hand-written values are
  // the fixture's fuel used, as in its SQL and in `tripColumns` below: 42.5 L, not observed, 0 L and not supported.
  const fuelUsedL = [{available: true, value: 42.5}, {available: false, reason: 'not-observed'}, {available: true, value: 0}, {available: false, reason: 'not-supported'}];
  // ET-016 PR-7: and where each trip's job and opening came from; the fixture SQL opens every trip at its event.
  expect(ok(storage.listTrips()).trips).toEqual((expected.trips as object[]).map((trip, index) => ({...trip, isHardMode: false, hardModeDetails: null, fuelUsedL: fuelUsedL[index], ...EVENT_OPENED})));
  storage.close();
  readOnly(file, db => {
    expect(db.prepare(`SELECT t.trip_uuid, t.opened_by, t.fuel_used_l, t.fuel_used_l_state, s.plugin_session_uuid AS closed_by_session, t.closed_by_event_seq
      FROM trips t LEFT JOIN plugin_sessions s ON s.id = t.closed_by_session_ref ORDER BY t.id`).all()).toEqual(expected.tripColumns);
    expect(db.prepare(`SELECT j.id, s.plugin_session_uuid AS session, j.source, e.event_seq, j.checkpoint_next_event_seq, j.expected_income_state
      FROM job_configurations j JOIN plugin_sessions s ON s.id = j.plugin_session_ref LEFT JOIN events e ON e.id = j.event_ref ORDER BY j.id`).all()).toEqual(expected.jobConfigurations);
    expect(db.prepare('SELECT first_event_seq, last_event_seq, cause_queue_count, cause_queue_bytes, cause_offline FROM event_gaps ORDER BY id').all()).toEqual(expected.gaps);
    expect(db.prepare('SELECT e.event_seq, t.trip_uuid, a.attribution FROM event_attributions a JOIN events e ON e.id = a.event_ref LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.id').all()).toEqual(expected.attributions);
    expect(db.prepare('SELECT c.kind, t.trip_uuid, c.first_event_seq, c.last_event_seq, c.detail_json FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref ORDER BY c.id').all()).toEqual(expected.completeness);
    expect(contentDigest(db).rowCounts).toEqual(expected.rowCounts);
  });
}

describe('REG-013 immutable storage fixtures', () => {
  it('lists every fixture file with its SHA-256 and nothing else', () => {
    expect(manifest.map(([, name]) => name).sort()).toEqual(files(STORAGE_FIXTURES).filter(name => name !== 'manifest.txt'));
    for (const [hash, name] of manifest) expect(sha256(path.join(STORAGE_FIXTURES, name)), name).toBe(hash);
  });
  it('keeps the frozen version 1 schema: migration 0001 still produces exactly the fixture schema', async () => {
    const storage = await ws.open({migrations: UP_TO_V1}); storage.close();
    expect(schemaOf(ws.database)).toEqual(schemaOf(ws.copyFixture(REPRESENTATIVE)));
  });
  it('reads the representative version 1 content from a temporary copy', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    const storage = await ws.open({path: copy, migrations: UP_TO_V1});
    expect(storage.summary).toMatchObject({schemaVersion: 1, created: false});
    expect(storage.summary.migratedFrom).toBeUndefined();
    expectRepresentative(storage, copy);
  });
  it('treats a redelivered copy of a stored event as a duplicate, so the stored payload encoding is stable', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE);
    const storage = await ws.open({path: copy, migrations: UP_TO_V2});
    // The stored session lists fewer event types than the shared welcome: a changed capability is a conflict.
    failed(storage.upsertSession({message: v1('welcome')}), 'SESSION_CONFLICT');
    expect(ok(storage.commitEvent({message: v1('money-uint64-max')}))).toEqual({status: 'duplicate', committedThroughEventSeq: '6'});
    expect(ok(storage.commitEvent({message: v1('event-job-configured')})).status).toBe('conflict');
  });
  it('keeps the frozen version 2 schema: migrations 0001 and 0002 still produce exactly the fixture schema', async () => {
    const storage = await ws.open({migrations: UP_TO_V2}); storage.close();
    expect(schemaOf(ws.database)).toEqual(schemaOf(ws.copyFixture(REPRESENTATIVE_V2)));
  });
  it('reads the representative version 2 content from a temporary copy without migrating it', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE_V2);
    const storage = await ws.open({path: copy, migrations: UP_TO_V2});
    expect(storage.summary).toMatchObject({schemaVersion: 2, created: false});
    expect(storage.summary.migratedFrom).toBeUndefined();
    expect(storage.summary.backupFileName).toBeUndefined();
    expectRepresentativeV2(storage, copy);
  });
  it('treats a redelivered copy of a stored version 2 event as a duplicate and changes nothing', async () => {
    const copy = ws.copyFixture(REPRESENTATIVE_V2);
    const storage = await ws.open({path: copy, migrations: UP_TO_V2});
    expect(ok(storage.commitEvent({message: withEventSeq('event-job-configured', 1n)}))).toEqual({status: 'duplicate', committedThroughEventSeq: '6'});
    expect(ok(storage.commitEvent({message: withEventSeq('event-job-delivered', 2n)}))).toEqual({status: 'duplicate', committedThroughEventSeq: '6'});
    // eventSeq 3 holds the job with the SDK-documented currency, so the plain fixture job is a different payload.
    expect(ok(storage.commitEvent({message: withEventSeq('event-job-configured', 3n)})).status).toBe('conflict');
    expectRepresentativeV2(storage, copy);
  });
});

it('REG-013 freezes the actual schema4 DDL and four singleton meanings without upgrading the fixture',async()=>{
  const copy=ws.copyFixture('schema-v4-representative.sqlite');
  const expected=JSON.parse(readFileSync(path.join(STORAGE_FIXTURES,'schema-v4-representative.expected.json'),'utf8'));
  const storage=await ws.open({path:copy,migrations:MIGRATIONS.slice(0,4)});expect(storage.summary.schemaVersion).toBe(4);storage.close();
  const fresh=await ws.open({migrations:MIGRATIONS.slice(0,4)});fresh.close();expect(schemaOf(copy)).toEqual(schemaOf(ws.database));
  readOnly(copy,db=>{
    expect(db.prepare('SELECT trip_uuid FROM trips ORDER BY id').pluck().all()).toEqual(expected.tripUuids);
    expect(db.prepare('SELECT outcome FROM trips ORDER BY id').pluck().all()).toEqual(expected.outcomes);
    expect(db.prepare('SELECT count(*) FROM logical_trips WHERE retired=1 AND profile_scope IS NULL').pluck().get()).toBe(expected.roots);
    expect(db.prepare('SELECT count(*) FROM logical_memberships WHERE trip_ref=logical_ref AND previous_logical_ref IS NULL').pluck().get()).toBe(expected.memberships);
    expect(db.prepare('SELECT count(*) FROM logical_revisions').pluck().get()).toBe(expected.revisions);
    expect(db.prepare('SELECT count(*) FROM events').pluck().get()).toBe(expected.events);
    expect(db.prepare('SELECT count(*) FROM samples').pluck().get()).toBe(expected.samples);
  });
});

it('REG-013 freezes actual schema5, ready copied evidence and an interrupted preparation without migrating it',async()=>{
  const copy=ws.copyFixture('schema-v5-representative.sqlite'),expected=JSON.parse(readFileSync(path.join(STORAGE_FIXTURES,'schema-v5-representative.expected.json'),'utf8'));
  const storage=await ws.open({path:copy,migrations:MIGRATIONS.slice(0,5)});expect(storage.summary.schemaVersion).toBe(5);storage.close();
  const fresh=await ws.open({migrations:MIGRATIONS.slice(0,5)});fresh.close();expect(schemaOf(copy)).toEqual(schemaOf(ws.database));
  readOnly(copy,db=>{
    expect(db.prepare('SELECT pin_id,state,phase,member_count,configuration_count,interval_count,item_after,source_after,evidence_generation,examined FROM upload_projection_pins ORDER BY pin_id').all()).toEqual(expected.pins);
    expect(db.prepare('SELECT root_ref,generation FROM upload_projection_evidence_versions').all()).toEqual(expected.generations);
    expect(db.prepare('SELECT count(*) FROM completeness_intervals WHERE trip_ref=2').pluck().get()).toBe(expected.root2Intervals);
  });
});


it('REG-013 freezes schema6 with delivered upload bytes, receipt and retained preparations',async()=>{
  const copy=ws.copyFixture('schema-v6-representative.sqlite'),expected=JSON.parse(readFileSync(path.join(STORAGE_FIXTURES,'schema-v6-representative.expected.json'),'utf8'));
  const storage=await ws.open({path:copy,migrations:MIGRATIONS.slice(0,6)});expect(storage.summary.schemaVersion).toBe(6);storage.close();
  const fresh=await ws.open({migrations:MIGRATIONS.slice(0,6)});fresh.close();expect(schemaOf(copy)).toEqual(schemaOf(ws.database));
  readOnly(copy,db=>{
    for(const [table,count] of [['trips',expected.trips],['upload_projection_pins',expected.pins],['upload_envelopes',expected.envelopes],['upload_receipts',expected.receipts]]){
      expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(count);
    }
    const bytes=db.prepare('SELECT payload FROM upload_envelopes WHERE event_id=?').pluck().get(expected.eventId) as Buffer;
    expect(JSON.parse(bytes.toString()).snapshot.evidence.reasons).toEqual([expected.legacyReason]);
    expect(db.prepare('SELECT receipt_id FROM upload_receipts WHERE event_ref=?').pluck().get(expected.eventId)).toBe(expected.receiptId);
  });
});
