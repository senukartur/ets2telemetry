// ET-014 trip identity (T4, T6). SHA-256 expectations are the FIPS 180-2 / NIST example vectors; parity cases compare
// with node:crypto, an independent implementation; UUID expectations follow the T4 derivation text.
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {isUuid} from '../../packages/storage/src/codec';
import {attachTripUuidFor, JOB_KEY_FIELDS, jobKey, sha256Hex, tripUuidFor, utf8Bytes} from '../../packages/telemetry-core/src/index';
import {job} from '../shared/trip-messages';

/** The T4 derivation written independently of the reducer: node:crypto SHA-256 of the documented input, first 128 bits. */
function specUuid(session: string, eventSeq: string): string {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
/** A seeded pseudo-random generator (mulberry32), so parity inputs are the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const ALPHABET = ['a', 'Z', '0', ' ', ':', '-', 'é', 'Ж', 'Гётеборг', '€', '中', '😀', '\u0000', '\u007f'];

describe('SHA-256 (T4)', () => {
  it.each([
    ['empty input', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['the 448-bit message', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['the 896-bit message', 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
    ['one million "a"', 'a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0']
  ])('matches the NIST vector for %s', (_name, input, digest) => expect(sha256Hex(input)).toBe(digest));

  it('matches node:crypto at every padding boundary and for seeded text with multi-byte characters', () => {
    const lengths = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129];
    const inputs = lengths.map(n => 'x'.repeat(n));
    const next = random(14);
    for (let i = 0; i < 300; i++) {
      const parts = Math.floor(next() * 80);
      inputs.push(Array.from({length: parts}, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join(''));
    }
    for (const input of inputs) expect(sha256Hex(input), JSON.stringify(input)).toBe(createHash('sha256').update(input, 'utf8').digest('hex'));
    const bytes = Uint8Array.from({length: 1_000}, (_, i) => (i * 37 + 11) & 0xff);
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
  it('encodes UTF-8 like TextEncoder, including a lone surrogate as U+FFFD', () => {
    for (const text of ['', 'ascii', 'Гётеборг', '😀 emoji', 'lone \ud800 high', 'lone \udc00 low', 'end \ud83d']) {
      expect([...utf8Bytes(text)], JSON.stringify(text)).toEqual([...new TextEncoder().encode(text)]);
    }
  });
});

describe('tripUuidFor (T4)', () => {
  const SESSION = '10000000-0000-4000-8000-000000000001';
  it('is the first 128 bits of SHA-256("ets2telemetry-trip-v1:" + session + ":" + eventSeq) as a lowercase UUID shape', () => {
    for (const seq of ['1', '2', '9007199254740993', '18446744073709551614']) {
      const uuid = tripUuidFor(SESSION, seq);
      expect(uuid).toBe(specUuid(SESSION, seq));
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(isUuid(uuid)).toBe(true);
    }
  });
  it('is deterministic and differs by session and by configuring event', () => {
    expect(tripUuidFor(SESSION, '7')).toBe(tripUuidFor(SESSION, '7'));
    const all = new Set([tripUuidFor(SESSION, '7'), tripUuidFor(SESSION, '8'), tripUuidFor('10000000-0000-4000-8000-000000000002', '7')]);
    expect(all.size).toBe(3);
  });
});

describe('attachTripUuidFor (ET-016 PR-7, J9)', () => {
  const SESSION = '10000000-0000-4000-8000-000000000001';
  it('is the first 128 bits of SHA-256("ets2telemetry-trip-attach-v1:" + session + ":" + nextEventSeq) in the T4 shape, never a T4 UUID', () => {
    for (const next of ['1', '2', '9007199254740993', '18446744073709551615']) {
      const h = createHash('sha256').update(`ets2telemetry-trip-attach-v1:${SESSION}:${next}`, 'utf8').digest('hex');
      const uuid = attachTripUuidFor(SESSION, next);
      expect(uuid).toBe(`${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`);
      expect(isUuid(uuid)).toBe(true);
      // Its own prefix keeps it apart from the trip opened at an event with the same number.
      expect(uuid).not.toBe(tripUuidFor(SESSION, next));
    }
    expect(attachTripUuidFor(SESSION, '7')).toBe(attachTripUuidFor(SESSION, '7'));
  });
});

describe('jobKey (T6, O3)', () => {
  it('covers every job.configured field except cargoLoaded', () => {
    expect([...JOB_KEY_FIELDS].sort()).toEqual(Object.keys(job()).filter(key => key !== 'cargoLoaded').sort());
  });
  it('ignores only cargoLoaded: a cargo-market pickup re-send is the same job (O3)', () => {
    const before = job({market: {available: true, value: 'cargo_market'}, cargoLoaded: {available: true, value: false}});
    const after = {...before, cargoLoaded: {available: true as const, value: true}};
    expect(jobKey(after)).toBe(jobKey(before));
    expect(jobKey({...before, cargoLoaded: {available: false, reason: 'not-observed'}})).toBe(jobKey(before));
  });
  it.each(JOB_KEY_FIELDS.map(field => [field]))('changes when %s changes availability', field => {
    const base = job(), value = base[field] as Record<string, unknown>;
    const changed = {...base, [field]: {available: false, reason: 'invalid', ...('unit' in value ? {unit: value.unit} : {})}};
    expect(jobKey(changed)).not.toBe(jobKey(base));
  });
  it('distinguishes unavailable reasons, values and currencies, and ignores member order and the record type', () => {
    const base = job();
    expect(jobKey({...base, cargo: {available: false, reason: 'not-observed'}})).not.toBe(jobKey({...base, cargo: {available: false, reason: 'invalid'}}));
    expect(jobKey({...base, cargo: {available: true, value: ''}})).not.toBe(jobKey({...base, cargo: {available: false, reason: 'not-observed'}}));
    expect(jobKey({...base, expectedIncome: {available: true, value: {raw: '12345', sdkType: 'u64', currency: {status: 'sdk-documented', code: 'EUR', source: 'header'}}}}))
      .not.toBe(jobKey(base));
    const reordered = Object.fromEntries(Object.entries(base).reverse().map(([key, value]) => [key, typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse()) : value]));
    expect(jobKey(reordered as typeof base)).toBe(jobKey(base));
    expect(jobKey({type: 'job.configured', ...base} as typeof base)).toBe(jobKey(base));
  });
});
