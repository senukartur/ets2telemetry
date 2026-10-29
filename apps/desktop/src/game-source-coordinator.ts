import type {LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
import type {BrokerConfiguration, BrokerProtocol} from './native-pipe-client';
import {v1BrokerConfiguration} from './native-pipe-client';
import {NativeDiscoveryError, sameTarget, type Game, type GameAvailability, type GameDiscovery, type GameTarget} from './native-game-discovery';
import type {SourceMode} from './source-mode';

/** Sequential discovery snapshots can straddle a restart; neither snapshot has connected-pipe authority. */
class DiscoveryTargetChanged extends Error {}
export interface CoordinatorPorts {
  discover(configuration: BrokerConfiguration, protocol: BrokerProtocol, signal: AbortSignal): Promise<GameDiscovery>;
  /** Retires both sources and resolves after every owned relay closes, without disposing the ingestors. */
  retire(): Promise<void>;
  attach(selection: SourceSelection, target?: GameTarget): void;
  publish(status: LiveTelemetry['status'], reason: string): void;
}
/** One service-owned selection, one discovery child at a time, and one immutable target shared by both protocols. */
export class GameSourceCoordinator {
  private generation = 0;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private work: Promise<void> = Promise.resolve();
  private target?: GameTarget;
  private lost = {v0: false, v1: false};
  private hardFailure = false;
  private stopped = false;
  private mode?: SourceMode;
  private broker?: BrokerConfiguration;
  private attempt = 0;
  constructor(private readonly ports: CoordinatorPorts) {}
  select(mode: SourceMode, broker?: BrokerConfiguration): void {
    if (this.stopped) throw new Error('Coordinator stopped');
    this.invalidate(); this.mode = mode; this.broker = broker; this.attempt = 0;
    const generation = this.generation;
    this.work = this.work.then(async () => {
      await this.ports.retire();
      if (!this.current(generation)) return;
      if (mode.kind === 'blocked') {this.ports.publish('incompatible', mode.reason); return;}
      if (mode.kind === 'fixture') {this.ports.attach(mode.selection); return;}
      if (!broker || !v1BrokerConfiguration(broker)) {this.ports.publish('unavailable', 'Verified native game pipe client is not configured'); return;}
      await this.cycle(generation);
    });
  }
  /** A partial attachment keeps its sibling and retries the same target. Hard failures stay visible. */
  observe(protocol: 'v0' | 'v1', state: {status: string; reason: string}): void {
    if (!this.target || this.stopped) return;
    if (state.status === 'incompatible' || state.status === 'unavailable') {this.hardFailure = true; return;}
    this.lost[protocol] = state.status === 'disconnected' || state.reason === 'No selected game discovery record';
    const terminal = protocol === 'v1' && state.reason.startsWith('Source ended (');
    if (!this.hardFailure && (terminal || this.lost.v0 && this.lost.v1)) this.select(this.mode!, this.broker);
  }
  async stop(): Promise<void> {
    this.stopped = true; this.invalidate(); await this.work; await this.ports.retire();
  }
  private current(generation: number): boolean {return !this.stopped && generation === this.generation;}
  private invalidate(): void {
    ++this.generation; this.abort?.abort(); clearTimeout(this.timer); this.timer = undefined;
    this.target = undefined; this.lost = {v0: false, v1: false}; this.hardFailure = false;
  }
  private async cycle(generation: number): Promise<void> {
    if (!this.current(generation)) return;
    const controller = this.abort = new AbortController();
    try {
      // Sequential scans ensure that only one owned discovery child can exist at any time.
      const v0 = await this.ports.discover(this.broker!, 'v0', controller.signal);
      if (!this.current(generation)) return;
      const v1 = await this.ports.discover(v1BrokerConfiguration(this.broker)!, 'v1', controller.signal);
      if (!this.current(generation)) return;
      const merge = (game: Game): GameAvailability => {
        const left = v0[game], right = v1[game];
        if (left.status === 'ambiguous' || right.status === 'ambiguous') return {status: 'ambiguous'};
        if (left.status === 'unique' && right.status === 'unique' && !sameTarget(left.target, right.target)) throw new DiscoveryTargetChanged();
        return left.status === 'unique' ? left : right;
      };
      const games = this.mode!.selection === 'game' ? ['ets2', 'ats'] as const : [this.mode!.selection as Game];
      const available = games.map(game => merge(game)).filter(entry => entry.status !== 'absent');
      if (available.some(entry => entry.status === 'ambiguous')) {
        this.ports.publish('incompatible', 'Multiple game instances are ambiguous'); this.retry(generation); return;
      }
      if (available.length === 1 && available[0].status === 'unique') {
        this.target = available[0].target; this.ports.attach(this.target.source.game, this.target); return;
      }
      this.ports.publish('waiting', available.length > 1 ? 'Both games are available; choose ETS2 or ATS' : 'Waiting for game');
      this.retry(generation);
    } catch (error) {
      if (!this.current(generation)) return;
      if (error instanceof DiscoveryTargetChanged) {
        this.ports.publish('waiting', 'Game protocol targets changed; retrying discovery'); this.retry(generation);
      } else if (error instanceof NativeDiscoveryError && error.transient) {
        this.ports.publish('waiting', 'Game discovery did not complete; retrying'); this.retry(generation);
      } else this.ports.publish('incompatible', 'Game discovery or protocol target mismatch');
    }
  }
  private retry(generation: number): void {
    this.timer = setTimeout(() => {this.timer = undefined; this.work = this.work.then(() => this.cycle(generation));}, Math.min(250 * 2 ** Math.min(this.attempt++, 4), 4000));
  }
}
