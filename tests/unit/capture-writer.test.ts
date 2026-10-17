import {createHash} from 'node:crypto';
import {open, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CaptureWriter, CAPTURE_LIMITS, type CaptureContext, type CaptureManifest} from '../../apps/desktop/src/capture-writer';
import {temporaryResources} from '../shared/resources';
import {AUTHORITY, SESSION, delivered, end, envelope, header, loss, observation} from '../shared/cap0-fixtures';

let resources: Awaited<ReturnType<typeof temporaryResources>>;
beforeEach(async () => {resources = await temporaryResources();});
afterEach(async () => {vi.useRealTimers(); await resources.dispose();});
const context = (deadlineMs: number = CAPTURE_LIMITS.deadlineMs): CaptureContext => ({captureSessionId: SESSION, activation: {mechanism: 'environment', deadlineMs, operatorLabel: 'synthetic-test'},
  code: {brokerSha256: 'b'.repeat(64)}, platform: {arch: 'x64'}, displays: []});
let clock = 0;
function writer(options: Partial<ConstructorParameters<typeof CaptureWriter>[0]> = {}) {
  const closed: CaptureManifest[] = [];
  const instance = new CaptureWriter({root: path.join(resources.directory, 'captures'), context: context(), now: () => clock += 1, utcNow: () => 1_700_000_000_000 + clock, ...options}, manifest => closed.push(manifest));
  return {instance, closed};
}
const readManifest = async (w: CaptureWriter) => JSON.parse(await readFile(path.join(w.directory, 'manifest.json'), 'utf8')) as CaptureManifest;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
/** The real packets file, with `written` resolving once its first write has completed. */
function observedFile() {
  const written = deferred();
  const openFile = async (filename: string) => {
    const handle = await open(filename, 'wx');
    return {write: async (buffer: Buffer, offset?: number, length?: number) => { const result = await handle.write(buffer, offset, length); written.resolve(); return result; },
      sync: () => handle.sync(), close: () => handle.close()} as never;
  };
  return {open: openFile, written: written.promise};
}
/** Runs every continuation already queued (promise jobs), so the writer has handled a completed write. */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('CAP0 bounded writer', () => {
  it('writes validated packets and a complete manifest with hashes and distinct clock domains', async () => {
    const {instance, closed} = writer(); await instance.start(); instance.bindAuthority(AUTHORITY);
    expect(instance.accept(header())).toBe(true); expect(instance.accept(envelope(1, 1, {observations: delivered()}))).toBe(true);
    expect(instance.accept(envelope(2, 3, {droppedBefore: 1, group: 'lifecycle', id: 'simulation.paused'}))).toBe(true);
    expect(instance.accept(loss(3, 3, 1))).toBe(true); expect(instance.accept(end(4, 3, 1))).toBe(true);
    const manifest = await instance.close('disconnect'); // Already closed by the end marker; reason is retained.
    expect(closed).toHaveLength(1); expect(manifest).toEqual(await readManifest(instance));
    expect(manifest).toMatchObject({status: 'complete', origin: 'synthetic', stop: {reason: 'source-end'}, authority: AUTHORITY,
      counts: {packetsReceived: 5, packetsWritten: 5, packetsDiscarded: 0, envelopesCompleted: 2},
      loss: {endMarkerReceived: true, lastPacketSeq: '4', lastEnvelopeSeq: '3', knownBoundaries: [{envelopeSeq: '3', droppedBefore: '1'}], pluginLoss: {droppedEnvelopes: '1'}},
      evidence: {durableAck: false, tripEffects: false, history: false, playback: false}});
    const raw = await readFile(path.join(instance.directory, 'packets.ndjson'));
    expect(manifest.files).toEqual([{name: 'packets.ndjson', bytes: raw.length, sha256: createHash('sha256').update(raw).digest('hex')}]);
    const lines = raw.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line) as {receipt: {seq: number; monotonicNs: string}; packet: {data: {observations?: {value: {value: unknown}}[]}}});
    expect(lines.map(l => l.receipt.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(lines[1].packet.data.observations![1].value.value).toBe('18446744073709551615');
    expect(manifest.clockDomains).toHaveProperty('fileReceipt.clockId', manifest.timing.receiptClockId);
    expect(manifest.clockDomains).toHaveProperty('sourceMonotonic.clockId', '33333333-3333-4333-8333-333333333333');
    expect((await readdir(instance.directory)).sort()).toEqual(['manifest.json', 'packets.ndjson']);
    expect(path.relative(resources.directory, instance.directory)).toBe(path.join('captures', SESSION));
  });
  it('contains a throwing credit grant, immediate or after a completed write, as an internal-error close', async () => {
    const unhandled: unknown[] = [], listener = (reason: unknown) => unhandled.push(reason); process.on('unhandledRejection', listener);
    try {
      const file = observedFile(), immediate = writer({open: file.open}); await immediate.instance.start(); immediate.instance.accept(header());
      await file.written; await settle(); // Header written: room for another line.
      expect(() => immediate.instance.whenRoom(() => { throw new Error('stdin closed'); })).not.toThrow();
      expect(await immediate.instance.close('disconnect')).toMatchObject({stop: {reason: 'internal-error', detail: 'credit grant failed: stdin closed'}});
      await resources.dispose(); resources = await temporaryResources();
      const gate = deferred();
      const delayed = writer({limits: {pendingBytes: 4096}, open: () => Promise.resolve({write: async (buffer: Buffer, offset = 0, length = buffer.length - offset) => { await gate.promise; return {bytesWritten: length, buffer}; }, sync: async () => {}, close: async () => {}} as never)});
      await delayed.instance.start(); delayed.instance.accept(header());
      delayed.instance.whenRoom(() => { throw new Error('broker gone'); }); expect(delayed.instance.closed).toBe(false);
      gate.resolve(); await settle(); // The completed write released the withheld grant, which threw and closed the capture.
      expect(await delayed.instance.close('disconnect')).toMatchObject({stop: {reason: 'internal-error', detail: 'credit grant failed: broker gone'}, flowControl: {creditsWithheld: 1, withheldAtClose: false}});
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', listener); }
  });
  it('closes on the pending-byte cap while a slow write is outstanding and records the discard', async () => {
    const gate = deferred(); let writes = 0;
    const {instance} = writer({limits: {pendingBytes: 4096}, open: () => Promise.resolve({write: async (buffer: Buffer, offset = 0, length = buffer.length - offset) => { writes++; await gate.promise; return {bytesWritten: length, buffer}; }, sync: async () => {}, close: async () => {}} as never)});
    await instance.start(); instance.bindAuthority(AUTHORITY); instance.accept(header());
    let seq = 1, accepted = true;
    while (accepted) accepted = instance.accept(envelope(seq, seq, {observations: [observation(0, 'text', 'string', 'p'.repeat(600))]})) && ++seq < 100;
    expect(instance.closed).toBe(true); gate.resolve();
    const manifest = await readManifest(await instance.close('disconnect').then(() => instance));
    expect(manifest).toMatchObject({status: 'partial', stop: {reason: 'pending-cap'}, counts: {packetsDiscarded: 1}});
    expect(manifest.counts.packetsWritten).toBe(manifest.counts.packetsReceived - 1); expect(writes).toBeGreaterThan(0);
    expect(manifest.limits.pendingBytes).toBe(4096);
  });
  it('closes at the file cap without exceeding it', async () => {
    const {instance} = writer({limits: {fileBytes: 6000}}); await instance.start(); instance.accept(header());
    for (let seq = 1; seq < 50 && instance.accept(envelope(seq, seq, {observations: [observation(0, 'text', 'string', 'f'.repeat(500))]})); seq++) await new Promise(r => setTimeout(r, 1));
    const manifest = await instance.close('disconnect');
    expect(manifest.stop.reason).toBe('file-cap'); expect(manifest.files[0].bytes).toBeLessThanOrEqual(6000); expect(manifest.counts.bytesDiscarded).toBeGreaterThan(0); expect(manifest.status).toBe('partial');
  });
  it('closes at the collection deadline using a controlled timer', async () => {
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    const {instance, closed} = writer({context: context(60_000)}); await instance.start(); instance.accept(header());
    vi.advanceTimersByTime(59_999); expect(instance.closed).toBe(false);
    vi.advanceTimersByTime(1); expect(instance.closed).toBe(true); vi.useRealTimers();
    const manifest = await instance.close('service-stop');
    expect(manifest).toMatchObject({stop: {reason: 'deadline'}, status: 'partial', loss: {endMarkerReceived: false}}); expect(closed).toHaveLength(1);
  });
  it('retains manifest and loss evidence when the file write fails', async () => {
    const {instance} = writer({open: () => Promise.resolve({write: () => Promise.reject(new Error('disk full')), sync: async () => {}, close: async () => {}} as never)});
    await instance.start(); instance.accept(header()); instance.accept(envelope(1, 1));
    const manifest = await instance.close('disconnect');
    expect(manifest).toMatchObject({status: 'partial', stop: {reason: 'write-failure', detail: 'write-failed: disk full'}, counts: {packetsWritten: 0, bytesWritten: 0}});
    expect(manifest.counts.packetsDiscarded).toBe(2); expect(manifest.files[0].bytes).toBe(0);
  });
  it('retains partial-completion evidence on disconnect inside a split envelope', async () => {
    const {instance} = writer(); await instance.start(); instance.accept(header());
    instance.accept(envelope(1, 1, {observations: delivered().slice(0, 2), total: 4, final: false}));
    const manifest = await instance.close('disconnect', 'source closed before an end marker');
    expect(manifest).toMatchObject({status: 'partial', stop: {reason: 'disconnect'}, loss: {endMarkerReceived: false, envelopePartial: true, lastEnvelopeSeq: '1'}, counts: {envelopesCompleted: 0}});
  });
  it('closes on an invalid stream instead of writing out-of-order evidence', async () => {
    const {instance} = writer(); await instance.start(); instance.accept(header());
    expect(instance.accept(envelope(2, 1))).toBe(false);
    const manifest = await instance.close('disconnect'); expect(manifest.stop.reason).toBe('protocol-error'); expect(manifest.counts.packetsWritten).toBe(1);
  });
  it('rejects bounds above the approved limits, relative roots and directory reuse', async () => {
    expect(() => writer({limits: {pendingBytes: CAPTURE_LIMITS.pendingBytes + 1}})).toThrow(/approved/);
    expect(() => writer({limits: {fileBytes: CAPTURE_LIMITS.fileBytes + 1}})).toThrow(/approved/);
    expect(() => writer({root: 'relative'})).toThrow(/absolute/);
    const first = writer(); await first.instance.start(); await first.instance.close('service-stop');
    await expect(writer().instance.start()).rejects.toThrow();
  });
});

describe('CAP0 writer close robustness and fidelity', () => {
  it('never rejects when the manifest write fails: onClose runs and the in-memory result records the failure', async () => {
    const unhandled: unknown[] = [], listener = (reason: unknown) => unhandled.push(reason); process.on('unhandledRejection', listener);
    try {
      const {instance, closed} = writer({writeManifest: () => Promise.reject(new Error('manifest disk full'))});
      await instance.start(); instance.accept(header()); instance.accept(end(1, 0));
      const manifest = await instance.close('service-stop');
      await settle(); // An unhandled rejection would have been reported by now.
      expect(manifest).toMatchObject({stop: {reason: 'source-end'}, manifestWriteError: 'manifest disk full'}); expect(closed).toEqual([manifest]);
      expect((await readdir(instance.directory)).sort()).toEqual(['packets.ndjson']); expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', listener); }
  });
  it('stores the validated payload text verbatim, preserving -0 and exact number spellings', async () => {
    const {instance} = writer(); await instance.start(); instance.accept(header());
    const packet = envelope(1, 1, {observations: [observation(0, 'damage', 'float', -0)]});
    const text = JSON.stringify(packet).replace('"value":0}', '"value":-0}').replace('"packetSeq"', '\n"packetSeq"');
    expect(text).toContain('-0'); instance.accept(packet, text); await instance.close('service-stop');
    const lines = (await readFile(path.join(instance.directory, 'packets.ndjson'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2); expect(lines[1]).toContain('"value":-0}');
    expect(Object.is((JSON.parse(lines[1]) as {packet: {data: {observations: {value: {value: number}}[]}}}).packet.data.observations[0].value.value, -0)).toBe(true);
  });
});
