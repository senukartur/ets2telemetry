import type {Cap0Packet, Cap0Observation} from '../../packages/contracts/src/capture-cap0';
import {CAP0_BOUNDS} from '../../packages/contracts/src/capture-cap0';

// Synthetic CAP0 packets for tests only. Values are explicitly synthetic and never game evidence.
export const SESSION = '0cab0000-0000-4000-8000-0000000000a1';
export const SOURCE = {game: 'ets2', sdkGameId: 'eut2', processId: 4242, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: '22222222-2222-4222-8222-222222222222'} as const;
export const AUTHORITY = {game: 'ets2', processId: 4242, windowsSessionId: 1, processInstanceId: SOURCE.processInstanceId, pluginSessionId: SOURCE.pluginSessionId, processCreationTime: '133000000000000000'} as const;
const base = (kind: string, packetSeq: number, publish = 1000 + packetSeq) => ({format: 'ets2telemetry-cap0', version: {major: 0, minor: 0}, kind, captureSessionId: SESSION, packetSeq: String(packetSeq), publishMonotonicNs: String(publish)});
export function header(packetSeq = 0, origin: 'game' | 'synthetic' = 'synthetic'): Cap0Packet {
  return {...base('header', packetSeq), data: {origin, source: {...SOURCE},
    versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 20}, sdkArchive: 'scs-sdk-1.15', pluginImage: {available: true, value: {path: '\\\\?\\C:\\Users\\Driver\\plugins\\ets2telemetry-plugin.dll', sha256: 'a'.repeat(64)}}},
    clocks: {sourceMonotonicClockId: '33333333-3333-4333-8333-333333333333', gameClockIdAtOpen: '44444444-4444-4444-8444-000000000000', openMonotonicNs: '900'},
    currency: {available: true, value: {code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'}},
    publishedBoundaryOrderAtOpen: '10', bounds: {...CAP0_BOUNDS}}} as Cap0Packet;
}
export function observation(position: number, name: string, sdkType: Cap0Observation['sdkType'], value: unknown, sdkTypeId?: number): Cap0Observation {
  const ids: Record<string, number> = {bool: 1, s32: 2, u32: 3, u64: 4, float: 5, double: 6, fvector: 7, dvector: 8, euler: 9, fplacement: 10, dplacement: 11, string: 12, s64: 13};
  return {position, name: {available: true, value: name}, arrayIndex: {available: false, reason: 'not-supported', detail: 'none'}, sdkType, sdkTypeId: sdkTypeId ?? ids[sdkType] ?? 99, value: {available: true, value} as Cap0Observation['value']};
}
export function envelope(packetSeq: number, envelopeSeq: number, options: {droppedBefore?: number; boundary?: number; group?: 'configuration' | 'gameplay' | 'lifecycle'; id?: string;
  observations?: Cap0Observation[]; first?: number; total?: number; final?: boolean} = {}): Cap0Packet {
  const observations = options.observations ?? [], group = options.group ?? 'gameplay', first = options.first ?? 0;
  const total = options.total ?? (group === 'lifecycle' ? 0 : first + observations.length);
  return {...base('envelope', packetSeq), data: {envelopeSeq: String(envelopeSeq), droppedBefore: String(options.droppedBefore ?? 0),
    callback: {group, id: {available: true, value: options.id ?? 'job.delivered'}}, sharedBoundaryOrder: String(options.boundary ?? 100 + envelopeSeq), configurationRevision: '3',
    callbackMonotonicNs: {available: true, value: String(950 + packetSeq)}, sdkFrame: {available: true, value: {renderTimeUs: '5000', simulationTimeUs: '5000', pausedSimulationTimeUs: '4000'}},
    gameTime: {minutes: {available: true, value: '4294967295'}, clockId: '44444444-4444-4444-8444-000000000000'}, simulation: 'running',
    attributes: {expected: group !== 'lifecycle', present: group !== 'lifecycle', terminated: true, total, first, count: observations.length, final: options.final ?? first + observations.length === total, omittedLowerBound: 0},
    observations}} as Cap0Packet;
}
export const delivered = () => [observation(0, 'revenue', 's64', '-9223372036854775808'), observation(1, 'income', 'u64', '18446744073709551615'), observation(2, 'distance.km', 'float', 12.5),
  observation(3, 'placement', 'dplacement', {position: {x: 1.5, y: -2, z: 3}, orientation: {heading: 0.25, pitch: 0, roll: 0}})];
export function loss(packetSeq: number, attempted: number, dropped: number): Cap0Packet {
  return {...base('loss', packetSeq), data: {attemptedEnvelopes: String(attempted), droppedEnvelopes: String(dropped), droppedBytes: String(dropped * 100), droppedQueueFull: String(dropped), droppedBytesFull: '0',
    lastDroppedEnvelopeSeq: dropped ? {available: true, value: String(attempted)} : {available: false, reason: 'not-observed', detail: 'none'}, lastDropMonotonicNs: {available: false, reason: 'not-observed', detail: 'none'}}} as Cap0Packet;
}
export function end(packetSeq: number, attempted: number, dropped = 0): Cap0Packet {
  return {...base('end', packetSeq), data: {reason: 'plugin-shutdown', attemptedEnvelopes: String(attempted), enqueuedEnvelopes: String(attempted - dropped), publishedEnvelopes: String(attempted - dropped),
    droppedEnvelopes: String(dropped), droppedBytes: String(dropped * 100), unsentEnvelopes: '0'}} as Cap0Packet;
}
export const payload = (packet: unknown) => new TextEncoder().encode(JSON.stringify(packet));
export function frame(packet: unknown): Uint8Array { const body = payload(packet), out = new Uint8Array(body.length + 4); new DataView(out.buffer).setUint32(0, body.length, true); out.set(body, 4); return out; }
