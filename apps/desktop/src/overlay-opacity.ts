/** Background opacity in whole percentages; shared by settings, both IPC boundaries and rendering (ET-049). */
export const OVERLAY_OPACITY_MIN = 40;
export const OVERLAY_OPACITY_MAX = 100;
export const DEFAULT_OVERLAY_OPACITY = 80;
export function isOverlayOpacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= OVERLAY_OPACITY_MIN && value <= OVERLAY_OPACITY_MAX;
}
