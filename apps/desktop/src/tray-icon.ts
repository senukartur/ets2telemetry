import {ACTIVE_CHANNEL, type ReleaseChannel} from './channel';
import {TRAY_ICON_PNG_BASE64} from './tray-icon-data';

/** Health tone of the notification-area icon. */
export type TrayTone = 'ready' | 'busy' | 'failed';
/** Status dot colours: green ready, amber starting/restarting/exiting, red failed. The tooltip names the state. */
export const TRAY_TONE_RGB: Readonly<Record<TrayTone, readonly [number, number, number]>> = Object.freeze({
  ready: [52, 211, 153], busy: [245, 158, 11], failed: [239, 68, 68]
});
/**
 * Windows picks the notification-area bitmap for the display scale: 16 px at 100%, 20 at 125%,
 * 24 at 150% and 32 at 200%. One image carries all four representations.
 */
export const TRAY_ICON_REPRESENTATIONS = Object.freeze([
  {size: 16, scaleFactor: 1}, {size: 20, scaleFactor: 1.25}, {size: 24, scaleFactor: 1.5}, {size: 32, scaleFactor: 2}
] as const);
export type TrayIconSize = (typeof TRAY_ICON_REPRESENTATIONS)[number]['size'];

/**
 * The square RGBA PNG for one notification-area representation: the small "road merge" tile with a status dot in the
 * lower right corner, in this build's channel (staging adds an amber corner flag). scripts/generate-app-icons.mjs
 * renders it; see docs/design/ui-spec.md#3-tokens-type-and-icons.
 */
export function trayIconPng(size: TrayIconSize, tone: TrayTone, channel: ReleaseChannel = ACTIVE_CHANNEL): Buffer {
  const encoded = TRAY_ICON_PNG_BASE64[channel]?.[tone]?.[size];
  if (encoded === undefined) throw new Error('Invalid tray icon size or tone');
  return Buffer.from(encoded, 'base64');
}
