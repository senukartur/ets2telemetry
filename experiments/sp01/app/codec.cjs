'use strict';
const MAX_FRAME = 2048;
const uint64 = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const numeric = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
function validate(value, game) {
  if (!value || value.v !== 'sp01-1' || value.game !== game || !/^[a-f0-9]{32}$/.test(value.session) ||
      !['seq', 'frame', 'renderUs', 'simulationUs', 'dropped'].every((key) => uint64(value[key])) ||
      !(value.speedMps === null || numeric(value.speedMps, -200, 200)) ||
      !(value.fuelLitres === null || numeric(value.fuelLitres, 0, 100000)) ||
      typeof value.paused !== 'boolean' || typeof value.timerRestart !== 'boolean') throw new Error('invalid SP-01 snapshot');
  const window = value.window;
  if (!window || typeof window.visible !== 'boolean' ||
      !['x', 'y', 'width', 'height'].every((key) => Number.isInteger(window[key])) ||
      !numeric(window.x, -100000, 100000) || !numeric(window.y, -100000, 100000) ||
      !numeric(window.width, 0, 100000) || !numeric(window.height, 0, 100000) ||
      (window.visible && (window.width === 0 || window.height === 0))) throw new Error('invalid SP-01 window');
  return { v: value.v, game, session: value.session, ...Object.fromEntries(['seq', 'frame', 'renderUs', 'simulationUs', 'dropped', 'speedMps', 'fuelLitres', 'paused', 'timerRestart'].map((key) => [key, value[key]])), window: { visible: window.visible, x: window.x, y: window.y, width: window.width, height: window.height } };
}
class Decoder {
  #pending = Buffer.alloc(0); #session; #sequence = 0n;
  constructor(game) { this.game = game; }
  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length > 65536) throw new Error('SP-01 chunk length');
    const values = [];
    // Scan before concatenation so a malicious chunk cannot make an unbounded retained buffer.
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      const size = this.#pending.length + index - start;
      if (size === 0 || size > MAX_FRAME) throw new Error('SP-01 frame length');
      const frame = Buffer.concat([this.#pending, chunk.subarray(start, index)], size);
      this.#pending = Buffer.alloc(0); start = index + 1;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(frame);
      const value = validate(JSON.parse(text), this.game);
      if (this.#session && value.session !== this.#session) throw new Error('session changed on connection');
      if (BigInt(value.seq) <= this.#sequence) throw new Error('unordered SP-01 frame');
      this.#session = value.session; this.#sequence = BigInt(value.seq); values.push(value);
    }
    if (this.#pending.length + chunk.length - start > MAX_FRAME) throw new Error('SP-01 frame length');
    this.#pending = Buffer.concat([this.#pending, chunk.subarray(start)]);
    return values;
  }
}
module.exports = { Decoder, validate, MAX_FRAME };
