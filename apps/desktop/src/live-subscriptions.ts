import type {LiveTelemetry} from '../../../packages/contracts/src';

export interface LivePort {
  postMessage(data: unknown): void;
  on(event: 'message', listener: (event: {data: unknown}) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}
/** One outstanding delivery and one replaceable update per authorized subscription. */
export class LiveSubscriptions {
  private readonly clients = new Map<LivePort, {inFlight?: number; latest?: LiveTelemetry; timer?: ReturnType<typeof setTimeout>}>();
  private serial = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastSend = -Infinity;
  constructor(private current: LiveTelemetry, private readonly limit = 2, private readonly ackTimeoutMs = 5000, private readonly maxDeliveries = Number.MAX_SAFE_INTEGER) {}
  attach(port: LivePort): boolean {
    if (this.clients.size >= this.limit || this.clients.has(port)) {port.close(); return false;}
    this.clients.set(port, {});
    port.on('close', () => this.remove(port));
    port.on('message', event => {
      const client = this.clients.get(port);
      const data = event.data as {type?: unknown; delivery?: unknown} | null;
      if (!client || !data || typeof data !== 'object' || Object.keys(data).length !== 2 || data.type !== 'consumed' || data.delivery !== client.inFlight) {this.remove(port); return;}
      clearTimeout(client.timer); client.timer = undefined; client.inFlight = undefined;
      if (client.latest) this.schedule();
    });
    port.start(); this.send(port, this.current); return true;
  }
  publish(update: LiveTelemetry): void {
    this.current = update;
    for (const client of this.clients.values()) client.latest = update;
    this.schedule();
  }
  remove(port: LivePort): void {
    const client = this.clients.get(port); if (!client) return;
    clearTimeout(client.timer); this.clients.delete(port); port.close();
    if (!this.clients.size) {clearTimeout(this.flushTimer); this.flushTimer = undefined;}
  }
  close(): void {for (const port of this.clients.keys()) this.remove(port); clearTimeout(this.flushTimer); this.flushTimer = undefined;}
  get size(): number {return this.clients.size;}
  private send(port: LivePort, update: LiveTelemetry): void {
    const client = this.clients.get(port); if (!client) return;
    if (this.serial >= this.maxDeliveries) {this.close(); return;}
    client.inFlight = ++this.serial;
    this.lastSend = performance.now();
    client.timer = setTimeout(() => this.remove(port), this.ackTimeoutMs);
    try {port.postMessage({type: 'live', delivery: client.inFlight, update});} catch {this.remove(port);}
  }
  private schedule(): void {
    if (this.flushTimer || !this.clients.size) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const [port, client] of this.clients) {
        if (client.inFlight !== undefined || !client.latest) continue;
        const update = client.latest; client.latest = undefined; this.send(port, update);
      }
    }, Math.max(0, 50 - (performance.now() - this.lastSend)));
  }
}
