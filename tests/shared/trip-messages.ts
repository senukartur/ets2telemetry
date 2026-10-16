// Synthetic protocol v1 message scripts for the ET-014 trip reducer tests, shared by the Node-safe unit tests and the
// Electron-runtime storage test. Every message is built from the hand-written shared fixtures in
// tests/fixtures/protocol-v1 (origin `synthetic`) and validated by the contract validator. No capture bytes are used.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {
  validateServerMessage, type CurrentState, type EventRecord, type GameMode, type JobConfiguration, type LossCounts, type Money, type ServerMessage, type TrailerConfiguration,
  type TruckConfiguration
} from '../../packages/contracts/src/protocol-v1';
import {stepTrip, type CheckpointMessage, type EventMessage, type GapMessage, type TripEffect, type TripInput, type TripSeed, type TripState, type WelcomeMessage} from '../../packages/telemetry-core/src/index';

const FIXTURES = path.resolve('tests/fixtures/protocol-v1');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')) as T;
type Of<K extends ServerMessage['kind']> = Extract<ServerMessage, {kind: K}>;
/** The fields of a fixture event's record without its `type`. */
const recordFields = <T>(name: string): T => Object.fromEntries(Object.entries(fixture<Of<'event'>>(name).data.record).filter(([key]) => key !== 'type')) as T;

export const ETS2_A = '10000000-0000-4000-8000-0000000000a1';
export const ETS2_B = '10000000-0000-4000-8000-0000000000b2';
export const ATS_A = '10000000-0000-4000-8000-0000000000c3';
/** 2026-10-12T00:00:00Z, the shared fixtures' UTC label. */
export const BASE_UTC = 1_791_676_800_000;
export const RECEIVED_UTC = BASE_UTC + 999_000_000;
export const GAME_CLOCK_1 = '40000000-0000-4000-8000-000000000001';
export const GAME_CLOCK_2 = '40000000-0000-4000-8000-000000000002';

/** The fixture job (freight market, cargo loaded) with field overrides; values stay valid protocol v1 fields. */
export function job(overrides: Partial<JobConfiguration> = {}): JobConfiguration {
  const base = recordFields<JobConfiguration>('event-job-configured');
  return {...base, ...overrides};
}
export const cargoMarketJob = (loaded: boolean) => job({market: {available: true, value: 'cargo_market'}, cargoLoaded: {available: true, value: loaded}});
export const otherJob = (cargoId = 'synthetic_other_cargo') => job({cargoId: {available: true, value: cargoId}, expectedIncome: {available: true, value: {raw: '9000', sdkType: 'u64', currency: {status: 'unknown'}}}});
export function truck(overrides: Partial<TruckConfiguration> = {}): TruckConfiguration {
  const base = recordFields<TruckConfiguration>('event-truck-configured');
  return {...base, ...overrides};
}
export function trailer(index = 0, overrides: Partial<TrailerConfiguration> = {}): TrailerConfiguration {
  const base = recordFields<TrailerConfiguration>('event-trailer-configured');
  return {...base, index, ...overrides};
}
const EUR = {status: 'sdk-documented', code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'} as const;
export const money = (raw: string, sdkType: Money['sdkType'] = 's64', currency: Money['currency'] = EUR) => ({available: true as const, value: {raw, sdkType, currency}});
const transfer = (amount: string) => ({amount: money(amount), sourceId: {available: true as const, value: 'synthetic_port_a'}, sourceName: {available: true as const, value: 'Synthetic Port A'},
  targetId: {available: true as const, value: 'synthetic_port_b'}, targetName: {available: true as const, value: 'Synthetic Port B'}});

/** Record constructors, one per protocol v1 record type the reducer reads. */
export const r = {
  jobConfigured: (j: JobConfiguration = job()): EventRecord => ({type: 'job.configured', ...j}),
  jobCleared: (): EventRecord => ({type: 'job.cleared'}),
  truckConfigured: (t: TruckConfiguration = truck()): EventRecord => ({type: 'truck.configured', ...t}),
  truckCleared: (): EventRecord => ({type: 'truck.cleared'}),
  trailerConfigured: (t: TrailerConfiguration = trailer()): EventRecord => ({type: 'trailer.configured', ...t}),
  trailerCleared: (index = 0): EventRecord => ({type: 'trailer.cleared', index}),
  paused: (): EventRecord => ({type: 'simulation.paused'}),
  started: (): EventRecord => ({type: 'simulation.started'}),
  timersRestart: (): EventRecord => ({type: 'timers.restart'}),
  regression: (fromMinutes: string, toMinutes: string, fromClock = GAME_CLOCK_1, toClock = GAME_CLOCK_2): EventRecord => ({type: 'gameTime.regression',
    from: {minutes: {available: true, value: fromMinutes}, clockId: fromClock}, to: {minutes: {available: true, value: toMinutes}, clockId: toClock}}),
  delivered: (revenue = '15000'): EventRecord => {
    const base = fixture<Of<'event'>>('event-job-delivered').data.record as Extract<EventRecord, {type: 'job.delivered'}>;
    return {...base, revenue: money(revenue)};
  },
  cancelled: (penalty = '12000'): EventRecord => ({type: 'job.cancelled', penalty: money(penalty)}),
  fined: (amount = '400', offence = 'crash'): EventRecord => ({type: 'player.fined', offence: {available: true, value: offence}, amount: money(amount)}),
  toll: (amount = '35'): EventRecord => ({type: 'player.tollgate.paid', amount: money(amount)}),
  ferry: (amount = '677'): EventRecord => ({type: 'player.use.ferry', ...transfer(amount)}),
  train: (amount = '250'): EventRecord => ({type: 'player.use.train', ...transfer(amount)}),
  gameMode: (mode: Pick<GameMode, 'mode' | 'method' | 'confidence'> & {module?: string}): EventRecord => ({type: 'source.gameMode', mode: mode.mode, method: mode.method,
    confidence: mode.confidence, module: mode.module === undefined ? {available: false, reason: 'not-observed'} : {available: true, value: mode.module}})
};

export interface EventOptions {
  simulation?: 'running' | 'paused' | 'unavailable';
  /** The UTC label in milliseconds; null makes occurred.utcUnixMs unavailable. Defaults to the script clock. */
  utcMs?: number | null;
  /** Real milliseconds since the previous item of this script; default 1,000. */
  advanceMs?: number;
}

/**
 * One plugin session's message stream. eventSeq values are assigned in order, message `seq` keeps increasing, and the
 * source monotonic clock and UTC label advance by `advanceMs` per item. Game time stays on its clock until a
 * regression rotates it, as the adapter does.
 */
export class Script {
  next = 1n;
  private seq = 2n;
  private ns = 1_000_000_000_000n;
  private utc: number;
  private gameClock = GAME_CLOCK_1;
  private minutes = '12345';
  private acked = '0';
  readonly clockId: string;
  /** `utcMs` is the label before the first item; each session of a test gets its own source clock. */
  constructor(readonly session: string, readonly game: 'ets2' | 'ats' = 'ets2', options: {utcMs?: number; clockId?: string} = {}) {
    this.utc = options.utcMs ?? BASE_UTC;
    this.clockId = options.clockId ?? `30000000${session.slice(8)}`;
  }
  /** The game time the next event carries, so a generated regression can go back from it. */
  get gameTime() { return {minutes: this.minutes, clockId: this.gameClock}; }
  private get source() {
    return {game: this.game, pluginSessionId: this.session, processInstanceId: `20000000${this.session.slice(8)}`, processId: 4242, windowsSessionId: 1, origin: 'synthetic' as const};
  }
  private envelope<K extends ServerMessage['kind']>(kind: K, data: Of<K>['data']): Of<K> {
    return validateServerMessage({version: {major: 1, minor: 0}, kind, source: this.source, seq: (this.seq++).toString(), capture: {clockId: this.clockId, monotonicNs: this.ns.toString()}, data}) as Of<K>;
  }
  private advance(ms: number) { this.ns += BigInt(ms) * 1_000_000n; this.utc += ms; }
  welcome(gameMode: GameMode = {mode: 'unknown', method: 'none', confidence: 'none', module: {available: false, reason: 'not-observed'}}): WelcomeMessage {
    const data = fixture<Of<'welcome'>>('welcome').data;
    return this.envelope('welcome', {...data, gameMode});
  }
  /**
   * A checkpoint at the script's current point: `nextEventSeq` is the next eventSeq. With `retained` > 0 the last
   * `retained` events already built are unacknowledged and retained, so a consumer receives them after the checkpoint
   * as replayed events (protocol v1 §7, §9).
   */
  checkpoint(checkpointJob: JobConfiguration | null, retained = 0, state: Partial<CurrentState> = {}): CheckpointMessage {
    const data = structuredClone(fixture<Of<'checkpoint'>>('checkpoint').data);
    data.boundarySeq = this.seq.toString();
    data.state.configuration.job = checkpointJob === null ? {available: false, reason: 'not-observed'} : {available: true, value: checkpointJob};
    data.state = {...data.state, ...state};
    this.acked = (this.next - 1n - BigInt(retained)).toString();
    data.status.delivery = {...data.status.delivery, ackedThroughEventSeq: this.acked, nextEventSeq: this.next.toString(),
      retainedEvents: retained, retainedBytes: retained * 1_024,
      oldestRetainedMonotonicNs: retained > 0 ? {available: true, value: (this.ns - 1_000_000n).toString()} : {available: false, reason: 'not-observed'}};
    return this.envelope('checkpoint', data);
  }
  /**
   * A snapshot after `advanceMs` (ET-015a): the shared snapshot fixture's state with the script's UTC label, an increasing
   * boundary order and the given state fields, and the delivery status of the connection's checkpoint (its
   * `ackedThroughEventSeq`, the script's next eventSeq).
   */
  snapshot(state: Partial<CurrentState> = {}, advanceMs = 1_000): Extract<ServerMessage, {kind: 'snapshot'}> {
    this.advance(advanceMs);
    const data = structuredClone(fixture<Of<'snapshot'>>('snapshot').data);
    data.state = {...data.state, captureUtcUnixMs: {available: true, value: this.utc.toString()}, boundaryOrder: (100n + this.seq).toString(), ...state};
    data.status.delivery = {...data.status.delivery, ackedThroughEventSeq: this.acked, nextEventSeq: this.next.toString(), retainedEvents: 0, retainedBytes: 0,
      oldestRetainedMonotonicNs: {available: false, reason: 'not-observed'}};
    data.continuity = {coalescedSnapshots: '0', offlineTransitions: '0'};
    return this.envelope('snapshot', data);
  }
  /** The producer's redelivery of an event already built (ET-015a): the same data marked `redelivered`, in a new envelope. */
  redeliver(m: EventMessage): EventMessage {
    return this.envelope('event', {...structuredClone(m.data), redelivered: true});
  }
  event(record: EventRecord, options: EventOptions = {}): EventMessage {
    this.advance(options.advanceMs ?? 1_000);
    if (record.type === 'gameTime.regression') { this.gameClock = record.to.clockId; this.minutes = record.to.minutes.available ? record.to.minutes.value : this.minutes; }
    const utc = options.utcMs === undefined ? this.utc : options.utcMs;
    return this.envelope('event', {eventSeq: (this.next++).toString(), redelivered: false, record, occurred: {
      monotonicNs: {available: true, value: (this.ns - 1_000_000n).toString()}, gameTime: {minutes: {available: true, value: this.minutes}, clockId: this.gameClock},
      utcUnixMs: utc === null ? {available: false, reason: 'not-observed'} : {available: true, value: utc.toString()},
      simulation: options.simulation ?? 'running', configurationRevision: '1', boundaryOrder: this.next.toString()
    }});
  }
  /** A gap of `count` eventSeq values from the next one; all of them have `cause` unless `causes` splits them. */
  gap(count: number, cause: keyof LossCounts = 'queueCount', advanceMs = 1_000): GapMessage {
    const first = this.next, last = first + BigInt(count) - 1n;
    this.next = last + 1n;
    return this.gapRange(first, last, {[cause]: BigInt(count).toString()}, advanceMs);
  }
  /** A gap record over an explicit range, such as a merged record redelivered after an ACK inside it. */
  gapRange(first: bigint, last: bigint, causes: Partial<LossCounts>, advanceMs = 1_000): GapMessage {
    this.advance(advanceMs);
    const lost = {available: true as const, value: (this.ns - 2_000_000n).toString()};
    return this.envelope('gap', {firstEventSeq: first.toString(), lastEventSeq: last.toString(), redelivered: false,
      causes: {offline: '0', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0', ...causes},
      firstLostMonotonicNs: {...lost, value: (this.ns - 3_000_000n).toString()}, lastLostMonotonicNs: lost});
  }
}

/** A reducer input for a commit carrier; the coverage is the reducer's own processed point, as a T3 caller's would be. */
export function carrier(state: TripState, message: EventMessage | GapMessage, receivedUtcMs = RECEIVED_UTC): TripInput {
  const coveredThrough = Object.hasOwn(state.sessions, message.source.pluginSessionId) ? state.sessions[message.source.pluginSessionId].processedThrough : '0';
  return message.kind === 'event' ? {kind: 'event', message, coveredThrough, receivedUtcMs} : {kind: 'gap', message, coveredThrough, receivedUtcMs};
}
export const sessionInput = (welcome: WelcomeMessage, coveredThrough = '0', openTrips: TripSeed[] = []): TripInput => ({kind: 'session', welcome, coveredThrough, openTrips});
export type Step = EventMessage | GapMessage | TripInput;
/** Feeds steps in order, adopting every result; returns the final state and the effects of each step. Throws on an error result. */
export function run(state: TripState, steps: Step[]): {state: TripState; effects: TripEffect[][]} {
  const effects: TripEffect[][] = [];
  for (const step of steps) {
    const input = 'version' in step ? carrier(state, step) : step;
    const result = stepTrip(state, input);
    if (!result.ok) throw new Error(`Unexpected ${result.code} at step ${effects.length}`);
    state = result.state; effects.push(result.effects);
  }
  return {state, effects};
}
