import {describe, expect, it} from 'vitest';
import {applicationInfoOrFallback, parseApplicationInfo, UNKNOWN_APP_VERSION} from '../../apps/desktop/src/updater/update-view';

// ET-055 UP9 (review round 2): main's application info and its fixed fallback. An invalid build version must never make
// the preload drop the application state; the fallback keeps the channel and packaged flag it can trust.

describe('applicationInfoOrFallback', () => {
  it('keeps valid application info and reports it as valid', () => {
    for (const info of [{version: '0.1.1', channel: 'production', packaged: true}, {version: '0.2.0-stg.000042', channel: 'staging', packaged: false}] as const)
      expect(applicationInfoOrFallback(info)).toEqual({info, valid: true});
  });
  it('replaces an invalid version with 0.0.0 and keeps a known channel and the packaged flag', () => {
    expect(UNKNOWN_APP_VERSION).toBe('0.0.0');
    expect(applicationInfoOrFallback({version: 'not-a-version', channel: 'staging', packaged: true}))
      .toEqual({info: {version: '0.0.0', channel: 'staging', packaged: true}, valid: false});
    expect(applicationInfoOrFallback({version: '..\\..\\Update.exe', channel: 'production', packaged: false}))
      .toEqual({info: {version: '0.0.0', channel: 'production', packaged: false}, valid: false});
    expect(parseApplicationInfo(applicationInfoOrFallback({version: ''}).info)).toBeDefined();
  });
  it('uses the build channel for an unknown channel, never a guess from the value', () => {
    expect(applicationInfoOrFallback({version: '0.1.1', channel: 'beta', packaged: true}, 'staging'))
      .toEqual({info: {version: '0.0.0', channel: 'staging', packaged: true}, valid: false});
    expect(applicationInfoOrFallback({version: '0.1.1', channel: 'beta', packaged: true}, 'production').info.channel).toBe('production');
    // Unbundled code (Vitest) is the production build.
    expect(applicationInfoOrFallback(undefined)).toEqual({info: {version: '0.0.0', channel: 'production', packaged: false}, valid: false});
    expect(applicationInfoOrFallback({version: '0.1.1', channel: 'staging', packaged: 'yes'}, 'production'))
      .toEqual({info: {version: '0.0.0', channel: 'staging', packaged: false}, valid: false});
  });
});
