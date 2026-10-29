import type {SourceSelection} from '../../../packages/contracts/src';
import {sourceSelection} from './live-state';

type Environment = Readonly<Record<string, string | undefined>>;
export type SourceMode = {kind: 'game' | 'fixture'; selection: SourceSelection} | {kind: 'blocked'; selection: SourceSelection; reason: string};
const fixture = (value: string | undefined): value is 'synthetic' | 'replay' => value === 'synthetic' || value === 'replay';
export function initialSource(env: Environment): SourceSelection {
  if (env.ETS2TELEMETRY_SOURCE_KIND) return resolveSourceMode(sourceSelection(env.ETS2TELEMETRY_SOURCE_KIND), env).selection;
  const recording = /^(synthetic|replay):[a-z0-9-]{1,64}$/.exec(env.ETS2TELEMETRY_RECORDING ?? '');
  if (recording) return recording[1] as 'synthetic' | 'replay';
  return isolated(env) ? 'synthetic' : 'game';
}
function isolated(env: Environment): boolean {
  return !!(env.ETS2TELEMETRY_SOURCE_PIPE || env.ETS2TELEMETRY_SOURCE_PIPE_V1 || env.ETS2TELEMETRY_PROFILE_DIR || env.ETS2TELEMETRY_LIVE_SMOKE === '1');
}
/** Launch fixtures stay isolated for the entire run, including missing endpoints and renderer selections. */
export function resolveSourceMode(requested: SourceSelection, env: Environment): SourceMode {
  const explicit = env.ETS2TELEMETRY_SOURCE_KIND;
  const target = env.ETS2TELEMETRY_RECORDING;
  const recording = target ? /^(synthetic|replay):[a-z0-9-]{1,64}$/.exec(target) : undefined;
  if (target && (!recording || (explicit && explicit !== recording[1]))) return {kind: 'blocked', selection: requested, reason: 'Conflicting fixture source configuration'};
  const locked = fixture(explicit) ? explicit : recording?.[1] as 'synthetic' | 'replay' | undefined;
  if (locked) return {kind: 'fixture', selection: locked};
  if (fixture(requested)) return {kind: 'fixture', selection: requested};
  if (isolated(env) && explicit !== 'ets2' && explicit !== 'ats') return {kind: 'fixture', selection: 'synthetic'};
  return {kind: 'game', selection: requested};
}
