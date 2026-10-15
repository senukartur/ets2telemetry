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
/** Main-owned application state pushed to the dashboard. ET-011b adds persisted settings. */
export interface AppState {
  health: AppHealth;
}
