// ET-112c engine 1 distance and fuel corpus (REG-008, REG-009), shared by tests/unit/trip-quantities.test.ts and the
// storage engine tests. Origin: synthetic. Base series S_k: t = k s, odometer 1000 + 20k m, fuel 400 - 0.01k L, x = 20k m,
// game minute 600, speed 20 m/s, truck T1, one member and one game clock. Every expected value is written by hand from
// the engine rules in docs/trips.md; the incident readings come from tests/shared/trip-continuation-incident.ts.
import {INCIDENT_SEGMENTS} from './trip-continuation-incident';

/** One stored reading. A change of `member` is a member junction; a change of `gameClock` inside a member is a boundary. */
export interface QuantityReading {
  member: string; t: number; odometerM: number | null; fuelL: number; x: number; minutes: number; speedMps: number; truck: string; gameClock: string;
  /** The recorder linked this reading to the previous one. */
  linked: boolean;
}
/** A ferry or train event of `member` at `t` seconds. */
export interface QuantityEvent {member: string; t: number; type: 'player.use.ferry' | 'player.use.train'}
export type QuantityFlagName = 'distanceTruck' | 'distanceJump' | 'distanceTransfer' | 'distanceHole' | 'distanceGap' | 'distanceUnproven' | 'distanceBridged'
  | 'distanceRestored' | 'fuelTruck' | 'fuelHole' | 'fuelTransfer' | 'fuelBoundary' | 'fuelUnproven' | 'fuelRefuelExcluded';
export interface QuantityExpectation {
  distanceM: number | null; distance: 'complete' | 'partial' | 'unavailable';
  fuelUsedL: number | null; fuel: 'complete' | 'partial' | 'unavailable';
  /** Exactly the cumulative bits (0-13) of the last point. */
  flags: QuantityFlagName[];
  /** A rollback cut was taken in the trip: storage marks the money totals incomplete. */
  cut: boolean;
}
export interface QuantityScenario {id: string; description: string; readings: QuantityReading[]; events?: QuantityEvent[]; expected: QuantityExpectation}

export const T1 = 'T1', T2 = 'T2', CLOCK_A = 'game-clock-a', CLOCK_B = 'game-clock-b';
/** S_k with overrides. */
export function s(k: number, overrides: Partial<QuantityReading> = {}): QuantityReading {
  return {member: 'A', t: k, odometerM: 1000 + 20 * k, fuelL: 400 - 0.01 * k, x: 20 * k, minutes: 600, speedMps: 20, truck: T1, gameClock: CLOCK_A, linked: true, ...overrides};
}
const base = (count: number) => Array.from({length: count}, (_, k) => s(k));
const none: QuantityFlagName[] = [];

/** Q8: k3 and k4 stopped at 1060 (the save point is k4), driven on to 1100, then a load on a new game clock back to 1060. */
function rollback(load: {member?: string; fuel: [number, number, number]}): QuantityReading[] {
  const member = load.member ?? 'A', t = member === 'A' ? 7 : 0;
  return [s(0), s(1), s(2), s(3, {fuelL: 399.970, speedMps: 0}), s(4, {odometerM: 1060, fuelL: 399.969, x: 60, speedMps: 0}),
    s(5, {odometerM: 1080, fuelL: 399.959, x: 80}), s(6, {odometerM: 1100, fuelL: 399.949, x: 100}),
    s(7, {member, t, odometerM: 1060, fuelL: load.fuel[0], x: 60, speedMps: 0, gameClock: CLOCK_B, linked: false}),
    s(8, {member, t: t + 1, odometerM: 1080, fuelL: load.fuel[1], x: 80, gameClock: CLOCK_B}),
    s(9, {member, t: t + 2, odometerM: 1100, fuelL: load.fuel[2], x: 100, gameClock: CLOCK_B})];
}
/** Q11: A on T1 to 1060 at minute 600, then B on T2 from 50,000 m at `minutes`, driving 40 m. */
function otherTruck(minutes: number): QuantityReading[] {
  return [...base(4), ...[0, 1, 2].map(k => s(k, {member: 'B', odometerM: 50_000 + 20 * k, fuelL: 300 - 0.01 * k, x: 5_000 + 20 * k, minutes, truck: T2, linked: k > 0}))];
}

export const QUANTITY_SCENARIOS: readonly QuantityScenario[] = [
  {id: 'Q1', description: 'a reading without its recorder link (a coalesced snapshot) is an ordinary step', readings: [s(0), s(1), s(2, {linked: false}), s(3)],
    expected: {distanceM: 60, distance: 'complete', fuelUsedL: 0.03, fuel: 'complete', flags: none, cut: false}},
  {id: 'Q2-linked', description: 'an 8 s hole inside one connection bridges distance; fuel carries with the hole bit',
    readings: [...base(3), s(10, {fuelL: 399.90}), s(11, {fuelL: 399.89})],
    expected: {distanceM: 220, distance: 'complete', fuelUsedL: 0.03, fuel: 'partial', flags: ['distanceBridged', 'fuelHole'], cut: false}},
  {id: 'Q2-unlinked', description: 'an 8 s hole without the recorder link breaks distance; both subtotals carry',
    readings: [...base(3), s(10, {fuelL: 399.90, linked: false}), s(11, {fuelL: 399.89})],
    expected: {distanceM: 60, distance: 'partial', fuelUsedL: 0.03, fuel: 'partial', flags: ['distanceHole', 'fuelHole'], cut: false}},
  {id: 'Q3', description: 'a stationary refuel of 200 L counts consumption only',
    readings: [100.00, 99.99, 299.99, 299.98].map((fuelL, k) => s(k, {odometerM: 1000, x: 0, speedMps: 0, fuelL})),
    expected: {distanceM: 0, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: ['fuelRefuelExcluded'], cut: false}},
  {id: 'Q4', description: 'a fuel increase of 4 ml within the noise band is subtracted',
    readings: [400, 399.99, 399.994, 399.984].map((fuelL, k) => s(k, {fuelL})),
    expected: {distanceM: 60, distance: 'complete', fuelUsedL: 0.016, fuel: 'complete', flags: none, cut: false}},
  {id: 'Q5', description: 'a truck change while running keeps both subtotals and breaks both',
    readings: [s(0), s(1), s(2, {truck: T2, odometerM: 50_000, fuelL: 300.00}), s(3, {truck: T2, odometerM: 50_020, fuelL: 299.99})],
    expected: {distanceM: 40, distance: 'partial', fuelUsedL: 0.02, fuel: 'partial', flags: ['distanceTruck', 'fuelTruck'], cut: false}},
  {id: 'Q6', description: 'a ferry crossing with an unchanged odometer adds nothing and keeps both complete',
    readings: [s(0), s(1), s(2, {odometerM: 1020, fuelL: 399.99, x: 90_000, minutes: 900}), s(3, {odometerM: 1040, fuelL: 399.98, x: 90_020, minutes: 900})],
    events: [{member: 'A', t: 1.5, type: 'player.use.ferry'}],
    expected: {distanceM: 40, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: none, cut: false}},
  {id: 'Q6-odometer', description: 'a ferry crossing that moved the odometer breaks distance only',
    readings: [s(0), s(1), s(2, {odometerM: 1500, fuelL: 399.99, x: 90_000, minutes: 900}), s(3, {odometerM: 1520, fuelL: 399.98, x: 90_020, minutes: 900})],
    events: [{member: 'A', t: 1.5, type: 'player.use.ferry'}],
    expected: {distanceM: 40, distance: 'partial', fuelUsedL: 0.02, fuel: 'complete', flags: ['distanceTransfer'], cut: false}},
  // Fuel as in Q6 (k2 unchanged at 399.99, k3 399.98): the hand-written 0.02 L needs the teleported reading to keep its fuel.
  {id: 'Q7', description: 'a road-service teleport with an unchanged odometer adds nothing',
    readings: [s(0), s(1), s(2, {odometerM: 1020, fuelL: 399.99, x: 5_020}), s(3, {odometerM: 1040, fuelL: 399.98, x: 5_040})],
    expected: {distanceM: 40, distance: 'complete', fuelUsedL: 0.02, fuel: 'complete', flags: none, cut: false}},
  {id: 'Q8', description: 'a save load back to 1060 m restores the retained run and the k4 fuel save point',
    readings: rollback({fuel: [399.9692, 399.9592, 399.9492]}),
    expected: {distanceM: 100, distance: 'complete', fuelUsedL: 0.051, fuel: 'complete', flags: ['distanceRestored'], cut: true}},
  {id: 'Q8-member', description: 'the same load as the first reading of the next member searches the whole trip',
    readings: rollback({member: 'B', fuel: [399.9692, 399.9592, 399.9492]}),
    expected: {distanceM: 100, distance: 'complete', fuelUsedL: 0.051, fuel: 'complete', flags: ['distanceRestored'], cut: true}},
  {id: 'Q8-fuel', description: 'a load whose fuel matches no retained save point keeps the newest retained fuel with the boundary bit',
    readings: rollback({fuel: [399.90, 399.89, 399.88]}),
    expected: {distanceM: 100, distance: 'complete', fuelUsedL: 0.051, fuel: 'partial', flags: ['distanceRestored', 'fuelBoundary'], cut: true}},
  {id: 'Q9', description: 'a load before the first retained run makes both unavailable for the rest of the trip',
    readings: [...base(4), s(4, {odometerM: 950, fuelL: 399.5, x: -50, gameClock: CLOCK_B, linked: false}), s(5, {odometerM: 970, fuelL: 399.49, x: -30, gameClock: CLOCK_B})],
    expected: {distanceM: null, distance: 'unavailable', fuelUsedL: null, fuel: 'unavailable', flags: ['distanceUnproven', 'fuelUnproven'], cut: false}},
  // B's own fuel starts at 399.96 (any start: nothing is credited across the junction) and drops 0.01 L per reading.
  {id: 'Q10', description: 'a forward member gap keeps both subtotals and breaks both',
    readings: [...base(4), ...[0, 1, 2].map(k => s(k, {member: 'B', odometerM: 1100 + 20 * k, fuelL: 399.96 - 0.01 * k, x: 100 + 20 * k, linked: k > 0}))],
    expected: {distanceM: 100, distance: 'partial', fuelUsedL: 0.05, fuel: 'partial', flags: ['distanceGap', 'fuelBoundary'], cut: false}},
  {id: 'Q11', description: 'a different truck at a later game minute is a member gap',
    readings: otherTruck(610),
    expected: {distanceM: 100, distance: 'partial', fuelUsedL: 0.05, fuel: 'partial', flags: ['distanceTruck', 'fuelTruck'], cut: false}},
  ...[600, 590].map(minutes => ({id: `Q11-${minutes}`, description: `a different truck at game minute ${minutes} has no known order`, readings: otherTruck(minutes),
    expected: {distanceM: null, distance: 'unavailable' as const, fuelUsedL: null, fuel: 'unavailable' as const, flags: ['distanceUnproven', 'fuelUnproven'] as QuantityFlagName[], cut: false}})),
  {id: 'Q12', description: 'readings without an odometer are holds',
    readings: [s(0), s(1, {odometerM: null}), s(2, {odometerM: null}), s(3)],
    expected: {distanceM: 60, distance: 'complete', fuelUsedL: 0.03, fuel: 'complete', flags: none, cut: false}},
  {id: 'Q13', description: 'an odometer step without movement is a jump',
    readings: [s(0), s(1, {x: 0}), s(2, {odometerM: 1040, x: 20})],
    expected: {distanceM: 20, distance: 'partial', fuelUsedL: 0.02, fuel: 'complete', flags: ['distanceJump'], cut: false}}
];

/** The ET-112 incident: each game process is a member; every reading is linked to the one before it in its process. */
export function incidentReadings(fuelShiftL = 0): QuantityReading[] {
  return INCIDENT_SEGMENTS.flatMap((segment, index) => segment.readings.map((reading, k) => ({member: segment.session, t: reading.atMs / 1000, odometerM: reading.odometerM,
    fuelL: reading.fuelL + (index === 2 ? fuelShiftL : 0), x: reading.x, minutes: reading.gameMinutes, speedMps: reading.speedMps, truck: T1, gameClock: `clock-${index}`, linked: k > 0})));
}
/** 40 m + 40 m + 100 m and 0.02 L + 0.02 L + 0.05 L; both junctions are the same save point (equal minute, 4.5 ml and 2 mm at the second). */
export const INCIDENT_QUANTITIES: QuantityExpectation = {distanceM: 180, distance: 'complete', fuelUsedL: 0.09, fuel: 'complete', flags: none, cut: false};
/** The last process starts 25 ml below the save point: fuel continues with the boundary bit, distance is unchanged. */
export const INCIDENT_25ML_QUANTITIES: QuantityExpectation = {distanceM: 180, distance: 'complete', fuelUsedL: 0.09, fuel: 'partial', flags: ['fuelBoundary'], cut: false};
export const INCIDENT_25ML_SHIFT_L = -0.0205;
