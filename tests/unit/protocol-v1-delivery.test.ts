import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {decodePayload, negotiateV1, ProtocolError, validateClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {AckValidator, computeClockMapping, DurableAckCursor, isClockMappingCurrent, V1Consumer, type V1Applied} from '../../packages/contracts/src/protocol-v1-delivery';

const dir = resolve('tests/fixtures/protocol-v1'), m1Dir = resolve(dir, 'minor1'), m2Dir = resolve(dir, 'minor2');
const bytes = (name: string, from = dir) => new Uint8Array(readFileSync(resolve(from, `${name}.json`)));
const server = (name: string) => decodePayload(bytes(name), 'server') as ServerMessage;
/** A minor-1 corpus message, decoded by a reader that accepts minor 1. */
const m1 = (name: string) => decodePayload(bytes(name, m1Dir), 'server', {maxMinor: 1}) as ServerMessage;
/** A minor-2 corpus message, decoded by a reader that accepts minor 2. */
const m2 = (name: string) => decodePayload(bytes(name, m2Dir), 'server', {maxMinor: 2}) as ServerMessage;
const rows = (input: string) => input.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const streams = rows(readFileSync(resolve(dir, 'streams.txt'), 'utf8'));
const m1Streams = rows(readFileSync(resolve(m1Dir, 'streams.txt'), 'utf8'));
const m2Streams = rows(readFileSync(resolve(m2Dir, 'streams.txt'), 'utf8'));
/** The minor-0 corpus with the default (minor 0) client and server, or the minor-1 or minor-2 corpus with both offering that minor. */
interface Corpus {dir: string; maxMinor: 0 | 1 | 2}
const MINOR_0: Corpus = {dir, maxMinor: 0}, MINOR_1: Corpus = {dir: m1Dir, maxMinor: 1}, MINOR_2: Corpus = {dir: m2Dir, maxMinor: 2};
const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const CLIENT_CLOCK = '60000000-0000-4000-8000-000000000001';

/**
 * Drives one shared stream. `S:` frames go through the consumer, and the harness mirrors them into the producer-side
 * ACK validator (created at welcome, as the producer does). `C:` frames go through negotiation, the ACK validator, or
 * the validator's probe check and then the consumer's probe registry. `A:<uint64>` requires the cursor to produce exactly that ACK and sends it to the validator;
 * `A:-` requires that the cursor produces none. `R` starts a new connection. Coverage is committed immediately to stand
 * in for a storage transaction; the actual UNIQUE insert belongs to ET-013/ET-015a. Every rejection comes from contract
 * code; harness misuse and an unexpected cursor ACK throw a plain Error, never a ProtocolError, which fails the stream test.
 * The corpus sets the consumer's offered minor and the server's own maximum; the cursor and the ACK validator follow the
 * minor the welcome selected.
 */
function runStream(durable: boolean, steps: string[], corpus: Corpus = MINOR_0): {cursor?: DurableAckCursor; applied: V1Applied[]; failedAt?: number; error?: unknown} {
  const options = {maxMinor: corpus.maxMinor};
  let consumer = new V1Consumer(durable, options), validator: AckValidator | undefined, cursor: DurableAckCursor | undefined;
  const applied: V1Applied[] = [];
  const producer = () => { if (!validator) throw new Error('Harness: client ACK before any welcome'); return validator; };
  for (const [index, step] of steps.entries()) {
    try {
      if (step === 'R') { consumer = new V1Consumer(durable, options); validator = undefined; continue; }
      if (step.startsWith('A:')) {
        const expected = step.slice('A:'.length);
        if (expected !== '-' && !/^(0|[1-9][0-9]*)$/.test(expected)) throw new Error(`Harness: malformed step ${step}`);
        const ack = cursor?.ack(), produced = ack?.data.throughEventSeq ?? '-';
        if (produced !== expected) throw new Error(`Harness: cursor produced ACK ${produced}, expected ${expected}`);
        if (ack) producer().accept(ack);
        continue;
      }
      const [side, name] = step.split(':');
      if (side === 'S') {
        const result = consumer.accept(decodePayload(bytes(name, corpus.dir), 'server', options)), m = result.message; applied.push(result);
        if (m.kind === 'welcome') {
          if (cursor?.pluginSessionId !== m.source.pluginSessionId) cursor = new DurableAckCursor(m.source.pluginSessionId);
          validator = new AckValidator(m.source.pluginSessionId, m.data.durableEvents, m.data.minor);
        }
        if (m.kind === 'checkpoint') {
          cursor!.beginConnection(m.data.status.delivery.ackedThroughEventSeq, consumer.minor);
          producer().checkpoint(m.data.status.delivery.ackedThroughEventSeq);
        }
        if (result.coverage) {
          producer().sent(result.coverage.lastEventSeq);
          cursor!.received(result.coverage.firstEventSeq, result.coverage.lastEventSeq);
          cursor!.commit(result.coverage.firstEventSeq, result.coverage.lastEventSeq);
        }
      } else if (side === 'C') {
        const m = validateClientMessage(decodePayload(bytes(name, corpus.dir), 'client', options), options);
        if (m.kind === 'hello') { if (negotiateV1(m, {allowDurable: true, maxMinor: corpus.maxMinor}).durableEvents !== durable) throw new Error('Harness: stream hello mismatch'); }
        else if (m.kind === 'ack') producer().accept(m);
        // A probe passes the producer-side check at the connection minor, then registers with the consumer.
        else consumer.expectClockReply(producer().probe(m));
      } else throw new Error(`Unknown step ${step}`);
    } catch (error) { return {cursor, applied, failedAt: index, error}; }
  }
  return {cursor, applied};
}

describe('REG-003/005/010 shared v1 delivery streams', () => {
  for (const [name, durable, steps, outcome, expected] of streams) it(`shared stream ${name}`, () => {
    const result = runStream(durable === '1', steps.split(','));
    if (outcome.startsWith('reject@')) {
      expect(result.error).toBeInstanceOf(ProtocolError);
      expect(result.failedAt).toBe(Number(outcome.slice('reject@'.length)));
    } else {
      expect(outcome).toBe('accept'); expect(result.error).toBeUndefined();
      expect(result.cursor?.throughEventSeq ?? '0').toBe(expected);
    }
  });
  it('fails every stream with a numeric A: step through the harness when the cursor never acknowledges', () => {
    const numeric = streams.filter(([, , steps]) => steps.split(',').some(step => /^A:[0-9]+$/.test(step)));
    expect(numeric.map(([name]) => name)).toEqual(['normal-cursor-ack', 'lost-ack-reconnect', 'retention-expired-ack', 'queue-count-overflow', 'queue-bytes-overflow', 'ack-inside-gap-record']);
    const never = vi.spyOn(DurableAckCursor.prototype, 'ack').mockReturnValue(undefined);
    try {
      for (const [name, durable, steps] of numeric) {
        const result = runStream(durable === '1', steps.split(','));
        expect(result.error, name).toBeInstanceOf(Error); expect(result.error, name).not.toBeInstanceOf(ProtocolError);
        expect(String(result.error), name).toMatch(/^Error: Harness: cursor produced ACK -, expected [0-9]+$/);
      }
    } finally { never.mockRestore(); }
  });
  it('rejects a bare or malformed A step and an unexpected cursor ACK as harness errors', () => {
    for (const step of ['A', 'A:', 'A:01', 'A:x']) {
      const result = runStream(true, ['S:welcome', 'S:checkpoint', step]);
      expect(result.failedAt).toBe(2); expect(result.error).toBeInstanceOf(Error); expect(result.error).not.toBeInstanceOf(ProtocolError);
    }
    const unexpected = runStream(true, 'S:welcome,S:checkpoint,S:event-job-configured,A:-'.split(','));
    expect(unexpected.failedAt).toBe(3); expect(String(unexpected.error)).toMatch(/produced ACK 1, expected -/);
  });
  it('keeps a retained gap record whole when an ACK falls inside it and redelivers it on reconnection', () => {
    const result = runStream(true, streams.find(([name]) => name === 'ack-inside-gap-record')![2].split(','));
    expect(result.error).toBeUndefined();
    const checkpoint = result.applied.find(a => a.message.kind === 'checkpoint' && a.message.seq === '21')!.message;
    if (checkpoint.kind !== 'checkpoint') throw new Error('fixture');
    // The producer accepted ACK 3 inside the record [2, 4]; its release point is the record's first eventSeq minus one.
    expect(checkpoint.data.status.delivery).toMatchObject({ackedThroughEventSeq: '1', nextEventSeq: '5', retainedEvents: 1, retainedBytes: 1_024});
    expect(result.applied.at(-1)?.coverage).toEqual({firstEventSeq: '2', lastEventSeq: '4'});
    expect(result.cursor?.throughEventSeq).toBe('4');
  });
  it('reports coverage in stream order, sequence skips and a hydration-only checkpoint', () => {
    const result = runStream(true, 'S:welcome,S:checkpoint,S:event-job-configured,S:snapshot,S:event-truck-configured-e2,S:gap,S:event-simulation-paused-e5'.split(','));
    expect(result.error).toBeUndefined();
    expect(result.applied.map(a => a.coverage ? `${a.coverage.firstEventSeq}-${a.coverage.lastEventSeq}` : '-')).toEqual(['-', '-', '1-1', '-', '2-2', '3-4', '5-5']);
    expect(result.applied.map(a => a.skippedSequences)).toEqual(['0', '0', '0', '1', '0', '0', '0']);
    expect(result.applied.map(a => a.hydration)).toEqual([false, true, false, false, false, false, false]);
  });
  it('hydrates current job configuration from a late checkpoint without producing an event', () => {
    const consumer = new V1Consumer(true); consumer.accept(server('welcome'));
    const applied = consumer.accept(server('checkpoint-late'));
    expect(applied.hydration).toBe(true); expect(applied.coverage).toBeUndefined();
    if (applied.message.kind !== 'checkpoint') throw new Error('fixture');
    expect(applied.message.data.state.configuration.job.available).toBe(true);
    expect(applied.message.data.status.eventLoss.offline).toBe('3');
    expect(consumer.nextEventSeq).toBe('1');
    const gap = consumer.accept(server('gap-offline'));
    expect(gap.coverage).toEqual({firstEventSeq: '1', lastEventSeq: '3'});
  });
  it('dedupes cross-connection redelivery in the ACK cursor', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0');
    cursor.received('1', '2'); expect(cursor.commit('1')).toBe('committed'); expect(cursor.commit('2')).toBe('committed');
    cursor.beginConnection('1'); cursor.received('2', '3');
    expect(cursor.commit('2')).toBe('duplicate'); expect(cursor.commit('3')).toBe('committed'); expect(cursor.throughEventSeq).toBe('3');
  });
  it('closes the consumer after a violation and after end', () => {
    const consumer = new V1Consumer(true); consumer.accept(server('welcome'));
    expect(() => consumer.accept(server('event-job-configured'))).toThrow(ProtocolError);
    expect(() => consumer.accept(server('checkpoint'))).toThrow(ProtocolError);
    const ended = new V1Consumer(true); ended.accept(server('welcome')); ended.accept(server('checkpoint')); ended.accept(server('end-early'));
    expect(() => ended.accept(server('snapshot-after-end'))).toThrow(ProtocolError);
    // An end marker that claims acknowledgements beyond the delivered coverage is inconsistent.
    const claims = new V1Consumer(true); claims.accept(server('welcome')); claims.accept(server('checkpoint'));
    expect(() => claims.accept(server('end-sequence-exhausted'))).toThrow(/End marker/);
  });
  it('allows only one outstanding probe with increasing IDs', () => {
    const consumer = new V1Consumer(true); consumer.accept(server('welcome')); consumer.accept(server('checkpoint'));
    consumer.expectClockReply('1'); expect(() => consumer.expectClockReply('2')).toThrow(ProtocolError);
    const replay = new V1Consumer(true); replay.accept(server('welcome')); replay.accept(server('checkpoint'));
    replay.expectClockReply('1'); replay.accept(server('clock-reply')); expect(() => replay.expectClockReply('1')).toThrow(ProtocolError);
  });
  it('keeps a probe outstanding past the deadline, accepts its late reply and discards the measurement', () => {
    const consumer = new V1Consumer(true); consumer.accept(server('welcome')); consumer.accept(server('checkpoint'));
    consumer.expectClockReply('1'); expect(consumer.clockProbeOutstanding).toBe(true);
    // More than 1 s has passed at the client, but the probe is still outstanding: no new probe may be registered.
    expect(() => consumer.expectClockReply('2')).toThrow(ProtocolError);
    const late = new V1Consumer(true); late.accept(server('welcome')); late.accept(server('checkpoint')); late.expectClockReply('1');
    expect(late.accept(server('clock-reply')).message.kind).toBe('clock.reply'); expect(late.clockProbeOutstanding).toBe(false);
    expect(computeClockMapping({reply: server('clock-reply'), probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '5000000000', replyReceivedNs: '6000000001'})).toBeUndefined();
    late.expectClockReply('2'); expect(late.clockProbeOutstanding).toBe(true);
  });
});

describe('REG-006 contract part: DurableAckCursor', () => {
  it('advances only to the highest contiguous committed eventSeq', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0'); cursor.received('1', '4');
    cursor.commit('1'); cursor.commit('2'); cursor.commit('4');
    expect(cursor.throughEventSeq).toBe('2'); expect(cursor.isCommitted('4')).toBe(true); expect(cursor.isCommitted('3')).toBe(false);
    cursor.commit('3'); expect(cursor.throughEventSeq).toBe('4');
  });
  it('treats out-of-order commits and committed gap markers alike', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0'); cursor.received('1', '1'); cursor.received('2', '5'); cursor.received('6', '6');
    expect(cursor.commit('6')).toBe('committed'); expect(cursor.commit('2', '5')).toBe('committed'); expect(cursor.throughEventSeq).toBe('0');
    expect(cursor.commit('1')).toBe('committed'); expect(cursor.throughEventSeq).toBe('6');
    expect(cursor.commit('3', '4')).toBe('duplicate');
  });
  it('never advances on receipt alone and never commits above the received range', () => {
    const cursor = new DurableAckCursor(P1);
    expect(() => cursor.received('1', '1')).toThrow(/No connection/);
    cursor.beginConnection('0'); cursor.received('1', '3');
    expect(cursor.throughEventSeq).toBe('0'); expect(cursor.ack()).toBeUndefined();
    expect(() => cursor.commit('4')).toThrow(ProtocolError); expect(() => cursor.commit('3', '4')).toThrow(ProtocolError);
    expect(() => cursor.received('5', '5')).toThrow(ProtocolError); expect(() => cursor.commit('2', '1')).toThrow(ProtocolError);
  });
  it('acknowledges stored commits on a new connection only after their range is received again', () => {
    const cursor = new DurableAckCursor(P1, '7'); expect(cursor.throughEventSeq).toBe('7');
    expect(cursor.ack()).toBeUndefined();
    cursor.beginConnection('5'); expect(cursor.ack()).toBeUndefined();
    cursor.received('6', '7'); expect(cursor.commit('6', '7')).toBe('duplicate');
    expect(validateClientMessage(cursor.ack())).toEqual({version: {major: 1, minor: 0}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: '7'}});
    expect(cursor.ack()).toBeUndefined();
    cursor.received('8', '8'); cursor.commit('8'); expect(cursor.ack()?.data).toEqual({pluginSessionId: P1, throughEventSeq: '8'});
    expect(() => cursor.beginConnection('9')).toThrow(ProtocolError);
    expect(() => new DurableAckCursor('not-a-uuid')).toThrow(ProtocolError);
  });
  it('produces ACKs the producer accepts after a lost ACK and a reconnect at A=1', () => {
    const cursor = new DurableAckCursor(P1), first = new AckValidator(P1, true);
    first.checkpoint('0'); cursor.beginConnection('0');
    first.sent('1'); cursor.received('1', '1'); cursor.commit('1'); expect(first.accept(cursor.ack())).toBe('1');
    // The ACK for 2 is produced but lost with the connection, so the producer still holds A=1.
    first.sent('2'); cursor.received('2', '2'); cursor.commit('2'); expect(cursor.ack()?.data.throughEventSeq).toBe('2');
    const second = new AckValidator(P1, true); second.checkpoint('1'); cursor.beginConnection('1');
    expect(cursor.ack()).toBeUndefined();
    second.sent('2'); cursor.received('2', '2'); expect(cursor.commit('2')).toBe('duplicate');
    expect(second.accept(cursor.ack())).toBe('2');
  });
  it('produces ACKs the producer accepts after retention expired at A=0', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0');
    for (const seq of ['1', '2']) { cursor.received(seq, seq); cursor.commit(seq); }
    const next = new AckValidator(P1, true); next.checkpoint('0'); cursor.beginConnection('0');
    expect(cursor.ack()).toBeUndefined();
    next.sent('2'); cursor.received('1', '2'); expect(cursor.commit('1', '2')).toBe('duplicate');
    expect(next.accept(cursor.ack())).toBe('2');
  });
});

describe('AckValidator', () => {
  const ack = (through: string, pluginSessionId = P1) => ({version: {major: 1, minor: 0}, kind: 'ack', data: {pluginSessionId, throughEventSeq: through}});
  const durable = (acked: string) => { const v = new AckValidator(P1, true); v.checkpoint(acked); return v; };
  it('releases on advance, treats an equal ACK as a no-op and closes on violations', () => {
    const v = durable('2'); v.sent('5');
    expect(v.accept(ack('2'))).toBeUndefined(); expect(v.accept(ack('4'))).toBe('4'); expect(v.accept(ack('4'))).toBeUndefined();
    expect(v.ackedThroughEventSeq).toBe('4');
    expect(() => v.accept(ack('3'))).toThrow(/regressed/); expect(() => v.accept(ack('5'))).toThrow(/closed/);
  });
  it('rejects an ACK beyond the sent range, a foreign session and a non-ACK message', () => {
    const beyond = durable('0'); beyond.sent('3'); expect(() => beyond.accept(ack('4'))).toThrow(/beyond/);
    const foreign = durable('0'); foreign.sent('3'); expect(() => foreign.accept(ack('1', P2))).toThrow(/foreign/);
    const other = durable('0'); expect(() => other.accept({version: {major: 1, minor: 0}, kind: 'clock.probe', data: {probeId: '1'}})).toThrow(ProtocolError);
    const numeric = durable('0'); numeric.sent('1'); expect(() => numeric.accept({...ack('1'), data: {pluginSessionId: P1, throughEventSeq: 1}})).toThrow(ProtocolError);
  });
  it('rejects every ACK from a live-only client and any ACK before the checkpoint', () => {
    const live = new AckValidator(P1, false); live.checkpoint('0');
    expect(() => live.accept(ack('0'))).toThrow(/live-only/);
    const liveCoverage = new AckValidator(P1, false); liveCoverage.checkpoint('0'); expect(() => liveCoverage.sent('1')).toThrow(ProtocolError);
    const early = new AckValidator(P1, true); expect(() => early.accept(ack('0'))).toThrow(/before checkpoint/);
    const twice = durable('0'); expect(() => twice.checkpoint('0')).toThrow(/Second checkpoint/);
  });
});

describe('clock mapping', () => {
  // clock-reply.json: probeId 1, receivedMonotonicNs 1000449700000, sentMonotonicNs 1000449900000 (200 us at the source).
  const reply = server('clock-reply');
  const map = (probeSentNs: string, replyReceivedNs: string, probeId = '1') => computeClockMapping({reply, probeId, clientClockId: CLIENT_CLOCK, probeSentNs, replyReceivedNs});
  it('computes the offset and an uncertainty of at least half the round trip with exact BigInt arithmetic', () => {
    expect(map('5000000000', '5000800000')).toEqual({sourceClockId: '30000000-0000-4000-8000-000000000001', clientClockId: CLIENT_CLOCK,
      offsetNs: '995449400000', uncertaintyNs: '300000', measuredAtClientNs: '5000800000'});
    expect(map('5000000000', '5000800001')).toMatchObject({offsetNs: '995449399999', uncertaintyNs: '300001'});
    expect(map('2000000000000', '2000000800000')).toMatchObject({offsetNs: '-999550600000', uncertaintyNs: '300000'});
    expect(map('2000000000000', '2000000800001')).toMatchObject({offsetNs: '-999550600001', uncertaintyNs: '300001'});
  });
  it('rejects negative round trips, mismatched replies and non-reply messages, and discards late measurements', () => {
    expect(() => map('5000000000', '5000100000')).toThrow(/Negative/);
    // The requirement changed in review: a late reply ends the probe but yields no measurement, instead of an error.
    expect(map('5000000000', '6000000001')).toBeUndefined();
    expect(map('5000000000', '6000000000')).toMatchObject({measuredAtClientNs: '6000000000'});
    expect(() => map('5000000000', '4999999999')).toThrow(/before its probe/);
    expect(() => map('5000000000', '5000800000', '2')).toThrow(/mismatch/);
    expect(() => computeClockMapping({reply: server('welcome'), probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '0', replyReceivedNs: '1'})).toThrow(ProtocolError);
  });
  const withTimes = (received: string, sent: string, capture = '18446744073709551615') => {
    const m = structuredClone(reply); if (m.kind !== 'clock.reply') throw new Error('fixture');
    m.capture.monotonicNs = capture; m.data.receivedMonotonicNs = received; m.data.sentMonotonicNs = sent; return m;
  };
  it('rejects a negative round trip before the lateness check', () => {
    // 2 s at the client cannot contain 3 s at the source: impossible, not merely late.
    const impossible = withTimes('997449900000', '1000449900000', '1000450000000');
    expect(() => computeClockMapping({reply: impossible, probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '5000000000', replyReceivedNs: '7000000000'})).toThrow(/Negative/);
  });
  it('computes exact offsets at the uint64 extremes', () => {
    const high = withTimes('18446744073709551615', '18446744073709551615'), low = withTimes('0', '0');
    expect(computeClockMapping({reply: high, probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '0', replyReceivedNs: '0'}))
      .toMatchObject({offsetNs: '18446744073709551615', uncertaintyNs: '0', measuredAtClientNs: '0'});
    expect(computeClockMapping({reply: low, probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '18446744073709551615', replyReceivedNs: '18446744073709551615'}))
      .toMatchObject({offsetNs: '-18446744073709551615', uncertaintyNs: '0', measuredAtClientNs: '18446744073709551615'});
  });
  it('invalidates the mapping when either clock identity changes', () => {
    const mapping = map('5000000000', '5000800000')!;
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000001', CLIENT_CLOCK)).toBe(true);
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000002', CLIENT_CLOCK)).toBe(false);
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002')).toBe(false);
  });
});

describe('ET-050b shared minor-1 delivery streams', () => {
  for (const [name, durable, steps, outcome, expected] of m1Streams) it(`shared minor-1 stream ${name}`, () => {
    const result = runStream(durable === '1', steps.split(','), MINOR_1);
    if (outcome.startsWith('reject@')) {
      expect(result.error).toBeInstanceOf(ProtocolError);
      expect(result.failedAt).toBe(Number(outcome.slice('reject@'.length)));
    } else {
      expect(outcome).toBe('accept'); expect(result.error).toBeUndefined();
      expect(result.cursor?.throughEventSeq ?? '0').toBe(expected);
    }
  });
  it('fails every minor-1 stream with a numeric A: step through the harness when the cursor never acknowledges', () => {
    const numeric = m1Streams.filter(([, , steps]) => steps.split(',').some(step => /^A:[0-9]+$/.test(step)));
    expect(numeric.map(([name]) => name)).toEqual(['normal', 'old-plugin-minor-0']);
    const never = vi.spyOn(DurableAckCursor.prototype, 'ack').mockReturnValue(undefined);
    try {
      for (const [name, durable, steps] of numeric) {
        const result = runStream(durable === '1', steps.split(','), MINOR_1);
        expect(String(result.error), name).toMatch(/^Error: Harness: cursor produced ACK -, expected [0-9]+$/);
      }
    } finally { never.mockRestore(); }
  });
  it('reports the selected minor and builds ACKs at it', () => {
    const result = runStream(true, m1Streams.find(([name]) => name === 'normal')![2].split(','), MINOR_1);
    expect(result.error).toBeUndefined();
    expect(result.applied.map(a => a.message.version.minor)).toEqual([1, 1, 1, 1, 1, 1]);
    const old = runStream(true, m1Streams.find(([name]) => name === 'old-plugin-minor-0')![2].split(','), MINOR_1);
    expect(old.error).toBeUndefined(); expect(old.applied.map(a => a.message.version.minor)).toEqual([0, 0, 0, 0]);
  });
});

describe('ET-050b one minor per connection', () => {
  it('rejects a welcome above the consumer maxMinor, which defaults to 0', () => {
    expect(() => new V1Consumer(true).accept(m1('welcome'))).toThrow(/Unsupported protocol version/);
    expect(() => new V1Consumer(true, {maxMinor: 0}).accept(m1('welcome'))).toThrow(ProtocolError);
    const offered = new V1Consumer(true, {maxMinor: 1}); expect(offered.minor).toBeUndefined();
    offered.accept(m1('welcome')); expect(offered.minor).toBe(1);
    const old = new V1Consumer(true, {maxMinor: 1}); old.accept(server('welcome')); expect(old.minor).toBe(0);
    // ET-052: minor 2 exists, so the first unsupported maximum is 3.
    for (const maxMinor of [3, -1, 0.5]) expect(() => new V1Consumer(true, {maxMinor})).toThrow(ProtocolError);
  });
  it('closes the consumer when the minor changes within a connection, in either direction', () => {
    const up = new V1Consumer(true, {maxMinor: 1}); up.accept(server('welcome')); up.accept(server('checkpoint'));
    expect(() => up.accept(m1('snapshot'))).toThrow(/Unsupported protocol version/); expect(() => up.accept(server('snapshot'))).toThrow(/closed/);
    const down = new V1Consumer(true, {maxMinor: 1}); down.accept(m1('welcome')); down.accept(m1('checkpoint'));
    expect(() => down.accept(server('event-job-configured'))).toThrow(/minor changed/); expect(() => down.accept(m1('event-job-configured'))).toThrow(/closed/);
  });
  it('rejects a minor-1 state without a gearbox and a minor-0 state with one, before any consumer sees them', () => {
    for (const name of ['checkpoint-without-gearbox', 'snapshot-without-gearbox', 'checkpoint-minor-0-with-gearbox', 'snapshot-minor-0-with-gearbox']) {
      expect(() => decodePayload(bytes(name, m1Dir), 'server', {maxMinor: 1}), name).toThrow(ProtocolError);
    }
  });
  it('hydrates a minor-1 checkpoint with its gearbox and no event coverage', () => {
    const consumer = new V1Consumer(true, {maxMinor: 1}); consumer.accept(m1('welcome'));
    const applied = consumer.accept(m1('checkpoint'));
    if (applied.message.kind !== 'checkpoint') throw new Error('fixture');
    expect(applied.hydration).toBe(true); expect(applied.coverage).toBeUndefined();
    expect(applied.message.data.state.gearbox?.forwardGears).toEqual({available: true, value: 12});
  });
  it('builds cumulative ACKs at the connection minor, which defaults to 0', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0', 1); cursor.received('1', '1'); cursor.commit('1');
    const ack = cursor.ack();
    expect(ack).toEqual({version: {major: 1, minor: 1}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: '1'}});
    expect(validateClientMessage(ack, {maxMinor: 1})).toEqual(ack); expect(() => validateClientMessage(ack)).toThrow(ProtocolError);
    cursor.beginConnection('1'); cursor.received('2', '2'); cursor.commit('2'); expect(cursor.ack()?.version).toEqual({major: 1, minor: 0});
    expect(() => cursor.beginConnection('2', 3)).toThrow(ProtocolError);
  });
  it('accepts producer-side ACKs only at the connection minor', () => {
    const ack = (minor: number, through: string) => ({version: {major: 1, minor}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: through}});
    const minor1 = new AckValidator(P1, true, 1); minor1.checkpoint('0'); minor1.sent('2');
    expect(minor1.accept(ack(1, '1'))).toBe('1');
    expect(() => minor1.accept(ack(0, '2'))).toThrow(/minor differs/); expect(() => minor1.accept(ack(1, '2'))).toThrow(/closed/);
    const minor0 = new AckValidator(P1, true); minor0.checkpoint('0'); minor0.sent('1');
    expect(() => minor0.accept(ack(1, '1'))).toThrow(/Unsupported protocol version/);
    expect(() => new AckValidator(P1, true, 3)).toThrow(ProtocolError);
  });
  it('accepts producer-side clock probes only after the checkpoint and at the connection minor', () => {
    const probe = (minor: number, probeId = '1') => ({version: {major: 1, minor}, kind: 'clock.probe', data: {probeId}});
    const minor1 = new AckValidator(P1, false, 1); minor1.checkpoint('0');
    expect(minor1.probe(probe(1))).toBe('1');
    expect(() => minor1.probe(probe(0, '2'))).toThrow(/minor differs/); expect(() => minor1.probe(probe(1, '3'))).toThrow(/closed/);
    const minor0 = new AckValidator(P1, true); minor0.checkpoint('0');
    expect(() => minor0.probe(probe(1))).toThrow(/Unsupported protocol version/);
    const early = new AckValidator(P1, true, 1); expect(() => early.probe(probe(1))).toThrow(/before checkpoint/);
    const notProbe = new AckValidator(P1, true); notProbe.checkpoint('0');
    expect(() => notProbe.probe({version: {major: 1, minor: 0}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: '0'}})).toThrow(/Clock probe expected/);
  });
  it('maps a clock reply at the caller maximum minor, which defaults to 0', () => {
    const input = {reply: m1('clock-reply'), probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '5000000000', replyReceivedNs: '5000800000'};
    expect(computeClockMapping({...input, maxMinor: 1}))
      .toEqual({sourceClockId: '30000000-0000-4000-8000-000000000001', clientClockId: CLIENT_CLOCK, offsetNs: '995449400000', uncertaintyNs: '300000', measuredAtClientNs: '5000800000'});
    expect(() => computeClockMapping(input)).toThrow(/Unsupported protocol version/);
    expect(() => computeClockMapping({...input, maxMinor: 3})).toThrow(ProtocolError);
  });
});

describe('ET-052 shared minor-2 delivery streams', () => {
  for (const [name, durable, steps, outcome, expected] of m2Streams) it(`shared minor-2 stream ${name}`, () => {
    const result = runStream(durable === '1', steps.split(','), MINOR_2);
    if (outcome.startsWith('reject@')) {
      expect(result.error).toBeInstanceOf(ProtocolError);
      expect(result.failedAt).toBe(Number(outcome.slice('reject@'.length)));
    } else {
      expect(outcome).toBe('accept'); expect(result.error).toBeUndefined();
      expect(result.cursor?.throughEventSeq ?? '0').toBe(expected);
    }
  });
  it('fails every minor-2 stream with a numeric A: step through the harness when the cursor never acknowledges', () => {
    const numeric = m2Streams.filter(([, , steps]) => steps.split(',').some(step => /^A:[0-9]+$/.test(step)));
    expect(numeric.map(([name]) => name)).toEqual(['normal', 'old-plugin-minor-1', 'old-plugin-minor-0']);
    const never = vi.spyOn(DurableAckCursor.prototype, 'ack').mockReturnValue(undefined);
    try {
      for (const [name, durable, steps] of numeric) {
        const result = runStream(durable === '1', steps.split(','), MINOR_2);
        expect(String(result.error), name).toMatch(/^Error: Harness: cursor produced ACK -, expected [0-9]+$/);
      }
    } finally { never.mockRestore(); }
  });
  it('reports the selected minor of each connection and builds its ACKs at it', () => {
    const minors = (name: string) => {
      const result = runStream(true, m2Streams.find(([n]) => n === name)![2].split(','), MINOR_2);
      expect(result.error, name).toBeUndefined(); return result.applied.map(a => a.message.version.minor);
    };
    expect(minors('normal')).toEqual([2, 2, 2, 2, 2, 2]);
    expect(minors('old-plugin-minor-1')).toEqual([1, 1, 1, 1]);
    expect(minors('old-plugin-minor-0')).toEqual([0, 0, 0, 0]);
  });
  it('lets the availability of the break change between snapshots of one connection', () => {
    const result = runStream(true, m2Streams.find(([name]) => name === 'break-availability')![2].split(','), MINOR_2);
    expect(result.error).toBeUndefined();
    const breaks = result.applied.map(a => a.message.kind === 'snapshot' || a.message.kind === 'checkpoint' ? a.message.data.state.nextMandatoryBreak : undefined).slice(1);
    expect(breaks).toEqual([
      {available: true, value: 95, unit: 'min'}, {available: true, value: 95, unit: 'min'}, {available: true, value: 0, unit: 'min'}, {available: true, value: -30, unit: 'min'},
      {available: true, value: 2_147_483_647, unit: 'min'}, {available: true, value: -2_147_483_648, unit: 'min'}, {available: false, reason: 'not-observed', unit: 'min'},
      {available: false, reason: 'not-supported', unit: 'min'}, {available: false, reason: 'invalid', unit: 'min'}]);
  });
  it('hydrates a minor-2 checkpoint with the break and no event coverage', () => {
    const consumer = new V1Consumer(true, {maxMinor: 2}); consumer.accept(m2('welcome')); expect(consumer.minor).toBe(2);
    const applied = consumer.accept(m2('checkpoint'));
    if (applied.message.kind !== 'checkpoint') throw new Error('fixture');
    expect(applied.hydration).toBe(true); expect(applied.coverage).toBeUndefined();
    expect(applied.message.data.state.nextMandatoryBreak).toEqual({available: true, value: 95, unit: 'min'});
  });
  it('rejects a minor-2 welcome above the consumer maximum and a minor change inside a minor-2 connection', () => {
    for (const maxMinor of [undefined, 0, 1]) {
      expect(() => new V1Consumer(true, maxMinor === undefined ? {} : {maxMinor}).accept(m2('welcome')), String(maxMinor)).toThrow(/Unsupported protocol version/);
    }
    const down = new V1Consumer(true, {maxMinor: 2}); down.accept(m2('welcome')); down.accept(m2('checkpoint'));
    expect(() => down.accept(m1('event-job-configured'))).toThrow(/minor changed/); expect(() => down.accept(m2('event-job-configured'))).toThrow(/closed/);
    for (const maxMinor of [3, -1, 0.5]) expect(() => new V1Consumer(true, {maxMinor})).toThrow(ProtocolError);
  });
  it('rejects a minor-2 state without the break and a minor-1 or minor-0 state with it, before any consumer sees them', () => {
    for (const name of ['checkpoint-without-break', 'snapshot-without-break', 'snapshot-without-gearbox', 'checkpoint-minor-1-with-break', 'snapshot-minor-0-with-break']) {
      expect(() => decodePayload(bytes(name, m2Dir), 'server', {maxMinor: 2}), name).toThrow(ProtocolError);
    }
  });
  it('builds ACKs, validates ACKs and clock probes, and maps clock replies at minor 2', () => {
    const cursor = new DurableAckCursor(P1); cursor.beginConnection('0', 2); cursor.received('1', '1'); cursor.commit('1');
    const ack = cursor.ack();
    expect(ack).toEqual({version: {major: 1, minor: 2}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: '1'}});
    expect(validateClientMessage(ack, {maxMinor: 2})).toEqual(ack); expect(() => validateClientMessage(ack, {maxMinor: 1})).toThrow(ProtocolError);
    expect(() => cursor.beginConnection('1', 3)).toThrow(ProtocolError);
    const ackAt = (minor: number, through: string) => ({version: {major: 1, minor}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: through}});
    const probeAt = (minor: number, probeId: string) => ({version: {major: 1, minor}, kind: 'clock.probe', data: {probeId}});
    const validator = new AckValidator(P1, true, 2); validator.checkpoint('0'); validator.sent('2');
    expect(validator.accept(ackAt(2, '1'))).toBe('1'); expect(validator.probe(probeAt(2, '1'))).toBe('1');
    expect(() => validator.accept(ackAt(1, '2'))).toThrow(/minor differs/); expect(() => validator.probe(probeAt(2, '2'))).toThrow(/closed/);
    const older = new AckValidator(P1, true, 1); older.checkpoint('0'); older.sent('1');
    expect(() => older.accept(ackAt(2, '1'))).toThrow(/Unsupported protocol version/);
    expect(() => new AckValidator(P1, true, 3)).toThrow(ProtocolError);
    const input = {reply: m2('clock-reply'), probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '5000000000', replyReceivedNs: '5000800000'};
    expect(computeClockMapping({...input, maxMinor: 2}))
      .toEqual({sourceClockId: '30000000-0000-4000-8000-000000000001', clientClockId: CLIENT_CLOCK, offsetNs: '995449400000', uncertaintyNs: '300000', measuredAtClientNs: '5000800000'});
    expect(() => computeClockMapping({...input, maxMinor: 1})).toThrow(/Unsupported protocol version/); expect(() => computeClockMapping({...input, maxMinor: 3})).toThrow(ProtocolError);
  });
});
