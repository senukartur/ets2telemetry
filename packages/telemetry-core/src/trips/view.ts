// A read-only view of one game's trip state for later journal and dashboard code (ET-014). Money stays exact raw
// digits summed per currency and SDK type, never converted and never netted into one value; expected income is not
// revenue, and planned distance is not observed or delivered distance (concept.md §7).
import type {Available, Money} from '../../../contracts/src/protocol-v1';
import {moneyReading} from '../normalize-v1';
import {fromAvailable, mapReading, missing, valueOf, type Distance, type MoneyCurrency, type MoneyKind, type MoneyValue, type Reading} from '../readings';
import {fuelUsedL} from './accounting';
import type {ClosedTrip, GameModeEvidence, MoneyTotals, OpenTrip, RecordingCompleteness, TripGame, TripPhase, TripState} from './types';

/** One exact total per currency and SDK type; `unavailable` counts amounts the game did not provide. */
export interface MoneySummary<K extends MoneyKind = MoneyKind> {totals: {kind: K; currency: MoneyCurrency; sdkType: Money['sdkType']; raw: string; count: number}[]; unavailable: number}
export interface TripSummaryView {
  tripUuid: string; recordingCompleteness: RecordingCompleteness; gameMode: GameModeEvidence; gameModeAmbiguous: boolean; startedUtcMs: number;
  /** Real nanoseconds since the trip opened, within one source clock; null across clocks or without monotonic time. */
  realDurationNs: string | null;
  cargoLoaded: Reading<boolean>;
  plannedDistance: Reading<Distance<'planned'>>; expectedIncome: Reading<MoneyValue<'expected-income'>>;
  /** Fines while the cargo of a cargo-market job was not loaded yet are kept apart (T14). */
  fines: MoneySummary<'fine'>; finesBeforeLoaded: MoneySummary<'fine'>; tolls: MoneySummary<'toll'>; transfers: MoneySummary<'transfer'>;
  /** Metres from continuous odometer steps while active (T16); `not-observed` before the first step. Not planned or delivered distance. */
  observedDistanceM: Reading<number>;
  /**
   * Litres consumed minus small increases over continuous fuel steps while active (T16); `not-observed` before the first
   * step. Refuels are excluded and reported apart. Not stored yet (S-1), and never the SDK's average consumption.
   */
  fuelUsedL: Reading<number>;
  /** Litres added by refuels while active, and the number of refuel episodes. */
  refuelledL: number; refuels: number;
}
export interface ClosedTripView extends TripSummaryView {
  outcome: ClosedTrip['outcome']; closeReason: ClosedTrip['closeReason']; endedUtcMs: number;
  revenue: Reading<MoneyValue<'revenue'>>; penalty: Reading<MoneyValue<'penalty'>>; deliveredDistance: Reading<Distance<'game-delivered'>>;
}
export interface TripView {
  game: TripGame;
  phase: 'idle' | TripPhase;
  /** A job is known or likely active but no trip tracks it: a checkpoint job seen while idle (T9), or the job of a trip a gap closed. */
  untrackedJob: boolean;
  current: TripSummaryView | null;
  lastClosed: ClosedTripView | null;
}

const NOT_OBSERVED = missing<never>('not-observed');
const optional = <T>(input: Available<T> | null): Reading<T> => input === null ? NOT_OBSERVED : fromAvailable(input);
function summary<K extends MoneyKind>(kind: K, totals: MoneyTotals): MoneySummary<K> {
  return {
    totals: totals.byCurrency.map(t => ({
      kind, sdkType: t.sdkType, raw: t.total, count: t.count,
      currency: t.currency.status === 'sdk-documented' ? {basis: 'sdk-documented', code: t.currency.code, source: t.currency.source} : {basis: 'unknown'}
    })),
    unavailable: totals.unavailable
  };
}
function duration(start: string | null, end: string | null): string | null {
  if (start === null || end === null) return null;
  const ns = BigInt(end) - BigInt(start);
  return ns < 0n ? null : ns.toString();
}
function tripSummary(trip: OpenTrip | ClosedTrip, endNs: string | null): TripSummaryView {
  const used = fuelUsedL(trip.accounting);
  return {
    tripUuid: trip.tripUuid, recordingCompleteness: trip.completeness, gameMode: {...trip.gameMode}, gameModeAmbiguous: trip.gameModeAmbiguous,
    startedUtcMs: trip.startedUtcMs, realDurationNs: duration(trip.startedMonotonicNs, endNs), cargoLoaded: optional(trip.cargoLoaded),
    plannedDistance: mapReading(optional(trip.plannedDistance), meters => ({kind: 'planned' as const, meters})),
    expectedIncome: trip.expectedIncome === null ? NOT_OBSERVED : moneyReading('expected-income', trip.expectedIncome),
    fines: summary('fine', trip.fines), finesBeforeLoaded: summary('fine', trip.finesBeforeLoaded), tolls: summary('toll', trip.tolls), transfers: summary('transfer', trip.transfers),
    observedDistanceM: trip.accounting.observedDistanceM === null ? NOT_OBSERVED : valueOf(trip.accounting.observedDistanceM),
    fuelUsedL: used === null ? NOT_OBSERVED : valueOf(used), refuelledL: trip.accounting.refuelledL, refuels: trip.accounting.refuels
  };
}

/** The view of one game: its phase, the open trip if any and the last closed trip, read from reducer state only. */
export function tripView(state: TripState, game: TripGame): TripView {
  const slot = state.games[game], trip = slot.trip;
  const session = slot.sessionId !== null && Object.hasOwn(state.sessions, slot.sessionId) ? state.sessions[slot.sessionId] : null;
  const closed = slot.lastClosed;
  return {
    game, phase: trip?.phase ?? 'idle', untrackedJob: trip === null && session !== null && session.untrackedJob !== null,
    current: trip === null ? null
      : tripSummary(trip, session !== null && trip.clockId !== null && trip.clockId === session.clockId ? session.lastMonotonicNs : null),
    lastClosed: closed === null ? null : {
      ...tripSummary(closed, closed.endedMonotonicNs), outcome: closed.outcome, closeReason: closed.closeReason, endedUtcMs: closed.endedUtcMs,
      revenue: closed.revenue === null ? NOT_OBSERVED : moneyReading('revenue', closed.revenue),
      penalty: closed.penalty === null ? NOT_OBSERVED : moneyReading('penalty', closed.penalty),
      deliveredDistance: mapReading(optional(closed.deliveredDistance), meters => ({kind: 'game-delivered' as const, meters}))
    }
  };
}
