import {DEFAULT_OVERLAY_OPACITY, isOverlayOpacity} from './overlay-opacity';
import type {AppLanguage, GearDisplayMode, GearDisplayModes, OverlayLayout, OverlayPlacement, OverlaySectionId, OverlaySections, OverlaySettings, UnitGame, UnitProfiles} from '../../../packages/contracts/src';
import {DEFAULT_OVERLAY_PLACEMENTS, normalizeFraction, normalizeScale, parseOverlayPlacement} from './overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, DEFAULT_OVERLAY_SETTINGS, isOverlayLayout, OVERLAY_LAYOUTS, OVERLAY_SECTION_IDS} from './overlay-sections';
import {DEFAULT_GEAR_DISPLAY, DEFAULT_UNIT_PROFILES, isGearDisplayMode, isUnitProfile, UNIT_GAMES} from './unit-profiles';

// Settings file format v11 (docs/settings.md). Pure parsing and serialization; the store owns file access.

export const SETTINGS_FORMAT = 'ets2telemetry.settings';
export const SETTINGS_VERSION = 11;
/** Larger files are rejected as invalid without being parsed. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export const APP_LANGUAGES: readonly AppLanguage[] = Object.freeze(['en', 'ru'] as const);
export const DEFAULT_APP_LANGUAGE: AppLanguage = 'en';

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'en' || value === 'ru';
}

export interface Settings {
  language: AppLanguage;
  autostart: boolean;
  units: UnitProfiles;
  /** Per-game gear display mode (ET-050). */
  gearDisplay: GearDisplayModes;
  overlay: OverlaySettings;
}
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  language: DEFAULT_APP_LANGUAGE,
  autostart: false,
  units: DEFAULT_UNIT_PROFILES,
  gearDisplay: DEFAULT_GEAR_DISPLAY,
  overlay: DEFAULT_OVERLAY_SETTINGS
});

/** Field paths that can fall back to their default independently. */
export type SettingsField = 'overlay.backgroundOpacity' | 'overlay.enabled' | 'language' | 'autostart' | `units.${UnitGame}` | `gearDisplay.${UnitGame}` | 'overlay.layout' | 'overlay.sections' | `overlay.sections.${OverlaySectionId}`
  | 'overlay.placements' | `overlay.placements.${OverlayLayout}`;
/** Set when the file was upgraded in memory from an older format; the file itself stays unchanged until the next save. */
type Migrated = {migratedFrom?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10};
export type ParsedSettings =
  | ({state: 'loaded'; settings: Settings} & Migrated)
  /** A valid file with some invalid or missing fields; they use defaults until the next save rewrites them. */
  | ({state: 'loaded-with-fallbacks'; settings: Settings; fallbackFields: SettingsField[]} & Migrated)
  /** Not UTF-8, not a JSON object, the wrong format marker, a malformed version or too large. */
  | {state: 'invalid-file'}
  /** A version below 1 or no version: there is no migration path, so defaults apply. */
  | {state: 'unsupported-older'}
  /** A later version: defaults apply and the file is never modified by this version. */
  | {state: 'newer-version'};

const placementDocument = ({x, y, scale}: OverlayPlacement) => ({x, y, scale});
const defaultPlacementsDocument = () => Object.fromEntries(OVERLAY_LAYOUTS.map(layout => [layout, placementDocument(DEFAULT_OVERLAY_PLACEMENTS[layout])]));
const defaultOverlayDocument = () => ({layout: DEFAULT_OVERLAY_SETTINGS.layout, sections: {...DEFAULT_OVERLAY_SECTIONS}});
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/**
 * Migrations from older format versions, keyed by source version. Each step is a pure `raw -> raw` function that never
 * mutates its input. v1 -> v2 adds the overlay block with its defaults (strip, every section); the v1 units then pass
 * the normal validation, so an invalid v1 unit still falls back alone. v2 -> v3 adds the default placements of every
 * layout to an overlay block (ET-012b); a v2 overlay that is not an object stays as it is and falls back as a whole.
 * v3 -> v4 adds the interface language (ET-029). v4 -> v5 adds autostart false (accepted ET-031).
 * v5 -> v6 adds overlay visibility true, preserving the accepted autostart preference (ET-012e integration).
 * v6 -> v7 adds backgroundOpacity 80, retaining the current visual default (ET-049).
 * v7 -> v8 changes only the version (ET-045e decision Z5, owner decision D1 option b; ET-049 took v7 first): every saved
 * scale number is kept and now means a setting whose zoom is setting × 0.7, valid in [0.5, 3] instead of [0.5, 2]. The
 * bump makes an older build read a v8 file as newer-version (read-only defaults) instead of misreading the rebased
 * numbers or replacing a scale above 2 with its default on the next save. A hand-edited earlier scale in (2, 3] passes
 * after this migration.
 * v8 -> v9 adds automatic gear display for both games (ET-050). A stray pre-v9 `gearDisplay` key is replaced, so an
 * older file never carries a hand-edited mode into v9; the bump makes an older build read a v9 file as newer-version
 * instead of dropping the mode on its next save.
 * v9 -> v10 changes only the version (ET-050b, owner option B of October 26, 2026): v10 adds the `crawler` gear display
 * mode, and the bump makes an older build read a v10 file as newer-version (read-only defaults) instead of replacing an
 * unknown `crawler` mode with automatic on its next save. Every v9 mode is kept.
 * v10 -> v11 adds the overlay section `mandatory-break`, switched on (ET-052 MB11, owner decision D2: on by default, also for
 * upgraders; ET-050b took v10 first). It is set on a copy of an `overlay.sections` record, so every other saved choice is
 * preserved, including a user who switched other sections off; anything that is not a record is left to the existing
 * fallbacks. The bump makes an older build read a v11 file as newer-version (read-only defaults) instead of ignoring the new
 * key and dropping it on its next save.
 * Version 0 and below have no path.
 */
const MIGRATIONS: ReadonlyMap<number, (raw: Record<string, unknown>) => Record<string, unknown>> = new Map<number, (raw: Record<string, unknown>) => Record<string, unknown>>([
  [1, (raw: Record<string, unknown>) => ({...raw, version: 2, overlay: defaultOverlayDocument()})],
  [2, (raw: Record<string, unknown>) => ({...raw, version: 3, overlay: isRecord(raw.overlay) ? {...raw.overlay, placements: defaultPlacementsDocument()} : raw.overlay})],
  [3, (raw: Record<string, unknown>) => ({...raw, version: 4, language: 'en'})],
  [4, (raw: Record<string, unknown>) => ({...raw, version: 5, autostart: false})],
  [5, (raw: Record<string, unknown>) => ({...raw, version: 6, overlay: isRecord(raw.overlay) ? {...raw.overlay, enabled: true} : raw.overlay})],
  [6, (raw: Record<string, unknown>) => ({...raw, version: 7, overlay: isRecord(raw.overlay) ? {...raw.overlay, backgroundOpacity: DEFAULT_OVERLAY_OPACITY} : raw.overlay})],
  [7, (raw: Record<string, unknown>) => ({...raw, version: 8})],
  [8, (raw: Record<string, unknown>) => ({...raw, version: 9, gearDisplay: {ets2: DEFAULT_GEAR_DISPLAY.ets2, ats: DEFAULT_GEAR_DISPLAY.ats}})],
  [9, (raw: Record<string, unknown>) => ({...raw, version: 10})],
  [10, (raw: Record<string, unknown>) => ({...raw, version: 11,
    overlay: isRecord(raw.overlay) && isRecord(raw.overlay.sections) ? {...raw.overlay, sections: {...raw.overlay.sections, 'mandatory-break': true}} : raw.overlay})]
]);

/** Upgrades an older raw document to the current version through the migration chain, or undefined without a complete path. */
export function migrateToCurrent(raw: Record<string, unknown>, version: number): Record<string, unknown> | undefined {
  let current = raw;
  for (let step = version; step < SETTINGS_VERSION; step++) {
    const migrate = MIGRATIONS.get(step);
    if (!migrate) return undefined;
    current = migrate(current);
  }
  return current;
}

/** The section record; a record that is not an object, or one that enables nothing, falls back as a whole. */
function parseSections(raw: unknown, fallbackFields: SettingsField[]): OverlaySections {
  if (!isRecord(raw)) {fallbackFields.push('overlay.sections'); return DEFAULT_OVERLAY_SECTIONS;}
  const sections = {} as Record<OverlaySectionId, boolean>;
  const sectionFallbacks: SettingsField[] = [];
  for (const id of OVERLAY_SECTION_IDS) {
    const enabled = raw[id];
    if (typeof enabled === 'boolean') sections[id] = enabled;
    else {sections[id] = DEFAULT_OVERLAY_SECTIONS[id]; sectionFallbacks.push(`overlay.sections.${id}`);}
  }
  // A record that enables nothing would hide the whole overlay: every section falls back together.
  if (!OVERLAY_SECTION_IDS.some(id => sections[id])) {fallbackFields.push('overlay.sections'); return DEFAULT_OVERLAY_SECTIONS;}
  fallbackFields.push(...sectionFallbacks);
  return Object.freeze(sections);
}

/**
 * The placements; a missing or non-object record falls back as a whole, and each layout's placement falls back alone
 * when its x or y is not a finite number in [0, 1] or its scale not one in [0.5, 3]. Out-of-range values are never clamped.
 */
function parsePlacements(raw: unknown, fallbackFields: SettingsField[]): OverlaySettings['placements'] {
  if (!isRecord(raw)) {fallbackFields.push('overlay.placements'); return DEFAULT_OVERLAY_PLACEMENTS;}
  const placements = {} as Record<OverlayLayout, OverlayPlacement>;
  for (const layout of OVERLAY_LAYOUTS) {
    const placement = parseOverlayPlacement(raw[layout]);
    if (placement) placements[layout] = placement;
    else {placements[layout] = DEFAULT_OVERLAY_PLACEMENTS[layout]; fallbackFields.push(`overlay.placements.${layout}`);}
  }
  return Object.freeze(placements);
}

/** The overlay block with per-field fallbacks; a missing or non-object block falls back as a whole. */
function parseOverlay(value: unknown, fallbackFields: SettingsField[]): OverlaySettings {
  const overlay = isRecord(value) ? value : {};
  let layout = DEFAULT_OVERLAY_SETTINGS.layout;
  if (isOverlayLayout(overlay.layout)) layout = overlay.layout;
  else fallbackFields.push('overlay.layout');
  const sections = parseSections(overlay.sections, fallbackFields);
  const placements = parsePlacements(overlay.placements, fallbackFields);
  const enabled = typeof overlay.enabled === 'boolean' ? overlay.enabled : DEFAULT_OVERLAY_SETTINGS.enabled;
  if (typeof overlay.enabled !== 'boolean') fallbackFields.push('overlay.enabled');
  const backgroundOpacity = isOverlayOpacity(overlay.backgroundOpacity) ? overlay.backgroundOpacity : DEFAULT_OVERLAY_OPACITY;
  if (!isOverlayOpacity(overlay.backgroundOpacity)) fallbackFields.push('overlay.backgroundOpacity');
  return {enabled, backgroundOpacity, layout, sections, placements};
}

/** Classifies settings bytes. A leading UTF-8 byte order mark is accepted; unknown keys are ignored. */
export function parseSettings(bytes: Uint8Array): ParsedSettings {
  if (bytes.byteLength > MAX_SETTINGS_BYTES) return {state: 'invalid-file'};
  let raw: unknown;
  try {
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes);
    raw = JSON.parse(text);
  } catch {return {state: 'invalid-file'};}
  if (!isRecord(raw) || raw.format !== SETTINGS_FORMAT) return {state: 'invalid-file'};
  const version = raw.version;
  let document: Record<string, unknown> | undefined = raw;
  if (version === undefined) return {state: 'unsupported-older'};
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return {state: 'invalid-file'};
  if (version > SETTINGS_VERSION) return {state: 'newer-version'};
  if (version < SETTINGS_VERSION) {
    document = migrateToCurrent(raw, version);
    if (!document) return {state: 'unsupported-older'};
  }
  const migrated: Migrated = version === 1 || version === 2 || version === 3 || version === 4 || version === 5 || version === 6 || version === 7 || version === 8 || version === 9 || version === 10 ? {migratedFrom: version} : {};
  const fallbackFields: SettingsField[] = [];

  let language: AppLanguage = DEFAULT_APP_LANGUAGE;
  if (isAppLanguage(document.language)) language = document.language;
  else fallbackFields.push('language');

  let autostart = false;
  if (typeof document.autostart === 'boolean') autostart = document.autostart;
  else fallbackFields.push('autostart');

  const units = isRecord(document.units) ? document.units : {};
  const resolved = {} as Record<UnitGame, UnitProfiles[UnitGame]>;
  for (const game of UNIT_GAMES) {
    const value = units[game];
    if (isUnitProfile(value)) resolved[game] = value;
    else {resolved[game] = DEFAULT_UNIT_PROFILES[game]; fallbackFields.push(`units.${game}`);}
  }
  // Each game's gear display mode falls back alone; a missing or non-object block falls back for both games.
  const gearDisplay = isRecord(document.gearDisplay) ? document.gearDisplay : {};
  const gears = {} as Record<UnitGame, GearDisplayMode>;
  for (const game of UNIT_GAMES) {
    const value = gearDisplay[game];
    if (isGearDisplayMode(value)) gears[game] = value;
    else {gears[game] = DEFAULT_GEAR_DISPLAY[game]; fallbackFields.push(`gearDisplay.${game}`);}
  }
  const overlay = parseOverlay(document.overlay, fallbackFields);
  const settings: Settings = {language, autostart, units: Object.freeze(resolved), gearDisplay: Object.freeze(gears), overlay: Object.freeze(overlay)};
  return fallbackFields.length ? {state: 'loaded-with-fallbacks', settings, fallbackFields, ...migrated} : {state: 'loaded', settings, ...migrated};
}

/**
 * The exact v11 file content: UTF-8 without a byte order mark, two-space indentation, a trailing newline, language,
 * both games' unit profiles followed by their gear display modes,
 * all fifteen overlay sections in canonical order and the placements of all four layouts in canonical order, each with
 * x and y rounded to four decimals and the scale to two.
 */
export function serializeSettings(settings: Settings): string {
  const sections = Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, settings.overlay.sections[id]]));
  const placements = Object.fromEntries(OVERLAY_LAYOUTS.map(layout => {
    const {x, y, scale} = settings.overlay.placements[layout];
    return [layout, {x: normalizeFraction(x), y: normalizeFraction(y), scale: normalizeScale(scale)}];
  }));
  return JSON.stringify({
    format: SETTINGS_FORMAT,
    version: SETTINGS_VERSION,
    language: settings.language,
    autostart: settings.autostart,
    units: {ets2: settings.units.ets2, ats: settings.units.ats},
    gearDisplay: {ets2: settings.gearDisplay.ets2, ats: settings.gearDisplay.ats},
    overlay: {enabled: settings.overlay.enabled, backgroundOpacity: settings.overlay.backgroundOpacity, layout: settings.overlay.layout, sections, placements}
  }, null, 2) + '\n';
}
