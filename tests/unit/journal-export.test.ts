// ET-016 PR-5 (J15-J17): the trip export document, format version 1. The expected documents are written by hand from
// docs/journal-export.md and the hand-written journal answers of tests/shared/journal-replies.ts; only the protocol v1
// job, truck, trailer and event records come from the shared protocol v1 fixtures, as in the journal tests. Nothing is
// read back from apps/desktop/src/journal-export.ts (REG-014).
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {JournalEvent, JournalInterval, JournalSample, JournalTripDetail} from '../../packages/contracts/src';
import {
  TripExportSerializer, tripExportBounds, tripExportFileName, tripExportHeader, withinTripExportBounds, type TripExportSection
} from '../../apps/desktop/src/journal-export';
import {journalExportText} from '../../apps/desktop/src/journal-view';
import {changed, CLOCK, DETAIL, EVENT, INTERVAL, SAMPLE, SESSION, TRIP} from '../shared/journal-replies';
import {job, trailer, truck} from '../shared/trip-messages';
import {tripExportProblems} from '../shared/trip-export-validator';

const DATABASE_UUID = 'f0000000-0000-4000-8000-000000000001';
const HEADER = tripExportHeader({uuid: DATABASE_UUID, purpose: 'synthetic', schemaVersion: 2}, '0.1.0-test', 1_800_000_000_000);
const detail = DETAIL as unknown as JournalTripDetail;
const EVENT_4 = {...EVENT, eventSeq: '4', attribution: null} as unknown as JournalEvent;
const NO = {available: false, reason: 'not-observed'};
/** Serializes one document from its parts; each section's pages in order. */
function serialize(d: JournalTripDetail, pages: {intervals?: unknown[][]; events?: unknown[][]; samples?: unknown[][]}, header = HEADER): string {
  const s = new TripExportSerializer(d, header);
  let text = s.begin();
  for (const section of ['intervals', 'events', 'samples'] as TripExportSection[]) for (const rows of pages[section] ?? []) text += s.rows(section, rows as never);
  return text + s.end();
}

/** The open anchor of journal-replies.ts as format version 1, written by hand. */
const EXPECTED = {
  format: 'ets2telemetry.trip-export',
  formatVersion: 1,
  header: {application: {name: 'ETS2Telemetry', version: '0.1.0-test'}, exportedUtcMs: 1_800_000_000_000,
    database: {uuid: DATABASE_UUID, purpose: 'synthetic', schemaVersion: 2}, sessionOrigin: 'synthetic'},
  units: {distance: 'm', speed: 'm/s', fuel: 'L', averageConsumption: 'L/100 km (the SDK mean, not a trip average)', mass: 'kg', engineSpeed: 'rpm',
    gear: 'gear index (0 neutral, negative reverse)', cargoDamage: 'fraction (0 to 1)', position: 'm (game-world coordinates, not latitude or longitude)',
    gameTime: 'min (game minutes of the game clock named by clockId)', monotonicTime: 'ns (the source clock named by its clock id)',
    utcLabel: 'ms since the Unix epoch (a label, not monotonic time)',
    money: 'exact decimal text in the SDK type; currency as documented by the SDK header or unknown, never converted'},
  bounds: {committedThroughEventSeq: '4', lastSampleId: '11', lastIntervalId: '7', snapshot: true},
  trip: {tripUuid: TRIP, pluginSessionId: SESSION, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false,
    outcome: 'open', closeReason: null, recordingCompleteness: 'partial', startedUtcMs: 1_791_676_800_000, endedUtcMs: null,
    observedDistanceM: {available: true, value: 0}, fuelUsedL: NO, openedBy: 'event', openedEventSeq: '3', outcomeEventSeq: null, closedBy: null},
  job: {source: 'event', eventSeq: '3', checkpointNextEventSeq: null, values: job()},
  truck: {eventSeq: '1', values: truck()},
  trailers: {items: [{eventSeq: '2', values: trailer(0)}], total: 1},
  outcomeDetails: null,
  money: {incomplete: false, totals: [], unavailable: []},
  window: {known: true, pluginSessionId: SESSION, fromEventSeq: '1', throughEventSeq: null, end: 'open'},
  intervals: [{id: '7', kind: 'discontinuity', annotation: true, cause: 'truck-change', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null,
    sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: {cause: 'truck-change', annotation: true, atEventSeq: '2'}}],
  events: [{eventSeq: '3', type: 'job.configured', occurred: EVENT.occurred, record: EVENT.record, attribution: {kind: 'trip', tripUuid: TRIP}},
    {eventSeq: '4', type: 'job.configured', occurred: EVENT.occurred, record: EVENT.record, attribution: null}],
  // The trip's own samples carry no trip UUID; zero speed stays a value beside the unavailable fuel reading.
  samples: [{id: '11', utcMs: 1_791_676_801_000, sourceClockId: CLOCK, monotonicNs: '1000000000', gameTime: {minutes: {available: true, value: 601}, clockId: CLOCK},
    speed: {available: true, value: 0}, fuel: {available: false, reason: 'not-supported'}, averageConsumption: {available: true, value: 31.5}, estimatedRange: NO,
    engineRpm: {available: true, value: 650}, gear: {available: true, value: -1}, odometer: {available: true, value: 1_000_500},
    position: {available: true, value: {x: -12.5, y: 3, z: 40_000.25}}}]
};

const EXPECTED_V2 = {...EXPECTED, formatVersion: 2, trip: {is_hard_mode: false, hard_mode_details: null, ...EXPECTED.trip}};

describe('format version 2 (J15, ET-026)', () => {
  it('still validates the hand-written historical format-1 document', () => {expect(tripExportProblems(EXPECTED)).toEqual([]);});
  it('writes the open anchor exactly as the hand-written document, in key order, one row per line', () => {
    const text = serialize(detail, {intervals: [[INTERVAL]], events: [[EVENT], [EVENT_4]], samples: [[SAMPLE]]});
    const document = JSON.parse(text) as Record<string, unknown>;
    expect(document).toEqual(EXPECTED_V2);
    expect(Object.keys(document)).toEqual(Object.keys(EXPECTED_V2));
    expect(tripExportProblems(document)).toEqual([]);
    // Fixed sections, then each row of each section on its own line, then the closing lines.
    const lines = text.split('\n');
    expect(lines[0]).toBe('{');
    expect(lines.filter(line => line.startsWith('{"id":"7"') || line.startsWith('{"eventSeq":') || line.startsWith('{"id":"11"'))).toHaveLength(4);
    expect(lines.slice(-3)).toEqual([']', '}', '']);
  });
  it('keeps the raw SDK job market value, never the journal display label (ET-045a)', () => {
    const document = JSON.parse(serialize(detail, {})) as {job: {values: {market: unknown}}};
    expect(document.job.values.market).toEqual({available: true, value: 'freight_market'});
    for (const label of ['Freight market', 'Грузоперевозки']) expect(serialize(detail, {})).not.toContain(label);
  });
  it('writes empty sections as empty arrays', () => {
    const closed = changed(detail, d => { d.exportBounds = {committedThroughEventSeq: '4', lastSampleId: null, lastIntervalId: null}; d.samples = {count: 0, firstUtcMs: null, lastUtcMs: null};
      d.intervals = {items: [], total: 0, nextCursor: null}; });
    const document = JSON.parse(serialize(closed, {})) as typeof EXPECTED;
    expect([document.intervals, document.events, document.samples]).toEqual([[], [], []]);
    expect(document.bounds).toEqual({committedThroughEventSeq: '4', lastSampleId: null, lastIntervalId: null, snapshot: true});
    expect(tripExportProblems(document)).toEqual([]);
  });
  it('names a history database\'s sessions game sessions and a replay database\'s replay sessions', () => {
    expect(tripExportHeader({uuid: DATABASE_UUID, purpose: 'history', schemaVersion: 2}, '0.1.0', 5)).toEqual({application: {name: 'ETS2Telemetry', version: '0.1.0'},
      exportedUtcMs: 5, database: {uuid: DATABASE_UUID, purpose: 'history', schemaVersion: 2}, sessionOrigin: 'game'});
    expect(tripExportHeader({uuid: DATABASE_UUID, purpose: 'replay', schemaVersion: 2}, '0.1.0', 5).sessionOrigin).toBe('replay');
  });
  it('writes sections only in order and the document once', () => {
    const s = new TripExportSerializer(detail, HEADER);
    expect(() => s.rows('intervals', [])).toThrow('order');
    s.begin();
    s.rows('events', [EVENT_4]);
    expect(() => s.rows('intervals', [INTERVAL as unknown as JournalInterval])).toThrow('order');
    s.end();
    expect(() => s.end()).toThrow('not open');
    expect(() => s.begin()).toThrow('already begun');
  });
});

describe('money stays exact decimal text (J15)', () => {
  it('keeps revenue and totals beyond 2^53 as strings with their SDK type and currency basis', () => {
    const EUR = {status: 'sdk-documented', code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'};
    const delivered = changed(DETAIL, d => {
      Object.assign(d.trip, {outcome: 'delivered', closeReason: 'outcome', endedUtcMs: 1_791_676_809_000, outcomeEventSeq: '9', closedBy: {pluginSessionId: SESSION, eventSeq: '9'}});
      (d as Record<string, unknown>).outcomeDetails = {eventSeq: '9', record: {type: 'job.delivered', revenue: {available: true, value: {raw: '9007199254740993', sdkType: 's64', currency: EUR}},
        earnedXp: {available: true, value: 0}, cargoDamage: {available: true, value: 0, unit: 'fraction'}, distance: {available: false, reason: 'not-supported', unit: 'm'},
        deliveryDuration: {available: false, reason: 'not-observed', unit: 'min'}, autoParkUsed: {available: true, value: false}, autoLoadUsed: NO}};
      d.money = {incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: EUR, raw: '18446744073709551616', count: 2},
        {category: 'toll', sdkType: 's64', currency: {status: 'unknown'}, raw: '-5', count: 1}], unavailable: [{category: 'toll', reason: 'not-observed', count: 1}]} as typeof d.money;
    }) as unknown as JournalTripDetail;
    // The rows at the detail's bounds (interval 7, sample 11), which a valid document holds (J17).
    const text = serialize(delivered, {intervals: [[INTERVAL]], samples: [[SAMPLE]]});
    expect(text).toContain('"raw":"9007199254740993"');
    expect(text).toContain('"raw":"18446744073709551616"');
    const document = JSON.parse(text) as {outcomeDetails: {record: {revenue: {value: {raw: unknown}}}}; money: unknown; bounds: {snapshot: boolean}};
    expect(document.outcomeDetails.record.revenue.value.raw).toBe('9007199254740993');
    expect(document.money).toEqual({incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: EUR, raw: '18446744073709551616', count: 2},
      {category: 'toll', sdkType: 's64', currency: {status: 'unknown'}, raw: '-5', count: 1}], unavailable: [{category: 'toll', reason: 'not-observed', count: 1}]});
    // A closed trip's export is no snapshot.
    expect(document.bounds.snapshot).toBe(false);
    expect(tripExportProblems(document)).toEqual([]);
  });
  it('is refused by the validator as a number or with a currency that is neither documented nor unknown', () => {
    const document = JSON.parse(serialize(detail, {})) as {job: {values: {expectedIncome: {value: Record<string, unknown>}}}};
    document.job.values.expectedIncome.value.raw = 12345;
    expect(tripExportProblems(document)).toContain('$.job.values.expectedIncome.value: money is not exact decimal text');
    document.job.values.expectedIncome.value = {raw: '12345', sdkType: 'u64', currency: {status: 'verified', code: 'EUR'}};
    expect(tripExportProblems(document)).toContain('$.job.values.expectedIncome.value: currency is neither sdk-documented with a code and source nor unknown');
  });
});

describe('bounds (J17)', () => {
  const bounds = tripExportBounds(detail);
  const sample = (id: string) => ({...SAMPLE, id}) as unknown as JournalSample;
  const interval = (id: string) => ({...INTERVAL, id}) as unknown as JournalInterval;
  const event = (eventSeq: string) => ({...EVENT, eventSeq}) as unknown as JournalEvent;
  it('come from the detail read and mark an open trip as a snapshot', () => {
    expect(bounds).toEqual({committedThroughEventSeq: '4', lastSampleId: '11', lastIntervalId: '7', snapshot: true});
  });
  it('keep rows up to the largest ids and the committed coverage, and nothing after them', () => {
    expect(['10', '11', '12'].map(id => withinTripExportBounds('samples', sample(id), bounds))).toEqual([true, true, false]);
    expect(['6', '7', '8'].map(id => withinTripExportBounds('intervals', interval(id), bounds))).toEqual([true, true, false]);
    expect(['3', '4', '5'].map(seq => withinTripExportBounds('events', event(seq), bounds))).toEqual([true, true, false]);
    // Compared as integers, not as text.
    expect(withinTripExportBounds('samples', sample('100'), {...bounds, lastSampleId: '99'})).toBe(false);
    expect(withinTripExportBounds('events', event('18446744073709551614'), {...bounds, committedThroughEventSeq: '18446744073709551615'})).toBe(true);
  });
  it('keep no samples or intervals when the trip had none at the detail read', () => {
    const none = {...bounds, lastSampleId: null, lastIntervalId: null};
    expect([withinTripExportBounds('samples', sample('1'), none), withinTripExportBounds('intervals', interval('1'), none)]).toEqual([false, false]);
  });
  it('are checked by the validator: a row past them is a problem', () => {
    const document = JSON.parse(serialize(detail, {samples: [[SAMPLE, {...SAMPLE, id: '12'}]], events: [[EVENT, EVENT_4, {...EVENT, eventSeq: '5'}]]})) as unknown;
    // The document also leaves out interval 7, which its lastIntervalId names.
    expect(tripExportProblems(document)).toEqual(['$.intervals: no row at the export bound', '$.events[2]: past the export bounds', '$.samples[1]: past the export bounds']);
  });
  it('are checked by the validator: a non-null sample or interval bound names the section\'s last row', () => {
    // Bounds 7 and 11 with their rows, and an empty event window, which the committed coverage allows (J7).
    expect(tripExportProblems(JSON.parse(serialize(detail, {intervals: [[{...INTERVAL, id: '6'}, INTERVAL]], samples: [[{...SAMPLE, id: '10'}, SAMPLE]]})))).toEqual([]);
    // Dropped interval rows, then dropped sample rows.
    expect(tripExportProblems(JSON.parse(serialize(detail, {samples: [[SAMPLE]]})))).toEqual(['$.intervals: no row at the export bound']);
    expect(tripExportProblems(JSON.parse(serialize(detail, {intervals: [[INTERVAL]]})))).toEqual(['$.samples: no row at the export bound']);
    // Rows that stop before the bound: the bound's own row is missing.
    expect(tripExportProblems(JSON.parse(serialize(detail, {intervals: [[{...INTERVAL, id: '6'}]], samples: [[{...SAMPLE, id: '10'}]]}))))
      .toEqual(['$.intervals: no row at the export bound', '$.samples: no row at the export bound']);
  });
  it('are checked by the validator: a null sample or interval bound allows no rows', () => {
    const none = changed(detail, d => { d.exportBounds = {committedThroughEventSeq: '4', lastSampleId: null, lastIntervalId: null}; });
    expect(tripExportProblems(JSON.parse(serialize(none, {})))).toEqual([]);
    expect(tripExportProblems(JSON.parse(serialize(none, {intervals: [[INTERVAL]], samples: [[SAMPLE]]}))))
      .toEqual(['$.intervals[0]: past the export bounds', '$.samples[0]: past the export bounds']);
  });
});

describe('the documented example (docs/journal-export.md)', () => {
  it('is a valid format version 1 document of a closed trip', () => {
    const text = readFileSync('docs/journal-export.md', 'utf8').replaceAll('\r\n', '\n');
    const block = /\n## Example\n[\s\S]*?```json\n([\s\S]*?)\n```\n/.exec(text);
    expect(block).not.toBeNull();
    const document = JSON.parse(block![1]) as {bounds: {snapshot: boolean}; events: unknown[]; samples: unknown[]};
    expect(tripExportProblems(document)).toEqual([]);
    expect([document.bounds.snapshot, document.events.length, document.samples.length]).toEqual([false, 3, 1]);
  });
});

describe('the default file name (J16)', () => {
  it('names the game, the start label in UTC and the first eight digits of the trip UUID', () => {
    expect(tripExportFileName(detail)).toBe('ets2telemetry-trip-ets2-20261011-0000-7a000000.json');
    expect(tripExportFileName(changed(DETAIL, d => { Object.assign(d.trip, {game: 'ats', startedUtcMs: 1_791_720_059_999, tripUuid: '7b123456-0000-4000-8000-000000000001'}); }) as unknown as JournalTripDetail))
      .toBe('ets2telemetry-trip-ats-20261011-1200-7b123456.json');
  });
});

describe('the result text (J16, J18)', () => {
  it.each<[Parameters<typeof journalExportText>[0], {text: string; failed: boolean}]>([
    [{ok: true, value: {outcome: 'saved', events: 105, intervals: 104, samples: 3600}},
      {text: 'Saved the trip as JSON: 105 events, 104 completeness intervals and 3600 one-second samples.', failed: false}],
    [{ok: true, value: {outcome: 'cancelled'}}, {text: 'Export cancelled. Nothing was written.', failed: false}],
    [{ok: false, code: 'EXPORT_TARGET_REFUSED'}, {text: 'That location cannot be used. Choose a folder outside the Yukon Union Telemetry data folder.', failed: true}],
    [{ok: false, code: 'EXPORT_WRITE_FAILED'}, {text: 'The file could not be written. A file that already had this name is unchanged.', failed: true}],
    [{ok: false, code: 'EXPORT_IN_PROGRESS'}, {text: 'Another export is still running. Try again when it has finished.', failed: true}],
    [{ok: false, code: 'EXPORT_INTERRUPTED'}, {text: 'The export stopped because Yukon Union Telemetry is exiting. Nothing was written.', failed: true}],
    [{ok: false, code: 'NOT_FOUND'}, {text: 'This trip is not in the database.', failed: true}],
    [{ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'TIMEOUT'}, {text: expect.stringMatching(/^The database is unavailable: .+\.$/) as string, failed: true}]
  ])('shows %j as fixed text', (result, expected) => {
    expect(journalExportText(result)).toEqual(expected);
  });
});
