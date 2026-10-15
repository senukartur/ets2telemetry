import type {LiveTelemetry, LiveTelemetryV1, LiveV1Status, SourceSelection} from '../../../packages/contracts/src';
import {validateLiveObservationV1, type CurrentState, type LiveStateV1} from '../../../packages/contracts/src/protocol-v1';
import type {V1SourceState} from './v1-ingestion';

// The protocol v1 live projection (ET-010c, decisions F1-F3). The telemetry service builds it from its service-internal
// v1 source state and attaches it to the coalesced live update; main and the dashboard preload validate it again and
// expire it on their own clocks. Pure, without Node built-ins, so the service, main and the sandboxed preload share it.

export const V1_LIVE_STATUSES: readonly LiveV1Status[] = Object.freeze(['waiting', 'connected', 'paused', 'stale', 'incompatible', 'disconnected', 'unavailable']);
/** v1 data expires after this long without a new SDK boundary in main and in the preload, as v0 data does. */
export const V1_LIVE_EXPIRY_MS = 500;
export const MAIN_V1_EXPIRED_REASON = 'Main has no recent v1 SDK capture';
export const RENDERER_V1_EXPIRED_REASON = 'Renderer has no recent v1 SDK capture';
const REASON_LIMIT = 256;
// eslint-disable-next-line no-control-regex -- C0 and DEL control characters are deliberately rejected.
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** The current state without the game window: an explicit whitelist, so a new wire field never leaks by default. */
function liveState(state: CurrentState): LiveStateV1 {
  return {
    simulation: state.simulation, speed: state.speed, fuel: state.fuel, fuelCapacity: state.fuelCapacity, engineRpm: state.engineRpm, gear: state.gear,
    odometer: state.odometer, averageConsumption: state.averageConsumption, estimatedRange: state.estimatedRange, navigationDistance: state.navigationDistance,
    gameTime: state.gameTime, captureUtcUnixMs: state.captureUtcUnixMs, boundaryOrder: state.boundaryOrder, worldPlacement: state.worldPlacement,
    configuration: state.configuration
  };
}

/**
 * The whitelisted projection of the service's v1 source state (decision F2). It never carries the game window or its
 * handle, the clock mapping, the last `end`, durable status, the delivery cursor, continuity or the message kind.
 */
export function liveV1Projection(state: V1SourceState): LiveTelemetryV1 {
  const observation = state.observation;
  return {
    selection: state.selection, status: state.status, reason: state.reason, fresh: state.fresh,
    ...(observation ? {observation: {
      source: observation.source, seq: observation.seq, capture: observation.capture, state: liveState(observation.state),
      sourceStatus: {gameMode: observation.status.gameMode, eventLoss: observation.status.eventLoss},
      receivedMonotonicMs: observation.receivedMonotonicMs, hydration: observation.hydration
    }} : {})
  };
}

/** Attaches the v1 projection to a v0 update only when both follow the same selection. */
export function withV1(v0: LiveTelemetry, v1: LiveTelemetryV1 | undefined): LiveTelemetry {
  return v1 && v1.selection === v0.selection ? {...v0, v1} : v0;
}

/**
 * Strict validation of an untrusted v1 projection for the given selection. Never throws: anything invalid, including a
 * game window, an extra key or another selection, returns undefined, and the caller strips the projection.
 */
export function parseLiveV1(value: unknown, selection: SourceSelection): LiveTelemetryV1 | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const v = value as Record<string, unknown>, keys = Object.keys(v);
    const observed = Object.hasOwn(v, 'observation');
    if (keys.length !== (observed ? 5 : 4) || !['selection', 'status', 'reason', 'fresh'].every(key => Object.hasOwn(v, key))) return undefined;
    if (v.selection !== selection || typeof v.status !== 'string' || !(V1_LIVE_STATUSES as readonly string[]).includes(v.status)) return undefined;
    if (typeof v.reason !== 'string' || v.reason.length < 1 || v.reason.length > REASON_LIMIT || CONTROL.test(v.reason)) return undefined;
    if (typeof v.fresh !== 'boolean' || (v.fresh && (!observed || (v.status !== 'connected' && v.status !== 'paused')))) return undefined;
    if (observed) validateLiveObservationV1(v.observation);
    return value as LiveTelemetryV1;
  } catch {
    return undefined;
  }
}

/** Receipt identity of a v1 observation: it changes only with the source, capture clock, SDK boundary or receipt time. */
export function liveV1Key(v1: LiveTelemetryV1 | undefined): string | undefined {
  const observation = v1?.observation;
  if (!observation) return undefined;
  return `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.capture.clockId}|${observation.state.boundaryOrder}|${observation.receivedMonotonicMs}`;
}

/** The projection after its expiry: stale and not fresh; the observation stays, so its values read as not current. */
export function expiredV1(v1: LiveTelemetryV1, reason: string): LiveTelemetryV1 {
  return {...v1, status: 'stale', fresh: false, reason};
}
