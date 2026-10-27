import type {GearboxGearDisplay, GearboxGearDisplays, GearboxIdentity, GearDisplayMode, UnitGame} from '../../../packages/contracts/src';
import {ID_BYTES, V1_GEARBOX} from '../../../packages/contracts/src/protocol-v1';
import {isGearDisplayMode} from './unit-profiles';

// ET-050b per-gearbox gear display modes (settings v12, owner decision of October 27, 2026). The SDK names no
// transmission and describes an automatic gearbox with the same H-shifter pattern as a crawler gearbox, so the user picks
// a mode per gearbox once; a gearbox is the truck's model id with its forward and reverse gear counts. Pure, safe for
// renderer, preload and main bundles.

/** Gearboxes with their own mode per game. Bounds the settings file well below its 64 KiB cap. */
export const MAX_GEARBOX_GEAR_DISPLAYS = 16;
/** The longest stored label in UTF-16 code units; a longer SDK brand and name falls back to the name, then the model id. */
export const MAX_GEARBOX_LABEL_LENGTH = 128;
export const DEFAULT_GEARBOX_GEAR_DISPLAY: GearboxGearDisplays = Object.freeze({ets2: Object.freeze([]), ats: Object.freeze([])});

/** The mode for gear display: the game's mode, with the gearboxes that override it. */
export interface GearDisplayChoice {game: UnitGame; mode: GearDisplayMode; gearboxes: readonly GearboxGearDisplay[]}

/** A C0 control character or DEL, which a stored id or label never holds. */
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** An SDK truck model id as protocol v1 carries it: 1 to 128 UTF-8 bytes, no control characters. */
export function isGearboxModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !hasControl(value) && utf8Bytes(value) <= ID_BYTES;
}
/** A display label: 1 to 128 UTF-16 code units, no control characters. */
export function isGearboxLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_GEARBOX_LABEL_LENGTH && !hasControl(value);
}
/** Forward gears 1 to 100 and reverse gears 0 to 100, the protocol v1 gearbox bounds; a gearbox has a forward gear. */
export function isForwardGearCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= V1_GEARBOX.maxGears;
}
export function isReverseGearCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= V1_GEARBOX.maxGears;
}
export function isGearboxIdentity(value: unknown): value is GearboxIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const gearbox = value as Record<string, unknown>;
  return keys.length === 3 && isGearboxModel(gearbox.model) && isForwardGearCount(gearbox.forwardGears) && isReverseGearCount(gearbox.reverseGears);
}
/** Exactly the five keys of a stored entry with valid values. */
export function isGearboxGearDisplay(value: unknown): value is GearboxGearDisplay {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 5 && isGearboxModel(entry.model) && isForwardGearCount(entry.forwardGears) &&
    isReverseGearCount(entry.reverseGears) && isGearboxLabel(entry.label) && isGearDisplayMode(entry.mode);
}

export function sameGearbox(left: GearboxIdentity, right: GearboxIdentity): boolean {
  return left.model === right.model && left.forwardGears === right.forwardGears && left.reverseGears === right.reverseGears;
}
/** Canonical order: model id by UTF-16 code units, then forward and reverse gear counts. */
export function compareGearboxes(left: GearboxIdentity, right: GearboxIdentity): number {
  return (left.model < right.model ? -1 : left.model > right.model ? 1 : 0) || left.forwardGears - right.forwardGears || left.reverseGears - right.reverseGears;
}
export function findGearboxGearDisplay(gearboxes: readonly GearboxGearDisplay[], gearbox: GearboxIdentity): GearboxGearDisplay | undefined {
  return gearboxes.find(entry => sameGearbox(entry, gearbox));
}

/**
 * One game's list after choosing `mode` for `gearbox` (replacing its earlier mode and label) or, with `null`, removing it.
 * Returns undefined when a new gearbox would exceed MAX_GEARBOX_GEAR_DISPLAYS. The result is frozen and in canonical order.
 */
export function withGearboxGearDisplay(gearboxes: readonly GearboxGearDisplay[], gearbox: GearboxIdentity, label: string,
  mode: GearDisplayMode | null): readonly GearboxGearDisplay[] | undefined {
  const others = gearboxes.filter(entry => !sameGearbox(entry, gearbox));
  if (mode === null) return Object.freeze(others);
  if (others.length >= MAX_GEARBOX_GEAR_DISPLAYS) return undefined;
  const entry: GearboxGearDisplay = Object.freeze({model: gearbox.model, forwardGears: gearbox.forwardGears, reverseGears: gearbox.reverseGears, label, mode});
  return Object.freeze([...others, entry].sort(compareGearboxes));
}
