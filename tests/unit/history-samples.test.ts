// ET-015b PR-2: the pure one-second history sampler (H3–H5, H7, H13, H14). Readings are built from the shared protocol
// v1 snapshot and checkpoint fixtures and checked by the contract validator; trip views come from the ET-014 reducer
// over tests/shared/trip-messages.ts. Every expected decision, second and row is written by hand from docs/trips.md and
// the decisions H3–H7, H13 and H14 (concept.md); none is read back from the code under test (REG-001, REG-002, REG-003,
// REG-009). Source time starts at 1,000 s, so a reading `ms` after the origin lies in second 1000 + floor(ms / 1000).
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {validateServerMessage, type Available, type CurrentState, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {SampleInput} from '../../packages/storage/src/api';
import {isUuid, SAMPLE_FIELDS, sampleMonotonicNs} from '../../packages/storage/src/codec';
import {fail, StorageFailure} from '../../packages/storage/src/errors';
import {
  initialSamplerState, initialTripState, sampleReading, tripView, type ReadingMessage, type SampleDecision, type SamplerState, type TripView
} from '../../packages/telemetry-core/src/index';
import {ETS2_A, Script, job, r, run, sessionInput, type Step} from '../shared/trip-messages';

type Of<K extends ServerMessage['kind']> = Extract<ServerMessage, {kind: K}>;
const fixture = <T>(name: string): T => JSON.parse(readFileSync(`tests/fixtures/protocol-v1/${name}.json`, 'utf8')) as T;
const SNAPSHOT = fixture<Of<'snapshot'>>('snapshot'), CHECKPOINT = fixture<Of<'checkpoint'>>('checkpoint');
const SESSION = '10000000-0000-4000-8000-000000000001', SESSION_B = '10000000-0000-4000-8000-000000000002', SESSION_C = '10000000-0000-4000-8000-000000000003';
const CLOCK = '30000000-0000-4000-8000-000000000001', CLOCK_B = '30000000-0000-4000-8000-000000000002';
const GAME_CLOCK = '40000000-0000-4000-8000-000000000001', GAME_CLOCK_B = '40000000-0000-4000-8000-000000000002';
const ORIGIN_NS = 1_000_000_000_000n;
/** The consumer's receipt label passed with every reading (H13). */
const RECEIVED = 1_800_000_000_000;
/** The fixtures' UTC label, 2026-10-12T00:00:00Z. */
const FIXTURE_UTC = 1_791_676_800_000;
const IDLE: TripView = tripView(initialTripState(), 'ets2');
/** The T4 trip UUID, written independently of the reducer with node:crypto. */
const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

interface At {
  /** Source milliseconds after the origin; `ns` overrides it with an exact capture time. */
  ms?: number; ns?: string; boundary: number;
  simulation?: CurrentState['simulation']; state?: Partial<CurrentState>;
  session?: string; clock?: string; game?: 'ets2' | 'ats'; kind?: 'snapshot' | 'checkpoint';
}
/** One reading from the shared fixture, with the given capture time, boundary order and state fields. Not validated. */
function build(at: At): ReadingMessage {
  const base: ReadingMessage = at.kind === 'checkpoint' ? CHECKPOINT : SNAPSHOT;
  const ns = at.ns ?? (ORIGIN_NS + BigInt(Math.round((at.ms ?? 0) * 1_000)) * 1_000n).toString();
  return {...base, source: {...base.source, game: at.game ?? 'ets2', pluginSessionId: at.session ?? SESSION}, capture: {clockId: at.clock ?? CLOCK, monotonicNs: ns},
    data: {...base.data, state: {...base.data.state, simulation: at.simulation ?? 'running', boundaryOrder: String(at.boundary), ...at.state},
      // Nothing retained, so the status never names a time after an early capture.
      status: {...base.data.status, delivery: {...base.data.status.delivery, retainedEvents: 0, retainedBytes: 0, oldestRetainedMonotonicNs: {available: false, reason: 'not-observed'}}}}} as ReadingMessage;
}
/** A reading that the protocol v1 contract validator accepts. */
const reading = (at: At): ReadingMessage => validateServerMessage(build(at)) as ReadingMessage;

/** A stream of one plugin session whose boundary order advances by one per reading unless given. */
class Stream {
  boundary: number;
  constructor(readonly base: Omit<At, 'boundary'> = {}, first = 100) { this.boundary = first; }
  at(ms: number, extra: Partial<At> = {}): ReadingMessage { return reading({...this.base, ms, ...extra, boundary: extra.boundary ?? this.boundary++}); }
  /** Readings every `stepMs` from `fromMs` through `toMs`. */
  every(fromMs: number, toMs: number, stepMs: number, extra: Partial<At> = {}): ReadingMessage[] {
    const out: ReadingMessage[] = [];
    for (let ms = fromMs; ms <= toMs; ms += stepMs) out.push(this.at(ms, extra));
    return out;
  }
  /** A re-send of the last boundary order: the same producer slot again. */
  again(ms: number, extra: Partial<At> = {}): ReadingMessage { return reading({...this.base, ms, ...extra, boundary: this.boundary - 1}); }
}

interface Fed {state: SamplerState; decisions: SampleDecision[]; rows: SampleInput[]}
function feed(messages: ReadingMessage[], options: {state?: SamplerState; view?: TripView | ((index: number) => TripView); receivedUtcMs?: number} = {}): Fed {
  let state = options.state ?? initialSamplerState();
  const decisions: SampleDecision[] = [], rows: SampleInput[] = [];
  messages.forEach((message, index) => {
    const view = typeof options.view === 'function' ? options.view(index) : options.view ?? IDLE;
    const result = sampleReading(state, {message, receivedUtcMs: options.receivedUtcMs ?? RECEIVED, view});
    state = result.state; decisions.push(result.decision);
    if (result.row !== null) rows.push(result.row);
  });
  return {state, decisions, rows};
}
const seconds = (rows: SampleInput[]) => rows.map(row => Number(BigInt(row.monotonicNs) / 1_000_000_000n));
/** Source milliseconds after the origin at which each row was captured. */
const capturedMs = (rows: SampleInput[]) => rows.map(row => Number((BigInt(row.monotonicNs) - ORIGIN_NS) / 1_000_000n));
const count = (decisions: SampleDecision[], decision: SampleDecision) => decisions.filter(d => d === decision).length;

/** The row of the unchanged fixture state, written by hand from tests/fixtures/protocol-v1/snapshot.json (H14). */
const FIXTURE_ROW = {
  tripUuid: null, utcMs: FIXTURE_UTC, sourceClockId: CLOCK, monotonicNs: '1000250000000',
  gameTime: {minutes: {available: true, value: 12345}, clockId: GAME_CLOCK},
  speed: {available: false, reason: 'not-observed'}, fuel: {available: true, value: 410.5}, averageConsumption: {available: true, value: 32.5},
  estimatedRange: {available: true, value: 1263000}, engineRpm: {available: true, value: 600}, gear: {available: true, value: 3},
  odometer: {available: true, value: 1234567.5}, position: {available: true, value: {x: -31234.5, y: 42.25, z: 18800.75}}
} satisfies SampleInput;

/**
 * The appendSamples row rules of docs/storage.md, checked with storage's own Node-safe field specs and monotonic range
 * check from codec.ts (unit tests may not load the SQLite core, whose validator is private): exactly the SampleInput
 * keys; a UUID or null trip; UUID clocks; a non-negative safe-integer UTC label; monotonic time at most 2^63−1; and
 * availability objects that are exactly `{available: true, value}` or `{available: false, reason}`. The real worker
 * receives these rows in PR-3's storage tests.
 */
const ROW_KEYS = 'averageConsumption,engineRpm,estimatedRange,fuel,gameTime,gear,monotonicNs,odometer,position,sourceClockId,speed,tripUuid,utcMs';
function exactAvailability(input: unknown): Available<unknown> {
  const o = input as Record<string, unknown>, keys = typeof input === 'object' && input !== null ? Object.keys(o).sort().join(',') : '';
  if (o.available === true ? keys !== 'available,value' || o.value === null || o.value === undefined
    : o.available !== false || keys !== 'available,reason' || !['not-observed', 'not-supported', 'invalid'].includes(o.reason as string)) fail('INVALID_INPUT');
  return o as Available<unknown>;
}
const finite = (value: unknown, integer: boolean) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) fail('INVALID_INPUT');
  return value;
};
function checkRow(row: SampleInput): void {
  if (Object.keys(row).sort().join(',') !== ROW_KEYS || !isUuid(row.sourceClockId) || (row.tripUuid !== null && !isUuid(row.tripUuid))) fail('INVALID_INPUT');
  if (!Number.isSafeInteger(row.utcMs) || row.utcMs < 0) fail('INVALID_INPUT');
  sampleMonotonicNs(row.monotonicNs);
  if (row.gameTime === null || Object.keys(row.gameTime).sort().join(',') !== 'clockId,minutes' || !isUuid(row.gameTime.clockId)) fail('INVALID_INPUT');
  for (const {field, integer} of SAMPLE_FIELDS) {
    const input = exactAvailability(field === 'gameTime' ? row.gameTime.minutes : row[field]);
    if (!input.available) continue;
    if (field === 'position') {
      const p = input.value as Record<string, unknown>;
      if (Object.keys(p).sort().join(',') !== 'x,y,z') fail('INVALID_INPUT');
      [p.x, p.y, p.z].forEach(value => finite(value, false));
    } else if (field === 'gameTime' && finite(input.value, true) > 4_294_967_295) fail('INVALID_INPUT');
    else finite(input.value, integer);
  }
}
function storageVerdict(rows: SampleInput[]): string {
  try {
    rows.forEach(checkRow);
    return 'valid';
  } catch (error) {
    if (error instanceof StorageFailure) return error.error.code;
    throw error;
  }
}

describe('baseline and freshness (H4)', () => {
  it('the first reading of a plugin session is a baseline; a fresh reading in the same second is then sampled', () => {
    const s = new Stream();
    const fed = feed([s.at(0), s.at(50), s.at(100)]);
    expect(fed.decisions).toEqual(['baseline', 'sampled', 'same-second']);
    expect(capturedMs(fed.rows)).toEqual([50]);
    expect(fed.state).toEqual({games: {ets2: {pluginSessionId: SESSION, clockId: CLOCK, boundaryOrder: '102', second: '1000'}, ats: null}});
  });
  it('a restart checkpoint carrying an old slot is a baseline, never a row', () => {
    const fed = feed([reading({kind: 'checkpoint', ms: 4_000, boundary: 900})]);
    expect(fed).toEqual({state: {games: {ets2: {pluginSessionId: SESSION, clockId: CLOCK, boundaryOrder: '900', second: null}, ats: null}}, decisions: ['baseline'], rows: []});
  });
  it('never mutates its input state or message', () => {
    const s = new Stream();
    const before = feed([s.at(0), s.at(50)]).state, message = s.at(1_000);
    const frozen = (value: unknown): void => { if (typeof value === 'object' && value !== null) { Object.freeze(value); Object.values(value).forEach(frozen); } };
    const copy = structuredClone(before), messageCopy = structuredClone(message);
    frozen(before); frozen(message);
    const result = sampleReading(before, {message, receivedUtcMs: RECEIVED, view: IDLE});
    expect(result.decision).toBe('sampled');
    expect(before).toEqual(copy);
    expect(message).toEqual(messageCopy);
    expect(result.state.games.ets2?.second).toBe('1001');
  });
});

describe('REG-001 road stop', () => {
  it('a stopped truck with unchanged values and an advancing boundary gives one row per second, speed 0 kept', () => {
    const s = new Stream({state: {speed: {available: true, value: 0, unit: 'm/s'}}});
    const fed = feed([s.at(-50), ...s.every(0, 4_950, 50)]);
    const stopped = {...FIXTURE_ROW, speed: {available: true, value: 0}};
    expect(fed.rows).toStrictEqual(['1000000000000', '1001000000000', '1002000000000', '1003000000000', '1004000000000'].map(monotonicNs => ({...stopped, monotonicNs})));
    expect(count(fed.decisions, 'same-second')).toBe(95);
  });
});

describe('REG-002 pause and unavailable simulation (H5)', () => {
  it('paused and unavailable readings add no row; after the resume the next second is sampled without catch-up', () => {
    const s = new Stream();
    const fed = feed([s.at(-50),
      ...s.every(0, 2_950, 50), ...s.every(3_000, 5_950, 50, {simulation: 'paused'}), ...s.every(6_000, 6_950, 50, {simulation: 'unavailable'}),
      // A running re-send of the last unavailable reading's slot: the paused and unavailable readings moved the boundary.
      s.again(7_000), ...s.every(7_500, 9_950, 50)]);
    expect(seconds(fed.rows)).toEqual([1000, 1001, 1002, 1007, 1008, 1009]);
    expect(capturedMs(fed.rows)).toEqual([0, 1_000, 2_000, 7_500, 8_000, 9_000]);
    expect(count(fed.decisions, 'not-running')).toBe(80);
    expect(fed.decisions[141]).toBe('stale');
  });
});

describe('REG-003 reconnection after a hole', () => {
  it('adds no rows for the hole; a reconnect checkpoint samples only with an advanced boundary', () => {
    const s = new Stream();
    const before = s.every(0, 2_950, 50);
    // Disconnected over 3,000–6,199 ms. The first reconnection's checkpoint repeats the last slot, so it is stale.
    const stale = s.again(6_200, {kind: 'checkpoint'});
    const after = [s.at(6_250), s.at(7_100, {kind: 'checkpoint', boundary: s.boundary + 40})];
    const fed = feed([...before, stale, ...after,
      // A re-send of the last slot much later is still stale, whatever its age.
      reading({ms: 60_000, boundary: 201})]);
    expect(fed.decisions.slice(60)).toEqual(['stale', 'sampled', 'sampled', 'stale']);
    expect(seconds(fed.rows)).toEqual([1000, 1001, 1002, 1006, 1007]);
    expect(capturedMs(fed.rows)).toEqual([50, 1_000, 2_000, 6_250, 7_100]);
  });
});

describe('cadence (H3)', () => {
  const cadence = (stepMs: number) => {
    const s = new Stream();
    return feed([s.at(-500), ...s.every(0, 9_999, stepMs)]).rows;
  };
  it('20 Hz gives one row per second at the first reading of each second', () => {
    expect(capturedMs(cadence(50))).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000]);
  });
  it('4 Hz gives one row per second', () => {
    expect(capturedMs(cadence(250))).toEqual([0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000]);
  });
  it('1.5 Hz gives one row per covered second, at its first reading', () => {
    expect(capturedMs(cadence(667))).toEqual([0, 1_334, 2_001, 3_335, 4_002, 5_336, 6_003, 7_337, 8_004, 9_338]);
  });
  it('one hour at 20 Hz with ±10 ms jitter gives exactly 3,600 rows, one per source second', () => {
    // A deterministic linear congruential generator for jitter in whole microseconds, -10,000 to +10,000.
    let seed = 0x2f6b1d3a;
    const jitterUs = () => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return (seed % 20_001) - 10_000; };
    let state = sampleReading(initialSamplerState(), {message: build({ms: -100, boundary: 1}), receivedUtcMs: RECEIVED, view: IDLE}).state;
    const rows: SampleInput[] = [];
    for (let k = 0; k < 72_000; k++) {
      const ns = (ORIGIN_NS + BigInt(20_000 + k * 50_000 + jitterUs()) * 1_000n).toString();
      const result = sampleReading(state, {message: build({ns, boundary: 2 + k}), receivedUtcMs: RECEIVED, view: IDLE});
      state = result.state;
      if (result.row !== null) rows.push(result.row);
    }
    expect(rows).toHaveLength(3_600);
    expect(seconds(rows)).toEqual(Array.from({length: 3_600}, (_, i) => 1000 + i));
    // The first reading of each second lies within its first 70 ms (20 ms offset, 50 ms period, ±10 ms jitter).
    expect(rows.every(row => BigInt(row.monotonicNs) % 1_000_000_000n < 70_000_000n)).toBe(true);
    expect(storageVerdict(rows)).toBe('valid');
  });
  it('game-time jumps and regressions and a UTC set back do not change the cadence', () => {
    const s = new Stream();
    const minutes = (value: string, clockId = GAME_CLOCK) => ({gameTime: {available: true as const, value, unit: 'min' as const, clockId}});
    const fed = feed([s.at(-250), ...s.every(0, 1_750, 250, {state: minutes('12345')}),
      // A sleep: +600 game minutes in one step.
      ...s.every(2_000, 2_750, 250, {state: minutes('12945')}),
      // A save load: game time goes back on a new game clock.
      ...s.every(3_000, 3_750, 250, {state: minutes('100', GAME_CLOCK_B)}),
      // The UTC label is set back by one hour.
      ...s.every(4_000, 4_750, 250, {state: {...minutes('101', GAME_CLOCK_B), captureUtcUnixMs: {available: true, value: String(FIXTURE_UTC - 3_600_000)}}})]);
    expect(capturedMs(fed.rows)).toEqual([0, 1_000, 2_000, 3_000, 4_000]);
    expect(fed.rows.map(row => [row.gameTime, row.utcMs])).toStrictEqual([
      [{minutes: {available: true, value: 12345}, clockId: GAME_CLOCK}, FIXTURE_UTC],
      [{minutes: {available: true, value: 12345}, clockId: GAME_CLOCK}, FIXTURE_UTC],
      [{minutes: {available: true, value: 12945}, clockId: GAME_CLOCK}, FIXTURE_UTC],
      [{minutes: {available: true, value: 100}, clockId: GAME_CLOCK_B}, FIXTURE_UTC],
      [{minutes: {available: true, value: 101}, clockId: GAME_CLOCK_B}, FIXTURE_UTC - 3_600_000]
    ]);
  });
});

describe('REG-009 row mapping (H13, H14)', () => {
  it('copies the fixture state in canonical units, without unit keys and without orientation', () => {
    const fed = feed([reading({ms: 0, boundary: 101}), reading({ms: 250, boundary: 102})]);
    expect(fed.rows).toStrictEqual([FIXTURE_ROW]);
  });
  it('keeps zero, negative values and every unavailable reason distinct; game time keeps its own clock', () => {
    const fed = feed([reading({ms: 0, boundary: 1}), reading({ms: 500, boundary: 2, state: {
      speed: {available: true, value: -2.5, unit: 'm/s'}, fuel: {available: true, value: 0, unit: 'L'}, engineRpm: {available: false, reason: 'not-supported', unit: 'rpm'},
      gear: {available: true, value: -1, unit: 'index'}, odometer: {available: false, reason: 'invalid', unit: 'm'},
      averageConsumption: {available: false, reason: 'not-observed', unit: 'L/100km'}, estimatedRange: {available: true, value: 0, unit: 'm'},
      worldPlacement: {available: false, reason: 'not-supported'}, gameTime: {available: false, reason: 'not-observed', unit: 'min', clockId: GAME_CLOCK_B},
      captureUtcUnixMs: {available: false, reason: 'not-observed'}
    }})]);
    expect(fed.rows).toStrictEqual([{
      tripUuid: null, utcMs: RECEIVED, sourceClockId: CLOCK, monotonicNs: '1000500000000',
      gameTime: {minutes: {available: false, reason: 'not-observed'}, clockId: GAME_CLOCK_B},
      speed: {available: true, value: -2.5}, fuel: {available: true, value: 0}, averageConsumption: {available: false, reason: 'not-observed'},
      estimatedRange: {available: true, value: 0}, engineRpm: {available: false, reason: 'not-supported'}, gear: {available: true, value: -1},
      odometer: {available: false, reason: 'invalid'}, position: {available: false, reason: 'not-supported'}
    }]);
  });
  it('falls back to the receipt label when the capture UTC label is unavailable or not a safe integer (H13)', () => {
    const utc = (value: string | null): Partial<CurrentState> => ({captureUtcUnixMs: value === null ? {available: false, reason: 'not-observed'} : {available: true, value}});
    const fed = feed([reading({ms: 0, boundary: 1}), reading({ms: 500, boundary: 2, state: utc(null)}), reading({ms: 1_500, boundary: 3, state: utc('9007199254740992')}),
      reading({ms: 2_500, boundary: 4, state: utc('9007199254740991')}), reading({ms: 3_500, boundary: 5, state: utc('0')})], {receivedUtcMs: 1_234_567});
    expect(fed.rows.map(row => row.utcMs)).toEqual([1_234_567, 1_234_567, 9_007_199_254_740_991, 0]);
  });
  it('produces rows that storage accepts, and storage refuses a row that kept a unit key', () => {
    const rows = feed([reading({ms: 0, boundary: 1}), reading({ms: 250, boundary: 2}), reading({ms: 1_250, boundary: 3, state: {
      speed: {available: true, value: 0, unit: 'm/s'}, gear: {available: false, reason: 'invalid', unit: 'index'}, worldPlacement: {available: false, reason: 'not-observed'},
      gameTime: {available: false, reason: 'not-supported', unit: 'min', clockId: GAME_CLOCK_B}, captureUtcUnixMs: {available: false, reason: 'not-observed'}
    }}), reading({ns: '9223372036854775807', boundary: 4})]).rows;
    expect(rows).toHaveLength(3);
    expect(storageVerdict(rows)).toBe('valid');
    expect(storageVerdict([{...rows[0], fuel: {available: true, value: 410.5, unit: 'L'} as unknown as SampleInput['fuel']}])).toBe('INVALID_INPUT');
    expect(storageVerdict([{...rows[0], gear: {available: true, value: 2.5}}])).toBe('INVALID_INPUT');
    expect(storageVerdict([{...rows[0], monotonicNs: '9223372036854775808'}])).toBe('VALUE_OUT_OF_RANGE');
  });
});

describe('capture range and plugin sessions', () => {
  it('a capture above 2^63−1 ns is out of range: no row, but the boundary advances', () => {
    const fed = feed([reading({ns: '9223372035000000000', boundary: 1}), reading({ns: '9223372036854775807', boundary: 2}),
      reading({ns: '9223372037854775807', boundary: 3}), reading({ns: '9223372037854775807', boundary: 3}), reading({ns: '18446744073709551615', boundary: 4})]);
    expect(fed.decisions).toEqual(['baseline', 'sampled', 'out-of-range', 'stale', 'out-of-range']);
    expect(fed.rows.map(row => row.monotonicNs)).toEqual(['9223372036854775807']);
    expect(fed.state.games.ets2).toEqual({pluginSessionId: SESSION, clockId: CLOCK, boundaryOrder: '4', second: '9223372036'});
  });
  it('a new plugin session of the game starts with a baseline; each game keeps its own session', () => {
    const fed = feed([reading({ms: 0, boundary: 100}), reading({ms: 50, boundary: 101}),
      // Session B starts with a lower boundary order on its own clock: a baseline, not a stale reading.
      reading({ms: 100, boundary: 5, session: SESSION_B, clock: CLOCK_B}), reading({ms: 150, boundary: 6, session: SESSION_B, clock: CLOCK_B}),
      reading({ms: 200, boundary: 7, session: SESSION_C, game: 'ats'}), reading({ms: 250, boundary: 7, session: SESSION_B, clock: CLOCK_B})]);
    expect(fed.decisions).toEqual(['baseline', 'sampled', 'baseline', 'sampled', 'baseline', 'same-second']);
    expect(fed.rows.map(row => [row.sourceClockId, row.monotonicNs])).toEqual([[CLOCK, '1000050000000'], [CLOCK_B, '1000150000000']]);
    expect(fed.state).toEqual({games: {
      ets2: {pluginSessionId: SESSION_B, clockId: CLOCK_B, boundaryOrder: '7', second: '1000'},
      ats: {pluginSessionId: SESSION_C, clockId: CLOCK, boundaryOrder: '7', second: null}
    }});
  });
  it('the sampled second is kept per capture clock', () => {
    const fed = feed([reading({ms: 1_500, boundary: 1}), reading({ms: 1_550, boundary: 2}),
      reading({ms: -500, boundary: 3, clock: CLOCK_B}), reading({ms: -400, boundary: 4, clock: CLOCK_B})]);
    expect(fed.decisions).toEqual(['baseline', 'sampled', 'sampled', 'same-second']);
    expect(fed.rows.map(row => [row.sourceClockId, seconds([row])[0]])).toEqual([[CLOCK, 1001], [CLOCK_B, 999]]);
  });
});

describe('H7 trip reference', () => {
  const paused = {simulation: 'paused'} as const, trip = uuid(ETS2_A, '2');
  /** A fresh script of ETS2_A: the session, a job accepted while paused (eventSeq 2) and the start, then `more`. */
  const after = (more: (s: Script) => Step[] = () => []) => {
    const s = new Script(ETS2_A);
    return run(initialTripState(), [sessionInput(s.welcome()), s.event(r.paused(), paused), s.event(r.jobConfigured(), paused), s.event(r.started()), ...more(s)]).state;
  };
  const active = after(), awaiting = after(s => [s.event(r.jobCleared())]);
  const reload = after(s => [s.event(r.paused(), paused), s.event(r.jobCleared(), paused), s.event(r.jobConfigured(), paused)]);
  const t = new Script(ETS2_A);
  const untracked = run(initialTripState(), [sessionInput(t.welcome()), {kind: 'checkpoint', message: t.checkpoint(job())}]).state;
  const views: [string, TripView][] = [
    ['active', tripView(active, 'ets2')], ['awaiting-outcome', tripView(awaiting, 'ets2')], ['reload-check', tripView(reload, 'ets2')],
    ['idle with an untracked job', tripView(untracked, 'ets2')], ['idle', IDLE]
  ];
  it('the reducer views have the phases this test relies on', () => {
    expect(views.map(([, view]) => [view.phase, view.untrackedJob, view.current?.tripUuid ?? null])).toEqual([
      ['active', false, trip], ['awaiting-outcome', false, trip], ['reload-check', false, trip], ['idle', true, null], ['idle', false, null]
    ]);
  });
  it('a sample names the trip only while the committed trip is active', () => {
    const stream = new Stream();
    const fed = feed([stream.at(-50), ...views.map((_, i) => stream.at(i * 1_000))], {view: index => index === 0 ? IDLE : views[index - 1][1]});
    expect(fed.rows.map(row => row.tripUuid)).toEqual([trip, null, null, null, null]);
  });
  it('an untracked job never gets a trip reference, even beside an active phase', () => {
    const view: TripView = {...tripView(active, 'ets2'), untrackedJob: true};
    const fed = feed([reading({ms: 0, boundary: 1}), reading({ms: 50, boundary: 2})], {view});
    expect(fed.rows.map(row => row.tripUuid)).toEqual([null]);
  });
});
