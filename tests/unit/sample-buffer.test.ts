// The trip recorder's pending sample buffer (ET-015b, H8, H9): the 300-row bound with newest-drop, one session-level
// `sample-loss` interval per contiguous dropped run, written once the run ended however often a write is retried,
// batches of one plugin session, commits and discard. Expected values are written by hand from decisions H8 and H9
// (concept.md) and docs/telemetry-service-v1.md (REG-007, REG-009).
import {describe, expect, it} from 'vitest';
import type {SampleInput} from '../../packages/storage/src/api';
import {MAX_LOSS_RUNS, MAX_PENDING_SAMPLES, SampleBuffer} from '../../apps/desktop/src/sample-buffer';

const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const CLOCK_A = '30000000-0000-4000-8000-00000000000a', CLOCK_B = '30000000-0000-4000-8000-00000000000b';
const NOT_OBSERVED = {available: false as const, reason: 'not-observed' as const};
/** A row of source second `second` on `clock`, labelled 1,800,000,000,000 ms + the second in ms. */
function row(second: number, clock = CLOCK_A): SampleInput {
  return {tripUuid: null, utcMs: 1_800_000_000_000 + second * 1000, sourceClockId: clock, monotonicNs: `${second}000000000`, gameTime: null,
    speed: {available: true, value: 0}, fuel: NOT_OBSERVED, averageConsumption: NOT_OBSERVED, estimatedRange: NOT_OBSERVED, engineRpm: NOT_OBSERVED, gear: NOT_OBSERVED,
    odometer: NOT_OBSERVED, position: NOT_OBSERVED};
}
/** The interval of a dropped run of seconds `first`-`last` on clock A with `count` rows. */
const loss = (first: number, last: number, count: number, clock = CLOCK_A) => ({tripUuid: null, kind: 'sample-loss', startUtcMs: 1_800_000_000_000 + first * 1000,
  endUtcMs: 1_800_000_000_000 + last * 1000, startMonotonicNs: `${first}000000000`, endMonotonicNs: `${last}000000000`, sourceClockId: clock,
  detail: {cause: 'sample-backlog', count}});
const seconds = (rows: readonly SampleInput[]) => rows.map(r => Number(BigInt(r.monotonicNs) / 1_000_000_000n));
/** Fills the buffer with seconds 1-300 of P1. */
function full(): SampleBuffer {
  const buffer = new SampleBuffer();
  for (let s = 1; s <= 300; s++) expect(buffer.push(P1, row(s))).toBe(true);
  return buffer;
}
/** Stores one batch of `n` rows of the oldest session, which frees room and so ends every open run. */
function storeRows(buffer: SampleBuffer, n: number) { const batch = buffer.nextBatch(n)!; buffer.commit({...batch, losses: []}); return batch; }

describe('ET-015b sample buffer', () => {
  it('holds 300 rows and drops the newest one beyond them (H9, D7)', () => {
    expect([MAX_PENDING_SAMPLES, MAX_LOSS_RUNS]).toEqual([300, 16]);
    const buffer = full();
    expect([buffer.rowCount, buffer.lossCount, buffer.dropped]).toEqual([300, 0, 0]);
    expect(buffer.push(P1, row(301))).toBe(false);
    // The 300 held rows are the oldest; the dropped row is not among them, and one loss run is pending.
    expect([buffer.rowCount, buffer.dropped, buffer.lossCount]).toEqual([300, 1, 1]);
    const batch = buffer.nextBatch(300)!;
    expect([seconds(batch.rows)[0], seconds(batch.rows).at(-1), batch.rows.length]).toEqual([1, 300, 300]);
  });

  it('writes a contiguous dropped run as one interval only once it ended, before the next rows', () => {
    const buffer = full();
    for (const s of [301, 302, 303]) buffer.push(P1, row(s));
    // The run is still open while the buffer is full: the batch carries rows only.
    const first = buffer.nextBatch(60)!;
    expect([first.pluginSessionId, first.losses, seconds(first.rows)]).toEqual([P1, [], Array.from({length: 60}, (_, i) => i + 1)]);
    buffer.commit(first);
    // The stored rows freed room, which ends the run; the next batch writes it first.
    const second = buffer.nextBatch(60)!;
    expect([second.losses, seconds(second.rows)[0]]).toEqual([[loss(301, 303, 3)], 61]);
  });

  it('keeps one run with the full count across batches whose writes fail while drops continue', () => {
    const buffer = full();
    // Every batch fails (nothing is committed) while the outage keeps dropping rows.
    for (const s of [301, 302, 303, 304]) { buffer.push(P1, row(s)); expect(buffer.nextBatch(60)!.losses).toEqual([]); }
    expect([buffer.lossCount, buffer.dropped]).toEqual([1, 4]);
    storeRows(buffer, 60);
    // An ended run whose loss write keeps failing stays one unchanged interval.
    for (let attempt = 0; attempt < 3; attempt++) expect(buffer.nextBatch(60)!.losses).toEqual([loss(301, 304, 4)]);
    expect(buffer.lossCount).toBe(1);
  });

  it('keeps the rows dropped after a batch was taken when its loss interval is stored', () => {
    const buffer = full();
    buffer.push(P1, row(301)); buffer.push(P1, row(302));
    // The final write takes the open run (count 2); two more rows are dropped before its interval is stored.
    const batch = buffer.nextBatch(60, true)!;
    expect(batch.losses).toEqual([loss(301, 302, 2)]);
    buffer.push(P1, row(303)); buffer.push(P1, row(304));
    buffer.commitLoss(batch.losses[0]);
    expect([buffer.lossCount, buffer.nextBatch(60, true)!.losses]).toEqual([1, [loss(303, 304, 2)]]);
  });

  it('ends a run when a row of its session is accepted again, so a later drop starts a second run', () => {
    const buffer = full();
    buffer.push(P1, row(301)); buffer.push(P1, row(302));
    storeRows(buffer, 60);
    const first = buffer.nextBatch(60)!;
    expect(first.losses).toEqual([loss(301, 302, 2)]);
    for (const l of first.losses) buffer.commitLoss(l);
    buffer.commit(first);
    // 180 rows are left, so 303-422 are accepted; then the buffer is full again and 423-424 are dropped.
    for (let s = 303; s <= 422; s++) expect(buffer.push(P1, row(s))).toBe(true);
    expect([buffer.push(P1, row(423)), buffer.push(P1, row(424)), buffer.dropped]).toEqual([false, false, 4]);
    storeRows(buffer, 60);
    expect(buffer.nextBatch(60)!.losses).toEqual([loss(423, 424, 2)]);
  });

  it('starts a new run when a dropped row is on another source clock', () => {
    const buffer = full();
    buffer.push(P1, row(301)); buffer.push(P1, row(5, CLOCK_B)); buffer.push(P1, row(6, CLOCK_B));
    expect(buffer.nextBatch(1, true)!.losses).toEqual([loss(301, 301, 1), loss(5, 6, 2, CLOCK_B)]);
  });

  it('merges a run beyond 16 pending runs of a session and clock into the latest one', () => {
    const buffer = full();
    let s = 300;
    // Seventeen outages, each ended by stored rows that are refilled at once; no loss interval is stored.
    for (let n = 0; n < 17; n++) {
      buffer.push(P1, row(++s));
      storeRows(buffer, 1);
      buffer.push(P1, row(++s));
    }
    expect([buffer.rowCount, buffer.lossCount, buffer.dropped]).toEqual([300, 16, 17]);
    const losses = buffer.nextBatch(60)!.losses;
    // Drops 301, 303, ..., 329 are the first sixteen runs; the seventeenth drop (333) extends the sixteenth (331).
    expect([losses.length, losses[0], losses[15]]).toEqual([16, loss(301, 301, 1), loss(331, 333, 2)]);
  });

  it('batches the oldest pending session only, at most maxRows of it in sampling order, then the next session', () => {
    const buffer = new SampleBuffer();
    buffer.push(P1, row(1)); buffer.push(P2, row(7)); buffer.push(P1, row(2)); buffer.push(P1, row(3)); buffer.push(P2, row(8));
    const first = buffer.nextBatch(2)!;
    expect([first.pluginSessionId, seconds(first.rows), first.losses]).toEqual([P1, [1, 2], []]);
    buffer.commit(first);
    expect([buffer.rowCount, buffer.lossCount]).toEqual([3, 0]);
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
    for (let i = 0; i < 5; i++) { const batch = buffer.nextBatch(60)!; expect([batch.pluginSessionId, batch.losses]).toEqual([P1, []]); buffer.commit(batch); }
    const last = buffer.nextBatch(60)!;
    expect([last.pluginSessionId, last.rows, last.losses]).toEqual([P2, [], [loss(9, 9, 1)]]);
    buffer.commitLoss(last.losses[0]);
    expect([buffer.rowCount, buffer.lossCount, buffer.nextBatch(60)]).toEqual([0, 0, undefined]);
  });

  it('keeps rows and loss intervals that were not committed, and keeps a written loss out of the next batch', () => {
    const buffer = full();
    buffer.push(P1, row(301));
    storeRows(buffer, 60);
    buffer.push(P1, row(361));
    const failed = buffer.nextBatch(60)!;
    // Neither part was stored (a failed write): the same loss and rows come back.
    expect(buffer.nextBatch(60)).toEqual(failed);
    // The loss was stored but the rows were not: only the rows come back.
    buffer.commitLoss(failed.losses[0]);
    const retry = buffer.nextBatch(60)!;
    expect([retry.losses, seconds(retry.rows)]).toEqual([[], seconds(failed.rows)]);
    expect([buffer.rowCount, buffer.lossCount]).toEqual([241, 0]);
  });

  it('discards every pending row and loss run and reports the rows', () => {
    const buffer = full();
    buffer.push(P1, row(301));
    expect([buffer.discard(), buffer.rowCount, buffer.lossCount, buffer.nextBatch(60)]).toEqual([300, 0, 0, undefined]);
    // The dropped count is a lifetime count.
    expect(buffer.dropped).toBe(1);
  });
});
