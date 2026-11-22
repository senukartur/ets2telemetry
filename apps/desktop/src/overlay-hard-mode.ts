import type {HardModeStatus, OverlayHardMode} from '../../../packages/contracts/src';
import {HARD_MODE_RULE_IDS} from '../../../packages/contracts/src/hard-mode';

// The overlay's fixed Hard Mode indicator (ET-070, owner decisions D1-D4). Main, the overlay preload and the overlay
// renderer share one definition. Main maps the status it already
// holds to an enum and a pass count; the preload and the view model validate that again, and nothing but positive
// evidence becomes `active` (D4).

/** A count is below the total because a full pass is represented by the active state. */
export const OVERLAY_HARD_MODE_RULES = HARD_MODE_RULE_IDS.length;
const INACTIVE: OverlayHardMode = Object.freeze({state: 'inactive'});

/**
 * The indicator for main's current status: `lost` only when a legacy v1 trip has a first loss, whatever the assessment;
 * otherwise `active` only for a passing assessment; otherwise `inactive` with the number of rules in `pass`, but only
 * when at least one rule is not `unknown`. An expired lease, a service that is not ready and an observation without
 * evidence all yield unknown rules, so they show no count. V2 trip ratios and
 * retained diagnostics never override the current settings.
 */
export function overlayHardMode(status: Pick<HardModeStatus, 'assessment' | 'trip'>): OverlayHardMode {
  if (status.trip?.version === 1 && status.trip.firstLoss) return {state: 'lost'};
  if (status.assessment.state === 'pass') return {state: 'active'};
  const rules = status.assessment.rules;
  if (!rules.some(rule => rule.state !== 'unknown')) return {state: 'inactive'};
  return {state: 'inactive', passed: Math.min(OVERLAY_HARD_MODE_RULES - 1, rules.filter(rule => rule.state === 'pass').length)};
}

const isPassCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < OVERLAY_HARD_MODE_RULES;

/**
 * Strictly validates an untrusted indicator: a plain object whose own data properties are `state` and, on `inactive`
 * only, `passed`, a nonnegative integer below the rule count. Getters are never run. `active` and `lost` pass only exactly; everything
 * else, a malformed count included, becomes `{state: 'inactive'}`, so a malformed value never shows Hard Mode as active.
 */
export function sanitizeOverlayHardMode(value: unknown): OverlayHardMode {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return INACTIVE;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return INACTIVE;
  const keys = Reflect.ownKeys(value);
  const data = (key: string) => {const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor && 'value' in descriptor ? {value: descriptor.value as unknown} : undefined;};
  const state = data('state')?.value;
  if (state === 'active' || state === 'lost') return keys.length === 1 ? {state} : INACTIVE;
  if (state !== 'inactive') return INACTIVE;
  const passed = data('passed');
  if (keys.length === 1) return INACTIVE;
  return keys.length === 2 && passed && isPassCount(passed.value) ? {state: 'inactive', passed: passed.value} : INACTIVE;
}

/** True when both indicators show the same thing; two missing values are the same. */
export function sameOverlayHardMode(left?: OverlayHardMode, right?: OverlayHardMode): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.state === right.state && left.passed === right.passed;
}

/**
 * The indicator after the overlay preload's quiet deadline: a loss stays a loss, anything else becomes not active
 * without a count, and a missing value stays missing (it already renders as not active).
 */
export function staleOverlayHardMode(value?: OverlayHardMode): OverlayHardMode | undefined {
  if (value === undefined) return undefined;
  return sanitizeOverlayHardMode(value).state === 'lost' ? {state: 'lost'} : INACTIVE;
}
