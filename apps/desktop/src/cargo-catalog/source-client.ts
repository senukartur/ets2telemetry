import {randomUUID} from 'node:crypto';
import {isCargoId, type CargoClassification} from '../../../../packages/contracts/src/cargo-classification';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import type {CargoOpening} from '../../../../packages/storage/src/api';
import type {GameProcess} from '../hard-mode/reader';
import {isCargoLookupReply, type CargoLookupRequest} from './service-contract';

const MAX_ACTIVE_LOOKUPS = 8;
const MAX_CACHED_CARGO = 32;
const LOOKUP_TIMEOUT_MS = 20_000;
const CACHED_LOOKUP_MS = 2_000;

export interface CargoLookup {
  opening: CargoOpening;
  result: Promise<CargoClassification | null>;
  current(): boolean;
}

interface Active {key: string; generation: string; controller: AbortController}
interface Pending {
  source: Active;
  accept(value: CargoClassification | null): void;
}
interface Entry {value: CargoClassification | null; result: Promise<CargoClassification | null>; expires: number}

/** A bounded utility-process client. A retired source cannot publish a ready value or complete a pending opening. */
export class CargoSourceClient {
  private active?: Active;
  private readonly waiting = new Map<string, Pending>();
  private readonly results = new Map<string, Entry>();

  constructor(private readonly send: (value: CargoLookupRequest) => void,
    private readonly keyFor: (source: SourceIdentity) => string | undefined,
    private readonly inspect: (source: SourceIdentity, signal: AbortSignal) => Promise<GameProcess | null>) {}

  retire() {
    this.active?.controller.abort();
    this.active = undefined;
    for (const pending of this.waiting.values()) pending.accept(null);
    this.waiting.clear();
    this.results.clear();
  }

  lookup(source: SourceIdentity, cargoId: string): CargoLookup | undefined {
    const key = source.origin === 'game' && this.keyFor(source);
    if (!key || !isCargoId(cargoId)) return;
    if (this.active?.key !== key) {
      this.retire();
      this.active = {key, generation: randomUUID(), controller: new AbortController()};
    }
    const active = this.active;
    const current = () => this.active === active && this.keyFor(source) === key;
    let cached = this.results.get(cargoId);
    if (cached && cached.expires <= performance.now()) {
      this.results.delete(cargoId);
      cached = undefined;
    }
    if (!cached) {
      if (this.waiting.size >= MAX_ACTIVE_LOOKUPS) return;
      if (this.results.size >= MAX_CACHED_CARGO) {
        const complete = [...this.results].find(([, value]) => Number.isFinite(value.expires));
        if (!complete) return;
        this.results.delete(complete[0]);
      }
      const entry: Entry = {value: null, result: Promise.resolve(null), expires: Infinity};
      entry.result = this.query(active, source, cargoId).then(value => {
        if (!current()) return null;
        entry.value = value;
        // The main process rechecks the installation fingerprint for a new request.
        entry.expires = performance.now() + CACHED_LOOKUP_MS;
        return value;
      });
      this.results.set(cargoId, cached = entry);
    }
    return {opening: {cargoId, generation: active.generation, classification: cached.value}, result: cached.result, current};
  }

  receive(value: unknown) {
    if (!isCargoLookupReply(value)) return;
    const pending = this.waiting.get(value.request);
    if (pending && this.active === pending.source && value.generation === pending.source.generation) pending.accept(value.classification);
  }

  private query(active: Active, source: SourceIdentity, cargoId: string): Promise<CargoClassification | null> {
    const request = randomUUID();
    return new Promise(resolve => {
      const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(LOOKUP_TIMEOUT_MS)]);
      const settle = (value: CargoClassification | null) => {
        this.waiting.delete(request);
        signal.removeEventListener('abort', cancel);
        resolve(value);
      };
      const cancel = () => settle(null);
      this.waiting.set(request, {source: active, accept: settle});
      signal.addEventListener('abort', cancel, {once: true});
      void Promise.resolve().then(() => signal.aborted ? null : this.inspect(source, signal)).then(result => {
        if (!result || signal.aborted || this.active !== active || this.keyFor(source) !== active.key) {settle(null); return;}
        this.send({type: 'cargo:lookup', generation: active.generation, request, game: source.game, executable: result.executable, cargoId});
      }).catch(cancel);
    });
  }
}
