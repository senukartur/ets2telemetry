// Journal seed (ET-016 PR-2, J20): hand-written anchor trips and generated filler trips, written through the real
// storage write commands (upsertSession, commitEvent, commitGap and appendSamples) with explicit trip effects. Every
// anchor's events, effects and values are listed here by hand, so the journal tests can write their expectations from
// this file and never from the code under test. Filler trips exist for paging only. Origins are `synthetic`, so only a
// synthetic-purpose database accepts them; nothing here touches history or real user data.
//
// Node-safe: it imports no native SQLite. The writer is the in-process Storage (synchronous Results) or a StorageClient
// (Promises of Results), so the Electron-runtime storage suite and a later seeding script can share it.
//
// The migrated version 1 anchor is not written here: it is the trip of tests/fixtures/storage/schema-v1-representative,
// migrated to schema version 2 by opening a copy of that fixture before seeding (MIGRATED_V1_TRIP).
import type {Money} from '../../packages/contracts/src/protocol-v1';
import {MAX_SAMPLE_BATCH, type CommitResult, type Result, type SampleAppendResult, type SampleInput, type TripEffect} from '../../packages/storage/src/api';
import {ATS_A, BASE_UTC, ETS2_A, ETS2_B, job, money, r, Script, trailer, truck, type EventOptions} from './trip-messages';

type Maybe<T> = T | Promise<T>;
/** The storage write commands the seed uses; both Storage and StorageClient satisfy it. */
export interface JournalSeedWriter {
  upsertSession(input: {message: unknown}): Maybe<Result<unknown>>;
  commitEvent(input: {message: unknown; effects?: TripEffect[]}): Maybe<Result<CommitResult>>;
  commitGap(input: {message: unknown; effects?: TripEffect[]}): Maybe<Result<CommitResult>>;
  appendSamples(pluginSessionId: string, rows: SampleInput[]): Maybe<Result<SampleAppendResult>>;
}

/** The anchor trips, in creation order. */
export const JOURNAL_TRIPS = {
  /** ETS2 session A: delivered and complete, with fines, a toll and a ferry; events after its outcome stay outside. */
  delivered: '7a000000-0000-4000-8000-000000000001',
  /** ETS2 session A: cancelled, with fines in EUR, a fine of unknown currency, a toll in USD and an unavailable toll. */
  cancelled: '7a000000-0000-4000-8000-000000000002',
  /** ETS2 session A: closed by a different job configuration, which is the last event of its window. */
  differentJob: '7a000000-0000-4000-8000-000000000003',
  /** ETS2 session A: partial, closed by a gap, with an annotation, a sample-loss and an event-loss interval. */
  gapClosed: '7a000000-0000-4000-8000-000000000004',
  /** ETS2 session A: closed with `restart` by the next plugin session (session B). */
  restartClosed: '7a000000-0000-4000-8000-000000000005',
  /** ETS2 session B: open, without a truck. */
  open: '7a000000-0000-4000-8000-000000000006',
  /** ATS session C: delivered, with zero values and unavailable values side by side. */
  zeroValues: '7a000000-0000-4000-8000-000000000007',
  /** ATS session C: open, with 650 one-second samples. */
  manySamples: '7a000000-0000-4000-8000-000000000008'
} as const;
/** The trip of the version 1 fixture: closed (cancelled) under schema version 1, so it has no close carrier. */
export const MIGRATED_V1_TRIP = '70000000-0000-4000-8000-000000000001';
export const MIGRATED_V1_SESSION = '10000000-0000-4000-8000-000000000001';
export const EUR: Money['currency'] = {status: 'sdk-documented', code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'};
export const USD: Money['currency'] = {status: 'sdk-documented', code: 'USD', source: 'scs-sdk-1.15/include/amtrucks/scssdk_telemetry_ats.h#game-specific-units'};
export const UNKNOWN_CURRENCY: Money['currency'] = {status: 'unknown'};
/** The game mode of every anchor trip (welcome evidence of the shared fixture: a module scan without a module). */
export const ANCHOR_GAME_MODE = {mode: 'single-player', method: 'module-scan', confidence: 'weak'} as const;
/** Session C's UTC base: 200 s after the shared fixtures' label. Session B's is 100 s after it. */
export const SESSION_B_UTC = BASE_UTC + 100_000;
export const SESSION_C_UTC = BASE_UTC + 200_000;

/** Job values of the anchors. `zeroJob` holds zero values and unavailable values side by side (REG-009). */
export const ANCHOR_JOBS = {
  delivered: job(),
  cancelled: job({cargoId: {available: true, value: 'synthetic_cancel_cargo'}, cargo: {available: true, value: 'Synthetic Cancel Cargo'}}),
  differentJob: job({cargoId: {available: true, value: 'synthetic_third_cargo'}}),
  gapClosed: job({cargoId: {available: true, value: 'synthetic_fourth_cargo'}}),
  restartClosed: job({cargoId: {available: true, value: 'synthetic_fifth_cargo'}}),
  open: job({cargoId: {available: true, value: 'synthetic_sixth_cargo'}}),
  zeroValues: job({
    sourceCity: {available: true, value: ''}, destinationCity: {available: false, reason: 'not-supported'}, cargo: {available: false, reason: 'not-observed'},
    cargoMass: {available: false, reason: 'not-supported', unit: 'kg'}, cargoUnitMass: {available: true, value: 0, unit: 'kg'}, cargoUnitCount: {available: true, value: 0},
    isSpecialJob: {available: true, value: false}, cargoLoaded: {available: false, reason: 'invalid'}, plannedDistance: {available: true, value: 0, unit: 'm'},
    expectedIncome: {available: true, value: {raw: '0', sdkType: 'u64', currency: USD}}, deliveryDeadline: {available: false, reason: 'invalid', unit: 'min'}
  }),
  manySamples: job({cargoId: {available: true, value: 'synthetic_eighth_cargo'}})
};
/** The second truck of session A, configured inside the gap-closed trip. */
export const CHANGED_TRUCK = truck({licensePlate: {available: true, value: 'SYN 0003'}});
/** The delivery of the zero-values trip: zero revenue, XP and damage beside unavailable distance, duration and auto load. */
export const ZERO_DELIVERY = {type: 'job.delivered', revenue: money('0', 's64', USD), earnedXp: {available: true, value: 0}, cargoDamage: {available: true, value: 0, unit: 'fraction'},
  distance: {available: false, reason: 'not-supported', unit: 'm'}, deliveryDuration: {available: false, reason: 'not-observed', unit: 'min'},
  autoParkUsed: {available: true, value: false}, autoLoadUsed: {available: false, reason: 'not-observed'}} as const;

const notObserved = {available: false as const, reason: 'not-observed' as const};
/** A sample in canonical units on the script's source clock; unspecified readings are not observed. */
export function seedSample(script: Script, tripUuid: string | null, second: number, utcMs: number, values: Partial<Omit<SampleInput, 'tripUuid' | 'utcMs' | 'sourceClockId' | 'monotonicNs'>> = {}): SampleInput {
  return {tripUuid, utcMs, sourceClockId: script.clockId, monotonicNs: (5_000_000_000_000n + BigInt(second) * 1_000_000_000n).toString(), gameTime: null,
    speed: notObserved, fuel: notObserved, averageConsumption: notObserved, estimatedRange: notObserved, engineRpm: notObserved, gear: notObserved,
    odometer: notObserved, position: notObserved, ...values};
}
/** The three samples of the delivered trip (seconds 1–3) and the free-driving sample before it (second 0). */
export function deliveredSamples(script: Script): SampleInput[] {
  const t = JOURNAL_TRIPS.delivered, at = (s: number) => BASE_UTC + 4_000 + s * 1_000;
  return [
    seedSample(script, null, 0, BASE_UTC + 3_500, {speed: {available: true, value: 0}}),
    seedSample(script, t, 1, at(1), {speed: {available: true, value: 22.25}, fuel: {available: true, value: 410.5}, averageConsumption: {available: true, value: 32.5},
      estimatedRange: {available: true, value: 1_263_000}, engineRpm: {available: true, value: 1_450.5}, gear: {available: true, value: 12}, odometer: {available: true, value: 1_234_590},
      position: {available: true, value: {x: -31_212.25, y: 42.5, z: 18_801.5}}, gameTime: {minutes: {available: true, value: 12_345}, clockId: '40000000-0000-4000-8000-000000000001'}}),
    seedSample(script, t, 2, at(2), {speed: {available: true, value: 0}, fuel: {available: false, reason: 'not-supported'}, gear: {available: true, value: 0}}),
    seedSample(script, t, 4, at(4), {speed: {available: false, reason: 'invalid'}, engineRpm: {available: true, value: 0}})
  ];
}

async function ok<T>(result: Maybe<Result<T>>, what: string): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(`Journal seed: ${what} failed with ${settled.error.code}`);
  return settled.value;
}
const label = (message: {data: {occurred: {utcUnixMs: {available: boolean; value?: string}}}}) => {
  const utc = message.data.occurred.utcUnixMs;
  if (!utc.available || utc.value === undefined) throw new Error('Journal seed: an opening event needs a UTC label');
  return Number(utc.value);
};
const attribute = (tripUuid: string): TripEffect => ({kind: 'event.attribute', tripUuid, attribution: 'trip'});
const open = (tripUuid: string, game: 'ets2' | 'ats', startedUtcMs: number, extra: Partial<Extract<TripEffect, {kind: 'trip.open'}>> = {}): TripEffect =>
  ({kind: 'trip.open', tripUuid, game, gameMode: ANCHOR_GAME_MODE, jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs, ...extra});

/** Commits one event of a script and requires `committed`. */
async function event(w: JournalSeedWriter, s: Script, record: Parameters<Script['event']>[0], effects: TripEffect[] | ((startedUtcMs: number) => TripEffect[]) = [], options?: EventOptions) {
  const message = s.event(record, options);
  const resolved = typeof effects === 'function' ? effects(label(message)) : effects;
  const result = await ok(w.commitEvent({message, effects: resolved}), `event ${message.data.eventSeq}`);
  if (result.status !== 'committed') throw new Error(`Journal seed: event ${message.data.eventSeq} was ${result.status}`);
  return message;
}

/**
 * Writes the eight anchor trips of three synthetic plugin sessions. Session A (ETS2) holds eventSeq 1–29 with a gap
 * 25–26, session B (ETS2) eventSeq 1–3 and session C (ATS) eventSeq 1–5; the eventSeq of each item is noted below.
 * UTC labels advance 1 s per item from BASE_UTC (A), SESSION_B_UTC (B) and SESSION_C_UTC (C).
 */
export async function seedJournalAnchors(w: JournalSeedWriter): Promise<void> {
  const T = JOURNAL_TRIPS, a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: SESSION_B_UTC}), c = new Script(ATS_A, 'ats', {utcMs: SESSION_C_UTC});
  const eur = (raw: string) => money(raw, 's64', EUR);
  await ok(w.upsertSession({message: a.welcome({mode: 'single-player', method: 'module-scan', confidence: 'weak', module: notObserved})}), 'session A');
  await event(w, a, r.truckConfigured());                                                            // A1
  await event(w, a, r.trailerConfigured());                                                          // A2
  await event(w, a, r.started());                                                                    // A3
  // Delivered (A4–A9). A10 and A11 follow its outcome and stay outside its window.
  await event(w, a, r.jobConfigured(ANCHOR_JOBS.delivered), started => [open(T.delivered, 'ets2', started, {truckConfiguration: {eventSeq: '1'}, trailerConfigurations: [{eventSeq: '2'}]})]);
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('400')}, [attribute(T.delivered)]);          // A5
  await event(w, a, {type: 'player.tollgate.paid', amount: eur('35')}, [attribute(T.delivered)]);                                               // A6
  await event(w, a, r.ferry('677'), [attribute(T.delivered)]);                                                                                  // A7
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'speeding'}, amount: eur('1')}, [attribute(T.delivered)]);         // A8
  await event(w, a, r.delivered('15000'), ended => [attribute(T.delivered), {kind: 'trip.update', tripUuid: T.delivered, set: {observedDistanceM: {available: true, value: 152_000.5}}},
    {kind: 'trip.close', tripUuid: T.delivered, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: ended}]); // A9
  await event(w, a, r.jobCleared());                                                                 // A10
  await event(w, a, r.fined('100'), [{kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'}]); // A11
  await ok(w.appendSamples(ETS2_A, deliveredSamples(a)), 'delivered samples');
  // Cancelled (A12–A19): EUR fines summing beyond 2^53, a negative fine, a fine of unknown currency, a USD toll and an unavailable toll.
  await event(w, a, r.jobConfigured(ANCHOR_JOBS.cancelled), started => [open(T.cancelled, 'ets2', started, {truckConfiguration: {eventSeq: '1'}, trailerConfigurations: [{eventSeq: '2'}]})]);
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('250')}, [attribute(T.cancelled)]);                      // A13
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('9007199254740993')}, [attribute(T.cancelled)]);         // A14
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('-5')}, [attribute(T.cancelled)]);                       // A15
  await event(w, a, {type: 'player.fined', offence: {available: false, reason: 'not-observed'}, amount: money('50', 's64', UNKNOWN_CURRENCY)}, [attribute(T.cancelled)]); // A16
  await event(w, a, {type: 'player.tollgate.paid', amount: money('20', 's64', USD)}, [attribute(T.cancelled)]);                                             // A17
  await event(w, a, {type: 'player.tollgate.paid', amount: notObserved}, [attribute(T.cancelled)]);                                                         // A18
  await event(w, a, r.cancelled('12000'), ended => [attribute(T.cancelled),
    {kind: 'trip.close', tripUuid: T.cancelled, outcome: 'cancelled', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: ended}]); // A19
  // Different job (A20–A22): A22 closes it and opens the gap-closed trip.
  await event(w, a, r.jobConfigured(ANCHOR_JOBS.differentJob), started => [open(T.differentJob, 'ets2', started, {truckConfiguration: {eventSeq: '1'}})]); // A20
  await event(w, a, {type: 'player.tollgate.paid', amount: eur('10')}, [attribute(T.differentJob)]);                                                         // A21
  await event(w, a, r.jobConfigured(ANCHOR_JOBS.gapClosed), at => [
    {kind: 'trip.close', tripUuid: T.differentJob, outcome: 'none', closeReason: 'different-job', recordingCompleteness: 'partial', endedUtcMs: at},
    open(T.gapClosed, 'ets2', at, {truckConfiguration: {eventSeq: '1'}})]);                                                                                // A22
  // Gap-closed (A22–A24, gap 25–26): a truck-change annotation, a sample-loss hole, then the gap closes it.
  await event(w, a, r.truckConfigured(CHANGED_TRUCK), [{kind: 'trip.update', tripUuid: T.gapClosed, set: {truckConfiguration: 'this-event'}},
    {kind: 'completeness.add', interval: {tripUuid: T.gapClosed, kind: 'discontinuity', detail: {cause: 'truck-change', annotation: true, atEventSeq: '23'}}}]); // A23
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('70')}, [attribute(T.gapClosed),
    {kind: 'completeness.add', interval: {tripUuid: T.gapClosed, kind: 'sample-loss', startUtcMs: BASE_UTC + 23_000, endUtcMs: BASE_UTC + 24_000,
      startMonotonicNs: '1023000000000', endMonotonicNs: '1024000000000', sourceClockId: a.clockId, detail: {cause: 'reading-hole'}}}]);                    // A24
  const gap = a.gap(2);                                                                                                                                      // A25–A26
  const gapResult = await ok(w.commitGap({message: gap, effects: [
    {kind: 'completeness.add', interval: {tripUuid: T.gapClosed, kind: 'event-loss', firstEventSeq: '25', lastEventSeq: '26', detail: {cause: 'gap', firstEventSeq: '25', lastEventSeq: '26'}}},
    {kind: 'trip.close', tripUuid: T.gapClosed, outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 24_000}]}), 'gap 25-26');
  if (gapResult.status !== 'committed') throw new Error(`Journal seed: gap 25-26 was ${gapResult.status}`);
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('30')}, [{kind: 'event.attribute', tripUuid: null, attribution: 'ambiguous'}]); // A27
  // Restart-closed (A28–A29): session B's first event closes it.
  await event(w, a, r.jobConfigured(ANCHOR_JOBS.restartClosed), started => [open(T.restartClosed, 'ets2', started)]);                                       // A28
  await event(w, a, {type: 'player.fined', offence: {available: true, value: 'crash'}, amount: eur('15')}, [attribute(T.restartClosed)]);                   // A29

  await ok(w.upsertSession({message: b.welcome({mode: 'single-player', method: 'module-scan', confidence: 'weak', module: notObserved})}), 'session B');
  await event(w, b, r.jobConfigured(ANCHOR_JOBS.open), started => [
    {kind: 'trip.close', tripUuid: T.restartClosed, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: BASE_UTC + 28_000},
    open(T.open, 'ets2', started)]);                                                                                                                        // B1
  await event(w, b, {type: 'player.tollgate.paid', amount: eur('5')}, [attribute(T.open)]);                                                                 // B2
  await event(w, b, r.paused(), [], {simulation: 'paused'});                                                                                                // B3
  await ok(w.appendSamples(ETS2_B, [seedSample(b, T.open, 1, SESSION_B_UTC + 1_500, {speed: {available: true, value: 10}}),
    seedSample(b, T.open, 2, SESSION_B_UTC + 2_500, {speed: {available: true, value: 0}})]), 'open samples');

  await ok(w.upsertSession({message: c.welcome({mode: 'single-player', method: 'module-scan', confidence: 'weak', module: notObserved})}), 'session C');
  await event(w, c, r.truckConfigured());                                                            // C1
  await event(w, c, r.trailerConfigured(trailer(0)));                                                // C2
  await event(w, c, r.jobConfigured(ANCHOR_JOBS.zeroValues), started => [open(T.zeroValues, 'ats', started, {truckConfiguration: {eventSeq: '1'}, trailerConfigurations: [{eventSeq: '2'}]})]); // C3
  await event(w, c, ZERO_DELIVERY, ended => [attribute(T.zeroValues),
    {kind: 'trip.update', tripUuid: T.zeroValues, set: {observedDistanceM: {available: true, value: 0}}},
    {kind: 'trip.close', tripUuid: T.zeroValues, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: ended}]); // C4
  await ok(w.appendSamples(ATS_A, [seedSample(c, T.zeroValues, 1, SESSION_C_UTC + 3_500, {
    speed: {available: true, value: 0}, fuel: {available: true, value: 0}, averageConsumption: {available: false, reason: 'not-supported'},
    estimatedRange: {available: false, reason: 'invalid'}, engineRpm: {available: true, value: 0}, gear: {available: true, value: 0}, odometer: notObserved,
    position: {available: true, value: {x: 0, y: 0, z: 0}}, gameTime: {minutes: {available: true, value: 0}, clockId: '40000000-0000-4000-8000-000000000001'}})]), 'zero samples');
  await event(w, c, r.jobConfigured(ANCHOR_JOBS.manySamples), started => [open(T.manySamples, 'ats', started, {truckConfiguration: {eventSeq: '1'}})]);      // C5
  await ok(w.appendSamples(ATS_A, Array.from({length: 650}, (_, i) => seedSample(c, T.manySamples, 10 + i, SESSION_C_UTC + 6_000 + i * 1_000,
    {speed: {available: true, value: 20 + (i % 7)}}))), 'many samples');
}

/** One generated filler trip: the values it was written with, for paging expectations only. */
export interface FillerTrip {tripUuid: string; game: 'ets2' | 'ats'; outcome: 'delivered' | 'cancelled' | 'open'; recordingCompleteness: 'complete' | 'partial' | 'unknown'}
export const FILLER_ETS2 = '10000000-0000-4000-8000-0000000000d4';
export const FILLER_ATS = '10000000-0000-4000-8000-0000000000e5';
/**
 * Writes `count` filler trips after the anchors, alternating ETS2 and ATS (filler i is ATS when i is odd). Each pair of
 * games cycles through delivered and complete, cancelled and partial, then open and unknown. With `samplesPerTrip` each
 * trip gets that many one-second samples, appended per game in batches of whole trips of at most MAX_SAMPLE_BATCH
 * (3,600) rows once their trips are written; a trip of more rows is still refused. Every batch is one synced commit,
 * which a slow runner pays for, so this keeps the scale build short. The stored rows, their values and their order
 * per trip and per clock are those of one batch per trip; only the sample row ids interleave differently. Returns
 * the trips in creation order.
 */
export async function seedJournalFillers(w: JournalSeedWriter, count: number, options: {samplesPerTrip?: number; utcMs?: number} = {}): Promise<FillerTrip[]> {
  const base = options.utcMs ?? BASE_UTC + 1_000_000;
  const scripts = {ets2: new Script(FILLER_ETS2, 'ets2', {utcMs: base}), ats: new Script(FILLER_ATS, 'ats', {utcMs: base})};
  for (const s of Object.values(scripts)) await ok(w.upsertSession({message: s.welcome()}), 'filler session');
  const trips: FillerTrip[] = [], seconds = {ets2: 0, ats: 0}, pending: Record<'ets2' | 'ats', SampleInput[]> = {ets2: [], ats: []};
  const flush = async (game: 'ets2' | 'ats') => {
    const rows = pending[game];
    if (rows.length === 0) return;
    pending[game] = [];
    const {appended} = await ok(w.appendSamples(scripts[game].session, rows), 'filler samples');
    if (appended !== rows.length) throw new Error(`Journal seed: ${appended} of ${rows.length} filler samples were appended`);
  };
  for (let i = 0; i < count; i++) {
    const game = i % 2 === 0 ? 'ets2' : 'ats', s = scripts[game], kind = Math.floor(i / 2) % 3;
    const tripUuid = `7f000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
    const trip: FillerTrip = {tripUuid, game, outcome: kind === 0 ? 'delivered' : kind === 1 ? 'cancelled' : 'open', recordingCompleteness: kind === 0 ? 'complete' : kind === 1 ? 'partial' : 'unknown'};
    await event(w, s, r.jobConfigured(), started => [{kind: 'trip.open', tripUuid, game, gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event',
      recordingCompleteness: 'unknown', startedUtcMs: started}]);
    if (options.samplesPerTrip) {
      const rows = Array.from({length: options.samplesPerTrip}, (_, k) => seedSample(s, tripUuid, seconds[game] + k, base + (seconds[game] + k) * 1_000, {speed: {available: true, value: 15}}));
      seconds[game] += options.samplesPerTrip;
      if (pending[game].length + rows.length > MAX_SAMPLE_BATCH) await flush(game);
      pending[game].push(...rows);
    }
    if (trip.outcome !== 'open') {
      await event(w, s, trip.outcome === 'delivered' ? r.delivered() : r.cancelled(), ended => [attribute(tripUuid), {kind: 'trip.close', tripUuid, outcome: trip.outcome as 'delivered' | 'cancelled',
        closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: trip.recordingCompleteness, endedUtcMs: ended}]);
    }
    trips.push(trip);
  }
  await flush('ets2');
  await flush('ats');
  return trips;
}
