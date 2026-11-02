import type {LiveTelemetry} from '../../../packages/contracts/src';

export interface LivePort {
  postMessage(data: unknown): void;
  on(event: 'message', listener: (event: {data: unknown}) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  start(): void;
  close(): void;
}
export type LiveRemovalOrigin = 'ack-deadline'|'malformed-credit'|'mismatched-credit'|'peer-close'|'send-failure'|'owner-retirement'|'delivery-exhaustion';
export interface LiveSubscriptionSnapshot {
  subscribed: boolean; ackTimeoutMs:number; publications: number; attempted: number; sent: number; credited: number; queued: number; replaced: number;
  inFlight: boolean; pending: boolean; sentPublication: number|null; creditedPublication: number|null; pendingPublication: number|null;
  ageMs: number|null; inFlightMs: number|null;
}
export type LiveSubscriptionDiagnostic = LiveSubscriptionSnapshot & {stage:'queued'|'sent'|'credited'|'removed';origin?:LiveRemovalOrigin};
const increment=(value:number)=>Math.min(Number.MAX_SAFE_INTEGER,value+1);
const elapsed=(since:number)=>Math.min(Number.MAX_SAFE_INTEGER,Math.max(0,Math.floor(performance.now()-since)));
/** One outstanding delivery and one replaceable update per authorized subscription. */
export class LiveSubscriptions<T = LiveTelemetry> {
  private readonly clients = new Map<LivePort, {inFlight?: number; latest?: T; timer?: ReturnType<typeof setTimeout>;removing?:boolean;
    attachedAt:number;sentAt?:number;attempted:number;sent:number;credited:number;queued:number;replaced:number;sentPublication?:number;creditedPublication?:number;pendingPublication?:number}>();
  private publications=0;
  private serial = 0;
  private flushTimer?: ReturnType<typeof setTimeout>;
  private lastSend = -Infinity;
  constructor(private current: T, private readonly limit = 2, private readonly ackTimeoutMs = 5000, private readonly maxDeliveries = Number.MAX_SAFE_INTEGER,
    private readonly diagnose?: (event:LiveSubscriptionDiagnostic)=>void) {}
  attach(port: LivePort): boolean {
    if (this.clients.size >= this.limit || this.clients.has(port)) {port.close(); return false;}
    this.clients.set(port, {attachedAt:performance.now(),attempted:0,sent:0,credited:0,queued:0,replaced:0});
    port.on('close', () => this.remove(port,'peer-close'));
    port.on('message', event => {
      const client = this.clients.get(port);
      const data = event.data as {type?: unknown; delivery?: unknown} | null;
      if (!client || !data || typeof data !== 'object' || Object.keys(data).length !== 2 || data.type !== 'consumed') {this.remove(port,'malformed-credit'); return;}
      if(data.delivery!==client.inFlight){this.remove(port,'mismatched-credit');return;}
      clearTimeout(client.timer); client.timer = undefined; client.inFlight = undefined;
      client.credited=increment(client.credited);client.creditedPublication=client.sentPublication;this.observe(port,'credited');
      if (client.latest) this.schedule();
    });
    port.start(); this.send(port, this.current); return true;
  }
  publish(update: T): void {
    this.current = update;this.publications=increment(this.publications);
    for (const [port,client] of this.clients) {
      const pending=client.latest!==undefined;client.latest=update;client.pendingPublication=this.publications;client.queued=increment(client.queued);
      if(pending)client.replaced=increment(client.replaced);else this.observe(port,'queued');
    }
    this.schedule();
  }
  remove(port: LivePort,origin:LiveRemovalOrigin='owner-retirement'): void {
    const client = this.clients.get(port); if (!client || client.removing) return;
    client.removing=true;this.observe(port,'removed',origin);
    clearTimeout(client.timer); this.clients.delete(port); port.close();
    if (!this.clients.size) {clearTimeout(this.flushTimer); this.flushTimer = undefined;}
  }
  close(origin:LiveRemovalOrigin='owner-retirement'): void {for (const port of this.clients.keys()) this.remove(port,origin); clearTimeout(this.flushTimer); this.flushTimer = undefined;}
  get size(): number {return this.clients.size;}
  /** Internal observations contain no update payload or port identity and never query native objects. */
  snapshot(port?:LivePort):LiveSubscriptionSnapshot {
    const client=port?this.clients.get(port):undefined;
    return {subscribed:!!client,ackTimeoutMs:this.ackTimeoutMs,publications:this.publications,attempted:client?.attempted??0,sent:client?.sent??0,credited:client?.credited??0,queued:client?.queued??0,replaced:client?.replaced??0,
      inFlight:client?.inFlight!==undefined,pending:client?.latest!==undefined,sentPublication:client?.sentPublication??null,creditedPublication:client?.creditedPublication??null,pendingPublication:client?.pendingPublication??null,
      ageMs:client?elapsed(client.attachedAt):null,inFlightMs:client?.inFlight!==undefined && client.sentAt!==undefined?elapsed(client.sentAt):null};
  }
  private observe(port:LivePort,stage:LiveSubscriptionDiagnostic['stage'],origin?:LiveRemovalOrigin):void {
    if(!this.diagnose)return;
    try{this.diagnose({...this.snapshot(port),stage,...(origin?{origin}:{})});}catch{/* Diagnostics cannot change delivery, retirement or the original error. */}
  }
  private send(port: LivePort, update: T, publication=this.publications): void {
    const client = this.clients.get(port); if (!client) return;
    if (this.serial >= this.maxDeliveries) {this.close('delivery-exhaustion'); return;}
    client.inFlight = ++this.serial;
    this.lastSend = performance.now();
    client.sentAt=this.lastSend;client.sentPublication=publication;client.attempted=increment(client.attempted);
    client.timer = setTimeout(() => this.remove(port,'ack-deadline'), this.ackTimeoutMs);
    try {port.postMessage({type: 'live', delivery: client.inFlight, update});client.sent=increment(client.sent);this.observe(port,'sent');} catch {this.remove(port,'send-failure');}
  }
  private schedule(): void {
    if (this.flushTimer || !this.clients.size) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      for (const [port, client] of this.clients) {
        if (client.inFlight !== undefined || !client.latest) continue;
        const update = client.latest,publication=client.pendingPublication; client.latest = undefined;client.pendingPublication=undefined;this.send(port, update,publication);
      }
    }, Math.max(0, 50 - (performance.now() - this.lastSend)));
  }
}
