import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import type {SinkResult} from '../../apps/desktop/src/durable-sink';
import type {CargoClassification} from '../../packages/contracts/src/cargo-classification';
import {validateJournalTripDetail, validateJournalTripPage} from '../../packages/contracts/src/journal';
import {MIGRATIONS, type FillCargoClassification} from '../../packages/storage/src';
import {StorageClient} from '../../packages/storage/src/client';
import {attachTripUuidFor, tripUuidFor} from '../../packages/telemetry-core/src';
import {ETS2_A, ETS2_B, Script, job, r} from '../shared/trip-messages';
import {ok, readOnly, TEST_CLOSE_GRACE_MS, uploadGame, workspace} from './helpers';
import {storageWorker, terminateWorkers} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await terminateWorkers(); await ws.dispose();});
const context = {receivedUtcMs: 1000};
const cargoId = 'synthetic_cargo';
const values = job({cargoId: {available: true, value: cargoId}});
const generation = '10000000-0000-4000-8000-000000000099';
const cargo: CargoClassification = {
  version: 1, fragility: 0.75, fragile: true, valuable: true, adr: {state: 'class', class: 3},
  overweight: false, oversize: null, groups: ['fragile', 'refrigerated'],
};
const known = () => ({opening: {generation, cargoId, classification: cargo}, current: () => true, result: Promise.resolve(cargo)});
function recorded<T>(result: SinkResult<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
async function worker() {
  const client = new StorageClient(storageWorker().handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
  ok(await client.open({path: ws.database, backupsDirectory: ws.backups, purpose: 'history', appVersion: 'test'}));
  return client;
}

describe('cargo classification in game-shaped history (REG-003/005/006/008/013/014)', () => {
  it('stores known event-opening evidence on the trip and refuses to rewrite it on redelivery', async () => {
    const client = await worker(), script = new Script(ETS2_A);
    const lookup = vi.fn(known), recorder = new TripRecorderSink(client, {cargoLookup: lookup});
    recorded(await recorder.openSession(uploadGame(script.welcome())));
    recorded(recorder.observe(uploadGame(script.checkpoint(null)), context));
    const message = uploadGame(script.event(r.jobConfigured(values)));
    const tripUuid = tripUuidFor(script.session, message.data.eventSeq);
    expect(recorded(await recorder.commit(message, context)).status).toBe('committed');
    expect(recorded(await recorder.commit(uploadGame(script.redeliver(message)), context)).status).toBe('duplicate');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(validateJournalTripPage(ok(await client.journalTrips())).trips[0].cargoClassification).toEqual(cargo);
    expect(validateJournalTripDetail(ok(await client.journalTrip(tripUuid))).trip.cargoClassification).toEqual(cargo);
    expect(await client.close()).toEqual({clean: true});
    const reopened = await worker();
    expect(ok(await reopened.journalTrip(tripUuid)).trip.cargoClassification).toEqual(cargo);
    expect(await reopened.close()).toEqual({clean: true});
  });

  it.each(['live', 'history', 'restored'] as const)('uses only a genuine %s checkpoint opening for cargo evidence', async kind => {
    const client = await worker(), script = new Script(ETS2_A);
    const lookup = vi.fn(known), recorder = new TripRecorderSink(client, {cargoLookup: lookup});
    const input = {...context, historyReplay: kind === 'history', restoreCheckpoint: kind === 'restored'};
    recorded(await recorder.openSession(uploadGame(script.welcome())));
    const checkpoint = uploadGame(script.checkpoint(values));
    recorded(await recorder.checkpoint(checkpoint));
    recorded(recorder.observe(checkpoint, input));
    expect(recorder.attach.due()).toBe(true);
    expect(recorded(await recorder.attach.open(input)).status).toBe('committed');
    const tripUuid = attachTripUuidFor(script.session, checkpoint.data.status.delivery.nextEventSeq);
    expect(lookup).toHaveBeenCalledTimes(kind === 'live' ? 1 : 0);
    expect(ok(await client.journalTrip(tripUuid)).trip.cargoClassification).toEqual(kind === 'live' ? cargo : undefined);
    expect(await client.close()).toEqual({clean: true});
  });

  it('fills only the still-open original boundary, idempotently, keeping the prior revision unknown', async () => {
    const client = await worker(), script = new Script(ETS2_A);
    let publish!: (value: CargoClassification) => void, done!: (input: FillCargoClassification) => void;
    const result = new Promise<CargoClassification>(resolve => {publish = resolve;});
    const filled = new Promise<FillCargoClassification>(resolve => {done = resolve;});
    const fill = client.fillCargoClassification.bind(client);
    vi.spyOn(client, 'fillCargoClassification').mockImplementation(async input => {
      const reply = await fill(input); done(input); return reply;
    });
    const recorder = new TripRecorderSink(client, {cargoLookup: () => ({opening: {generation, cargoId, classification: null}, current: () => true, result})});
    recorded(await recorder.openSession(uploadGame(script.welcome())));
    recorded(recorder.observe(uploadGame(script.checkpoint(null)), context));
    const message = uploadGame(script.event(r.jobConfigured(values)));
    const tripUuid = tripUuidFor(script.session, message.data.eventSeq);
    recorded(await recorder.commit(message, context));
    expect(ok(await client.journalTrip(tripUuid)).trip.cargoClassification).toBeUndefined();
    const anchor = {game: 'ets2', pluginSessionId: script.session, tripUuid, cargoId, generation, opening: 'event', boundary: message.data.eventSeq, classification: cargo} as const;
    for (const wrong of [{...anchor, boundary: '2'}, {...anchor, cargoId: 'other'}, {...anchor, generation: script.session}]) {
      expect(ok(await fill(wrong))).toBe('retired');
    }
    publish(cargo);
    expect(await filled).toEqual(anchor);
    expect(ok(await fill(anchor))).toBe('unchanged');
    expect(ok(await client.journalTrip(tripUuid)).trip.cargoClassification).toEqual(cargo);
    recorded(await recorder.commit(uploadGame(script.event(r.cancelled())), context));
    expect(ok(await fill(anchor))).toBe('retired');
    expect(await client.close()).toEqual({clean: true});
    const shadows = readOnly(ws.database, db => db.prepare(`SELECT json_type(p.row_json, '$.cargo_classification') AS state
      FROM logical_revisions r JOIN logical_projection_states p ON p.id=r.state_ref ORDER BY r.id`).all());
    expect(shadows[0]).toEqual({state: 'null'});
    expect(shadows.at(-1)).toEqual({state: 'text'});
  });

  it('keeps a schema-11 trip unknown after migration without attaching a new-generation fill guard', async () => {
    const storage = await ws.open({purpose: 'history', migrations: MIGRATIONS.slice(0, 11)}), script = new Script(ETS2_A);
    const message = uploadGame(script.event(r.jobConfigured(values))), tripUuid = tripUuidFor(script.session, message.data.eventSeq);
    ok(storage.upsertSession({message: uploadGame(script.welcome())}));
    ok(storage.commitEvent({message, effects: [{kind: 'trip.open', game: 'ets2', tripUuid, jobConfiguration: 'this-event',
      gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, startedUtcMs: 1000, recordingCompleteness: 'complete'}]}));
    ok(storage.close());
    const upgraded = await ws.open({purpose: 'history'});
    expect(upgraded.summary).toMatchObject({schemaVersion: 12, migratedFrom: 11});
    expect(ok(upgraded.journalTrip(tripUuid)).trip.cargoClassification).toBeUndefined();
    expect(ok(upgraded.fillCargoClassification({game: 'ets2', pluginSessionId: script.session, tripUuid, cargoId, generation,
      opening: 'event', boundary: message.data.eventSeq, classification: cargo}))).toBe('retired');
  });

  it('keeps the root opening value as a later classified segment continues the same job', async () => {
    const storage = await ws.open({purpose: 'history'});
    const open = (script: Script, classification?: CargoClassification) => {
      const welcome = uploadGame(script.welcome()), message = uploadGame(script.event(r.jobConfigured(values)));
      const tripUuid = tripUuidFor(script.session, message.data.eventSeq);
      ok(storage.upsertSession({message: welcome}));
      ok(storage.commitEvent({message, profile: {version: 1, scope: 'a'.repeat(64), binding: 'b'.repeat(64), game: 'ets2',
        pluginSessionId: script.session, processInstanceId: welcome.source.processInstanceId, sourceClockId: script.clockId,
        afterMonotonicNs: '0', loadGeneration: 1},
      ...(classification ? {cargoOpening: {cargoId, classification, generation}} : {}),
      effects: [{kind: 'trip.open', game: 'ets2', tripUuid, jobConfiguration: 'this-event',
        gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, startedUtcMs: 1000, recordingCompleteness: 'complete'}]}));
      return tripUuid;
    };
    const first = new Script(ETS2_A), root = open(first);
    ok(storage.commitEvent({message: uploadGame(first.event(r.timersRestart())), effects: [{kind: 'trip.close', tripUuid: root,
      outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
    const member = open(new Script(ETS2_B), cargo);
    const trips = ok(storage.journalTrips()).trips;
    expect(trips.map(trip => trip.tripUuid)).toEqual([root]);
    expect(trips[0].cargoClassification).toBeUndefined();
    expect(ok(storage.journalTrip(root)).trip.cargoClassification).toBeUndefined();
    ok(storage.close());
    readOnly(ws.database, db => expect(JSON.parse(db.prepare('SELECT cargo_classification FROM trips WHERE trip_uuid = ?')
      .pluck().get(member) as string)).toEqual(cargo));
  });
});
