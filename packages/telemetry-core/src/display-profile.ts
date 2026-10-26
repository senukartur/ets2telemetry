// Per-game display profiles. Profiles select display units only; canonical telemetry units never change.
// The gear display mode (ET-050) selects only how a gear index is presented; the raw integer gear never changes.
import type {ConsumptionUnit, DistanceUnit, MassUnit, SpeedUnit, VolumeUnit} from './units';

export const DISPLAY_PROFILE_IDS = ['metric', 'us-customary'] as const;
export type DisplayProfileId = (typeof DISPLAY_PROFILE_IDS)[number];
export type GameId = 'ets2' | 'ats';
/** ET-000 defaults: ETS2 metric, ATS US customary. */
export const DEFAULT_DISPLAY_PROFILE: Readonly<Record<GameId, DisplayProfileId>> = Object.freeze({ets2: 'metric', ats: 'us-customary'});

/**
 * Gear presentation: `automatic` shows 1, 2, 3...; `manual` shows range-splitter pairs 1L, 1H, 2L, 2H...; `crawler`
 * (ET-050b, owner option B of October 26, 2026) names gear 1 the crawler and numbers the rest 1, 2, 3...
 */
export const GEAR_DISPLAY_MODES = ['automatic', 'manual', 'crawler'] as const;
export type GearDisplayMode = (typeof GEAR_DISPLAY_MODES)[number];
/** Exact mode strings only; nothing is coerced. */
export function isGearDisplayMode(value: unknown): value is GearDisplayMode {
  return typeof value === 'string' && (GEAR_DISPLAY_MODES as readonly string[]).includes(value);
}

export interface DisplayUnitChoice {speed: SpeedUnit; distance: DistanceUnit; volume: VolumeUnit; consumption: ConsumptionUnit; mass: MassUnit}
/** Resolved units plus the profile they started from; per-quantity overrides may differ from that profile. */
export interface DisplayUnits extends DisplayUnitChoice {profile: DisplayProfileId}
export interface DisplaySelection {profile?: DisplayProfileId; overrides?: Partial<DisplayUnitChoice>}

export const DISPLAY_PROFILES: Readonly<Record<DisplayProfileId, Readonly<DisplayUnitChoice>>> = Object.freeze({
  'metric': Object.freeze({speed: 'km/h', distance: 'km', volume: 'L', consumption: 'L/100 km', mass: 't'}),
  'us-customary': Object.freeze({speed: 'mph', distance: 'mi', volume: 'US gal', consumption: 'US mpg', mass: 'lb'})
});
const OPTIONS: {readonly [K in keyof DisplayUnitChoice]: readonly DisplayUnitChoice[K][]} = {
  speed: ['km/h', 'mph'], distance: ['km', 'mi'], volume: ['L', 'US gal'], consumption: ['L/100 km', 'US mpg'], mass: ['t', 'lb']
};

export function isDisplayProfileId(value: unknown): value is DisplayProfileId {
  return typeof value === 'string' && (DISPLAY_PROFILE_IDS as readonly string[]).includes(value);
}

/**
 * Resolves display units for a game. Without a game the metric profile applies. An explicit valid profile replaces
 * the game default, and valid per-quantity overrides replace single units (the seam for later settings). Unknown
 * profile ids or override values are ignored, so a stale stored setting cannot produce an undefined unit.
 */
export function resolveDisplayUnits(game: GameId | undefined, selection?: DisplaySelection): DisplayUnits {
  const profile = isDisplayProfileId(selection?.profile) ? selection.profile : game ? DEFAULT_DISPLAY_PROFILE[game] : 'metric';
  const units: DisplayUnits = {profile, ...DISPLAY_PROFILES[profile]};
  const overrides = selection?.overrides ?? {};
  for (const key of Object.keys(OPTIONS) as (keyof DisplayUnitChoice)[]) {
    const value = overrides[key];
    if (value !== undefined && (OPTIONS[key] as readonly string[]).includes(value)) (units as unknown as Record<string, string>)[key] = value;
  }
  return units;
}
