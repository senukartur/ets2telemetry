// Generates the application and notification-area icons (docs/design/ui-spec.md#3-tokens-type-and-icons).
// Run `node scripts/generate-app-icons.mjs` after changing the icon design, then commit the outputs:
// - resources/icon/app.ico and resources/staging/icon/app.ico: the executable, installer, taskbar and window icon
//   (16-256 px) of the production and the staging channel; forge.config.cjs packages the build channel's one;
// - apps/desktop/src/tray-icon-data.ts: notification-area PNGs for each channel, health tone and scale;
// - docs/design/assets/app-icon.png: a 256 px preview of the production icon for the design documentation.
// The staging channel's icon is the same mark with an amber flag across the upper right corner, so the two installed
// applications can be told apart on the taskbar, in the tray and in Installed apps (ET-055).
// The mark is "road merge" (Yukon Union): two roads join into one and form a Y, with an amber centre line, on a
// blue-to-night tile. From 48 px it is drawn as liquid glass: aurora light behind frosted roads, lit edges, a dashed
// glowing centre line, a top gloss and a rim. Below 48 px, and in the tray, those details turn to noise, so the small
// mark has solid roads, a solid centre line and only the rim. The in-app logo (the bear) is not affected.
import {deflateSync} from 'node:zlib';
import {writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Paths are relative to the repository root, wherever the script is started from.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = relative => path.join(ROOT, relative);
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TRAY_SIZES = [16, 20, 24, 32];
const LARGE_FROM = 48;
// Keep in step with TRAY_TONE_RGB in apps/desktop/src/tray-icon.ts; the tray unit test compares the status dot.
const TONES = {ready: '#34D399', busy: '#F59E0B', failed: '#EF4444'};
const hex = value => [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
const COLORS = {
  tileTop: hex('#2563EB'), tileBottom: hex('#0B1120'), road: hex('#F8FAFC'), line: hex('#FFB300'), lineCore: hex('#FFC233'),
  shadow: hex('#020617'), white: [255, 255, 255], flag: hex('#FFB300'), flagEdge: hex('#111827')
};

// ---- PNG and ICO --------------------------------------------------------------------------------------------------
const CRC_TABLE = Array.from({length: 256}, (_, value) => {
  let crc = value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0;
});
function crc32(bytes) {let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0;}
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodePng(size, rgba) {
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), {level: 9})), chunk('IEND', Buffer.alloc(0))]);
}
// An ICO whose entries are PNG images (supported by Windows Vista and later).
function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({size, png}, index) => {
    const entry = 6 + 16 * index;
    header[entry] = size % 256; header[entry + 1] = size % 256; header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12); offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}

// ---- Geometry, in a 100 x 100 design space ------------------------------------------------------------------------
// The road centre lines: the left arm runs into the right arm as one dashed path, the stem is a second path.
const SEGMENTS = (() => {
  const make = (ax, ay, bx, by, offset) => ({ax, ay, bx, by, offset, length: Math.hypot(bx - ax, by - ay)});
  const left = make(20, -4, 50, 48, 0);
  return [left, make(50, 48, 80, -4, left.length), make(50, 48, 50, 104, 0)];
})();
const DASH = 7, GAP = 6;
// Distance to the nearest centre line and the arc length of the nearest point along its dashed path.
function road(u, v) {
  let best = Infinity, along = 0;
  for (const s of SEGMENTS) {
    const dx = s.bx - s.ax, dy = s.by - s.ay, t = Math.min(1, Math.max(0, ((u - s.ax) * dx + (v - s.ay) * dy) / (s.length * s.length)));
    const d = Math.hypot(u - s.ax - t * dx, v - s.ay - t * dy);
    if (d < best) {best = d; along = s.offset + t * s.length;}
  }
  return {d: best, along};
}
// Signed distance along the path to the nearest dash: negative inside a dash, positive in a gap.
function dashDistance(along) {
  const phase = ((along % (DASH + GAP)) + DASH + GAP) % (DASH + GAP);
  return phase < DASH ? -Math.min(phase, DASH - phase) : Math.min(phase - DASH, DASH + GAP - phase);
}
const insideRoundedSquare = (u, v, inset, radius) => {
  const low = inset, high = 100 - inset; if (u < low || v < low || u > high || v > high) return false;
  const cx = Math.min(Math.max(u, low + radius), high - radius), cy = Math.min(Math.max(v, low + radius), high - radius);
  return (u - cx) ** 2 + (v - cy) ** 2 <= radius * radius;
};
// Complementary error function (Abramowitz and Stegun 7.1.26); a Gaussian blur of a hard edge is 0.5 * erfc.
function erfc(x) {
  const z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  const value = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? value : 2 - value;
}
const blurredEdge = (signed, sigma) => 0.5 * erfc(signed / (sigma * Math.SQRT2));
const lerp = (a, b, t) => a.map((value, c) => value + (b[c] - value) * t);
const mix = (base, colour, alpha) => alpha <= 0 ? base : lerp(base, colour, Math.min(1, alpha));
// Opacity of a white gradient along the top-left to bottom-right diagonal, from piecewise-linear stops.
function diagonal(u, v, stops) {
  const t = (u + v) / 200;
  for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
    const [t0, a0] = stops[i - 1], [t1, a1] = stops[i]; return a0 + (a1 - a0) * (t - t0) / (t1 - t0);
  }
  return stops[stops.length - 1][1];
}
// The aurora behind the tile, and the brighter aurora refracted inside the frosted roads (blurred discs).
const AURORA = [[86, 18, 22, hex('#22D3EE'), 0.85], [12, 86, 24, hex('#7C3AED'), 0.8], [70, 92, 14, COLORS.line, 0.35]];
const REFRACTED = [[86, 18, 28, hex('#67E8F9'), 1], [12, 86, 30, hex('#A78BFA'), 1]];
const glow = (base, discs, u, v) => discs.reduce((colour, [x, y, r, rgb, opacity]) => mix(colour, rgb, opacity * blurredEdge(Math.hypot(u - x, v - y) - r, 10)), base);

// The staging channel's flag: an amber triangle across the upper right corner with a dark edge, clear of the tray's
// status dot in the lower right corner.
const FLAG = 66, FLAG_EDGE = 4;
const staging = (u, v, colour) => u - v > FLAG ? COLORS.flag : u - v > FLAG - FLAG_EDGE ? COLORS.flagEdge : colour;

// The colour of one sample point (u, v) of the tile in `channel`, or null outside it.
function shade(u, v, large, channel) {
  if (!insideRoundedSquare(u, v, 0, 22)) return null;
  let colour = lerp(COLORS.tileTop, COLORS.tileBottom, Math.min(1, Math.max(0, (u * 0.6 + v) / 136)));
  const {d, along} = road(u, v);
  if (!large) {
    if (d <= 11) colour = COLORS.road;
    if (d <= 3.5) colour = COLORS.line;
    if (channel === 'staging') colour = staging(u, v, colour);
    if (!insideRoundedSquare(u, v, 4, 18)) colour = mix(colour, COLORS.white, diagonal(u, v, [[0, 0.95], [0.45, 0.08], [1, 0.5]]));
    return colour;
  }
  colour = glow(colour, AURORA, u, v);
  colour = mix(colour, COLORS.shadow, 0.4 * blurredEdge(road(u, v - 2).d - 9, 3));
  if (d <= 8) colour = mix(glow(colour, REFRACTED, u, v), COLORS.white, 0.42);
  if (d > 7.75 && d <= 9.5) colour = mix(colour, COLORS.white, diagonal(u, v, [[0, 1], [0.5, 0.35], [1, 0.85]]));
  const dash = dashDistance(along);
  colour = mix(colour, COLORS.line, 0.9 * blurredEdge(d - 2.5, 1.4) * blurredEdge(dash, 1.4));
  if (d <= 1.7 && dash <= 0) colour = COLORS.lineCore;
  const glossBottom = 40 + 7.5 * (1 - ((u - 50) / 50) ** 2);
  if (v < glossBottom) colour = mix(colour, COLORS.white, 0.28 * (1 - v / 47.5));
  if (channel === 'staging') colour = staging(u, v, colour);
  if (!insideRoundedSquare(u, v, 2.4, 19.6)) colour = mix(colour, COLORS.white, diagonal(u, v, [[0, 0.95], [0.45, 0.08], [1, 0.5]]));
  return colour;
}

function render(S, {tone, channel = 'production'} = {}) {
  const large = tone === undefined && S >= LARGE_FROM, samples = S <= 64 ? 8 : 4, rgba = Buffer.alloc(S * S * 4);
  // The tray's status dot sits in the lower right corner with a transparent gap around it.
  const dot = 0.19 * 100, centre = 100 - dot - 2, gap = dot + Math.max(1.2, S / 20) * 100 / S, toneRgb = tone && hex(TONES[tone]);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const sum = [0, 0, 0, 0];
    for (let a = 0; a < samples; a++) for (let b = 0; b < samples; b++) {
      const u = (x + (a + 0.5) / samples) * 100 / S, v = (y + (b + 0.5) / samples) * 100 / S;
      let colour = null;
      if (tone) {
        const r = Math.hypot(u - centre, v - centre);
        if (r <= dot) colour = toneRgb; else if (r > gap) colour = shade(u, v, false, channel);
      } else colour = shade(u, v, large, channel);
      if (!colour) continue;
      sum[0] += colour[0]; sum[1] += colour[1]; sum[2] += colour[2]; sum[3]++;
    }
    const offset = (y * S + x) * 4;
    if (sum[3]) for (let c = 0; c < 3; c++) rgba[offset + c] = Math.round(sum[c] / sum[3]);
    rgba[offset + 3] = Math.round(255 * sum[3] / (samples * samples));
  }
  return encodePng(S, rgba);
}

// ---- Outputs ------------------------------------------------------------------------------------------------------
// Each channel's icon folder holds only app.ico and is packaged as resources/icon (forge.config.cjs).
const ICON_FILES = {production: 'resources/icon/app.ico', staging: 'resources/staging/icon/app.ico'};
for (const [channel, file] of Object.entries(ICON_FILES)) {
  mkdirSync(path.dirname(at(file)), {recursive: true});
  writeFileSync(at(file), encodeIco(APP_SIZES.map(size => ({size, png: render(size, {channel})}))));
}
writeFileSync(at('docs/design/assets/app-icon.png'), render(256));
const tray = channel => Object.keys(TONES).map(tone => `    ${tone}: {\n${TRAY_SIZES.map(size => `      ${size}: '${render(size, {tone, channel}).toString('base64')}'`).join(',\n')}\n    }`).join(',\n');
writeFileSync(at('apps/desktop/src/tray-icon-data.ts'), `// Generated by scripts/generate-app-icons.mjs. Do not edit by hand.
import type {ReleaseChannel} from './channel';
import type {TrayTone} from './tray-icon';

/**
 * Base64 RGBA PNGs of the notification-area icon: the small road-merge tile with a status dot, per channel, health tone
 * and pixel size. The staging tile carries the amber corner flag.
 */
export const TRAY_ICON_PNG_BASE64: Readonly<Record<ReleaseChannel, Readonly<Record<TrayTone, Readonly<Record<16 | 20 | 24 | 32, string>>>>>> = Object.freeze({
${Object.keys(ICON_FILES).map(channel => `  ${channel}: {\n${tray(channel)}\n  }`).join(',\n')}
});
`);
console.log(`Wrote ${Object.values(ICON_FILES).join(', ')}, docs/design/assets/app-icon.png and apps/desktop/src/tray-icon-data.ts`);
