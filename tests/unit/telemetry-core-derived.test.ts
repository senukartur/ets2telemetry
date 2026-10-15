// REG-008 step primitives and derived live values. Scenarios are built by hand from the shared v0 and v1 snapshot
// fixtures; each expected classification follows the rules in docs/live-telemetry-fields.md.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {
  bearingDegrees, deadlineRemaining, fuelLevel, fuelStep, normalizeV0State, normalizeV1State, odometerStep, type NormalizedLiveState,
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

const SECOND = 1_000_000_000n;
function sample(seconds: number, patch: Partial<NormalizedLiveState> = {}, from: 'v0' | 'v1' = 'v0'): StepSample {
  const base = from === 'v0' ? normalizeV0State(v0Snapshot.data.state) : normalizeV1State(v1Snapshot.data.state, v1Snapshot.data.status);
  const message = from === 'v0' ? v0Snapshot : v1Snapshot;
  return {
    source: {...message.source}, capture: {clockId: message.capture.clockId, monotonicNs: (1_000n * SECOND + BigInt(seconds) * SECOND).toString()},
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
  it('treats changes within 0.01 L as unchanged noise', () => {
    expect(fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.509)))).toEqual({kind: 'unchanged'});
    expect(fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.491)))).toEqual({kind: 'unchanged'});
    expect(fuelStep(sample(0, fuel(410.5)), sample(1, fuel(410.5)))).toEqual({kind: 'unchanged'});
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
    expect(fuelLevel(value(410.5), value(0))).toEqual(missing('not-supported'));
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
