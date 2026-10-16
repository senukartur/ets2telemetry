import type {AppErrorCode, AppHealth, RecordingHealth} from '../../../packages/contracts/src';
import {sameRecording} from './recording-status';

export type HealthEvent =
  | {type: 'service-ready'}
  /** A post-readiness failure report or start timeout; the service is being terminated and restarted. */
  | {type: 'service-failure'; code: AppErrorCode}
  /** `afterFailure`: the exit follows a reported failure whose code stays the last error. */
  | {type: 'service-exited'; afterFailure: boolean}
  | {type: 'service-restarting'}
  | {type: 'service-restart-exhausted'}
  | {type: 'exit-requested'}
  /** ET-015c (G4): a validated recording status of the current service, or `unknown` for a rejected one. */
  | {type: 'recording'; status: RecordingHealth};

const UNKNOWN: RecordingHealth = {state: 'unknown'};

export function initialHealth(): AppHealth {
  return {service: 'starting', storage: 'pending', recording: {...UNKNOWN}, lastError: null};
}

/** Maps a supervisor failure and the service's own report code to a fixed application error code. */
export function failureCode(supervisorCode: string, reportedCode?: unknown): AppErrorCode {
  if (supervisorCode === 'SERVICE_START_TIMEOUT') return 'SERVICE_START_TIMEOUT';
  if (typeof reportedCode === 'string' && reportedCode.startsWith('STORAGE_')) return 'STORAGE_FAILED';
  return 'SERVICE_EXITED';
}

/**
 * Pure health reducer. Only a new readiness reports `ready`; an orderly exit is final, and an exhausted
 * restart budget stays failed. ET-015c (G5, G12): the recording status is `unknown` until a service reports one, and
 * again whenever the service fails, exits, restarts or exhausts its restarts; readiness never changes it, so a status
 * the new service reported before its readiness stays.
 */
export function reduceHealth(health: AppHealth, event: HealthEvent): AppHealth {
  if (health.service === 'stopping') return health;
  switch (event.type) {
    case 'service-ready': return {...health, service: 'ready', storage: 'verified'};
    case 'service-failure': return {...health, service: 'restarting', storage: event.code === 'STORAGE_FAILED' ? 'failed' : health.storage, recording: {...UNKNOWN}, lastError: event.code};
    // An exit after a reported failure keeps that more specific cause. The exited service's self-test no
    // longer describes any running service.
    case 'service-exited': return {...health, service: 'failed', storage: health.storage === 'failed' ? 'failed' : 'pending', recording: {...UNKNOWN},
      lastError: event.afterFailure && health.lastError ? health.lastError : 'SERVICE_EXITED'};
    case 'service-restarting': return {...health, service: 'restarting', storage: health.storage === 'failed' ? 'failed' : 'pending', recording: {...UNKNOWN}};
    case 'service-restart-exhausted': return {...health, service: 'failed', recording: {...UNKNOWN}, lastError: 'SERVICE_RESTART_EXHAUSTED'};
    case 'exit-requested': return {...health, service: 'stopping'};
    case 'recording': return {...health, recording: event.status};
  }
}

export function sameHealth(left: AppHealth, right: AppHealth): boolean {
  return left.service === right.service && left.storage === right.storage && sameRecording(left.recording, right.recording) && left.lastError === right.lastError;
}
