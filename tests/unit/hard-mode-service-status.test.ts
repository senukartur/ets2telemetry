import {afterEach, describe, expect, it, vi} from 'vitest';
import {HardModeServiceCache} from '../../apps/desktop/src/hard-mode/service-status';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 1000, 'fixture');
const trip = advanceHardMode(null, assessment);
const publication = (remainingNs = '3000000000') => ({type: 'hard-mode', update: 'assessment', assessment, remainingNs});
const tripUpdate = {type: 'hard-mode', update: 'trip', trip};
afterEach(() => vi.restoreAllMocks());
describe('private Hard Mode relative display lifetime', () => {
  it('counts down aged proof without renewal from repeated trip updates or UTC steps, then accepts a genuine publication', () => {
    let mono = 900_000_000_000n, utc = 1000; vi.spyOn(Date, 'now').mockImplementation(() => utc);
    const cache = new HardModeServiceCache(() => mono);
    cache.accept(publication('100000000')); cache.accept(tripUpdate); expect(cache.status(true)).toEqual({assessment, trip});
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
