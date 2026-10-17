/**
 * Fixed service and storage error codes. They never carry paths, error text or other runtime details. Settings save
 * errors are separate (`SettingsSaveError`), so they never replace a service problem.
 */
export type AppErrorCode = 'SERVICE_EXITED' | 'SERVICE_RESTART_EXHAUSTED' | 'STORAGE_FAILED' | 'SERVICE_START_TIMEOUT';
export type ServiceHealth = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping';
export type StorageHealth = 'pending' | 'verified' | 'failed';
/** The database a recording service writes (ET-015c, G2): game history, or a synthetic or replay test database. */
export type RecordingTarget = 'history' | 'synthetic' | 'replay';
/**
 * What the recording of the telemetry service is doing (ET-015c, G3): the database is opening; it waits for a recorded
 * source; it records; the game is paused; the connection was lost after recording; a retryable storage or backlog
 * failure is being retried; the selected source is not recorded; this plugin session continues live-only (the database
 * is behind the plugin); or recording stopped for the service lifetime.
 */
export type RecordingState = 'opening' | 'waiting' | 'recording' | 'paused' | 'interrupted' | 'retrying' | 'not-recorded-source' | 'live-only' | 'stopped';
/**
 * The closed set of recording codes: the storage error codes, the trip recorder's codes and the ACK pipeline's own
 * failure codes. apps/desktop/src/recording-status.ts asserts at compile time that it equals them.
 */
export type RecordingCode =
  | 'DATABASE_LOCKED' | 'PERMISSION_DENIED' | 'DISK_FULL' | 'IO_ERROR' | 'DATABASE_CORRUPT' | 'CONSTRAINT_VIOLATION' | 'INVALID_INPUT' | 'UNKNOWN_SESSION'
  | 'UNKNOWN_TRIP' | 'SESSION_CONFLICT' | 'VALUE_OUT_OF_RANGE' | 'STORAGE_CLOSED' | 'STORAGE_BUSY' | 'WORKER_FAILED' | 'TIMEOUT' | 'DATA_PATH_INVALID'
  | 'DATABASE_UNRECOGNIZED' | 'SCHEMA_NEWER' | 'PURPOSE_MISMATCH' | 'DURABILITY_UNVERIFIED' | 'BACKUP_FAILED' | 'MIGRATION_FAILED' | 'INTERNAL'
  | 'TRIP_ORDER_VIOLATION' | 'TRIP_COVERAGE_MISMATCH' | 'TRIP_UNKNOWN_SESSION'
  | 'BACKLOG_FULL' | 'COVERAGE_MISMATCH' | 'ACK_AHEAD_OF_STORAGE';
/**
 * Losses that storage committed (ET-015c, G6), as non-negative safe integers that saturate. `lostEvents`: events a
 * committed gap or a recorded restore loss newly covers. The interval counts are the completeness intervals of each
 * kind that were committed, and `droppedSamples` the one-second rows the pending bound dropped. Main adds the counts of
 * every service process since ETS2Telemetry started; the database stays authoritative.
 */
export interface RecordingLosses {
  lostEvents: number; eventLoss: number; notConnected: number; sampleLoss: number; restoreLoss: number; droppedSamples: number;
}
/** The current trip of the recorded game: its phase, the open trip's completeness (null when idle) and an untracked job. */
export interface RecordingTrip {
  phase: 'idle' | 'active' | 'awaiting-outcome' | 'reload-check';
  completeness: 'unknown' | 'partial' | 'complete' | null;
  untrackedJob: boolean;
}
/**
 * The recording status in the application health (ET-015c, G2). `disabled`: this service records nothing (production
 * until the enablement PR). `unknown`: main has no current report, because the service is not running or sent an invalid
 * one. Otherwise the service's state with its target, a fixed code, its committed losses and the current trip. Fixed
 * enums and counts only: never text, paths or identifiers.
 */
export type RecordingHealth =
  | {state: 'disabled'}
  | {state: 'unknown'}
  | {state: RecordingState; target: RecordingTarget; code: RecordingCode | null; losses: RecordingLosses; trip: RecordingTrip | null};
export interface AppHealth {
  service: ServiceHealth;
  /** The isolated storage self-test of the current service; not production history. */
  storage: StorageHealth;
  /** ET-015c: the validated recording status the current service reports; `unknown` while there is none. */
  recording: RecordingHealth;
  lastError: AppErrorCode | null;
}
/** Games with their own display unit profile. */
export type UnitGame = 'ets2' | 'ats';
/**
 * Display unit profile ids. They must equal telemetry-core's `DisplayProfileId`; apps/desktop/src/unit-profiles.ts
 * asserts that at compile time.
 */
export type UnitProfile = 'metric' | 'us-customary';
export type UnitProfiles = Readonly<Record<UnitGame, UnitProfile>>;
/**
 * How the persisted settings were obtained at startup or by the last save. `defaults`: no file. `loaded-with-fallbacks`:
 * some fields were invalid and use defaults. `invalid-file`, `unsupported-older`: the file is kept unchanged until the
 * first save quarantines it. `newer-version`: written by a newer version; read-only. `unreadable`: the file or its
 * directory could not be read safely, or the read hung; `unavailable`: no valid settings location. Both are read-only.
 * `loading`: the startup read outlasted its 1000 ms budget and is still pending; defaults apply and saving is refused
 * until the read's own result replaces this state.
 */
export type SettingsState = 'loading' | 'defaults' | 'loaded' | 'loaded-with-fallbacks' | 'invalid-file' | 'unsupported-older'
  | 'newer-version' | 'unreadable' | 'unavailable';
/** Why the last settings save was refused: it could not be written, or the file is read-only (newer version). */
export type SettingsSaveError = 'SETTINGS_WRITE_FAILED' | 'SETTINGS_READ_ONLY';
/**
 * Overlay layouts (ET-012a): a strip of 36 px rows at the top centre, as many as its enabled sections need (ET-012c),
 * a card at the top right, a cluster with a round speed gauge at the bottom left, or a minimal text HUD at the top left
 * of the game's client area.
 */
export type OverlayLayout = 'strip' | 'card' | 'cluster' | 'hud';
/** The fourteen overlay sections in canonical order; apps/desktop/src/overlay-sections.ts groups them. */
export type OverlaySectionId = 'speed' | 'gear' | 'rpm' | 'fuel' | 'range' | 'sdk-consumption' | 'cargo' | 'origin' | 'destination'
  | 'distance-driven' | 'distance-remaining' | 'deadline' | 'expected-income' | 'game-time';
/** Which overlay sections are enabled: always all fourteen keys, at least one of them true. */
export type OverlaySections = Readonly<Record<OverlaySectionId, boolean>>;
/**
 * One layout's saved position and size (ET-012b). `x` and `y` are fractions in [0, 1] of the free space left inside the
 * game's client area once the margins and the scaled overlay are taken away: 0 is the left or top margin, 1 the right
 * or bottom one. `scale` multiplies the layout's size and content, in [0.5, 2]. Never pixels, so a placement stays
 * inside any client area it fits by construction.
 */
export interface OverlayPlacement {
  x: number;
  y: number;
  scale: number;
}
/** One placement per layout: always all four keys. */
export type OverlayPlacements = Readonly<Record<OverlayLayout, OverlayPlacement>>;
export interface OverlaySettings {
  layout: OverlayLayout;
  sections: OverlaySections;
  /** The saved position and scale of every layout (ET-012b). */
  placements: OverlayPlacements;
}
/**
 * Why the overlay is or is not shown while its position is edited (ET-012b). `visible`: shown over the game and
 * draggable. `waiting-for-game`: no usable game window (no game source, the game minimized, a stale window report or
 * an overlay that is not loaded). `too-large`: the layout at this scale does not fit the game's client area.
 * `not-foreground`: neither of this application's windows is focused, or the game itself is in front.
 */
export type OverlayEditPlacement = 'visible' | 'waiting-for-game' | 'too-large' | 'not-foreground';
/** Main-owned overlay edit mode. It lives in memory only: every start is in driving mode. */
export type OverlayEditState =
  | {active: false}
  | {active: true; layout: OverlayLayout; scale: number; placement: OverlayEditPlacement};
/** The settings that apply now. Never carries paths, file content or error text. */
export interface SettingsView {
  units: UnitProfiles;
  /** The saved overlay layout, sections and placements, or their defaults (strip, every section, the default anchors). */
  overlay: OverlaySettings;
  state: SettingsState;
  /** False when a change cannot be saved: a pending read, or a newer-version, unreadable or unavailable settings file. */
  writable: boolean;
  /** The last save's refusal, cleared by the next successful save. Independent of the service's `lastError`. */
  saveError: SettingsSaveError | null;
}
/**
 * Whether plugin setup runs (ET-017 P15). `active`: it manages the plugin in the real Steam and chosen game folders.
 * `test-root`: an isolated launch confined to a fake root. `disabled`: no discovery, no registry read and no write.
 */
export type PluginSetupMode = 'active' | 'test-root' | 'disabled';
/** Games whose plugin this application manages. */
export type PluginGame = 'ets2' | 'ats';
/**
 * Why a plugin change for one game folder did not happen or must wait (ET-017 P16). apps/desktop/src/plugin-setup/
 * plugin-setup.ts asserts at compile time that this equals the installer's codes.
 */
export type PluginBlockReason = 'GAME_RUNNING' | 'CLIENT_RUNNING' | 'TARGET_LOCKED' | 'PERMISSION_DENIED' | 'READ_ONLY_FILE' | 'UNRECOGNIZED_FILE'
  | 'LINKED_FOLDER' | 'DISK_FULL' | 'IO_ERROR' | 'VERIFY_FAILED' | 'RUNNING_CHECK_FAILED' | 'REGISTRY_UNAVAILABLE' | 'BUNDLE_UNAVAILABLE';
/** How the game was found through Steam; `pending` until the first discovery of this application run finished. */
export type PluginDiscoveryOutcome = 'pending' | 'found' | 'not-found' | 'steam-not-found' | 'steam-list-invalid';
/** The game folder the driver chose: none, a valid one, or one that is no longer a valid, separate game folder. */
export type PluginManualFolderState = 'none' | 'set' | 'invalid';
/**
 * One game folder's plugin. `installed`: the bundled plugin is in place. `outdated`: an older plugin of this application
 * is in place. `missing`: no plugin file. `excluded`: the game is excluded and the folder holds no plugin of this
 * application. `blocked`: the folder holds something this application cannot change now, or a removal waits. `working`:
 * a change is in progress. `reason` says why a change did not happen or waits.
 */
export type PluginTargetState = 'installed' | 'outdated' | 'missing' | 'excluded' | 'blocked' | 'working';
/** A plugin file this application recognizes: its version (null when unknown) and the first 12 hex digits of its SHA-256. */
export interface PluginFileView {version: string | null; sha256Prefix: string}
/**
 * One game folder, labelled by its source and ordinal only, never by a path. `id` is `<game>:<source>:<ordinal>` with an
 * ordinal from 0 to 3; `lastFailure` is the last failure recorded for this folder.
 */
export interface PluginTargetView {
  id: string;
  source: 'steam' | 'manual';
  ordinal: number;
  state: PluginTargetState;
  reason: PluginBlockReason | null;
  installed: PluginFileView | null;
  lastFailure: PluginBlockReason | null;
}
export interface PluginGameView {
  excluded: boolean;
  discovery: PluginDiscoveryOutcome;
  manualFolder: PluginManualFolderState;
  /** At most four game folders. */
  targets: readonly PluginTargetView[];
  /**
   * Steam folders of this game beyond the listed ones (with a chosen folder at most three Steam folders are listed). They
   * are never installed into; when the game is excluded, this application's plugin is still removed from them.
   */
  unlistedFolders: number;
}
/** Per-game plugin setup state (ET-017 P16). Fixed codes, versions and hash prefixes only: never a path. */
export interface PluginSetupView {
  mode: PluginSetupMode;
  /** The verified bundled plugin, or null before it was read or when it is unavailable. */
  bundled: PluginFileView | null;
  /** True while a setup run is in progress. */
  running: boolean;
  games: Readonly<Record<PluginGame, PluginGameView>>;
}
/** Why a chosen game folder was not stored. */
export type PluginFolderRefusal = 'FOLDER_UNSUPPORTED_PATH' | 'FOLDER_NOT_GAME' | 'FOLDER_WRONG_GAME' | 'FOLDER_LINKED' | 'FOLDER_DUPLICATE'
  | 'SETUP_DISABLED' | 'REGISTRY_UNAVAILABLE' | 'BUSY';
/** The result of the folder dialog: the folder was stored, the dialog was cancelled (nothing written), or it was refused. */
export type PluginFolderChoice = {outcome: 'chosen'} | {outcome: 'cancelled'} | {outcome: 'refused'; code: PluginFolderRefusal};
/** "Show plugin file": Explorer shows the verified bundled DLL, or nothing because it is not verified or no longer a plain file. */
export type PluginShowFileResult = {outcome: 'shown'} | {outcome: 'refused'; code: 'BUNDLE_UNAVAILABLE'};
/** Main-owned application state pushed to the dashboard. */
export interface AppState {
  health: AppHealth;
  settings: SettingsView;
  /** The overlay edit mode; pushed whenever it changes. */
  overlayEdit: OverlayEditState;
  /** ET-017: the per-game plugin setup state; pushed whenever it changes. */
  plugins: PluginSetupView;
}
