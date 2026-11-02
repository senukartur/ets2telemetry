// ET-051 (REG-009): the display-only hold of the SDK average consumption through the zeros the games send.
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {initialLive} from '../../apps/desktop/src/live-state';
import {CONSUMPTION_HOLD_NS, ConsumptionHold} from '../../packages/telemetry-core/src/consumption-hold';

const SESSION = '11111111-1111-4111-8111-111111111111', OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const CLOCK = '33333333-3333-4333-8333-333333333333', OTHER_CLOCK = '44444444-4444-4444-8444-444444444444';
type Consumption = LiveTelemetry['observation'] extends infer O ? O extends {state: {averageConsumption: infer C}} ? C : never : never;
/** One live update at `ms` of capture time with the given SDK mean in L/100 km, or unavailable. */
function update(ms: number, value: number | 'unavailable', sessionId = SESSION, clockId = CLOCK): LiveTelemetry {
  const base = initialLive('synthetic');
  const averageConsumption: Consumption = value === 'unavailable' ? {available: false, reason: 'not-observed', unit: 'L/100km'} : {available: true, value, unit: 'L/100km'};
  return {...base, status: 'connected', fresh: true, observation: {
    source: {game: 'ets2', pluginSessionId: sessionId, processInstanceId: SESSION, processId: 1, windowsSessionId: 1, origin: 'synthetic'},
    state: {averageConsumption} as NonNullable<LiveTelemetry['observation']>['state'],
    seq: String(ms), capture: {clockId, monotonicNs: (BigInt(ms) * 1_000_000n).toString()},
    receivedMonotonicMs: ms, windowReceivedMonotonicMs: ms, windowFresh: false, applied: {} as NonNullable<LiveTelemetry['observation']>['applied']
  }};
}
/** The displayed values for a sequence of updates applied to one hold. */
function shown(hold: ConsumptionHold, updates: LiveTelemetry[]): (number | 'unavailable')[] {
  return updates.map(u => {const c = hold.apply(u).observation!.state.averageConsumption; return c.available ? c.value : 'unavailable';});
}

describe('SDK average consumption hold', () => {
  it('shows the last non-zero value through a single zero and through two- and ten-second runs', () => {
    expect(CONSUMPTION_HOLD_NS).toBe(10_000_000_000n);
    expect(shown(new ConsumptionHold(), [update(0, 34.66), update(250, 0), update(500, 34.67)])).toEqual([34.66, 34.66, 34.67]);
    expect(shown(new ConsumptionHold(), [update(0, 40), update(1000, 0), update(2000, 0), update(2100, 41)])).toEqual([40, 40, 40, 41]);
    // Exactly 10 s after the last non-zero reading is still held; any later zero shows as sent.
    expect(shown(new ConsumptionHold(), [update(0, 40), update(5000, 0), update(10_000, 0), update(10_001, 0), update(15_000, 0)])).toEqual([40, 40, 40, 0, 0]);
  });
  it('measures the hold from the last non-zero reading, not from the start of the run', () => {
    expect(shown(new ConsumptionHold(), [update(0, 30), update(8000, 31), update(9000, 0), update(17_000, 0), update(18_500, 0)])).toEqual([30, 31, 31, 31, 0]);
  });
  it('keeps a zero without an earlier non-zero value, such as at a standstill after the session starts', () => {
    expect(shown(new ConsumptionHold(), [update(0, 0), update(1000, 0), update(2000, 25)])).toEqual([0, 0, 25]);
  });
  it('keeps unavailable distinct from zero and ends the hold at an unavailable reading', () => {
    expect(shown(new ConsumptionHold(), [update(0, 40), update(100, 'unavailable'), update(200, 0)])).toEqual([40, 'unavailable', 0]);
  });
  it('never carries a value into another plugin session or capture clock', () => {
    expect(shown(new ConsumptionHold(), [update(0, 40), update(100, 0, OTHER_SESSION)])).toEqual([40, 0]);
    expect(shown(new ConsumptionHold(), [update(0, 40), update(100, 0, SESSION, OTHER_CLOCK)])).toEqual([40, 0]);
    // A capture that goes backwards is not bridged either.
    expect(shown(new ConsumptionHold(), [update(1000, 40), update(500, 0)])).toEqual([40, 0]);
  });
  it('holds through a negative zero and leaves the input update unchanged', () => {
    const hold = new ConsumptionHold(); hold.apply(update(0, 40));
    const zero = update(100, -0), result = hold.apply(zero);
    expect(result.observation!.state.averageConsumption).toEqual({available: true, value: 40, unit: 'L/100km'});
    expect(Object.is(zero.observation!.state.averageConsumption.available && zero.observation!.state.averageConsumption.value, -0)).toBe(true);
    expect(result.observation!.capture).toBe(zero.observation!.capture);
  });
  it('passes an update without an observation through', () => {
    const live = initialLive('game');
    expect(new ConsumptionHold().apply(live)).toBe(live);
  });
});
