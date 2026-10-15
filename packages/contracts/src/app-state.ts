/** Fixed application error codes. They never carry paths, error text or other runtime details. */
export type AppErrorCode = 'SERVICE_EXITED' | 'SERVICE_RESTART_EXHAUSTED' | 'STORAGE_FAILED' | 'SERVICE_START_TIMEOUT'
  | 'SETTINGS_WRITE_FAILED' | 'SETTINGS_READ_ONLY';
export type ServiceHealth = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping';
export type StorageHealth = 'pending' | 'verified' | 'failed';
export interface AppHealth {
  service: ServiceHealth;
  /** The isolated storage self-test of the current service; not production history. */
  storage: StorageHealth;
  /** This version records no history, so recording is always unavailable. */
  recording: 'unavailable';
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
 * directory could not be read safely; `unavailable`: no valid settings location. Both of the last two are read-only.
 */
export type SettingsState = 'defaults' | 'loaded' | 'loaded-with-fallbacks' | 'invalid-file' | 'unsupported-older'
  | 'newer-version' | 'unreadable' | 'unavailable';
/** The settings that apply now. Never carries paths, file content or error text. */
export interface SettingsView {
  units: UnitProfiles;
  state: SettingsState;
  /** False when a change cannot be saved: a newer-version, unreadable or unavailable settings file. */
  writable: boolean;
}
/** Main-owned application state pushed to the dashboard. */
export interface AppState {
  health: AppHealth;
  settings: SettingsView;
}
