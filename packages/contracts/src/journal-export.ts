// Trip export format version 3. One recorded trip as a versioned JSON document for the user's own
// records: canonical units, stable identifiers, the protocol v1 availability and money shapes, and the bounds that fix
// what an export of a still changing trip contains. The application never imports or restores it. Plain data only;
// Node-safe and renderer-safe. See docs/journal-export.md.
import type {HardModeDetails} from './hard-mode';
import type {JournalCallCode, JournalCallResult, JournalSample} from './index';
import type {JournalEvent, JournalInterval, JournalPurpose, JournalTripDetail} from './journal';
import type {Uint64} from './protocol-v1';

export const TRIP_EXPORT_FORMAT = 'ets2telemetry.trip-export';
/** Bumped by any change to the document below; there is no import, so older versions are never read back. */
export const TRIP_EXPORT_FORMAT_VERSION = 3;

/**
 * The canonical units of every number in the document (J15). Values are never converted for display: a measure of a
 * protocol v1 record also carries its own `unit`, and the trip's observed distance and fuel used name it in the field.
 */
export const TRIP_EXPORT_UNITS = Object.freeze({
  distance: 'm',
  speed: 'm/s',
  fuel: 'L',
  averageConsumption: 'L/100 km (the SDK mean, not a trip average)',
  mass: 'kg',
  engineSpeed: 'rpm',
  gear: 'gear index (0 neutral, negative reverse)',
  cargoDamage: 'fraction (0 to 1)',
  position: 'm (game-world coordinates, not latitude or longitude)',
  gameTime: 'min (game minutes of the game clock named by clockId)',
  monotonicTime: 'ns (the source clock named by its clock id)',
  utcLabel: 'ms since the Unix epoch (a label, not monotonic time)',
  money: 'exact decimal text in the SDK type; currency as documented by the SDK header or unknown, never converted'
} as const);
export type TripExportUnits = typeof TRIP_EXPORT_UNITS;

/** The origin of every plugin session a database holds: a database accepts exactly one origin, fixed by its purpose. */
export const TRIP_EXPORT_SESSION_ORIGIN: Readonly<Record<JournalPurpose, 'game' | 'synthetic' | 'replay'>> = Object.freeze({history: 'game', synthetic: 'synthetic', replay: 'replay'});

export interface TripExportHeader {
  application: {name: 'ETS2Telemetry'; version: string};
  /** UTC label of the moment the export started; never monotonic time. */
  exportedUtcMs: number;
  /** The database the trip was read from (J3). A purpose other than `history` is a test database, never game history. */
  database: {uuid: string; purpose: JournalPurpose; schemaVersion: number};
  /** The origin of the trip's plugin session: `game`, or `synthetic`/`replay` test data. */
  sessionOrigin: 'game' | 'synthetic' | 'replay';
}
/**
 * What the export contains (J17), fixed by the trip detail read at the start of the export: the trip session's committed
 * coverage and the largest sample and interval ids of the trip. Rows written after that read are left out. With
 * `snapshot` true the trip was still open, so a later export can contain more.
 */
export interface TripExportBounds {committedThroughEventSeq: Uint64; lastSampleId: string | null; lastIntervalId: string | null; snapshot: boolean}
/** One stored one-second sample of the trip in canonical units; the trip is the document's own. */
export type TripExportSample = Omit<JournalSample, 'tripUuid'>;
/** The trip section: the stored trip row with its outcome, close reason, recording completeness, UTC labels, observed distance and fuel used. */
export type TripExportTrip = Omit<JournalTripDetail['trip'], 'job' | 'isHardMode' | 'hardModeDetails'> & {is_hard_mode: boolean; hard_mode_details: HardModeDetails | null};

/** Best-effort evidence from retained logs at export, never a claim that every disconnect was observed. */
export interface TripExportDiagnostics {
  collection: 'retained-logs-at-export';
  matchedBy: 'plugin-session-and-utc-window';
  status: 'records-found' | 'no-matching-records' | 'unavailable' | 'not-applicable';
  notes: ('LOGS_MAY_BE_INCOMPLETE' | 'GAME_LOG_UNAVAILABLE' | 'SERVICE_LOG_UNAVAILABLE' | 'RECORD_LIMIT' | 'COLLECTION_FAILED' | 'SOURCE_MODE_ISOLATED' | 'INVALID_TIME_WINDOW' | 'RESTART_CLOSE_CONTEXT')[];
  records: TripExportDiagnosticRecord[];
}
export interface TripExportDiagnosticRecord {
  time: string;
  event: 'PLUGIN_V1_CONNECTION_CLOSED' | 'NATIVE_BROKER_V1_EXIT';
  facts: {game: 'ets2' | 'ats'; pluginSessionId: string; [key: string]: string | number | boolean | null};
}

/** Format version 3 of `ets2telemetry.trip-export`, in key order. */
export interface TripExportDocument {
  format: typeof TRIP_EXPORT_FORMAT;
  formatVersion: typeof TRIP_EXPORT_FORMAT_VERSION;
  header: TripExportHeader;
  units: TripExportUnits;
  bounds: TripExportBounds;
  trip: TripExportTrip;
  job: JournalTripDetail['job'];
  truck: JournalTripDetail['truck'];
  trailers: JournalTripDetail['trailers'];
  outcomeDetails: JournalTripDetail['outcomeDetails'];
  money: JournalTripDetail['money'];
  window: JournalTripDetail['window'];
  diagnostics: TripExportDiagnostics;
  intervals: JournalInterval[];
  events: JournalEvent[];
  samples: TripExportSample[];
}

/**
 * The export's own refusal codes beside the journal's (J11). `EXPORT_TARGET_REFUSED`: the chosen file lies in the
 * application's data directory or is a device path. `EXPORT_WRITE_FAILED`: the file could not be written; the previous
 * file, if any, is unchanged. `EXPORT_IN_PROGRESS`: another export is running. `EXPORT_INTERRUPTED`: the application
 * exited during the export.
 */
export type JournalExportCode = 'EXPORT_TARGET_REFUSED' | 'EXPORT_WRITE_FAILED' | 'EXPORT_IN_PROGRESS' | 'EXPORT_INTERRUPTED';
/** A saved export with the number of rows it holds, or a cancelled dialog. Never a path. */
export type JournalExportOutcome = {outcome: 'saved'; events: number; intervals: number; samples: number} | {outcome: 'cancelled'};
export type JournalExportResult = JournalCallResult<JournalExportOutcome> | {ok: false; code: JournalExportCode};
/** Every refusal code an export can answer. */
export type JournalExportFailureCode = JournalCallCode | JournalExportCode;
