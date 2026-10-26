// The next mandatory break (ET-052): game minutes until the SDK's `mandatory.break`, as protocol v1 minor 2 carries it.
// Pure rules for its urgency and its text. The wire and the normalized reading keep the signed raw value; the clamp to
// zero exists only here, in the presentation, so a negative value, if the game reports one, stays visible to anything that
// reads the reading.
import {formatGameDuration} from './format';

/** Below this many game minutes (two hours) the break is "soon". Exactly this value is still normal (ET-052 D3, MB6). */
export const BREAK_SOON_MINUTES = 120;
/** `due`: zero or negative (due now, or overdue if the game reports that); `soon`: 1 to 119 minutes; `normal`: 120 minutes or more. */
export type BreakUrgency = 'normal' | 'soon' | 'due';
/** The urgencies a row or overlay section carries; `normal` is the absence of one. */
export type NotableBreakUrgency = Exclude<BreakUrgency, 'normal'>;

export function breakUrgency(minutes: number): BreakUrgency {
  return minutes <= 0 ? 'due' : minutes < BREAK_SOON_MINUTES ? 'soon' : 'normal';
}
/**
 * Game minutes as "H h M min" or "M min", clamped at zero: a negative value reads "0 min" (ET-052 D3). `minutes` must be
 * a whole number, as the wire guarantees; any other input (a fraction, NaN, an infinity) throws a RangeError instead of
 * being formatted. The live view checks `Number.isInteger` first and shows such a reading as `invalid`.
 */
export function formatMandatoryBreak(minutes: number, labels: {h?: string; min?: string} = {}): string {
  if (!Number.isInteger(minutes)) throw new RangeError('The mandatory break must be a whole number of minutes');
  return formatGameDuration(BigInt(Math.max(0, minutes)), labels);
}
