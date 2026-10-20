import path from 'node:path';
import {mkdir, writeFile, rename} from 'node:fs/promises';
import type {LiveTelemetry, OverlayPresentation, SourceIdentity, CaptureTime} from '../../../packages/contracts/src';
import type {V1SourceState} from './v1-ingestion';

export const LATENCY_DURATION_MS = 120000;
export const LATENCY_MAX_SAMPLES = 3000;
export interface LatencyFrameStats {subscriptions: number; requests: number; inFlight: boolean; hiddenSkips: number; ineligibleSkips: number; callbacks: number; eligible: number; decoded: number;
  width: number; height: number; bytes: number; dipWidth: number; zoom: number; scale: number; firstPixel: string}
export function latencyEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.ETS2TELEMETRY_OVERLAY_LATENCY === '1' && Boolean(env.ETS2TELEMETRY_DIAGNOSTIC_DIR && path.isAbsolute(env.ETS2TELEMETRY_DIAGNOSTIC_DIR) &&
    env.ETS2TELEMETRY_PROFILE_DIR && path.isAbsolute(env.ETS2TELEMETRY_PROFILE_DIR));
}
export interface LatencyRequest {type: 'overlay-latency'; token: number; source: SourceIdentity; capture: CaptureTime}
export type LatencyReply = {type: 'overlay-latency-result'; token: number} &
  ({reason: string} | {upperNs: string; uncertaintyNs: string; mappingAgeNs: string});
const uint = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v);
function sameSource(a: SourceIdentity, b: SourceIdentity): boolean {
  return a.game === b.game && a.origin === b.origin && a.pluginSessionId === b.pluginSessionId && a.processInstanceId === b.processInstanceId &&
    a.processId === b.processId && a.windowsSessionId === b.windowsSessionId;
}
/** Receipt happens AFTER Chromium's frame callback. Its source age is therefore a conservative upper bound, not a frame timestamp. */
export function latencyReply(request: unknown, state: V1SourceState, now: bigint): LatencyReply | undefined {
  if (!request || typeof request !== 'object') return;
  const r = request as Partial<LatencyRequest>;
  if (r.type !== 'overlay-latency' || !Number.isInteger(r.token) || r.token! < 1 || r.token! > LATENCY_MAX_SAMPLES ||
    !r.source || typeof r.source !== 'object' || !r.capture || typeof r.capture !== 'object' || !uint(r.capture.monotonicNs) || typeof r.capture.clockId !== 'string') return;
  const token = r.token!, reject = (reason: string): LatencyReply => ({type: 'overlay-latency-result', token, reason});
  const observation = state.observation, mapping = state.clockMapping;
  if (!state.fresh || state.status !== 'connected' || !observation || !sameSource(r.source, observation.source)) return reject('source-not-current');
  if (!mapping || mapping.sourceClockId !== r.capture.clockId || observation.capture.clockId !== r.capture.clockId) return reject('clock-not-mapped');
  const age = now - BigInt(mapping.measuredAtClientNs);
  if (age < 0n || age > 1500000000n) return reject('mapping-not-current');
  const uncertainty = BigInt(mapping.uncertaintyNs);
  const upper = now - BigInt(r.capture.monotonicNs) + BigInt(mapping.offsetNs) + uncertainty;
  if (upper < 0n) return reject('impossible-clock-order');
  return {type: 'overlay-latency-result', token, upperNs: upper.toString(), uncertaintyNs: uncertainty.toString(), mappingAgeNs: age.toString()};
}
interface Sample {token: number; source: SourceIdentity; capture: CaptureTime; publishedNs: string; frameNs?: string; lowerMs?: number;
  upperMs?: number; uncertaintyMs?: number; mappingAgeMs?: number; reason?: string}
export class OverlayLatency {
  private rows: Sample[] = [];
  private pending = new Map<number, Sample>();
  private started?: bigint;
  private ended = false;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();
  private lastCapture?: string;
  private lastToken?: number;
  private firstFrame = false;
  private firstResult = false;
  private frameStats?: () => LatencyFrameStats;
  setFrameStats(read: () => LatencyFrameStats): void {this.frameStats = read;}
  constructor(private readonly directory: string, private readonly send: (request: LatencyRequest) => void,
    private readonly log: (code: string, error?: unknown) => void, private readonly now = () => process.hrtime.bigint()) {}
  project(view: OverlayPresentation, live: LiveTelemetry, visible: boolean): OverlayPresentation {
    if (this.ended) return view;
    if (!visible || view.editing || view.paused || view.freshness !== 'current' || !live.observation || !live.observation.windowFresh) {this.retire(); return view;}
    const {source, capture} = live.observation;
    const identity = `${source.processInstanceId}/${source.pluginSessionId}/${capture.clockId}/${capture.monotonicNs}`;
    // Re-publications caused by v1/window/health updates do not create new SDK samples.
    if (identity === this.lastCapture) return this.lastToken === undefined ? view : {...view, diagnosticFrame: this.lastToken};
    this.lastCapture = identity;
    if (this.rows.length === LATENCY_MAX_SAMPLES) {this.finish('sample-limit'); return view;}
    const now = this.now();
    if (this.started === undefined) {
      this.started = now; this.log('OVERLAY_LATENCY_STARTED');
      this.timer = setTimeout(() => this.finish('duration'), LATENCY_DURATION_MS); this.timer.unref();
    }
    // Keep at most 2 s of in-flight captures; every expired row remains in the report, without inventing latency.
    for (const [token, row] of this.pending) if (now - BigInt(row.publishedNs) > 2000000000n) {row.reason = 'frame-or-reply-timeout'; this.pending.delete(token);}
    const token = this.rows.length + 1;
    this.lastToken = token;
    const row = {token, source, capture, publishedNs: now.toString()};
    this.rows.push(row); this.pending.set(token, row);
    return {...view, diagnosticFrame: token};
  }
  frame(token: number, visible: boolean, observedNs = this.now()): void {
    const row = this.pending.get(token);
    if (!row || row.frameNs || this.ended) return;
    if (!visible) {row.reason = 'overlay-hidden'; this.pending.delete(token); return;}
    row.frameNs = observedNs.toString(); row.lowerMs = Number(observedNs - BigInt(row.publishedNs)) / 1e6;
    if (!this.firstFrame) {this.firstFrame = true; this.log('OVERLAY_LATENCY_FIRST_FRAME', {token, lowerMs: row.lowerMs});}
    try {this.send({type: 'overlay-latency', token, source: row.source, capture: row.capture});}
    catch {row.reason = 'service-unavailable'; this.pending.delete(token);}
  }
  reply(message: unknown): void {
    if (!message || typeof message !== 'object' || this.ended) return;
    const r = message as Partial<LatencyReply>;
    const row = this.pending.get(r.token!);
    if (!row?.frameNs) return;
    this.pending.delete(row.token);
    if ('reason' in r && typeof r.reason === 'string') {row.reason = r.reason.slice(0, 64); return;}
    if (!('upperNs' in r) || !uint(r.upperNs) || !uint(r.uncertaintyNs) || !uint(r.mappingAgeNs)) {row.reason = 'invalid-reply'; return;}
    row.upperMs = Number(BigInt(r.upperNs)) / 1e6; row.uncertaintyMs = Number(BigInt(r.uncertaintyNs)) / 1e6; row.mappingAgeMs = Number(BigInt(r.mappingAgeNs)) / 1e6;
    if (row.upperMs < row.lowerMs!) row.reason = 'inconsistent-bounds';
    if (!row.reason && !this.firstResult) {this.firstResult = true; this.log('OVERLAY_LATENCY_FIRST_RESULT',
      {token: row.token, lowerMs: row.lowerMs, upperMs: row.upperMs, uncertaintyMs: row.uncertaintyMs, mappingAgeMs: row.mappingAgeMs});}
  }
  retire(): void {
    // Keep the dedup identity: recovery must not measure an already-seen SDK capture again.
    this.lastToken = undefined;
    for (const row of this.pending.values()) row.reason = 'source-or-document-retired';
    this.pending.clear();
  }
  finish(reason: string): void {
    if (this.ended) return;
    this.ended = true; clearTimeout(this.timer);
    for (const row of this.pending.values()) row.reason = 'unfinished';
    this.pending.clear();
    const valid = this.rows.filter(row => row.upperMs !== undefined && !row.reason);
    const distribution = (key: 'lowerMs' | 'upperMs') => {
      const values = valid.map(row => row[key]!).sort((a, b) => a - b);
      const at = (p: number) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)] : null;
      return {p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1)};
    };
    const report = {schema: 'et009-overlay-latency/2', utc: new Date().toISOString(), reason,
      method: 'capturePage marker-only readback; <=20 requests/s; <=1 pending; visibility gated; stayHidden true',
      endpoint: 'SDK v0 speed/fuel capture to completed Chromium marker readback; upper bound includes polling, readback and service IPC; excludes DWM/scan-out/monitor and independent v1 sections',
      clockAssumption: 'v0/v1 share one source clock; clock offset remains within measured uncertainty for mapping age <= 1500 ms; no cross-process Node clock comparison',
      instrumented: true, recording: false, durationMs: this.started === undefined ? 0 : Number(this.now() - this.started) / 1e6,
      frameCapture: this.frameStats ? {...this.frameStats()} : undefined,
      attempted: this.rows.length, observedFrames: this.rows.filter(row => row.frameNs !== undefined).length, valid: valid.length, unresolved: this.rows.length - valid.length,
      targetMs: 200, upperBoundWithinTarget: valid.filter(row => row.upperMs! <= 200).length,
      lowerBoundOverTarget: valid.filter(row => row.lowerMs! > 200).length,
      lowerMs: distribution('lowerMs'), upperMs: distribution('upperMs'), samples: this.rows};
    this.writing = (async () => {
      await mkdir(this.directory, {recursive: true});
      const target = path.join(this.directory, 'overlay-latency.json');
      await writeFile(`${target}.partial`, JSON.stringify(report, null, 2)); await rename(`${target}.partial`, target);
      this.log('OVERLAY_LATENCY_SAVED');
    })().catch(error => this.log('OVERLAY_LATENCY_WRITE_FAILED', error));
  }
  idle(): Promise<void> {return this.writing;}
  get complete(): boolean {return this.ended;}
}
