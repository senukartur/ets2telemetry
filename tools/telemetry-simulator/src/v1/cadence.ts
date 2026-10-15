// Real-time checks of a paced protocol v1 pipe run (ET-005b). The scenario fixes every message's scenario time; the
// pipe paces connected segments in real time. These checks are smoke bounds, not latency targets.
import {V1_LIMITS} from '../../../../packages/contracts/src/protocol-v1';
import {checkCadence, type CadenceCheck} from '../cadence';
import {type TranscriptLine} from './replay';

/**
 * The first measurable scheduled gap between server messages of one connection (at least 20 ms, measured from the
 * connection's first message) must arrive within half to one second beyond its schedule; see the v0 rule in
 * ../cadence.ts. `arrivalsMs` holds each connection's arrival times in message order; a connection whose client stopped
 * early (crash, stall) is compared over the messages it processed. Returns undefined without a measurable gap.
 */
export function checkV1Cadence(transcript: readonly TranscriptLine[], arrivalsMs: ReadonlyMap<number, readonly number[]>): CadenceCheck | undefined {
  const emissions: {atMs: number; connection: number}[] = [], arrivals: number[] = [];
  for (const [connection, times] of arrivalsMs) {
    const lines = transcript.filter(l => l.connection === connection && l.direction === 'server');
    const n = Math.min(lines.length, times.length);
    for (let i = 0; i < n; i++) { emissions.push({atMs: lines[i].atMs, connection}); arrivals.push(times[i]); }
  }
  return emissions.length ? checkCadence(emissions, arrivals) : undefined;
}

/**
 * Display rate bound: consecutive state messages (checkpoint, snapshot) of one connection are at least the 50 ms
 * snapshot interval apart in capture time, so state reaches a client at no more than 20 Hz (§7). Returns the smallest
 * interval in nanoseconds, or null when no connection has two state messages.
 */
export function checkStateRate(transcript: readonly TranscriptLine[]): string | null {
  const last = new Map<number, bigint>(), interval = BigInt(V1_LIMITS.snapshotIntervalMs) * 1_000_000n; let min: bigint | undefined;
  for (const l of transcript) {
    if (l.direction !== 'server' || (l.message.kind !== 'checkpoint' && l.message.kind !== 'snapshot')) continue;
    const capture = BigInt(l.message.capture.monotonicNs), previous = last.get(l.connection);
    if (previous !== undefined) {
      const gap = capture - previous;
      if (gap < interval) throw new Error(`State messages ${gap} ns apart on connection ${l.connection}, below the ${V1_LIMITS.snapshotIntervalMs} ms interval`);
      if (min === undefined || gap < min) min = gap;
    }
    last.set(l.connection, capture);
  }
  return min === undefined ? null : min.toString();
}
