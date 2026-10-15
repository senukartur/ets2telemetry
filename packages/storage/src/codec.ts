// Exact value encodings between protocol v1 values and SQLite columns. Node-safe: pure functions and column specs.
// Wire uint64 keys are stored as 20-digit zero-padded TEXT, which is exact and sorts numerically; money is raw decimal
// TEXT with its SDK type; availability is a value column plus a state column; JSON payloads are canonical.
import {isUint64} from '../../contracts/src/protocol-v0';
import type {Available, Money, UnavailableReason, Uint64} from '../../contracts/src/protocol-v1';
import type {SampleField} from './api';
import {fail} from './errors';

export const U64_KEY_WIDTH = 20;
export const U64_MAX = 18_446_744_073_709_551_615n;
export const I64_MAX = 9_223_372_036_854_775_807n;
const I64_MIN = -9_223_372_036_854_775_808n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** A canonical wire uint64 (or BigInt) as its 20-digit key. Non-canonical text is INVALID_INPUT, never coerced. */
export function u64Key(value: Uint64 | bigint): string {
  if (typeof value === 'bigint') { if (value < 0n || value > U64_MAX) fail('VALUE_OUT_OF_RANGE'); return value.toString().padStart(U64_KEY_WIDTH, '0'); }
  if (!isUint64(value)) fail('INVALID_INPUT');
  return value.padStart(U64_KEY_WIDTH, '0');
}
/** A stored key back to its canonical wire form. */
export function fromU64Key(key: unknown): Uint64 {
  if (typeof key !== 'string' || key.length !== U64_KEY_WIDTH || !/^[0-9]+$/.test(key) || key > U64_MAX.toString()) fail('DATABASE_CORRUPT');
  return key.replace(/^0+(?=.)/, '');
}

export type AvailabilityState = 'available' | UnavailableReason;
/** Splits an availability object into its value (NULL when unavailable) and state columns. */
export function availabilityColumns<T, C>(input: Available<T>, map: (value: T) => C): [C | null, AvailabilityState] {
  return input.available ? [map(input.value), 'available'] : [null, input.reason];
}
export function fromAvailability<T>(value: unknown, state: unknown, map: (value: unknown) => T): Available<T> {
  if (state === 'available') { if (value === null || value === undefined) fail('DATABASE_CORRUPT'); return {available: true, value: map(value)}; }
  if (state !== 'not-observed' && state !== 'not-supported' && state !== 'invalid') fail('DATABASE_CORRUPT');
  return {available: false, reason: state};
}

/** Integers are read as BigInt (safe integers) and become numbers only within the given bound. */
export function toSafeNumber(value: unknown, max = Number.MAX_SAFE_INTEGER, min = -Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'bigint' ? value : typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : undefined;
  if (n === undefined) fail('DATABASE_CORRUPT');
  if (n > BigInt(max) || n < BigInt(min)) fail('VALUE_OUT_OF_RANGE');
  return Number(n);
}
/** A real number column: float64 copies of SDK float32 values are exact, so no rounding happens either way. */
export function toReal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('DATABASE_CORRUPT');
  return value;
}
/** Sample monotonic nanoseconds are INTEGER columns: values above 2^63-1 are refused, never truncated. */
export function sampleMonotonicNs(value: Uint64): bigint {
  if (!isUint64(value)) fail('INVALID_INPUT');
  const n = BigInt(value); if (n > I64_MAX) fail('VALUE_OUT_OF_RANGE');
  return n;
}

export interface MoneyColumns {raw: string | null; sdkType: 's64' | 'u64' | null; currencyStatus: 'unknown' | 'sdk-documented' | null; currencyCode: string | null; currencySource: string | null; state: AvailabilityState}
/** Exact raw money in canonical decimal form, range-checked with BigInt; never converted to a float. */
export function checkMoneyRaw(raw: unknown, sdkType: 's64' | 'u64'): string {
  const shape = sdkType === 'u64' ? /^(0|[1-9][0-9]{0,19})$/ : /^(0|-?[1-9][0-9]{0,18})$/;
  if (typeof raw !== 'string' || !shape.test(raw)) fail('INVALID_INPUT');
  const n = BigInt(raw);
  if (sdkType === 'u64' ? n > U64_MAX : n < I64_MIN || n > I64_MAX) fail('VALUE_OUT_OF_RANGE');
  return raw;
}
export function moneyColumns(input: Available<Money>, sdkType: 's64' | 'u64'): MoneyColumns {
  if (!input.available) return {raw: null, sdkType: null, currencyStatus: null, currencyCode: null, currencySource: null, state: input.reason};
  const m = input.value; if (m.sdkType !== sdkType) fail('INVALID_INPUT');
  const documented = m.currency.status === 'sdk-documented' ? m.currency : undefined;
  return {raw: checkMoneyRaw(m.raw, sdkType), sdkType, currencyStatus: m.currency.status, currencyCode: documented?.code ?? null, currencySource: documented?.source ?? null, state: 'available'};
}
export function moneyFromColumns(c: MoneyColumns): Available<Money> {
  return fromAvailability(c.raw, c.state, raw => {
    if (c.sdkType !== 's64' && c.sdkType !== 'u64') fail('DATABASE_CORRUPT');
    const currency = c.currencyStatus === 'sdk-documented' ? {status: 'sdk-documented' as const, code: String(c.currencyCode), source: String(c.currencySource)} : {status: 'unknown' as const};
    return {raw: checkMoneyRaw(raw, c.sdkType), sdkType: c.sdkType, currency};
  });
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, numbers as JavaScript's shortest round-trip
 * form (exact for float64), negative zero kept. Equal values give identical text, so redeliveries compare by string.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('INVALID_INPUT'); return Object.is(value, -0) ? '-0' : JSON.stringify(value); }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(o[key])}`).join(',')}}`;
  }
  fail('INVALID_INPUT');
}

export type ColumnKind = 'text' | 'real' | 'integer' | 'boolean' | 'minutes' | 'money';
/** Maps a protocol record field to its normalized column. `money` expands to `<column>_raw`, `_sdk_type`, `_currency_*`. */
export interface FieldSpec {field: string; column: string; kind: ColumnKind; sdkType?: 's64' | 'u64'}
const spec = (field: string, column: string, kind: ColumnKind, sdkType?: 's64' | 'u64'): FieldSpec => ({field, column, kind, ...(sdkType ? {sdkType} : {})});
export const JOB_FIELDS: readonly FieldSpec[] = [
  spec('sourceCityId', 'source_city_id', 'text'), spec('sourceCity', 'source_city', 'text'),
  spec('sourceCompanyId', 'source_company_id', 'text'), spec('sourceCompany', 'source_company', 'text'),
  spec('destinationCityId', 'destination_city_id', 'text'), spec('destinationCity', 'destination_city', 'text'),
  spec('destinationCompanyId', 'destination_company_id', 'text'), spec('destinationCompany', 'destination_company', 'text'),
  spec('cargoId', 'cargo_id', 'text'), spec('cargo', 'cargo', 'text'), spec('cargoMass', 'cargo_mass_kg', 'real'), spec('cargoUnitMass', 'cargo_unit_mass_kg', 'real'),
  spec('cargoUnitCount', 'cargo_unit_count', 'integer'), spec('market', 'market', 'text'), spec('isSpecialJob', 'is_special_job', 'boolean'),
  spec('cargoLoaded', 'cargo_loaded', 'boolean'), spec('plannedDistance', 'planned_distance_m', 'integer'),
  spec('expectedIncome', 'expected_income', 'money', 'u64'), spec('deliveryDeadline', 'delivery_deadline_minutes', 'minutes')
];
export const TRUCK_FIELDS: readonly FieldSpec[] = [
  spec('brandId', 'brand_id', 'text'), spec('brand', 'brand', 'text'), spec('id', 'model_id', 'text'), spec('name', 'model_name', 'text'),
  spec('fuelCapacity', 'fuel_capacity_l', 'real'), spec('licensePlate', 'license_plate', 'text'),
  spec('plateCountryId', 'plate_country_id', 'text'), spec('plateCountry', 'plate_country', 'text')
];
export const TRAILER_FIELDS: readonly FieldSpec[] = [
  spec('id', 'trailer_id', 'text'), spec('bodyType', 'body_type', 'text'), spec('chainType', 'chain_type', 'text'),
  spec('cargoAccessoryId', 'cargo_accessory_id', 'text'), spec('brandId', 'brand_id', 'text'), spec('brand', 'brand', 'text'),
  spec('name', 'name', 'text'), spec('licensePlate', 'license_plate', 'text'), spec('plateCountryId', 'plate_country_id', 'text'),
  spec('plateCountry', 'plate_country', 'text')
];
export const DELIVERY_FIELDS: readonly FieldSpec[] = [
  spec('earnedXp', 'earned_xp', 'integer'), spec('cargoDamage', 'cargo_damage', 'real'), spec('distance', 'distance_m', 'real'),
  spec('deliveryDuration', 'delivery_duration_minutes', 'minutes'), spec('autoParkUsed', 'auto_park_used', 'boolean'), spec('autoLoadUsed', 'auto_load_used', 'boolean')
];
/** The money field of each event type that carries one; stored in `event_amounts`. */
export const AMOUNT_FIELD: Readonly<Record<string, string>> = {
  'job.delivered': 'revenue', 'job.cancelled': 'penalty', 'player.fined': 'amount', 'player.tollgate.paid': 'amount', 'player.use.ferry': 'amount', 'player.use.train': 'amount'
};
/** Columns of a field spec, in table order: every field has a value column and a state column. */
export function specColumns(fields: readonly FieldSpec[]): string[] {
  return fields.flatMap(f => f.kind === 'money'
    ? ['raw', 'sdk_type', 'currency_status', 'currency_code', 'currency_source', 'state'].map(suffix => `${f.column}_${suffix}`)
    : [f.column, `${f.column}_state`]);
}
/** Column values for one record, in `specColumns` order. Booleans are 0/1 and game minutes exact integers. */
export function specValues(fields: readonly FieldSpec[], record: Record<string, unknown>): unknown[] {
  return fields.flatMap(f => {
    const input = record[f.field] as Available<unknown>;
    if (f.kind === 'money') { const m = moneyColumns(input as Available<Money>, f.sdkType!); return [m.raw, m.sdkType, m.currencyStatus, m.currencyCode, m.currencySource, m.state]; }
    return availabilityColumns(input, value => f.kind === 'boolean' ? (value ? 1 : 0) : f.kind === 'minutes' ? BigInt(value as string) : value);
  });
}
/** The inverse of `specValues` for a row read with safe integers. */
export function specRecord(fields: readonly FieldSpec[], row: Record<string, unknown>): Record<string, Available<unknown>> {
  return Object.fromEntries(fields.map((f): [string, Available<unknown>] => {
    if (f.kind === 'money') {
      const c = (suffix: string) => row[`${f.column}_${suffix}`];
      return [f.field, moneyFromColumns({raw: c('raw') as string | null, sdkType: c('sdk_type') as 's64' | 'u64' | null, currencyStatus: c('currency_status') as MoneyColumns['currencyStatus'],
        currencyCode: c('currency_code') as string | null, currencySource: c('currency_source') as string | null, state: c('state') as AvailabilityState})];
    }
    return [f.field, fromAvailability(row[f.column], row[`${f.column}_state`], value =>
      f.kind === 'boolean' ? toSafeNumber(value, 1, 0) === 1 : f.kind === 'minutes' ? String(value) : f.kind === 'integer' ? toSafeNumber(value) : f.kind === 'real' ? toReal(value) : String(value))];
  }));
}

/**
 * Sample columns. A NULL value with no mask bit is not observed; `not_supported_mask` and `invalid_mask` carry one bit
 * per field for the other two unavailable reasons. Position x/y/z share one bit.
 */
export const SAMPLE_FIELDS: readonly {field: SampleField; columns: readonly string[]; bit: number; integer: boolean}[] = [
  {field: 'speed', columns: ['speed_mps'], bit: 1, integer: false}, {field: 'fuel', columns: ['fuel_l'], bit: 2, integer: false},
  {field: 'averageConsumption', columns: ['avg_consumption_l100km'], bit: 4, integer: false}, {field: 'estimatedRange', columns: ['range_m'], bit: 8, integer: false},
  {field: 'engineRpm', columns: ['engine_rpm'], bit: 16, integer: false}, {field: 'gear', columns: ['gear'], bit: 32, integer: true},
  {field: 'odometer', columns: ['odometer_m'], bit: 64, integer: false}, {field: 'position', columns: ['x', 'y', 'z'], bit: 128, integer: false},
  {field: 'gameTime', columns: ['game_minutes'], bit: 256, integer: true}
];
/** Mask bits for one availability: not supported and invalid each set their own mask. */
export function maskBits(input: Available<unknown>, bit: number): {notSupported: number; invalid: number} {
  if (input.available || input.reason === 'not-observed') return {notSupported: 0, invalid: 0};
  return input.reason === 'not-supported' ? {notSupported: bit, invalid: 0} : {notSupported: 0, invalid: bit};
}
export function fromMask<T>(value: T | null, bit: number, notSupported: number, invalid: number): Available<T> {
  if (value !== null) return {available: true, value};
  return {available: false, reason: notSupported & bit ? 'not-supported' : invalid & bit ? 'invalid' : 'not-observed'};
}
