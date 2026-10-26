import {readdirSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  decodePayload, encodeFrame, EVENT_TYPES, FrameDecoder, fraction, GAP_RECORD_BYTES, kmToMetersFloat, kmToMetersU32, MAX_EVENT_SEQ, negotiateV1, PROTOCOL_V1,
  NOT_SUPPORTED_BREAK, NOT_SUPPORTED_GEARBOX, ProtocolError, sdkMoney, sdkText, V1_GEARBOX, V1_LIMITS, V1_MAX_MINOR, validateLiveObservationV1, type GearboxState, type ProtocolMessage, type Sender, type ServerMessage
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

// ET-050b PR-1: protocol v1 minor 1, the gearbox state. The minor-1 corpus has its own directory, manifest and streams,
// so the frozen minor-0 corpus above, and its C++ reader, are unchanged. Expected values below are written by hand from
// docs/protocol/v1.md and the CAP-01 run4/run9 hshifter captures.
const m1Dir = resolve(dir, 'minor1');
const M1 = {maxMinor: 1} as const;
const m1Bytes = (name: string) => new Uint8Array(readFileSync(resolve(m1Dir, `${name}.json`)));
const m1Server = (name: string) => decodePayload(m1Bytes(name), 'server', M1) as ServerMessage;
const m1Entries = rows(readFileSync(resolve(m1Dir, 'manifest.txt'), 'utf8'));
const m1Streams = rows(readFileSync(resolve(m1Dir, 'streams.txt'), 'utf8'));
const gearboxOf = (name: string): GearboxState => {
  const m = m1Server(name); if ((m.kind !== 'checkpoint' && m.kind !== 'snapshot') || !m.data.state.gearbox) throw new Error('fixture');
  return m.data.state.gearbox;
};
const table = (box: GearboxState) => {
  if (!box.hshifter.available) throw new Error('fixture');
  return box.hshifter.value.slots.map(s => `${s.gear}=h${s.handlePosition}/s${s.selectors}`).join(' ');
};

describe('ET-050b protocol v1 minor-1 corpus', () => {
  it('reads its manifest and streams identically with Windows CRLF or LF', () => {
    for (const [name, parsed] of [['manifest.txt', m1Entries], ['streams.txt', m1Streams]] as const) {
      expect(rows(readFileSync(resolve(m1Dir, name), 'utf8').replace(/\r?\n/g, '\r\n'))).toEqual(parsed);
    }
  });
  it('lists every minor-1 fixture exactly once with a known expectation', () => {
    const files = readdirSync(m1Dir).filter(file => file.endsWith('.json')).sort();
    expect(m1Entries.map(([file]) => file).sort()).toEqual(files);
    expect(files).toHaveLength(48);
    for (const entry of m1Entries) { expect(entry).toHaveLength(2); expect(['valid', 'invalid', 'valid-client', 'invalid-client']).toContain(entry[1]); }
  });
  for (const [filename, result] of m1Entries) it(`${result} at maxMinor 1: ${filename}`, () => {
    const body = new Uint8Array(readFileSync(resolve(m1Dir, filename))), sender = senderOf(result);
    if (result.startsWith('invalid')) { expect(() => decodePayload(body, sender, M1)).toThrow(ProtocolError); return; }
    const parsed = decodePayload(body, sender, M1), encoded = encodeFrame(parsed, M1);
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(encoded.length - 4);
    expect(decodePayload(encoded.subarray(4), sender, M1)).toEqual(parsed);
    expect(() => decodePayload(body, sender === 'server' ? 'client' : 'server', M1)).toThrow(ProtocolError);
    // Without the opt-in every entry point stays at minor 0: a minor-1 envelope is refused, a minor-0 one unchanged.
    if (parsed.version.minor === 1) {
      expect(() => decodePayload(body, sender)).toThrow(/Unsupported protocol version/); expect(() => encodeFrame(parsed)).toThrow(/Unsupported protocol version/);
    } else expect(decodePayload(body, sender)).toEqual(parsed);
  });
  it('gives every frozen minor-0 fixture the same result for a reader that accepts minor 1', () => {
    for (const [filename, result] of entries) {
      const body = new Uint8Array(readFileSync(resolve(dir, filename))), sender = senderOf(result);
      if (result.startsWith('invalid')) expect(() => decodePayload(body, sender, M1), filename).toThrow(ProtocolError);
      else expect(decodePayload(body, sender, M1), filename).toEqual(decodePayload(body, sender));
    }
  });
  it('carries the CAP-01 ETS2 12-speed and ATS Mack 18-speed layouts exactly', () => {
    const daf = gearboxOf('checkpoint'), mack = gearboxOf('checkpoint-ats-mack');
    expect(daf.forwardGears).toEqual({available: true, value: 12}); expect(daf.reverseGears).toEqual({available: true, value: 4});
    expect(daf.hshifter.available && daf.hshifter.value.selectorCount).toBe(2);
    expect(table(daf)).toBe('-1=h1/s0 -3=h1/s1 -2=h1/s2 -4=h1/s3 1=h2/s0 7=h2/s1 2=h2/s2 8=h2/s3 3=h3/s0 9=h3/s1 4=h3/s2 10=h3/s3 5=h4/s0 11=h4/s1 6=h4/s2 12=h4/s3');
    expect(mack.forwardGears).toEqual({available: true, value: 18}); expect(mack.reverseGears).toEqual({available: true, value: 4});
    // Handle position 3 holds the crawler gears 1 and 2; its two other selector states are neutral and omitted.
    expect(table(mack)).toBe('-1=h2/s0 -3=h2/s1 -2=h2/s2 -4=h2/s3 1=h3/s0 2=h3/s2 3=h4/s0 11=h4/s1 4=h4/s2 12=h4/s3 5=h5/s0 13=h5/s1 6=h5/s2 14=h5/s3 ' +
      '7=h6/s0 15=h6/s1 8=h6/s2 16=h6/s3 9=h7/s0 17=h7/s1 10=h7/s2 18=h7/s3');
  });
  it('keeps unavailable counts and layouts distinct from an available empty or zero-selector layout', () => {
    expect(gearboxOf('snapshot').hshifter).toEqual({available: false, reason: 'not-observed'});
    expect(gearboxOf('snapshot-hshifter-invalid').hshifter).toEqual({available: false, reason: 'invalid'});
    const counts = gearboxOf('snapshot-counts-not-observed');
    expect(counts.forwardGears).toEqual({available: false, reason: 'not-observed'}); expect(counts.reverseGears).toEqual({available: false, reason: 'not-observed'});
    expect(counts.hshifter.available).toBe(true);
    expect(gearboxOf('snapshot-gearbox-not-supported')).toEqual({forwardGears: {available: false, reason: 'not-supported'},
      reverseGears: {available: false, reason: 'not-supported'}, hshifter: {available: false, reason: 'not-supported'}});
    expect(gearboxOf('snapshot-all-neutral-slots').hshifter).toEqual({available: true, value: {selectorCount: 2, slots: []}});
    const zero = gearboxOf('snapshot-zero-selectors');
    expect(zero.hshifter.available && zero.hshifter.value.selectorCount).toBe(0); expect(table(zero)).toBe('-1=h1/s0 1=h2/s0 2=h3/s0 3=h4/s0 4=h5/s0 5=h6/s0 6=h7/s0');
  });
  it('fits the worst-case minor-1 checkpoint within the server frame (D17) and decodes it byte at a time', () => {
    const worst = m1Bytes('checkpoint-worst'), box = gearboxOf('checkpoint-worst');
    expect(worst.length).toBe(55_394); expect(worst.length).toBeLessThanOrEqual(V1_LIMITS.serverFrameBytes);
    // The frozen minor-0 worst case plus the largest gearbox: two not-supported counts and 64 slots of maximal width.
    expect(worst.length - bytes('checkpoint-worst').length).toBe(3_400);
    expect(box.forwardGears).toEqual({available: false, reason: 'not-supported'});
    expect(box.hshifter.available && box.hshifter.value.selectorCount).toBe(6); expect(box.hshifter.available && box.hshifter.value.slots).toHaveLength(64);
    expect(encodeFrame(m1Server('checkpoint-worst'), M1).length - 4).toBe(worst.length);
    const decoder = new FrameDecoder('server', M1), found: ProtocolMessage[] = [];
    for (const b of encodeFrame(m1Server('checkpoint-worst'), M1)) decoder.push(Uint8Array.of(b), m => found.push(m));
    decoder.end(); expect(found).toEqual([m1Server('checkpoint-worst')]);
  });
  it('declares the approved gearbox bounds and the unchanged hello version', () => {
    // ET-052: the highest implemented minor moved to 2 (asserted with the minor-2 corpus below); this was 1 in ET-050b.
    expect(PROTOCOL_V1).toEqual({major: 1, minor: 0});
    expect(V1_GEARBOX).toEqual({maxGears: 100, maxSelectorCount: 6, maxSlots: 64, maxHandlePosition: 255});
  });
  it('rejects each gearbox bound one step past its limit and accepts the limit itself', () => {
    const base = structuredClone(m1Server('snapshot-zero-selectors')) as Extract<ServerMessage, {kind: 'snapshot'}>;
    const encode = (edit: (box: GearboxState) => void) => { const m = structuredClone(base); edit(m.data.state.gearbox!); return () => encodeFrame(m, M1); };
    const slots = (box: GearboxState) => { if (!box.hshifter.available) throw new Error('fixture'); return box.hshifter.value; };
    expect(encode(box => { box.forwardGears = {available: true, value: 100}; box.reverseGears = {available: true, value: 0}; })).not.toThrow();
    expect(encode(box => { box.reverseGears = {available: true, value: 101}; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).slots[0] = {gear: -100, handlePosition: 255, selectors: 0}; })).not.toThrow();
    expect(encode(box => { slots(box).slots[0] = {gear: -101, handlePosition: 1, selectors: 0}; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).slots[0].handlePosition = -1; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).selectorCount = 6; slots(box).slots[0].selectors = 63; })).not.toThrow();
    expect(encode(box => { slots(box).selectorCount = 6; slots(box).slots[0].selectors = 64; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).selectorCount = 1; slots(box).slots[0].selectors = 2; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).selectorCount = -1; })).toThrow(ProtocolError);
    // A slot gear never repeats a neutral slot, and the gear values themselves may repeat in different slots.
    expect(encode(box => { slots(box).slots[1].gear = -1; })).not.toThrow();
    expect(encode(box => { slots(box).slots[1].gear = -0; })).toThrow(ProtocolError);
    expect(encode(box => { slots(box).slots = Array.from({length: 64}, (_, i) => ({gear: 1, handlePosition: i, selectors: 0})); })).not.toThrow();
    expect(encode(box => { slots(box).slots = Array.from({length: 65}, (_, i) => ({gear: 1, handlePosition: i, selectors: 0})); })).toThrow(ProtocolError);
  });
  it('requires the welcome envelope minor to equal the minor it announces, and a hello at version 1.0', () => {
    const welcome = structuredClone(m1Server('welcome')) as Extract<ServerMessage, {kind: 'welcome'}>;
    expect(welcome.version).toEqual({major: 1, minor: 1}); expect(welcome.data.minor).toBe(1);
    welcome.data.minor = 0; expect(() => encodeFrame(welcome, M1)).toThrow(ProtocolError);
    expect(() => decodePayload(bytes('welcome-minor-1'), 'server', M1)).toThrow(ProtocolError);
    expect(() => decodePayload(bytes('unsupported-minor'), 'server', M1)).toThrow(ProtocolError);
    expect(() => decodePayload(m1Bytes('hello-envelope-minor-1'), 'client', M1)).toThrow(/Unsupported protocol version/);
  });
  // ET-050b B7 (PR-5): the live observation always carries the gearbox, validated with the minor-1 rules. This replaces
  // the PR-1 expectation that the gearbox was not projected yet.
  it('requires the gearbox in the live observation and validates it with the minor-1 rules', () => {
    const m = m1Server('checkpoint'); if (m.kind !== 'checkpoint') throw new Error('fixture');
    const withGearbox: Partial<typeof m.data.state> = {...m.data.state}; delete withGearbox.window;
    const withoutGearbox = {...withGearbox}; delete withoutGearbox.gearbox;
    const live = (state: unknown) => ({source: m.source, seq: m.seq, capture: m.capture, state, sourceStatus: {gameMode: m.data.status.gameMode, eventLoss: m.data.status.eventLoss},
      receivedMonotonicMs: 0, hydration: true});
    expect(validateLiveObservationV1(live(withGearbox)).state).toEqual(withGearbox);
    expect(validateLiveObservationV1(live({...withoutGearbox, gearbox: NOT_SUPPORTED_GEARBOX})).state.gearbox).toEqual({
      forwardGears: {available: false, reason: 'not-supported'}, reverseGears: {available: false, reason: 'not-supported'}, hshifter: {available: false, reason: 'not-supported'}});
    expect(() => validateLiveObservationV1(live(withoutGearbox))).toThrow(ProtocolError);
    const duplicate = structuredClone(withGearbox) as typeof withGearbox & {gearbox: GearboxState};
    if (!duplicate.gearbox.hshifter.available) throw new Error('fixture');
    duplicate.gearbox.hshifter.value.slots.push({...duplicate.gearbox.hshifter.value.slots[0]});
    expect(() => validateLiveObservationV1(live(duplicate))).toThrow(ProtocolError);
  });
});

describe('ET-050b minor negotiation', () => {
  const hello = (maxMinor: number) => { const m = structuredClone(client('hello')); if (m.kind !== 'hello') throw new Error('fixture'); m.data.maxMinor = maxMinor; return m; };
  it('selects min(hello maxMinor, server maxMinor), keeping minor 0 by default', () => {
    // [hello maxMinor, server maxMinor, selected]
    for (const [offered, own, selected] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 1], [3, 0, 0], [3, 1, 1]]) {
      expect(negotiateV1(hello(offered), {allowDurable: true, maxMinor: own}), `${offered}/${own}`).toEqual({version: {major: 1, minor: selected}, minor: selected, durableEvents: true});
    }
    expect(negotiateV1(client('hello-wider-minor'))).toEqual({version: {major: 1, minor: 0}, minor: 0, durableEvents: true});
    expect(negotiateV1(client('hello-wider-minor'), {allowDurable: true, maxMinor: 1})).toEqual({version: {major: 1, minor: 1}, minor: 1, durableEvents: true});
    expect(negotiateV1(decodePayload(m1Bytes('hello'), 'client'), {allowDurable: false, maxMinor: 1})).toEqual({version: {major: 1, minor: 1}, minor: 1, durableEvents: false});
  });
});

// ET-052 PR-1: protocol v1 minor 2, the next mandatory break. The minor-2 corpus has its own directory, manifest and
// streams, so the frozen minor-0 and minor-1 corpora, and the C++ reader that scans them, are unchanged. The expected
// values below are written by hand from docs/protocol/v1.md §7 (the SDK `mandatory.break` is an s32 of game minutes).
const m2Dir = resolve(dir, 'minor2');
const M2 = {maxMinor: 2} as const;
const m2Bytes = (name: string) => new Uint8Array(readFileSync(resolve(m2Dir, `${name}.json`)));
const m2Server = (name: string) => decodePayload(m2Bytes(name), 'server', M2) as ServerMessage;
const m2Entries = rows(readFileSync(resolve(m2Dir, 'manifest.txt'), 'utf8'));
const m2Streams = rows(readFileSync(resolve(m2Dir, 'streams.txt'), 'utf8'));
const breakOf = (name: string) => {
  const m = m2Server(name); if (m.kind !== 'checkpoint' && m.kind !== 'snapshot') throw new Error('fixture');
  return m.data.state.nextMandatoryBreak;
};

describe('ET-052 protocol v1 minor-2 corpus', () => {
  it('reads its manifest and streams identically with Windows CRLF or LF', () => {
    for (const [name, parsed] of [['manifest.txt', m2Entries], ['streams.txt', m2Streams]] as const) {
      expect(rows(readFileSync(resolve(m2Dir, name), 'utf8').replace(/\r?\n/g, '\r\n'))).toEqual(parsed);
    }
  });
  it('lists every minor-2 fixture exactly once with a known expectation', () => {
    const files = readdirSync(m2Dir).filter(file => file.endsWith('.json')).sort();
    expect(m2Entries.map(([file]) => file).sort()).toEqual(files);
    expect(files).toHaveLength(51); expect(m2Streams).toHaveLength(12);
    for (const entry of m2Entries) { expect(entry).toHaveLength(2); expect(['valid', 'invalid', 'valid-client', 'invalid-client']).toContain(entry[1]); }
  });
  for (const [filename, result] of m2Entries) it(`${result} at maxMinor 2: ${filename}`, () => {
    const body = new Uint8Array(readFileSync(resolve(m2Dir, filename))), sender = senderOf(result);
    if (result.startsWith('invalid')) { expect(() => decodePayload(body, sender, M2)).toThrow(ProtocolError); return; }
    const parsed = decodePayload(body, sender, M2), encoded = encodeFrame(parsed, M2);
    expect(new DataView(encoded.buffer).getUint32(0, true)).toBe(encoded.length - 4);
    expect(decodePayload(encoded.subarray(4), sender, M2)).toEqual(parsed);
    expect(() => decodePayload(body, sender === 'server' ? 'client' : 'server', M2)).toThrow(ProtocolError);
    // A narrower reader refuses a message above its maximum and reads one at or below it exactly as a minor-2 reader does.
    const minor = parsed.version.minor;
    for (const max of [0, 1] as const) {
      const options = max === 0 ? {} : {maxMinor: max};
      if (minor > max) {
        expect(() => decodePayload(body, sender, options)).toThrow(/Unsupported protocol version/); expect(() => encodeFrame(parsed, options)).toThrow(/Unsupported protocol version/);
      } else expect(decodePayload(body, sender, options)).toEqual(parsed);
    }
  });
  it('gives every frozen minor-0 fixture the same result for a reader that accepts minor 2', () => {
    for (const [filename, result] of entries) {
      const body = new Uint8Array(readFileSync(resolve(dir, filename))), sender = senderOf(result);
      if (result.startsWith('invalid')) expect(() => decodePayload(body, sender, M2), filename).toThrow(ProtocolError);
      else expect(decodePayload(body, sender, M2), filename).toEqual(decodePayload(body, sender));
    }
  });
  it('gives every frozen minor-1 fixture the same result for a reader that accepts minor 2, except the two minor-2 envelopes', () => {
    // minor1/welcome-minor-2 and minor1/ack-minor-2 were the rejection cases for a minor-1 reader; they are minor 2's own
    // welcome and ack, byte for byte, and the only results that change.
    const turned = new Map([['welcome-minor-2.json', 'welcome'], ['ack-minor-2.json', 'ack-1']]);
    for (const [filename, result] of m1Entries) {
      const body = new Uint8Array(readFileSync(resolve(m1Dir, filename))), sender = senderOf(result);
      if (turned.has(filename)) {
        expect(() => decodePayload(body, sender, M1), filename).toThrow(ProtocolError);
        expect(Buffer.from(body).equals(Buffer.from(m2Bytes(turned.get(filename)!))), filename).toBe(true);
        expect(decodePayload(body, sender, M2), filename).toEqual(decodePayload(m2Bytes(turned.get(filename)!), sender, M2));
      } else if (result.startsWith('invalid')) expect(() => decodePayload(body, sender, M2), filename).toThrow(ProtocolError);
      else expect(decodePayload(body, sender, M2), filename).toEqual(decodePayload(body, sender, M1));
    }
  });
  it('carries the break as a plain signed integer: available values, zero, negative values and the s32 extremes', () => {
    expect(breakOf('checkpoint')).toEqual({available: true, value: 95, unit: 'min'});
    expect(breakOf('snapshot')).toEqual({available: true, value: 95, unit: 'min'});
    expect(breakOf('snapshot-break-zero')).toEqual({available: true, value: 0, unit: 'min'});
    expect(breakOf('snapshot-break-negative')).toEqual({available: true, value: -30, unit: 'min'});
    expect(breakOf('snapshot-break-int32-max')).toEqual({available: true, value: 2_147_483_647, unit: 'min'});
    expect(breakOf('snapshot-break-int32-min')).toEqual({available: true, value: -2_147_483_648, unit: 'min'});
    for (const name of ['snapshot-break-zero', 'snapshot-break-negative', 'snapshot-break-int32-max', 'snapshot-break-int32-min']) {
      const m = breakOf(name); expect(m?.available && typeof m.value).toBe('number');
    }
  });
  it('keeps zero distinct from every unavailable reading', () => {
    expect(breakOf('snapshot-break-not-observed')).toEqual({available: false, reason: 'not-observed', unit: 'min'});
    expect(breakOf('snapshot-break-not-supported')).toEqual({available: false, reason: 'not-supported', unit: 'min'});
    expect(breakOf('snapshot-break-invalid')).toEqual({available: false, reason: 'invalid', unit: 'min'});
    expect(breakOf('snapshot-break-zero')).not.toEqual(breakOf('snapshot-break-not-observed'));
  });
  it('still carries the minor-1 gearbox beside the break', () => {
    const m = m2Server('checkpoint'); if (m.kind !== 'checkpoint') throw new Error('fixture');
    expect(m.version).toEqual({major: 1, minor: 2}); expect(m.data.state.gearbox?.forwardGears).toEqual({available: true, value: 12});
    expect(Object.keys(m.data.state).slice(-3)).toEqual(['gearbox', 'nextMandatoryBreak', 'window']);
  });
  it('fits the worst-case minor-2 checkpoint within the server frame (D17) and decodes it byte at a time', () => {
    const worst = m2Bytes('checkpoint-worst');
    // The minor-1 worst case plus the widest break, `{"available":false,"reason":"not-supported","unit":"min"}` (57 bytes)
    // and its key `,"nextMandatoryBreak":` (22 bytes).
    expect(worst.length).toBe(55_473); expect(worst.length - m1Bytes('checkpoint-worst').length).toBe(79); expect(worst.length).toBeLessThanOrEqual(V1_LIMITS.serverFrameBytes);
    expect(breakOf('checkpoint-worst')).toEqual({available: false, reason: 'not-supported', unit: 'min'});
    expect(encodeFrame(m2Server('checkpoint-worst'), M2).length - 4).toBe(worst.length);
    const decoder = new FrameDecoder('server', M2), found: ProtocolMessage[] = [];
    for (const b of encodeFrame(m2Server('checkpoint-worst'), M2)) decoder.push(Uint8Array.of(b), m => found.push(m));
    decoder.end(); expect(found).toEqual([m2Server('checkpoint-worst')]);
  });
  it('declares minor 2 as the highest implemented minor and a not-supported break for older minors', () => {
    expect(V1_MAX_MINOR).toBe(2); expect(PROTOCOL_V1).toEqual({major: 1, minor: 0});
    expect(NOT_SUPPORTED_BREAK).toEqual({available: false, reason: 'not-supported', unit: 'min'}); expect(Object.isFrozen(NOT_SUPPORTED_BREAK)).toBe(true);
    // The constant has the wire shape, so a minor-2 state that carries it is valid.
    const snapshot = structuredClone(m2Server('snapshot')) as Extract<ServerMessage, {kind: 'snapshot'}>;
    snapshot.data.state.nextMandatoryBreak = {...NOT_SUPPORTED_BREAK}; expect(() => encodeFrame(snapshot, M2)).not.toThrow();
  });
  it('accepts the break at the s32 edges and rejects one step past them, any non-integer and any other shape', () => {
    const base = m2Server('snapshot') as Extract<ServerMessage, {kind: 'snapshot'}>;
    const encode = (value: unknown) => { const m = structuredClone(base); (m.data.state as {nextMandatoryBreak: unknown}).nextMandatoryBreak = value; return () => encodeFrame(m, M2); };
    const av = (value: unknown) => ({available: true, value, unit: 'min'});
    for (const ok of [0, -1, 1, 119, 120, 2_147_483_647, -2_147_483_648]) expect(encode(av(ok)), String(ok)).not.toThrow();
    for (const bad of [2_147_483_648, -2_147_483_649, 0.5, -0.5, 45.5, Number.NaN, Number.POSITIVE_INFINITY, '45', '0', null, true, undefined, 1e10]) expect(encode(av(bad)), String(bad)).toThrow(ProtocolError);
    expect(encode({available: true, value: 95, unit: 'm'})).toThrow(ProtocolError); expect(encode({available: true, value: 95})).toThrow(ProtocolError);
    expect(encode({available: true, value: 95, unit: 'min', extra: 1})).toThrow(ProtocolError); expect(encode({available: false, unit: 'min'})).toThrow(ProtocolError);
    expect(encode({available: false, reason: 'unknown', unit: 'min'})).toThrow(ProtocolError); expect(encode(undefined)).toThrow(ProtocolError);
    // Not the canonical u64 decimal string of GameMinutes: the SDK value is signed.
    expect(encode({available: true, value: '95', unit: 'min'})).toThrow(ProtocolError);
  });
  it('requires the break exactly in a minor-2 state, on top of the gearbox', () => {
    const snapshot = (name: string) => structuredClone(m2Server(name)) as Extract<ServerMessage, {kind: 'snapshot'}>;
    const withBreak = snapshot('snapshot');
    const lacking = snapshot('snapshot'); delete lacking.data.state.nextMandatoryBreak; expect(() => encodeFrame(lacking, M2)).toThrow(ProtocolError);
    const noGearbox = snapshot('snapshot'); delete noGearbox.data.state.gearbox; expect(() => encodeFrame(noGearbox, M2)).toThrow(ProtocolError);
    const minor1 = structuredClone(withBreak); minor1.version = {major: 1, minor: 1}; expect(() => encodeFrame(minor1, M2)).toThrow(ProtocolError);
    const minor0 = structuredClone(withBreak); minor0.version = {major: 1, minor: 0}; delete minor0.data.state.gearbox; expect(() => encodeFrame(minor0, M2)).toThrow(ProtocolError);
  });
  it('requires the welcome envelope minor to equal the minor it announces at minor 2 as well', () => {
    const welcome = structuredClone(m2Server('welcome')) as Extract<ServerMessage, {kind: 'welcome'}>;
    expect(welcome.version).toEqual({major: 1, minor: 2}); expect(welcome.data.minor).toBe(2);
    welcome.data.minor = 1; expect(() => encodeFrame(welcome, M2)).toThrow(ProtocolError);
    expect(() => decodePayload(m2Bytes('welcome-minor-3'), 'server', M2)).toThrow(/Unsupported protocol version/);
    expect(() => decodePayload(m2Bytes('hello-envelope-minor-2'), 'client', M2)).toThrow(/Unsupported protocol version/);
  });
  it('rejects a caller maximum minor above 2 and accepts 0, 1 and 2', () => {
    for (const maxMinor of [3, -1, 0.5]) {
      expect(() => decodePayload(bytes('welcome'), 'server', {maxMinor})).toThrow(ProtocolError);
      expect(() => new FrameDecoder('server', {maxMinor})).toThrow(ProtocolError);
      expect(() => negotiateV1(client('hello'), {allowDurable: true, maxMinor})).toThrow(ProtocolError);
    }
    for (const maxMinor of [0, 1, 2]) expect(() => new FrameDecoder('client', {maxMinor})).not.toThrow();
  });
  // ET-052 MB5 (PR-4 changes this): nothing projects the break yet, so the live observation still has the minor-1 shape and
  // a state that carries the key is not a live observation.
  it('keeps the live observation at the minor-1 shape until the service projects the break', () => {
    const m = m2Server('checkpoint'); if (m.kind !== 'checkpoint') throw new Error('fixture');
    const state: Partial<typeof m.data.state> = {...m.data.state}; delete state.window;
    const live = (s: unknown) => ({source: m.source, seq: m.seq, capture: m.capture, state: s, sourceStatus: {gameMode: m.data.status.gameMode, eventLoss: m.data.status.eventLoss}, receivedMonotonicMs: 0, hydration: true});
    expect(() => validateLiveObservationV1(live(state))).toThrow(ProtocolError);
    delete state.nextMandatoryBreak; expect(validateLiveObservationV1(live(state)).state).toEqual(state);
  });
});

describe('ET-052 minor negotiation', () => {
  const hello = (maxMinor: number) => { const m = structuredClone(client('hello')); if (m.kind !== 'hello') throw new Error('fixture'); m.data.maxMinor = maxMinor; return m; };
  it('selects min(hello maxMinor, server maxMinor) for every offer against every server maximum', () => {
    // [hello maxMinor, server maxMinor, selected]. Minor 1 offered to a minor-2 server must select 1, never 0.
    const table = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0], [1, 1, 1], [1, 2, 1], [2, 0, 0], [2, 1, 1], [2, 2, 2], [3, 0, 0], [3, 1, 1], [3, 2, 2]];
    for (const [offered, own, selected] of table) {
      expect(negotiateV1(hello(offered), {allowDurable: true, maxMinor: own}), `${offered}/${own}`).toEqual({version: {major: 1, minor: selected}, minor: selected, durableEvents: true});
    }
    expect(negotiateV1(hello(65_535), {allowDurable: true, maxMinor: 2}).minor).toBe(2);
  });
  it('keeps minor 0 by default and reads the minor-2 corpus hellos', () => {
    expect(negotiateV1(client('hello-wider-minor')).minor).toBe(0);
    expect(negotiateV1(client('hello-wider-minor'), {allowDurable: true, maxMinor: 2}).minor).toBe(2);
    expect(negotiateV1(decodePayload(m2Bytes('hello'), 'client'), {allowDurable: true, maxMinor: 2}).minor).toBe(2);
    expect(negotiateV1(decodePayload(m2Bytes('hello'), 'client'), {allowDurable: false, maxMinor: 1}).minor).toBe(1);
    expect(negotiateV1(decodePayload(m2Bytes('hello-offer-1'), 'client'), {allowDurable: true, maxMinor: 2})).toEqual({version: {major: 1, minor: 1}, minor: 1, durableEvents: true});
  });
});
