import type {OverlayLayout, OverlayPlacement, OverlayPlacements} from '../../../packages/contracts/src';

// Overlay placements (ET-012b decisions M2-M4). Pure data and validation without Node built-ins, so main, the
// dashboard preload and renderer, the settings schema and plain Node tests share one definition.

export const OVERLAY_SCALE_MIN = 0.5;
export const OVERLAY_SCALE_MAX = 2;
/** The dashboard's smaller/larger buttons change the scale by this step. */
export const OVERLAY_SCALE_STEP = 0.1;

const placement = (x: number, y: number): OverlayPlacement => Object.freeze({x, y, scale: 1});
/**
 * The ET-012a anchors (decision L10) at scale 1, in canonical layout order: the strip at the top centre, the card at the
 * top right, the cluster at the bottom left and the HUD at the top left.
 */
export const DEFAULT_OVERLAY_PLACEMENTS: OverlayPlacements = Object.freeze({
  strip: placement(0.5, 0),
  card: placement(1, 0),
  cluster: placement(0, 1),
  hud: placement(0, 0)
});

/** Four decimals for a position fraction; `+ 0` turns a negative zero into zero. */
export const normalizeFraction = (value: number): number => Math.round(value * 10_000) / 10_000 + 0;
/** Two decimals for a scale. */
export const normalizeScale = (value: number): number => Math.round(value * 100) / 100 + 0;
export const clampFraction = (value: number): number => Math.min(1, Math.max(0, value));

/** A finite number in [0, 1]. */
export function isPlacementFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}
/** A finite number in [0.5, 2]. */
export function isOverlayScale(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= OVERLAY_SCALE_MIN && value <= OVERLAY_SCALE_MAX;
}

/**
 * One placement from the settings file: an object whose `x` and `y` are fractions in [0, 1] and whose `scale` is in
 * [0.5, 2]. Out-of-range values are rejected, never clamped; unknown keys are ignored. Returns a normalised frozen copy.
 */
export function parseOverlayPlacement(value: unknown): OverlayPlacement | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const {x, y, scale} = value as Record<string, unknown>;
  if (!isPlacementFraction(x) || !isPlacementFraction(y) || !isOverlayScale(scale)) return undefined;
  return Object.freeze({x: normalizeFraction(x), y: normalizeFraction(y), scale: normalizeScale(scale)});
}

/**
 * The scale argument of an IPC request: exactly one finite number in [0.5, 2], rounded to two decimals. A rounded
 * value stays inside the range because both bounds have two decimals.
 */
export function parseOverlayEditScale(value: unknown): number | undefined {
  return isOverlayScale(value) ? normalizeScale(value) : undefined;
}

export type OverlayEditOutcome = 'save' | 'cancel';
export function isOverlayEditOutcome(value: unknown): value is OverlayEditOutcome {
  return value === 'save' || value === 'cancel';
}

/** The next scale one step smaller or larger, rounded and kept inside [0.5, 2]. */
export function stepOverlayScale(scale: number, direction: -1 | 1): number {
  return normalizeScale(Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, scale + direction * OVERLAY_SCALE_STEP)));
}

export function samePlacement(left: OverlayPlacement, right: OverlayPlacement): boolean {
  return left.x === right.x && left.y === right.y && left.scale === right.scale;
}

/** The given layout's placement replaced by a normalised frozen copy; the other layouts are kept. */
export function withPlacement(placements: OverlayPlacements, layout: OverlayLayout, next: OverlayPlacement): OverlayPlacements {
  const copy = Object.freeze({x: normalizeFraction(next.x), y: normalizeFraction(next.y), scale: normalizeScale(next.scale)});
  return Object.freeze({...placements, [layout]: copy});
}
