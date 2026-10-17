// Main's side of the journal queries (ET-016, J4, J10, J11). Main sends each journal read to the current telemetry service
// on its parent port as {type: 'journal', id, query} and waits for {type: 'journal', id, result}. One request is in
// flight per service and at most JOURNAL_QUEUE_LIMIT wait behind it (BUSY beyond that); each has JOURNAL_REQUEST_DEADLINE_MS
// from the moment it is sent (TIMEOUT). Only the current service's reply to the request in flight is accepted; it is
// checked strictly against the request (journal-contract.ts) and an invalid one is answered FAILED and never forwarded.
// When the service fails, exits, restarts or the application exits, every pending request resolves SERVICE_UNAVAILABLE
// and the retired service's late replies are ignored. Fixed codes and counts only in the log. See docs/journal.md.
import type {JournalCallResult} from '../../../packages/contracts/src';
import type {DiagnosticFacts} from './diagnostics';
import {parseJournalReply, refusal, type JournalQuery} from './journal-contract';

/** Requests waiting behind the one in flight; one more is answered BUSY at once (J4). */
export const JOURNAL_QUEUE_LIMIT = 4;
/** Deadline of one request after it was sent to the service (J4). Longer than the storage client's 10 s command deadline. */
export const JOURNAL_REQUEST_DEADLINE_MS = 15_000;

/** The service process as the broker sees it: Electron's UtilityProcess provides postMessage. */
export interface JournalServiceChannel {postMessage(message: unknown): void}
export interface JournalBrokerOptions {
  /** Fixed codes and facts only. */
  log: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
  /** Tests only; the system timers by default. */
  timers?: {setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void};
}
interface Request {query: JournalQuery; resolve: (result: JournalCallResult<unknown>) => void}
interface InFlight extends Request {id: number; service: JournalServiceChannel; timer: unknown}

const systemTimers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class JournalBroker {
  #service: JournalServiceChannel | undefined;
  #inFlight: InFlight | undefined;
  readonly #queue: Request[] = [];
  #nextId = 1;
  readonly #counts = new Map<string, number>();
  readonly #timers: NonNullable<JournalBrokerOptions['timers']>;

  constructor(private readonly options: JournalBrokerOptions) {
    this.#timers = options.timers ?? systemTimers;
  }

  /** The ready service that answers journal requests from now on. A previous one is retired first. */
  attach(service: JournalServiceChannel): void {
    if (this.#service === service) return;
    this.retire();
    this.#service = service;
  }

  /**
   * Retires the current service (failure, exit, restart, restart exhaustion or application exit): the request in
   * flight and every queued one resolve SERVICE_UNAVAILABLE, later requests too until a service is attached, and replies
   * of the retired service are ignored. Repeated calls change nothing.
   */
  retire(): void {
    this.#service = undefined;
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    if (inFlight) { this.#timers.clearTimeout(inFlight.timer); inFlight.resolve(refusal('SERVICE_UNAVAILABLE')); }
    for (const request of this.#queue.splice(0)) request.resolve(refusal('SERVICE_UNAVAILABLE'));
  }

  /** Sends one journal read to the current service, or queues it behind the one in flight. Never rejects. */
  request(query: JournalQuery): Promise<JournalCallResult<unknown>> {
    if (!this.#service) return Promise.resolve(refusal('SERVICE_UNAVAILABLE'));
    if (this.#inFlight && this.#queue.length >= JOURNAL_QUEUE_LIMIT) { this.#count('JOURNAL_REQUEST_BUSY'); return Promise.resolve(refusal('BUSY')); }
    return new Promise(resolve => { this.#queue.push({query, resolve}); this.#pump(); });
  }

  /**
   * A `{type: 'journal'}` message of a service. Accepted only from the current service, as exactly {type, id, result}
   * for the request in flight; anything else is ignored and counted (JOURNAL_REPLY_IGNORED). An accepted reply that does
   * not answer the request exactly resolves it FAILED (JOURNAL_REPLY_REJECTED); it is never forwarded.
   */
  reply(service: JournalServiceChannel, message: Record<string, unknown>): void {
    const inFlight = this.#inFlight;
    const keys = Object.keys(message);
    if (!inFlight || service !== this.#service || inFlight.service !== service || keys.length !== 3 || !Object.hasOwn(message, 'result') || message.id !== inFlight.id) {
      this.#count('JOURNAL_REPLY_IGNORED');
      return;
    }
    this.#timers.clearTimeout(inFlight.timer);
    this.#inFlight = undefined;
    const result = parseJournalReply(inFlight.query, message.result);
    if (!result) this.#count('JOURNAL_REPLY_REJECTED', {kind: inFlight.query.kind});
    inFlight.resolve(result ?? refusal('FAILED'));
    this.#pump();
  }

  #pump(): void {
    const service = this.#service;
    if (this.#inFlight || !service) return;
    const next = this.#queue.shift();
    if (!next) return;
    if (!Number.isSafeInteger(this.#nextId)) { next.resolve(refusal('FAILED')); this.#pump(); return; }
    const id = this.#nextId++;
    const inFlight: InFlight = {...next, id, service, timer: undefined};
    inFlight.timer = this.#timers.setTimeout(() => {
      if (this.#inFlight !== inFlight) return;
      // The service may still answer; its late reply has another id than the request in flight and is ignored.
      this.#inFlight = undefined;
      this.#count('JOURNAL_REQUEST_TIMEOUT', {kind: inFlight.query.kind});
      inFlight.resolve(refusal('TIMEOUT'));
      this.#pump();
    }, JOURNAL_REQUEST_DEADLINE_MS);
    this.#inFlight = inFlight;
    try { service.postMessage({type: 'journal', id, query: inFlight.query}); }
    catch {
      // A closed service channel: the supervisor retires the service separately; this request cannot be answered.
      this.#timers.clearTimeout(inFlight.timer);
      this.#inFlight = undefined;
      inFlight.resolve(refusal('SERVICE_UNAVAILABLE'));
      this.#pump();
    }
  }

  /** Logs `event` with its running count at counts 1, 2, 4, 8, ..., so a repeating fault cannot fill the bounded log. */
  #count(event: string, facts: DiagnosticFacts = {}): void {
    const count = (this.#counts.get(event) ?? 0) + 1;
    this.#counts.set(event, count);
    if ((count & (count - 1)) === 0) this.options.log(event, undefined, {...facts, count});
  }
}
