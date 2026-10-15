import type {AppErrorCode, ServiceHealth, StorageHealth} from '../../../packages/contracts/src';

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
  serviceFailedTitle: 'Telemetry service problem'
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
  SERVICE_START_TIMEOUT: 'The telemetry service did not start in time.',
  SETTINGS_WRITE_FAILED: 'Settings could not be saved.',
  SETTINGS_READ_ONLY: 'Settings were written by a newer version and are read-only.'
});
