import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {SampleInput, Storage} from '../../packages/storage/src/index';
import {failed, ok, P1, readOnly, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
let storage: Storage;
beforeEach(async () => { ws = await workspace(); storage = await ws.open(); ok(storage.upsertSession({message: v1('welcome')})); });
afterEach(async () => { await ws.dispose(); });

const SOURCE_CLOCK = '30000000-0000-4000-8000-000000000001', GAME_CLOCK = '40000000-0000-4000-8000-000000000001';
const TRIP = '70000000-0000-4000-8000-000000000001';
function sample(overrides: Partial<SampleInput> = {}): SampleInput {
  return {
    utcMs: 1_791_676_800_000, sourceClockId: SOURCE_CLOCK, monotonicNs: '1000149000000', gameTime: {minutes: {available: true, value: 12_345}, clockId: GAME_CLOCK},
    speed: {available: true, value: 0}, fuel: {available: false, reason: 'not-supported'}, averageConsumption: {available: true, value: Math.fround(32.5)},
    estimatedRange: {available: false, reason: 'invalid'}, engineRpm: {available: false, reason: 'not-observed'}, gear: {available: true, value: -1},
    odometer: {available: true, value: Math.fround(1_234_567.5)}, position: {available: true, value: {x: Math.fround(-31_234.5), y: Math.fround(42.25), z: Math.fround(18_800.75)}},
    ...overrides
  };
}

describe('REG-009 one-second samples', () => {
  it('keeps zero, not observed, not supported and invalid readings distinct', () => {
    ok(storage.appendSamples(P1, [sample()]));
    const [read] = ok(storage.listSamples({pluginSessionId: P1}));
    expect(read).toEqual({...sample(), tripUuid: null, id: expect.any(String)});
    storage.close();
    const row = readOnly(ws.database, db => db.prepare('SELECT speed_mps, fuel_l, range_m, engine_rpm, not_supported_mask, invalid_mask FROM samples').get());
    // Zero is a value; unavailable readings are NULL, and only not-supported/invalid set a mask bit.
    expect(row).toEqual({speed_mps: 0, fuel_l: null, range_m: null, engine_rpm: null, not_supported_mask: 2, invalid_mask: 8});
  });
  it('stores SDK float32 values exactly as float64 and reads them back bit for bit', () => {
    const values = [Math.fround(0.1), Math.fround(1e-30), Math.fround(3.4e38), Math.fround(-123.456), Math.fround(-0.75)];
    ok(storage.appendSamples(P1, values.map(value => sample({speed: {available: true, value}}))));
    const read = ok(storage.listSamples({pluginSessionId: P1})).map(s => s.speed.available ? s.speed.value : NaN);
    read.forEach((value, index) => expect(Object.is(value, values[index]), `index ${index}`).toBe(true));
  });
  it('stores negative zero as zero, because SQLite keeps integral REAL values in integer form', () => {
    ok(storage.appendSamples(P1, [sample({speed: {available: true, value: -0}})]));
    const [read] = ok(storage.listSamples({pluginSessionId: P1}));
    expect(read.speed).toEqual({available: true, value: 0});
    expect(Object.is(read.speed.available && read.speed.value, 0)).toBe(true);
  });
  it('refuses a monotonic time above 2^63-1 instead of truncating it, and accepts 2^63-1', () => {
    failed(storage.appendSamples(P1, [sample({monotonicNs: '9223372036854775808'})]), 'VALUE_OUT_OF_RANGE');
    ok(storage.appendSamples(P1, [sample({monotonicNs: '9223372036854775807'})]));
    expect(ok(storage.listSamples({pluginSessionId: P1})).map(s => s.monotonicNs)).toEqual(['9223372036854775807']);
  });
  it('writes a batch atomically: one invalid sample stores none of them', () => {
    failed(storage.appendSamples(P1, [sample(), sample({utcMs: 1_791_676_801_000}), sample({tripUuid: TRIP})]), 'UNKNOWN_TRIP');
    failed(storage.appendSamples(P1, [sample(), sample({gear: {available: true, value: 1.5}})]), 'INVALID_INPUT');
    failed(storage.appendSamples(P1, Array.from({length: 3_601}, () => sample())), 'INVALID_INPUT');
    failed(storage.appendSamples('10000000-0000-4000-8000-000000000009', [sample()]), 'UNKNOWN_SESSION');
    expect(ok(storage.listSamples({pluginSessionId: P1}))).toEqual([]);
    expect(ok(storage.appendSamples(P1, Array.from({length: 3_600}, (_, i) => sample({utcMs: 1_791_676_800_000 + i * 1_000}))))).toEqual({appended: 3_600});
  });
  it('refuses a malformed availability object instead of storing it as not observed', () => {
    const malformed = (value: unknown) => value as never;
    const cases: Partial<SampleInput>[] = [
      {position: malformed({available: true, value: null})},
      {position: malformed({available: true})},
      {position: malformed({available: true, value: {x: 1, y: 2}})},
      {gameTime: malformed({clockId: GAME_CLOCK})},
      {gameTime: malformed({minutes: {available: true, value: null}, clockId: GAME_CLOCK})},
      {gameTime: malformed({minutes: null, clockId: GAME_CLOCK})},
      {gameTime: malformed({minutes: undefined, clockId: GAME_CLOCK})},
      {speed: malformed({available: false})},
      {speed: malformed({available: false, reason: 'unknown'})},
      {speed: malformed({available: true, value: 1, reason: 'invalid'})},
      {speed: malformed({available: 'yes', value: 1})}
    ];
    for (const overrides of cases) failed(storage.appendSamples(P1, [sample(overrides)]), 'INVALID_INPUT');
    expect(ok(storage.listSamples({pluginSessionId: P1}))).toEqual([]);
  });
  it('associates samples with a trip and pages them in insertion order', () => {
    ok(storage.commitEvent({message: v1('event-job-configured'), effects: [{kind: 'trip.open', tripUuid: TRIP, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
      jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1_791_676_800_000}]}));
    ok(storage.appendSamples(P1, [sample(), sample({tripUuid: TRIP, utcMs: 1}), sample({tripUuid: TRIP, utcMs: 2}), sample({tripUuid: TRIP, utcMs: 3, gameTime: null})]));
    const first = ok(storage.listSamples({tripUuid: TRIP}, {limit: 2}));
    expect(first.map(s => s.utcMs)).toEqual([1, 2]);
    const rest = ok(storage.listSamples({tripUuid: TRIP}, {afterId: first[1].id}));
    expect(rest.map(s => [s.utcMs, s.tripUuid, s.gameTime])).toEqual([[3, TRIP, null]]);
    failed(storage.listSamples({pluginSessionId: P1}, {limit: 3_601}), 'INVALID_INPUT');
  });
});
