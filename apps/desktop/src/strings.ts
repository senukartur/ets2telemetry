import type {AppErrorCode, ServiceHealth, SettingsSaveError, SettingsState, StorageHealth, UnitGame, UnitProfile} from '../../../packages/contracts/src';
import type {FieldNote, LiveFieldId, LiveSectionId, ViewReason} from '../../../packages/telemetry-core/src/live-view';

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
  prototypeNotice: 'Prototype live display. No trip recording or durable history.',
  healthTitle: 'Application status',
  serviceLabel: 'Telemetry service',
  storageLabel: 'Storage self-test',
  recordingLabel: 'Recording',
  recordingUnavailable: 'not available in this version',
  lastErrorLabel: 'Last problem',
  closeToTray: 'Closing this window keeps ETS2Telemetry running in the notification area. Open it again from the tray icon; use Exit to stop it.',
  exitAction: 'Exit ETS2Telemetry',
  exitPending: 'Exiting…',
  exitFailed: 'Exit request failed',
  trayOpen: 'Open ETS2Telemetry',
  trayExit: 'Exit ETS2Telemetry',
  trayRecording: 'Recording: not available in this version',
  trayStarting: 'Starting',
  trayExiting: 'Exiting',
  serviceFailedTitle: 'Telemetry service problem',
  unitsTitle: 'Display units',
  unitsSaveFailed: 'The unit change was not saved; the previous units stay in use.',
  liveTitle: 'Live telemetry',
  livePaused: 'Game paused',
  liveNoJob: 'No job reported',
  liveJobUnavailable: 'Job unavailable'
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
/** Shown in the units card for the last refused save; never part of the service's last problem. */
export const SETTINGS_SAVE_ERROR_TEXT: Readonly<Record<SettingsSaveError, string>> = Object.freeze({
  SETTINGS_WRITE_FAILED: 'The unit change could not be saved; the previous units stay in use.',
  SETTINGS_READ_ONLY: 'Settings were written by a newer version and are read-only; the unit change was not saved.'
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
  'defaults': 'Default units. A change is saved for later launches.',
  'loaded': 'Saved units loaded.',
  'loaded-with-fallbacks': 'Some saved units were invalid; their defaults are in use until the next change.',
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
