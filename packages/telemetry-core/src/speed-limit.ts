// The navigation speed limit (ET-084): the SDK's `truck.navigation.speed.limit` in m/s, as protocol v1 minor 4 carries it.
// Pure display rules. This contract treats a zero or negative reading as no limit on this road, so it is a value with its
// own text, never an unavailable reading. A positive reading that rounds to 0 whole units reads the same, so no sign shows
// a limit of 0; the wire and the normalized reading keep the raw m/s value.
import {fixed} from './format';
import {convertSpeed, type SpeedUnit} from './units';

/** The formatted text when no limit applies. The application localizes it. */
export const SPEED_LIMIT_NONE = 'none';

/** `none` at zero and below or when the whole-unit text is 0, otherwise the limit in whole units of the profile's speed unit, as road signs show. */
export function formatSpeedLimit(metersPerSecond: number, unit: SpeedUnit): string {
  const whole = fixed(convertSpeed(metersPerSecond, unit), 0);
  return metersPerSecond > 0 && whole !== '0' ? `${whole} ${unit}` : SPEED_LIMIT_NONE;
}
