// Per-game display profiles. Profiles select display units only; canonical telemetry units never change.
import type {ConsumptionUnit, DistanceUnit, MassUnit, SpeedUnit, VolumeUnit} from './units';

export const DISPLAY_PROFILE_IDS = ['metric', 'us-customary'] as const;
export type DisplayProfileId = (typeof DISPLAY_PROFILE_IDS)[number];
export type GameId = 'ets2' | 'ats';
/** ET-000 defaults: ETS2 metric, ATS US customary. */
export const DEFAULT_DISPLAY_PROFILE: Readonly<Record<GameId, DisplayProfileId>> = Object.freeze({ets2: 'metric', ats: 'us-customary'});

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
