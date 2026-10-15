// Real-time checks of a paced protocol v1 pipe run (ET-005b). The scenario fixes every message's scenario time; the
// pipe paces connected segments in real time. These checks are smoke bounds, not latency targets.
import {V1_LIMITS} from '../../../../packages/contracts/src/protocol-v1';
import {MAX_LATE_MS, MIN_MEASURABLE_GAP_MS} from '../cadence';
import {type PacedWrite} from './pipe';
import {type TranscriptLine} from './replay';

/** `index` is the message's position on its connection. */
export interface V1CadenceCheck {index: number; expectedMs: number; serverMs: number; clientMs: number}

/**
 * Lower bound, on the server's own clock: no paced message is written before its schedule. Both sides are measured from
 * the same server event (the hello's receipt), so this holds by construction of the pacing and fails only on a pacing
 * defect. Upper bound, on the client's clock: the first measurable scheduled gap of a connection (at least 20 ms after
 * its first message) arrives no more than one second later than scheduled, as in the v0 rule (../cadence.ts); a delayed
 * first arrival only shortens the measured gap, so it cannot fail this bound. `arrivalsMs` holds each connection's
 * arrival times in message order; a connection whose client stopped early is compared over what it processed.
 * Returns the gap checked, or undefined when no connection has a measurable gap.
 */
export function checkV1Cadence(writes: readonly PacedWrite[], transcript: readonly TranscriptLine[], arrivalsMs: ReadonlyMap<number, readonly number[]>): V1CadenceCheck | undefined {
  for (const w of writes) if (w.actualMs < w.scheduledMs) throw new Error(`Message at ${w.atMs} ms written ${w.actualMs.toFixed(2)} ms after the hello, before its ${w.scheduledMs} ms schedule`);
  for (const [connection, times] of arrivalsMs) {
    const lines = transcript.filter(l => l.connection === connection && l.direction === 'server'), n = Math.min(lines.length, times.length);
    for (let i = 1; i < n; i++) {
      const expectedMs = lines[i].atMs - lines[0].atMs;
      if (expectedMs < MIN_MEASURABLE_GAP_MS) continue;
      const clientMs = times[i] - times[0], write = writes.filter(w => w.connection === connection)[i];
      if (clientMs > expectedMs + MAX_LATE_MS) throw new Error(`Real cadence outside smoke bounds: expected ${expectedMs} ms, observed ${clientMs.toFixed(2)} ms`);
      return {index: i, expectedMs, serverMs: write ? write.actualMs : NaN, clientMs};
    }
  }
  return undefined;
}

/**
 * Display rate bound on content: consecutive state messages (checkpoint, snapshot) of one connection carry capture times
 * at least the 50 ms snapshot interval apart, so the producer emits state at no more than 20 Hz of source time (§7).
 * This holds by construction of the producer model and says nothing about real delivery spacing, which pipe and
 * scheduling jitter can compress. Returns the smallest interval in nanoseconds, or null without two state messages.
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
