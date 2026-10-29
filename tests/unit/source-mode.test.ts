import {expect, it} from 'vitest';
import {initialSource, resolveSourceMode} from '../../apps/desktop/src/source-mode';

it('defaults to automatic and preserves explicit game launch priority', () => {
  expect(initialSource({})).toBe('game');
  expect(initialSource({ETS2TELEMETRY_SOURCE_KIND: 'ats'})).toBe('ats');
  expect(resolveSourceMode('ets2', {})).toEqual({kind: 'game', selection: 'ets2'});
});
it.each(['synthetic', 'replay'] as const)('locks %s launches and recording targets even without any endpoint', selection => {
  for (const env of [{ETS2TELEMETRY_SOURCE_KIND: selection}, {ETS2TELEMETRY_RECORDING: `${selection}:isolated`}]) {
    expect(initialSource(env)).toBe(selection);
    for (const requested of ['game', 'ats', 'ets2', selection] as const) expect(resolveSourceMode(requested, env)).toEqual({kind: 'fixture', selection});
  }
});
it('fails closed on invalid and conflicting recording configuration', () => {
  for (const env of [{ETS2TELEMETRY_RECORDING: 'history'}, {ETS2TELEMETRY_RECORDING: 'synthetic:test', ETS2TELEMETRY_SOURCE_KIND: 'replay'},
    {ETS2TELEMETRY_RECORDING: 'synthetic:test', ETS2TELEMETRY_SOURCE_KIND: 'ets2'}]) expect(resolveSourceMode('game', env).kind).toBe('blocked');
});
it('isolates existing smoke/profile/pipe launches without an explicit game source', () => {
  for (const env of [{ETS2TELEMETRY_PROFILE_DIR: 'isolated'}, {ETS2TELEMETRY_LIVE_SMOKE: '1'}, {ETS2TELEMETRY_SOURCE_PIPE_V1: 'missing'}]) {
    expect(initialSource(env)).toBe('synthetic');
    expect(resolveSourceMode('game', env)).toEqual({kind: 'fixture', selection: 'synthetic'});
    expect(resolveSourceMode('ats', {...env, ETS2TELEMETRY_SOURCE_KIND: 'ats'})).toEqual({kind: 'game', selection: 'ats'});
  }
});
