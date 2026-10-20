// Diagnostic pixels travel in the same React commit as the speed/fuel projection. No renderer acknowledgement is used.
export const MARKER_CELL = 4;
export const MARKER_HEIGHT = 8;
export function latencyBits(token: number): number[] {
  if (!Number.isInteger(token) || token < 1 || token > 65535) throw new Error('Invalid latency token');
  const bytes = [0xa5, token >>> 8, token & 255, (token >>> 8) ^ (token & 255) ^ 0x5a];
  return bytes.flatMap(byte => Array.from({length: 8}, (_, bit) => (byte >>> (7 - bit)) & 1));
}

/** Whole-frame, 32-bit bitmap. Black/white is independent of BGRA/RGBA channel order. */
export function readLatencyMarker(bitmap: Uint8Array, width: number, height: number, cssScale: number): number | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
    !Number.isFinite(cssScale) || cssScale < 0.25 || cssScale > 8 || bitmap.length !== width * height * 4) return;
  const bytes = [0, 0, 0, 0];
  const y = Math.floor(MARKER_HEIGHT * cssScale / 2);
  for (let bit = 0; bit < 32; bit++) {
    const x = Math.floor((bit + 0.5) * MARKER_CELL * cssScale);
    if (x >= width || y >= height) return;
    const index = (y * width + x) * 4;
    const channels = [bitmap[index], bitmap[index + 1], bitmap[index + 2]];
    const white = channels.every(channel => channel >= 240), black = channels.every(channel => channel <= 15);
    if ((!white && !black) || bitmap[index + 3] < 240) return;
    bytes[Math.floor(bit / 8)] = (bytes[Math.floor(bit / 8)] << 1) | Number(white);
  }
  if (bytes[0] !== 0xa5 || bytes[3] !== (bytes[1] ^ bytes[2] ^ 0x5a)) return;
  const token = (bytes[1] << 8) | bytes[2];
  return token || undefined;
}
