import {deflateSync} from 'node:zlib';

/** Health tone of the notification-area icon. */
export type TrayTone = 'ready' | 'busy' | 'failed';
/** Fill colours: green ready, amber starting/restarting/exiting, red failed. */
export const TRAY_TONE_RGB: Readonly<Record<TrayTone, readonly [number, number, number]>> = Object.freeze({
  ready: [46, 157, 87], busy: [217, 154, 30], failed: [208, 57, 59]
});
/**
 * Windows picks the notification-area bitmap for the display scale: 16 px at 100%, 20 at 125%,
 * 24 at 150% and 32 at 200%. One image carries all four representations.
 */
export const TRAY_ICON_REPRESENTATIONS = Object.freeze([
  {size: 16, scaleFactor: 1}, {size: 20, scaleFactor: 1.25}, {size: 24, scaleFactor: 1.5}, {size: 32, scaleFactor: 2}
] as const);

const CRC_TABLE = Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * A generated square RGBA PNG: an anti-aliased filled disc with a darker rim on a transparent
 * background. Generated at runtime, so no binary image asset is committed or packaged.
 */
export function trayIconPng(size: number, tone: TrayTone): Buffer {
  if (!Number.isSafeInteger(size) || size < 8 || size > 256) throw new Error('Invalid tray icon size');
  const [red, green, blue] = TRAY_TONE_RGB[tone];
  const rows: Buffer[] = [];
  const center = size / 2, outer = size / 2 - 0.5, rim = Math.max(1, size / 16), samples = 4;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // Filter byte 0: no filtering.
    for (let x = 0; x < size; x++) {
      let covered = 0, inner = 0;
      for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
        const distance = Math.hypot(x + (sx + 0.5) / samples - center, y + (sy + 0.5) / samples - center);
        if (distance <= outer) {covered++; if (distance <= outer - rim) inner++;}
      }
      if (!covered) continue;
      // The rim is the same hue at 60% brightness, so the disc stays visible on light and dark taskbars.
      const shade = (inner + (covered - inner) * 0.6) / covered;
      const offset = 1 + x * 4;
      row[offset] = Math.round(red * shade); row[offset + 1] = Math.round(green * shade); row[offset + 2] = Math.round(blue * shade);
      row[offset + 3] = Math.round(255 * covered / (samples * samples));
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0; // 8-bit RGBA, deflate, no interlace.
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
