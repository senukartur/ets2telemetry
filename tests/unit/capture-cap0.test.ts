import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {Cap0Error, Cap0FrameDecoder, Cap0StreamValidator, decodeCap0Payload, encodeCap0Hello, CAP0_MAX_HELLO_BYTES, type Cap0Packet} from '../../packages/contracts/src/capture-cap0';
import {decodePayload, FrameDecoder, V0Consumer, validateMessage} from '../../packages/contracts/src/protocol-v0';
import {AUTHORITY, SESSION, delivered, end, envelope, frame, header, loss, observation, payload} from '../shared/cap0-fixtures';

const mutate = (packet: Cap0Packet, change: (value: Record<string, unknown>) => void) => { const copy = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>; change(copy); return copy; };
const data = (value: Record<string, unknown>) => value.data as Record<string, unknown>;
const bytes = (text: string) => new TextEncoder().encode(text);

describe('CAP0 decoder validation', () => {
  it('accepts every packet kind and keeps 64-bit integers as exact decimal strings', () => {
    for (const packet of [header(), envelope(1, 1, {observations: delivered()}), loss(2, 3, 1), end(3, 3, 1)]) expect(decodeCap0Payload(payload(packet))).toEqual(packet);
    const decoded = decodeCap0Payload(payload(envelope(1, 1, {observations: delivered()})));
    if (decoded.kind !== 'envelope') throw new Error('kind');
    expect(decoded.data.observations[0].value).toEqual({available: true, value: '-9223372036854775808'});
    expect(decoded.data.observations[1].value).toEqual({available: true, value: '18446744073709551615'});
    expect(decoded.data.gameTime.minutes).toEqual({available: true, value: '4294967295'});
  });
  it('rejects wrong format/version, unknown or duplicate keys, malformed JSON and invalid UTF-8', () => {
    const valid = header();
    const invalid: unknown[] = [
      mutate(valid, v => { v.version = {major: 1, minor: 0}; }), mutate(valid, v => { v.version = {major: 0, minor: 1}; }), mutate(valid, v => { v.format = 'ets2telemetry-cap1'; }),
      mutate(valid, v => { v.extra = true; }), mutate(valid, v => { delete v.publishMonotonicNs; }), mutate(valid, v => { v.packetSeq = 0; }), mutate(valid, v => { v.captureSessionId = SESSION.toUpperCase(); }),
      mutate(valid, v => { (data(v).bounds as Record<string, number>).queueBytes = 4_194_304; }), mutate(valid, v => { data(v).origin = 'replay'; })
    ];
    for (const value of invalid) expect(() => decodeCap0Payload(payload(value)), JSON.stringify(value).slice(0, 80)).toThrow(Cap0Error);
    const text = JSON.stringify(valid);
    expect(() => decodeCap0Payload(bytes(text.replace('"kind":"header"', '"kind":"header","kind":"header"')))).toThrow(Cap0Error);
    expect(() => decodeCap0Payload(bytes(text.slice(0, -1)))).toThrow(Cap0Error);
    expect(() => decodeCap0Payload(Uint8Array.from([0x7b, 0xff, 0x7d]))).toThrow(Cap0Error);
  });
  it('rejects oversized and empty payloads at the 64 KiB bound', () => {
    const exact = new Uint8Array(65_536).fill(0x20); exact.set(payload(header()));
    expect(decodeCap0Payload(exact).kind).toBe('header');
    const oversized = new Uint8Array(65_537).fill(0x20); oversized.set(payload(header()));
    expect(() => decodeCap0Payload(oversized)).toThrow(/size/);
    expect(() => decodeCap0Payload(new Uint8Array())).toThrow(/size/);
    const decoder = new Cap0FrameDecoder(), prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, 65_537, true);
    expect(() => decoder.push(prefix, () => {})).toThrow(/size/); expect(() => decoder.push(frame(header()), () => {})).toThrow(/closed/);
  });
  it('rejects precision-losing and mistyped observation values', () => {
    const bad = [
      observation(0, 'income', 'u64', Number('18446744073709551615')), observation(0, 'income', 'u64', '018'), observation(0, 'revenue', 's64', '9223372036854775808'),
      observation(0, 'revenue', 's64', '-0'), observation(0, 'xp', 's32', 2 ** 31), observation(0, 'damage', 'float', 1e39), observation(0, 'flag', 'bool', 1),
      observation(0, 'text', 'string', 'x'.repeat(1025)), observation(0, 'flag', 'bool', true, 2), observation(0, 'odd', 'unknown', 1, 99)
    ];
    for (const item of bad) expect(() => decodeCap0Payload(payload(envelope(1, 1, {observations: [item]})))).toThrow(Cap0Error);
    expect(decodeCap0Payload(payload(envelope(1, 1, {observations: [observation(0, 'text', 'string', '\u0001'.repeat(1024))]}))).kind).toBe('envelope');
    const unknown = {...observation(0, 'odd', 'unknown', 0, 99), value: {available: false, reason: 'not-supported', detail: 'unsupported-type'}};
    expect(decodeCap0Payload(payload(envelope(1, 1, {observations: [unknown as never]}))).kind).toBe('envelope');
  });
  it('decodes negative zero exactly as sent', () => {
    const text = JSON.stringify(envelope(1, 1, {observations: [observation(0, 'damage', 'float', 0)]})).replace('"value":0}', '"value":-0}');
    const decoded = decodeCap0Payload(bytes(text));
    if (decoded.kind !== 'envelope' || !decoded.data.observations[0].value.available) throw new Error('kind');
    expect(Object.is(decoded.data.observations[0].value.value, -0)).toBe(true);
  });
  it('rejects inconsistent attribute ranges, positions and unavailable forms', () => {
    const base = envelope(1, 1, {observations: delivered()});
    const invalid = [
      mutate(base, v => { (data(v).attributes as Record<string, number>).count = 3; }), mutate(base, v => { (data(v).attributes as Record<string, unknown>).final = false; }),
      mutate(base, v => { ((data(v).observations as Record<string, unknown>[])[1]).position = 5; }), mutate(base, v => { (data(v).attributes as Record<string, unknown>).terminated = false; }),
      mutate(base, v => { data(v).callbackMonotonicNs = {available: false, reason: 'invalid'}; }), mutate(base, v => { data(v).envelopeSeq = '0'; }),
      mutate(envelope(1, 1, {group: 'lifecycle', id: 'simulation.paused'}), v => { (data(v).attributes as Record<string, unknown>).expected = true; })
    ];
    for (const value of invalid) expect(() => decodeCap0Payload(payload(value))).toThrow(Cap0Error);
    expect(decodeCap0Payload(payload(envelope(1, 1, {observations: delivered().slice(2), first: 2, total: 4}))).kind).toBe('envelope');
  });
  it('decodes arbitrary byte splits and multiple frames in one chunk', () => {
    const stream = [header(), envelope(1, 1, {observations: delivered()}), end(2, 1)].map(frame);
    const joined = new Uint8Array(stream.reduce((n, f) => n + f.length, 0)); let offset = 0; for (const f of stream) { joined.set(f, offset); offset += f.length; }
    const oneByOne: Cap0Packet[] = [], decoder = new Cap0FrameDecoder();
    for (const byte of joined) decoder.push(Uint8Array.of(byte), p => oneByOne.push(decodeCap0Payload(p)));
    const combined: Cap0Packet[] = []; new Cap0FrameDecoder().push(joined, p => combined.push(decodeCap0Payload(p)));
    expect(oneByOne.map(p => p.kind)).toEqual(['header', 'envelope', 'end']); expect(combined).toEqual(oneByOne); expect(decoder.idle).toBe(true);
  });
  it('encodes a bounded evidence-only hello', () => {
    const hello = encodeCap0Hello(SESSION), length = new DataView(hello.buffer).getUint32(0, true);
    expect(length + 4).toBe(hello.length); expect(length).toBeLessThanOrEqual(CAP0_MAX_HELLO_BYTES);
    expect(JSON.parse(new TextDecoder().decode(hello.subarray(4)))).toEqual({format: 'ets2telemetry-cap0', version: {major: 0, minor: 0}, kind: 'hello', captureSessionId: SESSION, data: {evidenceOnly: true}});
    expect(() => encodeCap0Hello('not-a-uuid')).toThrow(Cap0Error);
  });
});

describe('CAP0 stream ordering', () => {
  const accept = (packets: Cap0Packet[], validator = new Cap0StreamValidator(SESSION, AUTHORITY)) => { for (const p of packets) validator.accept(p); return validator; };
  it('accepts ordered split envelopes, explicit drop gaps, loss and end', () => {
    const v = accept([header(), envelope(1, 1, {observations: delivered().slice(0, 2), total: 4, final: false}), envelope(2, 1, {observations: delivered().slice(2), first: 2, total: 4}),
      loss(3, 4, 2), envelope(4, 4, {droppedBefore: 2}), end(5, 4, 2)]);
    expect(v.ended).toBe(true); expect(v.lastEnvelopeSeq).toBe('4'); expect(v.lastPacketSeq).toBe('5'); expect(v.loss?.droppedEnvelopes).toBe('2');
  });
  it('rejects ordering, identity and completeness violations without repairing them', () => {
    const cases: Cap0Packet[][] = [
      [envelope(0, 1)], [header(), header(1)], [header(), envelope(2, 1)], [header(), envelope(1, 2)], [header(), envelope(1, 2, {droppedBefore: 2})],
      [header(), envelope(1, 1), envelope(2, 1)], [header(), envelope(1, 1, {boundary: 5}), envelope(2, 2, {boundary: 5})],
      [header(), envelope(1, 1, {observations: delivered().slice(0, 2), total: 4, final: false}), envelope(2, 2)],
      [header(), envelope(1, 1, {observations: delivered().slice(0, 2), total: 4, final: false}), end(2, 1)],
      [header(), loss(1, 5, 2), loss(2, 5, 1)], [header(), end(1, 0), envelope(2, 1)]
    ];
    for (const packets of cases) expect(() => accept(packets), packets.map(p => p.kind).join(',')).toThrow(Cap0Error);
    expect(() => accept([header()], new Cap0StreamValidator(SESSION, {...AUTHORITY, processId: 1}))).toThrow(/authority/);
    expect(() => accept([{...header(), captureSessionId: '0cab0000-0000-4000-8000-0000000000a2'}])).toThrow(/session/);
    const regressed = {...envelope(1, 1), publishMonotonicNs: '1'} as Cap0Packet; expect(() => accept([header(), regressed])).toThrow(/clock/);
  });
});

describe('frozen v0 isolation', () => {
  it('never lets the v0 parser accept CAP0 packets or hello, even with diagnostics requested', () => {
    for (const value of [header(), envelope(1, 1, {observations: delivered()}), loss(2, 1, 0), end(3, 1)]) {
      expect(() => decodePayload(payload(value))).toThrow(); expect(() => validateMessage(value)).toThrow();
      expect(() => new FrameDecoder().push(frame(value), () => {})).toThrow(); expect(() => new V0Consumer(true).accept(value)).toThrow();
    }
    expect(() => decodePayload(encodeCap0Hello(SESSION).subarray(4))).toThrow();
  });
  it('never lets the CAP0 decoder accept v0 messages', () => {
    for (const name of ['hello.json', 'welcome.json', 'checkpoint.json', 'snapshot.json', 'diagnostic.json']) {
      const bytesV0 = readFileSync(new URL(`../fixtures/protocol-v0/${name}`, import.meta.url)); expect(() => decodeCap0Payload(bytesV0)).toThrow(Cap0Error);
    }
  });
});
