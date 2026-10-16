// The trip recorder's pending sample buffer (ET-015b, H8, H9): the 300-row bound with newest-drop, one session-level
// `sample-loss` interval per contiguous dropped run, batches of one plugin session, commits and discard. Expected
// values are written by hand from decisions H8 and H9 (concept.md) and docs/telemetry-service-v1.md (REG-007, REG-009).
import {describe, expect, it} from 'vitest';
import type {SampleInput} from '../../packages/storage/src/api';
import {MAX_PENDING_SAMPLES, SampleBuffer} from '../../apps/desktop/src/sample-buffer';

const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const CLOCK_A = '30000000-0000-4000-8000-00000000000a', CLOCK_B = '30000000-0000-4000-8000-00000000000b';
const NOT_OBSERVED = {available: false as const, reason: 'not-observed' as const};
/** A row of source second `second` on `clock`, labelled 1,800,000,000,000 ms + the second in ms. */
function row(second: number, clock = CLOCK_A): SampleInput {
  return {tripUuid: null, utcMs: 1_800_000_000_000 + second * 1000, sourceClockId: clock, monotonicNs: `${second}000000000`, gameTime: null,
    speed: {available: true, value: 0}, fuel: NOT_OBSERVED, averageConsumption: NOT_OBSERVED, estimatedRange: NOT_OBSERVED, engineRpm: NOT_OBSERVED, gear: NOT_OBSERVED,
    odometer: NOT_OBSERVED, position: NOT_OBSERVED};
}
const seconds = (rows: readonly SampleInput[]) => rows.map(r => Number(BigInt(r.monotonicNs) / 1_000_000_000n));
/** Fills the buffer with seconds 1-300 of P1. */
function full(): SampleBuffer {
  const buffer = new SampleBuffer();
  for (let s = 1; s <= 300; s++) expect(buffer.push(P1, row(s))).toBe(true);
  return buffer;
}

describe('ET-015b sample buffer', () => {
  it('holds 300 rows and drops the newest one beyond them (H9, D7)', () => {
    expect(MAX_PENDING_SAMPLES).toBe(300);
    const buffer = full();
    expect([buffer.pending, buffer.rowCount, buffer.dropped]).toEqual([300, 300, 0]);
    expect(buffer.push(P1, row(301))).toBe(false);
    // The 300 held rows are the oldest; the dropped row is not among them, and one loss run is pending.
    expect([buffer.rowCount, buffer.dropped, buffer.pending]).toEqual([300, 1, 301]);
    const batch = buffer.nextBatch(300)!;
    expect([seconds(batch.rows)[0], seconds(batch.rows).at(-1), batch.rows.length]).toEqual([1, 300, 300]);
  });

  it('records one contiguous dropped run as one session-level sample-loss interval with its bounds and size', () => {
    const buffer = full();
    for (const s of [301, 302, 303]) buffer.push(P1, row(s));
    const batch = buffer.nextBatch(60)!;
    expect(batch.pluginSessionId).toBe(P1);
    expect(batch.losses).toEqual([{tripUuid: null, kind: 'sample-loss', startUtcMs: 1_800_000_301_000, endUtcMs: 1_800_000_303_000, startMonotonicNs: '301000000000',
      endMonotonicNs: '303000000000', sourceClockId: CLOCK_A, detail: {cause: 'sample-backlog', count: 3}}]);
    expect(seconds(batch.rows)).toEqual(Array.from({length: 60}, (_, i) => i + 1));
  });

  it('ends a run when a row of its session is accepted again, so a later drop starts a second run', () => {
    const buffer = full();
    buffer.push(P1, row(301)); buffer.push(P1, row(302));
    const first = buffer.nextBatch(60)!;
    for (const loss of first.losses) buffer.commitLoss(loss);
    buffer.commit(first);
    // 240 rows are left, so 303-362 are accepted; then the buffer is full again and 363-364 are dropped.
    for (let s = 303; s <= 362; s++) expect(buffer.push(P1, row(s))).toBe(true);
    expect([buffer.push(P1, row(363)), buffer.push(P1, row(364)), buffer.dropped]).toEqual([false, false, 4]);
    const second = buffer.nextBatch(60)!;
    expect(second.losses).toEqual([{tripUuid: null, kind: 'sample-loss', startUtcMs: 1_800_000_363_000, endUtcMs: 1_800_000_364_000, startMonotonicNs: '363000000000',
      endMonotonicNs: '364000000000', sourceClockId: CLOCK_A, detail: {cause: 'sample-backlog', count: 2}}]);
    expect(seconds(second.rows)[0]).toBe(61);
  });

  it('ends a run at nextBatch, so drops while that batch is written form a new run', () => {
    const buffer = full();
    buffer.push(P1, row(301));
    const batch = buffer.nextBatch(60)!;
    buffer.push(P1, row(302));
    expect(batch.losses.map(l => l.detail)).toEqual([{cause: 'sample-backlog', count: 1}]);
    for (const loss of batch.losses) buffer.commitLoss(loss);
    buffer.commit(batch);
    expect(buffer.nextBatch(60)!.losses.map(l => [l.startMonotonicNs, l.detail])).toEqual([['302000000000', {cause: 'sample-backlog', count: 1}]]);
  });

  it('starts a new run when a dropped row is on another source clock', () => {
    const buffer = full();
    buffer.push(P1, row(301)); buffer.push(P1, row(5, CLOCK_B)); buffer.push(P1, row(6, CLOCK_B));
    expect(buffer.nextBatch(1)!.losses.map(l => [l.sourceClockId, l.startMonotonicNs, l.endMonotonicNs, l.detail])).toEqual([
      [CLOCK_A, '301000000000', '301000000000', {cause: 'sample-backlog', count: 1}], [CLOCK_B, '5000000000', '6000000000', {cause: 'sample-backlog', count: 2}]]);
  });

  it('batches the oldest pending session only, at most maxRows of it in sampling order, then the next session', () => {
    const buffer = new SampleBuffer();
    buffer.push(P1, row(1)); buffer.push(P2, row(7)); buffer.push(P1, row(2)); buffer.push(P1, row(3)); buffer.push(P2, row(8));
    const first = buffer.nextBatch(2)!;
    expect([first.pluginSessionId, seconds(first.rows), first.losses]).toEqual([P1, [1, 2], []]);
    buffer.commit(first);
    expect([buffer.rowCount, buffer.pending]).toEqual([3, 3]);
    // P2's 7 is now the oldest row.
    const second = buffer.nextBatch(60)!;
    expect([second.pluginSessionId, seconds(second.rows)]).toEqual([P2, [7, 8]]);
    buffer.commit(second);
    expect(seconds(buffer.nextBatch(60)!.rows)).toEqual([3]);
  });

  it('writes a loss run of a session with no pending row as a batch without rows', () => {
    const buffer = full();
    // A new plugin session whose first row meets a full buffer of P1.
    buffer.push(P2, row(9));
    for (let i = 0; i < 5; i++) { const batch = buffer.nextBatch(60)!; expect(batch.pluginSessionId).toBe(P1); buffer.commit(batch); }
    const last = buffer.nextBatch(60)!;
    expect([last.pluginSessionId, last.rows, last.losses.map(l => l.detail)]).toEqual([P2, [], [{cause: 'sample-backlog', count: 1}]]);
    buffer.commitLoss(last.losses[0]);
    expect([buffer.pending, buffer.nextBatch(60)]).toEqual([0, undefined]);
  });

  it('keeps rows and loss intervals that were not committed, and keeps a written loss out of the next batch', () => {
    const buffer = full();
    buffer.push(P1, row(301));
    const failed = buffer.nextBatch(60)!;
    // Neither part was stored (a failed write): the same loss and rows come back.
    expect(buffer.nextBatch(60)).toEqual(failed);
    // The loss was stored but the rows were not: only the rows come back.
    buffer.commitLoss(failed.losses[0]);
    const retry = buffer.nextBatch(60)!;
    expect([retry.losses, seconds(retry.rows)]).toEqual([[], seconds(failed.rows)]);
    expect(buffer.pending).toBe(300);
  });

  it('discards every pending row and loss run and reports the rows', () => {
    const buffer = full();
    buffer.push(P1, row(301));
    expect([buffer.discard(), buffer.pending, buffer.rowCount, buffer.nextBatch(60)]).toEqual([300, 0, 0, undefined]);
    // The dropped count is a lifetime count.
    expect(buffer.dropped).toBe(1);
  });
});
