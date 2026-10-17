// Trip identity (ET-014, T4 and T6). A trip UUID is derived from the plugin session and the eventSeq of the job
// configuration that opened it, so replaying or redelivering the same events always yields the same UUID. A pure
// TypeScript SHA-256 keeps telemetry-core free of Node globals and runtime packages (docs/trips.md, "Identity").
import type {JobConfiguration} from '../../../contracts/src/protocol-v1';

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

/** UTF-8 bytes of a string. A lone surrogate becomes U+FFFD, as in the WHATWG encoder. */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00); i++; }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
}

/** SHA-256 (FIPS 180-4) of bytes or of a string's UTF-8 encoding, as 64 lowercase hex digits. */
export function sha256Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  // Padding: 0x80, zeros, then the bit length as a 64-bit big-endian integer, to a multiple of 64 bytes.
  const length = bytes.length, blocks = Math.ceil((length + 9) / 64), padded = new Uint8Array(blocks * 64);
  padded.set(bytes); padded[length] = 0x80;
  const view = new DataView(padded.buffer), bits = length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000)); view.setUint32(padded.length - 4, bits >>> 0);
  const h = H0.slice(), w = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < blocks; block++) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3), s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return h.map(word => word.toString(16).padStart(8, '0')).join('');
}

/** The prefix of every trip UUID hash input. A new derivation would use a new prefix, never reuse this one. */
export const TRIP_UUID_PREFIX = 'ets2telemetry-trip-v1:';
/**
 * The project-owned trip UUID (T4): the first 128 bits of SHA-256("ets2telemetry-trip-v1:" + pluginSessionId + ":" +
 * jobEventSeq), written as 8-4-4-4-12 lowercase hex like the simulator's seeded ids. It carries no RFC 4122 version
 * bits; storage accepts any lowercase hex UUID shape. One job configuration event opens at most one trip, so the pair
 * is unique within the history.
 */
export function tripUuidFor(pluginSessionId: string, jobEventSeq: string): string {
  const h = sha256Hex(`${TRIP_UUID_PREFIX}${pluginSessionId}:${jobEventSeq}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The prefix of a late-attach trip's UUID hash input (ET-016 PR-7, J9); never shared with TRIP_UUID_PREFIX. */
export const ATTACH_TRIP_UUID_PREFIX = 'ets2telemetry-trip-attach-v1:';
/**
 * The UUID of a trip opened from a checkpoint (J9): the first 128 bits of SHA-256("ets2telemetry-trip-attach-v1:" +
 * pluginSessionId + ":" + the checkpoint's nextEventSeq), in the shape of tripUuidFor (T4). Storage keeps at most one
 * checkpoint job per session and nextEventSeq, so the pair opens at most one trip, and its own prefix keeps it apart
 * from every trip opened at an event.
 */
export function attachTripUuidFor(pluginSessionId: string, nextEventSeq: string): string {
  const h = sha256Hex(`${ATTACH_TRIP_UUID_PREFIX}${pluginSessionId}:${nextEventSeq}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** JSON with object members in sorted order at every depth, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).filter(key => o[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(o[key])}`).join(',')}}`;
}

/**
 * Every job.configured field in a fixed order, except `cargoLoaded`: a cargo-market job re-sends its configuration at
 * pickup with only `cargoLoaded` changed (O3), and that re-send is the same job.
 */
export const JOB_KEY_FIELDS = [
  'sourceCityId', 'sourceCity', 'sourceCompanyId', 'sourceCompany', 'destinationCityId', 'destinationCity', 'destinationCompanyId', 'destinationCompany',
  'cargoId', 'cargo', 'cargoMass', 'cargoUnitMass', 'cargoUnitCount', 'market', 'isSpecialJob', 'plannedDistance', 'expectedIncome', 'deliveryDeadline'
] as const satisfies readonly (keyof JobConfiguration)[];
/**
 * The job identity key (T6): the canonical tuple of every job.configured field, with its availability, reason, unit
 * and money currency, except `cargoLoaded`. Two configurations are the same job exactly when their keys are equal. It
 * accepts a job.configured record or the job of a checkpoint configuration, which has the same fields without `type`.
 */
export function jobKey(job: JobConfiguration): string {
  return canonicalJson(JOB_KEY_FIELDS.map(field => job[field]));
}
