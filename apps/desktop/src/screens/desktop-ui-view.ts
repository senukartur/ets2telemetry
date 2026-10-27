import type {GearboxGearDisplays, GearDisplayModes, LiveTelemetry, RecordingHealth, PluginTargetView, UnitProfiles} from '../../../../packages/contracts/src';
import type {HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {resolveDisplayUnits} from '../../../../packages/telemetry-core/src/display-profile';
import {fixed} from '../../../../packages/telemetry-core/src/format';
import {convertSpeed} from '../../../../packages/telemetry-core/src/units';
import {liveSources} from '../live-sources';
import {appCopy} from './app-copy';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {initialLive} from '../live-state';
import {DEFAULT_UNIT_PROFILES, displayGame, gearDisplayFor, profileFor} from '../unit-profiles';
import {SPEED_GAUGE_FULL_SCALE, speedGaugeFraction} from '../speed-gauge';
/** Geometry only clamps normalized numeric readings; formatted telemetry is never parsed or replaced by demo values. */
export const clampRatio = (value: number | null) => value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
/** `gearDisplay` (ET-050): the per-game gear display mode for `live.instrument.gear`; automatic without settings. */
export function desktopLiveView(live: LiveTelemetry | undefined, profiles: UnitProfiles = DEFAULT_UNIT_PROFILES, gearDisplay?: GearDisplayModes, gearboxes?: GearboxGearDisplays) {
  const telemetry = live ?? initialLive(), game = displayGame(telemetry), profile = profileFor(profiles, game), units = resolveDisplayUnits(game, {profile});
  const sources = liveSources(telemetry, units, gearDisplayFor(gearDisplay, game, gearboxes)), state = sources.v0State, current = sources.v0View.connection.current;
  const metersPerSecond = current && state?.speed.state === 'value' ? state.speed.value : null;
  const speed = metersPerSecond === null ? null : convertSpeed(metersPerSecond, units.speed);
  const rpm = current && state?.engineRpm.state === 'value' ? state.engineRpm.value : null;
  const fuel = current && state?.fuel.state === 'value' && state.fuelCapacity.state === 'value' && state.fuelCapacity.value > 0 ? state.fuel.value / state.fuelCapacity.value : null;
  const scaleMax = SPEED_GAUGE_FULL_SCALE[units.speed], speedText = speed === null ? '—' : fixed(speed, 0);
  // ET-045a: the speed arc follows the displayed integer, so a reading that shows 0 draws no arc (a round line cap
  // would paint a dot that blinks as the SDK speed flickers around zero). Above 0 the ratio keeps its fractional precision.
  // ET-045f: the Cluster overlay's speed arc shares this rule and scale (speed-gauge.ts).
  const speedRatio = metersPerSecond === null ? null : speedGaugeFraction(metersPerSecond, profile) ?? null;
  return {sources, units, current, speed, speedText, rpm, scaleMax, speedRatio, rpmRatio: clampRatio(rpm === null ? null : rpm / 3000), fuelRatio: clampRatio(fuel)};
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
