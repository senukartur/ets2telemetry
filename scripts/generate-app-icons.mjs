// Generates the application and notification-area icons from the line-art logo (apps/desktop/src/assets/logo.png).
// Run `node scripts/generate-app-icons.mjs` after changing the logo or the icon design, then commit the outputs:
// - resources/icon/app.ico: the executable, installer, taskbar and window icon (16-256 px);
// - apps/desktop/src/tray-icon-data.ts: notification-area PNGs for each health tone and scale;
// - docs/design/assets/app-icon.png: a 256 px preview for the design documentation.
// The mark is the logo's bear on a blue rounded tile. At 64 px and above it keeps every inner stroke of the logo. Below
// 48 px the strokes fade into grey, so the small mark fills the silhouette and cuts out only the open mouth and the eye.
import {deflateSync, inflateSync} from 'node:zlib';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import path from 'node:path';

const LOGO = 'apps/desktop/src/assets/logo.png';
const APP_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TRAY_SIZES = [16, 20, 24, 32];
// Keep in step with TRAY_TONE_RGB in apps/desktop/src/tray-icon.ts; the tray unit test compares the status dot.
const TONES = {ready: '#34D399', busy: '#F59E0B', failed: '#EF4444'};
const COLORS = {tileTop: '#2563EB', tileBottom: '#0B1120', tileRim: '#60A5FA', bear: '#F8FAFC', cavity: '#0B1120', shadow: '#020617'};

// ---- PNG ----------------------------------------------------------------------------------------------------------
function readPng(file) {
  const bytes = readFileSync(file); const idat = []; let width = 0, height = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8), data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('The logo must be a non-interlaced 8-bit RGBA PNG');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * 4, pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0, up = y ? pixels[(y - 1) * stride + x] : 0, corner = y && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = line[x];
      if (filter === 1) value += left; else if (filter === 2) value += up; else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - corner, pa = Math.abs(estimate - left), pb = Math.abs(estimate - up), pc = Math.abs(estimate - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      pixels[y * stride + x] = value & 255;
    }
  }
  return {width, height, pixels};
}
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

// ---- Logo masks ---------------------------------------------------------------------------------------------------
const neighbours = (index, width, height) => {
  const x = index % width, y = (index / width) | 0;
  return [x ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y ? index - width : -1, y < height - 1 ? index + width : -1].filter(next => next >= 0);
};
// Pixels reachable from the image border without crossing `wall`.
function outside(wall, width, height) {
  const reached = new Uint8Array(width * height), stack = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const index = stack.pop(); if (reached[index] || wall[index]) continue;
    reached[index] = 1; stack.push(...neighbours(index, width, height));
  }
  return reached;
}
// Exact squared Euclidean distance to the nearest set pixel (Felzenszwalb and Huttenlocher).
function distanceSquared(mask, width, height) {
  const n = Math.max(width, height), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = Float64Array.from(mask, value => value ? 0 : 1e20);
  const pass = (count, get, set) => {
    for (let q = 0; q < count; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < count; q++) {
      let s;
      for (;;) {s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); if (s <= z[k]) k--; else break;}
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < count; q++) {while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]];}
    for (let q = 0; q < count; q++) set(q, d[q]);
  };
  for (let x = 0; x < width; x++) pass(height, y => grid[y * width + x], (y, value) => {grid[y * width + x] = value;});
  for (let y = 0; y < height; y++) pass(width, x => grid[y * width + x], (x, value) => {grid[y * width + x] = value;});
  return grid;
}
const dilate = (mask, width, height, radius) => radius <= 0 ? mask : Uint8Array.from(distanceSquared(mask, width, height), value => value <= radius * radius ? 1 : 0);
const erode = (mask, width, height, radius) => Uint8Array.from(distanceSquared(mask.map(value => 1 - value), width, height), value => value > radius * radius ? 1 : 0);

function logoMasks() {
  const {width, height, pixels} = readPng(LOGO), count = width * height;
  const stroke = new Uint8Array(count); for (let i = 0; i < count; i++) stroke[i] = pixels[i * 4 + 3] >= 128 ? 1 : 0;
  const exterior = outside(stroke, width, height);
  // Filled silhouette: everything inside the outline, with the logo's own anti-aliasing kept on the outer edge.
  const silhouette = Float32Array.from({length: count}, (_, i) => exterior[i] ? pixels[i * 4 + 3] / 255 : 1);
  // Inner strokes are the stroke components that do not touch the outside; the outline is the one that does.
  const component = new Int32Array(count).fill(-1), inner = [];
  for (let start = 0; start < count; start++) {
    if (!stroke[start] || component[start] >= 0) continue;
    const id = inner.length, members = [start], stack = [start]; let touchesOutside = false, top = height, left = width; component[start] = id;
    while (stack.length) {
      const index = stack.pop(); top = Math.min(top, (index / width) | 0); left = Math.min(left, index % width);
      for (const next of neighbours(index, width, height)) {
        if (exterior[next]) touchesOutside = true;
        if (stroke[next] && component[next] < 0) {component[next] = id; stack.push(next); members.push(next);}
      }
    }
    inner.push({members, touchesOutside, top, left});
  }
  const strokes = inner.filter(entry => !entry.touchesOutside && entry.members.length > 50);
  const detail = new Uint8Array(count); for (const entry of strokes) for (const index of entry.members) detail[index] = 1;
  // The simplified mark needs the mouth and the eye. In the logo the jaws are the three largest strokes in the lower
  // left quarter and the eye is the stroke that starts nearest to (400, 200); find them by geometry, not by index.
  const pick = list => {const mask = new Uint8Array(count); for (const entry of list) for (const index of entry.members) mask[index] = 1; return mask;};
  const jaws = strokes.filter(entry => entry.left < width * 0.45 && entry.top > height * 0.21 && entry.top < height * 0.7)
    .sort((a, b) => b.members.length - a.members.length).slice(0, 3);
  const eye = strokes.filter(entry => !jaws.includes(entry))
    .sort((a, b) => Math.hypot(a.left - width * 0.39, a.top - height * 0.2) - Math.hypot(b.left - width * 0.39, b.top - height * 0.2))[0];
  if (jaws.length !== 3 || !eye) throw new Error('The logo no longer has the expected jaw and eye strokes');
  // Close the gap between the jaws and fill the enclosed cavity.
  const jawMask = pick(jaws), closing = 70;
  const ring = erode(dilate(jawMask, width, height, closing), width, height, closing).map((value, i) => value | jawMask[i]);
  const ringOutside = outside(ring, width, height);
  const mouth = Uint8Array.from({length: count}, (_, i) => !ringOutside[i] && silhouette[i] >= 0.5 ? 1 : 0);
  return {width, height, silhouette, detail, mouth, eye: pick([eye])};
}

// ---- Rendering ----------------------------------------------------------------------------------------------------
const hex = value => [1, 3, 5].map(offset => parseInt(value.slice(offset, offset + 2), 16));
// Area-averaged coverage of `mask` for an S x S output whose square window starts at (ox, oy) and spans `span` source px.
function resample(mask, width, height, S, ox, oy, span) {
  const out = new Float32Array(S * S), step = span / S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const x0 = ox + x * step, x1 = x0 + step, y0 = oy + y * step, y1 = y0 + step; let sum = 0, area = 0;
    for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
      const weight = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * (Math.min(yy + 1, y1) - Math.max(yy, y0)); area += weight;
      if (xx >= 0 && yy >= 0 && xx < width && yy < height) sum += mask[yy * width + xx] * weight;
    }
    out[y * S + x] = sum / area;
  }
  return out;
}
// Supersampled coverage of a shape given as a predicate over unit coordinates.
function coverage(S, inside, samples = 6) {
  const out = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let hits = 0;
    for (let a = 0; a < samples; a++) for (let b = 0; b < samples; b++) if (inside((x + (a + 0.5) / samples) / S, (y + (b + 0.5) / samples) / S)) hits++;
    out[y * S + x] = hits / (samples * samples);
  }
  return out;
}
const roundedSquare = (radius, inset = 0) => (u, v) => {
  const low = inset, high = 1 - inset; if (u < low || v < low || u > high || v > high) return false;
  const cx = Math.min(Math.max(u, low + radius), high - radius), cy = Math.min(Math.max(v, low + radius), high - radius);
  return (u - cx) ** 2 + (v - cy) ** 2 <= radius * radius;
};
const disc = (cx, cy, radius) => (u, v) => (u - cx) ** 2 + (v - cy) ** 2 <= radius * radius;
function paint(image, S, cover, colour, opacity = 1) {
  for (let i = 0; i < S * S; i++) {
    const alpha = cover[i] * opacity; if (!alpha) continue;
    const rgb = typeof colour === 'function' ? colour((i % S) / S, Math.floor(i / S) / S) : colour;
    const below = image[i * 4 + 3], total = alpha + below * (1 - alpha);
    for (let c = 0; c < 3; c++) image[i * 4 + c] = (rgb[c] * alpha + image[i * 4 + c] * below * (1 - alpha)) / total;
    image[i * 4 + 3] = total;
  }
}
function render(masks, S, {tone} = {}) {
  const {width, height} = masks, image = new Float32Array(S * S * 4), small = S < 48 || tone !== undefined;
  const radius = small ? 0.18 : S < 64 ? 0.21 : 0.22, pad = tone ? 0.04 : S < 48 ? 0.05 : S < 64 ? 0.08 : 0.1;
  const top = hex(COLORS.tileTop), bottom = hex(COLORS.tileBottom);
  paint(image, S, coverage(S, roundedSquare(radius)), (u, v) => {
    const t = Math.min(1, Math.max(0, (u * 0.35 + v * 0.65) * 1.1)); return top.map((value, c) => value + (bottom[c] - value) * t);
  });
  const outer = coverage(S, roundedSquare(radius)), inner = coverage(S, roundedSquare(radius - 1 / S, Math.max(1, S / 64) / S));
  paint(image, S, outer.map((value, i) => Math.max(0, value - inner[i])), hex(COLORS.tileRim), 0.55);
  const span = width / (1 - 2 * pad), origin = -pad * span, pxPerOutput = span / S;
  const silhouette = resample(masks.silhouette, width, height, S, origin, origin, span);
  let cut;
  if (small) {
    const eye = dilate(masks.eye, width, height, Math.round(0.35 * pxPerOutput));
    const mouth = resample(masks.mouth, width, height, S, origin, origin, span), eyeCover = resample(eye, width, height, S, origin, origin, span);
    cut = mouth.map((value, i) => Math.min(silhouette[i], Math.max(value, eyeCover[i])));
    paint(image, S, cut, hex(COLORS.cavity));
  } else {
    cut = resample(dilate(masks.detail, width, height, S < 64 ? 4 : 0), width, height, S, origin, origin, span);
    paint(image, S, resample(masks.silhouette, width, height, S, origin - span * 0.012, origin - span * 0.02, span), hex(COLORS.shadow), 0.45);
  }
  paint(image, S, silhouette.map((value, i) => Math.max(0, value - cut[i])), hex(COLORS.bear));
  if (tone) {
    // The status dot sits in the lower right corner with a transparent gap around it.
    const dot = 0.19, centre = 1 - dot - 0.02, gap = coverage(S, disc(centre, centre, dot + Math.max(1.2, S / 20) / S));
    for (let i = 0; i < S * S; i++) image[i * 4 + 3] *= 1 - gap[i];
    paint(image, S, coverage(S, disc(centre, centre, dot)), hex(TONES[tone]));
  }
  const rgba = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(image[i * 4 + c]);
    rgba[i * 4 + 3] = Math.round(image[i * 4 + 3] * 255);
  }
  return encodePng(S, rgba);
}

// ---- Outputs ------------------------------------------------------------------------------------------------------
const masks = logoMasks();
mkdirSync('resources/icon', {recursive: true});
writeFileSync('resources/icon/app.ico', encodeIco(APP_SIZES.map(size => ({size, png: render(masks, size)}))));
writeFileSync(path.join('docs/design/assets/app-icon.png'), render(masks, 256));
const tray = Object.keys(TONES).map(tone => `  ${tone}: {\n${TRAY_SIZES.map(size => `    ${size}: '${render(masks, size, {tone}).toString('base64')}'`).join(',\n')}\n  }`).join(',\n');
writeFileSync('apps/desktop/src/tray-icon-data.ts', `// Generated by scripts/generate-app-icons.mjs from apps/desktop/src/assets/logo.png. Do not edit by hand.
import type {TrayTone} from './tray-icon';

/** Base64 RGBA PNGs of the notification-area icon: the bear tile with a status dot, per health tone and pixel size. */
export const TRAY_ICON_PNG_BASE64: Readonly<Record<TrayTone, Readonly<Record<16 | 20 | 24 | 32, string>>>> = Object.freeze({
${tray}
});
`);
console.log('Wrote resources/icon/app.ico, docs/design/assets/app-icon.png and apps/desktop/src/tray-icon-data.ts');
