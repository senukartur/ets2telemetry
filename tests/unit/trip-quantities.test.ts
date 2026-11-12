// ET-112c engine 1 distance and fuel (REG-008, REG-009): the pure engine over the hand-written corpus of
// tests/shared/quantity-scenarios.ts, its flags and status, and the run and point bounds of a rollback search.
import {describe, expect, it} from 'vitest';
import {advanceQuantities, completeAnchor, composeOffset, DISTANCE_BREAK_FLAGS, FUEL_BREAK_FLAGS, memoryPath, QUANTITY_ENGINE_VERSION, QUANTITY_FLAGS, QUANTITY_POINT_LIMIT, QUANTITY_RUN_LIMIT,
  quantityStatus, type QuantityAdvance, type QuantityAnchor, type QuantityPoint, type QuantityStep, type MemoryRun} from '../../packages/telemetry-core/src/index';
import {CLOCK_B, INCIDENT_25ML_QUANTITIES, INCIDENT_25ML_SHIFT_L, INCIDENT_QUANTITIES, incidentReadings, QUANTITY_SCENARIOS, s, type QuantityEvent, type QuantityExpectation,
  type QuantityFlagName, type QuantityReading} from '../shared/quantity-scenarios';

const F = QUANTITY_FLAGS;
/** Bits 0-13: everything but the per-row base and link bits. */
const cumulative = (flags: number) => flags & ~(F.base | F.linked);
const bits = (names: readonly QuantityFlagName[]) => names.reduce((sum, name) => sum | F[name], 0);
const anchorOf = (r: QuantityReading): QuantityAnchor => ({pluginSessionId: r.member, sourceClockId: `source-${r.member}`, monotonicNs: String(Math.round(r.t * 1e9)),
  gameClockId: r.gameClock, gameMinutes: String(r.minutes), truck: r.truck, odometerM: r.odometerM, fuelL: r.fuelL, speedMps: r.speedMps, position: {x: r.x, y: 0, z: 0}});
/**
 * The step from the last complete reading `a` to `b`, as storage classifies it: another member, a game clock change or a
 * non-positive time inside the member, or running time with the ferry or train events in (a.t, b.t] and the recorder
 * link, which holds only when `b` was linked to `a` itself.
 */
function stepOf(a: QuantityReading | undefined, b: QuantityReading, before: QuantityReading | undefined, events: readonly QuantityEvent[]): QuantityStep {
  if (!a || a.member !== b.member) return {kind: 'member'};
  if (a.gameClock !== b.gameClock || b.t <= a.t) return {kind: 'boundary'};
  return {kind: 'running', seconds: b.t - a.t, transfer: events.some(e => e.member === b.member && e.t > a.t && e.t <= b.t), linked: b.linked && before === a};
}
function fold(readings: readonly QuantityReading[], events: readonly QuantityEvent[] = []) {
  const path = memoryPath(), advances: QuantityAdvance<MemoryRun>[] = [];
  let last: QuantityReading | undefined;
  readings.forEach((reading, index) => {
    const anchor = anchorOf(reading), advance = advanceQuantities(path.head, anchor, stepOf(last, reading, readings[index - 1], events), path);
    path.record(reading.member, anchor, advance);
    advances.push(advance);
    if (completeAnchor(anchor)) last = reading;
  });
  return {path, advances, point: path.head!};
}
const scenario = (id: string) => QUANTITY_SCENARIOS.find(candidate => candidate.id === id)!;
function expectQuantities(point: QuantityPoint, expected: QuantityExpectation) {
  if (expected.distanceM === null) expect(point.distanceM).toBeNull(); else expect(point.distanceM).toBeCloseTo(expected.distanceM, 9);
  if (expected.fuelUsedL === null) expect(point.fuelUsedL).toBeNull(); else expect(point.fuelUsedL).toBeCloseTo(expected.fuelUsedL, 9);
  expect([quantityStatus(point.distanceM, point.flags, 'distance'), quantityStatus(point.fuelUsedL, point.flags, 'fuel')]).toEqual([expected.distance, expected.fuel]);
  expect(cumulative(point.flags)).toBe(bits(expected.flags));
}

describe('REG-008/009 engine 1 distance and fuel corpus', () => {
  it('is version 1 with sixteen distinct flag bits', () => {
    expect(QUANTITY_ENGINE_VERSION).toBe(1);
    const values = Object.values(F);
    expect(values.sort((a, b) => a - b)).toEqual(Array.from({length: 16}, (_, bit) => 2 ** bit));
  });
  it('persists the frozen engine 1 bit layout by name', () => {
    expect(F).toStrictEqual({distanceTruck: 0x0001, distanceJump: 0x0002, distanceTransfer: 0x0004, distanceHole: 0x0008, distanceGap: 0x0010, distanceUnproven: 0x0020,
      distanceBridged: 0x0040, distanceRestored: 0x0080, fuelTruck: 0x0100, fuelHole: 0x0200, fuelTransfer: 0x0400, fuelBoundary: 0x0800, fuelUnproven: 0x1000,
      fuelRefuelExcluded: 0x2000, base: 0x4000, linked: 0x8000});
    expect(DISTANCE_BREAK_FLAGS).toBe(0x003f);
    expect(FUEL_BREAK_FLAGS).toBe(0x1f00);
  });
  it.each(QUANTITY_SCENARIOS.map(scenario => [scenario.id, scenario] as const))('%s', (_id, scenario) => {
    const {point, advances} = fold(scenario.readings, scenario.events);
    expectQuantities(point, scenario.expected);
    expect(advances.some(advance => advance.cut !== null)).toBe(scenario.expected.cut);
  });
  it('Q1 sets no break bit at any step, so storage writes no annotation', () => {
    expect(fold(QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q1')!.readings).advances.map(advance => advance.added)).toEqual([0, 0, 0, 0]);
  });
  it('reports each newly set break bit once: Q5 adds both truck bits at the change only', () => {
    const {advances} = fold(QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q5')!.readings);
    expect(advances.map(advance => advance.added)).toEqual([0, 0, F.distanceTruck | F.fuelTruck, 0]);
    expect(advances.map(advance => advance.run)).toEqual(['new', 'continue', 'new', 'continue']);
  });
  it('Q8 cuts the current run at 1060 m, takes the closer stopped save point k4 and drops the abandoned suffix', () => {
    const {path, advances} = fold(QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q8')!.readings);
    const load = advances[7];
    expect(load.cut?.odometerM).toBe(1060);
    expect(load.savePoint).toBe(true);
    expect(load.point!.distanceM).toBeCloseTo(60, 9);
    expect(load.point!.fuelUsedL).toBeCloseTo(0.031, 9);
    expect(load.unproven).toBe(false);
    // The new run starts at the load; the restored run now ends at the cut, and nothing newer than it is retained.
    expect(path.runs('trip').map(run => [run.startOdometerM, run.end.anchor.odometerM])).toEqual([[1060, 1100], [1000, 1060]]);
  });
  it('Q6-fuel carries fuel across the crossing with the transfer bit and consumes again after it', () => {
    const {advances} = fold(scenario('Q6-fuel').readings, scenario('Q6-fuel').events);
    expect(advances.map(advance => [advance.run, advance.added])).toEqual([['new', 0], ['continue', 0], ['continue', F.fuelTransfer], ['continue', 0]]);
    expect(advances[2].point!.fuelUsedL).toBeCloseTo(0.01, 9);
  });
  it('Q8-closest keeps the older stop k3 and Q8-tie the newer stop k4 at the load', () => {
    for (const [id, fuelUsedL] of [['Q8-closest', 0.03125], ['Q8-tie', 0.0390625]] as const) {
      const load = fold(scenario(id).readings).advances[7];
      expect([load.cut?.odometerM, load.savePoint], id).toEqual([1060, true]);
      expect(load.point!.distanceM, id).toBeCloseTo(60, 9);
      expect(load.point!.fuelUsedL, id).toBeCloseTo(fuelUsedL, 9);
    }
  });
  it('Q8-running cuts at the regressed reading with k2 as the save point; Q8-running-member finds no run of its own member', () => {
    const running = fold(scenario('Q8-running').readings);
    const back = running.advances[4];
    expect([back.cut?.odometerM, back.savePoint, back.run, back.unproven]).toEqual([1040, true, 'new', false]);
    expect([back.point!.distanceM, back.point!.fuelUsedL]).toEqual([expect.closeTo(40, 9), expect.closeTo(0.02, 9)]);
    expect(running.path.runs('member').map(run => [run.startOdometerM, run.end.anchor.odometerM])).toEqual([[1040, 1060], [1000, 1040]]);
    const member = fold(scenario('Q8-running-member').readings).advances.at(-1)!;
    expect([member.cut, member.unproven]).toEqual([null, true]);
  });
  it('Q2-jump starts a new run at the linked hole that is not continuous', () => {
    const {advances} = fold(scenario('Q2-jump').readings);
    expect(advances.map(advance => [advance.run, advance.added])).toEqual([['new', 0], ['continue', 0], ['continue', 0], ['new', F.distanceHole | F.fuelHole], ['continue', 0]]);
    expect(advances[3].point!.flags & F.linked).toBe(F.linked);
  });
  it('Q9 is unproven at the load and stays unavailable after a later load to a retained point', () => {
    // After Q9: on to 1100 m, then a load back to 1020 m, inside the first retained run; its k1 is the same save point.
    const readings = [...QUANTITY_SCENARIOS.find(scenario => scenario.id === 'Q9')!.readings, s(6, {odometerM: 1100, fuelL: 399.48, x: 100, gameClock: CLOCK_B}),
      s(7, {odometerM: 1020, fuelL: 399.99, x: 20, gameClock: 'game-clock-c', linked: false})];
    const {point, advances} = fold(readings);
    expect(advances.map(advance => advance.unproven)).toEqual([false, false, false, false, true, false, false, false]);
    expect(advances[7].cut?.odometerM).toBe(1020);
    expectQuantities(point, {distanceM: null, distance: 'unavailable', fuelUsedL: null, fuel: 'unavailable', flags: ['distanceRestored', 'distanceUnproven', 'fuelUnproven'], cut: true});
  });
});

describe('REG-008 incident M1, M4 and M14 in pure form', () => {
  // The live joins (M1, M14) and the retroactive join (M4) compose the same members in join order, so the fold is the same.
  it('continues 180 m and 0.09 L across both game restarts, each junction being the same save point', () => {
    const {point, advances} = fold(incidentReadings());
    expectQuantities(point, INCIDENT_QUANTITIES);
    expect([advances[3], advances[6]].map(advance => [advance.savePoint, advance.run, advance.added])).toEqual([[true, 'continue', 0], [true, 'continue', 0]]);
  });
  it('keeps fuel with the boundary bit when the last process starts 25 ml from the save point', () => {
    const {point, advances} = fold(incidentReadings(INCIDENT_25ML_SHIFT_L));
    expectQuantities(point, INCIDENT_25ML_QUANTITIES);
    expect(advances[6].savePoint).toBe(false);
  });
});

describe('REG-008 engine 1 rules', () => {
  const step: QuantityStep = {kind: 'running', seconds: 1, transfer: false, linked: true};
  it('holds an incomplete anchor without a change, and starts at the first complete one with the base bit', () => {
    const path = memoryPath();
    for (const field of ['truck', 'odometerM', 'fuelL', 'speedMps', 'gameMinutes', 'position'] as const) {
      const anchor: QuantityAnchor = {...anchorOf(s(0)), [field]: null};
      expect(completeAnchor(anchor), field).toBe(false);
      expect(advanceQuantities(null, anchor, step, path)).toEqual({point: null, run: 'continue', cut: null, unproven: false, savePoint: null, added: 0});
    }
    expect(completeAnchor({...anchorOf(s(0)), gameClockId: null})).toBe(true);
    const start = advanceQuantities(null, anchorOf(s(0)), step, path);
    expect(start).toMatchObject({point: {distanceM: 0, fuelUsedL: 0, flags: F.base}, run: 'new'});
    expect(advanceQuantities(start.point, {...anchorOf(s(1)), odometerM: null}, step, path).point).toBe(start.point);
  });
  it('accepts one stationary forward minute tick as the same save point at a junction, but not two', () => {
    const end = s(3, {speedMps: 0}), next = (minutes: number) => s(0, {member: 'B', odometerM: 1060, fuelL: 399.97, x: 60, speedMps: 0, minutes, linked: false});
    expect(fold([s(0), s(1), s(2), end, next(601)]).advances[4].savePoint).toBe(true);
    const {point, advances} = fold([s(0), s(1), s(2), end, next(602)]);
    expect(advances[4].savePoint).toBe(false);
    expectQuantities(point, {distanceM: 60, distance: 'complete', fuelUsedL: 0.03, fuel: 'partial', flags: ['fuelBoundary'], cut: false});
  });
  it('an in-member load searches only its own member; a member junction searches the whole trip', () => {
    const driven = [s(0), s(1), s(2), s(3), ...[0, 1, 2].map(k => s(k, {member: 'B', odometerM: 1100 + 20 * k, fuelL: 399.96 - 0.01 * k, x: 100 + 20 * k, linked: k > 0}))];
    const inMember = fold([...driven, s(3, {member: 'B', odometerM: 1040, fuelL: 399.98, x: 40, gameClock: CLOCK_B, linked: false})]);
    expect(inMember.advances.at(-1)!.unproven).toBe(true);
    expectQuantities(inMember.point, {distanceM: null, distance: 'unavailable', fuelUsedL: null, fuel: 'unavailable', flags: ['distanceGap', 'fuelBoundary', 'distanceUnproven', 'fuelUnproven'], cut: false});
    // The next member at 1040 m restores A's run: 40 m, and the moving point k2 is the same save point (0.02 L).
    const nextMember = fold([...driven, s(2, {member: 'C', t: 0, linked: false})]);
    expect(nextMember.advances.at(-1)!.savePoint).toBe(true);
    expectQuantities(nextMember.point, {distanceM: 40, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: ['distanceRestored'], cut: true});
  });
  it('composes a member-local point after its junction point', () => {
    const junction: QuantityPoint = {anchor: anchorOf(s(3)), distanceM: 60, fuelUsedL: 0.25, flags: F.base | F.distanceGap};
    const local: QuantityPoint = {anchor: anchorOf(s(5)), distanceM: 40, fuelUsedL: 0.5, flags: F.fuelHole | F.linked};
    expect(composeOffset(junction, local)).toEqual({anchor: local.anchor, distanceM: 100, fuelUsedL: 0.75, flags: F.distanceGap | F.fuelHole | F.linked});
    expect(composeOffset(junction, {...local, distanceM: null, flags: F.distanceUnproven})).toEqual({anchor: local.anchor, distanceM: null, fuelUsedL: 0.75, flags: F.distanceGap | F.distanceUnproven});
  });
  it('derives the status from the value and the flags only', () => {
    expect(quantityStatus(null, 0, 'distance')).toBe('unavailable');
    expect(quantityStatus(0, F.distanceBridged | F.distanceRestored | F.fuelRefuelExcluded | F.base | F.linked, 'distance')).toBe('complete');
    expect(quantityStatus(0, F.distanceBridged | F.distanceRestored | F.fuelRefuelExcluded | F.base | F.linked, 'fuel')).toBe('complete');
    for (const name of ['distanceTruck', 'distanceJump', 'distanceTransfer', 'distanceHole', 'distanceGap', 'distanceUnproven'] as const) {
      expect([quantityStatus(5, F[name], 'distance'), quantityStatus(5, F[name], 'fuel')], name).toEqual(['partial', 'complete']);
    }
    for (const name of ['fuelTruck', 'fuelHole', 'fuelTransfer', 'fuelBoundary', 'fuelUnproven'] as const) {
      expect([quantityStatus(5, F[name], 'distance'), quantityStatus(5, F[name], 'fuel')], name).toEqual(['complete', 'partial']);
    }
  });
});

describe('REG-008 rollback search bounds', () => {
  /** k0 then `jumps` odometer steps without movement, one new run each, then a stationary load back to 1000 m on a new game clock. */
  function jumpsThenLoad(jumps: number) {
    const readings = [s(0), ...Array.from({length: jumps}, (_, k) => s(k + 1, {x: 0})), s(jumps + 1, {odometerM: 1000, fuelL: 400, x: 0, gameClock: CLOCK_B, linked: false})];
    return fold(readings);
  }
  it(`restores to the oldest of ${QUANTITY_RUN_LIMIT} retained runs and not to a run beyond them`, () => {
    expect(QUANTITY_RUN_LIMIT).toBe(256);
    const within = jumpsThenLoad(QUANTITY_RUN_LIMIT - 1), beyond = jumpsThenLoad(QUANTITY_RUN_LIMIT);
    expect(within.advances.at(-1)!.cut?.odometerM).toBe(1000);
    expectQuantities(within.point, {distanceM: 0, distance: 'complete', fuelUsedL: 0, fuel: 'complete', flags: ['distanceRestored'], cut: true});
    expect(beyond.advances.at(-1)!.unproven).toBe(true);
    expectQuantities(beyond.point, {distanceM: null, distance: 'unavailable', fuelUsedL: null, fuel: 'unavailable', flags: ['distanceJump', 'distanceUnproven', 'fuelUnproven'], cut: false});
  });
  /**
   * k0-k2 driving, then `stops` stationary readings at 1060 m, each 15 ml below the one before (stop 1 at 399.97 L), then
   * 1080 m, then a stationary load back to 1060 m with stop 1's fuel. Only stops 1 and 2 are within 20 ml of the load.
   */
  function stopsThenLoad(stops: number) {
    const readings = [s(0), s(1), s(2), ...Array.from({length: stops}, (_, i) => s(3 + i, {odometerM: 1060, x: 60, speedMps: 0, fuelL: 399.97 - 0.015 * i})),
      s(3 + stops, {odometerM: 1080, x: 80, fuelL: 399.97 - 0.015 * stops}),
      s(4 + stops, {odometerM: 1060, x: 60, speedMps: 0, fuelL: 399.97, gameClock: CLOCK_B, linked: false})];
    return fold(readings);
  }
  it(`compares at most ${QUANTITY_POINT_LIMIT} points of the restored run for the fuel save point`, () => {
    expect(QUANTITY_POINT_LIMIT).toBe(65);
    // 66 stops: the newest 65 are stops 2-66, so stop 2 (fuel used 0.045 L) is the save point.
    const within = stopsThenLoad(66);
    expect(within.advances.at(-1)!.savePoint).toBe(true);
    expectQuantities(within.point, {distanceM: 60, distance: 'complete', fuelUsedL: 0.045, fuel: 'complete', flags: ['distanceRestored'], cut: true});
    // 67 stops: stops 3-67 hold no save point, so the newest stop 67 (fuel used 1.02 L) is kept with the boundary bit.
    const beyond = stopsThenLoad(67);
    const restored = beyond.advances.at(-1)!.cut!.run;
    expect(beyond.path.points(restored, 1060)).toHaveLength(QUANTITY_POINT_LIMIT);
    expect(beyond.advances.at(-1)!.savePoint).toBe(false);
    expectQuantities(beyond.point, {distanceM: 60, distance: 'complete', fuelUsedL: 1.02, fuel: 'partial', flags: ['distanceRestored', 'fuelBoundary'], cut: true});
  });
});
