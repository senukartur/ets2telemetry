// Hand-written journal answers for the ET-016 PR-3 unit tests (main's reply check, the broker and the service). Each value
// is written from the journal contract (packages/contracts/src/journal.ts) and the protocol v1 fixtures, never read back
// from the code under test. `changed` deep-copies a value and applies one change, for the refused variants.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {job, trailer, truck} from './trip-messages';

export const TRIP = '7a000000-0000-4000-8000-000000000001';
export const SESSION = '10000000-0000-4000-8000-000000000001';
export const CLOCK = '2c000000-0000-4000-8000-00000000000a';
export const DATABASE = {purpose: 'synthetic', schemaVersion: 2};
const NO = {available: false, reason: 'not-observed'} as const;
export const LIST_ITEM = {isHardMode: false, hardModeDetails: null, tripUuid: TRIP, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', closeReason: null,
  recordingCompleteness: 'partial', startedUtcMs: 1_791_676_800_000, endedUtcMs: null, observedDistanceM: {available: true, value: 0}, fuelUsedL: NO,
  job: {source: 'event', sourceCity: {available: true, value: 'Synthetic City A'}, sourceCompany: NO, destinationCity: NO, destinationCompany: NO, cargo: NO,
    plannedDistance: {available: true, value: 152_000, unit: 'm'}, expectedIncome: {available: true, value: {raw: '12345', sdkType: 'u64', currency: {status: 'unknown'}}}}};
export const TRIP_PAGE = {database: DATABASE, trips: [LIST_ITEM], nextCursor: null};
export const INTERVAL = {id: '7', kind: 'discontinuity', annotation: true, cause: 'truck-change', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null,
  sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: {cause: 'truck-change', annotation: true, atEventSeq: '2'}};
export const INTERVAL_PAGE = {database: DATABASE, intervals: [INTERVAL], total: 1, nextCursor: null};
export const WINDOW = {known: true, pluginSessionId: SESSION, fromEventSeq: '1', throughEventSeq: null, end: 'open'};
const configured = JSON.parse(readFileSync(path.resolve('tests/fixtures/protocol-v1/event-job-configured.json'), 'utf8')) as {data: {occurred: unknown; record: unknown}};
export const EVENT = {eventSeq: '3', type: 'job.configured', occurred: configured.data.occurred, record: configured.data.record, attribution: {kind: 'trip', tripUuid: TRIP}};
export const EVENT_PAGE = {database: DATABASE, window: WINDOW, events: [EVENT, {...EVENT, eventSeq: '4', attribution: null}], nextCursor: null};
export const DETAIL = {database: DATABASE, trip: {...LIST_ITEM, pluginSessionId: SESSION, openedBy: 'event', openedEventSeq: '3', outcomeEventSeq: null, closedBy: null},
  job: {source: 'event', eventSeq: '3', checkpointNextEventSeq: null, values: job()}, truck: {eventSeq: '1', values: truck()}, trailers: {items: [{eventSeq: '2', values: trailer(0)}], total: 1},
  outcomeDetails: null, money: {incomplete: false, totals: [], unavailable: []},
  window: WINDOW, intervals: {items: [INTERVAL], total: 1, nextCursor: null}, samples: {count: 1, firstUtcMs: 1_791_676_801_000, lastUtcMs: 1_791_676_801_000},
  exportBounds: {committedThroughEventSeq: '4', lastSampleId: '11', lastIntervalId: '7'}};
/** A sample with a zero speed (a value), an unavailable fuel reading and every other field shaped as stored. */
export const SAMPLE = {id: '11', tripUuid: TRIP, utcMs: 1_791_676_801_000, sourceClockId: CLOCK, monotonicNs: '1000000000',
  gameTime: {minutes: {available: true, value: 601}, clockId: CLOCK}, speed: {available: true, value: 0}, fuel: {available: false, reason: 'not-supported'},
  averageConsumption: {available: true, value: 31.5}, estimatedRange: NO, engineRpm: {available: true, value: 650}, gear: {available: true, value: -1},
  odometer: {available: true, value: 1_000_500}, position: {available: true, value: {x: -12.5, y: 3, z: 40_000.25}}};
export const SAMPLE_PAGE = {database: DATABASE, samples: [SAMPLE], nextCursor: null};

/** A deep copy of `value` with one change applied. */
export function changed<T>(value: T, change: (copy: T) => void): T {
  const copy = structuredClone(value);
  change(copy);
  return copy;
}
/** `count` copies of `item`, each with the decimal id `first + index` in `key`. */
export function numbered<T>(item: T, key: keyof T, count: number, first = 1): T[] {
  return Array.from({length: count}, (_, index) => ({...item, [key]: String(first + index)}));
}
