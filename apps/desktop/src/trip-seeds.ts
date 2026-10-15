// Cold-start trip seeds read from storage (ET-015a, R4). When the trip recorder first sees a durable welcome of a game,
// the reducer gets that game's stored open trips as TripSeed values (docs/trips.md, "Cold start"). The seeds are built
// from stored rows by fixed rules, mirroring TripStorageModel.seeds() in tests/shared/trip-replay.ts; they are not
// derived by running the reducer over stored items. Node-safe: it reads through the StorageClient interface only.
import type {Available, Uint64} from '../../../packages/contracts/src/protocol-v1';
import {MAX_EVENT_PAGE, MAX_TRIP_PAGE, type EventRow, type Result, type TripRecord} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
import {jobKey} from '../../../packages/telemetry-core/src/trips/identity';
import type {TripGame, TripSeed} from '../../../packages/telemetry-core/src/trips/types';

/** The storage reads a cold start needs. */
export type TripSeedReader = Pick<StorageClient, 'listTrips' | 'getEvent' | 'listEvents'>;

type JobConfiguredRecord = Parameters<typeof jobKey>[0] & {type: 'job.configured'};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isJobConfigured = (record: unknown): record is JobConfiguredRecord => isRecord(record) && record.type === 'job.configured';
/**
 * The UTC label of a stored event: `occurred.utcUnixMs` when it is available and a safe integer, as the reducer reads a
 * label (T15); otherwise none.
 */
function labelOf(occurred: unknown): number | null {
  if (!isRecord(occurred) || !isRecord(occurred.utcUnixMs)) return null;
  const label = occurred.utcUnixMs as Available<Uint64>;
  if (!label.available || typeof label.value !== 'string') return null;
  const value = Number(label.value);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The seed of one stored open trip (R4):
 * - `jobKey`: jobKey() of the stored job configuration record. Null when the row is missing, is not a `job.configured`
 *   record or is not at the trip's job configuration eventSeq, so no later job matches the trip.
 * - `lastObservedUtcMs`: the label of the session's stored event with the highest eventSeq that has a usable label.
 * - `observedDistanceM`: the stored observed distance when it is available.
 * - `awaitingOutcome`: true when the session's last `job.configured` or `job.cleared` event after the trip's opening
 *   event is `job.cleared`: the job was cleared and not configured again before the stop.
 * `sessionEvents` are the stored events of the trip's plugin session, in any order.
 */
export function seedFromStored(trip: TripRecord, jobRow: EventRow | undefined, sessionEvents: readonly EventRow[]): TripSeed {
  const job = jobRow !== undefined && jobRow.eventSeq === trip.jobConfigurationEventSeq && isJobConfigured(jobRow.record) ? jobKey(jobRow.record) : null;
  const opened = BigInt(trip.openedEventSeq);
  let lastLabel: {eventSeq: bigint; utcMs: number} | null = null;
  let lastJobEvent: {eventSeq: bigint; type: string} | null = null;
  for (const event of sessionEvents) {
    const eventSeq = BigInt(event.eventSeq), label = labelOf(event.occurred);
    if (label !== null && (lastLabel === null || eventSeq > lastLabel.eventSeq)) lastLabel = {eventSeq, utcMs: label};
    if ((event.type === 'job.configured' || event.type === 'job.cleared') && eventSeq > opened && (lastJobEvent === null || eventSeq > lastJobEvent.eventSeq)) {
      lastJobEvent = {eventSeq, type: event.type};
    }
  }
  return {
    tripUuid: trip.tripUuid, pluginSessionId: trip.pluginSessionId, game: trip.game, jobKey: job, startedUtcMs: trip.startedUtcMs,
    recordingCompleteness: trip.recordingCompleteness, ...(lastLabel !== null ? {lastObservedUtcMs: lastLabel.utcMs} : {}),
    ...(trip.observedDistanceM.available ? {observedDistanceM: trip.observedDistanceM.value} : {}),
    ...(lastJobEvent?.type === 'job.cleared' ? {awaitingOutcome: true} : {})
  };
}

/** Every stored event of one plugin session, in eventSeq order, read in pages of MAX_EVENT_PAGE. */
async function sessionEvents(reader: TripSeedReader, pluginSessionId: string): Promise<Result<EventRow[]>> {
  const events: EventRow[] = [];
  for (;;) {
    const after = events.length === 0 ? undefined : events[events.length - 1].eventSeq;
    const page = await reader.listEvents(pluginSessionId, {limit: MAX_EVENT_PAGE, ...(after !== undefined ? {afterEventSeq: after} : {})});
    if (!page.ok) return page;
    events.push(...page.value);
    if (page.value.length < MAX_EVENT_PAGE) return {ok: true, value: events};
  }
}

/**
 * The seeds of every stored open trip of `game`, in trip creation order. Open trips are listed with the storage filter,
 * page by page; each trip session's events are read once. The first failed read is returned as the result.
 */
export async function readTripSeeds(reader: TripSeedReader, game: TripGame): Promise<Result<TripSeed[]>> {
  const trips: TripRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.listTrips({game, outcome: 'open', limit: MAX_TRIP_PAGE, ...(cursor !== undefined ? {cursor} : {})});
    if (!page.ok) return page;
    trips.push(...page.value.trips);
    cursor = page.value.nextCursor ?? undefined;
  } while (cursor !== undefined);
  const sessions = new Map<string, EventRow[]>(), seeds: TripSeed[] = [];
  for (const trip of trips) {
    let events = sessions.get(trip.pluginSessionId);
    if (events === undefined) {
      const read = await sessionEvents(reader, trip.pluginSessionId);
      if (!read.ok) return read;
      events = read.value;
      sessions.set(trip.pluginSessionId, events);
    }
    const job = await reader.getEvent(trip.pluginSessionId, trip.jobConfigurationEventSeq);
    if (!job.ok) return job;
    seeds.push(seedFromStored(trip, job.value, events));
  }
  return {ok: true, value: seeds};
}
