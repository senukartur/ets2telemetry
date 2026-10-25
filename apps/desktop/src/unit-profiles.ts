import type {GearDisplayMode, GearDisplayModes, LiveTelemetry, UnitGame, UnitProfile, UnitProfiles} from '../../../packages/contracts/src';
import {
  DEFAULT_DISPLAY_PROFILE, DISPLAY_PROFILE_IDS, DISPLAY_PROFILES, GEAR_DISPLAY_MODES, isDisplayProfileId, isGearDisplayMode as isCoreGearDisplayMode,
  type DisplayProfileId, type GameId, type GearDisplayMode as CoreGearDisplayMode
} from '../../../packages/telemetry-core/src/display-profile';
import {fixed} from '../../../packages/telemetry-core/src/format';
import {convertSpeed, convertVolume, type SpeedUnit, type VolumeUnit} from '../../../packages/telemetry-core/src/units';

// Maps persisted per-game settings to telemetry-core display profiles. Conversion constants, conversions and rounding
// live only in packages/telemetry-core; this module never repeats them. Pure, safe for renderer and preload bundles.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-time guard: the contract's profile ids are exactly telemetry-core's `DisplayProfileId`. */
export const PROFILE_IDS_MATCH_TELEMETRY_CORE: Same<UnitProfile, DisplayProfileId> = true;
/** Compile-time guard: the contract's games are exactly telemetry-core's `GameId`. */
export const GAMES_MATCH_TELEMETRY_CORE: Same<UnitGame, GameId> = true;
/** Compile-time guard: the contract's gear display modes are exactly telemetry-core's `GearDisplayMode` (ET-050). */
export const GEAR_DISPLAY_MODES_MATCH_TELEMETRY_CORE: Same<GearDisplayMode, CoreGearDisplayMode> = true;

export const UNIT_GAMES: readonly UnitGame[] = Object.freeze(['ets2', 'ats']);
/** telemetry-core's profile ids, in its order. */
export const UNIT_PROFILE_IDS: readonly UnitProfile[] = DISPLAY_PROFILE_IDS;
/** ET-000 defaults from telemetry-core: ETS2 metric, ATS US customary. */
export const DEFAULT_UNIT_PROFILES: UnitProfiles = DEFAULT_DISPLAY_PROFILE;
/** telemetry-core's gear display modes, in its order (ET-050). */
export const GEAR_DISPLAY_MODE_IDS: readonly GearDisplayMode[] = GEAR_DISPLAY_MODES;
/** Both games show automatic gears 1, 2, 3... until the driver chooses otherwise (ET-050). */
export const DEFAULT_GEAR_DISPLAY: GearDisplayModes = Object.freeze({ets2: 'automatic', ats: 'automatic'});

export function isUnitGame(value: unknown): value is UnitGame {
  return value === 'ets2' || value === 'ats';
}
export function isUnitProfile(value: unknown): value is UnitProfile {
  return isDisplayProfileId(value);
}
export function isGearDisplayMode(value: unknown): value is GearDisplayMode {
  return isCoreGearDisplayMode(value);
}

/**
 * The game whose profile applies to a live update. An explicit synthetic or replay fixture names its game in its own
 * source identity; otherwise only an ETS2 or ATS selection selects a game.
 */
export function displayGame(live: LiveTelemetry): UnitGame | undefined {
  const game = isExplicitFixture(live) ? live.observation?.source.game : live.selection;
  return isUnitGame(game) ? game : undefined;
}
/** A synthetic or replay selection whose observation carries that same origin. */
export function isExplicitFixture(live: LiveTelemetry): boolean {
  return (live.selection === 'synthetic' || live.selection === 'replay') && live.observation?.source.origin === live.selection;
}
/** Without a game the metric profile applies, as in telemetry-core's `resolveDisplayUnits`. */
export function profileFor(units: UnitProfiles, game: UnitGame | undefined): UnitProfile {
  return game ? units[game] : 'metric';
}
/** The game's gear display mode (ET-050); automatic without a game or before the settings arrive. */
export function gearDisplayFor(modes: GearDisplayModes | undefined, game: UnitGame | undefined): GearDisplayMode {
  return game && modes ? modes[game] : 'automatic';
}
/** The gear display mode for a live update, chosen by the same displayed-game rule as its unit profile. */
export function displayGearMode(live: LiveTelemetry | undefined, modes: GearDisplayModes | undefined): GearDisplayMode {
  return gearDisplayFor(modes, live ? displayGame(live) : undefined);
}
/**
 * The profile for displaying a live update: the displayed game's persisted profile, or its ET-000 default before the
 * settings arrive (so an ATS dashboard shows mph and US gallons by default). Metric without an update or a game.
 */
export function displayProfile(live: LiveTelemetry | undefined, units: UnitProfiles = DEFAULT_UNIT_PROFILES): UnitProfile {
  return profileFor(units, live ? displayGame(live) : undefined);
}
export function speedUnit(profile: UnitProfile): SpeedUnit {
  return DISPLAY_PROFILES[profile].speed;
}
export function volumeUnit(profile: UnitProfile): VolumeUnit {
  return DISPLAY_PROFILES[profile].volume;
}
/** Canonical m/s as an integer LIVE number in the profile's speed unit; rounded negative zero shows as 0. */
export function speedNumber(metersPerSecond: number, profile: UnitProfile): string {
  return fixed(convertSpeed(metersPerSecond, speedUnit(profile)), 0);
}
/** Canonical liters as a one-decimal number in the profile's volume unit. */
export function volumeNumber(liters: number, profile: UnitProfile): string {
  return fixed(convertVolume(liters, volumeUnit(profile)), 1);
}
