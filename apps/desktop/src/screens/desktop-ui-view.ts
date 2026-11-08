import type {GearDisplayModes, LiveTelemetry, RecordingHealth, PluginTargetView, UnitProfiles} from '../../../../packages/contracts/src';
import type {HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {resolveDisplayUnits} from '../../../../packages/telemetry-core/src/display-profile';
import {fixed} from '../../../../packages/telemetry-core/src/format';
import {convertSpeed} from '../../../../packages/telemetry-core/src/units';
import {liveSources, type LiveSources} from '../live-sources';
import {connectionReasonText} from '../live-dashboard-text';
import {hardModeView} from '../hard-mode/view';
import {t} from '../i18n';
import {appCopy} from './app-copy';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {initialLive} from '../live-state';
import {DEFAULT_UNIT_PROFILES, displayGame, gearDisplayFor, profileFor} from '../unit-profiles';
import {SPEED_GAUGE_FULL_SCALE, speedGaugeFraction} from '../speed-gauge';
/** Geometry only clamps normalized numeric readings; formatted telemetry is never parsed or replaced by demo values. */
export const clampRatio = (value: number | null) => value === null || !Number.isFinite(value) ? null : Math.max(0, Math.min(1, value));
/** `gearDisplay` (ET-050): the per-game gear display mode for `live.instrument.gear`; automatic without settings. */
export function desktopLiveView(live: LiveTelemetry | undefined, profiles: UnitProfiles = DEFAULT_UNIT_PROFILES, gearDisplay?: GearDisplayModes) {
  const telemetry = live ?? initialLive(), game = displayGame(telemetry), profile = profileFor(profiles, game), units = resolveDisplayUnits(game, {profile});
  const sources = liveSources(telemetry, units, gearDisplayFor(gearDisplay, game)), state = sources.v0State, current = sources.v0View.connection.current;
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

/**
 * The dot's animation: a ring spreads while the recorder is active (calm while recording or waiting, busier while
 * opening, urgent while the connection or storage fails), a paused game breathes, and a state that changes only on the
 * user's action or is not recording stays still, so a stopped or disabled recorder never looks busy.
 */
export function recordingMotion(state: RecordingHealth['state'] | undefined): 'calm' | 'busy' | 'urgent' | 'breathe' | 'still' {
  if (state === 'recording' || state === 'waiting') return 'calm';
  if (state === 'opening') return 'busy';
  if (state === 'interrupted' || state === 'retrying') return 'urgent';
  if (state === 'paused') return 'breathe';
  return 'still';
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

export type StatusTone = 'ok' | 'warn' | 'error' | 'neutral';
export interface StatusChip {text: string; tone: StatusTone}
export type ShellRoute = 'live' | 'hardMode' | 'journal' | 'settings' | 'account';
/** The sidebar groups in order (ET-074); the top bar's breadcrumb names the group of the current route. */
export const NAV_GROUPS = [
  {id: 'drive', routes: ['live', 'hardMode', 'journal']},
  {id: 'app', routes: ['settings']},
  {id: 'company', routes: ['account']}
] as const satisfies readonly {id: string; routes: readonly ShellRoute[]}[];
export type NavGroupId = typeof NAV_GROUPS[number]['id'];
export function routeGroup(route: ShellRoute): NavGroupId {
  return NAV_GROUPS.find(group => (group.routes as readonly ShellRoute[]).includes(route))?.id ?? 'drive';
}

/**
 * The top bar's game chip (ET-074). Only what the renderer knows is shown: the game and, while connected, its mode when the
 * v1 evidence is strong enough, else the connection word. Stale and lost connections name their state, never an age.
 */
export function connectionChip(status: LiveTelemetry['status'] | undefined, game: string, mode: string | null, language: AppLanguage = 'en'): StatusChip {
  const word = (value: NonNullable<LiveTelemetry['status']>) => t(`ui.status.${value}`, undefined, language);
  const prefixed = (text: string) => game ? `${game} · ${text}` : text;
  switch (status) {
    case 'connected': return {text: game && mode ? t('chip.game.live', {game, mode}, language) : prefixed(word('connected')), tone: 'ok'};
    case 'paused': return {text: game ? t('chip.game.paused', {game}, language) : word('paused'), tone: 'warn'};
    case 'stale': case 'disconnected': return {text: prefixed(word(status)), tone: 'error'};
    case undefined: case 'waiting': return {text: t('chip.game.waiting', undefined, language), tone: 'neutral'};
    default: return {text: word(status), tone: connectionTone(status)};
  }
}

/** "Plugin n/m": installed targets of the games that are not excluded, with the state words while not all are installed. */
export function pluginChip(targets: readonly Pick<PluginTargetView, 'state'>[], language: AppLanguage = 'en'): StatusChip {
  const managed = targets.filter(target => target.state !== 'excluded').length, installed = targets.filter(target => target.state === 'installed').length;
  const text = !managed ? `${t('ui.plugin', undefined, language)} · ${pluginStatusText(targets, language)}`
    : `${t('chip.plugin', {n: installed, m: managed}, language)}${installed < managed ? ` · ${pluginStatusText(targets, language)}` : ''}`;
  return {text, tone: pluginTone(targets)};
}

/** "Hard Mode n/12" from the current assessment; a loss for this trip and an unknown assessment say so in words. */
export function hardModeChip(status: HardModeStatus, nowUtcMs: number, language: AppLanguage = 'en'): StatusChip {
  const tone = hardModeTone(status);
  if (status.trip?.firstLoss) return {text: t('chip.hm.lost', undefined, language), tone};
  if (status.assessment.state === 'unknown') return {text: t('hm.status.unknown', undefined, language), tone};
  return {text: t('chip.hm.fail', {n: hardModeView(status, nowUtcMs, language).passed}, language), tone};
}

/**
 * One telemetry stream current and the other not, in either direction, exactly when gameConnectionText shows its
 * "connection is incomplete" text: an incompatible v1 source is not partial, because the banner names the version
 * mismatch instead (a parity test in desktop-ui-view.test.ts keeps the two rules equal).
 */
export function liveSourcesPartial(live: LiveTelemetry | undefined): boolean {
  if (!live?.v1 || live.v1.status === 'incompatible') return false;
  const current = (state: {status: string; fresh: boolean}) => state.fresh && (state.status === 'connected' || state.status === 'paused');
  return current(live) !== current(live.v1);
}

/**
 * The Live page state (ET-074): current values are connected or paused; one current stream of two is partial; a lost
 * stream with no current source is stale; anything else waits.
 */
export type LiveScreenState = 'connected' | 'paused' | 'partial' | 'stale' | 'waiting';
export function liveScreenState(status: LiveTelemetry['status'] | undefined, current: boolean, paused: boolean, partial = false): LiveScreenState {
  if (partial) return 'partial';
  if (current) return paused ? 'paused' : 'connected';
  return status === 'stale' || status === 'disconnected' ? 'stale' : 'waiting';
}

/**
 * The game mode for the game chip and the Game session card: v1's current mode evidence through the combiner's freshness.
 * TruckersMP needs strong evidence; single-player is strong evidence or the ordinary weak module scan, which the owner
 * decided on November 2, 2026 to present as single-player (the same rule as journal-view.ts). Anything else is not shown.
 */
export function liveGameMode(sources: Pick<LiveSources, 'v1Current' | 'v1State' | 'field'>): 'single-player' | 'truckersmp' | null {
  const reading = sources.v1State?.gameMode;
  if (!sources.v1Current || sources.field('game-mode').state !== 'value' || reading?.state !== 'value') return null;
  const {mode, confidence, method} = reading.value;
  if (mode === 'truckersmp') return confidence === 'strong' ? 'truckersmp' : null;
  return mode === 'single-player' && (confidence === 'strong' || method === 'module-scan' && confidence === 'weak') ? 'single-player' : null;
}

const NO_NEW_DATA = /(?:no recent (?:v1 )?SDK capture|no recent current observation|awaits a current observation)$/i;
/** The stale reason in the Live subline: the expiry reasons read "no new data from the game", others as the connection reason. */
export function staleReasonText(reason: string | undefined, language: AppLanguage = 'en'): string | null {
  if (!reason) return null;
  return NO_NEW_DATA.test(reason) ? t('live.staleReason', undefined, language) : connectionReasonText(reason, language);
}
/** The Live page subline: what the values are worth now. Only the stale state adds a reason; nothing claims an update rate. */
export function liveSubline(state: LiveScreenState, game: string, reason: string | undefined, language: AppLanguage = 'en'): string {
  const detail = state === 'connected' ? game ? t('live.sub.connected', {game}, language) : t('ui.status.connected', undefined, language) : t(`live.sub.${state}`, undefined, language);
  const why = state === 'stale' ? staleReasonText(reason, language) : null;
  return t('live.sub', {v: why ? `${detail} · ${why}` : detail}, language);
}
