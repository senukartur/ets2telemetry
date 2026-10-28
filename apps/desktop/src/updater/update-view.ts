import type {ApplicationInfo, UpdateFailure, UpdateLastCheck, UpdateRefusal, UpdateState, UpdateView} from '../../../../packages/contracts/src/app-state';

// The update view and the application info that cross into the dashboard (ET-055 UP9; docs/app-lifecycle.md, "In-app
// updates"). Main validates what it sends with these parsers and the dashboard preload validates it again. This module is
// pure, with no Node.js or Electron import, so the sandboxed preload may bundle it.

/** The two argument-free, trusted-dashboard-only IPC channels (UP9). */
export const UPDATE_CHANNELS = Object.freeze({apply: 'update:apply', check: 'update:check'} as const);

export const UPDATE_STATES: readonly UpdateState[] = Object.freeze(['unsupported', 'idle', 'checking', 'available', 'downloading', 'installing', 'restarting', 'ready', 'refused', 'failed']);
export const UPDATE_REFUSALS: readonly UpdateRefusal[] = Object.freeze(['GAME_RUNNING', 'GAME_CHECK_FAILED', 'BUSY', 'EXITING']);
export const UPDATE_FAILURES: readonly UpdateFailure[] = Object.freeze(['OFFLINE', 'MANIFEST_INVALID', 'SIGNATURE_INVALID', 'DOWNLOAD_FAILED', 'HASH_MISMATCH', 'DISK_FULL', 'APPLY_FAILED', 'APPLY_TIMEOUT']);

/** An application version as builds carry it: `x.y.z` with an optional prerelease (the staging `-stg.<6 digits>`). */
export const APP_VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;
export const isAppVersion = (value: unknown): value is string => typeof value === 'string' && APP_VERSION_PATTERN.test(value);

/** The view of a launch that never checks; also what main reports before the update context is known. */
export const UNSUPPORTED_UPDATE: UpdateView = Object.freeze({state: 'unsupported', available: null, progress: null, refusal: null, failure: null, lastCheck: null});

/** States that carry the offered version. */
const OFFERING: ReadonlySet<UpdateState> = new Set(['available', 'downloading', 'installing', 'restarting', 'ready', 'refused', 'failed']);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) => {
  const own = Object.keys(record);
  return own.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key));
};
const member = <T extends string>(set: readonly T[], value: unknown): value is T => typeof value === 'string' && (set as readonly string[]).includes(value);

function parseLastCheck(value: unknown): UpdateLastCheck | null | undefined {
  if (value === null) return null;
  if (!plainObject(value) || !exactKeys(value, ['outcome', 'failure', 'atUtcMs'])) return undefined;
  const {outcome, failure, atUtcMs} = value;
  if (outcome !== 'up-to-date' && outcome !== 'available' && outcome !== 'failed') return undefined;
  if (outcome === 'failed' ? !member(UPDATE_FAILURES, failure) : failure !== null) return undefined;
  if (typeof atUtcMs !== 'number' || !Number.isSafeInteger(atUtcMs) || atUtcMs < 0) return undefined;
  return {outcome, failure: failure as UpdateFailure | null, atUtcMs};
}

/**
 * A fresh copy of a valid update view, or undefined. Exactly the six keys; the offered version from `available` on and
 * only there; an integer progress 0–100 exactly while downloading; a refusal in `refused` (required) and `ready`
 * (optional) only; a failure exactly in `failed`; no last check while unsupported.
 */
export function parseUpdateView(value: unknown): UpdateView | undefined {
  if (!plainObject(value) || !exactKeys(value, ['state', 'available', 'progress', 'refusal', 'failure', 'lastCheck'])) return undefined;
  const {state, available, progress, refusal, failure} = value;
  if (!member(UPDATE_STATES, state)) return undefined;
  if (OFFERING.has(state) ? !isAppVersion(available) : available !== null) return undefined;
  if (state === 'downloading' ? !(typeof progress === 'number' && Number.isInteger(progress) && progress >= 0 && progress <= 100) : progress !== null) return undefined;
  if (state === 'refused' ? !member(UPDATE_REFUSALS, refusal) : state === 'ready' ? refusal !== null && !member(UPDATE_REFUSALS, refusal) : refusal !== null) return undefined;
  if (state === 'failed' ? !member(UPDATE_FAILURES, failure) : failure !== null) return undefined;
  const lastCheck = parseLastCheck(value.lastCheck);
  if (lastCheck === undefined || (state === 'unsupported' && lastCheck !== null)) return undefined;
  return {state, available: available as string | null, progress: progress as number | null, refusal: refusal as UpdateRefusal | null,
    failure: failure as UpdateFailure | null, lastCheck};
}

/** A fresh copy of valid application info, or undefined: exactly a build version, a channel and the packaged flag. */
export function parseApplicationInfo(value: unknown): ApplicationInfo | undefined {
  if (!plainObject(value) || !exactKeys(value, ['version', 'channel', 'packaged'])) return undefined;
  const {version, channel, packaged} = value;
  if (!isAppVersion(version) || (channel !== 'production' && channel !== 'staging') || typeof packaged !== 'boolean') return undefined;
  return {version, channel, packaged};
}
