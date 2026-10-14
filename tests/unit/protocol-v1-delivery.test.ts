import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import {decodePayload, negotiateV1, ProtocolError, validateClientMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {AckValidator, computeClockMapping, DurableAckCursor, isClockMappingCurrent, V1Consumer, type V1Applied} from '../../packages/contracts/src/protocol-v1-delivery';

const dir = resolve('tests/fixtures/protocol-v1');
const bytes = (name: string) => new Uint8Array(readFileSync(resolve(dir, `${name}.json`)));
const server = (name: string) => decodePayload(bytes(name), 'server') as ServerMessage;
const rows = (input: string) => input.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const streams = rows(readFileSync(resolve(dir, 'streams.txt'), 'utf8'));
const P1 = '10000000-0000-4000-8000-000000000001', P2 = '10000000-0000-4000-8000-000000000002';
const CLIENT_CLOCK = '60000000-0000-4000-8000-000000000001';

/**
 * Drives one shared stream: `S:` frames go through the consumer, `C:` frames through negotiation, the producer-side
 * ACK validator or the probe registry, and `R` starts a new connection. Coverage is committed immediately here to
 * stand in for a storage transaction; the actual UNIQUE insert belongs to ET-013/ET-015a.
 */
function runStream(durable: boolean, steps: string[]): {cursor?: DurableAckCursor; applied: V1Applied[]; failedAt?: number; error?: unknown} {
  let consumer = new V1Consumer(durable), validator: AckValidator | undefined, cursor: DurableAckCursor | undefined;
  const applied: V1Applied[] = [];
  for (const [index, step] of steps.entries()) {
    try {
      if (step === 'R') { consumer = new V1Consumer(durable); validator = undefined; continue; }
      const [side, name] = step.split(':');
      if (side === 'S') {
        const result = consumer.accept(server(name)), m = result.message; applied.push(result);
        if (m.kind === 'welcome' && cursor?.pluginSessionId !== m.source.pluginSessionId) cursor = new DurableAckCursor(m.source.pluginSessionId);
        if (m.kind === 'checkpoint') {
          cursor!.beginConnection(m.data.status.delivery.ackedThroughEventSeq);
          validator = new AckValidator(m.source.pluginSessionId, m.data.status.delivery.ackedThroughEventSeq);
        }
        if (result.coverage) {
          validator!.sent(result.coverage.lastEventSeq);
          cursor!.received(result.coverage.firstEventSeq, result.coverage.lastEventSeq);
          cursor!.commit(result.coverage.firstEventSeq, result.coverage.lastEventSeq);
        }
      } else if (side === 'C') {
        const m = validateClientMessage(decodePayload(bytes(name), 'client'));
        if (m.kind === 'hello') { if (negotiateV1(m).durableEvents !== durable) throw new ProtocolError('Stream hello mismatch'); }
        else if (m.kind === 'ack') { if (!validator) throw new ProtocolError('ACK before checkpoint'); validator.accept(m); }
        else consumer.expectClockReply(m.data.probeId);
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
    const cursor = new DurableAckCursor(P1);
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
});

describe('REG-006 contract part: DurableAckCursor', () => {
  it('advances only to the highest contiguous committed eventSeq', () => {
    const cursor = new DurableAckCursor(P1); cursor.received('1', '4');
    cursor.commit('1'); cursor.commit('2'); cursor.commit('4');
    expect(cursor.throughEventSeq).toBe('2'); expect(cursor.isCommitted('4')).toBe(true); expect(cursor.isCommitted('3')).toBe(false);
    cursor.commit('3'); expect(cursor.throughEventSeq).toBe('4');
  });
  it('treats out-of-order commits and committed gap markers alike', () => {
    const cursor = new DurableAckCursor(P1); cursor.received('1', '1'); cursor.received('2', '5'); cursor.received('6', '6');
    expect(cursor.commit('6')).toBe('committed'); expect(cursor.commit('2', '5')).toBe('committed'); expect(cursor.throughEventSeq).toBe('0');
    expect(cursor.commit('1')).toBe('committed'); expect(cursor.throughEventSeq).toBe('6');
    expect(cursor.commit('3', '4')).toBe('duplicate');
  });
  it('never advances on receipt alone and never commits above the received range', () => {
    const cursor = new DurableAckCursor(P1); cursor.received('1', '3');
    expect(cursor.throughEventSeq).toBe('0'); expect(cursor.ack()).toBeUndefined();
    expect(() => cursor.commit('4')).toThrow(ProtocolError); expect(() => cursor.commit('3', '4')).toThrow(ProtocolError);
    expect(() => cursor.received('5', '5')).toThrow(ProtocolError); expect(() => cursor.commit('2', '1')).toThrow(ProtocolError);
  });
  it('emits a cumulative ACK only when it advances and starts from stored commits', () => {
    const cursor = new DurableAckCursor(P1, '7'); expect(cursor.throughEventSeq).toBe('7');
    expect(cursor.ack()).toBeUndefined();
    cursor.beginConnection('5'); expect(validateClientMessage(cursor.ack())).toEqual({version: {major: 1, minor: 0}, kind: 'ack', data: {pluginSessionId: P1, throughEventSeq: '7'}});
    expect(cursor.ack()).toBeUndefined();
    cursor.received('8', '8'); cursor.commit('8'); expect(cursor.ack()?.data).toEqual({pluginSessionId: P1, throughEventSeq: '8'});
    expect(() => cursor.beginConnection('9')).toThrow(ProtocolError);
    expect(() => new DurableAckCursor('not-a-uuid')).toThrow(ProtocolError);
  });
});

describe('AckValidator', () => {
  const ack = (through: string, pluginSessionId = P1) => ({version: {major: 1, minor: 0}, kind: 'ack', data: {pluginSessionId, throughEventSeq: through}});
  it('releases on advance, treats an equal ACK as a no-op and closes on violations', () => {
    const v = new AckValidator(P1, '2'); v.sent('5');
    expect(v.accept(ack('2'))).toBeUndefined(); expect(v.accept(ack('4'))).toBe('4'); expect(v.accept(ack('4'))).toBeUndefined();
    expect(v.ackedThroughEventSeq).toBe('4');
    expect(() => v.accept(ack('3'))).toThrow(/regressed/); expect(() => v.accept(ack('5'))).toThrow(/closed/);
  });
  it('rejects an ACK beyond the sent range, a foreign session and a non-ACK message', () => {
    const beyond = new AckValidator(P1, '0'); beyond.sent('3'); expect(() => beyond.accept(ack('4'))).toThrow(/beyond/);
    const foreign = new AckValidator(P1, '0'); foreign.sent('3'); expect(() => foreign.accept(ack('1', P2))).toThrow(/foreign/);
    const other = new AckValidator(P1, '0'); expect(() => other.accept({version: {major: 1, minor: 0}, kind: 'clock.probe', data: {probeId: '1'}})).toThrow(ProtocolError);
    const numeric = new AckValidator(P1, '0'); numeric.sent('1'); expect(() => numeric.accept({...ack('1'), data: {pluginSessionId: P1, throughEventSeq: 1}})).toThrow(ProtocolError);
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
  it('rejects negative round trips, late or mismatched replies and non-reply messages', () => {
    expect(() => map('5000000000', '5000100000')).toThrow(/Negative/);
    expect(() => map('5000000000', '6000000001')).toThrow(/deadline/);
    expect(() => map('5000000000', '4999999999')).toThrow(/deadline/);
    expect(() => map('5000000000', '5000800000', '2')).toThrow(/mismatch/);
    expect(() => computeClockMapping({reply: server('welcome'), probeId: '1', clientClockId: CLIENT_CLOCK, probeSentNs: '0', replyReceivedNs: '1'})).toThrow(ProtocolError);
  });
  it('invalidates the mapping when either clock identity changes', () => {
    const mapping = map('5000000000', '5000800000');
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000001', CLIENT_CLOCK)).toBe(true);
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000002', CLIENT_CLOCK)).toBe(false);
    expect(isClockMappingCurrent(mapping, '30000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000002')).toBe(false);
  });
});
