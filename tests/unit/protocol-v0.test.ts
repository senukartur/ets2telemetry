import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePayload, encodeFrame, FrameDecoder, isUint64, MAX_FRAME_BYTES, negotiateV0, normalizeSdkMeasurement, ProtocolError, V0Consumer, withReceiveTime, type ProtocolMessage, type ServerMessage } from '../../packages/contracts/src';

const dir = resolve('tests/fixtures/protocol-v0');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(dir, `${name}.json`)));
const message = (name: string) => decodePayload(bytes(name));
const rows = (input: string) => input.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const entries = rows(readFileSync(resolve(dir, 'manifest.txt'), 'utf8'));
const streams = rows(readFileSync(resolve(dir, 'streams.txt'), 'utf8'));

describe('REG-010 shared protocol v0 corpus', () => {
  it('reads the manifest identically with Windows CRLF or LF', () => {
    const input = readFileSync(resolve(dir, 'manifest.txt'), 'utf8').replace(/\r?\n/g, '\r\n');
    expect(rows(input)).toEqual(entries);
    const streamInput = readFileSync(resolve(dir, 'streams.txt'), 'utf8').replace(/\r?\n/g, '\r\n');
    expect(rows(streamInput)).toEqual(streams);
  });
  for (const [filename, result] of entries) it(`${result}: ${filename}`, () => {
    const body = new Uint8Array(readFileSync(resolve(dir, filename)));
    if (result === 'invalid') expect(() => decodePayload(body)).toThrow(ProtocolError);
    else {
      const parsed = decodePayload(body); const encoded = encodeFrame(parsed);
      expect(decodePayload(encoded.subarray(4))).toEqual(parsed);
    }
  });
  it('materializes zero/unavailable, canonical units, clocks and exact large identities', () => {
    const m = message('checkpoint'); if (m.kind !== 'checkpoint') throw Error('fixture');
    expect(m.seq).toBe('9007199254740994'); expect(m.source.origin).toBe('synthetic');
    expect(m.data.state.speed).toEqual({ available: true, value: 0, unit: 'm/s' });
    expect(m.data.state.fuel).toEqual({ available: false, reason: 'not-observed', unit: 'L' });
    expect(m.data.state.averageConsumption).toEqual({ available: true, value: 25, unit: 'L/100km' });
    expect(m.data.state.configuration.revision).toBe('9007199254740993');
    expect(m.data.state.window.available && m.data.state.window.value.handle).toBe('18446744073709551615');
    expect(m.data.state.configuration.job.available && m.data.state.configuration.job.value.expectedIncome).toEqual({rawValue:'9007199254740993.123456',currency:{status:'unknown'}});
    expect(m.capture.monotonicNs).toBe('9007199254740993');
    const receive = { clockId: '00000000-0000-4000-8000-000000000099', monotonicNs: '1', utcUnixMs: { available: false, reason: 'not-observed' } } as const;
    expect(withReceiveTime(m, receive).received.monotonicNs).toBe('1');
    expect(withReceiveTime(m, receive).message.capture.monotonicNs).toBe('9007199254740993');
  });
  it('checks uint64 boundaries without JavaScript rounding', () => {
    expect(isUint64('18446744073709551615')).toBe(true);
    for (const v of ['18446744073709551616', '00', '-1', '1.0', '1e3', ' 1', '', 1, undefined]) expect(isUint64(v)).toBe(false);
  });
  it('negotiates only implemented minor zero and cannot enable recording', () => {
    expect(negotiateV0(message('hello'))).toEqual({ version: { major: 0, minor: 0 }, diagnostics: true, durableRecording: false });
    expect(() => negotiateV0(message('snapshot'))).toThrow();
  });
  it('normalizes SDK units, preserves unavailable/zero and rejects invalid native scalars', () => {
    expect(normalizeSdkMeasurement('odometer', { available: true, value: 12.5 })).toEqual({ available: true, value: 12_500, unit: 'm' });
    expect(normalizeSdkMeasurement('estimatedRange', { available: true, value: 10 })).toEqual({ available: true, value: 10_000, unit: 'm' });
    expect(normalizeSdkMeasurement('averageConsumption', { available: true, value: 0.25 })).toEqual({ available: true, value: 25, unit: 'L/100km' });
    expect(normalizeSdkMeasurement('speed', { available: true, value: 0 })).toEqual({ available: true, value: 0, unit: 'm/s' });
    expect(normalizeSdkMeasurement('fuel', { available: false, reason: 'not-supported' })).toEqual({ available: false, reason: 'not-supported', unit: 'L' });
    for (const value of [NaN, Infinity, -1]) expect(normalizeSdkMeasurement('fuel', { available: true, value })).toEqual({ available: false, reason: 'invalid', unit: 'L' });
    expect(normalizeSdkMeasurement('gear', { available: true, value: 1.5 }).available).toBe(false);
  });
  it('rejects huge caller-owned outbound diagnostic strings', () => {
    const m = structuredClone(message('diagnostic')); if (m.kind !== 'diagnostic') throw Error('fixture');
    m.data.observations[1].value = { available: true, value: '🚚'.repeat(1_000_000) };
    expect(() => encodeFrame(m)).toThrow(ProtocolError);
  });
  it('bounds encoded bytes when a valid 32-observation batch expands through JSON escaping', () => {
    const m = structuredClone(message('diagnostic')); if (m.kind !== 'diagnostic') throw Error('fixture');
    m.data.observations = Array.from({ length: 32 }, (_, i) => ({ channel: `channel${i}`, sdkType: 'string', value: { available: true, value: 'x'.repeat(1_024) }, unit: 'raw' }));
    expect(encodeFrame(m).length).toBeLessThan(MAX_FRAME_BYTES + 4);
    for (const observation of m.data.observations) observation.value = { available: true, value: '"'.repeat(1_024) };
    expect(() => encodeFrame(m)).toThrow(ProtocolError);
  });
});

describe('bounded framing', () => {
  it('handles every possible two-way split and multiple frames in one chunk', () => {
    const first = encodeFrame(message('hello')); const second = encodeFrame(message('checkpoint'));
    const combined = new Uint8Array(first.length + second.length); combined.set(first); combined.set(second, first.length);
    for (let split = 0; split <= combined.length; split++) {
      const decoder = new FrameDecoder(); const found: ProtocolMessage[] = [];
      decoder.push(combined.subarray(0, split), m => found.push(m));
      decoder.push(combined.subarray(split), m => found.push(m)); decoder.end();
      expect(found.map(m => m.kind)).toEqual(['hello', 'checkpoint']);
    }
  });
  it('handles byte-at-a-time delivery, including Unicode', () => {
    const decoder = new FrameDecoder(); const found: ProtocolMessage[] = [];
    for (const b of encodeFrame(message('diagnostic'))) decoder.push(Uint8Array.of(b), m => found.push(m));
    decoder.end(); expect(found).toEqual([message('diagnostic')]);
  });
  it('accepts the exact byte bound, rejects oversized/zero before payload allocation', () => {
    const base = bytes('hello'); const exact = new Uint8Array(MAX_FRAME_BYTES); exact.fill(32); exact.set(base);
    const frame = new Uint8Array(4 + exact.length); new DataView(frame.buffer).setUint32(0, exact.length, true); frame.set(exact, 4);
    let count = 0; const decoder = new FrameDecoder(); decoder.push(frame, () => count++); decoder.end(); expect(count).toBe(1);
    for (const length of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
      const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, length, true);
      const d = new FrameDecoder(); expect(() => d.push(header, () => {})).toThrow();
      expect(() => d.push(encodeFrame(message('hello')), () => {})).toThrow();
    }
  });
  it('rejects truncated headers/payloads at EOF and closes after clean EOF', () => {
    const frame = encodeFrame(message('hello'));
    for (const n of [1, 2, 3, 4, frame.length - 1]) {
      const decoder = new FrameDecoder(); decoder.push(frame.subarray(0, n), () => {}); expect(() => decoder.end()).toThrow();
    }
    const clean = new FrameDecoder(); clean.end(); expect(() => clean.push(frame, () => {})).toThrow();
  });
  it('fails closed without applying a later valid frame after malformed input', () => {
    const bad = new TextEncoder().encode('{'); const good = encodeFrame(message('hello'));
    const chunk = new Uint8Array(4 + bad.length + good.length); new DataView(chunk.buffer).setUint32(0, bad.length, true); chunk.set(bad, 4); chunk.set(good, 5);
    const found: ProtocolMessage[] = []; const decoder = new FrameDecoder(); expect(() => decoder.push(chunk, m => found.push(m))).toThrow();
    expect(found).toEqual([]); expect(() => decoder.push(good, m => found.push(m))).toThrow();
  });
});

describe('REG-003/005 checkpoint and ordering (no gameplay effects)', () => {
  for (const [name, requested, inputs, outcome, expected] of streams) it(`shared stream ${name}`, () => {
    const consumer = new V0Consumer(requested === '1'); const applied: string[] = [];
    const run = () => { for (const name of inputs.split(',')) {
      const result = consumer.accept(message(name)); if (result) applied.push(`${Number(result.hydration)}:${result.skippedSequences}`);
    } };
    if (outcome === 'reject') { expect(run).toThrow(ProtocolError); expect(() => consumer.accept(message('snapshot'))).toThrow(ProtocolError); }
    else { run(); expect(applied.join(',')).toBe(expected); }
  });
  it('reconnect creates a fresh consumer and hydrates once without pretending seq skips are loss', () => {
    const first = new V0Consumer(true); first.accept(message('welcome')); first.accept(message('checkpoint'));
    const result = first.accept(message('snapshot'))!;
    expect(result.skippedSequences).toBe('3'); expect(result.continuity.lostObservations).toBe('2');
    const next = new V0Consumer(true); next.accept(message('welcome'));
    expect(next.accept(message('checkpoint'))).toEqual({ hydration: true, skippedSequences: '0', continuity: { coalescedSnapshots: '3', lostObservations: '2', offlineTransitions: '1' } });
  });
  it('exhausted sequence cannot wrap; direct inputs are revalidated', () => {
    const consumer = new V0Consumer(true); consumer.accept(message('welcome')); consumer.accept(message('checkpoint'));
    consumer.accept(message('max-uint64')); expect(() => consumer.accept(message('snapshot'))).toThrow();
    const invalid = structuredClone(message('diagnostic')) as ServerMessage;
    if (invalid.kind !== 'diagnostic') throw Error('fixture'); invalid.data.observations[1].value = { available: true, value: '\ud800' };
    expect(() => encodeFrame(invalid)).toThrow(ProtocolError);
  });
});
