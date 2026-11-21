// CityHash64 v1.0.3 from https://github.com/google/cityhash/tree/00b9287e8c1255b5922ef90e304d5287361b2c2a
// Adapted for HashFS path bytes. Later versions of CityHash64 produce different hashes.
//
// Copyright (c) 2011 Google, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const k0 = 0xc3a5c85c97cb3127n;
const k1 = 0xb492b66fbe98f273n;
const k2 = 0x9ae16a3b2f90404fn;
const k3 = 0xc949d7c7509e6557n;
const multiply = 0x9ddfea08eb382d69n;

const u64 = (value: bigint) => BigInt.asUintN(64, value);
const shiftMix = (value: bigint) => {
  const word = u64(value);
  return word ^ (word >> 47n);
};
const rotate = (value: bigint, bits: bigint) => {
  const word = u64(value);
  return u64((word >> bits) | (word << (64n - bits)));
};

function hashPair(left: bigint, right: bigint) {
  const a = shiftMix((left ^ right) * multiply);
  const b = shiftMix((right ^ a) * multiply);
  return u64(b * multiply);
}

function shortHash(bytes: Buffer) {
  const size = bytes.length, length = BigInt(size);
  if (size > 8) {
    const a = bytes.readBigUInt64LE(), b = bytes.readBigUInt64LE(size - 8);
    return hashPair(a, rotate(b + length, length)) ^ b;
  }
  if (size >= 4) {
    return hashPair(length + (BigInt(bytes.readUInt32LE()) << 3n), BigInt(bytes.readUInt32LE(size - 4)));
  }
  if (size === 0) return k2;
  const left = BigInt(bytes[0] + (bytes[size >> 1] << 8));
  const right = length + BigInt(bytes[size - 1] << 2);
  return u64(shiftMix(left * k2 ^ right * k3) * k2);
}

function mediumHash(bytes: Buffer) {
  const size = bytes.length;
  const a = u64(bytes.readBigUInt64LE() * k1);
  const b = bytes.readBigUInt64LE(8);
  const c = u64(bytes.readBigUInt64LE(size - 8) * k2);
  const d = u64(bytes.readBigUInt64LE(size - 16) * k0);
  return hashPair(rotate(a - b, 43n) + rotate(c, 30n) + d, a + rotate(b ^ k3, 20n) - c + BigInt(size));
}

function blockHash(bytes: Buffer, start: bigint, mid: number, end: number): [bigint, bigint] {
  const first = start + bytes.readBigUInt64LE(mid);
  const last = bytes.readBigUInt64LE(end);
  const sum = first + bytes.readBigUInt64LE(mid + 8);
  return [u64(sum + last), u64(rotate(start + last, 52n) + rotate(start, 37n) + rotate(first, 7n) + rotate(sum, 31n))];
}

function weakBlock(bytes: Buffer, offset: number, seedA: bigint, seedB: bigint): [bigint, bigint] {
  const first = seedA + bytes.readBigUInt64LE(offset);
  const last = bytes.readBigUInt64LE(offset + 24);
  const sum = first + bytes.readBigUInt64LE(offset + 8) + bytes.readBigUInt64LE(offset + 16);
  return [u64(sum + last), u64(rotate(seedB + first + last, 21n) + rotate(sum, 44n) + first)];
}

export function hashArchivePath(path: string): bigint {
  const bytes = Buffer.from(path, 'utf8'), size = bytes.length, length = BigInt(size);
  if (size <= 16) return shortHash(bytes);
  if (size <= 32) return mediumHash(bytes);
  if (size <= 64) {
    const [v1, v2] = blockHash(bytes, bytes.readBigUInt64LE() + (length + bytes.readBigUInt64LE(size - 16)) * k0, 8, 24);
    const [w1, w2] = blockHash(bytes, bytes.readBigUInt64LE(16) + bytes.readBigUInt64LE(size - 32), size - 24, size - 8);
    const mixed = shiftMix((v1 + w2) * k2 + (w1 + v2) * k0);
    return u64(shiftMix(mixed * k0 + v2) * k2);
  }
  let x = bytes.readBigUInt64LE(size - 40);
  let y = u64(bytes.readBigUInt64LE(size - 16) + bytes.readBigUInt64LE(size - 56));
  let z = hashPair(bytes.readBigUInt64LE(size - 48) + length, bytes.readBigUInt64LE(size - 24));
  let v = weakBlock(bytes, size - 64, length, z), w = weakBlock(bytes, size - 32, y + k1, x);
  x = u64(x * k1 + bytes.readBigUInt64LE());
  for (let offset = 0; offset + 64 < size; offset += 64) {
    x = u64(rotate(x + y + v[0] + bytes.readBigUInt64LE(offset + 8), 37n) * k1) ^ w[1];
    y = u64(rotate(y + v[1] + bytes.readBigUInt64LE(offset + 48), 42n) * k1 + v[0] + bytes.readBigUInt64LE(offset + 40));
    z = u64(rotate(z + w[0], 33n) * k1);
    v = weakBlock(bytes, offset, v[1] * k1, x + w[0]);
    w = weakBlock(bytes, offset + 32, z + w[1], y + bytes.readBigUInt64LE(offset + 16));
    [x, z] = [z, x];
  }
  return hashPair(hashPair(v[0], w[0]) + shiftMix(y) * k1 + z, hashPair(v[1], w[1]) + x);
}
