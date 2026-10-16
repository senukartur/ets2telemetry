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
 * Running values of one session's stored events, kept instead of the rows: the usable label with the highest eventSeq
 * and, per open trip, the last `job.configured` or `job.cleared` event after the trip's opening event. Events may be
 * observed in any order and more than once; each value keeps the highest eventSeq.
 */
interface SessionScan {
  lastLabel: {eventSeq: bigint; utcMs: number} | null;
  trips: Map<string, {opened: bigint; lastJobEvent: {eventSeq: bigint; type: string} | null}>;
}
const newScan = (trips: readonly TripRecord[]): SessionScan =>
  ({lastLabel: null, trips: new Map(trips.map(trip => [trip.tripUuid, {opened: BigInt(trip.openedEventSeq), lastJobEvent: null}]))});
function observe(scan: SessionScan, event: EventRow, labelOnly = false): void {
  const eventSeq = BigInt(event.eventSeq), label = labelOf(event.occurred);
  if (label !== null && (scan.lastLabel === null || eventSeq > scan.lastLabel.eventSeq)) scan.lastLabel = {eventSeq, utcMs: label};
  if (labelOnly || (event.type !== 'job.configured' && event.type !== 'job.cleared')) return;
  for (const trip of scan.trips.values()) {
    if (eventSeq > trip.opened && (trip.lastJobEvent === null || eventSeq > trip.lastJobEvent.eventSeq)) trip.lastJobEvent = {eventSeq, type: event.type};
  }
}
function seedOf(trip: TripRecord, jobRow: EventRow | undefined, scan: SessionScan): TripSeed {
  const job = jobRow !== undefined && jobRow.eventSeq === trip.jobConfigurationEventSeq && isJobConfigured(jobRow.record) ? jobKey(jobRow.record) : null;
  const lastJobEvent = scan.trips.get(trip.tripUuid)?.lastJobEvent ?? null;
  return {
    tripUuid: trip.tripUuid, pluginSessionId: trip.pluginSessionId, game: trip.game, jobKey: job, startedUtcMs: trip.startedUtcMs,
    recordingCompleteness: trip.recordingCompleteness, ...(scan.lastLabel !== null ? {lastObservedUtcMs: scan.lastLabel.utcMs} : {}),
    ...(trip.observedDistanceM.available ? {observedDistanceM: trip.observedDistanceM.value} : {}),
    ...(trip.fuelUsedL.available ? {fuelUsedL: trip.fuelUsedL.value} : {}),
    ...(lastJobEvent?.type === 'job.cleared' ? {awaitingOutcome: true} : {})
  };
}

/**
 * The seed of one stored open trip (R4):
 * - `jobKey`: jobKey() of the stored job configuration record. Null when the row is missing, is not a `job.configured`
 *   record or is not at the trip's job configuration eventSeq, so no later job matches the trip.
 * - `lastObservedUtcMs`: the label of the session's stored event with the highest eventSeq that has a usable label.
 * - `observedDistanceM`: the stored observed distance when it is available.
 * - `fuelUsedL`: the stored fuel used when it is available (S-1, J8).
 * - `awaitingOutcome`: true when the session's last `job.configured` or `job.cleared` event after the trip's opening
 *   event is `job.cleared`: the job was cleared and not configured again before the stop.
 * `sessionEvents` are the stored events of the trip's plugin session, in any order. readTripSeeds() applies the same
 * rules while it pages, without keeping the rows.
 */
export function seedFromStored(trip: TripRecord, jobRow: EventRow | undefined, sessionEvents: readonly EventRow[]): TripSeed {
  const scan = newScan([trip]);
  for (const event of sessionEvents) observe(scan, event);
  return seedOf(trip, jobRow, scan);
}

/**
 * Scans the stored events one session's seeds need, in pages of MAX_EVENT_PAGE, keeping only running values. The
 * forward read starts at the earliest opening event S of the session's open trips (`afterEventSeq` S - 1), because
 * every job event that decides `awaitingOutcome` comes after an opening event; its cost grows with the open trips'
 * part of the session, not with the session's history. Only when no event at or after S has a usable label is the
 * range before S read as well, from the session's first event, for the label only, until a page reaches S - 1: that
 * fallback costs one page per 500 events before S and is needed only when the opening event and everything after it
 * are unlabelled.
 */
async function scanSession(reader: TripSeedReader, pluginSessionId: string, trips: readonly TripRecord[]): Promise<Result<SessionScan>> {
  const scan = newScan(trips);
  const first = trips.reduce((min, trip) => { const opened = BigInt(trip.openedEventSeq); return opened < min ? opened : min; }, BigInt(trips[0].openedEventSeq));
  const before = first > 0n ? first - 1n : 0n;
  for (let after = before; ;) {
    const page = await reader.listEvents(pluginSessionId, {limit: MAX_EVENT_PAGE, afterEventSeq: after.toString()});
    if (!page.ok) return page;
    for (const event of page.value) observe(scan, event);
    if (page.value.length < MAX_EVENT_PAGE) break;
    after = BigInt(page.value[page.value.length - 1].eventSeq);
  }
  if (scan.lastLabel !== null || before === 0n) return {ok: true, value: scan};
  for (let after = 0n; ;) {
    const page = await reader.listEvents(pluginSessionId, {limit: MAX_EVENT_PAGE, afterEventSeq: after.toString()});
    if (!page.ok) return page;
    for (const event of page.value) if (BigInt(event.eventSeq) <= before) observe(scan, event, true);
    if (page.value.length < MAX_EVENT_PAGE) break;
    after = BigInt(page.value[page.value.length - 1].eventSeq);
    if (after >= before) break;
  }
  return {ok: true, value: scan};
}

/**
 * The seeds of every stored open trip of `game`, in trip creation order. Open trips are listed with the storage filter,
 * page by page; each trip session is scanned once, when its first trip is seeded (scanSession). The first failed read
 * is returned as the result.
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
  const scans = new Map<string, SessionScan>(), seeds: TripSeed[] = [];
  for (const trip of trips) {
    let scan = scans.get(trip.pluginSessionId);
    if (scan === undefined) {
      const read = await scanSession(reader, trip.pluginSessionId, trips.filter(other => other.pluginSessionId === trip.pluginSessionId));
      if (!read.ok) return read;
      scan = read.value;
      scans.set(trip.pluginSessionId, scan);
    }
    const job = await reader.getEvent(trip.pluginSessionId, trip.jobConfigurationEventSeq);
    if (!job.ok) return job;
    seeds.push(seedOf(trip, job.value, scan));
  }
  return {ok: true, value: seeds};
}
