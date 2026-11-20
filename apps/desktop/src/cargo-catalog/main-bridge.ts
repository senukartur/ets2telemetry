import type {CargoClassification} from '../../../../packages/contracts/src/cargo-classification';
import {CargoArchiveCache} from './archive-cache';
import {isCargoLookupRequest, type CargoLookupReply, type CargoLookupRequest} from './service-contract';

type ResolveInstallation = (game: CargoLookupRequest['game'], executable: string, signal: AbortSignal) => Promise<string | undefined>;
const MAX_REQUESTS = 8;

/** Only the current telemetry utility child can call this bridge. */
export class CargoMainBridge {
  private active?: {generation: string; controller: AbortController};
  private readonly pending = new Set<string>();

  constructor(private readonly cache: CargoArchiveCache, private readonly resolve: ResolveInstallation,
    private readonly send: (message: CargoLookupReply) => void, private readonly admitted: (game: CargoLookupRequest['game']) => boolean) {}

  retire() {
    this.active?.controller.abort();
    this.active = undefined;
  }

  receive(value: unknown): void {
    if (!isCargoLookupRequest(value) || !this.admitted(value.game) || this.pending.has(value.request) || this.pending.size >= MAX_REQUESTS) return;
    if (this.active?.generation !== value.generation) {
      this.retire();
      this.active = {generation: value.generation, controller: new AbortController()};
    }
    const active = this.active;
    this.pending.add(value.request);
    const signal = AbortSignal.any([active.controller.signal, AbortSignal.timeout(18_000)]);
    void this.lookup(value, signal).then(classification => {
      if (!active.controller.signal.aborted && this.active === active && this.admitted(value.game)) {
        this.send({type: 'cargo:result', generation: value.generation, request: value.request, classification});
      }
    }).catch(() => undefined).finally(() => this.pending.delete(value.request));
  }

  private async lookup(request: CargoLookupRequest, signal: AbortSignal): Promise<CargoClassification | null> {
    try {
      const root = await this.resolve(request.game, request.executable, signal);
      if (!root || signal.aborted) return null;
      const classification = await this.cache.lookup(root, request.cargoId, signal);
      if (classification && await this.resolve(request.game, request.executable, signal) !== root) return null;
      return signal.aborted ? null : classification;
    } catch {return null;}
  }
}
