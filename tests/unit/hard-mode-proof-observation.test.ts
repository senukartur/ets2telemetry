import {performance} from 'node:perf_hooks';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import type {HardModeDetails, HardModeObservation, HardModeStatus} from '../../packages/contracts/src/hard-mode';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {waitForHardModeProof, type HardModeProofRecord} from '../../scripts/ci/hard-mode-proof-observation.mjs';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());});
afterEach(() => {vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers();});
const source: SourceIdentity = {game: 'ets2', origin: 'game', processId: 123, windowsSessionId: 1,
  processInstanceId: '10000000-0000-4000-8000-000000000001', pluginSessionId: '20000000-0000-4000-8000-000000000001'};
const passing = (at = 0) => evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), at, 'fixture');
function monitorFixture() {
  const scans: number[] = [], publications: HardModeObservation[] = [];
  let trip: HardModeDetails | null = null;
  const monitor = new HardModeMonitor(() => {
    const first = scans.length === 0; scans.push(Date.now());
    // A completed file read still needs the real monitor's strictly post-read causal probe. Its inFlight spans both.
    setTimeout(() => monitor.select({source, monotonicNs: '100', clockId: 'clock', boundary: {
      clockId: 'clock', probeSentClientNs: (BigInt(Date.now()) * 1_000_000n + 1n).toString(), receivedSourceNs: '200'}}), 1100);
    return new Promise<HardModeObservation>(resolve => setTimeout(() => resolve({assessment: passing(Date.now()),
      binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'}), first ? 0 : 100));
  }, value => {publications.push(value); if (trip) trip = advanceHardMode(trip, value.assessment);}, () => BigInt(Date.now()) * 1_000_000n);
  monitor.select({source, monotonicNs: '100', clockId: 'clock'}); monitor.start();
  const read = vi.fn(() => Promise.resolve({...monitor.status(), trip}));
  // Main's trusted request posts refresh and returns current status; it does not await the monitor's file/bind work.
  const refresh = vi.fn(() => {void monitor.refresh(); return Promise.resolve(monitor.status());});
  return {monitor, scans, publications, read, refresh, open: () => {trip = advanceHardMode(null, monitor.status().assessment);},
    status: () => ({...monitor.status(), trip}), close: () => {trip = null; monitor.close();}};
}

it('reproduces passive polling loss when the periodic tick is coalesced behind post-read binding', async () => {
  const f = monitorFixture();
  try {
    await vi.advanceTimersByTimeAsync(1100); f.open();
    expect(f.status().trip?.firstLoss).toBeNull(); expect(f.scans).toEqual([0]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.scans).toEqual([0, 2000]);
    // This direct reducer port uses unknownHardMode's default source-unproven reason, without the storage adapter.
    expect(f.status().trip?.firstLoss).toMatchObject({atUtcMs: 3100, reason: 'source-unproven'});
    expect(f.publications.slice(-2).map(value => value.assessment.state)).toEqual(['unknown', 'pass']);
  } finally {f.close();}
});

it('drives eligible refreshes through the real monitor and requires two different unlost trip publications', async () => {
  const f = monitorFixture();
  try {
    await vi.advanceTimersByTimeAsync(1000);
    // The initial trusted request is coalesced behind the pending causal bind. Open only after that genuine proof.
    setTimeout(f.open, 100);
    let observed = 0;
    for (let publication = 0; publication < 2; publication++) {
      const record: HardModeProofRecord = {};
      const pending = waitForHardModeProof({refresh: f.refresh, read: f.read, record, message: 'REFRESH',
        accept: status => status.trip?.latest.state === 'pass' && status.trip.latest.observedUtcMs !== observed});
      const outcome = pending.then(value => ({value, error: undefined}), (error: unknown) => ({value: undefined, error}));
      await vi.advanceTimersByTimeAsync(2200);
      const accepted = await outcome;
      expect(accepted.error).toBeUndefined(); expect(accepted.value).toMatchObject({trip: {firstLoss: null}});
      expect(record.lastStatus?.trip?.latest.observedUtcMs).not.toBe(observed);
      observed = record.lastStatus!.trip!.latest.observedUtcMs;
      expect(record.phase).toBe('complete');
    }
    expect(f.scans.slice(0, 2)).toEqual([0, 1100]);
    expect(f.scans.every((stamp, index) => index === 0 || stamp - f.scans[index - 1] >= 1000)).toBe(true);
    expect(f.status().trip?.firstLoss).toBeNull();
  } finally {f.close();}
});

it('keeps trusted refresh and read requests sequential, rejecting a loss before the acceptance predicate', async () => {
  let resolve!: () => void;
  const refresh = vi.fn(() => new Promise<void>(done => {resolve = done;}));
  const status: HardModeStatus = {assessment: passing(), trip: {...advanceHardMode(null, passing()), firstLoss: {atUtcMs: 1, reason: 'interrupted', rule: null, values: null}}};
  const read = vi.fn(() => Promise.resolve(status)), accept = vi.fn(() => true), record: HardModeProofRecord = {};
  const pending = waitForHardModeProof({refresh, read, accept, record, message: 'REFRESH'}), failed = expect(pending).rejects.toThrow('REFRESH_QUALIFICATION_LOST');
  await vi.advanceTimersByTimeAsync(200); expect(refresh).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled();
  resolve(); await failed;
  expect(read).toHaveBeenCalledOnce(); expect(accept).not.toHaveBeenCalled(); expect(record.lastStatus).toEqual(status);
  await vi.advanceTimersByTimeAsync(1000); expect(refresh).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});

it.each(['refresh', 'read', 'accept'] as const)('bounds a hung %s by one eight-second deadline and stops after late settlement', async phase => {
  let resolve!: () => void;
  const held = new Promise<void>(done => {resolve = done;}), status: HardModeStatus = {assessment: passing(), trip: null};
  const refresh = vi.fn(() => phase === 'refresh' ? held : Promise.resolve());
  const read = vi.fn(async () => {if (phase === 'read') await held; return status;});
  const record: HardModeProofRecord = {}, accept = vi.fn(async () => {if (phase === 'accept') await held; return false;});
  const pending = waitForHardModeProof({refresh, read, accept, record, message: 'REFRESH'}), failed = expect(pending).rejects.toThrow('REFRESH within 8000 ms');
  await vi.advanceTimersByTimeAsync(8000); await failed; const counts = [refresh.mock.calls.length, read.mock.calls.length];
  expect(record.elapsedMilliseconds).toBe(8000); resolve(); await vi.advanceTimersByTimeAsync(1000);
  expect([refresh.mock.calls.length, read.mock.calls.length]).toEqual(counts);
  expect(accept).toHaveBeenCalledTimes(phase === 'accept' ? 1 : 0); expect(vi.getTimerCount()).toBe(0);
});

it('never accepts an unchanged observed stamp or resets its deadline while polling', async () => {
  const status: HardModeStatus = {assessment: passing(), trip: advanceHardMode(null, passing())}, record: HardModeProofRecord = {};
  const pending = waitForHardModeProof({refresh: () => Promise.resolve(), read: () => Promise.resolve(status), record, message: 'REFRESH',
    accept: value => value.trip!.latest.observedUtcMs !== 0}), failed = expect(pending).rejects.toThrow('REFRESH within 8000 ms');
  await vi.advanceTimersByTimeAsync(8000); await failed;
  expect(record.elapsedMilliseconds).toBe(8000); expect(record.lastStatus).toEqual(status); expect(vi.getTimerCount()).toBe(0);
});

it('propagates trusted request rejection and stops without another poll', async () => {
  const error = new Error('Trusted refresh failed'), refresh = vi.fn(() => Promise.reject(error)), read = vi.fn();
  await expect(waitForHardModeProof({refresh, read, accept: () => true, record: {}, message: 'REFRESH'})).rejects.toBe(error);
  expect(read).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
