import type {AppErrorCode, AppHealth} from '../../../packages/contracts/src';

export type HealthEvent =
  | {type: 'service-ready'}
  /** A post-readiness failure report or start timeout; the service is being terminated and restarted. */
  | {type: 'service-failure'; code: AppErrorCode}
  /** `afterFailure`: the exit follows a reported failure whose code stays the last error. */
  | {type: 'service-exited'; afterFailure: boolean}
  | {type: 'service-restarting'}
  | {type: 'service-restart-exhausted'}
  | {type: 'exit-requested'};

export function initialHealth(): AppHealth {
  return {service: 'starting', storage: 'pending', recording: 'unavailable', lastError: null};
}

/** Maps a supervisor failure and the service's own report code to a fixed application error code. */
export function failureCode(supervisorCode: string, reportedCode?: unknown): AppErrorCode {
  if (supervisorCode === 'SERVICE_START_TIMEOUT') return 'SERVICE_START_TIMEOUT';
  if (typeof reportedCode === 'string' && reportedCode.startsWith('STORAGE_')) return 'STORAGE_FAILED';
  return 'SERVICE_EXITED';
}

/**
 * Pure health reducer. Only a new readiness reports `ready`; an orderly exit is final, and an exhausted
 * restart budget stays failed. Recording is always unavailable in this version.
 */
export function reduceHealth(health: AppHealth, event: HealthEvent): AppHealth {
  if (health.service === 'stopping') return health;
  switch (event.type) {
    case 'service-ready': return {...health, service: 'ready', storage: 'verified'};
    case 'service-failure': return {...health, service: 'restarting', storage: event.code === 'STORAGE_FAILED' ? 'failed' : health.storage, lastError: event.code};
    // An exit after a reported failure keeps that more specific cause. The exited service's self-test no
    // longer describes any running service.
    case 'service-exited': return {...health, service: 'failed', storage: health.storage === 'failed' ? 'failed' : 'pending',
      lastError: event.afterFailure && health.lastError ? health.lastError : 'SERVICE_EXITED'};
    case 'service-restarting': return {...health, service: 'restarting', storage: health.storage === 'failed' ? 'failed' : 'pending'};
    case 'service-restart-exhausted': return {...health, service: 'failed', lastError: 'SERVICE_RESTART_EXHAUSTED'};
    case 'exit-requested': return {...health, service: 'stopping'};
  }
}

export function sameHealth(left: AppHealth, right: AppHealth): boolean {
  return left.service === right.service && left.storage === right.storage && left.recording === right.recording && left.lastError === right.lastError;
}
