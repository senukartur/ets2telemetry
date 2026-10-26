// Live inputs for the ET-010c tests, built from the shared protocol fixtures. They are inputs only: every expected
// display text in the tests is written by hand. The v1 projection here is assembled field by field from the fixture
// message, independently of apps/desktop/src/live-v1.ts.
import {readFileSync} from 'node:fs';
import type {LiveTelemetry, LiveTelemetryV1, SourceSelection} from '../../packages/contracts/src';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {decodePayload, type GearboxState, type LiveStateV1, type Measure, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';

export type V0State = Extract<v0.ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
export type V1State = Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
export function v0Message(name: string): V0State {
  const message = v0.decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v0/${name}.json`)));
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a v0 state message`);
  return message;
}
export function v1Message(name: string): V1State {
  const message = decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v1/${name}.json`)), 'server');
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a v1 state message`);
  return message;
}
/** A current v0 update of a fixture; `origin` replaces the fixture's synthetic origin. */
export function v0Live(name: string, selection: SourceSelection, patch: Partial<LiveTelemetry> = {}, origin?: 'game' | 'synthetic' | 'replay'): LiveTelemetry {
  const message = v0Message(name);
  return {
    selection, status: 'connected', reason: 'Validated current observation', fresh: true, recording: false, coverage: 'unknown',
    observation: {
      source: origin ? {...message.source, origin} : message.source, state: message.data.state, seq: message.seq, capture: message.capture,
      receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
      applied: {hydration: message.kind === 'checkpoint', skippedSequences: '0', continuity: message.data.continuity}
    },
    ...patch
  };
}
/** The smoke source's v0 checkpoint: 25 m/s and 73 L under the synthetic selection (scripts/ci/live-smoke-source.mjs). */
export function smokeV0(patch: Partial<LiveTelemetry> = {}): LiveTelemetry {
  const telemetry = v0Live('checkpoint', 'synthetic', patch);
  telemetry.observation!.state.speed = {available: true, value: 25, unit: 'm/s'};
  telemetry.observation!.state.fuel = {available: true, value: 73, unit: 'L'};
  return telemetry;
}

export interface V1Options {
  selection?: SourceSelection; status?: LiveTelemetryV1['status']; reason?: string; fresh?: boolean;
  /** `v0`: the job's cargo and destination city ids of the v0 fixtures (cargo.logs, city.warszawa), as the smoke source sets them. */
  ids?: 'v0' | 'fixture'; origin?: 'game' | 'synthetic' | 'replay'; game?: 'ets2' | 'ats';
  receivedMonotonicMs?: number;
  /** ET-052: the projection's next mandatory break; by default what the fixture carries, or not-supported below minor 2. */
  nextMandatoryBreak?: Measure<'min'>;
}
/** The live v1 projection of a v1 fixture message, by hand: the state without its window and two status fields. */
export function v1Projection(name = 'snapshot-live', options: V1Options = {}): LiveTelemetryV1 {
  const message = structuredClone(v1Message(name));
  const state = Object.fromEntries(Object.entries(message.data.state).filter(([key]) => key !== 'window')) as LiveStateV1;
  // ET-050b B7: the projection always carries the gearbox; a minor-0 fixture has none, so every part is not-supported.
  state.gearbox ??= {forwardGears: {available: false, reason: 'not-supported'}, reverseGears: {available: false, reason: 'not-supported'}, hshifter: {available: false, reason: 'not-supported'}};
  // ET-052 MB5: likewise the next mandatory break; a minor-0 or minor-1 fixture carries none, so it is not-supported.
  state.nextMandatoryBreak = structuredClone(options.nextMandatoryBreak ?? state.nextMandatoryBreak ?? {available: false, reason: 'not-supported', unit: 'min'});
  const job = state.configuration.job;
  if ((options.ids ?? 'v0') === 'v0' && job.available) {
    job.value.cargoId = {available: true, value: 'cargo.logs'};
    job.value.destinationCityId = {available: true, value: 'city.warszawa'};
  }
  const fresh = options.fresh ?? true;
  return {
    selection: options.selection ?? 'synthetic', status: options.status ?? 'connected', reason: options.reason ?? 'Validated current observation', fresh,
    observation: {
      source: {...message.source, ...(options.origin ? {origin: options.origin} : {}), ...(options.game ? {game: options.game} : {})},
      seq: message.seq, capture: message.capture, state,
      sourceStatus: {gameMode: message.data.status.gameMode, eventLoss: message.data.status.eventLoss},
      receivedMonotonicMs: options.receivedMonotonicMs ?? 0, hydration: message.kind === 'checkpoint'
    }
  };
}
/** The smoke pair: the v0 smoke checkpoint with the v1 projection of snapshot-live carrying the same job ids. */
export function smokePair(v1: V1Options = {}, v0Patch: Partial<LiveTelemetry> = {}): LiveTelemetry {
  // ET-052: the smoke source serves minor-2 states with a next mandatory break of 95 game minutes (scripts/ci/live-smoke-source-v1.mjs).
  return {...smokeV0(v0Patch), v1: v1Projection('snapshot-live', {nextMandatoryBreak: {available: true, value: 95, unit: 'min'}, ...v1})};
}
/** A service-internal v1 source state of a fixture, with the service-only fields the projection must drop. */
export function v1SourceState(name = 'snapshot-live', patch: Partial<V1SourceState> = {}): V1SourceState {
  const message = v1Message(name);
  return {
    selection: 'synthetic', status: 'connected', reason: 'Validated current observation', fresh: true,
    observation: {kind: message.kind, source: message.source, seq: message.seq, capture: message.capture, state: message.data.state,
      status: message.data.status, continuity: message.data.continuity, receivedMonotonicMs: 1250, hydration: message.kind === 'checkpoint'},
    clockMapping: {sourceClockId: message.capture.clockId, clientClockId: '50000000-0000-4000-8000-000000000001', offsetNs: '-12', uncertaintyNs: '34', measuredAtClientNs: '56'},
    lastEnd: {reason: 'plugin-shutdown', nextEventSeq: '3', ackedThroughEventSeq: '0', retainedUnacked: '1'},
    durable: {state: 'failed', code: 'WORKER_FAILED'},
    ...patch
  };
}

/** A minor-1 fixture's gearbox (ET-050b): `checkpoint-ats-mack` is the ATS Mack 18-speed, `checkpoint` the ETS2 12-speed. */
export function gearboxFixture(name: string): GearboxState {
  const message = JSON.parse(readFileSync(`tests/fixtures/protocol-v1/minor1/${name}.json`, 'utf8')) as {data: {state: {gearbox: GearboxState}}};
  return message.data.state.gearbox;
}
export interface GearboxPairOptions {
  /** Default: the Mack 18-speed. */
  gearbox?: GearboxState;
  /** The v1 truck model id; by default v0's `truck.volvo`, so both sources describe the same truck (ET-045a). */
  truckId?: string;
  /** The game of both sources, which names the crawler; by default the smoke fixtures' ETS2. */
  game?: 'ets2' | 'ats';
  v1?: V1Options;
  v0Patch?: Partial<LiveTelemetry>;
}
/** The smoke pair with `gear` in both sources and a minor-1 gearbox in the v1 projection (ET-050b B6 inputs). */
export function gearboxPair(gear: number, options: GearboxPairOptions = {}): LiveTelemetry {
  const live = smokePair(options.v1, options.v0Patch);
  live.observation!.state.gear = {available: true, value: gear, unit: 'index'};
  const state = live.v1!.observation!.state, truck = state.configuration.truck;
  state.gear = {available: true, value: gear, unit: 'index'};
  state.gearbox = structuredClone(options.gearbox ?? gearboxFixture('checkpoint-ats-mack'));
  if (truck.available) truck.value.id = {available: true, value: options.truckId ?? 'truck.volvo'};
  if (options.game !== undefined) {
    live.observation!.source.game = options.game;
    live.v1!.observation!.source.game = options.game;
  }
  return live;
}
