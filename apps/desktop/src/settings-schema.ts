import type {OverlaySectionId, OverlaySettings, UnitGame, UnitProfiles} from '../../../packages/contracts/src';
import {DEFAULT_OVERLAY_SECTIONS, DEFAULT_OVERLAY_SETTINGS, isOverlayLayout, OVERLAY_SECTION_IDS} from './overlay-sections';
import {DEFAULT_UNIT_PROFILES, isUnitProfile, UNIT_GAMES} from './unit-profiles';

// Settings file format v2 (docs/settings.md). Pure parsing and serialization; the store owns file access.

export const SETTINGS_FORMAT = 'ets2telemetry.settings';
export const SETTINGS_VERSION = 2;
/** Larger files are rejected as invalid without being parsed. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface Settings {
  units: UnitProfiles;
  overlay: OverlaySettings;
}
export const DEFAULT_SETTINGS: Settings = Object.freeze({units: DEFAULT_UNIT_PROFILES, overlay: DEFAULT_OVERLAY_SETTINGS});

/** Field paths that can fall back to their default independently. */
export type SettingsField = `units.${UnitGame}` | 'overlay.layout' | 'overlay.sections' | `overlay.sections.${OverlaySectionId}`;
/** Set when the file was upgraded in memory from an older format; the file itself stays unchanged until the next save. */
type Migrated = {migratedFrom?: 1};
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

const defaultOverlayDocument = () => ({layout: DEFAULT_OVERLAY_SETTINGS.layout, sections: {...DEFAULT_OVERLAY_SECTIONS}});
/**
 * Migrations from older format versions, keyed by source version. Each step is a pure `raw -> raw` function that never
 * mutates its input. v1 -> v2 adds the overlay block with its defaults (strip, every section); the v1 units then pass
 * the normal v2 validation, so an invalid v1 unit still falls back alone. Version 0 and below have no path.
 */
const MIGRATIONS: ReadonlyMap<number, (raw: Record<string, unknown>) => Record<string, unknown>> = new Map([
  [1, (raw: Record<string, unknown>) => ({...raw, version: 2, overlay: defaultOverlayDocument()})]
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The overlay block with per-field fallbacks; a missing or non-object block falls back as a whole. */
function parseOverlay(value: unknown, fallbackFields: SettingsField[]): OverlaySettings {
  const overlay = isRecord(value) ? value : {};
  let layout = DEFAULT_OVERLAY_SETTINGS.layout;
  if (isOverlayLayout(overlay.layout)) layout = overlay.layout;
  else fallbackFields.push('overlay.layout');
  const raw = overlay.sections;
  if (!isRecord(raw)) {fallbackFields.push('overlay.sections'); return {layout, sections: DEFAULT_OVERLAY_SECTIONS};}
  const sections = {} as Record<OverlaySectionId, boolean>;
  const sectionFallbacks: SettingsField[] = [];
  for (const id of OVERLAY_SECTION_IDS) {
    const enabled = raw[id];
    if (typeof enabled === 'boolean') sections[id] = enabled;
    else {sections[id] = DEFAULT_OVERLAY_SECTIONS[id]; sectionFallbacks.push(`overlay.sections.${id}`);}
  }
  // A record that enables nothing would hide the whole overlay: every section falls back together.
  if (!OVERLAY_SECTION_IDS.some(id => sections[id])) {fallbackFields.push('overlay.sections'); return {layout, sections: DEFAULT_OVERLAY_SECTIONS};}
  fallbackFields.push(...sectionFallbacks);
  return {layout, sections: Object.freeze(sections)};
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
  const migrated: Migrated = version === 1 ? {migratedFrom: 1} : {};
  const units = isRecord(document.units) ? document.units : {};
  const fallbackFields: SettingsField[] = [];
  const resolved = {} as Record<UnitGame, UnitProfiles[UnitGame]>;
  for (const game of UNIT_GAMES) {
    const value = units[game];
    if (isUnitProfile(value)) resolved[game] = value;
    else {resolved[game] = DEFAULT_UNIT_PROFILES[game]; fallbackFields.push(`units.${game}`);}
  }
  const overlay = parseOverlay(document.overlay, fallbackFields);
  const settings: Settings = {units: Object.freeze(resolved), overlay: Object.freeze(overlay)};
  return fallbackFields.length ? {state: 'loaded-with-fallbacks', settings, fallbackFields, ...migrated} : {state: 'loaded', settings, ...migrated};
}

/**
 * The exact v2 file content: UTF-8 without a byte order mark, two-space indentation, a trailing newline, and all
 * fourteen overlay sections in canonical order.
 */
export function serializeSettings(settings: Settings): string {
  const sections = Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, settings.overlay.sections[id]]));
  return JSON.stringify({format: SETTINGS_FORMAT, version: SETTINGS_VERSION, units: {ets2: settings.units.ets2, ats: settings.units.ats},
    overlay: {layout: settings.overlay.layout, sections}}, null, 2) + '\n';
}
