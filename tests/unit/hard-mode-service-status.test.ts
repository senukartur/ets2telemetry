import {afterEach, describe, expect, it, vi} from 'vitest';
import {HardModeServiceCache} from '../../apps/desktop/src/hard-mode/service-status';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture');
const trip = advanceHardMode(null, assessment);
const VERIFIED = {state: 'verified', reason: null, checking: false, lastCheck: null} as const;
const publication = (remainingNs = '3000000000') => ({type: 'hard-mode', update: 'assessment', assessment, verification: VERIFIED, remainingNs});
const tripUpdate = {type: 'hard-mode', update: 'trip', trip};
afterEach(() => vi.restoreAllMocks());
describe('private Hard Mode relative display lifetime', () => {
  it('keeps an old verified assessment while memory health publications continue and expires after they stop',()=>{
    let mono=0n;const cache=new HardModeServiceCache(()=>mono);
    for(let second=0;second<=60;second++){mono=BigInt(second)*1_000_000_000n;cache.accept(publication());expect(cache.status(true).assessment).toEqual(assessment);}
    mono+=3_000_000_000n;cache.accept(tripUpdate);expect(cache.status(true).assessment.state).toBe('unknown');
    cache.retire();cache.accept(tripUpdate);expect(cache.status(true).assessment.state).toBe('unknown');
  });
  it('counts down aged proof without renewal from repeated trip updates or UTC steps, then accepts a genuine publication', () => {
    let mono = 900_000_000_000n, utc = 1000; vi.spyOn(Date, 'now').mockImplementation(() => utc);
    const cache = new HardModeServiceCache(() => mono);
    cache.accept(publication('100000000')); cache.accept(tripUpdate); expect(cache.status(true)).toEqual({assessment, trip, verification: VERIFIED});
    mono += 50_000_000n; utc += 120_000; cache.accept(tripUpdate); expect(cache.status(true).assessment.state).toBe('pass');
    mono += 50_000_000n; utc = 1; cache.accept(tripUpdate); expect(cache.status(true)).toMatchObject({assessment: {state: 'unknown'}, trip});
    mono += 5_000_000_000n; cache.accept(tripUpdate); expect(cache.status(true).assessment.state).toBe('unknown');
    cache.accept(publication()); expect(cache.status(true).assessment).toEqual(assessment);
    expect(cache.status(false)).toMatchObject({assessment: {state: 'unknown'}, trip});
    cache.retire(); expect(cache.status(true)).toMatchObject({assessment: {state: 'unknown'}, trip: null});
    cache.accept(tripUpdate); expect(cache.status(true).assessment.state).toBe('unknown');
  });
  it.each([undefined, null, 0, -1, '01', '-1', '3000000001', '1e9', '', {}, 'Infinity'])('fails closed for a malformed/missing remaining lifetime: %j', remainingNs => {
    const cache = new HardModeServiceCache(() => 0n); cache.accept(publication());
    cache.accept({...publication(), remainingNs}); cache.accept(tripUpdate);
    expect(cache.status(true)).toMatchObject({assessment: {state: 'unknown'}, trip});
  });
  it('refuses zero lifetime, extra envelope fields, malformed trip updates and a backwards local clock', () => {
    let mono = 100n; const cache = new HardModeServiceCache(() => mono);
    for (const message of [publication('0'), {...publication(), path: 'private'}, {type: 'hard-mode', update: 'trip', trip: {...trip, path: 'private'}}]) {
      cache.accept(publication()); cache.accept(message); expect(cache.status(true).assessment.state).toBe('unknown');
    }
    cache.accept(publication()); mono = 0n; expect(cache.status(true).assessment.state).toBe('unknown');
  });
});
describe('ET-070 lease expiry notification for the overlay indicator', () => {
  afterEach(() => vi.useRealTimers());
  // Main's monotonic clock follows the fake timers: 1 ms of fake time is 1_000_000 ns.
  const timed = () => {
    vi.useFakeTimers(); const start = Date.now(), expired = vi.fn();
    return {expired, cache: new HardModeServiceCache(() => BigInt(Date.now() - start) * 1_000_000n, expired)};
  };
  it('calls back exactly once when a 3 s lease ends, and the status is then unknown', async () => {
    const {cache, expired} = timed(); cache.accept(publication());
    await vi.advanceTimersByTimeAsync(2999); expect(expired).not.toHaveBeenCalled(); expect(cache.status(true).assessment).toEqual(assessment);
    await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledOnce(); expect(cache.status(true).assessment.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(10_000); expect(expired).toHaveBeenCalledOnce();
  });
  it('re-arms on a renewal: a lease renewed at 2 s for 3 s ends at 5 s', async () => {
    const {cache, expired} = timed(); cache.accept(publication());
    await vi.advanceTimersByTimeAsync(2000); cache.accept(publication());
    await vi.advanceTimersByTimeAsync(2999); expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledOnce();
  });
  it('rounds a sub-millisecond rest up: a 1.5 ms lease ends after 2 ms, not 1', async () => {
    const {cache, expired} = timed(); cache.accept(publication('1500000'));
    await vi.advanceTimersByTimeAsync(1); expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledOnce();
  });
  it('re-arms for the rest of the lease when the timer fires before main\'s clock reaches its end', async () => {
    vi.useFakeTimers(); let mono = 0n; const expired = vi.fn(), cache = new HardModeServiceCache(() => mono, expired);
    cache.accept(publication());
    // 3000 ms of timer time pass while the monotonic clock advanced only 1 s: 2 s of the lease remain, so it waits 2000 ms more.
    mono = 1_000_000_000n; await vi.advanceTimersByTimeAsync(3000); expect(expired).not.toHaveBeenCalled();
    mono = 2_999_000_000n; await vi.advanceTimersByTimeAsync(1999); expect(expired).not.toHaveBeenCalled();
    // At the re-armed timer the clock is at 3.0 s: the lease has ended.
    mono = 3_000_000_000n; await vi.advanceTimersByTimeAsync(1); expect(expired).toHaveBeenCalledOnce();
  });
  it('expires a zero lease on the next timer turn', async () => {
    const {cache, expired} = timed(); cache.accept(publication('0'));
    expect(expired).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(0); expect(expired).toHaveBeenCalledOnce();
  });
  it('cancels the timer on retirement and on a malformed message, and a trip update does not arm it', async () => {
    const retired = timed(); retired.cache.accept(publication()); retired.cache.retire();
    await vi.advanceTimersByTimeAsync(10_000); expect(retired.expired).not.toHaveBeenCalled();
    const invalidated = timed(); invalidated.cache.accept(publication()); invalidated.cache.accept({...publication(), path: 'private'});
    await vi.advanceTimersByTimeAsync(10_000); expect(invalidated.expired).not.toHaveBeenCalled();
    const tripOnly = timed(); tripOnly.cache.accept(tripUpdate);
    await vi.advanceTimersByTimeAsync(10_000); expect(tripOnly.expired).not.toHaveBeenCalled();
  });
});
describe('ET-112d profile verification in the status reply (REG-011, REG-012)', () => {
  const unknown = evaluateHardMode({}, 1000, 'local');
  const lastCheck = {atUtcMs: 900, state: 'unverified', reason: 'game-log'} as const;
  const unverified = {state: 'unverified', reason: 'game-log', checking: false, lastCheck} as const;
  const waiting = (last: typeof lastCheck | null) => ({state: 'waiting', reason: 'no-game', checking: false, lastCheck: last});
  const published = (verification: unknown, value: unknown = unknown) => ({type: 'hard-mode', update: 'assessment', assessment: value, verification, remainingNs: '3000000000'});
  it('passes an accepted verification through while the lease is valid and the service is ready', () => {
    const cache = new HardModeServiceCache(() => 0n); cache.accept(published(unverified));
    expect(cache.status(true)).toEqual({assessment: unknown, trip: null, verification: unverified});
  });
  it.each([
    ['an extra key', {...unverified, code: 'PROFILE_LOG_GENERATION'}],
    ['an unknown reason', {...unverified, reason: 'C:/private/log.txt'}],
    ['unverified without a reason', {...unverified, reason: null}],
    ['verified with a reason', {...VERIFIED, reason: 'game-log'}],
    ['waiting for a failure reason', {...unverified, state: 'waiting'}],
    ['a last check with an extra key', {...unverified, lastCheck: {...lastCheck, path: 'private'}}],
    ['a last check that is verified with a reason', {...unverified, lastCheck: {...lastCheck, state: 'verified'}}],
    ['a missing verification', undefined]
  ])('rejects %s and falls back to waiting', (_name, verification) => {
    const cache = new HardModeServiceCache(() => 0n); cache.accept(published(unverified)); cache.accept(published(verification));
    expect(cache.status(true)).toMatchObject({assessment: {state: 'unknown'}, verification: waiting(lastCheck)});
  });
  it('rejects a passing assessment that claims an unverified profile', () => {
    const cache = new HardModeServiceCache(() => 0n); cache.accept(publication()); cache.accept(published(unverified, assessment));
    expect(cache.status(true)).toMatchObject({assessment: {state: 'unknown'}, verification: {state: 'waiting', reason: 'no-game'}});
  });
  it('shows waiting for game telemetry, never unverified, after the lease or the service, and keeps the last check', () => {
    let mono = 0n; const cache = new HardModeServiceCache(() => mono); cache.accept(published(unverified));
    expect(cache.status(false)).toEqual({assessment: expect.objectContaining({state: 'unknown'}), trip: null, verification: waiting(lastCheck)});
    mono = 3_000_000_000n; expect(cache.status(true).verification).toEqual(waiting(lastCheck));
  });
  it('marks a requested check as running until the next publication, and retirement clears the last check', () => {
    const cache = new HardModeServiceCache(() => 0n); cache.accept(published(unverified));
    cache.checkRequested(); expect(cache.status(true).verification).toEqual({...unverified, checking: true});
    cache.accept(published(unverified)); expect(cache.status(true).verification).toEqual(unverified);
    cache.retire(); expect(cache.status(true).verification).toEqual(waiting(null));
  });
});
