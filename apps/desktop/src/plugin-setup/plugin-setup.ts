import path from 'node:path';
import type {PluginBlockReason as ContractBlockReason, PluginDiscoveryOutcome, PluginFileView, PluginFolderChoice, PluginGame, PluginManualFolderState,
  PluginSetupView, PluginTargetState, PluginTargetView} from '../../../../packages/contracts/src';
import type {DiagnosticFacts} from '../diagnostics';
import {dataPaths} from '../paths';
import {pluginTargetId} from '../plugin-setup-contract';
import {validateManualFolder} from './game-folder';
import {blockingProcess, checkRunningGames, type RunningGames} from './game-processes';
import {confineToRoot, testRootRegistryDirectory, testRootSteam, type PluginSetupDecision} from './mode';
import {pluginBundleDirectory, readPluginBundle, type LoadedPluginBundle, type PluginBundleResult} from './plugin-bundle';
import {nodeInstallerFs, PluginInstaller, type InstallerFileSystem, type PluginActionResult, type PluginTarget, type RunningCheck} from './plugin-installer';
import {failureFor, PluginRegistry, type PluginBlockReason} from './plugin-registry';
import {canonicalDirectory, discoverSteamGames, isInsideOrEqual, PLUGIN_GAMES, validateGameLayout, type SteamDiscovery, type SteamRootResult} from './steam-discovery';
import {readSteamRoot} from './steam-registry';

// Silent plugin setup in main (ET-017 P13, P14; docs/plugin-setup.md, "Setup run"). It combines discovery (PR-2), the
// install registry and the installer (PR-3), the exclusions and manual folders stored in the registry, and builds the
// per-game view the dashboard receives in AppState.plugins. Every file and child-process call is asynchronous; the
// launch run starts 2 s after Electron is ready on an unreferenced timer and is never awaited by startup. Runs are
// single-flight with one coalesced follow-up and each is aborted after 30 s. While a folder waits for a game or the
// TruckersMP client to close, or for a locked file, the running games are polled every 15 s. The exit's `begin` aborts
// the run, and `idle` returns the run in flight, which ends with the removal of its temporary file, so the exit's
// existing 1000 ms idle budget covers it. The disabled mode does nothing at all.

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The installer's block reasons and the AppState contract's must stay the same set. */
const BLOCK_REASONS_MATCH: Same<PluginBlockReason, ContractBlockReason> = true;
void BLOCK_REASONS_MATCH;

/** Delay of the launch run after Electron is ready (P13). */
export const LAUNCH_DELAY_MS = 2000;
/** Each run is aborted after this long (P13). */
export const RUN_TIMEOUT_MS = 30_000;
/** Interval of the running-game poll while a folder waits (P13). */
export const POLL_INTERVAL_MS = 15_000;
/** Most game folders listed per game (P16): Steam folders in library order, then the chosen folder, which keeps its place. */
export const MAX_TARGETS_PER_GAME = 4;
/** Consecutive automatic retries of a TARGET_LOCKED folder while the running games stay the same. */
export const MAX_LOCKED_RETRIES = 3;
/** Block reasons that keep the 15 s poll running. */
const POLL_REASONS: readonly PluginBlockReason[] = ['GAME_RUNNING', 'CLIENT_RUNNING', 'TARGET_LOCKED'];
const PREFIX_LENGTH = 12;

type Log = (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;

/** The production operations a setup run uses; tests replace them with fakes confined to a temporary root. */
export interface PluginSetupPorts {
  /** Game folder file operations. The test-root mode confines them to its root. */
  fs: InstallerFileSystem;
  /** Reads and verifies the bundle; called until it succeeds once, then never again. */
  readBundle(signal: AbortSignal): Promise<PluginBundleResult>;
  /** Loads the install registry from a folder; loading never writes. */
  loadRegistry(directory: string | undefined): Promise<PluginRegistry>;
  /** The Steam registry reader of the active mode; the test-root mode never calls it. */
  readSteamRoot(signal?: AbortSignal): Promise<SteamRootResult>;
  /** The running-game check before every change and for the poll. */
  checkRunning: RunningCheck;
  /** `%LOCALAPPDATA%\ETS2Telemetry\plugins` in the active mode. */
  registryDirectory: string | undefined;
  /** `%LOCALAPPDATA%\ETS2Telemetry`; a chosen folder inside it is refused. */
  dataRoot: string | undefined;
  /** The application's install folder; a chosen folder inside it is refused. */
  installDirectory: string | undefined;
  /** 16 lowercase hex digits for a temporary file name; the installer's default when absent. */
  randomHex?: () => string;
}

export interface PluginSetupOptions {
  decision: PluginSetupDecision;
  log: Log;
  /** Called whenever the view changes; main pushes AppState. */
  changed: () => void;
  /** Required unless the mode is disabled. */
  ports?: PluginSetupPorts;
}

/** A refused plugin setup request; main turns it into a rejection with a fixed message. Never carries a path. */
export class PluginSetupError extends Error {
  constructor(readonly code: 'REGISTRY_UNAVAILABLE' | 'SETUP_CLOSED') {
    super(code === 'SETUP_CLOSED' ? 'Plugin setup has stopped' : 'Plugin setup could not be saved');
    this.name = 'PluginSetupError';
  }
}

interface TargetState extends PluginTargetView {readonly game: PluginGame; readonly root: string}
interface GameState {excluded: boolean; discovery: PluginDiscoveryOutcome; manualFolder: PluginManualFolderState; targets: TargetState[]}
type TriggerReason = 'launch' | 'poll' | 'retry' | 'folder' | 'exclusion';

const emptyGame = (): GameState => ({excluded: false, discovery: 'pending', manualFolder: 'none', targets: []});
const fileView = (sha256: string, version: string | null): PluginFileView => ({version, sha256Prefix: sha256.slice(0, PREFIX_LENGTH)});
const sameRunning = (left: RunningGames, right: RunningGames) => left.ets2 === right.ets2 && left.ats === right.ats && left.client === right.client;
const unref = (timer: ReturnType<typeof setTimeout>) => {(timer as {unref?: () => void}).unref?.(); return timer;};

export class PluginSetup {
  private readonly decision: PluginSetupDecision;
  private readonly log: Log;
  private readonly changed: () => void;
  private readonly ports: PluginSetupPorts | undefined;
  private readonly fs: InstallerFileSystem | undefined;
  private readonly games: Record<PluginGame, GameState> = {ets2: emptyGame(), ats: emptyGame()};
  private registry: PluginRegistry | undefined;
  private registryLoading: Promise<PluginRegistry> | undefined;
  private bundle: LoadedPluginBundle | undefined;
  private discovery: SteamDiscovery | undefined;
  private current: Promise<void> | undefined;
  private followUp: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private pollController: AbortController | undefined;
  private launchTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private closed = false;
  private inRun = false;
  /** The running games the last successful check of the current run saw, and those of the last finished run. */
  private seenRunning: RunningGames | undefined;
  private runRunning: RunningGames | undefined;
  private lockedRetries = 0;
  private escapes = 0;
  /** The last facts of each on-change log line, by key. */
  private readonly logged = new Map<string, string>();
  private lastView = '';

  constructor(options: PluginSetupOptions) {
    this.decision = options.decision;
    this.log = options.log;
    this.changed = options.changed;
    if (options.decision.mode !== 'disabled') {
      if (!options.ports) throw new Error('Plugin setup needs its ports outside the disabled mode');
      this.ports = options.ports;
      this.fs = options.decision.mode === 'test-root' ? confineToRoot(options.ports.fs, options.decision.root, () => {this.escapes++;}) : options.ports.fs;
    }
    if (options.decision.mode === 'disabled' && options.decision.rejected) this.log('PLUGIN_SETUP_MODE_REJECTED', undefined, {reason: options.decision.rejected});
    this.log('PLUGIN_SETUP_MODE', undefined, {mode: options.decision.mode, reason: options.decision.mode === 'disabled' ? options.decision.reason : null});
    this.lastView = JSON.stringify(this.view());
  }

  get mode(): PluginSetupDecision['mode'] {return this.decision.mode;}

  /** The current view: fixed codes, versions and hash prefixes; never a path. */
  view(): PluginSetupView {
    const game = (state: GameState) => ({excluded: state.excluded, discovery: state.discovery, manualFolder: state.manualFolder,
      targets: state.targets.map(target => ({id: target.id, source: target.source, ordinal: target.ordinal, state: target.state, reason: target.reason,
        installed: target.installed ? {...target.installed} : null, lastFailure: target.lastFailure}))});
    return {mode: this.decision.mode, bundled: this.bundle ? fileView(this.bundle.sha256, this.bundle.appVersion) : null, running: this.inRun,
      games: {ets2: game(this.games.ets2), ats: game(this.games.ats)}};
  }

  /** Schedules the launch run 2 s from now on an unreferenced timer. Startup never awaits it; disabled does nothing. */
  start(): void {
    if (this.decision.mode === 'disabled' || this.closed || this.started) return;
    this.started = true;
    this.launchTimer = unref(setTimeout(() => {this.launchTimer = undefined; void this.trigger('launch');}, LAUNCH_DELAY_MS));
  }

  /** Runs setup now and resolves with the view after that run (or after the run it was coalesced into). */
  async retry(): Promise<PluginSetupView> {
    if (this.decision.mode === 'disabled') return this.view();
    if (this.closed) throw new PluginSetupError('SETUP_CLOSED');
    await this.trigger('retry');
    return this.view();
  }

  /** Stores the exclusion of a game durably, then runs setup; resolves with the view after that run. */
  async setExcluded(game: PluginGame, excluded: boolean): Promise<PluginSetupView> {
    if (this.decision.mode === 'disabled') return this.view();
    if (this.closed) throw new PluginSetupError('SETUP_CLOSED');
    const registry = await this.ensureRegistry();
    if (registry.document.games[game].excluded !== excluded) {
      if (!registry.writable) throw new PluginSetupError('REGISTRY_UNAVAILABLE');
      try {
        await registry.update(document => ({...document, games: {...document.games, [game]: {...document.games[game], excluded}}}));
      } catch {throw new PluginSetupError('REGISTRY_UNAVAILABLE');}
    }
    this.games[game].excluded = excluded;
    this.publish();
    await this.trigger('exclusion');
    return this.view();
  }

  /**
   * Validates a folder main's dialog returned and stores it as the game's manual folder, replacing an earlier one (whose
   * install record stays). Setup then runs without being awaited. Main calls this only for a confirmed selection.
   */
  async chooseFolder(game: PluginGame, selected: string): Promise<PluginFolderChoice> {
    if (this.decision.mode === 'disabled') return {outcome: 'refused', code: 'SETUP_DISABLED'};
    if (this.closed) throw new PluginSetupError('SETUP_CLOSED');
    if (this.decision.mode === 'test-root' && !(typeof selected === 'string' && isInsideOrEqual(selected, this.decision.root))) {
      this.escapes++;
      this.flushEscapes();
      return {outcome: 'refused', code: 'FOLDER_UNSUPPORTED_PATH'};
    }
    const registry = await this.ensureRegistry();
    if (!registry.writable) return {outcome: 'refused', code: 'REGISTRY_UNAVAILABLE'};
    const result = await validateManualFolder(selected, game, this.folderContext(game));
    this.flushEscapes();
    if (!result.ok) return {outcome: 'refused', code: result.code};
    try {
      await registry.update(document => ({...document, games: {...document.games, [game]: {...document.games[game], manualRoot: result.root}}}));
    } catch {return {outcome: 'refused', code: 'REGISTRY_UNAVAILABLE'};}
    this.games[game].manualFolder = 'set';
    this.publish();
    void this.trigger('folder');
    return {outcome: 'chosen'};
  }

  /** The verified bundled DLL, for "Show plugin file"; main never sends it to a renderer. */
  bundledFile(): string | undefined {return this.bundle?.file;}

  /**
   * The folder "Open game plugins folder" opens for a listed target: its plugins folder when that is a plain folder,
   * otherwise its `bin\win_x64` folder. Undefined for an unknown target or a folder that is linked or no longer a game.
   */
  async folderToOpen(targetId: string): Promise<string | undefined> {
    if (this.decision.mode === 'disabled' || this.closed || !this.fs) return undefined;
    const target = PLUGIN_GAMES.flatMap(game => this.games[game].targets).find(candidate => candidate.id === targetId);
    if (!target) return undefined;
    const layout = await validateGameLayout(this.fs, target.root, target.game);
    this.flushEscapes();
    if (layout.status === 'not-game' || layout.status === 'linked') return undefined;
    return layout.status === 'ready' && layout.pluginsExists ? layout.pluginsDirectory : path.win32.dirname(layout.pluginsDirectory);
  }

  /** The exit's `begin`: no further run, poll or trigger; the run in flight stops after its current folder. */
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.launchTimer); this.launchTimer = undefined;
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    this.pollController?.abort();
    this.controller?.abort();
  }

  /** The exit's `idle`: the run in flight, which ends with the removal of its temporary file; undefined when idle. */
  idle(): Promise<void> | undefined {
    return this.current?.then(() => undefined, () => undefined);
  }

  /** Single-flight: a trigger during a run queues one follow-up run, shared by every further trigger meanwhile. */
  private trigger(reason: TriggerReason): Promise<void> {
    if (this.closed || this.decision.mode === 'disabled') return Promise.resolve();
    if (reason !== 'poll') this.lockedRetries = 0;
    if (!this.current) {
      const run = this.current = this.execute().finally(() => {if (this.current === run) this.current = undefined;});
      return run;
    }
    return this.followUp ??= this.current.then(() => {this.followUp = undefined; return this.trigger(reason);});
  }

  private async execute(): Promise<void> {
    const controller = this.controller = new AbortController();
    const timer = unref(setTimeout(() => {
      this.log('PLUGIN_SETUP_TIMEOUT', undefined, {timeoutMs: RUN_TIMEOUT_MS});
      controller.abort();
    }, RUN_TIMEOUT_MS));
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    this.inRun = true; this.seenRunning = undefined;
    this.publish();
    try {await this.runSteps(controller.signal);} catch (error) {
      // A run that throws outside the per-folder handling (for example while loading the registry) keeps the earlier view.
      if (!controller.signal.aborted) this.logOnChange('run', 'PLUGIN_SETUP_RUN_ERROR', {error: error instanceof Error ? error.name : 'unknown'});
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
      this.runRunning = this.seenRunning;
      this.inRun = false;
      this.flushEscapes();
      this.publish();
      this.schedulePoll();
    }
  }

  private async runSteps(signal: AbortSignal): Promise<void> {
    const ports = this.ports!, fs = this.fs!;
    const registry = await this.ensureRegistry();
    for (const game of PLUGIN_GAMES) this.games[game].excluded = registry.document.games[game].excluded;
    if (!this.bundle) {
      const result = await ports.readBundle(signal);
      if (result.ok) this.bundle = result.bundle;
      this.logOnChange('bundle', 'PLUGIN_BUNDLE', result.ok ? {state: 'verified'} : {state: 'unavailable', failure: result.failure});
    }
    if (signal.aborted) return;
    const installer = this.bundle ? new PluginInstaller(this.bundle, {fs, registry, checkRunning: this.check, log: this.log, signal,
      ...(ports.randomHex ? {randomHex: ports.randomHex} : {})}) : undefined;
    if (installer) {
      // A recovery reason is information: intents that stay are recovered by a later run or by their own folder's change.
      const recovery = await installer.recover();
      // Logged when intents stay, and once more when they are all resolved.
      if (recovery.remaining || this.logged.has('recovery')) this.logOnChange('recovery', 'PLUGIN_RECOVERY_PENDING', {remaining: recovery.remaining, reason: recovery.reason});
    }
    if (signal.aborted) return;
    const discovery = this.discovery = await discoverSteamGames({steamRoot: this.steamRoot, fs, signal, log: this.log});
    this.logOnChange('discovery', 'PLUGIN_DISCOVERY', discovery.facts);
    for (const game of PLUGIN_GAMES) await this.collectTargets(game, discovery, registry);
    this.publish();
    for (const game of PLUGIN_GAMES) {
      for (const target of this.games[game].targets) {
        if (signal.aborted) return;
        await this.act(installer, registry, target, signal);
      }
    }
  }

  /** The game's folders for this run: Steam roots in library order and the chosen folder, at most four. */
  private async collectTargets(game: PluginGame, discovery: SteamDiscovery, registry: PluginRegistry): Promise<void> {
    const state = this.games[game], found = discovery.games[game];
    state.discovery = found.outcome;
    const manualRoot = registry.document.games[game].manualRoot;
    let manual: string | undefined;
    if (manualRoot === null) state.manualFolder = 'none';
    else {
      // Validated again on every run: a folder that moved, became linked or is now a Steam root is not changed.
      const result = await validateManualFolder(manualRoot, game, this.folderContext(game));
      state.manualFolder = result.ok ? 'set' : 'invalid';
      if (result.ok) manual = result.root;
    }
    const steam = found.roots.slice(0, manual ? MAX_TARGETS_PER_GAME - 1 : MAX_TARGETS_PER_GAME);
    const next: {source: 'steam' | 'manual'; ordinal: number; root: string}[] = [
      ...steam.map((root, ordinal) => ({source: 'steam' as const, ordinal, root: root.root})),
      ...(manual ? [{source: 'manual' as const, ordinal: 0, root: manual}] : [])
    ];
    const previous = state.targets;
    state.targets = next.map(entry => {
      const id = pluginTargetId(game, entry.source, entry.ordinal);
      const kept = previous.find(target => target.id === id && target.root.toLowerCase() === entry.root.toLowerCase());
      // A folder seen for the first time is `working` until its first result.
      return kept ?? {id, game, source: entry.source, ordinal: entry.ordinal, root: entry.root, state: 'working', reason: null, installed: null,
        lastFailure: failureFor(registry.document, game, entry.root)?.code ?? null};
    });
    for (const target of previous) if (!state.targets.some(other => other.id === target.id)) this.logged.delete(`action:${target.id}`);
  }

  /** Installs into or removes from one folder and records its new view. */
  private async act(installer: PluginInstaller | undefined, registry: PluginRegistry, target: TargetState, signal: AbortSignal): Promise<void> {
    const excluded = this.games[target.game].excluded;
    const plugin: PluginTarget = {game: target.game, source: target.source, root: target.root};
    let next: Pick<PluginTargetView, 'state' | 'reason' | 'installed'>;
    if (!installer) next = {state: 'blocked', reason: 'BUNDLE_UNAVAILABLE', installed: null};
    else {
      let result: PluginActionResult;
      try {result = excluded ? await installer.remove(plugin) : await installer.ensureInstalled(plugin);} catch (error) {
        result = {op: excluded ? 'remove' : 'install', outcome: 'blocked', reason: 'IO_ERROR', step: null, errno: error instanceof Error ? error.name : null, loadsAfterRestart: false};
      }
      this.logOnChange(`action:${target.id}`, 'PLUGIN_ACTION', {game: target.game, source: target.source, ordinal: target.ordinal, op: result.op,
        outcome: result.outcome, code: result.reason, step: result.step, errno: result.errno});
      next = await this.describe(installer, plugin, excluded, result, signal);
    }
    this.replace(target, {...next, lastFailure: failureFor(registry.document, target.game, target.root)?.code ?? null});
    this.publish();
  }

  /**
   * The view of a folder after an operation. A success is `installed` (or `excluded` after a removal). A blocked change
   * is described from what the folder holds now: an older plugin of this application is `outdated`, no plugin is
   * `missing` (`excluded` for an excluded game), and anything this application cannot change is `blocked`; `reason`
   * says why the change did not happen.
   */
  private async describe(installer: PluginInstaller, target: PluginTarget, excluded: boolean, result: PluginActionResult, signal: AbortSignal): Promise<Pick<PluginTargetView, 'state' | 'reason' | 'installed'>> {
    const bundle = this.bundle!;
    if (result.outcome === 'removed' || result.outcome === 'absent') return {state: 'excluded', reason: null, installed: null};
    if (result.outcome !== 'blocked') return {state: 'installed', reason: null, installed: fileView(bundle.sha256, bundle.appVersion)};
    if (signal.aborted) return {state: 'blocked', reason: result.reason, installed: null};
    let found: Awaited<ReturnType<PluginInstaller['inspect']>>;
    try {found = await installer.inspect(target);} catch {found = {state: 'blocked', reason: 'IO_ERROR', step: 'classify', errno: null};}
    if (found.state === 'missing') return {state: excluded ? 'excluded' : 'missing', reason: result.reason, installed: null};
    if (found.state === 'blocked') return {state: 'blocked', reason: result.reason, installed: null};
    const state: PluginTargetState = excluded ? 'blocked' : found.current ? 'installed' : 'outdated';
    return {state, reason: result.reason, installed: fileView(found.sha256, found.version)};
  }

  private replace(target: TargetState, next: Pick<PluginTargetView, 'state' | 'reason' | 'installed' | 'lastFailure'>): void {
    const state = this.games[target.game];
    state.targets = state.targets.map(other => other.id === target.id && other.root === target.root ? {...other, ...next} : other);
  }

  private folderContext(game: PluginGame) {
    const ports = this.ports!;
    // In the test-root mode the protected data folder is the root's own; the real one lies outside the root.
    const testRoot = this.decision.mode === 'test-root' ? this.decision.root : undefined;
    return {fs: this.fs!, dataRoot: testRoot ? path.win32.dirname(testRootRegistryDirectory(testRoot)) : ports.dataRoot,
      installDirectory: testRoot ? undefined : ports.installDirectory, steamRoots: this.discovery?.games[game].roots.map(root => root.root) ?? []};
  }

  /** The Steam root: `<root>\Steam` in the test-root mode, without any registry read; the registry reader otherwise. */
  private readonly steamRoot = async (signal?: AbortSignal): Promise<SteamRootResult> => {
    if (this.decision.mode !== 'test-root') return this.ports!.readSteamRoot(signal);
    const steam = await canonicalDirectory(this.fs!, testRootSteam(this.decision.root));
    return steam ? {kind: 'found', path: steam.path} : {kind: 'not-found'};
  };

  /** The running check the installer uses; it remembers the latest successful listing for the poll. */
  private readonly check: RunningCheck = async signal => {
    const result = await this.ports!.checkRunning(signal);
    if (result.ok) this.seenRunning = result.running;
    return result;
  };

  private ensureRegistry(): Promise<PluginRegistry> {
    if (this.registry && this.registry.state !== 'unreadable') return Promise.resolve(this.registry);
    return this.registryLoading ??= (async () => {
      try {
        const directory = this.decision.mode === 'test-root' ? testRootRegistryDirectory(this.decision.root) : this.ports!.registryDirectory;
        const registry = this.registry = await this.ports!.loadRegistry(directory);
        this.logOnChange('registry', 'PLUGIN_REGISTRY_STATE', {state: registry.state});
        for (const game of PLUGIN_GAMES) this.games[game].excluded = registry.document.games[game].excluded;
        return registry;
      } finally {this.registryLoading = undefined;}
    })();
  }

  /** Polls the running games every 15 s while a folder waits for a game, the TruckersMP client or a locked file. */
  private schedulePoll(): void {
    clearTimeout(this.pollTimer); this.pollTimer = undefined;
    const waiting = PLUGIN_GAMES.some(game => this.games[game].targets.some(target => target.reason !== null && POLL_REASONS.includes(target.reason)));
    if (!waiting) this.lockedRetries = 0;
    if (this.closed || !waiting) return;
    this.pollTimer = unref(setTimeout(() => {this.pollTimer = undefined; void this.poll();}, POLL_INTERVAL_MS));
  }

  private async poll(): Promise<void> {
    if (this.closed || this.current) return;
    const controller = this.pollController = new AbortController();
    let check: Awaited<ReturnType<RunningCheck>>;
    try {check = await this.ports!.checkRunning(controller.signal);} catch {check = {ok: false, code: 'RUNNING_CHECK_FAILED'};}
    if (this.pollController === controller) this.pollController = undefined;
    if (this.closed || this.current) return;
    if (check.ok && this.unblocked(check.running)) void this.trigger('poll');
    else this.schedulePoll();
  }

  /**
   * True when a waiting folder may now succeed: its game or the TruckersMP client is no longer running (or another one
   * started), or, for a locked file, the running games changed since the run, or fewer than three automatic retries
   * have happened while they stayed the same.
   */
  private unblocked(running: RunningGames): boolean {
    let locked = false;
    for (const game of PLUGIN_GAMES) {
      for (const target of this.games[game].targets) {
        if (target.reason === 'GAME_RUNNING' || target.reason === 'CLIENT_RUNNING') {
          if (blockingProcess(game, running) !== target.reason) return true;
        } else if (target.reason === 'TARGET_LOCKED') locked = true;
      }
    }
    if (!locked) return false;
    if (!this.runRunning || !sameRunning(this.runRunning, running)) {this.lockedRetries = 0; return true;}
    if (this.lockedRetries >= MAX_LOCKED_RETRIES) return false;
    this.lockedRetries++;
    return true;
  }

  private flushEscapes(): void {
    if (!this.escapes) return;
    this.log('PLUGIN_TEST_ROOT_ESCAPE', undefined, {count: this.escapes});
    this.escapes = 0;
  }

  /** Logs `event` with `facts` only when they differ from the last line logged under `key`. */
  private logOnChange(key: string, event: string, facts: DiagnosticFacts): void {
    const signature = JSON.stringify([event, facts]);
    if (this.logged.get(key) === signature) return;
    this.logged.set(key, signature);
    this.log(event, undefined, facts);
  }

  private publish(): void {
    const next = JSON.stringify(this.view());
    if (next === this.lastView) return;
    this.lastView = next;
    this.changed();
  }
}

/** The production ports of the active and test-root modes. */
export function productionPluginSetupPorts(options: {mainDirectory: string; resourcesPath: string; packaged: boolean; localAppData: string | undefined;
  installDirectory: string | undefined; log: Log}): PluginSetupPorts {
  const bundleDirectory = pluginBundleDirectory(options.mainDirectory, options.resourcesPath, options.packaged);
  const data = options.localAppData && path.win32.isAbsolute(options.localAppData) ? dataPaths(options.localAppData) : undefined;
  return {
    fs: nodeInstallerFs,
    readBundle: signal => readPluginBundle(bundleDirectory, {signal}),
    loadRegistry: directory => PluginRegistry.load(directory, {log: options.log}),
    readSteamRoot: signal => readSteamRoot({signal}),
    checkRunning: signal => checkRunningGames({signal}),
    registryDirectory: data?.pluginMetadata,
    dataRoot: data?.root,
    installDirectory: options.installDirectory
  };
}
