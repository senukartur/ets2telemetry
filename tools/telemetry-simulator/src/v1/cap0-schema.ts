// Replay-only callback context. CAP0 observations remain typed, including values the v1 adapter does not use.
import {createHash} from 'node:crypto';
import {validateCap0Packet, type Cap0EnvelopeData} from '../../../../packages/contracts/src/capture-cap0';

export interface CaptureStep {atMs: number; action: 'capture'; data: Omit<Cap0EnvelopeData, 'sdkFrame'>}
export interface CaptureProvenance {
  converter: 'cap0-v1-1'; run: string; inputOrigin: 'game' | 'synthetic'; packetsSha256: string; stepsSha256: string;
  envelopes: number; orderingComplete: true; lossFree: true; review: 'docs/validation/cap-01a.md#expectation-updates';
  operator: {mode: 'single-player' | 'truckersmp' | 'unknown'; display: 'windowed' | 'borderless' | 'unknown'; gameVersion: '1.61.1.1s' | null};
  build: {pluginSha256: string | null; sourceCommit: string | null; source: 'coordinator-ledger' | 'unrecorded'};
}
export const stepsDigest = (steps: unknown): string => createHash('sha256').update(JSON.stringify(steps)).digest('hex');
function fail(): never { throw new Error('Invalid CAP0 replay schema'); }
export function exactObject(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail();
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) fail();
  return o;
}
export function runLabel(v: unknown): string { if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(v)) fail(); return v; }
export function validateCaptureStep(v: unknown): CaptureStep {
  const o = exactObject(v, ['atMs', 'action', 'data']);
  if (o.action !== 'capture' || typeof o.atMs !== 'number' || !Number.isSafeInteger(o.atMs) || o.atMs < 1 || o.atMs > 86_400_000) fail();
  const d = exactObject(o.data, ['envelopeSeq', 'droppedBefore', 'callback', 'sharedBoundaryOrder', 'configurationRevision', 'callbackMonotonicNs', 'gameTime', 'simulation', 'attributes', 'observations']);
  const packet = validateCap0Packet({format: 'ets2telemetry-cap0', version: {major: 0, minor: 0}, kind: 'envelope',
    captureSessionId: '00000000-0000-4000-8000-000000000001', packetSeq: '1', publishMonotonicNs: String(BigInt(o.atMs) * 1_000_000n),
    data: {...d, sdkFrame: {available: false, reason: 'not-observed', detail: 'none'}}});
  if (packet.kind !== 'envelope') fail();
  const data = packet.data;
  if (data.droppedBefore !== '0' || !data.callback.id.available || !data.callbackMonotonicNs.available ||
      BigInt(data.callbackMonotonicNs.value) > BigInt(o.atMs) * 1_000_000n || data.attributes.first !== 0 || !data.attributes.final) fail();
  const id = data.callback.id.value;
  if (!/^[a-z0-9_.-]{1,128}$/.test(id) || data.observations.some(a => !a.name.available || !/^[a-zA-Z0-9_.-]{1,128}$/.test(a.name.value))) fail();
  if (data.callback.group === 'lifecycle' && !['timers.restart', 'game.time.regression', 'simulation.started', 'simulation.paused'].includes(id)) fail();
  if ((id === 'simulation.started' && data.simulation !== 'running') || (id === 'simulation.paused' && data.simulation !== 'paused')) fail();
  return structuredClone(v) as CaptureStep;
}
export function validateProvenance(v: unknown): CaptureProvenance {
  const o = exactObject(v, ['converter', 'run', 'inputOrigin', 'packetsSha256', 'stepsSha256', 'envelopes', 'orderingComplete', 'lossFree', 'review', 'operator', 'build']);
  runLabel(o.run);
  if (o.converter !== 'cap0-v1-1' || !['game', 'synthetic'].includes(String(o.inputOrigin)) || o.orderingComplete !== true || o.lossFree !== true ||
      o.review !== 'docs/validation/cap-01a.md#expectation-updates' || typeof o.envelopes !== 'number' || !Number.isSafeInteger(o.envelopes) || o.envelopes < 1 || o.envelopes > 998) fail();
  for (const k of ['packetsSha256', 'stepsSha256']) if (typeof o[k] !== 'string' || !/^[a-f0-9]{64}$/.test(o[k])) fail();
  const p = exactObject(o.operator, ['mode', 'display', 'gameVersion']);
  if (!['single-player', 'truckersmp', 'unknown'].includes(String(p.mode)) || !['windowed', 'borderless', 'unknown'].includes(String(p.display)) || (p.gameVersion !== null && p.gameVersion !== '1.61.1.1s')) fail();
  const b = exactObject(o.build, ['pluginSha256', 'sourceCommit', 'source']);
  if ((b.pluginSha256 !== null && (typeof b.pluginSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(b.pluginSha256))) ||
      (b.sourceCommit !== null && (typeof b.sourceCommit !== 'string' || !/^[a-f0-9]{7,40}$/.test(b.sourceCommit))) || !['coordinator-ledger', 'unrecorded'].includes(String(b.source))) fail();
  return structuredClone(v) as CaptureProvenance;
}
