// ET-051: a development probe that opts into the plugin's v0 diagnostics mode and records the raw per-frame channel
// values, so a zero can be attributed to a game callback. It writes only to a new local directory, never to history.
import {createWriteStream, type WriteStream} from 'node:fs';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FrameDecoder, PROTOCOL_V0, V0Consumer, encodeFrame, type DiagnosticObservation, type ProtocolMessage, type SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import type {TelemetrySocket} from '../../../apps/desktop/src/native-pipe-client';
import {CONSUMPTION_CHANNEL, ProbeSummarizer, type ProbeFrame, type ProbeSummary, type RawValue, type Simulation} from './summarize';

export const FRAMES_FILE = 'frames.ndjson';
export const SUMMARY_FILE = 'summary.json';
export const PROBE_FORMAT = 'ets2telemetry-channel-probe';
export const MAX_SECONDS = 3600;
/** About one hour at 500 frames per second; a capture stops at this bound rather than growing without limit. */
export const MAX_FRAMES = 2_000_000;
const CHANNELS = {consumption: CONSUMPTION_CHANNEL, speed: 'truck.speed', rpm: 'truck.engine.rpm', fuel: 'truck.fuel.amount'} as const;

export type StopReason = 'deadline' | 'interrupted' | 'frame-cap' | 'diagnostics-refused' | 'protocol-error';
export interface ProbeOptions {
  /** A directory that must not exist yet; its parent must. */
  output: string;
  game: 'ets2' | 'ats';
  /** `game` for a verified broker source; `synthetic` only for the simulator fixture. */
  origin: 'game' | 'synthetic';
  seconds: number;
  /** Opens one connection: the native broker for a game, a fixture pipe in tests. */
  connect: () => TelemetrySocket;
  signal?: AbortSignal;
  /** Delay before the next connection attempt after a connection ends or no game is running. */
  retryMs?: number;
  maxFrames?: number;
  log?: (line: string) => void;
}
export interface ProbeResult {stopReason: StopReason; summary: ProbeSummary; directory: string}

function raw(observations: DiagnosticObservation[], channel: string): RawValue {
  const observation = observations.find(o => o.channel === channel);
  if (!observation) return null;
  if (!observation.value.available) return 'unavailable';
  return typeof observation.value.value === 'number' ? observation.value.value : 'unavailable';
}
/** JSON text of one frame that keeps a raw -0 visible; JSON.stringify would write it as 0. */
export function frameLine(frame: ProbeFrame): string {
  return JSON.stringify(frame, (_key, value: unknown) => Object.is(value, -0) ? '-0' : value) + '\n';
}

export async function runProbe(options: ProbeOptions): Promise<ProbeResult> {
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > MAX_SECONDS) throw new Error(`--seconds must be an integer from 1 to ${MAX_SECONDS}`);
  const log = options.log ?? (() => {}), retryMs = options.retryMs ?? 2000, maxFrames = options.maxFrames ?? MAX_FRAMES;
  const directory = path.resolve(options.output);
  // Not recursive: the directory must be new and its parent must exist.
  await mkdir(directory);
  const frames = createWriteStream(path.join(directory, FRAMES_FILE), {flags: 'wx'});
  const summarizer = new ProbeSummarizer();
  const deadline = performance.now() + options.seconds * 1000;
  let stopReason: StopReason | undefined, connection = 0, recorded = 0, waitingLogged = false;
  const stopped = () => stopReason !== undefined;
  const stop = (reason: StopReason) => {stopReason ??= reason;};
  options.signal?.addEventListener('abort', () => stop('interrupted'), {once: true});

  while (!stopped()) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {stop('deadline'); break;}
    let welcomed = false;
    await new Promise<void>(resolve => {
      const socket = options.connect(), decoder = new FrameDecoder(), consumer = new V0Consumer(true);
      let done = false, last: {monotonicNs: string; simulation: Simulation} | undefined, identity: SourceIdentity | undefined;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); socket.destroy();
        // The broker has exited (or the fixture socket closed) before the next attempt.
        void (socket.completion ?? Promise.resolve()).then(() => resolve());
      };
      const fail = (reason: StopReason, message: string) => {log(message); stop(reason); finish();};
      const abort = () => finish();
      const timer = setTimeout(() => {stop('deadline'); finish();}, remaining);
      options.signal?.addEventListener('abort', abort, {once: true});
      socket.once('connect', () => {
        if (done) return;
        socket.write(encodeFrame({version: PROTOCOL_V0, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, diagnostics: true}}));
      });
      socket.on('data', (bytes: unknown) => {
        if (done) return;
        try {
          if (!(bytes instanceof Uint8Array)) throw new Error('Invalid transport bytes');
          decoder.push(bytes, (message: ProtocolMessage) => {
            if (done) return;
            if (message.kind === 'hello') throw new Error('Unexpected client direction');
            const authority = socket.authority;
            if (options.origin === 'game' ? !authority || (Object.keys(authority) as (keyof SourceIdentity)[]).some(key => authority[key] !== message.source[key]) : message.source.origin !== 'synthetic') throw new Error('Source identity mismatch');
            if (identity && message.source.pluginSessionId !== identity.pluginSessionId) throw new Error('Source identity changed');
            identity = message.source;
            consumer.accept(message);
            if (message.kind === 'welcome') {
              if (!message.data.diagnostics) {fail('diagnostics-refused', 'The plugin did not enable diagnostics for this connection.'); return;}
              welcomed = true; waitingLogged = false; connection++; log(`Connected (connection ${connection}); recording raw frames.`); return;
            }
            if (message.kind === 'checkpoint' || message.kind === 'snapshot') {last = {monotonicNs: message.capture.monotonicNs, simulation: message.data.state.simulation}; return;}
            const observations = message.data.observations;
            const frame: ProbeFrame = {connection, monotonicNs: message.capture.monotonicNs, simulation: last?.monotonicNs === message.capture.monotonicNs ? last.simulation : null,
              consumption: raw(observations, CHANNELS.consumption), speed: raw(observations, CHANNELS.speed), rpm: raw(observations, CHANNELS.rpm), fuel: raw(observations, CHANNELS.fuel),
              coalescedSnapshots: message.data.continuity.coalescedSnapshots, lostObservations: message.data.continuity.lostObservations};
            summarizer.add(frame); frames.write(frameLine(frame));
            if (++recorded >= maxFrames) {stop('frame-cap'); finish();}
          });
        } catch {fail('protocol-error', 'Invalid protocol, ordering or source identity; the capture stops.');}
      });
      socket.on('waiting', () => {if (!waitingLogged) log('No game with the plugin is running yet; waiting.'); waitingLogged = true;});
      socket.on('error', (error: unknown) => {
        const outcome = (error as {outcome?: string}).outcome;
        log(outcome === 'busy' ? 'Another client holds the game connection: close Yukon Union Telemetry and keep this probe running.' : `Connection failed (${outcome ?? 'error'}); retrying.`);
        finish();
      });
      socket.on('end', finish); socket.on('close', finish);
    });
    if (welcomed && !stopped()) log('Connection ended; waiting for the game again.');
    if (!stopped()) await new Promise<void>(resolve => {
      const timer = setTimeout(done, Math.min(retryMs, Math.max(0, deadline - performance.now())));
      function done() {clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve();}
      options.signal?.addEventListener('abort', done, {once: true});
    });
  }
  await close(frames);
  const summary = summarizer.result(), reason = stopReason ?? 'deadline';
  await writeFile(path.join(directory, SUMMARY_FILE), JSON.stringify({format: PROBE_FORMAT, formatVersion: 1, game: options.game, origin: options.origin,
    requestedSeconds: options.seconds, stopReason: reason, summary}, null, 2) + '\n', {flag: 'wx'});
  return {stopReason: reason, summary, directory};
}
function close(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {stream.once('error', reject); stream.end(() => resolve());});
}
