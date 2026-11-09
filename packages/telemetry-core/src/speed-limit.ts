// The navigation speed limit (ET-084): the SDK's `truck.navigation.speed.limit` in m/s, as protocol v1 minor 4 carries it.
// Pure display rules. A zero or negative reading means there is no limit on this road, so it is a value with its own text,
// never an unavailable reading; the wire and the normalized reading keep the raw m/s value.
import {fixed} from './format';
import {convertSpeed, type SpeedUnit} from './units';

/** The formatted text of a zero or negative reading: no limit. The application localizes it. */
export const SPEED_LIMIT_NONE = 'none';

/** Whether a limit applies: any positive m/s value. Zero and anything below mean no limit. */
export function speedLimitActive(metersPerSecond: number): boolean {
  return metersPerSecond > 0;
}
/** `none` when no limit applies, otherwise the limit in whole units of the profile's speed unit, as road signs show. */
export function formatSpeedLimit(metersPerSecond: number, unit: SpeedUnit): string {
  return speedLimitActive(metersPerSecond) ? `${fixed(convertSpeed(metersPerSecond, unit), 0)} ${unit}` : SPEED_LIMIT_NONE;
}
