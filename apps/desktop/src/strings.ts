import type {AppErrorCode, DiagnosticsExportFailure, DiagnosticsExportRefusal, JournalAttributionKind, JournalCallCode, JournalCloseReason, JournalCompleteness, JournalExportCode, JournalIntervalKind, JournalMoneyCategory, JournalOutcome,
  JournalPurpose, OverlayEditPlacement, OverlayLayout, OverlaySectionId, PluginBlockReason, PluginDiscoveryOutcome, PluginFolderRefusal, PluginManualFolderState,
  PluginSetupMode, PluginTargetState, RecordingCode, RecordingHealth, RecordingLosses, RecordingTarget, RecordingTrip, ServiceHealth,
  SettingsSaveError, SettingsState, StorageHealth, UnitGame, UnitProfile} from '../../../packages/contracts/src';
import type {EventType, GameMode, UnavailableReason} from '../../../packages/contracts/src/protocol-v1';
import type {FieldNote, LiveFieldId, LiveSectionId, ViewReason} from '../../../packages/telemetry-core/src/live-view';
import type {OverlayGroupId, OverlayPresetId, OverlayRequirement} from './overlay-sections';
import type {ConnectionDiagnosisCode, ConnectionDiagnosisNote} from './connection-diagnosis';
import type {UninstallBlockCode, UninstallFailureCode} from '../../../packages/contracts/src/uninstall';
import type {FolderNote} from './uninstall/plugin-cleanup';
import type {DataEntry} from './uninstall/data-wipe';

/**
 * User-visible English text for the dashboard and tray. There is no i18n framework yet; keeping the
 * literals here gives a later localization one place to start. Pure data, safe for renderer bundles.
 */
export const STRINGS = Object.freeze({
  appName: 'ETS2Telemetry',
  startupPending: 'Starting',
  startupReady: 'Telemetry service ready; isolated storage probe verified',
  startupFailed: 'Startup failed',
  startupWaiting: 'Waiting for the telemetry service',
  sourceSelectionFailed: 'Source selection failed',
  healthTitle: 'Application status',
  serviceLabel: 'Telemetry service',
  storageLabel: 'Storage self-test',
  recordingLabel: 'Recording',
  recordingProblemTitle: 'Recording problem',
  recordingLossesTitle: 'Gaps recorded since ETS2Telemetry started',
  recordingUpperBound: 'These totals may be an upper bound: after a telemetry service restart in the same game session a restored-database loss is counted again. The database itself is correct.',
  recordingTrayPrefix: 'Recording: ',
  lastErrorLabel: 'Last problem',
  closeToTray: 'Closing this window keeps ETS2Telemetry running in the notification area. Open it again from the tray icon; use Exit to stop it.',
  exitAction: 'Exit ETS2Telemetry',
  exitPending: 'Exiting…',
  exitFailed: 'Exit request failed',
  trayOpen: 'Open ETS2Telemetry',
  trayExit: 'Exit ETS2Telemetry',
  trayStarting: 'Starting',
  trayExiting: 'Exiting',
  serviceFailedTitle: 'Telemetry service problem',
  unitsTitle: 'Display units',
  unitsSaveFailed: 'The unit change was not saved; the previous units stay in use.',
  liveTitle: 'Live telemetry',
  livePaused: 'Game paused',
  liveNoJob: 'No job reported',
  liveJobUnavailable: 'Job unavailable',
  liveSourceTitle: 'Protocol v1 source',
  liveEventLossNote: 'this version records no gameplay events',
  overlayTitle: 'Overlay',
  overlayLayoutLabel: 'Layout',
  overlaySectionsLabel: 'Sections',
  overlayPresetsLabel: 'Presets',
  overlayPaused: 'Paused',
  overlayNoSignal: 'No signal',
  overlaySynthetic: 'Synthetic',
  overlayReplay: 'Replay',
  overlaySdkMean: 'SDK mean',
  overlaySaveFailed: 'The overlay change was not saved; the previous overlay settings stay in use.',
  overlayLastSection: 'At least one section stays on.',
  overlayHiddenNote: 'While telemetry is current, a section without data is hidden (speed and fuel show a dash). While it is not current, every shown section is a dash.',
  overlayPlacementLabel: 'Position and size',
  overlayScaleLabel: 'Scale',
  overlayEditAction: 'Edit position',
  overlayScaleDown: 'Smaller',
  overlayScaleUp: 'Larger',
  overlayResetPlacement: 'Reset to default',
  overlayEditDone: 'Done',
  overlayEditCancel: 'Cancel',
  overlayEditHelp: 'Drag the outlined overlay over the game to move it. Enter on the overlay saves, Esc cancels. The layout cannot change while you edit.',
  overlayEditFailed: 'The overlay edit request failed; the saved position and size stay in use.'
});
export type StringKey = keyof typeof STRINGS;

export const SERVICE_HEALTH_TEXT: Readonly<Record<ServiceHealth, string>> = Object.freeze({
  starting: 'starting', ready: 'ready', restarting: 'restarting', failed: 'failed', stopping: 'stopping'
});
export const STORAGE_HEALTH_TEXT: Readonly<Record<StorageHealth, string>> = Object.freeze({
  pending: 'pending', verified: 'verified', failed: 'failed'
});
export const APP_ERROR_TEXT: Readonly<Record<AppErrorCode, string>> = Object.freeze({
  SERVICE_EXITED: 'The telemetry service stopped unexpectedly.',
  SERVICE_RESTART_EXHAUSTED: 'Automatic service restart limit reached. Exit and start ETS2Telemetry again.',
  STORAGE_FAILED: 'The isolated storage self-test failed.',
  SERVICE_START_TIMEOUT: 'The telemetry service did not start in time.'
});
// Recording status text (ET-015c PR-4, G8). apps/desktop/src/recording-status-text.ts composes these; each map covers
// every state, code, target, trip phase and loss counter, so a new value fails to compile until it has a text.
/** The headline of each recording state; retrying and stopped add their cause. */
export const RECORDING_STATE_TEXT: Readonly<Record<RecordingHealth['state'], string>> = Object.freeze({
  'disabled': 'Off: this version does not record game history',
  'unknown': 'Not known: the telemetry service is not running or has not reported a valid status',
  'opening': 'Opening the database',
  'waiting': 'Waiting for the recorded source to connect',
  'recording': 'Recording',
  'paused': 'Game paused; recording continues when it resumes',
  'interrupted': 'Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap',
  'retrying': 'Retrying: {cause}. Nothing is acknowledged until storage commits; events while reconnecting are recorded as a gap',
  'stopped': 'Stopped: {cause}. Restart ETS2Telemetry after fixing it',
  'live-only': 'Not recording this game session: the database is behind the plugin (restored database); recording resumes with the next game session',
  'not-recorded-source': 'Not recording the selected source'
});
/** The tray's short form after `Recording: `; retrying and stopped add their cause. */
export const RECORDING_STATE_SHORT_TEXT: Readonly<Record<RecordingHealth['state'], string>> = Object.freeze({
  'disabled': 'off in this version',
  'unknown': 'not known',
  'opening': 'opening the database',
  'waiting': 'waiting for the source',
  'recording': 'on',
  'paused': 'game paused',
  'interrupted': 'connection lost',
  'retrying': 'retrying, {cause}',
  'stopped': 'stopped, {cause}',
  'live-only': 'not this game session',
  'not-recorded-source': 'not this source'
});
/** What a recording code means, as a cause inside a sentence. Never a path or error text. */
export const RECORDING_CODE_TEXT: Readonly<Record<RecordingCode, string>> = Object.freeze({
  DATABASE_LOCKED: 'the database is locked by another program',
  PERMISSION_DENIED: 'no permission to write the database',
  DISK_FULL: 'the disk is full',
  IO_ERROR: 'a disk read or write failed',
  DATABASE_CORRUPT: 'the database is damaged',
  CONSTRAINT_VIOLATION: 'storage refused inconsistent data',
  INVALID_INPUT: 'storage refused invalid data',
  UNKNOWN_SESSION: 'storage does not know this game session',
  UNKNOWN_TRIP: 'storage does not know this trip',
  SESSION_CONFLICT: 'this game session conflicts with the stored one',
  VALUE_OUT_OF_RANGE: 'a value was out of range',
  STORAGE_CLOSED: 'the database is closed',
  STORAGE_BUSY: 'storage is busy',
  WORKER_FAILED: 'the storage worker failed',
  TIMEOUT: 'storage did not answer in time',
  DATA_PATH_INVALID: 'the data folder cannot be used',
  DATABASE_UNRECOGNIZED: 'the database file is not an ETS2Telemetry database',
  SCHEMA_NEWER: 'the database was written by a newer version',
  PURPOSE_MISMATCH: 'the database holds another kind of data',
  DURABILITY_UNVERIFIED: 'safe disk writes could not be confirmed',
  BACKUP_FAILED: 'the backup before a database upgrade failed',
  MIGRATION_FAILED: 'the database upgrade failed',
  INTERNAL: 'an internal error occurred',
  TRIP_ORDER_VIOLATION: 'trip events arrived out of order',
  TRIP_COVERAGE_MISMATCH: 'the trip records do not match the stored coverage',
  TRIP_UNKNOWN_SESSION: 'a trip belongs to an unknown game session',
  BACKLOG_FULL: 'too much work is waiting for storage',
  COVERAGE_MISMATCH: 'the plugin and the database disagree about what was stored',
  ACK_AHEAD_OF_STORAGE: 'the database is behind the plugin'
});
/** The database a recording writes, shown only for a test database. */
export const RECORDING_TARGET_TEXT: Readonly<Record<RecordingTarget, string | null>> = Object.freeze({
  history: null,
  synthetic: 'Synthetic test database (never game history)',
  replay: 'Replay test database (never game history)'
});
/** The tray's form of a test database target, after the short state. */
export const RECORDING_TARGET_SHORT_TEXT: Readonly<Record<RecordingTarget, string | null>> = Object.freeze({
  history: null, synthetic: 'synthetic test database', replay: 'replay test database'
});
/**
 * The current trip; an idle trip without an untracked job shows nothing. Since ET-016 PR-7 (J9) a job that started before
 * recording opens a partial trip once the replayed events have drained, so an untracked job is either such a job before
 * its trip opens (or when a live clear, outcome or gap prevented it) or the job of a trip a recording gap ended. The status
 * carries only a flag, not the cause, so the line names both (PR-7 review round 1).
 */
export const RECORDING_TRIP_TEXT = Object.freeze({
  untrackedJob: 'The current job is not tracked as a trip: it started before recording, or a recording gap ended its trip',
  completeness: Object.freeze({
    unknown: 'The current trip\'s completeness is not known yet', partial: 'Current trip is partial', complete: 'Current trip is recorded completely so far'
  }) satisfies Readonly<Record<NonNullable<RecordingTrip['completeness']>, string>>,
  open: 'A trip is in progress',
  phase: Object.freeze({'idle': null, 'active': null, 'awaiting-outcome': 'waiting for its delivery outcome', 'reload-check': 'checking a loaded save'}) satisfies
    Readonly<Record<RecordingTrip['phase'], string | null>>
});
/** One line per non-zero loss counter, with `{count}` replaced. */
export const RECORDING_LOSS_TEXT: Readonly<Record<keyof RecordingLosses, string>> = Object.freeze({
  lostEvents: 'Lost events: {count}',
  eventLoss: 'Event loss intervals: {count}',
  notConnected: 'Intervals without a connection: {count}',
  sampleLoss: 'One-second sample loss intervals: {count}',
  restoreLoss: 'Restored-database intervals: {count}',
  droppedSamples: 'Dropped one-second samples: {count}'
});
/** The status card's prototype notice for the recording state: no recording, not known, a test database or history. */
export const PROTOTYPE_NOTICE_TEXT = Object.freeze({
  disabled: 'Prototype live display. No trip recording or durable history.',
  unknown: 'Prototype live display. The recording status is not known right now.',
  test: 'Prototype live display. Only a test database is recorded, never game history.',
  history: 'Prototype live display. Game history recording is new; check the recording status below.'
});
/** The Alert below the recording row while recording is retrying, stopped or live-only. */
export const RECORDING_ALERT_TEXT = Object.freeze({
  retrying: 'ETS2Telemetry retries automatically. Live telemetry and the overlay keep working.',
  stopped: 'Recording stopped until the telemetry service starts again. Live telemetry and the overlay keep working.',
  liveOnly: 'Live telemetry and the overlay keep working; this game session is not recorded.'
});
/**
 * Shown in the units card and the overlay card for the last refused save; never part of the service's last problem.
 * Neutral wording: either card's change may have been refused.
 */
export const SETTINGS_SAVE_ERROR_TEXT: Readonly<Record<SettingsSaveError, string>> = Object.freeze({
  SETTINGS_WRITE_FAILED: 'The change could not be saved; the previous settings stay in use.',
  SETTINGS_READ_ONLY: 'Settings were written by a newer version and are read-only; the change was not saved.'
});
export const UNIT_GAME_TEXT: Readonly<Record<UnitGame, string>> = Object.freeze({
  ets2: 'Euro Truck Simulator 2', ats: 'American Truck Simulator'
});
export const UNIT_PROFILE_TEXT: Readonly<Record<UnitProfile, string>> = Object.freeze({
  'metric': 'Metric (km/h, L)', 'us-customary': 'US customary (mph, US gal)'
});
/** How the persisted settings were obtained; shown under the unit choices. Never contains a path. */
export const SETTINGS_STATE_TEXT: Readonly<Record<SettingsState, string>> = Object.freeze({
  'loading': 'Saved settings are still being read; defaults are in use and changes cannot be saved yet.',
  'defaults': 'Default settings. A change is saved for later launches.',
  'loaded': 'Saved settings loaded.',
  'loaded-with-fallbacks': 'Some saved settings were invalid; their defaults are in use until the next change.',
  'invalid-file': 'The settings file is invalid; defaults are in use. The file is kept and set aside when you save a change.',
  'unsupported-older': 'The settings file has an unsupported older format; defaults are in use. The file is kept and set aside when you save a change.',
  'newer-version': 'Settings were written by a newer version and are read-only; defaults are in use.',
  'unreadable': 'Settings could not be read safely; defaults are in use and changes cannot be saved.',
  'unavailable': 'No settings location is available; defaults are in use and changes cannot be saved.'
});

// Live dashboard labels (ET-010 N5). Each map covers every telemetry-core id, so a new id fails to compile until it
// has a text. Values themselves are formatted by telemetry-core; these maps hold only labels, reasons and notes.
export const LIVE_FIELD_TEXT: Readonly<Record<LiveFieldId, string>> = Object.freeze({
  'speed': 'Speed', 'gear': 'Gear', 'engine-rpm': 'Engine RPM', 'fuel': 'Fuel', 'fuel-capacity': 'Fuel capacity', 'fuel-level': 'Fuel level',
  'sdk-average-consumption': 'SDK average consumption', 'estimated-range': 'Estimated range', 'odometer': 'Odometer',
  'route-remaining': 'Route remaining', 'game-time': 'Game time', 'deadline': 'Delivery deadline', 'cargo': 'Cargo', 'source-city': 'Source city',
  'source-company': 'Source company', 'destination-city': 'Destination city', 'destination-company': 'Destination company',
  'cargo-mass': 'Cargo mass', 'market': 'Job market', 'special-job': 'Special job', 'cargo-loaded': 'Cargo loaded',
  'planned-distance': 'Planned distance', 'expected-income': 'Expected income', 'truck': 'Truck', 'truck-plate': 'License plate',
  'trailers': 'Trailers', 'position': 'World position', 'bearing': 'Heading', 'game-mode': 'Game mode', 'event-loss': 'Lost events'
});
/** Why a row shows `unavailable` (or `none`). `not-carried` rows are hidden, so that text is never rendered. */
export const VIEW_REASON_TEXT: Readonly<Record<ViewReason, string>> = Object.freeze({
  'not-observed': 'not yet observed', 'not-supported': 'not provided by the game', 'invalid': 'invalid reading',
  'not-carried': 'not carried by this protocol', 'not-current': 'not current', 'zero-consumption': 'no consumption recorded',
  'no-trailer': 'no trailer attached'
});
/** Context shown beside a label; the SDK average is never presented as a trip average. */
export const FIELD_NOTE_TEXT: Readonly<Record<FieldNote, string>> = Object.freeze({
  'sdk-mean': 'SDK mean, not a trip average', 'ats-mostly-static': 'mostly static in ATS per the SDK header',
  'game-estimate': "the game's estimate", 'job-offer-excludes-ferry': 'from the job offer, excludes ferries', 'game-time': 'game time',
  'game-world-coordinates': 'game-world coordinates, not GPS', 'cargo-market-only': 'cargo market jobs only'
});
export const LIVE_SECTION_TEXT: Readonly<Record<LiveSectionId, string>> = Object.freeze({
  motion: 'Driving', fuel: 'Fuel', distance: 'Distance', time: 'Time', job: 'Job', vehicle: 'Vehicle', position: 'Position'
});

// Overlay labels (ET-012a). Each map covers every id, so a new layout, section, group, preset or requirement fails to
// compile until it has a text. Values are formatted by telemetry-core in main; these maps hold only labels.
export const OVERLAY_LAYOUT_TEXT: Readonly<Record<OverlayLayout, string>> = Object.freeze({
  strip: 'Strip (top centre)', card: 'Card (top right)', cluster: 'Cluster (bottom left)', hud: 'Minimal HUD (top left)'
});
/** Full labels for the settings card and the overlay card layout. Income is expected income, never revenue. */
export const OVERLAY_SECTION_TEXT: Readonly<Record<OverlaySectionId, string>> = Object.freeze({
  'speed': 'Speed', 'gear': 'Gear', 'rpm': 'Engine RPM', 'fuel': 'Fuel', 'range': 'Estimated range', 'sdk-consumption': 'SDK average consumption',
  'cargo': 'Cargo', 'origin': 'Origin', 'destination': 'Destination', 'distance-driven': 'Distance driven', 'distance-remaining': 'Distance remaining',
  'deadline': 'Delivery deadline', 'expected-income': 'Expected income', 'game-time': 'Game time'
});
/** Short labels for the strip, cluster panel and HUD. */
export const OVERLAY_SECTION_SHORT_TEXT: Readonly<Record<OverlaySectionId, string>> = Object.freeze({
  'speed': 'Speed', 'gear': 'Gear', 'rpm': 'RPM', 'fuel': 'Fuel', 'range': 'Range', 'sdk-consumption': 'SDK mean',
  'cargo': 'Cargo', 'origin': 'From', 'destination': 'To', 'distance-driven': 'Driven', 'distance-remaining': 'Remaining',
  'deadline': 'Due', 'expected-income': 'Expected', 'game-time': 'Time'
});
export const OVERLAY_GROUP_TEXT: Readonly<Record<OverlayGroupId, string>> = Object.freeze({
  driving: 'Driving', fuel: 'Fuel', job: 'Job', time: 'Time'
});
export const OVERLAY_PRESET_TEXT: Readonly<Record<OverlayPresetId, string>> = Object.freeze({
  'everything': 'Everything', 'job-focus': 'Job focus', 'driving-only': 'Driving only'
});
/** Where the overlay is while its position is edited (ET-012b); shown in the overlay card. */
export const OVERLAY_EDIT_PLACEMENT_TEXT: Readonly<Record<OverlayEditPlacement, string>> = Object.freeze({
  'visible': 'Editing: the overlay is outlined over the game. Drag it to move it.',
  'waiting-for-game': 'Editing: waiting for the game window. Start the game in windowed or borderless mode and keep it open, not minimized.',
  'too-large': 'Editing: at this scale the overlay does not fit the game window. Make it smaller.',
  'not-foreground': 'Editing: the overlay is hidden while another application or the game is in front. Click this window to show it again.'
});
/** Why a section may stay hidden in this version; shown beside its switch. */
export const OVERLAY_REQUIREMENT_TEXT: Readonly<Record<OverlayRequirement, string>> = Object.freeze({
  'protocol-v1': "needs the plugin's protocol v1 data",
  'trip-tracking': 'needs trip tracking; hidden for now',
  'ids-until-v1': 'shows game ids without protocol v1'
});

// Trip journal text (ET-016 PR-4, J12-J14). apps/desktop/src/journal-view.ts composes these; each map covers every
// code, outcome, close reason, completeness, interval kind, event type and attribution, so a new value fails to compile
// until it has a text. The journal never shows a path, SQL or storage error text.
export const JOURNAL_STRINGS = Object.freeze({
  liveTab: 'Live',
  journalTab: 'Journal',
  title: 'Trip journal',
  refresh: 'Refresh',
  loading: 'Loading…',
  previous: 'Previous',
  next: 'Next',
  back: 'Back to the list',
  open: 'Details',
  gameFilter: 'Game',
  outcomeFilter: 'Outcome',
  completenessFilter: 'Recording',
  allFilter: 'All',
  empty: 'No trips recorded',
  emptyFiltered: 'No trips match these filters',
  noMoreTrips: 'No more trips.',
  noMoreEvents: 'No more events in this window.',
  noMoreIntervals: 'No more completeness intervals.',
  noMoreSamples: 'No more one-second samples.',
  renderFailed: 'The journal could not be shown. Open the Live tab and then the Journal tab again to retry.',
  recordingOffNote: 'Game history recording is off in this version, so no game trips are recorded yet.',
  requestRefused: 'The journal request was refused.',
  pageNote: 'Page {page}. The journal does not update by itself; use Refresh.',
  unavailable: 'unavailable',
  emptyText: '(empty)',
  none: 'none',
  inProgress: 'not yet (in progress)',
  noOutcome: 'none (no delivery or cancellation)',
  notDelivered: 'none (not delivered)',
  summaryTab: 'Summary',
  intervalsTab: 'Completeness',
  timelineTab: 'Timeline',
  samplesTab: 'Samples',
  intervalsTotal: 'Completeness intervals recorded for this trip: {count}.',
  noIntervals: 'No completeness intervals were recorded for this trip.',
  noEvents: 'No events in this window.',
  noSamples: 'No one-second samples were recorded for this trip.',
  sampleGap: 'no samples for {seconds} s',
  sourceRestarted: 'source restarted',
  trailerTotal: 'Showing the latest {shown} of {total} trailer configurations.',
  noTruck: 'No truck was recorded for this trip. A trip whose recording started during the job has no truck until the game sends it again.',
  noTrailers: 'No trailer was recorded for this trip. A trip whose recording started during the job has no trailer until the game sends it again.',
  moneyNote: 'Amounts are the exact game values. They are never converted, netted or added across currencies.',
  moneyIncomplete: 'This trip has more than 5,000 amounts; no totals are shown, so a partial sum is never presented as a total.',
  moneyNone: 'none recorded',
  moneyCount: '{count} amounts',
  moneyCountOne: '1 amount',
  moneyUnavailable: '{count} unavailable ({reason})',
  timeNote: 'Times are the recorded UTC labels shown in local time.',
  annotation: 'annotation; completeness unchanged',
  eventRange: 'eventSeq {first}–{last}',
  windowOpen: "Events of the trip's plugin session from eventSeq {from}; the trip is in progress.",
  windowCloseEvent: "Events of the trip's plugin session from eventSeq {from} through {through}, the event that closed the trip.",
  windowCloseGap: "Events of the trip's plugin session from eventSeq {from} through {through}; lost events closed the trip.",
  windowEndOfSession: "Events of the trip's plugin session from eventSeq {from} to the end of that session; a later session closed the trip.",
  windowUnknown: 'This trip was closed before schema version 2, so its window is unknown. Only the events attributed to it or referenced by it are listed.',
  gameModeChanged: 'changed during the trip',
  zeroConsumption: 'no consumption recorded'
});
/** The persistent banner of a test database (J3); history has none. */
export const JOURNAL_PURPOSE_TEXT: Readonly<Record<JournalPurpose, string | null>> = Object.freeze({
  history: null,
  synthetic: 'Synthetic test database — never game history',
  replay: 'Replay test database — never game history'
});
/** Every journal refusal code as fixed text (J11). `{cause}` is the storage code's text from RECORDING_CODE_TEXT. */
export const JOURNAL_ERROR_TEXT: Readonly<Record<JournalCallCode, string>> = Object.freeze({
  SERVICE_UNAVAILABLE: 'The telemetry service is not available right now. Try again when it is ready.',
  DATABASE_OPENING: 'The database is still opening. Try again in a moment.',
  DATABASE_UNAVAILABLE: 'The database is unavailable: {cause}.',
  BUSY: 'The journal is busy with other requests. Try again.',
  TIMEOUT: 'The journal did not answer in time. Try again.',
  NOT_FOUND: 'This trip is not in the database.',
  FAILED: 'The journal could not be read.'
});
/**
 * The trip export (ET-016 PR-5, J16, J18). The note next to Export states the owner's uninstall rule of October 16, 2026
 * and that the export is a copy that cannot be imported. Results never name a path.
 */
export const JOURNAL_EXPORT_STRINGS = Object.freeze({
  button: 'Export JSON',
  exporting: 'Exporting…',
  note: 'Uninstalling ETS2Telemetry removes its local trip history and settings. The JSON export is a copy for your own records; it cannot be imported back.',
  saved: 'Saved the trip as JSON: {events} events, {intervals} completeness intervals and {samples} one-second samples.',
  cancelled: 'Export cancelled. Nothing was written.',
  refused: 'The export request was refused.'
});
/** The export's own refusal codes as fixed text; the journal codes use JOURNAL_ERROR_TEXT. */
export const JOURNAL_EXPORT_ERROR_TEXT: Readonly<Record<JournalExportCode, string>> = Object.freeze({
  EXPORT_TARGET_REFUSED: 'That location cannot be used. Choose a folder outside the ETS2Telemetry data folder.',
  EXPORT_WRITE_FAILED: 'The file could not be written. A file that already had this name is unchanged.',
  EXPORT_IN_PROGRESS: 'Another export is still running. Try again when it has finished.',
  EXPORT_INTERRUPTED: 'The export stopped because ETS2Telemetry is exiting. Nothing was written.'
});
export const JOURNAL_GAME_TEXT: Readonly<Record<UnitGame, string>> = Object.freeze({ets2: 'ETS2', ats: 'ATS'});
/** Outcome and recording completeness are separate (J13); neither is inferred from the other. */
export const JOURNAL_OUTCOME_TEXT: Readonly<Record<JournalOutcome, string>> = Object.freeze({
  open: 'In progress', delivered: 'Delivered', cancelled: 'Cancelled', none: 'No outcome'
});
/** Why a trip without an outcome closed, after `No outcome — `. */
export const JOURNAL_CLOSE_REASON_TEXT: Readonly<Record<JournalCloseReason, string>> = Object.freeze({
  'outcome': 'delivery outcome',
  'configuration-cleared': 'job cleared',
  'different-job': 'a different job started',
  'restart': 'the game or plugin restarted',
  'discontinuity': 'a loaded save or game time change',
  'gap': 'events were lost'
});
export const JOURNAL_COMPLETENESS_TEXT: Readonly<Record<JournalCompleteness, string>> = Object.freeze({
  complete: 'Complete', partial: 'Partial', unknown: 'Unknown'
});
/** Why a stored value is unavailable, inside `unavailable (…)`. */
export const JOURNAL_REASON_TEXT: Readonly<Record<UnavailableReason, string>> = Object.freeze({
  'not-observed': 'not observed', 'not-supported': 'not provided by the game', 'invalid': 'invalid reading'
});
export const JOURNAL_GAME_MODE_TEXT: Readonly<Record<GameMode['mode'] | 'convoy', string>> = Object.freeze({
  'single-player': 'Single-player', 'truckersmp': 'TruckersMP', 'unknown': 'Unknown', 'convoy': 'Convoy'
});
/** Detection evidence: a weak result is never presented as confirmed (D9). */
export const JOURNAL_GAME_MODE_EVIDENCE_TEXT = Object.freeze({
  confidence: Object.freeze({strong: 'strong evidence', weak: 'weak evidence, not confirmed', none: 'no evidence'}) satisfies Readonly<Record<GameMode['confidence'], string>>,
  method: Object.freeze({'module-scan': 'module scan', 'process-scan': 'process scan', 'none': 'no detection'}) satisfies Readonly<Record<GameMode['method'], string>>
});
export const JOURNAL_INTERVAL_KIND_TEXT: Readonly<Record<JournalIntervalKind, string>> = Object.freeze({
  'event-loss': 'Lost events', 'not-connected': 'Not connected', 'storage-unavailable': 'Storage unavailable', 'sample-loss': 'Missing one-second samples',
  'discontinuity': 'Discontinuity', 'restore-loss': 'Restored database'
});
/** The interval causes the recorder writes (docs/trips.md#interval-detail-keys); any other cause shows as JOURNAL_OTHER_CAUSE. */
export const JOURNAL_INTERVAL_CAUSE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'opened-at-load': 'opened while a save was loading', 'late-attach': 'recording started during the job', 'opened-before-attach': 'job began before recording',
  'restart': 'continues a trip closed by a restart', 'gap': 'lost events', 'discontinuity': 'continues a trip closed by a discontinuity',
  'configuration-cleared': 'continues a trip whose job was cleared', 'reload': 'save reloaded', 'save-load': 'save loaded', 'disconnected': 'source disconnected',
  'consumer-restart': 'telemetry service restarted', 'reading-hole': 'readings missing', 'truck-change': 'truck changed', 'utc-label-jump': 'clock label jumped back',
  'odometer-regressed': 'odometer went back', 'odometer-jump': 'odometer jumped', 'game-time-jump': 'game time jumped', 'position-jump': 'position jumped',
  'refuel': 'refuelled', 'sample-backlog': 'samples could not be stored in time', 'ack-ahead-of-storage': 'database behind the plugin'
});
export const JOURNAL_OTHER_CAUSE = 'other';
export const JOURNAL_EVENT_TYPE_TEXT: Readonly<Record<EventType, string>> = Object.freeze({
  'job.configured': 'Job configured', 'job.cleared': 'Job cleared', 'truck.configured': 'Truck configured', 'truck.cleared': 'Truck cleared',
  'trailer.configured': 'Trailer configured', 'trailer.cleared': 'Trailer detached', 'simulation.paused': 'Game paused', 'simulation.started': 'Game resumed',
  'timers.restart': 'Game timers restarted', 'gameTime.regression': 'Game time went back', 'job.delivered': 'Delivered', 'job.cancelled': 'Cancelled',
  'player.fined': 'Fine', 'player.tollgate.paid': 'Toll', 'player.use.ferry': 'Ferry', 'player.use.train': 'Train', 'source.gameMode': 'Game mode detected'
});
/** Who an event belongs to, seen from the trip shown; `none` when it has no attribution. */
export const JOURNAL_ATTRIBUTION_TEXT: Readonly<Record<JournalAttributionKind | 'other-trip' | 'none', string>> = Object.freeze({
  'trip': 'this trip', 'trip-before-loaded': 'this trip, before the cargo was loaded', 'free-driving': 'free driving', 'ambiguous': 'ambiguous',
  'other-trip': 'another trip', 'none': '—'
});
export const JOURNAL_MONEY_CATEGORY_TEXT: Readonly<Record<JournalMoneyCategory, string>> = Object.freeze({
  fine: 'Fines', toll: 'Tolls', ferry: 'Ferries', train: 'Trains'
});
/** Section titles of the trip detail. */
export const JOURNAL_SECTION_TEXT = Object.freeze({
  trip: 'Trip', distance: 'Distance', fuel: 'Fuel', money: 'Money', job: 'Job', delivery: 'Delivery', truck: 'Truck', trailers: 'Trailers', samples: 'One-second samples'
});
/** Field and column labels of the journal. */
export const JOURNAL_LABEL_TEXT = Object.freeze({
  game: 'Game', gameMode: 'Game mode', outcome: 'Outcome', completeness: 'Recording', started: 'Started', ended: 'Ended', tripId: 'Trip ID', session: 'Plugin session',
  openedBy: 'Opened by', route: 'Route', cargo: 'Cargo',
  plannedDistance: 'Planned distance', observedDistance: 'Observed distance', deliveredDistance: 'Delivered distance', fuelUsed: 'Fuel used',
  expectedIncome: 'Expected income', revenue: 'Revenue', penalty: 'Penalty', revenueOrPenalty: 'Revenue or penalty',
  sourceCity: 'Source city', sourceCompany: 'Source company', destinationCity: 'Destination city', destinationCompany: 'Destination company', cargoMass: 'Cargo mass',
  market: 'Job market', specialJob: 'Special job', cargoLoaded: 'Cargo loaded', deadline: 'Delivery deadline', jobSource: 'Job recorded from',
  earnedXp: 'XP earned', cargoDamage: 'Cargo damage', deliveryDuration: 'Delivery duration', autoPark: 'Auto park used', autoLoad: 'Auto load used',
  brand: 'Brand', model: 'Model', licensePlate: 'License plate', plateCountry: 'Plate country', fuelCapacity: 'Fuel capacity', bodyType: 'Body type',
  trailer: 'Trailer {number}', trailerBrand: 'Trailer {number} brand', trailerModel: 'Trailer {number} model', trailerBody: 'Trailer {number} body type',
  trailerPlate: 'Trailer {number} license plate', sampleCount: 'Samples', firstSample: 'First sample', lastSample: 'Last sample',
  time: 'Time', eventSeq: 'eventSeq', type: 'Event', detail: 'Detail', attribution: 'Belongs to', kind: 'Kind', cause: 'Cause', start: 'Start', end: 'End', events: 'Events',
  speed: 'Speed', fuel: 'Fuel', consumption: 'SDK average consumption', range: 'Estimated range', rpm: 'Engine RPM', gear: 'Gear', odometer: 'Odometer',
  gameTime: 'Game time', position: 'World position'
});
/** Context beside a label: what each distance, amount and value means. */
export const JOURNAL_NOTE_TEXT = Object.freeze({
  plannedDistance: 'job offer, excludes ferries', observedDistance: 'odometer while recording', deliveredDistance: 'reported by the game',
  fuelUsed: 'while recording, refuels excluded', expectedIncome: 'job offer', revenue: 'reported by the game', penalty: 'reported by the game',
  deadline: 'game time', deliveryDuration: 'game time', consumption: 'SDK mean, not a trip average', position: 'game-world coordinates, not GPS'
});
/** How the trip opened and where its job values came from; `{eventSeq}` is replaced. */
export const JOURNAL_OPENED_BY_TEXT = Object.freeze({
  event: 'job event {eventSeq}', checkpoint: 'checkpoint (recording started during the job)'
});
export const JOURNAL_JOB_SOURCE_TEXT = Object.freeze({
  event: 'job event {eventSeq}', checkpoint: 'checkpoint at eventSeq {eventSeq} (recording started during the job)'
});

/**
 * The Game plugin card (ET-017 PR-5, P18). Fixed texts for every mode, discovery outcome, folder state, block reason and
 * refusal of AppState.plugins; apps/desktop/src/plugin-setup-text.ts picks them. Never a path: a game folder is named
 * by its source and position only.
 */
export const PLUGIN_STRINGS = Object.freeze({
  title: 'Game plugin',
  diagnosisLabel: 'Connection',
  bundled: 'Bundled plugin: {version} ({hash})',
  bundledUnknown: 'Bundled plugin: not checked yet',
  running: 'Checking the game folders…',
  manage: 'Manage the plugin for this game',
  chooseFolder: 'Choose game folder…',
  retry: 'Retry',
  showFile: 'Show plugin file',
  openFolder: 'Open game plugins folder',
  steamFolder: 'Steam folder {number}',
  manualFolder: 'Chosen folder',
  noFolders: 'No game folder found yet.',
  notSearched: 'Not searched in this launch.',
  unrecognizedExcluded: 'A file with the plugin\'s name that this application did not install is in this folder; it is left as it is.',
  unreadableFile: 'The plugin file in this folder could not be read or checked, so it is left as it is.',
  installedVersion: 'Installed plugin: {version} ({hash})',
  unknownVersion: 'unknown version',
  lastFailure: 'Last problem: {reason}',
  unlistedOne: '1 more Steam folder of this game is not listed; the plugin is not installed there, but excluding the game removes it there too.',
  unlistedMany: '{count} more Steam folders of this game are not listed; the plugin is not installed there, but excluding the game removes it there too.',
  manualCopy: 'To install it by hand: close the game, copy the plugin file into the game\'s plugins folder (Windows may ask for administrator rights), then press Retry.',
  manualRemove: 'To remove it by hand: close the game, delete the plugin file from the game\'s plugins folder (Windows may ask for administrator rights), then press Retry.',
  requestFailed: 'The request failed; nothing changed.',
  folderChosen: 'Game folder saved; the plugin is being set up there.',
  folderCancelled: 'No folder chosen; nothing changed.',
  fileShown: 'The plugin file is shown in Explorer.',
  fileUnavailable: 'The bundled plugin file is not available; nothing was shown.'
});
export const PLUGIN_MODE_TEXT: Readonly<Record<PluginSetupMode, string | null>> = Object.freeze({
  'active': null,
  'test-root': 'Test mode: plugin setup works only inside a test folder.',
  'disabled': 'Plugin setup is off in this launch (a development, test or opt-out launch); no game folder is changed.'
});
export const PLUGIN_DISCOVERY_TEXT: Readonly<Record<PluginDiscoveryOutcome, string>> = Object.freeze({
  'pending': 'Looking for the game…',
  'found': 'Found through Steam.',
  'not-found': 'Not found in the Steam libraries. Choose the game folder if it is installed elsewhere.',
  'steam-not-found': 'Steam was not found. Choose the game folder if the game is installed.',
  'steam-list-invalid': 'Steam\'s library list could not be read; only the main Steam folder was searched.'
});
export const PLUGIN_MANUAL_FOLDER_TEXT: Readonly<Record<PluginManualFolderState, string | null>> = Object.freeze({
  'none': null,
  'set': 'A chosen game folder is in use.',
  'invalid': 'The chosen game folder is no longer a separate, valid game folder; it is not changed.'
});
export const PLUGIN_STATE_TEXT: Readonly<Record<PluginTargetState, string>> = Object.freeze({
  'installed': 'Installed',
  'outdated': 'Older version installed',
  'missing': 'Not installed',
  'excluded': 'Not managed (game excluded)',
  'blocked': 'Blocked',
  'working': 'Setting up…'
});
export const PLUGIN_REASON_TEXT: Readonly<Record<PluginBlockReason, string>> = Object.freeze({
  GAME_RUNNING: 'The game is running; the plugin is changed after you close it.',
  CLIENT_RUNNING: 'TruckersMP is running; the plugin is changed after you close it.',
  TARGET_LOCKED: 'Another program is using the plugin file; it is tried again later.',
  PERMISSION_DENIED: 'Windows denied access to the game\'s plugins folder.',
  READ_ONLY_FILE: 'The plugin file is read-only; it is left as it is.',
  UNRECOGNIZED_FILE: 'A file with the plugin\'s name that this application did not install is in the way; it is left as it is. Move it away, then press Retry.',
  LINKED_FOLDER: 'The game\'s folders are linked elsewhere; they are not changed.',
  DISK_FULL: 'The disk is full.',
  IO_ERROR: 'The game folder could not be read or written.',
  VERIFY_FAILED: 'The copied plugin did not match the bundled one; nothing was kept.',
  RUNNING_CHECK_FAILED: 'Running games could not be checked; it is tried again shortly.',
  REGISTRY_UNAVAILABLE: 'The plugin setup record could not be saved or is from a newer version.',
  BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged; reinstall ETS2Telemetry.'
});
export const PLUGIN_FOLDER_REFUSAL_TEXT: Readonly<Record<PluginFolderRefusal, string>> = Object.freeze({
  FOLDER_UNSUPPORTED_PATH: 'This folder cannot be used: choose a local game folder outside the ETS2Telemetry folders.',
  FOLDER_NOT_GAME: 'This folder is not a game folder of this game.',
  FOLDER_WRONG_GAME: 'This folder holds the other game.',
  FOLDER_LINKED: 'The game\'s folders in this folder are linked elsewhere; it cannot be used.',
  FOLDER_DUPLICATE: 'This game folder is already found through Steam.',
  SETUP_DISABLED: 'Plugin setup is off in this launch.',
  REGISTRY_UNAVAILABLE: 'The plugin setup record could not be saved.',
  BUSY: 'A folder dialog is already open.'
});
/** The Game plugin card's connection diagnosis (ET-017 P17), one fixed text per code. */
export const CONNECTION_DIAGNOSIS_TEXT: Readonly<Record<ConnectionDiagnosisCode, string>> = Object.freeze({
  SERVICE_UNAVAILABLE: 'The telemetry service is not running; see Application status.',
  CONNECTED: 'Receiving telemetry from the selected source.',
  NO_GAME_SELECTED: 'No game is selected as the source. Choose Euro Truck Simulator 2 or American Truck Simulator above.',
  SETUP_DISABLED: 'Not checked: plugin setup is off in this launch.',
  GAME_NOT_FOUND: 'The selected game was not found. Choose its game folder below.',
  PLUGIN_BLOCKED_PERMISSION: 'Windows did not allow the plugin file in a game folder to be read or changed. See the folder line below for what to do.',
  PLUGIN_UNRECOGNIZED: 'A file that this application did not install is in place of the plugin. Move it away, then press Retry.',
  PLUGIN_OUTDATED: 'An older plugin is installed. If its folder line below says it waits for the game, TruckersMP or another program, it is updated once that closes; otherwise resolve the problem shown there, then press Retry.',
  PLUGIN_PENDING_GAME_CLOSE: 'The plugin is changed automatically once the game, TruckersMP or the program using the file is closed. Then start the game again.',
  PLUGIN_BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged. Reinstall ETS2Telemetry.',
  PLUGIN_NOT_CHECKED: 'The plugin could not be checked in a game folder; see the folder line below.',
  PLUGIN_MISSING: 'The plugin is not installed in a game folder. Turn on "Manage the plugin for this game" or press Retry.',
  TRANSPORT_FAILED: 'The game\'s plugin could not be connected, or it is incompatible, and the connection is not tried again by itself. After the plugin is fixed, choose another source and then the game again above, or exit ETS2Telemetry from the tray and start it again.',
  NO_RUNNING_SOURCE: 'The plugin is in place. Start the game to connect.'
});
export const CONNECTION_DIAGNOSIS_NOTE_TEXT: Readonly<Record<ConnectionDiagnosisNote, string>> = Object.freeze({
  PLUGIN_OUTDATED_ON_DISK: 'A game folder still holds an older plugin. If its folder line says it waits for the game, TruckersMP or another program, it is updated once that closes; otherwise resolve the problem shown there, then press Retry.',
  OTHER_FOLDER_BLOCKED_PERMISSION: 'Another folder of this game could not be changed because Windows denied access; see its line below.',
  OTHER_FOLDER_UNRECOGNIZED: 'Another folder of this game holds a file that this application did not install; see its line below.',
  OTHER_FOLDER_PENDING_GAME_CLOSE: 'Another folder of this game is changed once the game, TruckersMP or the program using the file is closed.',
  OTHER_FOLDER_BUNDLE_UNAVAILABLE: 'The bundled plugin is missing or damaged, so another folder of this game was not set up. Reinstall ETS2Telemetry.',
  OTHER_FOLDER_NOT_CHECKED: 'The plugin could not be checked in another folder of this game; see its line below.',
  OTHER_FOLDER_MISSING: 'Another folder of this game does not hold the plugin; see its line below.'
});
/** "Export diagnostics…" (ET-017 P17): the button, the note beside it and each answer as fixed text, never a path. */
export const DIAGNOSTICS_EXPORT_STRINGS = Object.freeze({
  button: 'Export diagnostics…',
  note: 'Saves one JSON file with versions, states and recent log codes, without paths or user and computer names. Nothing is uploaded.',
  saved: 'Diagnostics saved.',
  cancelled: 'Export cancelled. Nothing was written.',
  failed: 'The diagnostics export request failed.'
});
export const DIAGNOSTICS_EXPORT_ERROR_TEXT: Readonly<Record<DiagnosticsExportRefusal | DiagnosticsExportFailure, string>> = Object.freeze({
  EXPORT_IN_PROGRESS: 'Another diagnostics export is still running.',
  EXPORT_INTERRUPTED: 'The export stopped because ETS2Telemetry is exiting. Nothing was written.',
  EXPORT_TARGET_REFUSED: 'That location cannot be used. Choose a folder outside the ETS2Telemetry data folder.',
  BUNDLE_FAILED: 'The diagnostics could not be collected. Nothing was written.',
  DIALOG_FAILED: 'The Save dialog could not be opened. Nothing was written.',
  EXPORT_WRITE_FAILED: 'The file could not be written. A file that already had this name is unchanged.'
});
/**
 * The in-app uninstall (ET-018 PR-4, plan U8 and U9). The warning states what the owner's uninstall rule of October 16,
 * 2026 removes, what stays and when the game plugin goes. No text names a path; the data folder is described by its
 * location only. uninstall-text.ts builds every message from these.
 */
export const UNINSTALL_STRINGS = Object.freeze({
  title: 'Uninstall ETS2Telemetry',
  warningTitle: 'Uninstalling deletes your local data',
  warning: [
    'Your local trip history, which is not synchronized anywhere, is deleted for good, with its backups.',
    'Your settings, logs, captures and synthetic recordings are deleted as well.',
    'Trip exports you saved elsewhere stay where they are.',
    'The ETS2Telemetry game plugin is removed from your game folders while the games are closed.'
  ] as readonly string[],
  button: 'Uninstall ETS2Telemetry…',
  pending: 'Checking your game folders…',
  notInstalled: 'Uninstalling is available only in an installed copy of ETS2Telemetry. This copy is portable or a development build; delete its folder to remove it.',
  cancelled: 'Uninstall cancelled. Nothing was changed.',
  started: 'Removing ETS2Telemetry. The application closes now and Windows finishes the uninstall.',
  blocked: 'ETS2Telemetry was not uninstalled, and nothing was changed: {reason}',
  interrupted: 'ETS2Telemetry was not uninstalled: {reason} Before it stopped, it had removed its game plugin from some game folders (plugin files removed: {count}). Your data was kept. ETS2Telemetry puts the plugin back automatically in every game folder it manages while that game is closed.',
  blockedFolder: '{target}: {reason}',
  failed: 'ETS2Telemetry was not uninstalled: {reason}',
  requestFailed: 'The uninstall request was refused.',
  confirmTitle: 'Uninstall ETS2Telemetry',
  confirmMessage: 'Uninstall ETS2Telemetry and delete its local data?',
  confirmCancel: 'Cancel',
  confirmUninstall: 'Uninstall',
  finishedTitle: 'ETS2Telemetry was uninstalled',
  finishedMessage: 'ETS2Telemetry removed its game plugin and its local data. Windows now removes the program files.',
  finishedPartial: 'ETS2Telemetry removed its game plugin, but some local data could not be deleted. Windows now removes the program files.',
  finishedRemoved: 'Plugin files removed: {count}.',
  finishedUnrecognized: 'Files with the plugin\'s name that ETS2Telemetry did not install were left as they are: {count}.',
  finishedKept: 'Files and folders in the data folder that ETS2Telemetry does not know were kept: {count}. Delete %LOCALAPPDATA%\\ETS2Telemetry by hand if you do not need them.',
  finishedFailed: 'Could not be deleted: {entries}. Delete %LOCALAPPDATA%\\ETS2Telemetry by hand.',
  /** The wipe ran out of time (BUDGET_EXPIRED): the intent stays, and the uninstall hook of the handover finishes it. */
  finishedPending: 'ETS2Telemetry removed its game plugin. The Windows uninstall that starts now finishes removing its local data and removes the program files.',
  finishedExpired: 'Not deleted yet, because this step ran out of time: {entries}. The Windows uninstall that starts now finishes removing them.',
  spawnFailedTitle: 'Windows uninstall could not start',
  spawnFailed: 'ETS2Telemetry removed its plugin and data, but the Windows uninstall could not be started. Uninstall ETS2Telemetry from Windows Settings, Apps.',
  /** The handover failed after a wipe that did not finish: the intent stays, and the Windows-initiated hook reads it. */
  spawnFailedPartial: 'ETS2Telemetry removed its plugin, but some of its local data remains, and the Windows uninstall could not be started. Uninstall ETS2Telemetry from Windows Settings, Apps: that removes the program files and finishes removing the remaining data where it can.'
});
export const UNINSTALL_TARGET_TEXT = Object.freeze({
  steam: '{game} (Steam folder {number})',
  manual: '{game} (chosen folder)',
  other: '{game} (a folder that is no longer listed)'
});
/** Why the in-app uninstall stopped at a game folder or the install registry; every code has a fixed text. */
export const UNINSTALL_REASON_TEXT: Readonly<Record<UninstallBlockCode, string>> = Object.freeze({
  GAME_RUNNING: 'the game is running. Close it, then try again.',
  CLIENT_RUNNING: 'TruckersMP is running. Close it, then try again.',
  TARGET_LOCKED: 'another program is using the plugin file. Close it, then try again.',
  PERMISSION_DENIED: 'Windows denied access to the game\'s plugins folder.',
  READ_ONLY_FILE: 'the plugin file is read-only. Clear its read-only attribute, then try again.',
  UNRECOGNIZED_FILE: 'the game folder holds unexpected entries, so it is not changed.',
  LINKED_FOLDER: 'the game\'s folders are linked elsewhere, so they are not changed.',
  DISK_FULL: 'the disk is full.',
  IO_ERROR: 'the game folder could not be read or written.',
  VERIFY_FAILED: 'the plugin file could not be checked.',
  RUNNING_CHECK_FAILED: 'running games could not be checked. Try again in a moment.',
  REGISTRY_UNAVAILABLE: 'the plugin setup record could not be used.',
  BUNDLE_UNAVAILABLE: 'the bundled plugin is missing or damaged.',
  FOLDER_UNAVAILABLE: 'the game folder is not available right now (for example a disconnected drive). Connect it, then try again.',
  BUDGET_EXPIRED: 'checking the game folders took too long. Try again.',
  REGISTRY_INVALID: 'the plugin setup record is damaged, so the game folders are not known.',
  REGISTRY_NEWER: 'the plugin setup record was written by a newer version of ETS2Telemetry.',
  REGISTRY_UNREADABLE: 'the plugin setup record could not be read. Try again.'
});
/** Why the in-app uninstall failed before it changed anything. */
export const UNINSTALL_FAILURE_TEXT: Readonly<Record<UninstallFailureCode, string>> = Object.freeze({
  ROOT_MISMATCH: 'the install folder does not match this Windows user\'s local application data folder.',
  LAYOUT_INVALID: 'the install folder is not laid out as expected.',
  DATA_ROOT_LINKED: 'the data folder is a link to another location, so it is not deleted. Remove it by hand.',
  TEST_ROOT_INVALID: 'this test installation is not marked correctly.',
  BUSY: 'an uninstall is already in progress.',
  DIALOG_FAILED: 'the confirmation could not be shown.',
  INTENT_FAILED: 'the uninstall record could not be written to the data folder.',
  ENGINE_FAILED: 'an unexpected error stopped it. Nothing more was removed; run the uninstall again.'
});
/** How a game folder that is no longer a game folder was handled (the engine's notes); shown in the result. */
export const UNINSTALL_NOTE_TEXT: Readonly<Record<FolderNote, string>> = Object.freeze({
  GAME_FOLDER_GONE: '{game}: the game folder no longer exists; nothing was left there.',
  GAME_EXECUTABLE_MISSING: '{game}: the game is no longer installed in a recorded folder; the plugin was removed from it by its checksum.',
  LAYOUT_NOT_PLAIN: '{game}: a recorded folder is no longer a plain game folder, so it was not checked. Look in its bin\\win_x64\\plugins folder for ets2telemetry-plugin.dll.',
  PLUGINS_FOLDER_ABSENT: '{game}: a recorded folder has no plugins folder; nothing was left there.'
});
/** A data entry that could not be deleted, by its allowlisted name. */
export const UNINSTALL_DATA_ENTRY_TEXT: Readonly<Record<DataEntry, string>> = Object.freeze({
  data: 'trip history', backups: 'history backups', settings: 'settings', logs: 'logs', synthetic: 'synthetic recordings', plugins: 'plugin setup record',
  captures: 'captures', transport: 'connection settings', uninstall: 'uninstall record'
});
