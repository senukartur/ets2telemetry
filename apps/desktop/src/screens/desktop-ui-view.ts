import type {LiveTelemetry, RecordingHealth, PluginTargetView, UnitProfiles} from '../../../../packages/contracts/src';
import type {HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {resolveDisplayUnits} from '../../../../packages/telemetry-core/src/display-profile';
import {fixed} from '../../../../packages/telemetry-core/src/format';
import {convertSpeed} from '../../../../packages/telemetry-core/src/units';
import {liveSources} from '../live-sources';
import {appCopy} from './app-copy';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {initialLive} from '../live-state';
import {DEFAULT_UNIT_PROFILES, displayGame, profileFor} from '../unit-profiles';
/** Geometry only clamps normalized numeric readings; formatted telemetry is never parsed or replaced by demo values. */
export const clampRatio = (value: number | null) => value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
export function desktopLiveView(live: LiveTelemetry | undefined, profiles: UnitProfiles = DEFAULT_UNIT_PROFILES) {
  const telemetry = live ?? initialLive(), game = displayGame(telemetry), profile = profileFor(profiles, game), units = resolveDisplayUnits(game, {profile});
  const sources = liveSources(telemetry, units), state = sources.v0State, current = sources.v0View.connection.current;
  const speed = current && state?.speed.state === 'value' ? convertSpeed(state.speed.value, units.speed) : null;
  const rpm = current && state?.engineRpm.state === 'value' ? state.engineRpm.value : null;
  const fuel = current && state?.fuel.state === 'value' && state.fuelCapacity.state === 'value' && state.fuelCapacity.value > 0 ? state.fuel.value / state.fuelCapacity.value : null;
  const scaleMax = units.speed === 'mph' ? 80 : 130;
  return {sources, units, current, speed, speedText: speed === null ? '—' : fixed(speed, 0), rpm, scaleMax, speedRatio: clampRatio(speed === null ? null : speed / scaleMax), rpmRatio: clampRatio(rpm === null ? null : rpm / 3000), fuelRatio: clampRatio(fuel)};
}
export function gaugeArc(radius: number, start: number, end: number, center = 130): string {
  const point = (angle: number) => {const rad = angle * Math.PI / 180; return [center + radius * Math.sin(rad), center - radius * Math.cos(rad)];};
  const a = point(start), b = point(end);
  return `M${a[0]} ${a[1]} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b[0]} ${b[1]}`;
}

/** The dot reinforces the recording words; disabled or unavailable must never imply active recording. */
export function recordingTone(state: RecordingHealth['state'] | undefined): 'ok' | 'warn' | 'error' | 'neutral' {
  if (state === 'recording') return 'ok';
  if (state === 'paused' || state === 'waiting' || state === 'opening') return 'warn';
  if (state === 'retrying' || state === 'interrupted' || state === 'stopped') return 'error';
  return 'neutral';
}

export function connectionTone(status: LiveTelemetry['status'] | undefined): 'ok' | 'warn' | 'error' | 'neutral' {
  switch (status) {
    case 'connected': return 'ok';
    case 'paused': return 'warn';
    case 'stale': case 'disconnected': case 'incompatible': case 'service-failed': return 'error';
    default: return 'neutral';
  }
}
export function pluginTone(targets: readonly Pick<PluginTargetView, 'state'>[]): 'ok' | 'warn' | 'error' | 'neutral' {
  if (targets.some(target => target.state === 'blocked')) return 'error';
  if (targets.some(target => target.state === 'outdated' || target.state === 'working')) return 'warn';
  return targets.length && targets.every(target => target.state === 'installed') ? 'ok' : 'neutral';
}
export function hardModeTone(status: HardModeStatus): 'ok' | 'warn' | 'error' | 'neutral' {
  if (status.trip?.firstLoss) return 'error';
  return status.assessment.state === 'pass' ? 'ok' : status.assessment.state === 'fail' ? 'warn' : 'neutral';
}

export function pluginStatusText(targets: readonly Pick<PluginTargetView, 'state'>[], language: AppLanguage = 'en'): string {
  const state = targets.some(target => target.state === 'blocked') ? 'Blocked'
    : targets.some(target => target.state === 'outdated') ? 'Older version installed'
    : targets.some(target => target.state === 'working') ? 'Setting up…'
    : targets.length && targets.every(target => target.state === 'installed') ? 'Installed'
    : targets.some(target => target.state === 'missing') ? 'Not installed'
    : targets.length && targets.every(target => target.state === 'excluded') ? 'Not managed (game excluded)' : 'Unknown';
  return appCopy(state, language);
}
