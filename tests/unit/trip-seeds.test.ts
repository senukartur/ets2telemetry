// ET-015a cold-start seeds (R4): seedFromStored() derives a TripSeed from stored rows by fixed rules, and readTripSeeds()
// reads them page by page through the storage client. Expected seeds are written by hand from the R4 rules in
// docs/trips.md and the TripSeed contract; job keys come from jobKey() (T6), never from the code under test.
import {describe, expect, it} from 'vitest';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {storageError} from '../../packages/storage/src/errors';
import type {EventRow, Result, TripList, TripPage, TripRecord} from '../../packages/storage/src/api';
import {jobKey} from '../../packages/telemetry-core/src/index';
import {readTripSeeds, seedFromStored, type TripSeedReader} from '../../apps/desktop/src/trip-seeds';
import {job, otherJob} from '../shared/trip-messages';

const S1 = '10000000-0000-4000-8000-0000000000a1', S2 = '10000000-0000-4000-8000-0000000000b2';
const T1 = '70000000-0000-4000-8000-000000000001', T2 = '70000000-0000-4000-8000-000000000002', T3 = '70000000-0000-4000-8000-000000000003';
const UTC = 1_791_676_800_000;
const NOT_OBSERVED = {available: false as const, reason: 'not-observed' as const};

/** A stored open trip opened by its job configuration event `opened`. */
function trip(overrides: Partial<TripRecord> = {}): TripRecord {
  return {
    tripUuid: T1, pluginSessionId: S1, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false,
    jobConfigurationEventSeq: '2', truckConfigurationEventSeq: null, trailerConfigurationEventSeqs: [], openedEventSeq: '2', outcome: 'open', outcomeEventSeq: null,
    closeReason: null, recordingCompleteness: 'complete', startedUtcMs: UTC, endedUtcMs: null, observedDistanceM: NOT_OBSERVED, createdUtcMs: UTC, updatedUtcMs: UTC,
    ...overrides
  };
}
/** A stored event row; `utc` is its `occurred.utcUnixMs` label (a decimal string) or null for an unavailable label. */
function event(eventSeq: string, type: string, utc: string | null, record: Record<string, unknown> = {}): EventRow {
  return {
    eventSeq, type, record: {type, ...record}, firstRedelivered: false, protocolMinor: 0, committedUtcMs: UTC,
    occurred: {utcUnixMs: utc === null ? NOT_OBSERVED : {available: true, value: utc}}
  };
}
const configured = (eventSeq: string, utc: string | null, configuration: JobConfiguration = job()) => event(eventSeq, 'job.configured', utc, {...configuration});

describe('seedFromStored (R4)', () => {
  it('builds the seed of a stored open trip from its job row, the session labels and its stored distance', () => {
    const rows = [event('1', 'simulation.started', '1791676801000'), configured('2', '1791676802000'), event('3', 'player.fined', '1791676803000')];
    expect(seedFromStored(trip({observedDistanceM: {available: true, value: 1234.5}, recordingCompleteness: 'partial'}), rows[1], rows)).toEqual({
      tripUuid: T1, pluginSessionId: S1, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: UTC, recordingCompleteness: 'partial',
      lastObservedUtcMs: 1_791_676_803_000, observedDistanceM: 1234.5
    });
  });

  it('derives jobKey only from a job.configured row at the trip job eventSeq; otherwise it is null', () => {
    const rows = [configured('2', null)];
    // The key ignores cargoLoaded (T6), so a pickup re-send of the same job has the same key.
    expect(seedFromStored(trip(), configured('2', null, job({cargoLoaded: {available: true, value: false}})), rows).jobKey).toBe(jobKey(job()));
    expect(seedFromStored(trip(), configured('2', null, otherJob()), rows).jobKey).toBe(jobKey(otherJob()));
    expect(seedFromStored(trip(), configured('2', null, otherJob()), rows).jobKey).not.toBe(jobKey(job()));
    expect(seedFromStored(trip(), undefined, rows).jobKey).toBeNull();
    expect(seedFromStored(trip(), event('2', 'job.cleared', null), rows).jobKey).toBeNull();
    expect(seedFromStored(trip(), configured('3', null), rows).jobKey).toBeNull();
  });

  it('takes the label of the highest stored eventSeq with a usable label, in any row order', () => {
    const rows = [configured('2', '1791676802000'), event('5', 'player.fined', '1791676805000'), event('6', 'player.fined', null),
      // A label beyond the safe integer range is not a usable label (T15), so it is skipped like an unavailable one.
      event('7', 'player.fined', '18446744073709551615'), event('4', 'player.fined', '1791676809000')];
    expect(seedFromStored(trip(), rows[0], rows).lastObservedUtcMs).toBe(1_791_676_805_000);
    expect(seedFromStored(trip(), rows[0], [...rows].reverse()).lastObservedUtcMs).toBe(1_791_676_805_000);
    const unlabelled = [configured('2', null), event('3', 'player.fined', null)];
    expect(seedFromStored(trip(), unlabelled[0], unlabelled)).not.toHaveProperty('lastObservedUtcMs');
  });

  it('marks a trip awaiting its outcome when the last job event after its opening is a clear', () => {
    const cleared = [configured('2', null), event('3', 'job.cleared', null), event('4', 'player.fined', null)];
    expect(seedFromStored(trip(), cleared[0], cleared).awaitingOutcome).toBe(true);
    // A later configuration (the re-send after a save load) cancels it.
    const resent = [...cleared, configured('5', null)];
    expect(seedFromStored(trip(), resent[0], resent)).not.toHaveProperty('awaitingOutcome');
    // A clear at or before the trip's opening event is not the trip's clear.
    const earlier = [event('1', 'job.cleared', null), configured('2', null)];
    expect(seedFromStored(trip(), earlier[1], earlier)).not.toHaveProperty('awaitingOutcome');
    // Rows in another order give the same answer.
    expect(seedFromStored(trip(), cleared[0], [...cleared].reverse()).awaitingOutcome).toBe(true);
    expect(seedFromStored(trip(), resent[0], [...resent].reverse())).not.toHaveProperty('awaitingOutcome');
  });

  it('passes an available stored distance through and leaves a not-observed one out', () => {
    expect(seedFromStored(trip({observedDistanceM: {available: true, value: 0}}), undefined, []).observedDistanceM).toBe(0);
    expect(seedFromStored(trip(), undefined, [])).toEqual({tripUuid: T1, pluginSessionId: S1, game: 'ets2', jobKey: null, startedUtcMs: UTC, recordingCompleteness: 'complete'});
  });
});

/** A scripted reader: trips are served from `pages`, events of each session in pages of at most `limit`. */
function reader(pages: TripRecord[][], events: Record<string, EventRow[]>) {
  const calls: unknown[][] = [];
  const failures: Partial<Record<'listTrips' | 'listEvents' | 'getEvent', Result<never>>> = {};
  const fake: TripSeedReader = {
    listTrips(page?: TripPage): Promise<Result<TripList>> {
      calls.push(['listTrips', page]);
      if (failures.listTrips) return Promise.resolve(failures.listTrips);
      const index = page?.cursor === undefined ? 0 : Number(page.cursor);
      return Promise.resolve({ok: true, value: {trips: pages[index], nextCursor: index + 1 < pages.length ? String(index + 1) : null}});
    },
    listEvents(pluginSessionId: string, page?: {afterEventSeq?: string; limit?: number}): Promise<Result<EventRow[]>> {
      calls.push(['listEvents', pluginSessionId, page]);
      if (failures.listEvents) return Promise.resolve(failures.listEvents);
      const after = BigInt(page?.afterEventSeq ?? '0');
      return Promise.resolve({ok: true, value: (events[pluginSessionId] ?? []).filter(row => BigInt(row.eventSeq) > after).slice(0, page?.limit ?? 500)});
    },
    getEvent(pluginSessionId: string, eventSeq: string): Promise<Result<EventRow | undefined>> {
      calls.push(['getEvent', pluginSessionId, eventSeq]);
      if (failures.getEvent) return Promise.resolve(failures.getEvent);
      return Promise.resolve({ok: true, value: (events[pluginSessionId] ?? []).find(row => row.eventSeq === eventSeq)});
    }
  };
  return {reader: fake, calls, failures};
}

describe('readTripSeeds', () => {
  it('lists the open trips of the game with the storage filter, page by page, and reads each session once', async () => {
    // Session S1 has 503 events: a full page of eventSeq 1-500, then 501-503. Trips T1 and T2 belong to it, T3 to S2.
    const s1 = [configured('1', '1791676801000'), ...Array.from({length: 500}, (_, i) => event(String(i + 2), 'player.fined', null)),
      event('502', 'job.cleared', '1791676900000'), configured('503', null, otherJob())];
    const s2 = [configured('7', null)];
    const f = reader([[trip({jobConfigurationEventSeq: '1', openedEventSeq: '1'}), trip({tripUuid: T2, jobConfigurationEventSeq: '503', openedEventSeq: '503'})],
      [trip({tripUuid: T3, pluginSessionId: S2, jobConfigurationEventSeq: '7', openedEventSeq: '7'})]], {[S1]: s1, [S2]: s2});
    const result = await readTripSeeds(f.reader, 'ets2');
    expect(result).toEqual({ok: true, value: [
      // T1: its job was configured again at 503 after the clear at 502, so it is not awaiting its outcome.
      {tripUuid: T1, pluginSessionId: S1, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: UTC, recordingCompleteness: 'complete', lastObservedUtcMs: 1_791_676_900_000},
      {tripUuid: T2, pluginSessionId: S1, game: 'ets2', jobKey: jobKey(otherJob()), startedUtcMs: UTC, recordingCompleteness: 'complete', lastObservedUtcMs: 1_791_676_900_000},
      {tripUuid: T3, pluginSessionId: S2, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: UTC, recordingCompleteness: 'complete'}
    ]});
    expect(f.calls).toEqual([
      ['listTrips', {game: 'ets2', outcome: 'open', limit: 100}],
      ['listTrips', {game: 'ets2', outcome: 'open', limit: 100, cursor: '1'}],
      ['listEvents', S1, {limit: 500}],
      ['listEvents', S1, {limit: 500, afterEventSeq: '500'}],
      ['getEvent', S1, '1'],
      ['getEvent', S1, '503'],
      ['listEvents', S2, {limit: 500}],
      ['getEvent', S2, '7']
    ]);
  });

  it('asks for the requested game and returns no seeds when it has no open trip', async () => {
    const f = reader([[]], {});
    expect(await readTripSeeds(f.reader, 'ats')).toEqual({ok: true, value: []});
    expect(f.calls).toEqual([['listTrips', {game: 'ats', outcome: 'open', limit: 100}]]);
  });

  it.each(['listTrips', 'listEvents', 'getEvent'] as const)('returns the first failed %s read as the result', async name => {
    const f = reader([[trip()]], {[S1]: [configured('2', null)]});
    const failure = {ok: false as const, error: storageError('WORKER_FAILED')};
    f.failures[name] = failure;
    expect(await readTripSeeds(f.reader, 'ets2')).toEqual(failure);
    expect(f.calls.at(-1)?.[0]).toBe(name);
  });
});
