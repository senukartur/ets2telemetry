// The one-second history sampler (ET-015b, H3–H5, H7, H13, H14): a pure, deterministic choice of which protocol v1
// readings become stored samples, and their storage rows. It has no clock and no timer: the tick is the source second
// of the reading's own capture time, and the only UTC input is the caller's receipt label. The storage row type is
// imported as a type only from packages/storage/src/api.ts (T2); see docs/trips.md.
import type {Available, CurrentState, ServerMessage, Uint64} from '../../contracts/src/protocol-v1';
import type {SampleInput} from '../../storage/src/api';
import type {TripGame} from './trips/types';
import type {TripView} from './trips/view';

/** A message that carries a reading of current state: a connection's checkpoint or a snapshot. */
export type ReadingMessage = Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
/**
 * The sampler's memory of one game: the plugin session and capture clock of its last reading, that reading's
 * `boundaryOrder`, and the last sampled source second on that clock (null before the first sample on it).
 */
export interface SamplerSlot {pluginSessionId: string; clockId: string; boundaryOrder: Uint64; second: string | null}
export interface SamplerState {games: Record<TripGame, SamplerSlot | null>}
/**
 * What the sampler did with one reading:
 * - `baseline`: the first reading of a plugin session (or a new plugin session of the game); remembered, never sampled;
 * - `stale`: its `boundaryOrder` is not above the session's previous reading; nothing changes;
 * - `not-running`: fresh, but the simulation is paused or unavailable; the boundary advances, no row;
 * - `out-of-range`: fresh and running, but the capture time is above 2^63−1 ns, which storage refuses;
 * - `same-second`: fresh and running, but its source second was already sampled on this clock;
 * - `sampled`: the first qualifying reading of a new source second; `row` is its sample.
 */
export type SampleDecision = 'baseline' | 'stale' | 'not-running' | 'out-of-range' | 'same-second' | 'sampled';
export interface SampleReadingInput {
  message: ReadingMessage;
  /** The consumer's UTC label taken when the reading was decoded (H13); used only when the reading has no usable label. */
  receivedUtcMs: number;
  /** The trip view of the reading's game from committed trip state, read right before sampling (R17, H7). */
  view: TripView;
}
export interface SampleReadingResult {state: SamplerState; decision: SampleDecision; row: SampleInput | null}

const NS_PER_SECOND = 1_000_000_000n;
/** Storage keeps sample monotonic time in a signed 64-bit INTEGER column and refuses larger values. */
const MAX_SAMPLE_NS = 9_223_372_036_854_775_807n;

/** No game has a remembered reading. */
export function initialSamplerState(): SamplerState {
  return {games: {ets2: null, ats: null}};
}

/** Copies an availability object without its wire `unit`: storage accepts exactly `{available, value}` or `{available, reason}`. */
function plain<T>(input: Available<T>): Available<T> {
  return input.available ? {available: true, value: input.value} : {available: false, reason: input.reason};
}
/** The UTC label of a sample: the reading's own label when it is a safe integer, otherwise the receipt label. */
function sampleUtc(state: CurrentState, receivedUtcMs: number): number {
  const label = state.captureUtcUnixMs;
  if (!label.available) return receivedUtcMs;
  const ms = Number(label.value);
  return Number.isSafeInteger(ms) ? ms : receivedUtcMs;
}
/** H7: only a committed, active trip owns a sample; idle, awaiting the outcome, a reload check and an untracked job do not. */
function sampleTrip(view: TripView): string | null {
  return view.phase === 'active' && !view.untrackedJob && view.current !== null ? view.current.tripUuid : null;
}
/** H14: the storage row of one reading, in the wire's canonical units, copied unchanged. */
function sampleRow(message: ReadingMessage, receivedUtcMs: number, view: TripView): SampleInput {
  const state = message.data.state, game = state.gameTime, place = state.worldPlacement;
  return {
    tripUuid: sampleTrip(view), utcMs: sampleUtc(state, receivedUtcMs), sourceClockId: message.capture.clockId, monotonicNs: message.capture.monotonicNs,
    gameTime: {minutes: game.available ? {available: true, value: Number(game.value)} : {available: false, reason: game.reason}, clockId: game.clockId},
    speed: plain(state.speed), fuel: plain(state.fuel), averageConsumption: plain(state.averageConsumption), estimatedRange: plain(state.estimatedRange),
    engineRpm: plain(state.engineRpm), gear: plain(state.gear), odometer: plain(state.odometer),
    position: place.available ? {available: true, value: {x: place.value.position.x, y: place.value.position.y, z: place.value.position.z}} : {available: false, reason: place.reason}
  };
}

/**
 * Decides whether one checkpoint or snapshot becomes a one-second sample (H3, H4, H5). The tick is the absolute
 * source second `floor(capture.monotonicNs / 1e9)` per plugin session and capture clock, and the first qualifying
 * reading of each second is sampled. A reading qualifies only when its `boundaryOrder` is strictly above the previous
 * reading of the same plugin session (across connections), the simulation is running, its second is above the last
 * sampled second on its clock and its capture time fits storage. The first reading of a plugin session is a baseline,
 * so a restart checkpoint carrying an old slot never becomes a row; the baseline's second can still be sampled by the
 * next fresh reading. Paused and unavailable readings advance the boundary but add no row, and missed seconds are
 * never filled. Game time and UTC never set the cadence. The input state is never mutated.
 */
export function sampleReading(state: SamplerState, input: SampleReadingInput): SampleReadingResult {
  const {message, receivedUtcMs, view} = input;
  const source = message.source, capture = message.capture, reading = message.data.state;
  const slot = state.games[source.game];
  const withSlot = (next: SamplerSlot): SamplerState => ({games: {...state.games, [source.game]: next}});
  if (slot === null || slot.pluginSessionId !== source.pluginSessionId) {
    return {state: withSlot({pluginSessionId: source.pluginSessionId, clockId: capture.clockId, boundaryOrder: reading.boundaryOrder, second: null}), decision: 'baseline', row: null};
  }
  if (BigInt(reading.boundaryOrder) <= BigInt(slot.boundaryOrder)) return {state, decision: 'stale', row: null};
  // A fresh reading always advances the boundary. A new capture clock starts with no sampled second.
  const fresh: SamplerSlot = {...slot, clockId: capture.clockId, boundaryOrder: reading.boundaryOrder, second: capture.clockId === slot.clockId ? slot.second : null};
  if (reading.simulation !== 'running') return {state: withSlot(fresh), decision: 'not-running', row: null};
  const ns = BigInt(capture.monotonicNs);
  if (ns > MAX_SAMPLE_NS) return {state: withSlot(fresh), decision: 'out-of-range', row: null};
  const second = ns / NS_PER_SECOND;
  if (fresh.second !== null && second <= BigInt(fresh.second)) return {state: withSlot(fresh), decision: 'same-second', row: null};
  return {state: withSlot({...fresh, second: second.toString()}), decision: 'sampled', row: sampleRow(message, receivedUtcMs, view)};
}
