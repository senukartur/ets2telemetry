import type {AppErrorCode, OverlayEditPlacement, OverlayLayout, OverlaySectionId, RecordingCode, RecordingHealth, RecordingLosses, RecordingTarget, RecordingTrip, ServiceHealth,
  SettingsSaveError, SettingsState, StorageHealth, UnitGame, UnitProfile} from '../../../packages/contracts/src';
import type {FieldNote, LiveFieldId, LiveSectionId, ViewReason} from '../../../packages/telemetry-core/src/live-view';
import type {OverlayGroupId, OverlayPresetId, OverlayRequirement} from './overlay-sections';

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
/** The current trip; an idle trip without an untracked job shows nothing. */
export const RECORDING_TRIP_TEXT = Object.freeze({
  untrackedJob: 'The current job started before recording and is not tracked as a trip',
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
