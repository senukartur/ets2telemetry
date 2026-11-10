import {describe, expect, it} from 'vitest';
import {deriveTripHardModeResult} from '../../packages/telemetry-core/src/hard-mode';

describe('ET-111 / deriveTripHardModeResult', () => {
  it('returns qualified for true', () => {
    expect(deriveTripHardModeResult(true)).toBe('qualified');
  });

  it('returns not-qualified for false', () => {
    expect(deriveTripHardModeResult(false)).toBe('not-qualified');
  });
});
