// Display formatting of canonical values. Rounding uses Number.prototype.toFixed on the converted value; a rounded
// negative zero is shown as positive zero. Labels and reason texts belong to the application (apps/desktop/src/strings.ts).
import {bearingDegrees} from './derived';
import type {GearDisplayMode} from './display-profile';
import type {MoneyValue} from './readings';
import {
  convertConsumption, convertDistance, convertMass, convertSpeed, convertVolume, type ConsumptionUnit, type DistanceUnit, type MassUnit,
  type SpeedUnit, type VolumeUnit
} from './units';

const MINUTES_PER_DAY = 1440n;

/** Rounds to a fixed number of decimals and never returns a signed zero such as "-0.0". */
export function fixed(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}
/** Speed with one decimal; a negative value means reverse. */
export function formatSpeed(metersPerSecond: number, unit: SpeedUnit): string {
  return `${fixed(convertSpeed(metersPerSecond, unit), 1)} ${unit}`;
}
export function formatDistance(meters: number, unit: DistanceUnit, decimals: 0 | 1): string {
  return `${fixed(convertDistance(meters, unit), decimals)} ${unit}`;
}
export function formatVolume(liters: number, unit: VolumeUnit, decimals: 0 | 1): string {
  return `${fixed(convertVolume(liters, unit), decimals)} ${unit}`;
}
/** Tonnes with one decimal, pounds as an integer. */
export function formatMass(kilograms: number, unit: MassUnit): string {
  return `${fixed(convertMass(kilograms, unit), unit === 't' ? 1 : 0)} ${unit}`;
}
/**
 * The SDK mean consumption with one decimal. Zero L/100 km has no US mpg value: the result is the reason
 * `zero-consumption`, never "Infinity" or "0.0 US mpg". A negative or non-finite input is `invalid`.
 */
export function formatConsumption(litersPer100Km: number, unit: ConsumptionUnit): {text: string} | {reason: 'zero-consumption' | 'invalid'} {
  const converted = convertConsumption(litersPer100Km, unit);
  if (converted !== undefined) return {text: `${fixed(converted, 1)} ${unit}`};
  return litersPer100Km === 0 ? {reason: 'zero-consumption'} : {reason: 'invalid'};
}
export function formatRpm(rpm: number): string {
  return `${fixed(rpm, 0)} rpm`;
}
/**
 * Displayed gear: N for neutral and R1..Rn reverse in both modes. Forward gears are 1..n in `automatic` mode and
 * range-splitter pairs in `manual` mode: gear g is `ceil(g / 2)` followed by L for odd g and H for even g, so 1 is 1L,
 * 2 is 1H and 16 is 8H. This is a uniform simplification; it does not know the actual gearbox layout. A forward
 * value that is not a safe integer is shown as its plain number.
 */
export function formatGear(index: number, mode: GearDisplayMode = 'automatic'): string {
  if (index === 0) return 'N';
  if (index < 0) return `R${-index}`;
  if (mode === 'manual' && Number.isSafeInteger(index)) return `${Math.ceil(index / 2)}${index % 2 === 1 ? 'L' : 'H'}`;
  return String(index);
}
/** An integer percentage of a fraction. */
export function formatPercent(fraction: number): string {
  return `${fixed(fraction * 100, 0)}%`;
}
const pad2 = (value: bigint) => value.toString().padStart(2, '0');
/** Absolute game minutes since the first game day as "Day N, HH:MM", where day 1 starts at minute 0. */
export function formatGameTime(minutes: bigint, labels: {day?: string} = {}): string {
  if (minutes < 0n) throw new RangeError('Game time cannot be negative');
  const minuteOfDay = minutes % MINUTES_PER_DAY;
  const dayPrefix = labels.day ?? 'Day';
  return `${dayPrefix} ${(minutes / MINUTES_PER_DAY + 1n).toString()}, ${pad2(minuteOfDay / 60n)}:${pad2(minuteOfDay % 60n)}`;
}
/** A non-negative game-time span as "H h M min" or "M min". */
export function formatGameDuration(minutes: bigint, labels: {h?: string; min?: string} = {}): string {
  const span = minutes < 0n ? -minutes : minutes;
  const hours = span / 60n, rest = span % 60n;
  const hLabel = labels.h ?? 'h';
  const minLabel = labels.min ?? 'min';
  return hours > 0n ? `${hours.toString()} ${hLabel} ${rest.toString()} ${minLabel}` : `${rest.toString()} ${minLabel}`;
}
/** Signed game minutes until the delivery deadline: "in …" before it and at it, "late by …" after it. */
export function formatDeadline(remainingMinutes: bigint, labels: {in?: string; lateBy?: string; h?: string; min?: string} = {}): string {
  const inPrefix = labels.in ?? 'in';
  const lateByPrefix = labels.lateBy ?? 'late by';
  const duration = formatGameDuration(remainingMinutes, labels);
  return remainingMinutes < 0n ? `${lateByPrefix} ${duration}` : `${inPrefix} ${duration}`;
}
/** Compass bearing rounded to whole degrees; 359.5° and above wrap to 0°. */
export function formatBearing(heading: number): string {
  const text = fixed(bearingDegrees(heading), 0);
  return `${text === '360' ? '0' : text}°`;
}
/** Game-world coordinates with one decimal; never latitude/longitude. */
export function formatPosition(position: {x: number; y: number; z: number}): string {
  return `x ${fixed(position.x, 1)}, y ${fixed(position.y, 1)}, z ${fixed(position.z, 1)}`;
}
/**
 * Exact raw money digits without grouping, symbols or conversion. The currency code appears only when the pinned SDK
 * header documents it; otherwise the currency is stated as unknown.
 */
export function formatMoney(money: MoneyValue): string {
  return money.currency.basis === 'sdk-documented' ? `${money.raw} ${money.currency.code} (SDK-documented)` : `${money.raw} (currency unknown)`;
}
/**
 * The same exact raw digits and currency as formatMoney, without the "(SDK-documented)" provenance suffix, for compact
 * displays such as the overlay (ET-045a). An unknown currency is still stated as unknown.
 */
export function formatMoneyAmount(money: MoneyValue): string {
  return money.currency.basis === 'sdk-documented' ? `${money.raw} ${money.currency.code}` : `${money.raw} (currency unknown)`;
}
export function formatBoolean(value: boolean, labels: {yes?: string; no?: string} = {}): string {
  return value ? (labels.yes ?? 'yes') : (labels.no ?? 'no');
}
