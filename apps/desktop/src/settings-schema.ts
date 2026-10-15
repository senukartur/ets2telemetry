import type {UnitGame, UnitProfiles} from '../../../packages/contracts/src';
import {DEFAULT_UNIT_PROFILES, isUnitProfile, UNIT_GAMES} from './unit-profiles';

// Settings file format v1 (docs/settings.md). Pure parsing and serialization; the store owns file access.

export const SETTINGS_FORMAT = 'ets2telemetry.settings';
export const SETTINGS_VERSION = 1;
/** Larger files are rejected as invalid without being parsed. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface Settings {
  units: UnitProfiles;
}
export const DEFAULT_SETTINGS: Settings = Object.freeze({units: DEFAULT_UNIT_PROFILES});

/** Field paths that can fall back to their default independently. */
export type SettingsField = `units.${UnitGame}`;
export type ParsedSettings =
  | {state: 'loaded'; settings: Settings}
  /** Valid v1 file with some invalid or missing fields; they use defaults until the next save rewrites them. */
  | {state: 'loaded-with-fallbacks'; settings: Settings; fallbackFields: SettingsField[]}
  /** Not UTF-8, not a JSON object, the wrong format marker, a malformed version or too large. */
  | {state: 'invalid-file'}
  /** A version below 1 or no version: there is no migration path to v1, so defaults apply. */
  | {state: 'unsupported-older'}
  /** A later version: defaults apply and the file is never modified by this version. */
  | {state: 'newer-version'};

/**
 * Migrations from older format versions to v1, keyed by source version. The chain is empty: no older format was ever
 * released, so every version below 1 is `unsupported-older`. A future version adds pure `raw -> raw` steps here.
 */
const MIGRATIONS: ReadonlyMap<number, (raw: Record<string, unknown>) => Record<string, unknown>> = new Map();

/** Upgrades an older raw document to v1 through the migration chain, or returns undefined without a complete path. */
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
  const units = isRecord(document.units) ? document.units : {};
  const fallbackFields: SettingsField[] = [];
  const resolved = {} as Record<UnitGame, UnitProfiles[UnitGame]>;
  for (const game of UNIT_GAMES) {
    const value = units[game];
    if (isUnitProfile(value)) resolved[game] = value;
    else {resolved[game] = DEFAULT_UNIT_PROFILES[game]; fallbackFields.push(`units.${game}`);}
  }
  const settings: Settings = {units: Object.freeze(resolved)};
  return fallbackFields.length ? {state: 'loaded-with-fallbacks', settings, fallbackFields} : {state: 'loaded', settings};
}

/** The exact v1 file content: UTF-8 without a byte order mark, two-space indentation and a trailing newline. */
export function serializeSettings(settings: Settings): string {
  return JSON.stringify({format: SETTINGS_FORMAT, version: SETTINGS_VERSION, units: {ets2: settings.units.ets2, ats: settings.units.ats}}, null, 2) + '\n';
}
