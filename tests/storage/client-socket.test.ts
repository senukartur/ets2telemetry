// The recording harness's ClientSocket (tests/storage/recording-helpers.ts) on a fake pipe socket: the bytes and socket
// events it passes on are the original ones, each exactly once and in their order, with and without a gate. It lives
// in the storage suite because the harness module requires the storage test bundles.
import {EventEmitter} from 'node:events';
import type net from 'node:net';
import {describe, expect, it} from 'vitest';
import {encodeFrame} from '../../packages/contracts/src/protocol-v1';
import {v1, withEventSeq} from './helpers';
import {ClientSocket, type StreamGate} from './recording-helpers';

const welcome = Buffer.from(encodeFrame(v1('welcome'))), checkpoint = Buffer.from(encodeFrame(v1('checkpoint')));
const event1 = Buffer.from(encodeFrame(withEventSeq('event-simulation-started', 1n))), event2 = Buffer.from(encodeFrame(withEventSeq('event-simulation-started', 2n)));

/** A fake pipe socket, the ClientSocket over it, and what the ClientSocket passed on: the data bytes and the event order. */
function harness(gate?: StreamGate) {
  const real = Object.assign(new EventEmitter(), {write: () => true, destroy: () => undefined}), failures: unknown[] = [];
  const socket = new ClientSocket(real as unknown as net.Socket, gate, error => failures.push(error));
  const chunks: Buffer[] = [], events: string[] = [];
  socket.on('data', (chunk: Buffer) => { chunks.push(chunk); events.push('data'); });
  for (const event of ['end', 'error', 'close']) socket.on(event, () => events.push(event));
  return {real, failures, events, bytes: () => Buffer.concat(chunks), collapsed: () => events.filter((e, i) => e !== 'data' || events[i - 1] !== 'data')};
}

describe('recording harness ClientSocket', () => {
  it('passes chunks on unchanged without a gate', () => {
    const h = harness(), first = Buffer.concat([welcome, checkpoint.subarray(0, 7)]), second = checkpoint.subarray(7);
    h.real.emit('data', first); h.real.emit('data', second); h.real.emit('end'); h.real.emit('close', false);
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint]))).toBe(true);
    expect(h.events).toEqual(['data', 'data', 'end', 'close']);
  });

  it('holds everything after the gate event until the gate opens, then passes every byte on exactly once', async () => {
    let open!: () => void;
    const h = harness({afterEventSeq: '1', until: () => new Promise<void>(r => { open = r; })});
    // The gate frame starts in one chunk and ends in the next, which also carries the start of a later frame.
    h.real.emit('data', Buffer.concat([welcome, checkpoint, event1.subarray(0, 5)]));
    h.real.emit('data', Buffer.concat([event1.subarray(5), event2.subarray(0, 3)]));
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1]))).toBe(true);
    h.real.emit('data', event2.subarray(3)); h.real.emit('end'); h.real.emit('close', false);
    // Nothing after the gate frame, not even the end or close, passes before the gate opens.
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1]))).toBe(true);
    expect(h.collapsed()).toEqual(['data']);
    open(); await Promise.resolve(); await Promise.resolve();
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1, event2]))).toBe(true);
    expect(h.collapsed()).toEqual(['data', 'end', 'close']);
    expect(h.failures).toEqual([]);
  });

  it('with `beforeEventSeq`, holds the gate event itself and everything after it until the gate opens', async () => {
    let open!: () => void;
    const h = harness({beforeEventSeq: '2', until: () => new Promise<void>(r => { open = r; })});
    // The gate frame starts in the same chunk as the frames before it and completes in the next; the end follows while
    // the gate is closed.
    h.real.emit('data', Buffer.concat([welcome, checkpoint, event1, event2.subarray(0, 6)]));
    h.real.emit('data', event2.subarray(6)); h.real.emit('end');
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1]))).toBe(true);
    expect(h.collapsed()).toEqual(['data']);
    open(); await Promise.resolve(); await Promise.resolve();
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1, event2]))).toBe(true);
    expect([h.collapsed(), h.failures]).toEqual([['data', 'end'], []]);
  });

  it('with `redelivered`, holds only after a redelivery of the gate event, not after its first delivery (ET-015c)', async () => {
    const redelivered = (eventSeq: bigint) => {
      const m = withEventSeq('event-simulation-started', eventSeq) as Extract<ReturnType<typeof v1>, {kind: 'event'}>; m.data.redelivered = true;
      return Buffer.from(encodeFrame(m));
    };
    let open!: () => void, opened = 0;
    const h = harness({afterEventSeq: '1', redelivered: true, until: () => { opened++; return new Promise<void>(r => { open = r; }); }});
    h.real.emit('data', Buffer.concat([welcome, checkpoint, event1, event2]));
    expect([opened, h.bytes().equals(Buffer.concat([welcome, checkpoint, event1, event2]))]).toEqual([0, true]);
    const again1 = redelivered(1n), again2 = redelivered(2n);
    h.real.emit('data', Buffer.concat([again1, again2])); h.real.emit('end');
    expect([opened, h.bytes().equals(Buffer.concat([welcome, checkpoint, event1, event2, again1]))]).toEqual([1, true]);
    open(); await Promise.resolve(); await Promise.resolve();
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint, event1, event2, again1, again2]))).toBe(true);
    expect([h.collapsed(), h.failures]).toEqual([['data', 'end'], []]);
  });

  it('passes on an incomplete frame held before the gate event ahead of an error and close', () => {
    const h = harness({afterEventSeq: '1', until: () => new Promise(() => undefined)});
    h.real.emit('data', Buffer.concat([welcome, checkpoint.subarray(0, 9)]));
    h.real.emit('error', new Error('pipe failed')); h.real.emit('close', true);
    expect(h.bytes().equals(Buffer.concat([welcome, checkpoint.subarray(0, 9)]))).toBe(true);
    expect(h.collapsed()).toEqual(['data', 'error', 'close']);
  });
});
