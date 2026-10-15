// REG-008 step primitives and derived live values. Scenarios are built by hand from the shared v0 and v1 snapshot
// fixtures; each expected classification follows the rules in docs/live-telemetry-fields.md.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {
  bearingDegrees, deadlineRemaining, float32Quantum, fuelLevel, fuelStep, normalizeV0State, odometerJumpMargin, normalizeV1State, odometerStep, type NormalizedLiveState,
  type Reading, type StepSample
} from '../../packages/telemetry-core/src';

const value = <T>(v: T): Reading<T> => ({state: 'value', value: v});
const missing = (reason: 'not-observed' | 'not-supported' | 'invalid' | 'not-carried'): Reading<never> => ({state: 'missing', reason});
function snapshotOf<M extends {kind: string}>(message: M): Extract<M, {kind: 'snapshot'}> {
  if (message.kind !== 'snapshot') throw new Error('snapshot expected');
  return message as Extract<M, {kind: 'snapshot'}>;
}
const v0Snapshot = snapshotOf(v0.decodePayload(new Uint8Array(readFileSync('tests/fixtures/protocol-v0/snapshot.json'))));
const v1Snapshot = snapshotOf(v1.decodePayload(new Uint8Array(readFileSync('tests/fixtures/protocol-v1/snapshot.json')), 'server'));

const MS = 1_000_000n;
/** A sample at a whole number of source milliseconds after a fixed origin, `seconds` written in seconds. */
function sample(seconds: number, patch: Partial<NormalizedLiveState> = {}, from: 'v0' | 'v1' = 'v0'): StepSample {
  const base = from === 'v0' ? normalizeV0State(v0Snapshot.data.state) : normalizeV1State(v1Snapshot.data.state, v1Snapshot.data.status);
  const message = from === 'v0' ? v0Snapshot : v1Snapshot;
  return {
    source: {...message.source}, capture: {clockId: message.capture.clockId, monotonicNs: (1_000_000n * MS + BigInt(Math.round(seconds * 1000)) * MS).toString()},
    state: {...base, ...patch}
  };
}
const odometer = (meters: number) => ({odometer: value({kind: 'odometer' as const, meters})});
const fuel = (liters: number) => ({fuel: value(liters)});

describe('REG-008 odometer steps', () => {
  it('keeps a road stop continuous with zero metres', () => {
    expect(odometerStep(sample(0), sample(1))).toEqual({kind: 'continuous', meters: 0});
  });
  it('accepts a normal step', () => {
    expect(odometerStep(sample(0, odometer(1234567.5)), sample(1, odometer(1234592.5)))).toEqual({kind: 'continuous', meters: 25});
  });
  it('accepts the plausible bound exactly and rejects a step beyond it as a jump', () => {
    expect(odometerStep(sample(0, odometer(1000)), sample(1, odometer(1150)))).toEqual({kind: 'continuous', meters: 150});
    expect(odometerStep(sample(0, odometer(1000)), sample(1, odometer(1150.5)))).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
    expect(odometerStep(sample(0, odometer(1000)), sample(10, odometer(2000)))).toEqual({kind: 'continuous', meters: 1000});
  });
  // PR #53 advisory review: truck.odometer is an SDK float32 in km, quantized to 1/16 km (62.5 m) from 2^19 km and to
  // 1/8 km (125 m) from 2^20 km, which exceeds the fixed 55 m threshold of a 50 ms (20 Hz) step.
  it('measures the float32 quantum exactly at and around the power-of-two boundaries', () => {
    expect(float32Quantum(1)).toBe(2 ** -23);
    expect(float32Quantum(524287.5)).toBe(0.03125);
    expect(float32Quantum(524288)).toBe(0.0625);
    expect(float32Quantum(600000)).toBe(0.0625);
    expect(float32Quantum(1048576)).toBe(0.125);
    expect(float32Quantum(-524288)).toBe(0.0625);
    expect(odometerJumpMargin(1_000_000, 1_000_055)).toBe(50);
    expect(odometerJumpMargin(524_288_000, 524_288_062.5)).toBe(125);
    expect(odometerJumpMargin(1_048_575_000, 1_048_576_000)).toBe(250);
  });
  it('keeps a one-quantum 20 Hz step of a 600,000 km odometer continuous', () => {
    expect(odometerStep(sample(0, odometer(600_000_000)), sample(0.05, odometer(600_000_062.5)))).toEqual({kind: 'continuous', meters: 62.5});
  });
  it('still reports a teleport of a high-mileage truck as a jump', () => {
    expect(odometerStep(sample(0, odometer(600_000_000)), sample(0.05, odometer(600_005_000)))).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
    expect(odometerStep(sample(0, odometer(1_048_576_000)), sample(1, odometer(1_048_586_000)))).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
  });
  it('widens the 20 Hz threshold to 5 m + two quanta at 2^19 km and at 2^20 km', () => {
    const at = (km: number, plus: number) => odometerStep(sample(0, odometer(km * 1000)), sample(0.05, odometer(km * 1000 + plus)));
    expect(at(524288, 62.5)).toEqual({kind: 'continuous', meters: 62.5});
    expect(at(524288, 130)).toEqual({kind: 'continuous', meters: 130});
    expect(at(524288, 130.5)).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
    expect(at(1048576, 125)).toEqual({kind: 'continuous', meters: 125});
    expect(at(1048576, 255)).toEqual({kind: 'continuous', meters: 255});
    expect(at(1048576, 255.5)).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
    // Low mileage keeps the fixed 50 m margin: 5 m + 50 m.
    expect(at(1000, 55)).toEqual({kind: 'continuous', meters: 55});
    expect(at(1000, 55.5)).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
  });
  it('reports a one-quantum decrease as a regression, because float32 rounding is monotonic', () => {
    expect(odometerStep(sample(0, odometer(600_000_062.5)), sample(0.05, odometer(600_000_000)))).toEqual({kind: 'discontinuity', cause: 'odometer-regressed'});
  });
  it('classifies a teleport as a jump and never as distance', () => {
    expect(odometerStep(sample(0, odometer(1234567.5)), sample(1, odometer(1334567.5)))).toEqual({kind: 'discontinuity', cause: 'odometer-jump'});
  });
  it('never returns negative distance for a regressed odometer', () => {
    expect(odometerStep(sample(0, odometer(1234567.5)), sample(1, odometer(1234000)))).toEqual({kind: 'discontinuity', cause: 'odometer-regressed'});
  });
  it('reports a save load (O10) as a game-clock rotation even when the odometer regresses', () => {
    const loaded = {...odometer(1200000), gameTime: {minutes: value(12000n), clockId: '00000000-0000-4000-8000-0000000000aa'}};
    expect(odometerStep(sample(0), sample(1, loaded))).toEqual({kind: 'discontinuity', cause: 'game-clock-rotated'});
  });
  it('reports a timer restart as a game-clock rotation with an unchanged odometer', () => {
    const restarted = {gameTime: {minutes: value(0n), clockId: '00000000-0000-4000-8000-0000000000bb'}};
    expect(odometerStep(sample(0), sample(1, restarted))).toEqual({kind: 'discontinuity', cause: 'game-clock-rotated'});
  });
  it('reports a v0 truck change and a change of truck availability', () => {
    const base = sample(0).state;
    if (base.truck.state !== 'value') throw new Error('truck expected');
    const other = {truck: value({...base.truck.value, model: {...base.truck.value.model, id: value('truck.scania')}})};
    expect(odometerStep(sample(0), sample(1, other))).toEqual({kind: 'discontinuity', cause: 'truck-changed'});
    expect(odometerStep(sample(0), sample(1, {truck: missing('not-observed')}))).toEqual({kind: 'discontinuity', cause: 'truck-changed'});
  });
  it('reports a v1 truck change by plate', () => {
    const base = sample(0, {}, 'v1').state;
    if (base.truck.state !== 'value') throw new Error('truck expected');
    const replated = {truck: value({...base.truck.value, licensePlate: value('SYN 0009')})};
    expect(odometerStep(sample(0, {}, 'v1'), sample(1, replated, 'v1'))).toEqual({kind: 'discontinuity', cause: 'truck-changed'});
    expect(odometerStep(sample(0, {}, 'v1'), sample(1, {}, 'v1'))).toEqual({kind: 'continuous', meters: 0});
  });
  it('reports a new plugin session, process or capture clock as a source change', () => {
    const next = sample(1);
    expect(odometerStep(sample(0), {...next, source: {...next.source, pluginSessionId: '00000000-0000-4000-8000-0000000000cc'}}))
      .toEqual({kind: 'discontinuity', cause: 'source-changed'});
    expect(odometerStep(sample(0), {...next, source: {...next.source, processInstanceId: '00000000-0000-4000-8000-0000000000dd'}}))
      .toEqual({kind: 'discontinuity', cause: 'source-changed'});
    expect(odometerStep(sample(0), {...next, capture: {...next.capture, clockId: '00000000-0000-4000-8000-0000000000ee'}}))
      .toEqual({kind: 'discontinuity', cause: 'source-changed'});
  });
  it('is unavailable with a missing odometer or out-of-order samples', () => {
    expect(odometerStep(sample(0), sample(1, {odometer: missing('not-observed')}))).toEqual({kind: 'unavailable'});
    expect(odometerStep(sample(0, {odometer: missing('invalid')}), sample(1))).toEqual({kind: 'unavailable'});
    expect(odometerStep(sample(2), sample(1))).toEqual({kind: 'unavailable'});
  });
});

describe('REG-008 fuel steps', () => {
  it('reports consumption as a positive amount', () => {
    const step = fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.2)));
    expect(step.kind).toBe('consumed');
    expect(step.kind === 'consumed' && step.liters).toBeCloseTo(0.3, 9);
  });
  it('reports a refuel of 200 L as refuelled, never as negative consumption', () => {
    expect(fuelStep(sample(0, fuel(100)), sample(1, fuel(300)))).toEqual({kind: 'refuelled', addedLiters: 200});
  });
  // Requirement changed in fix round 1: small decreases are real consumption, not noise. About 30–35 L/100 km at
  // 80–90 km/h burns roughly 0.0075 L per second, well inside the 0.01 L refuel band.
  it('reports a 1 Hz cruise step of 0.0075 L as consumed', () => {
    const step = fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.4925)));
    expect(step.kind).toBe('consumed');
    expect(step.kind === 'consumed' && step.liters).toBeCloseTo(0.0075, 9);
  });
  it('keeps every 20 Hz step as consumption so the steps add up to the observed drop', () => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const step = fuelStep(sample(i * 0.05, fuel(410.5 - i * 0.000375)), sample((i + 1) * 0.05, fuel(410.5 - (i + 1) * 0.000375)));
      if (step.kind !== 'consumed') throw new Error(`step ${i} was ${step.kind}`);
      expect(step.liters).toBeGreaterThan(0);
      total += step.liters;
    }
    expect(total).toBeCloseTo(0.0075, 9);
  });
  it('treats an increase of at most 0.01 L as unchanged with its amount, and a larger one as a refuel', () => {
    const small = fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.509)));
    expect(small.kind).toBe('unchanged');
    expect(small.kind === 'unchanged' && small.increaseLiters).toBeCloseTo(0.009, 9);
    expect(fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.5)))).toEqual({kind: 'unchanged', increaseLiters: 0});
    const refuel = fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.511)));
    expect(refuel.kind).toBe('refuelled');
    expect(refuel.kind === 'refuelled' && refuel.addedLiters).toBeCloseTo(0.011, 9);
  });
  it('is unavailable with missing fuel and discontinuous across the same boundaries', () => {
    expect(fuelStep(sample(0), sample(1))).toEqual({kind: 'unavailable'});
    expect(fuelStep(sample(0, fuel(400)), sample(1, {...fuel(500), truck: missing('not-observed')}))).toEqual({kind: 'discontinuity', cause: 'truck-changed'});
    expect(fuelStep(sample(0, fuel(400)), sample(1, {...fuel(500), gameTime: {minutes: value(1n), clockId: '00000000-0000-4000-8000-0000000000ff'}})))
      .toEqual({kind: 'discontinuity', cause: 'game-clock-rotated'});
  });
});

describe('derived live values', () => {
  it('computes the fuel level only from a valid fuel and a positive capacity', () => {
    expect(fuelLevel(value(410.5), value(1000))).toEqual(value(0.4105));
    expect(fuelLevel(value(0), value(1000))).toEqual(value(0));
    // Requirement changed in fix round 1: a provided zero capacity is an invalid denominator, not an unsupported field.
    expect(fuelLevel(value(410.5), value(0))).toEqual(missing('invalid'));
    expect(fuelLevel(value(0), value(0))).toEqual(missing('invalid'));
    expect(fuelLevel(value(410.5), missing('not-observed'))).toEqual(missing('not-observed'));
    expect(fuelLevel(missing('invalid'), value(1000))).toEqual(missing('invalid'));
    expect(fuelLevel(value(1000.01), value(1000))).toEqual(missing('invalid'));
    const withinTolerance = fuelLevel(value(1000.0005), value(1000));
    expect(withinTolerance.state === 'value' && withinTolerance.value).toBeCloseTo(1.0000005, 12);
  });
  it('computes signed game minutes until the deadline', () => {
    expect(deadlineRemaining(value(13000n), value(12345n))).toEqual(value(655n));
    expect(deadlineRemaining(value(13000n), value(13312n))).toEqual(value(-312n));
    expect(deadlineRemaining(missing('not-carried'), value(12345n))).toEqual(missing('not-carried'));
    expect(deadlineRemaining(value(13000n), missing('not-observed'))).toEqual(missing('not-observed'));
  });
  it('converts the SDK heading to a clockwise compass bearing', () => {
    expect(bearingDegrees(0)).toBe(0);
    expect(bearingDegrees(0.25)).toBe(270);
    expect(bearingDegrees(0.5)).toBe(180);
    expect(bearingDegrees(0.75)).toBe(90);
    expect(bearingDegrees(-0.25)).toBe(90);
    expect(bearingDegrees(1)).toBe(0);
  });
});
