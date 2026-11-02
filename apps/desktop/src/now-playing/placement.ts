import type {NowPlayingPosition, NowPlayingStyle} from '../../../../packages/contracts/src/now-playing';
export interface Area {x: number; y: number; width: number; height: number}
export interface MediaDisplay {id: number; workArea: Area}
export const widgetSize = (style: NowPlayingStyle) => style === 'minimal' ? {width: 300, height: 78} : {width: 360, height: 128};
export function widgetBounds(position: NowPlayingPosition, style: NowPlayingStyle, displays: readonly MediaDisplay[], primary: MediaDisplay): Area {
  const {workArea: area} = displays.find(display => String(display.id) === position.displayId) ?? primary;
  const size = widgetSize(style), width = Math.min(size.width, area.width), height = Math.min(size.height, area.height);
  const mx = Math.min(16, (area.width - width) / 2), my = Math.min(16, (area.height - height) / 2);
  return {x: Math.round(area.x + mx + (area.width - width - 2 * mx) * position.x), y: Math.round(area.y + my + (area.height - height - 2 * my) * position.y), width, height};
}
export function positionFromBounds(bounds: Area, display: MediaDisplay): NowPlayingPosition {
  const a = display.workArea, mx = Math.min(16, Math.max(0, (a.width - bounds.width) / 2)), my = Math.min(16, Math.max(0, (a.height - bounds.height) / 2));
  const fraction = (v: number, size: number) => Math.round(Math.max(0, Math.min(1, size > 0 ? v / size : 0)) * 10000) / 10000;
  return {displayId: String(display.id), x: fraction(bounds.x - a.x - mx, a.width - bounds.width - 2 * mx), y: fraction(bounds.y - a.y - my, a.height - bounds.height - 2 * my)};
}
