import type {JournalQuantityProvenance, JournalRecordingSource} from '../../../packages/contracts/src/journal';
// The trip export document: pure serialization of `ets2telemetry.trip-export` format version 7.
// The writer (journal-export-writer.ts) reads the trip detail once, then its completeness intervals, timeline events and
// samples page by page, and appends this module's text for each page, so the whole document is never held in memory.
// Every row is copied field by field in a fixed key order; values keep the protocol v1 availability and money shapes and
// their canonical units. Bounds come from the detail read at the start: rows after them are left out. Node-safe and
// free of Electron. See docs/journal-export.md.
import {
  isTruckPowertrain, TRIP_EXPORT_FORMAT, TRIP_EXPORT_FORMAT_VERSION, TRIP_EXPORT_SESSION_ORIGIN, TRIP_EXPORT_UNITS, type JournalEvent, type JournalInterval, type JournalPurpose, type JournalSample,
  type JournalTripDetail, type TripExportBounds, type TripExportDiagnostics, type TripExportHeader, type TripExportSample, type TripExportTrip, type TripExportTruck
} from '../../../packages/contracts/src';
import type {TruckConfiguration} from '../../../packages/contracts/src/protocol-v1';
import type {JournalGame, TruckPowertrain} from '../../../packages/contracts/src';
import {truckEnergyUnit, truckPowertrain} from '../../../packages/telemetry-core/src/truck-powertrain';
import {emptyTripDiagnostics} from './trip-export-diagnostics';

/** The array sections of the document, in the order they are written. */
export const TRIP_EXPORT_SECTIONS = ['sources', 'intervals', 'events', 'samples'] as const;
export type TripExportSection = typeof TRIP_EXPORT_SECTIONS[number];
/** One row of a section, as a journal page returns it. */
export interface TripExportRows {sources:JournalRecordingSource;intervals: JournalInterval; events: JournalEvent; samples: JournalSample}

/** The header of an export of the database `database` (J3, J15). The session origin follows from the purpose. */
export function tripExportHeader(database: {uuid: string; purpose: JournalPurpose; schemaVersion: number}, version: string, exportedUtcMs: number): TripExportHeader {
  return {application: {name: 'ETS2Telemetry', version}, exportedUtcMs, database: {uuid: database.uuid, purpose: database.purpose, schemaVersion: database.schemaVersion},
    sessionOrigin: TRIP_EXPORT_SESSION_ORIGIN[database.purpose]};
}
/** The bounds of the export (J17), fixed by the detail read at its start. An open trip's export is a snapshot. */
export function tripExportBounds(detail: JournalTripDetail): TripExportBounds {
  const b = detail.exportBounds;
  return {...(b.snapshot ? {projection:b.snapshot,sources:b.sources,sourceTotal:b.sourceTotal,accountingHead:b.accountingHead} : {}), committedThroughEventSeq: b.committedThroughEventSeq, lastSampleId: b.lastSampleId, lastIntervalId: b.lastIntervalId, snapshot: detail.trip.outcome === 'open'};
}
/**
 * Whether a row lies inside the bounds (J17): an interval or sample id at most the largest one the detail read saw, an
 * event at most the trip session's committed coverage. A section whose bound is null has no rows to export.
 */
export function withinTripExportBounds<S extends TripExportSection>(section: S, row: TripExportRows[S], bounds: TripExportBounds): boolean {
  if (section === 'sources') return true;
  if (section === 'events' && bounds.projection && (row as JournalEvent).pluginSessionId) {
    const source = bounds.sources?.find(s=>s.pluginSessionId===(row as JournalEvent).pluginSessionId);
    return !source || BigInt((row as JournalEvent).eventSeq)<=BigInt(source.committedThroughEventSeq);
  }
  if (section === 'events') return BigInt((row as JournalEvent).eventSeq) <= BigInt(bounds.committedThroughEventSeq);
  const last = section === 'intervals' ? bounds.lastIntervalId : bounds.lastSampleId;
  return last !== null && BigInt((row as JournalInterval | JournalSample).id) <= BigInt(last);
}

/** A quantity's provenance, copied field by field. */
const provenance = <B extends string, Q extends string>(p: JournalQuantityProvenance<B, Q>): JournalQuantityProvenance<B, Q> => ({status: p.status, breaks: [...p.breaks], quality: [...p.quality]});
/**
 * The trip row without the list's job summary; the job section holds the full job values. The provenance of distance and
 * fuel follows them (null for engine 0); the Journal's page-time membership hint is never written.
 */
function trip(t: JournalTripDetail['trip'], powertrain: TruckPowertrain): TripExportTrip {
  const unit = truckEnergyUnit(powertrain);
  const energyUsed = unit === null && t.fuelUsedL.available ? {available: false, reason: 'unit-unknown'} as const : t.fuelUsedL;
  const accounting = t.accounting;
  return {is_hard_mode: t.isHardMode, hard_mode_details: t.hardModeDetails, tripUuid: t.tripUuid, pluginSessionId: t.pluginSessionId, game: t.game, gameMode: {mode: t.gameMode.mode, method: t.gameMode.method, confidence: t.gameMode.confidence},
    gameModeAmbiguous: t.gameModeAmbiguous, outcome: t.outcome, closeReason: t.closeReason, recordingCompleteness: t.recordingCompleteness,
    startedUtcMs: t.startedUtcMs, endedUtcMs: t.endedUtcMs, observedDistanceM: t.observedDistanceM, powertrain, energyUsed: {...energyUsed, unit},
    accounting: accounting ? {engine: accounting.engine, distance: provenance(accounting.distance),
      fuel: provenance({...accounting.fuel, status: unit === null ? 'unavailable' : accounting.fuel.status})} : null,
    openedBy: t.openedBy, openedEventSeq: t.openedEventSeq, outcomeEventSeq: t.outcomeEventSeq, closedBy: t.closedBy};
}
const exportedIntervalDetail = (i: JournalInterval, tripType: TruckPowertrain): JournalInterval['detail'] => {
  if (i.cause !== 'refuel' || !i.detail) return i.detail;
  const {addedLiters, powertrain, ...detail} = i.detail;
  delete detail.refuelReadings;
  delete detail.readingClock;
  delete detail.readingGameClock;
  const type = isTruckPowertrain(powertrain) ? powertrain : tripType;
  return {...detail, powertrain: type, amountAdded: {value: typeof addedLiters === 'number' ? addedLiters : null, unit: truckEnergyUnit(type)}};
};
const interval = (i: JournalInterval, powertrain: TruckPowertrain): JournalInterval => ({...(i.pluginSessionId ? {pluginSessionId:i.pluginSessionId,rawTripUuid:i.rawTripUuid}:{}),id: i.id, kind: i.kind, annotation: i.annotation, cause: i.cause, startUtcMs: i.startUtcMs, endUtcMs: i.endUtcMs,
  startMonotonicNs: i.startMonotonicNs, endMonotonicNs: i.endMonotonicNs, sourceClockId: i.sourceClockId, firstEventSeq: i.firstEventSeq, lastEventSeq: i.lastEventSeq, detail: exportedIntervalDetail(i, powertrain)});
function truckValues<T extends TruckConfiguration>(values: T, game: JournalGame): Omit<T, 'fuelCapacity'> & TripExportTruck {
  const type = truckPowertrain(game, values.id.available ? values.id.value : undefined);
  return {...values, fuelCapacity: {...values.fuelCapacity, unit: truckEnergyUnit(type)}};
}
const event = (e: JournalEvent, game: JournalGame) => ({...(e.pluginSessionId ? {id:e.id,pluginSessionId:e.pluginSessionId,rawTripUuid:e.rawTripUuid}:{}),eventSeq: e.eventSeq, type: e.type, occurred: e.occurred, record: e.record.type === 'truck.configured' ? truckValues(e.record, game) : e.record,
  attribution: e.attribution === null ? null : {...(e.attribution.logicalTripUuid?{logicalTripUuid:e.attribution.logicalTripUuid}:{}),kind: e.attribution.kind, tripUuid: e.attribution.tripUuid}});
const sample = (s: JournalSample): TripExportSample => ({...(s.pluginSessionId ? {pluginSessionId:s.pluginSessionId,rawTripUuid:s.rawTripUuid,accountingIncluded:s.accountingIncluded}:{}),id: s.id, utcMs: s.utcMs, sourceClockId: s.sourceClockId, monotonicNs: s.monotonicNs, gameTime: s.gameTime, powertrain: s.powertrain ?? 'unknown',
  speed: s.speed, fuel: s.fuel, averageConsumption: s.averageConsumption, estimatedRange: s.estimatedRange, engineRpm: s.engineRpm, gear: s.gear, odometer: s.odometer,
  position: s.position});

/**
 * Serializes one export document in parts: `begin` writes every fixed section and opens the intervals array, `rows`
 * appends one page of a section (sections advance in TRIP_EXPORT_SECTIONS order and never go back), and `end` closes the
 * remaining arrays and the document. The parts joined in order are one valid JSON document; each row is on its own line.
 */
export class TripExportSerializer {
  #section = -1;
  #rows = 0;
  #ended = false;
  private readonly powertrain: TruckPowertrain;
  private readonly row: {[S in TripExportSection]: (row: TripExportRows[S]) => unknown};

  constructor(private readonly detail: JournalTripDetail, private readonly header: TripExportHeader,
    private readonly diagnostics: TripExportDiagnostics = emptyTripDiagnostics(detail)) {
    const {game} = detail.trip, id = detail.truck?.values.id;
    this.powertrain = detail.energyPowertrain ?? truckPowertrain(game, id?.available ? id.value : undefined);
    this.row = {sources: source => ({...source}), intervals: value => interval(value, this.powertrain),
      events: value => event(value, game), samples: sample};
  }

  begin(): string {
    if (this.#section !== -1) throw new Error('The export document has already begun');
    const d = this.detail;
    // Format 7 carries whole-trip money and the raw events. The Journal's retained subtotal is a view field.
    const fixed: [string, unknown][] = [['format', TRIP_EXPORT_FORMAT], ['formatVersion', TRIP_EXPORT_FORMAT_VERSION], ['header', this.header], ['units', TRIP_EXPORT_UNITS],
      ['bounds', tripExportBounds(d)], ['trip', trip(d.trip, this.powertrain)], ['job', d.job], ['truck', d.truck && {...d.truck, values: truckValues(d.truck.values, d.trip.game)}], ['trailers', d.trailers], ['outcomeDetails', d.outcomeDetails],
      ['money', {incomplete: d.money.incomplete, totals: d.money.totals, unavailable: d.money.unavailable}],
      ['window', d.window], ['diagnostics', this.diagnostics]];
    this.#section = 0; this.#rows = 0;
    return `{\n${fixed.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)},\n`).join('')}"${TRIP_EXPORT_SECTIONS[0]}": [`;
  }

  /** One page of `section`; the caller has already left out rows past the bounds. */
  rows<S extends TripExportSection>(section: S, rows: readonly TripExportRows[S][]): string {
    let text = this.#enter(section);
    const copy = this.row[section] as (row: TripExportRows[S]) => unknown;
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
