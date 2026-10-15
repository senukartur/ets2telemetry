import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodePayload} from '../../packages/contracts/src/protocol-v1';
import {
  availabilityColumns, canonicalJson, checkMoneyRaw, fromAvailability, fromMask, fromU64Key, JOB_FIELDS, maskBits, moneyColumns, moneyFromColumns,
  sampleMonotonicNs, specColumns, specRecord, specValues, toSafeNumber, u64Key
} from '../../packages/storage/src/codec';
import type {StorageErrorCode} from '../../packages/storage/src/api';

const code = (body: () => unknown): StorageErrorCode | undefined => {
  try { body(); return undefined; } catch (error) { return (error as {error?: {code: StorageErrorCode}}).error?.code; }
};

describe('exact uint64 keys', () => {
  it('stores wire uint64 values as 20-digit keys and restores the canonical form', () => {
    const cases: [string, string][] = [['0', '00000000000000000000'], ['1', '00000000000000000001'], ['9007199254740993', '00009007199254740993'],
      ['18446744073709551614', '18446744073709551614'], ['18446744073709551615', '18446744073709551615']];
    for (const [wire, key] of cases) { expect(u64Key(wire)).toBe(key); expect(fromU64Key(key)).toBe(wire); }
    expect(u64Key(2n ** 64n - 1n)).toBe('18446744073709551615');
  });
  it('orders keys as text exactly like the numbers they encode', () => {
    const values = ['0', '9', '10', '99', '100', '9007199254740992', '9007199254740993', '18446744073709551615', '255', '1000000000000000000'];
    expect(values.map(u64Key).sort().map(fromU64Key)).toEqual([...values].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)));
  });
  it('refuses non-canonical text and out-of-range numbers instead of coercing them', () => {
    for (const bad of ['01', '-1', '1e3', ' 1', '', '18446744073709551616', '1.0']) expect(code(() => u64Key(bad)), bad).toBe('INVALID_INPUT');
    expect(code(() => u64Key(2n ** 64n))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => u64Key(-1n))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => fromU64Key('1'))).toBe('DATABASE_CORRUPT');
  });
});

describe('exact money', () => {
  it('accepts the full s64 and u64 ranges and refuses anything outside them', () => {
    expect(checkMoneyRaw('-9223372036854775808', 's64')).toBe('-9223372036854775808');
    expect(checkMoneyRaw('9223372036854775807', 's64')).toBe('9223372036854775807');
    expect(checkMoneyRaw('18446744073709551615', 'u64')).toBe('18446744073709551615');
    expect(code(() => checkMoneyRaw('9223372036854775808', 's64'))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => checkMoneyRaw('-9223372036854775809', 's64'))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => checkMoneyRaw('18446744073709551616', 'u64'))).toBe('VALUE_OUT_OF_RANGE');
    for (const bad of ['-0', '-1', '01', '1.5', '1e3', '+1']) expect(code(() => checkMoneyRaw(bad, 'u64')), bad).toBe('INVALID_INPUT');
    for (const bad of ['-0', '01', '1.5', '+1', '-01']) expect(code(() => checkMoneyRaw(bad, 's64')), bad).toBe('INVALID_INPUT');
  });
  it('keeps raw text, SDK type and documented currency, and an unavailable amount as NULL columns', () => {
    const money = {available: true as const, value: {raw: '-125', sdkType: 's64' as const, currency: {status: 'sdk-documented' as const, code: 'EUR', source: 'scssdk_telemetry_eut2.h'}}};
    const columns = moneyColumns(money, 's64');
    expect(columns).toEqual({raw: '-125', sdkType: 's64', currencyStatus: 'sdk-documented', currencyCode: 'EUR', currencySource: 'scssdk_telemetry_eut2.h', state: 'available'});
    expect(moneyFromColumns(columns)).toEqual(money);
    expect(moneyColumns({available: false, reason: 'not-observed'}, 's64')).toEqual({raw: null, sdkType: null, currencyStatus: null, currencyCode: null, currencySource: null, state: 'not-observed'});
    expect(code(() => moneyColumns(money, 'u64'))).toBe('INVALID_INPUT');
  });
});

describe('availability, canonical JSON and samples', () => {
  it('keeps zero and a provided empty string distinct from unavailable values', () => {
    expect(availabilityColumns({available: true, value: 0}, v => v)).toEqual([0, 'available']);
    expect(availabilityColumns({available: true, value: ''}, v => v)).toEqual(['', 'available']);
    expect(availabilityColumns({available: false, reason: 'not-supported'}, v => v)).toEqual([null, 'not-supported']);
    expect(fromAvailability('', 'available', String)).toEqual({available: true, value: ''});
    expect(code(() => fromAvailability(null, 'available', String))).toBe('DATABASE_CORRUPT');
    expect(code(() => fromAvailability(null, 'missing', String))).toBe('DATABASE_CORRUPT');
  });
  it('writes the same canonical JSON for equal values regardless of member order, keeping negative zero', () => {
    expect(canonicalJson({b: [1, {d: 2, c: -0}], a: 'x'})).toBe('{"a":"x","b":[1,{"c":-0,"d":2}]}');
    expect(canonicalJson({a: 1, b: 2})).toBe(canonicalJson({b: 2, a: 1}));
    expect(JSON.parse(canonicalJson({v: 0.1 + 0.2})).v).toBe(0.1 + 0.2);
    expect(code(() => canonicalJson({v: Number.NaN}))).toBe('INVALID_INPUT');
  });
  it('maps a job configuration record to columns and back without changing a value', () => {
    const message = decodePayload(new Uint8Array(readFileSync('tests/fixtures/protocol-v1/money-uint64-max.json')), 'server');
    if (message.kind !== 'event' || message.data.record.type !== 'job.configured') throw new Error('fixture');
    const record = message.data.record as unknown as Record<string, unknown>;
    const columns = specColumns(JOB_FIELDS), values = specValues(JOB_FIELDS, record);
    // SQLite returns INTEGER columns as BigInt under safe integers, and REAL columns as numbers.
    const integerColumns = new Set(JOB_FIELDS.filter(f => f.kind === 'integer' || f.kind === 'boolean').map(f => f.column));
    const restored = specRecord(JOB_FIELDS, Object.fromEntries(columns.map((column, i) => [column, integerColumns.has(column) && typeof values[i] === 'number' ? BigInt(values[i]) : values[i]])));
    for (const field of JOB_FIELDS) {
      const original = record[field.field] as Record<string, unknown>;
      const withoutUnit = {...original}; delete withoutUnit.unit;
      expect(restored[field.field], field.field).toEqual(withoutUnit);
    }
  });
  it('refuses sample monotonic times above 2^63-1 and unsafe integers instead of truncating them', () => {
    expect(sampleMonotonicNs('9223372036854775807')).toBe(2n ** 63n - 1n);
    expect(code(() => sampleMonotonicNs('9223372036854775808'))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => sampleMonotonicNs('01'))).toBe('INVALID_INPUT');
    expect(toSafeNumber(2n ** 53n - 1n)).toBe(Number.MAX_SAFE_INTEGER);
    expect(code(() => toSafeNumber(2n ** 53n))).toBe('VALUE_OUT_OF_RANGE');
    expect(code(() => toSafeNumber(4_294_967_296n, 4_294_967_295, 0))).toBe('VALUE_OUT_OF_RANGE');
  });
  it('encodes not-supported and invalid readings in separate masks and not-observed in neither', () => {
    expect(maskBits({available: true, value: 0}, 4)).toEqual({notSupported: 0, invalid: 0});
    expect(maskBits({available: false, reason: 'not-observed'}, 4)).toEqual({notSupported: 0, invalid: 0});
    expect(maskBits({available: false, reason: 'not-supported'}, 4)).toEqual({notSupported: 4, invalid: 0});
    expect(maskBits({available: false, reason: 'invalid'}, 4)).toEqual({notSupported: 0, invalid: 4});
    expect(fromMask(null, 4, 0, 0)).toEqual({available: false, reason: 'not-observed'});
    expect(fromMask(null, 4, 4, 0)).toEqual({available: false, reason: 'not-supported'});
    expect(fromMask(null, 4, 0, 4)).toEqual({available: false, reason: 'invalid'});
    expect(fromMask(0, 4, 4, 0)).toEqual({available: true, value: 0});
  });
});
