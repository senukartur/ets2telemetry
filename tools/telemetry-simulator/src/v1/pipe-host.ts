// The named-pipe host shared by the lockstep (pipe.ts) and reactive (reactive.ts) v1 simulator servers (ET-005b): the
// synthetic endpoint name, accepted connections with their unread bytes and pending writes, and bounded waits.
//
// Node is only a synthetic test server: it has no protected DACL, no peer authentication and no discovery record or
// service policy. Native endpoint security belongs to ET-004b and is not evidenced here.
import net, {type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';

export const TEST_PIPE_PREFIX_V1 = '\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-';
/** The only endpoints the simulator serves or connects to: `\\.\pipe\ETS2Telemetry-SYNTHETIC-TEST-v1-{pid}-{uuid}`. */
export const TEST_PIPE_PATTERN_V1 = /^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Liveness bound for a cooperative client's scripted reply, connection or close; only a broken client reaches it. */
export const REPLY_DEADLINE_MS = 5_000;
// Client bytes not consumed yet; a client never has more than a few frames in flight.
const MAX_INBOUND_BYTES = 65_536;

export class Cancelled extends Error {}
export function bounded(value: number | undefined, fallback: number, min: number, max: number, name: string, integer = true): number {
  const v = value ?? fallback;
  if (!Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) throw new Error(`Invalid ${name}`);
  return v;
}

/** One accepted pipe connection, its unread client bytes and its pending writes. */
export class Link {
  inbound = Buffer.alloc(0); ended = false; closed = false; pendingWrites = 0; writeError?: Error; overflow = false;
  /** Set by a consumer of the bytes; the link then hands each read to it instead of buffering. */
  onData?: (chunk: Buffer) => void;
  constructor(readonly socket: Socket, changed: () => void) {
    socket.on('data', (chunk: Buffer) => {
      if (this.onData) this.onData(chunk);
      else {
        this.inbound = Buffer.concat([this.inbound, chunk]);
        if (this.inbound.length > MAX_INBOUND_BYTES) { this.overflow = true; socket.pause(); }
      }
      changed();
    });
    socket.on('end', () => { this.ended = true; changed(); });
    socket.on('close', () => { this.closed = true; changed(); });
    // A departed client is observed through close and failed writes.
    socket.on('error', () => undefined);
  }
  get gone(): boolean { return this.ended || this.closed; }
  write(bytes: Uint8Array, changed: () => void): void {
    this.pendingWrites++;
    this.socket.write(bytes, error => { this.pendingWrites--; if (error) this.writeError ??= error; changed(); });
  }
}

/** The endpoint, its links and the waits every server uses. */
export abstract class PipeHost {
  readonly endpoint = TEST_PIPE_PREFIX_V1 + String(process.pid) + '-' + randomUUID();
  protected readonly server = net.createServer(socket => this.arrived(socket));
  protected readonly links = new Set<Link>();
  private readonly listeners = new Set<() => void>();
  protected stopError?: Error; protected stopping = false; protected failure?: Error;
  async listen(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('The v1 pipe simulator requires actual Windows named pipes');
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.endpoint, () => { this.server.removeListener('error', reject); resolve(); }); });
    this.server.on('error', error => { this.failure ??= error; this.changed(); });
  }
  protected changed(): void { for (const check of [...this.listeners]) check(); }
  private arrived(socket: Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    const link = new Link(socket, () => this.changed()); this.links.add(link);
    this.connection(link); this.changed();
  }
  /** A new client connection. */
  protected abstract connection(link: Link): void;
  /**
   * Resolves true once `ready` holds, or false when `ms` have passed on `performance.now()`, the clock callers measure
   * with. A deadline is judged only after one more I/O poll (setImmediate after the timer), so a completion that was
   * already queued when a starved process woke still counts; a timer that fires early is re-armed for the remainder.
   */
  protected wait(ready: () => boolean, ms: number, abortable = true): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const deadline = performance.now() + ms;
      let timer: NodeJS.Timeout | undefined;
      const finish = (f: () => void) => { clearTimeout(timer); this.listeners.delete(check); f(); };
      const check = () => {
        if (abortable && this.stopError) finish(() => reject(this.stopError!));
        else if (this.failure) finish(() => reject(this.failure!));
        else if (ready()) finish(() => resolve(true));
      };
      const arm = (delay: number) => {
        timer = setTimeout(() => setImmediate(() => {
          if (!this.listeners.has(check)) return;
          check(); if (!this.listeners.has(check)) return;
          const left = deadline - performance.now();
          if (left > 0) arm(left); else finish(() => resolve(false));
        }), Math.max(0, Math.ceil(delay)));
      };
      this.listeners.add(check); arm(ms); check();
    });
  }
  protected async teardown(): Promise<void> {
    this.stopping = true;
    for (const l of this.links) l.socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  stop(): void { this.stopError ??= new Cancelled('Simulator pipe cancelled'); this.changed(); }
}
