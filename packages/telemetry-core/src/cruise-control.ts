// The cruise control set speed (ET-071): the SDK's `truck.cruise_control` in m/s, as protocol v1 minor 3 carries it.
// Pure display rules. The SDK reports zero while cruise control is off, so zero is a value with its own text, never an
// unavailable reading; the wire and the normalized reading keep the raw m/s value.
import {formatSpeed} from './format';
import type {SpeedUnit} from './units';

/** The formatted text of a zero reading: cruise control is off. The application localizes it. */
export const CRUISE_CONTROL_OFF = 'off';

/** Whether cruise control holds a set speed: any positive m/s value. Zero (and anything below) means off. */
export function cruiseControlActive(metersPerSecond: number): boolean {
  return metersPerSecond > 0;
}
/** `off` when cruise control is off, otherwise the set speed in the profile's speed unit, rounded as speed is. */
export function formatCruiseControl(metersPerSecond: number, unit: SpeedUnit): string {
  return cruiseControlActive(metersPerSecond) ? formatSpeed(metersPerSecond, unit) : CRUISE_CONTROL_OFF;
}
