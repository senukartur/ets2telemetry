import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Cap0FrameDecoder} from '../../packages/contracts/src/capture-cap0';
import {CaptureSession, type CaptureAuthority, type CaptureTransport} from '../../apps/desktop/src/capture-session';
import {temporaryResources} from '../shared/resources';
import {AUTHORITY, SESSION, delivered, end, envelope, frame, header, loss, observation, payload} from '../shared/cap0-fixtures';

// Actual Windows named pipes with a synthetic CAP0 source standing in for the fake-SDK plugin endpoint.
class PipeTransport extends EventEmitter implements CaptureTransport {
  readonly completion: Promise<void>;
  private readonly socket: net.Socket; private readonly decoder = new Cap0FrameDecoder(); private connected = false;
  constructor(endpoint: string, authority: CaptureAuthority) {
    super();
    this.socket = net.connect(endpoint);
    this.completion = new Promise(resolve => this.socket.once('close', () => resolve()));
    this.socket.once('connect', () => { this.connected = true; this.emit('authority', authority); });
    this.socket.on('data', (chunk: Buffer) => { try { this.decoder.push(chunk, packet => this.emit('packet', packet)); } catch (error) { this.socket.destroy(); this.emit('error', error); } });
    this.socket.on('error', (error: NodeJS.ErrnoException) => { if (!this.connected && error.code === 'ENOENT') this.emit('waiting'); else this.emit('error', error); });
    this.socket.once('end', () => this.emit('end'));
  }
  sendHello(bytes: Uint8Array): void { this.socket.write(bytes); }
  credit(): void {}
  destroy(): void { this.socket.destroy(); }
}
interface Source {endpoint: string; hellos: string[]; close(): Promise<void>}
async function source(script: (socket: net.Socket) => Promise<void>): Promise<Source> {
  const endpoint = `\\\\.\\pipe\\ets2telemetry-test-cap0-${randomUUID()}`, hellos: string[] = [], sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket); const decoder = new Cap0FrameDecoder(); let started = false;
    socket.on('error', () => {});
    socket.on('data', chunk => decoder.push(chunk, payload => {
      hellos.push(new TextDecoder().decode(payload));
      if (!started) { started = true; void script(socket).catch(() => socket.destroy()); }
    }));
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return {endpoint, hellos, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); })};
}
// Writes frames in irregular fragments to exercise reassembly over the real pipe.
async function send(socket: net.Socket, packets: unknown[]) {
  for (const packet of packets) { const bytes = frame(packet); for (let offset = 0; offset < bytes.length; offset += 7) socket.write(bytes.subarray(offset, Math.min(bytes.length, offset + 7))); }
  await new Promise(resolve => setTimeout(resolve, 20));
}
/** Hang guard of a wait for an observable write over the real pipe, below the 5 s case timeout; never a speed claim. */
const WRITE_HANG_GUARD_MS = 4000;
let resources: Awaited<ReturnType<typeof temporaryResources>>, sources: Source[];
beforeEach(async () => {resources = await temporaryResources(); sources = [];});
afterEach(async () => {await Promise.all(sources.map(s => s.close())); await resources.dispose();});
const context = (deadlineMs = 10_000) => ({activation: {mechanism: 'environment' as const, deadlineMs, operatorLabel: null}, code: {}, platform: {}, displays: []});
function session(endpoint: string, deadlineMs?: number) {
  return new CaptureSession({root: path.join(resources.directory, 'captures'), game: 'ets2', captureSessionId: SESSION, retryMs: 20, context: context(deadlineMs), connect: () => new PipeTransport(endpoint, AUTHORITY)});
}

describe('CAP0 capture over an actual Windows named pipe', () => {
  it('captures a synthetic stream end-to-end into an isolated directory', async () => {
    const pipe = await source(async socket => { await send(socket, [header(), envelope(1, 1, {observations: delivered()}), envelope(2, 2, {group: 'lifecycle', id: 'simulation.paused'}), loss(3, 2, 0), end(4, 2)]); });
    sources.push(pipe);
    const capture = session(pipe.endpoint); await capture.start(); const manifest = await capture.done;
    expect(JSON.parse(pipe.hellos[0])).toEqual({format: 'ets2telemetry-cap0', version: {major: 0, minor: 0}, kind: 'hello', captureSessionId: SESSION, data: {evidenceOnly: true}});
    expect(manifest).toMatchObject({status: 'complete', origin: 'synthetic', stop: {reason: 'source-end'}, authority: AUTHORITY, counts: {packetsWritten: 5, envelopesCompleted: 2}});
    const lines = (await readFile(path.join(resources.directory, 'captures', SESSION, 'packets.ndjson'), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(5); expect(lines[1]).toContain('"18446744073709551615"'); expect(lines[1]).toContain('"-9223372036854775808"');
    const receipts = lines.map(line => BigInt((JSON.parse(line) as {receipt: {monotonicNs: string}}).receipt.monotonicNs));
    expect(receipts.every((value, index) => index === 0 || value >= receipts[index - 1])).toBe(true);
  });
  it('closes with partial-completion evidence when the source disconnects mid-envelope', async () => {
    const pipe = await source(async socket => { await send(socket, [header(), envelope(1, 1, {observations: delivered().slice(0, 2), total: 4, final: false})]); socket.destroy(); });
    sources.push(pipe);
    const capture = session(pipe.endpoint); await capture.start(); const manifest = await capture.done;
    expect(manifest).toMatchObject({status: 'partial', stop: {reason: 'disconnect'}, loss: {endMarkerReceived: false, envelopePartial: true}, counts: {packetsWritten: 2}});
  });
  it('closes the capture on a malformed packet without scanning for later frames', async () => {
    const pipe = await source(async socket => { await send(socket, [header()]); socket.write(Uint8Array.from([3, 0, 0, 0, 0x7b, 0x7d, 0x20])); await send(socket, [envelope(1, 1)]); });
    sources.push(pipe);
    const capture = session(pipe.endpoint); await capture.start(); const manifest = await capture.done;
    expect(manifest).toMatchObject({stop: {reason: 'protocol-error'}, status: 'partial', counts: {packetsWritten: 1}});
  });
  it('retries discovery only until the explicit deadline and never invents a source', async () => {
    const capture = session(`\\\\.\\pipe\\ets2telemetry-test-cap0-absent-${randomUUID()}`, 300); await capture.start(); const manifest = await capture.done;
    expect(manifest).toMatchObject({stop: {reason: 'deadline'}, status: 'partial', authority: null, header: null, origin: 'unknown', counts: {packetsReceived: 0}});
  });
  it('closes as service-stop with retained evidence when the service stops first', async () => {
    const pipe = await source(async socket => { await send(socket, [header(), envelope(1, 1)]); });
    sources.push(pipe);
    const capture = session(pipe.endpoint); await capture.start();
    // Stop only once both packets are on disk: the observable write, not a sleep, orders the stop after them.
    const packets = path.join(resources.directory, 'captures', SESSION, 'packets.ndjson');
    await vi.waitFor(async () => expect((await readFile(packets, 'utf8')).match(/\n/g)).toHaveLength(2), {timeout: WRITE_HANG_GUARD_MS, interval: 10});
    const manifest = await capture.stop();
    expect(manifest).toMatchObject({stop: {reason: 'service-stop'}, status: 'partial', counts: {packetsWritten: 2}, loss: {endMarkerReceived: false}});
    expect(await capture.done).toEqual(manifest);
  });
});

// Scripted transport: each connect() takes the next behaviour; emits run after listeners attach.
class ScriptedTransport extends EventEmitter implements CaptureTransport {
  readonly completion = Promise.resolve(); destroyed = 0; credits = 0; hellos = 0;
  constructor(script: (t: ScriptedTransport) => void) { super(); setTimeout(() => script(this), 0); }
  sendHello(): void { this.hellos++; } credit(): void { this.credits++; } destroy(): void { this.destroyed++; }
}
function scripted(steps: ((t: ScriptedTransport) => void)[], options: Partial<ConstructorParameters<typeof CaptureSession>[0]> = {}) {
  const transports: ScriptedTransport[] = [];
  const capture = new CaptureSession({root: path.join(resources.directory, 'captures'), game: 'ets2', captureSessionId: SESSION, retryMs: 5, context: context(), ...options,
    connect: () => { const t = new ScriptedTransport(steps[Math.min(transports.length, steps.length - 1)]); transports.push(t); return t; }});
  return {capture, transports};
}
const transient = (message: string) => Object.assign(new Error(message), {transient: true});
const deliver = (t: ScriptedTransport) => { t.emit('authority', AUTHORITY); for (const packet of [header(), envelope(1, 1), end(2, 1)]) t.emit('packet', payload(packet)); };

describe('CAP0 session failure handling', () => {
  it('finishes, tears down the transport and never rejects when the manifest cannot be written', async () => {
    const unhandled: unknown[] = [], listener = (reason: unknown) => unhandled.push(reason); process.on('unhandledRejection', listener);
    try {
      const {capture, transports} = scripted([deliver], {writer: {writeManifest: () => Promise.reject(new Error('manifest write denied'))}});
      await capture.start(); const manifest = await capture.done; await new Promise(resolve => setTimeout(resolve, 20));
      expect(manifest).toMatchObject({status: 'complete', manifestWriteError: 'manifest write denied'});
      expect(transports[0].destroyed).toBeGreaterThan(0); expect(unhandled).toEqual([]);
      expect(await capture.stop()).toEqual(manifest);
    } finally { process.off('unhandledRejection', listener); }
  });
  it('retries transient pre-authority failures with bounded backoff and keeps one grant', async () => {
    const {capture, transports} = scripted([t => t.emit('error', transient('Capture authority deadline exceeded')), t => t.emit('error', transient('Capture broker exited before or during capture')), deliver]);
    await capture.start(); const manifest = await capture.done;
    expect(transports).toHaveLength(3); expect(manifest).toMatchObject({status: 'complete', stop: {reason: 'source-end'}, authority: AUTHORITY});
    expect(transports[2].hellos).toBe(1); expect(transports[2].credits).toBe(2); // No credit after the end marker closes the capture.
  });
  it('reserves authority-rejected for an explicitly invalid receipt or protocol use', async () => {
    const {capture, transports} = scripted([t => t.emit('error', Object.assign(new Error('Capture relay protocol rejected'), {transient: false}))]);
    await capture.start(); const manifest = await capture.done;
    expect(transports).toHaveLength(1); expect(manifest).toMatchObject({stop: {reason: 'authority-rejected', detail: 'Capture relay protocol rejected'}, authority: null});
  });
  it('ends as source-unavailable after the bounded transient window', async () => {
    let clock = 0;
    const {capture, transports} = scripted([t => { clock += 30_000; t.emit('error', transient('Capture broker could not start')); }], {now: () => clock});
    await capture.start(); const manifest = await capture.done;
    expect(manifest?.stop.reason).toBe('source-unavailable'); expect(manifest?.stop.detail).toMatch(/^3 transient pre-authority failures/); expect(transports).toHaveLength(3);
  });
  it('restarts the transient window after discovery progress', async () => {
    let clock = 0;
    const {capture, transports} = scripted([
      t => t.emit('error', transient('Capture authority deadline exceeded')),
      t => t.emit('waiting'),
      t => { clock += 70_000; t.emit('error', transient('Capture authority deadline exceeded')); },
      deliver], {now: () => clock});
    await capture.start(); const manifest = await capture.done;
    expect(transports).toHaveLength(4); expect(manifest).toMatchObject({status: 'complete', stop: {reason: 'source-end'}});
  });
  it('cancels a pending transient retry when the service stops', async () => {
    // Controlled timers: the retry schedule is observed exactly instead of sleeping past it.
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
    try {
      const {capture, transports} = scripted([t => t.emit('error', transient('Capture authority deadline exceeded'))], {transientWindowMs: 60_000});
      await capture.start();
      // The scripted transport emits on a zero-delay timer, which fake timers run 1 ms later.
      await vi.advanceTimersByTimeAsync(1); expect(transports).toHaveLength(1);
      // The first transient failure scheduled a retry 250 ms later: it ran and failed again, which scheduled the next
      // retry 500 ms after that, so it is still pending 300 ms in.
      await vi.advanceTimersByTimeAsync(300); expect(transports).toHaveLength(2);
      // Pending now: the collection deadline and that retry.
      expect(vi.getTimerCount()).toBe(2);
      const manifest = await capture.stop();
      expect(manifest).toMatchObject({stop: {reason: 'no-source'}});
      // The stop cancelled the retry and the deadline, and no attempt follows within the whole transient window.
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(transports).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});

// Credit-honouring broker over a modelled plugin evidence queue: the broker relays one packet per
// credit, and envelopes produced while it is not reading wait in a bounded queue whose newest entries
// are dropped with exact counters, as in the native EvidenceQueue.
class QueueingTransport extends EventEmitter implements CaptureTransport {
  readonly completion = Promise.resolve(); credits = 0; delivered = 0; destroyed = 0;
  private outstanding = false; private scheduled = false; private ending = false; private packetSeq = 0;
  private attempted = 0; private dropped = 0; private lastSent = 0; private queue: number[] = [];
  constructor(private readonly capacity: number) { super(); setTimeout(() => this.emit('authority', AUTHORITY), 0); }
  get creditOutstanding(): boolean { return this.outstanding; }
  get droppedEnvelopes(): number { return this.dropped; }
  sendHello(): void { this.outstanding = true; this.schedule(); }
  credit(): void { if (this.outstanding) throw new Error('duplicate credit'); this.outstanding = true; this.credits++; this.schedule(); }
  destroy(): void { this.destroyed++; }
  produce(): void { this.attempted++; if (this.queue.length < this.capacity) this.queue.push(this.attempted); else this.dropped++; this.schedule(); }
  finish(): void { this.ending = true; this.schedule(); }
  /** Models the plugin's write deadline closing a capture whose reader stopped. */
  disconnect(): void { this.emit('end'); }
  private schedule(): void { if (!this.scheduled) { this.scheduled = true; setImmediate(() => { this.scheduled = false; this.pump(); }); } }
  private send(packet: unknown): void { this.outstanding = false; this.packetSeq++; this.emit('packet', payload(packet)); }
  private pump(): void {
    if (!this.outstanding) return;
    if (this.packetSeq === 0) { this.send(header(0)); return; }
    const seq = this.queue.shift();
    if (seq !== undefined) {
      const observations = Array.from({length: 10}, (_, i) => observation(i, `text${i}`, 'string', 'x'.repeat(1000)));
      this.send(envelope(this.packetSeq, seq, {droppedBefore: seq - this.lastSent - 1, observations})); this.lastSent = seq; this.delivered++; return;
    }
    if (this.ending) { this.ending = false; this.send(loss(this.packetSeq, this.attempted, this.dropped)); this.outstanding = true; this.send(end(this.packetSeq, this.attempted, this.dropped)); }
  }
}
function stallableFile() {
  let stalled = true, release!: () => void, gate = new Promise<void>(resolve => { release = resolve; });
  const file = {write: async (buffer: Buffer, offset = 0, length = buffer.length - offset) => { while (stalled) await gate; return {bytesWritten: length, buffer}; }, sync: async () => {}, close: async () => {}};
  return {open: () => Promise.resolve(file as never), stall: () => { stalled = true; gate = new Promise<void>(resolve => { release = resolve; }); }, resume: () => { stalled = false; release(); }};
}
const tick = () => new Promise(resolve => setImmediate(resolve));
describe('CAP0 session flow control', () => {
  // 200,000 pending bytes leave room for one maximum line only while about 134 KB are pending.
  const limits = {pendingBytes: 200_000};
  it('withholds the broker credit during a writer stall, resumes after flushing and never reaches the pending cap', async () => {
    const file = stallableFile(); let transport!: QueueingTransport;
    const capture = new CaptureSession({root: path.join(resources.directory, 'captures'), game: 'ets2', captureSessionId: SESSION, retryMs: 5, context: context(),
      writer: {open: file.open, limits}, connect: () => transport = new QueueingTransport(8)});
    await capture.start(); await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 40; i++) { transport.produce(); await tick(); await tick(); }
    // Stalled: the writer stopped crediting before its cap, so later envelopes stayed in or were dropped by the plugin queue.
    expect(transport.creditOutstanding).toBe(false); expect(transport.delivered).toBeGreaterThan(5); expect(transport.delivered).toBeLessThan(20);
    expect(transport.droppedEnvelopes).toBeGreaterThan(0);
    const deliveredWhileStalled = transport.delivered;
    for (let i = 0; i < 5; i++) await tick();
    expect(transport.delivered).toBe(deliveredWhileStalled);
    file.resume(); for (let i = 0; i < 10; i++) { transport.produce(); await tick(); await tick(); }
    transport.finish(); const manifest = await capture.done;
    expect(manifest).toMatchObject({status: 'complete', stop: {reason: 'source-end'}, counts: {packetsDiscarded: 0, envelopesCompleted: 50 - transport.droppedEnvelopes},
      flowControl: {withheldAtClose: false}, loss: {endMarkerReceived: true, pluginLoss: {droppedEnvelopes: String(transport.droppedEnvelopes)}}});
    expect(manifest!.flowControl.creditsWithheld).toBeGreaterThan(0);
    expect(manifest!.loss.knownBoundaries.length).toBeGreaterThan(0);
    expect(manifest!.loss.knownBoundaries.reduce((sum, b) => sum + Number(b.droppedBefore), 0)).toBe(transport.droppedEnvelopes);
  });
  it('records a credit still withheld when the source closes during a persistent stall', async () => {
    const file = stallableFile(); let transport!: QueueingTransport; let clock = 0;
    const capture = new CaptureSession({root: path.join(resources.directory, 'captures'), game: 'ets2', captureSessionId: SESSION, retryMs: 5, context: context(), now: () => clock += 5,
      writer: {open: file.open, limits}, connect: () => transport = new QueueingTransport(8)});
    await capture.start(); await new Promise(resolve => setTimeout(resolve, 10));
    for (let i = 0; i < 30; i++) { transport.produce(); await tick(); await tick(); }
    expect(transport.creditOutstanding).toBe(false);
    transport.disconnect(); const pending = capture.done; file.resume(); const manifest = await pending;
    expect(manifest).toMatchObject({status: 'partial', stop: {reason: 'disconnect'}, counts: {packetsDiscarded: 0}, flowControl: {creditsWithheld: 1, withheldAtClose: true}});
    expect(manifest!.flowControl.withheldMs).toBeGreaterThan(0);
  });
});
