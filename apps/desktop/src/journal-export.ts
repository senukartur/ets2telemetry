// The trip export document (ET-016 PR-5, J15-J17): pure serialization of `ets2telemetry.trip-export` format version 1.
// The writer (journal-export-writer.ts) reads the trip detail once, then its completeness intervals, timeline events and
// samples page by page, and appends this module's text for each page, so the whole document is never held in memory.
// Every row is copied field by field in a fixed key order; values keep the protocol v1 availability and money shapes and
// their canonical units. Bounds come from the detail read at the start: rows after them are left out. Node-safe and
// free of Electron. See docs/journal-export.md.
import {
  TRIP_EXPORT_FORMAT, TRIP_EXPORT_FORMAT_VERSION, TRIP_EXPORT_SESSION_ORIGIN, TRIP_EXPORT_UNITS, type JournalEvent, type JournalInterval, type JournalPurpose, type JournalSample,
  type JournalTripDetail, type TripExportBounds, type TripExportHeader, type TripExportSample, type TripExportTrip
} from '../../../packages/contracts/src';

/** The array sections of the document, in the order they are written. */
export const TRIP_EXPORT_SECTIONS = ['intervals', 'events', 'samples'] as const;
export type TripExportSection = typeof TRIP_EXPORT_SECTIONS[number];
/** One row of a section, as a journal page returns it. */
export interface TripExportRows {intervals: JournalInterval; events: JournalEvent; samples: JournalSample}

/** The header of an export of the database `database` (J3, J15). The session origin follows from the purpose. */
export function tripExportHeader(database: {uuid: string; purpose: JournalPurpose; schemaVersion: number}, version: string, exportedUtcMs: number): TripExportHeader {
  return {application: {name: 'ETS2Telemetry', version}, exportedUtcMs, database: {uuid: database.uuid, purpose: database.purpose, schemaVersion: database.schemaVersion},
    sessionOrigin: TRIP_EXPORT_SESSION_ORIGIN[database.purpose]};
}
/** The bounds of the export (J17), fixed by the detail read at its start. An open trip's export is a snapshot. */
export function tripExportBounds(detail: JournalTripDetail): TripExportBounds {
  const b = detail.exportBounds;
  return {committedThroughEventSeq: b.committedThroughEventSeq, lastSampleId: b.lastSampleId, lastIntervalId: b.lastIntervalId, snapshot: detail.trip.outcome === 'open'};
}
/**
 * Whether a row lies inside the bounds (J17): an interval or sample id at most the largest one the detail read saw, an
 * event at most the trip session's committed coverage. A section whose bound is null has no rows to export.
 */
export function withinTripExportBounds<S extends TripExportSection>(section: S, row: TripExportRows[S], bounds: TripExportBounds): boolean {
  if (section === 'events') return BigInt((row as JournalEvent).eventSeq) <= BigInt(bounds.committedThroughEventSeq);
  const last = section === 'intervals' ? bounds.lastIntervalId : bounds.lastSampleId;
  return last !== null && BigInt((row as JournalInterval | JournalSample).id) <= BigInt(last);
}

/** The trip row without the list's job summary; the job section holds the full job values. */
function trip(t: JournalTripDetail['trip']): TripExportTrip {
  return {tripUuid: t.tripUuid, pluginSessionId: t.pluginSessionId, game: t.game, gameMode: {mode: t.gameMode.mode, method: t.gameMode.method, confidence: t.gameMode.confidence},
    gameModeAmbiguous: t.gameModeAmbiguous, outcome: t.outcome, closeReason: t.closeReason, recordingCompleteness: t.recordingCompleteness,
    startedUtcMs: t.startedUtcMs, endedUtcMs: t.endedUtcMs, observedDistanceM: t.observedDistanceM, fuelUsedL: t.fuelUsedL,
    openedBy: t.openedBy, openedEventSeq: t.openedEventSeq, outcomeEventSeq: t.outcomeEventSeq, closedBy: t.closedBy};
}
const interval = (i: JournalInterval): JournalInterval => ({id: i.id, kind: i.kind, annotation: i.annotation, cause: i.cause, startUtcMs: i.startUtcMs, endUtcMs: i.endUtcMs,
  startMonotonicNs: i.startMonotonicNs, endMonotonicNs: i.endMonotonicNs, sourceClockId: i.sourceClockId, firstEventSeq: i.firstEventSeq, lastEventSeq: i.lastEventSeq, detail: i.detail});
const event = (e: JournalEvent): JournalEvent => ({eventSeq: e.eventSeq, type: e.type, occurred: e.occurred, record: e.record,
  attribution: e.attribution === null ? null : {kind: e.attribution.kind, tripUuid: e.attribution.tripUuid}});
const sample = (s: JournalSample): TripExportSample => ({id: s.id, utcMs: s.utcMs, sourceClockId: s.sourceClockId, monotonicNs: s.monotonicNs, gameTime: s.gameTime,
  speed: s.speed, fuel: s.fuel, averageConsumption: s.averageConsumption, estimatedRange: s.estimatedRange, engineRpm: s.engineRpm, gear: s.gear, odometer: s.odometer,
  position: s.position});
const ROW: {[S in TripExportSection]: (row: TripExportRows[S]) => unknown} = {intervals: interval, events: event, samples: sample};

/**
 * Serializes one export document in parts: `begin` writes every fixed section and opens the intervals array, `rows`
 * appends one page of a section (sections advance in TRIP_EXPORT_SECTIONS order and never go back), and `end` closes the
 * remaining arrays and the document. The parts joined in order are one valid JSON document; each row is on its own line.
 */
export class TripExportSerializer {
  #section = -1;
  #rows = 0;
  #ended = false;

  constructor(private readonly detail: JournalTripDetail, private readonly header: TripExportHeader) {}

  begin(): string {
    if (this.#section !== -1) throw new Error('The export document has already begun');
    const d = this.detail;
    const fixed: [string, unknown][] = [['format', TRIP_EXPORT_FORMAT], ['formatVersion', TRIP_EXPORT_FORMAT_VERSION], ['header', this.header], ['units', TRIP_EXPORT_UNITS],
      ['bounds', tripExportBounds(d)], ['trip', trip(d.trip)], ['job', d.job], ['truck', d.truck], ['trailers', d.trailers], ['outcomeDetails', d.outcomeDetails],
      ['money', d.money], ['window', d.window]];
    this.#section = 0; this.#rows = 0;
    return `{\n${fixed.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},\n`).join('')}"${TRIP_EXPORT_SECTIONS[0]}": [`;
  }

  /** One page of `section`; the caller has already left out rows past the bounds. */
  rows<S extends TripExportSection>(section: S, rows: readonly TripExportRows[S][]): string {
    let text = this.#enter(section);
    const copy = ROW[section] as (row: TripExportRows[S]) => unknown;
    for (const row of rows) { text += `${this.#rows === 0 ? '\n' : ',\n'}${JSON.stringify(copy(row))}`; this.#rows++; }
    return text;
  }

  end(): string {
    if (this.#ended || this.#section === -1) throw new Error('The export document is not open');
    const text = this.#enter(TRIP_EXPORT_SECTIONS.at(-1)!);
    this.#ended = true;
    return `${text}${this.#rows === 0 ? '' : '\n'}]\n}\n`;
  }

  /** Closes the arrays before `section` and opens it; sections never go back. */
  #enter(section: TripExportSection): string {
    const target = TRIP_EXPORT_SECTIONS.indexOf(section);
    if (this.#section === -1 || this.#ended || target < this.#section) throw new Error('Export sections are written in order');
    let text = '';
    while (this.#section < target) {
      text += `${this.#rows === 0 ? '' : '\n'}],\n"${TRIP_EXPORT_SECTIONS[++this.#section]}": [`;
      this.#rows = 0;
    }
    return text;
  }
}

/**
 * The default file name (J16): `ets2telemetry-trip-<game>-<YYYYMMDD-HHmm>-<uuid8>.json`, with the trip's start label in
 * UTC, so the name does not depend on the computer's time zone or its daylight-saving changes.
 */
export function tripExportFileName(detail: JournalTripDetail): string {
  const d = new Date(detail.trip.startedUtcMs), p = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isFinite(d.getTime()) ? `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}` : '00000000-0000';
  return `ets2telemetry-trip-${detail.trip.game}-${stamp}-${detail.trip.tripUuid.slice(0, 8)}.json`;
}
