import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {decodePayload, encodeFrame, PROTOCOL_V1, ProtocolError, type ServerMessage, type SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {AckValidator, DurableAckCursor} from '../../packages/contracts/src/protocol-v1-delivery';
import {EventStore, LOSS_CAUSES, MAX_SEQ, wireCounts, type StoredEvent} from '../../tools/telemetry-simulator/src/v1/store';
import {deliveryStatus, endData, gapData, measureEvent, V1Producer} from '../../tools/telemetry-simulator/src/v1/producer';
import {AdapterModel, ScenarioClock} from '../../tools/telemetry-simulator/src/v1/source';

// Expected values below come from docs/protocol/v1.md §7-§10, docs/native-transport-v1.md (I1-I8, OD-5) and the
// hand-written ET-002b fixtures; none are produced by the store under test.
const fixture = (name: string) => decodePayload(new Uint8Array(readFileSync(resolve('tests/fixtures/protocol-v1', `${name}.json`))), 'server') as ServerMessage;
const data = (name: string) => fixture(name).data as unknown as Record<string, unknown>;
const P = '10000000-0000-4000-8000-000000000001';
function ev(seq: bigint | number, ns: bigint | number = 1_000_000_000_000n): StoredEvent {
  return {eventSeq: BigInt(seq), record: {type: 'job.cleared'},
    occurred: {monotonicNs: {available: true, value: BigInt(ns).toString()}, gameTime: {minutes: {available: false, reason: 'not-observed'}, clockId: P},
      utcUnixMs: {available: false, reason: 'not-observed'}, simulation: 'running', configurationRevision: '0', boundaryOrder: '0'}};
}
const connected = () => { const s = new EventStore(); s.connect(); return s; };
const drain = (s: EventStore) => { const items = []; for (let o = s.nextOutbound(); o; o = s.nextOutbound()) items.push(o); return items; };
const snapshotOf = (s: EventStore) => JSON.stringify({status: s.status(), end: s.endCursor(), entries: Array.from({length: s.entryCount}, (_, i) => s.entry(i))}, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);

describe('simulator v1 event store (I1-I8 mirror)', () => {
  it('I2: retains 255 events, keeps the last entry for a gap record and counts queueCount (REG-011)', () => {
    const s = connected();
    for (let i = 1; i <= 255; i++) expect(s.admit(ev(i), 100, 1n)).toBe('retained');
    expect(s.admit(ev(256, 7), 100, 2n)).toBe('lostQueueCount');
    // I3: a later loss extends the trailing gap record in place, whatever its cause.
    expect(s.lose(257n, 258n, 'offline', 8n, 9n, 3n)).toBe(true);
    expect(s.admit(ev(259, 10), 100, 4n)).toBe('lostQueueCount');
    expect(s.status()).toMatchObject({retainedEntries: 256, retainedBytes: 255 * 100 + 1_024, nextEventSeq: 260n});
    expect(s.entry(255)).toMatchObject({gap: true, first: 256n, last: 259n, bytes: 1_024, sinceNs: 2n});
    expect(s.status().eventLoss).toMatchObject({queueCount: 2n, offline: 2n});
  });

  it('measures event-worst at the documented 6,306 bytes, then 166 such events fit and the 167th is queueBytes', () => {
    const worst = fixture('event-worst');
    if (worst.kind !== 'event') throw new Error('event fixture expected');
    const record = {eventSeq: BigInt(worst.data.eventSeq), occurred: worst.data.occurred, record: worst.data.record};
    // native-transport-v1.md "Encoder": the fixture's 6,305 bytes plus one for `redelivered: false`.
    expect(measureEvent(worst.source, worst.capture.clockId, record)).toBe(6_306);
    const s = connected();
    // (1,048,576 - 1,024) / 6,306 = 166.1, so the reserved gap bytes stop admission at the 167th event.
    for (let i = 1; i <= 166; i++) expect(s.admit(ev(i), 6_306, 1n)).toBe('retained');
    expect(s.admit(ev(167), 6_306, 1n)).toBe('lostQueueBytes');
    expect(s.status()).toMatchObject({retainedEntries: 167, retainedBytes: 166 * 6_306 + 1_024});
  });

  it('counts queueCount when both bounds apply, and rejects an unsendable size', () => {
    const s = connected();
    // 254 x 4,000 + 16,384 + 1,024 fits; one more 16,384-byte event would exceed both bounds.
    for (let i = 1; i <= 254; i++) s.admit(ev(i), 4_000, 1n);
    expect(s.admit(ev(255), 16_384, 1n)).toBe('retained');
    expect(s.admit(ev(256), 16_384, 1n)).toBe('lostQueueCount');
    expect(s.status().eventLoss.queueBytes).toBe(0n);
  });

  it('rejects misuse without any effect', () => {
    const fresh = new EventStore(), before = snapshotOf(fresh);
    // OD-4: no event is admitted before the first durable connection; losses are.
    expect(fresh.admit(ev(1), 10, 1n)).toBe('rejected');
    expect(snapshotOf(fresh)).toBe(before);
    const s = connected(); s.admit(ev(1), 10, 1n); const after = snapshotOf(s);
    for (const misuse of [() => s.admit(ev(3), 10, 1n), () => s.admit(ev(2), 0, 1n), () => s.admit(ev(2), 16_385, 1n)]) expect(misuse()).toBe('rejected');
    expect(s.lose(2n, 2n, 'offline', 5n, undefined, 1n)).toBe(false);
    expect(s.lose(2n, 2n, 'offline', 6n, 5n, 1n)).toBe(false);
    expect(s.lose(3n, 3n, 'offline', undefined, undefined, 1n)).toBe(false);
    expect(s.release(1n)).toBeUndefined(); // nothing written yet on this connection
    expect(snapshotOf(s)).toBe(after);
    s.disconnect(1n);
    expect(s.release(0n)).toBeUndefined();
  });

  it('decision (c): an ACK inside a gap record keeps it whole and the reconnection redelivers it (stream ack-inside-gap-record)', () => {
    const s = connected();
    s.admit(ev(1, 1_000_149_000_000n), 1_500, 1_000_149_000_000n);
    expect(gapLike(drain(s))).toEqual([{event: 1n, redelivered: false}]);
    s.lose(2n, 3n, 'queueCount', 1_000_330_000_000n, 1_000_340_000_000n, 1_000_330_000_000n);
    const first = drain(s);
    if (!first[0].gap) throw new Error('gap expected');
    expect(gapData(first[0].range, first[0].redelivered)).toEqual(data('gap-queue-count'));
    s.lose(4n, 4n, 'encodingFailed', 1_000_355_000_000n, 1_000_355_000_000n, 1_000_355_000_000n);
    // A record extended after it was written yields a delta gap for the new tail only.
    const delta = drain(s);
    if (!delta[0].gap) throw new Error('gap expected');
    expect(gapData(delta[0].range, delta[0].redelivered)).toEqual(data('gap-encoding-failed-e4'));
    expect(s.release(3n)).toBe(1n);
    expect(s.entryCount).toBe(1);
    s.disconnect(1_001_000_000_000n); s.connect();
    const checkpoint = fixture('checkpoint-ack-inside-gap');
    if (checkpoint.kind !== 'checkpoint') throw new Error('checkpoint expected');
    expect(deliveryStatus(s.status(), true)).toEqual(checkpoint.data.status.delivery);
    expect(wireCounts(s.status().eventLoss)).toEqual(checkpoint.data.status.eventLoss);
    const again = drain(s);
    if (!again[0].gap) throw new Error('gap expected');
    expect(gapData(again[0].range, again[0].redelivered)).toEqual(data('gap-merged-redelivered'));
    expect(s.release(4n)).toBe(4n);
  });

  it('I5: retention expiry merges every retained event into one gap record timed at expiry (stream retention-expired)', () => {
    const s = connected();
    s.admit(ev(1, 1_000_150_000_000n), 1_500, 1_000_150_000_000n); s.admit(ev(2, 1_000_300_000_000n), 1_500, 1_000_300_000_000n);
    drain(s); s.disconnect(1_000_699_000_000n);
    s.expire(1_300_698_999_999n); expect(s.entryCount).toBe(2); // 1 ns before the 300,000 ms deadline
    s.expire(1_300_699_000_000n);
    expect(s.entryCount).toBe(1);
    s.connect();
    const checkpoint = fixture('checkpoint-expired');
    if (checkpoint.kind !== 'checkpoint') throw new Error('checkpoint expected');
    // The fixture stream uses an illustrative expiry time; OD-5 S2 makes the merged record's retention time the expiry time.
    expect(deliveryStatus(s.status(), true)).toEqual({...checkpoint.data.status.delivery, oldestRetainedMonotonicNs: {available: true, value: '1300699000000'}});
    expect(wireCounts(s.status().eventLoss)).toEqual(checkpoint.data.status.eventLoss);
    const [gap] = drain(s);
    if (!gap.gap) throw new Error('gap expected');
    expect(gapData(gap.range, gap.redelivered)).toEqual(data('gap-expired'));
  });

  it('cancels the retention window on a durable reconnection and admits OD-5 S4 events while it runs', () => {
    const s = connected(); s.admit(ev(1), 10, 1n); s.disconnect(10n);
    // Copied while connected, stored after the disconnect but inside the window: retained.
    expect(s.admit(ev(2), 10, 20n)).toBe('retained');
    s.connect(); s.disconnect(30n); s.expire(300_000_000_029n); expect(s.status().eventLoss.retentionExpired).toBe(0n);
    s.expire(300_000_000_030n); expect(s.status().eventLoss.retentionExpired).toBe(2n);
    // After the window an event stored this late is retentionExpired coverage.
    expect(s.admit(ev(3, 40n), 10, 300_000_000_031n)).toBe('lostRetentionExpired');
    expect(s.status()).toMatchObject({retainedEntries: 1, nextEventSeq: 4n});
  });

  it('I8 and the end cursor match the shared end fixtures', () => {
    const s = connected();
    for (let i = 1; i <= 5; i++) s.admit(ev(i), 10, 1n);
    drain(s); s.release(5n);
    expect(endData('plugin-shutdown', s.endCursor())).toEqual(data('end'));
    const last = new EventStore(MAX_SEQ); last.connect();
    expect(last.admit(ev(MAX_SEQ), 10, 1n)).toBe('retained');
    expect(last.exhausted).toBe(true);
    expect(endData('sequence-exhausted', last.endCursor())).toEqual(data('end-sequence-exhausted'));
    expect(last.lose(MAX_SEQ + 1n, MAX_SEQ + 1n, 'offline', undefined, undefined, 1n)).toBe(false);
  });

  it('fixed-seed randomized run: counters equal gap coverage, bounds hold, and the ET-002b cursor and validator accept every ACK', () => {
    let seed = 0x5eed_0001;
    const rand = (n: number) => { seed = (seed * 1_103_515_245 + 12_345) >>> 0; return seed % n; };
    const s = new EventStore(), lastKind = new Map<bigint, 'event' | 'gap'>();
    let cursor = new DurableAckCursor(P), validator: AckValidator | undefined, now = 1n, lost = 0n;
    const connect = () => { s.connect(); validator = new AckValidator(P, true); validator.checkpoint(s.releasePoint.toString()); cursor.beginConnection(s.releasePoint.toString()); };
    for (let step = 0; step < 4_000; step++) {
      now += BigInt(1 + rand(5_000)) * 1_000_000n;
      const op = rand(100), n = s.nextEventSeq;
      if (op < 50 && s.everConnectedDurably) { const r = s.admit(ev(n, now), 1 + rand(16_384), now); if (r !== 'retained') lost++; }
      else if (op < 70) { const k = BigInt(1 + rand(4)); s.lose(n, n + k - 1n, LOSS_CAUSES[rand(6)], now, now, now); lost += k; }
      else if (op < 78) { if (s.connected) { s.disconnect(now); validator = undefined; } else { if (rand(3) === 0) cursor = new DurableAckCursor(P, cursor.throughEventSeq); connect(); } }
      else if (op < 82 && !s.connected) {
        now += 300_000_000_000n * BigInt(rand(2));
        // An oracle independent of the counters: every retained event becomes lost when the window has ended.
        const events = Array.from({length: s.entryCount}, (_, i) => s.entry(i)).filter(e => !e.gap).length, deadline = s.retentionDeadlineNs;
        s.expire(now); if (deadline !== undefined && now >= deadline) lost += BigInt(events);
      }
      if (s.connected && validator) for (let o = s.nextOutbound(); o; o = s.nextOutbound()) {
        const first = o.gap ? o.range.first : o.event.eventSeq, last = o.gap ? o.range.last : o.event.eventSeq;
        for (let q = first; q <= last; q++) lastKind.set(q, o.gap ? 'gap' : 'event');
        validator.sent(last.toString()); cursor.received(first.toString(), last.toString());
        if (rand(4)) cursor.commit(first.toString(), last.toString());
        const ack = rand(3) ? cursor.ack() : undefined;
        if (ack) { const t = validator.accept(ack); if (t !== undefined) expect(s.release(BigInt(t))).toBeDefined(); }
      }
      const st = s.status();
      expect(st.retainedEntries).toBeLessThanOrEqual(256); expect(st.retainedBytes).toBeLessThanOrEqual(1_048_576);
      if (st.retainedEntries === 256) expect(st.retainedBytes).toBeGreaterThanOrEqual(1_024);
      expect(LOSS_CAUSES.reduce((sum, k) => sum + st.eventLoss[k], 0n)).toBe(lost);
      // Every retained entry starts right after the previous one. The run checks about 678,000 entry boundaries,
      // so compare them directly and assert the first break once per step: one expect() per boundary cost ~1.5 s
      // of assertion overhead and timed out under CPU contention. The checked condition is unchanged.
      let expect1 = st.ackedThroughEventSeq + 1n, firstBreak: {step: number; entry: number; first: bigint; expected: bigint} | undefined;
      for (let i = 0; i < s.entryCount && !firstBreak; i++) { const e = s.entry(i); if (e.first !== expect1) firstBreak = {step, entry: i, first: e.first, expected: expect1}; expect1 = e.last + 1n; }
      expect(firstBreak).toBeUndefined();
      expect(expect1).toBe(st.nextEventSeq);
    }
    // Deliver everything: the last delivered form of every eventSeq is a gap exactly for the counted losses.
    if (!s.connected) connect();
    for (let o = s.nextOutbound(); o; o = s.nextOutbound()) { const f = o.gap ? o.range.first : o.event.eventSeq, l = o.gap ? o.range.last : o.event.eventSeq; for (let q = f; q <= l; q++) lastKind.set(q, o.gap ? 'gap' : 'event'); }
    const gaps = [...lastKind.values()].filter(k => k === 'gap').length;
    expect(BigInt(gaps)).toBe(LOSS_CAUSES.reduce((sum, k) => sum + s.status().eventLoss[k], 0n));
    expect(lastKind.size).toBe(Number(s.nextEventSeq - 1n));
  });
});

function gapLike(items: ReturnType<typeof drain>) { return items.map(o => o.gap ? {gap: [o.range.first, o.range.last], redelivered: o.redelivered} : {event: o.event.eventSeq, redelivered: o.redelivered}); }

describe('simulator v1 producer caller sequence (docs/native-transport-v1.md steps 2-6)', () => {
  const source: SourceIdentity = {game: 'ets2', pluginSessionId: P, processInstanceId: '20000000-0000-4000-8000-000000000001', processId: 1, windowsSessionId: 0, origin: 'synthetic'};
  function producer() {
    const adapter = new AdapterModel({game: 'ets2', seed: 'producer-test', gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown',
      versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, startEventSeq: 1n}, new ScenarioClock());
    return {adapter, p: new V1Producer(adapter, source, '30000000-0000-4000-8000-000000000001')};
  }
  const hello = (durable: boolean) => encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: '50000000-0000-4000-8000-000000000001', minMinor: 0, maxMinor: 0, durableEvents: durable}});

  it('splits a loss run into lose() calls in the fixed cause order, each with the run lost times', () => {
    const {adapter, p} = producer(), lose = vi.spyOn(p.store, 'lose');
    adapter.channel.gate = 'durable'; adapter.channel.full = true; adapter.lifecycle('simulation.started', 1);
    adapter.channel.full = false; adapter.channel.gate = 'live'; adapter.lifecycle('simulation.paused', 2);
    adapter.channel.gate = 'none'; adapter.lifecycle('simulation.started', 3); adapter.frame(false, {}, 4);
    p.drain(5_000_000_000_000n);
    const t1 = 1_000_001_000_000n, t3 = 1_000_003_000_000n;
    expect(lose.mock.calls.map(c => c.slice(0, 5))).toEqual([[1n, 1n, 'offline', t1, t3], [2n, 2n, 'noDurableConsumer', t1, t3], [3n, 3n, 'queueCount', t1, t3]]);
    expect(p.store.status().eventLoss).toMatchObject({offline: 1n, noDurableConsumer: 1n, queueCount: 1n});
  });

  it('stamps capture no earlier than a carried occurrence time and never before the previous capture (step 5)', () => {
    const {adapter, p} = producer();
    p.open(); const [welcome, checkpoint] = p.receive(hello(true), 1_000_000_000_000n);
    expect([welcome.message.kind, checkpoint.message.kind]).toEqual(['welcome', 'checkpoint']);
    // The SDK thread observed the event at 1,000,050 ms; the worker's clock reading is earlier.
    adapter.lifecycle('simulation.started', 50); p.drain(1_000_010_000_000n);
    const event = p.pump(1_000_010_000_000n)!;
    expect(event.message.kind).toBe('event');
    expect(event.message.capture.monotonicNs).toBe('1000050000000');
    const later = p.receive(encodeFrame({version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: '1'}}), 1_000_020_000_000n)[0];
    expect(later.message.capture.monotonicNs).toBe('1000050000000');
  });

  it('accepts ACKs only through AckValidator and releases the store with the accepted value (step 6)', () => {
    const {adapter, p} = producer();
    p.open(); p.receive(hello(true), 1n);
    adapter.lifecycle('simulation.started', 0); p.drain(1n); p.pump(1_000_000_000_000n);
    const ack = (t: string) => encodeFrame({version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: P, throughEventSeq: t}});
    expect(() => p.receive(ack('2'), 1_000_000_000_000n)).toThrow(ProtocolError);
    const fresh = producer(); fresh.p.open(); fresh.p.receive(hello(true), 1n); fresh.adapter.lifecycle('simulation.started', 0); fresh.p.drain(1n); fresh.p.pump(1_000_000_000_000n);
    fresh.p.receive(ack('1'), 1_000_000_000_000n);
    expect(fresh.p.store.releasePoint).toBe(1n);
    const live = producer(); live.p.open(); live.p.receive(hello(false), 1n);
    expect(() => live.p.receive(ack('0'), 1n)).toThrow(ProtocolError);
  });

  // ET-050b B1, ET-052: the producer selects min(hello maxMinor, 2); minor-0 and minor-1 bytes stay the original ones.
  const helloOffering = (maxMinor: number, durable = true) => encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: '50000000-0000-4000-8000-000000000001', minMinor: 0, maxMinor, durableEvents: durable}});
  const M1 = {major: 1, minor: 1} as const;
  it('serves minor 0 without a gearbox or break to a client that offers only minor 0, minor 1 with the gearbox, and minor 2 with both', () => {
    for (const [offered, selected] of [[0, 0], [1, 1], [2, 2], [3, 2]] as const) {
      const {adapter, p} = producer();
      adapter.configuration('truck', [{name: 'gears.forward', sdkType: 'u32', value: 12}, {name: 'gears.reverse', sdkType: 'u32', value: 4}], 'terminated', 0); adapter.frame(false, {}, 1);
      p.open(); const [welcome, checkpoint] = p.receive(helloOffering(offered), 1_000_002_000_000n);
      expect([welcome.message.version, welcome.message.kind === 'welcome' && welcome.message.data.minor, checkpoint.message.version], `offer ${offered}`).toEqual([{major: 1, minor: selected}, selected, {major: 1, minor: selected}]);
      const state = checkpoint.message.kind === 'checkpoint' ? checkpoint.message.data.state : undefined;
      if (selected === 0) expect(Object.hasOwn(state!, 'gearbox')).toBe(false);
      else expect(state!.gearbox).toEqual({forwardGears: {available: true, value: 12}, reverseGears: {available: true, value: 4}, hshifter: {available: false, reason: 'not-observed'}});
      // The break key exists exactly on a minor-2 connection; this adapter's channel was never called back, so it is not-observed.
      expect(Object.hasOwn(state!, 'nextMandatoryBreak'), `offer ${offered}`).toBe(selected === 2);
      if (selected === 2) expect(state!.nextMandatoryBreak).toEqual({available: false, reason: 'not-observed', unit: 'min'});
      // Every later message of the connection, here a snapshot, keeps the selected minor.
      adapter.frame(false, {speed: 1}, 100);
      const snapshot = p.publication(1_000_100_000_000n)!;
      expect(snapshot.message.version).toEqual({major: 1, minor: selected});
    }
  });
  it('serves the break on a minor-2 connection exactly as the adapter holds it, and a lower minor never carries it (ET-052)', () => {
    const M2 = {major: 1, minor: 2} as const;
    for (const [value, expected] of [[95, {available: true, value: 95, unit: 'min'}], [0, {available: true, value: 0, unit: 'min'}], [-30, {available: true, value: -30, unit: 'min'}],
      [2147483647, {available: true, value: 2147483647, unit: 'min'}], [-2147483648, {available: true, value: -2147483648, unit: 'min'}],
      [null, {available: false, reason: 'not-observed', unit: 'min'}], ['invalid', {available: false, reason: 'invalid', unit: 'min'}]] as const) {
      for (const offered of [1, 2]) {
        const {adapter, p} = producer();
        adapter.frame(false, {'mandatory.break': value}, 0);
        p.open(); const [, checkpoint] = p.receive(helloOffering(offered), 1_000_002_000_000n);
        const state = checkpoint.message.kind === 'checkpoint' ? checkpoint.message.data.state : undefined;
        if (offered === 1) { expect(Object.hasOwn(state!, 'nextMandatoryBreak'), `value ${value}`).toBe(false); continue; }
        expect(state!.nextMandatoryBreak, `value ${value}`).toEqual(expected);
        // A snapshot of the same connection follows the next frame and keeps minor 2.
        adapter.frame(false, {'mandatory.break': 7}, 100);
        const snapshot = p.publication(1_000_100_000_000n)!;
        expect(snapshot.message.version).toEqual(M2);
        expect(snapshot.message.kind === 'snapshot' && snapshot.message.data.state.nextMandatoryBreak).toEqual({available: true, value: 7, unit: 'min'});
      }
    }
  });
  it('accepts ACKs and clock probes at the minor-2 connection minor only (ET-052)', () => {
    const M2 = {major: 1, minor: 2} as const;
    const {adapter, p} = producer();
    p.open(); p.receive(helloOffering(2), 1n);
    adapter.lifecycle('simulation.started', 0); p.drain(1n); p.pump(1_000_000_000_000n);
    p.receive(encodeFrame({version: M2, kind: 'ack', data: {pluginSessionId: P, throughEventSeq: '1'}}, {maxMinor: 2}), 1_000_000_000_000n);
    expect(p.store.releasePoint).toBe(1n);
    const [reply] = p.receive(encodeFrame({version: M2, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 2}), 1_000_000_000_001n);
    expect([reply.message.kind, reply.message.version]).toEqual(['clock.reply', M2]);
    // A {1,1} or {1,0} ACK or probe on a minor-2 connection is refused.
    for (const version of [{major: 1, minor: 1}, PROTOCOL_V1] as const) for (const kind of ['ack', 'clock.probe'] as const) {
      const fresh = producer(); fresh.p.open(); fresh.p.receive(helloOffering(2), 1n);
      const message = kind === 'ack' ? {version, kind, data: {pluginSessionId: P, throughEventSeq: '1'}} : {version, kind, data: {probeId: '2'}};
      expect(() => fresh.p.receive(encodeFrame(message, {maxMinor: 1}), 1n), `${kind} at minor ${version.minor}`).toThrow(ProtocolError);
    }
  });
  it('accepts ACKs and clock probes only at the connection minor, probes through AckValidator.probe', () => {
    const {adapter, p} = producer();
    p.open(); p.receive(helloOffering(1), 1n);
    adapter.lifecycle('simulation.started', 0); p.drain(1n); p.pump(1_000_000_000_000n);
    p.receive(encodeFrame({version: M1, kind: 'ack', data: {pluginSessionId: P, throughEventSeq: '1'}}, {maxMinor: 1}), 1_000_000_000_000n);
    expect(p.store.releasePoint).toBe(1n);
    const [reply] = p.receive(encodeFrame({version: M1, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 1}), 1_000_000_000_001n);
    expect([reply.message.kind, reply.message.version]).toEqual(['clock.reply', M1]);
    // A {1,0} ACK or probe on a minor-1 connection is refused.
    for (const message of [{version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: P, throughEventSeq: '1'}}, {version: PROTOCOL_V1, kind: 'clock.probe', data: {probeId: '2'}}] as const) {
      const fresh = producer(); fresh.p.open(); fresh.p.receive(helloOffering(1), 1n);
      expect(() => fresh.p.receive(encodeFrame(message), 1n)).toThrow(ProtocolError);
    }
    // A {1,1} probe on a minor-0 connection is refused by its decoder.
    const old = producer(); old.p.open(); old.p.receive(helloOffering(0), 1n);
    expect(() => old.p.receive(encodeFrame({version: M1, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 1}), 1n)).toThrow(ProtocolError);
    // The validator's probe check runs: a probe at the connection minor is still subject to the S6 order rule.
    const validator = vi.spyOn(AckValidator.prototype, 'probe');
    const order = producer(); order.p.open(); order.p.receive(helloOffering(1), 1n);
    order.p.receive(encodeFrame({version: M1, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 1}), 2n);
    expect(validator).toHaveBeenCalledOnce();
    expect(() => order.p.receive(encodeFrame({version: M1, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 1}), 3n)).toThrow(/Clock probe order/);
    validator.mockRestore();
  });
});
