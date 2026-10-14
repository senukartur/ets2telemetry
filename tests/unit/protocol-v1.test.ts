import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  decodePayload, encodeFrame, EVENT_TYPES, FrameDecoder, fraction, GAP_RECORD_BYTES, kmToMetersFloat, kmToMetersU32, MAX_EVENT_SEQ, negotiateV1, PROTOCOL_V1,
  ProtocolError, sdkMoney, sdkText, V1_LIMITS, type ProtocolMessage, type Sender, type ServerMessage
} from '../../packages/contracts/src/protocol-v1';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {Cap0Error, decodeCap0Payload, encodeCap0Hello} from '../../packages/contracts/src/capture-cap0';
import {delivered, end, envelope, header, loss, payload as cap0Payload} from '../shared/cap0-fixtures';

const dir = resolve('tests/fixtures/protocol-v1');
const v0Dir = resolve('tests/fixtures/protocol-v0');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(dir, `${name}.json`)));
const server = (name: string) => decodePayload(bytes(name), 'server') as ServerMessage;
const client = (name: string) => decodePayload(bytes(name), 'client');
const rows = (input: string) => input.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const entries = rows(readFileSync(resolve(dir, 'manifest.txt'), 'utf8'));
const streams = rows(readFileSync(resolve(dir, 'streams.txt'), 'utf8'));
const senderOf = (result: string): Sender => result.endsWith('-client') ? 'client' : 'server';
const frameOf = (payload: Uint8Array) => { const out = new Uint8Array(4 + payload.length); new DataView(out.buffer).setUint32(0, payload.length, true); out.set(payload, 4); return out; };
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const v0Valid = rows(readFileSync(resolve(v0Dir, 'manifest.txt'), 'utf8')).filter(([, result]) => result === 'valid').map(([file]) => file);
const v1Valid = entries.filter(([, result]) => result.startsWith('valid')).map(([file, result]) => [file, senderOf(result)] as const);

describe('REG-010 shared protocol v1 corpus', () => {
  it('reads the manifest and streams identically with Windows CRLF or LF', () => {
    for (const [name, parsed] of [['manifest.txt', entries], ['streams.txt', streams]] as const) {
      const input = readFileSync(resolve(dir, name), 'utf8').replace(/\r?\n/g, '\r\n');
      expect(rows(input)).toEqual(parsed);
    }
  });
  it('lists every fixture exactly once with a known expectation', () => {
    const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
    expect(entries.map(([file]) => file).sort()).toEqual(files);
    for (const entry of entries) { expect(entry).toHaveLength(2); expect(['valid', 'invalid', 'valid-client', 'invalid-client']).toContain(entry[1]); }
  });
  for (const [filename, result] of entries) it(`${result}: ${filename}`, () => {
    const body = new Uint8Array(readFileSync(resolve(dir, filename))), sender = senderOf(result);
    if (result.startsWith('invalid')) { expect(() => decodePayload(body, sender)).toThrow(ProtocolError); return; }
    const parsed = decodePayload(body, sender), encoded = encodeFrame(parsed);
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(encoded.length - 4);
    expect(decodePayload(encoded.subarray(4), sender)).toEqual(parsed);
    // Direction is part of the contract: a server message is never a valid client frame and vice versa.
    expect(() => decodePayload(body, sender === 'server' ? 'client' : 'server')).toThrow(ProtocolError);
  });
  it('covers every server kind, client kind and minor-0 record type with a valid fixture', () => {
    const kinds = new Set<string>(), types = new Set<string>();
    for (const [file, sender] of v1Valid) {
      const m = decodePayload(new Uint8Array(readFileSync(resolve(dir, file))), sender); kinds.add(m.kind);
      if (m.kind === 'event') types.add(m.data.record.type);
    }
    expect([...kinds].sort()).toEqual(['ack', 'checkpoint', 'clock.probe', 'clock.reply', 'end', 'event', 'gap', 'hello', 'snapshot', 'welcome']);
    expect([...types].sort()).toEqual([...EVENT_TYPES].sort());
  });
});

describe('REG-009 availability, units, time and money', () => {
  it('distinguishes zero from unavailable for speed and revenue', () => {
    const cp = server('checkpoint'), snap = server('snapshot');
    if (cp.kind !== 'checkpoint' || snap.kind !== 'snapshot') throw new Error('fixture');
    expect(cp.data.state.speed).toEqual({available: true, value: 0, unit: 'm/s'});
    expect(snap.data.state.speed).toEqual({available: false, reason: 'not-observed', unit: 'm/s'});
    const zero = server('event-job-delivered-zero-revenue'), missing = server('event-job-delivered-unavailable-revenue');
    if (zero.kind !== 'event' || zero.data.record.type !== 'job.delivered' || missing.kind !== 'event' || missing.data.record.type !== 'job.delivered') throw new Error('fixture');
    expect(zero.data.record.revenue).toEqual({available: true, value: {raw: '0', sdkType: 's64', currency: {status: 'unknown'}}});
    expect(missing.data.record.revenue).toEqual({available: false, reason: 'not-observed'});
    expect(missing.data.record.cargoDamage).toEqual({available: false, reason: 'invalid', unit: 'fraction'});
  });
  it('keeps a provided empty string available and distinct from a value that was not sent', () => {
    const m = server('event-trailer-configured'); if (m.kind !== 'event' || m.data.record.type !== 'trailer.configured') throw new Error('fixture');
    expect(m.data.record.cargoAccessoryId).toEqual({available: true, value: ''});
    expect(m.data.record.name).toEqual({available: false, reason: 'not-observed'});
    expect(m.data.record.id).toEqual({available: true, value: 'trailer.synthetic_box'});
  });
  it('separates real capture time, game time and UTC labels, and planned from delivered distance', () => {
    const m = server('event-job-delivered'); if (m.kind !== 'event' || m.data.record.type !== 'job.delivered') throw new Error('fixture');
    expect(m.data.occurred.monotonicNs).toEqual({available: true, value: '1000149000000'});
    expect(m.data.occurred.gameTime).toEqual({minutes: {available: true, value: '12345'}, clockId: '40000000-0000-4000-8000-000000000001'});
    expect(m.data.occurred.utcUnixMs).toEqual({available: true, value: '1791676800000'});
    expect(m.data.record.deliveryDuration).toEqual({available: true, value: '471', unit: 'min'});
    expect(m.data.record.distance).toEqual({available: true, value: 151250.5, unit: 'm'});
    const job = server('event-job-configured'); if (job.kind !== 'event' || job.data.record.type !== 'job.configured') throw new Error('fixture');
    expect(job.data.record.plannedDistance).toEqual({available: true, value: 152000, unit: 'm'});
    expect(job.data.record.deliveryDeadline).toEqual({available: true, value: '13000', unit: 'min'});
  });
  it('keeps raw money exact with unknown or SDK-documented currency', () => {
    const unknown = server('event-job-configured'), documented = server('event-job-configured-documented-currency');
    if (unknown.kind !== 'event' || unknown.data.record.type !== 'job.configured' || documented.kind !== 'event' || documented.data.record.type !== 'job.configured') throw new Error('fixture');
    expect(unknown.data.record.expectedIncome).toEqual({available: true, value: {raw: '12345', sdkType: 'u64', currency: {status: 'unknown'}}});
    expect(documented.data.record.expectedIncome).toEqual({available: true, value: {raw: '12345', sdkType: 'u64',
      currency: {status: 'sdk-documented', code: 'EUR', source: 'scs-sdk-1.15/include/eurotrucks2/scssdk_telemetry_eut2.h#game-specific-units'}}});
  });
  it('keeps game-world placement as game coordinates and game mode evidence intact', () => {
    const cp = server('checkpoint'); if (cp.kind !== 'checkpoint') throw new Error('fixture');
    expect(cp.data.state.worldPlacement).toEqual({available: true, value: {position: {x: -31234.5, y: 42.25, z: 18800.75}, orientation: {heading: 0.25, pitch: 0, roll: -0.01}}});
    expect(cp.data.status.gameMode).toEqual({mode: 'single-player', method: 'module-scan', confidence: 'weak', module: {available: false, reason: 'not-observed'}});
    const mode = server('event-source-game-mode'); if (mode.kind !== 'event' || mode.data.record.type !== 'source.gameMode') throw new Error('fixture');
    expect(mode.data.record.mode).toBe('truckersmp'); expect(mode.data.record.confidence).toBe('strong');
  });
});

describe('64-bit identifiers', () => {
  it('materializes exact large sequences and money without JavaScript rounding', () => {
    const max = server('max-seq'); expect(max.seq).toBe('18446744073709551615'); expect(max.capture.monotonicNs).toBe('18446744073709551615');
    const big = server('event-seq-2pow53'), last = server('event-seq-last');
    if (big.kind !== 'event' || last.kind !== 'event') throw new Error('fixture');
    expect(big.data.eventSeq).toBe('9007199254740993'); expect(last.data.eventSeq).toBe(MAX_EVENT_SEQ);
    expect(MAX_EVENT_SEQ).toBe('18446744073709551614');
    const min = server('money-int64-min'), umax = server('money-uint64-max');
    if (min.kind !== 'event' || min.data.record.type !== 'job.cancelled' || umax.kind !== 'event' || umax.data.record.type !== 'job.configured') throw new Error('fixture');
    expect(min.data.record.penalty).toEqual({available: true, value: {raw: '-9223372036854775808', sdkType: 's64', currency: {status: 'unknown'}}});
    expect(umax.data.record.expectedIncome).toEqual({available: true, value: {raw: '18446744073709551615', sdkType: 'u64', currency: {status: 'unknown'}}});
    const roundTrip = decodePayload(encodeFrame(umax).subarray(4), 'server');
    expect(roundTrip).toEqual(umax);
  });
  it('rejects a caller-built eventSeq outside 1..MAX_EVENT_SEQ before serializing', () => {
    const m = structuredClone(server('event-job-cleared')); if (m.kind !== 'event') throw new Error('fixture');
    for (const value of ['0', '18446744073709551615', '01', '-1']) { m.data.eventSeq = value; expect(() => encodeFrame(m)).toThrow(ProtocolError); }
  });
});

describe('size bounds', () => {
  it('fits the worst-case checkpoint and event, and rejects one byte over each bound', () => {
    const worst = bytes('checkpoint-worst'), event = bytes('event-worst');
    expect(worst.length).toBeLessThanOrEqual(V1_LIMITS.serverFrameBytes); expect(event.length).toBeLessThanOrEqual(V1_LIMITS.eventBytes);
    expect(encodeFrame(server('checkpoint-worst')).length - 4).toBe(worst.length);
    expect(bytes('checkpoint-size-limit').length).toBe(65_536); expect(bytes('checkpoint-oversized').length).toBe(65_537);
    expect(bytes('event-size-limit').length).toBe(16_384); expect(bytes('event-oversized').length).toBe(16_385);
    expect(() => server('event-oversized')).toThrow(/event size/);
    expect(bytes('hello-exact').length).toBe(4_096); expect(bytes('hello-oversized').length).toBe(4_097);
    expect(() => client('hello-oversized')).toThrow(/size/);
  });
  it('fits the worst-case gap into the bytes reserved for one gap record and bounds a full retained store', () => {
    expect(GAP_RECORD_BYTES).toBe(1_024); expect(bytes('gap-worst').length).toBeLessThanOrEqual(GAP_RECORD_BYTES);
    const full = server('snapshot-full-store'); if (full.kind !== 'snapshot') throw new Error('fixture');
    expect(full.data.status.delivery).toMatchObject({retainedEvents: 256, retainedBytes: 1_048_576}); expect(full.data.status.eventLoss.queueCount).toBe('44');
    expect(() => server('status-full-without-gap-bytes')).toThrow(ProtocolError); expect(() => server('status-bytes-limit')).toThrow(ProtocolError);
  });
  it('declares the approved fixed limits', () => {
    expect(PROTOCOL_V1).toEqual({major: 1, minor: 0});
    expect(V1_LIMITS).toEqual({serverFrameBytes: 65_536, clientFrameBytes: 4_096, eventBytes: 16_384, retainedEntries: 256, retainedBytes: 1_048_576,
      disconnectRetentionMs: 300_000, helloTimeoutMs: 5_000, writeDeadlineMs: 1_000, snapshotIntervalMs: 50, trailerSlots: 10});
  });
});

describe('major isolation from v0 and CAP0', () => {
  it('the v1 decoder rejects every valid v0 fixture in both directions', () => {
    for (const file of v0Valid) {
      const body = new Uint8Array(readFileSync(resolve(v0Dir, file)));
      expect(() => decodePayload(body, 'server'), file).toThrow(ProtocolError); expect(() => decodePayload(body, 'client'), file).toThrow(ProtocolError);
    }
  });
  it('the v0 decoder rejects every valid v1 fixture', () => {
    for (const [file] of v1Valid) expect(() => v0.decodePayload(new Uint8Array(readFileSync(resolve(dir, file)))), file).toThrow(v0.ProtocolError);
  });
  it('v1 rejects CAP0 packets and the CAP0 hello, and CAP0 rejects v1 messages', () => {
    for (const packet of [header(), envelope(1, 1, {observations: delivered()}), loss(2, 3, 1), end(3, 3, 1)]) {
      expect(() => decodePayload(cap0Payload(packet), 'server')).toThrow(ProtocolError);
    }
    expect(() => decodePayload(encodeCap0Hello('0cab0000-0000-4000-8000-0000000000a1').subarray(4), 'client')).toThrow(ProtocolError);
    for (const [file] of v1Valid) expect(() => decodeCap0Payload(new Uint8Array(readFileSync(resolve(dir, file)))), file).toThrow(Cap0Error);
  });
  it('the v1 frame decoder rejects a v0 frame', () => {
    const decoder = new FrameDecoder('client');
    expect(() => decoder.push(v0.encodeFrame(v0.decodePayload(new Uint8Array(readFileSync(resolve(v0Dir, 'hello.json'))))), () => {})).toThrow(ProtocolError);
  });
});

describe('version negotiation', () => {
  it('selects minor 0 and never grants more durable delivery than requested or allowed', () => {
    expect(negotiateV1(client('hello'))).toEqual({version: {major: 1, minor: 0}, minor: 0, durableEvents: true});
    expect(negotiateV1(client('hello-wider-minor'))).toEqual({version: {major: 1, minor: 0}, minor: 0, durableEvents: true});
    expect(negotiateV1(client('hello-live')).durableEvents).toBe(false);
    expect(negotiateV1(client('hello'), {allowDurable: false}).durableEvents).toBe(false);
  });
  it('rejects a v0 hello, major 2 and non-hello messages', () => {
    const v0Hello = JSON.parse(readFileSync(resolve(v0Dir, 'hello.json'), 'utf8')) as unknown;
    expect(() => negotiateV1(v0Hello)).toThrow(ProtocolError);
    expect(() => negotiateV1(JSON.parse(readFileSync(resolve(dir, 'hello-major-2.json'), 'utf8')))).toThrow(ProtocolError);
    expect(() => negotiateV1(client('ack-5'))).toThrow(ProtocolError);
    expect(() => negotiateV1(server('welcome'))).toThrow(ProtocolError);
  });
});

describe('bounded framing', () => {
  const pair = (sender: Sender, a: string, b: string) => [concat(encodeFrame(decodePayload(bytes(a), sender)), encodeFrame(decodePayload(bytes(b), sender))), [a, b]] as const;
  it('handles every possible two-way split of combined frames in both directions', () => {
    for (const [sender, [combined]] of [['server', pair('server', 'welcome', 'checkpoint')], ['client', pair('client', 'hello', 'ack-5')]] as const) {
      const expected = sender === 'server' ? ['welcome', 'checkpoint'] : ['hello', 'ack'];
      for (let split = 0; split <= combined.length; split++) {
        const decoder = new FrameDecoder(sender), found: ProtocolMessage[] = [];
        decoder.push(combined.subarray(0, split), m => found.push(m)); decoder.push(combined.subarray(split), m => found.push(m)); decoder.end();
        expect(found.map(m => m.kind)).toEqual(expected);
      }
    }
  });
  it('handles byte-at-a-time delivery, including multibyte UTF-8 and escapes', () => {
    for (const name of ['event-job-configured-localized', 'checkpoint-worst']) {
      const decoder = new FrameDecoder('server'), found: ProtocolMessage[] = [];
      for (const b of encodeFrame(server(name))) decoder.push(Uint8Array.of(b), m => found.push(m));
      decoder.end(); expect(found).toEqual([server(name)]);
    }
  });
  it('applies the direction limit to the length prefix before allocating', () => {
    for (const [sender, limit] of [['server', 65_536], ['client', 4_096]] as const) {
      const exact = new Uint8Array(limit).fill(0x20); exact.set(bytes(sender === 'server' ? 'welcome' : 'hello'));
      let count = 0; const ok = new FrameDecoder(sender); ok.push(frameOf(exact), () => count++); ok.end(); expect(count).toBe(1);
      for (const length of [0, limit + 1, 0xffffffff]) {
        const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, length, true);
        const d = new FrameDecoder(sender); expect(() => d.push(prefix, () => {})).toThrow(ProtocolError);
        expect(() => d.push(frameOf(bytes('hello')), () => {})).toThrow(ProtocolError);
      }
    }
    // A 4,097-byte client-size payload is legal from the server, but a server frame over 64 KiB is not.
    const d = new FrameDecoder('server'); const padded = new Uint8Array(4_097).fill(0x20); padded.set(bytes('welcome'));
    let count = 0; d.push(frameOf(padded), () => count++); expect(count).toBe(1);
  });
  it('rejects a partial header or payload at EOF and stays closed after clean EOF', () => {
    const frame = encodeFrame(client('hello'));
    for (const n of [1, 3, 4, frame.length - 1]) { const d = new FrameDecoder('client'); d.push(frame.subarray(0, n), () => {}); expect(() => d.end()).toThrow(ProtocolError); }
    const clean = new FrameDecoder('client'); clean.end(); expect(() => clean.push(frame, () => {})).toThrow(ProtocolError);
  });
  it('fails closed without emitting a later valid frame after malformed input', () => {
    const good = encodeFrame(server('welcome')), chunk = concat(frameOf(new TextEncoder().encode('{')), good);
    const found: ProtocolMessage[] = [], decoder = new FrameDecoder('server');
    expect(() => decoder.push(chunk, m => found.push(m))).toThrow(ProtocolError);
    expect(found).toEqual([]); expect(() => decoder.push(good, m => found.push(m))).toThrow(ProtocolError);
  });
  it('rejects recursive push calls and stops when the callback ends the decoder', () => {
    const frame = encodeFrame(client('hello')), twice = concat(frame, frame);
    const recursive = new FrameDecoder('client'); let emitted = 0;
    expect(() => recursive.push(frame, () => { emitted++; recursive.push(frame, () => { emitted++; }); })).toThrow(ProtocolError);
    expect(emitted).toBe(1); expect(() => recursive.push(frame, () => {})).toThrow(ProtocolError);
    const ending = new FrameDecoder('client'); let seen = 0;
    ending.push(twice, () => { seen++; if (seen === 1) ending.end(); });
    expect(seen).toBe(1); expect(() => ending.push(frame, () => {})).toThrow(ProtocolError);
  });
});

describe('JSON nesting depth', () => {
  // The root is depth 0 and the limit is 16. A parsed non-message fails the schema (Invalid); a deeper one fails parsing (Malformed).
  const decode = (text: string) => () => decodePayload(new TextEncoder().encode(text), 'server');
  const arrays = (n: number, inner: string) => '['.repeat(n) + inner + ']'.repeat(n);
  const objects = (n: number, inner: string) => '{"a":'.repeat(n) + inner + '}'.repeat(n);
  it('accepts 16 nested containers around a scalar and rejects 17', () => {
    expect(decode(arrays(16, '0'))).toThrow(/^Invalid protocol v1 message$/); expect(decode(arrays(17, '0'))).toThrow(/^Malformed protocol v1 JSON$/);
    expect(decode(objects(16, '0'))).toThrow(/^Invalid protocol v1 message$/); expect(decode(objects(17, '0'))).toThrow(/^Malformed protocol v1 JSON$/);
  });
  it('accepts 17 nested empty containers and rejects 18', () => {
    expect(decode(arrays(16, '[]'))).toThrow(/^Invalid protocol v1 message$/); expect(decode(arrays(17, '[]'))).toThrow(/^Malformed protocol v1 JSON$/);
    expect(decode(objects(16, '{}'))).toThrow(/^Invalid protocol v1 message$/); expect(decode(objects(17, '{}'))).toThrow(/^Malformed protocol v1 JSON$/);
  });
  it('rejects deep.json while parsing, not in the schema', () => {
    expect(() => server('deep')).toThrow(/^Malformed protocol v1 JSON$/);
  });
});

describe('encoding validates first', () => {
  it('rejects invalid caller-owned values, including lone surrogates and unknown record types', () => {
    const m = structuredClone(server('event-truck-configured')); if (m.kind !== 'event' || m.data.record.type !== 'truck.configured') throw new Error('fixture');
    m.data.record.name = {available: true, value: 'x\ud800'}; expect(() => encodeFrame(m)).toThrow(ProtocolError);
    const bus = structuredClone(server('event-job-cleared')) as unknown as {data: {record: {type: string}}};
    bus.data.record.type = 'bus_job'; expect(() => encodeFrame(bus as unknown as ProtocolMessage)).toThrow(ProtocolError);
  });
});

describe('SDK normalization helpers', () => {
  it('converts kilometres exactly and preserves unavailable and zero', () => {
    expect(kmToMetersU32({available: true, value: 4_294_967_295})).toEqual({available: true, value: 4_294_967_295_000, unit: 'm'});
    expect(kmToMetersU32({available: true, value: 0})).toEqual({available: true, value: 0, unit: 'm'});
    for (const value of [1.5, -1, 4_294_967_296, NaN]) expect(kmToMetersU32({available: true, value})).toEqual({available: false, reason: 'invalid', unit: 'm'});
    expect(kmToMetersU32({available: false, reason: 'not-supported'})).toEqual({available: false, reason: 'not-supported', unit: 'm'});
    expect(kmToMetersFloat({available: true, value: 12.5})).toEqual({available: true, value: 12_500, unit: 'm'});
    expect(kmToMetersFloat({available: true, value: 0})).toEqual({available: true, value: 0, unit: 'm'});
    for (const value of [NaN, Infinity, -0.5]) expect(kmToMetersFloat({available: true, value})).toEqual({available: false, reason: 'invalid', unit: 'm'});
    expect(fraction({available: true, value: 0})).toEqual({available: true, value: 0, unit: 'fraction'});
    expect(fraction({available: true, value: NaN})).toEqual({available: false, reason: 'invalid', unit: 'fraction'});
    expect(fraction({available: false, reason: 'not-observed'})).toEqual({available: false, reason: 'not-observed', unit: 'fraction'});
  });
  it('keeps money exact from strings or bigints and never rounds an out-of-range value', () => {
    const unknown = {status: 'unknown'} as const;
    expect(sdkMoney(-(2n ** 63n), 's64', unknown)).toEqual({available: true, value: {raw: '-9223372036854775808', sdkType: 's64', currency: unknown}});
    expect(sdkMoney('18446744073709551615', 'u64', unknown)).toEqual({available: true, value: {raw: '18446744073709551615', sdkType: 'u64', currency: unknown}});
    expect(sdkMoney('0', 's64', unknown)).toEqual({available: true, value: {raw: '0', sdkType: 's64', currency: unknown}});
    for (const [raw, type] of [['18446744073709551616', 'u64'], [2n ** 63n, 's64'], ['-1', 'u64'], ['1.5', 's64'], ['-0', 's64']] as const) {
      expect(sdkMoney(raw, type, unknown)).toEqual({available: false, reason: 'invalid'});
    }
    expect(sdkMoney('1', 's64', {status: 'sdk-documented', code: 'EUR', source: ''})).toEqual({available: false, reason: 'invalid'});
  });
  it('maps SDK text to available, provided-empty, not-observed or invalid without truncation', () => {
    expect(sdkText(undefined, 'id')).toEqual({available: false, reason: 'not-observed'});
    expect(sdkText('', 'id')).toEqual({available: true, value: ''});
    expect(sdkText('x'.repeat(128), 'id')).toEqual({available: true, value: 'x'.repeat(128)});
    expect(sdkText('x'.repeat(129), 'id')).toEqual({available: false, reason: 'invalid'});
    expect(sdkText('é'.repeat(128), 'name')).toEqual({available: true, value: 'é'.repeat(128)});
    expect(sdkText('é'.repeat(129), 'name')).toEqual({available: false, reason: 'invalid'});
    expect(sdkText('a\u007f', 'name')).toEqual({available: false, reason: 'invalid'});
  });
});
