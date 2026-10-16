// The recording runtime of the telemetry service (ET-015a R3, R10, R14; ET-015c G13, G14, G20): the recording plan,
// the history or recording-target database, the trip recorder and the protocol v1 ingestion, wired exactly as the
// service runs them, their three shutdown steps and the recording status they report (ET-015c G3-G5). telemetry-service.ts
// owns the process, the parent port, v0
// ingestion, captures and the storage probe, and uses this module for everything that records. The storage suite drives
// the same wiring in process with the real or the fault storage worker (tests/storage/recording-runtime.test.ts).
// Node-safe: it never loads native SQLite; the database lives in the storage worker that `createWorker` starts. See
// docs/telemetry-service-v1.md#service-wiring.
import type {RecordingHealth, SourceSelection} from '../../../packages/contracts/src';
import type {StorageWorkerHandle} from '../../../packages/storage/src/client';
import type {DiagnosticFacts} from './diagnostics';
import {HistoryStorage, HISTORY_CLOSE_BUDGET_MS, recorderClient, type HistoryStorageOptions} from './history-storage';
import {recordingPlan, type RecordingPlan} from './recording-policy';
import {deriveRecordingStatus, RecordingStatusPublisher, type RecordingStatusTimers} from './recording-status';
import type {ShutdownSequence} from './shutdown-sequence';
import {TripRecorderSink} from './trip-recorder';
import {V1Ingestion, type V1IngestionOptions, type V1SourceState} from './v1-ingestion';

/** Budget of the `v1-ingestion` step in the `intake` shutdown phase. */
export const V1_INTAKE_BUDGET_MS = 1000;
/** Budget of the `recording-flush` step, the only step of the `flush` shutdown phase. */
export const RECORDING_FLUSH_BUDGET_MS = 500;

/** Ingestion options a test may set; the wiring (sources, sink, selections, readiness, diagnostics, state) stays the runtime's. */
export type RecordingIngestionOverrides = Omit<V1IngestionOptions, 'connect' | 'connectGame' | 'broker' | 'sink' | 'durableSelections' | 'durableReady' | 'diagnose' | 'onState'>;

export interface RecordingRuntimeOptions {
  /** The service environment; only ETS2TELEMETRY_RECORDING is read (recording-policy.ts). */
  env: Readonly<Record<string, string | undefined>>;
  /** GAME_HISTORY_RECORDING in production. */
  gameHistory: boolean;
  /** The service's LOCALAPPDATA; the database path is derived from it at start. */
  localAppData: string | undefined;
  /** Fixed codes and numbers only. */
  log: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
  /** Starts the storage worker of the database; the service passes the physical worker beside its bundle. */
  createWorker: () => StorageWorkerHandle;
  /** The native broker in v1 mode for game selections. */
  connectGame?: V1IngestionOptions['connectGame'];
  /** Fixture sockets for synthetic or replay endpoints; `net.connect` when omitted. */
  connect?: V1IngestionOptions['connect'];
  /** Every v1 source state change. */
  onV1State: (state: V1SourceState) => void;
  /** Tests only: bounds, timers and clocks of the ingestion and its pipeline. */
  ingestionOverrides?: RecordingIngestionOverrides;
  /** Tests only: the stamped application version and the close grace of the database. */
  historyOverrides?: Pick<HistoryStorageOptions, 'appVersion' | 'closeGraceMs'>;
  /** ET-015c (G4, G5): every recording status to send to main, from `start()` until `stopStatus()`. */
  onRecordingStatus?: (status: RecordingHealth) => void;
  /** Tests only: the coalescing interval (G5) and timers of the recording status; 250 ms and the system timers by default. */
  statusOverrides?: {intervalMs?: number; timers?: RecordingStatusTimers};
}

export interface RecordingRuntime {
  readonly plan: RecordingPlan;
  readonly v1: V1Ingestion;
  readonly history: HistoryStorage;
  /** Opens the database without waiting for it and sends the first recording status; live telemetry never depends on storage. */
  start(): void;
  /** Registers `v1-ingestion` (intake), `recording-flush` (flush) and `history-storage` (storage). */
  register(shutdown: Pick<ShutdownSequence, 'register'>): void;
  /** ET-015c (G3): the recording status now. */
  recordingStatus(): RecordingHealth;
  /** ET-015c: sends no further recording status; the service calls it when its orderly stop begins. */
  stopStatus(): void;
}

/**
 * Builds the service's recording wiring from its environment (R3). Game selections stay live-only while `gameHistory`
 * is false. Only ETS2TELEMETRY_RECORDING=synthetic:<name>|replay:<name> constructs the trip recorder, over a database in
 * the synthetic directory that replaces history, and makes only the matching selection durable once that database is
 * open (`durableReady`); its open lets a live-only connection made before it reconnect durable (R10, `onOpened`).
 * ET-015c (G3-G5): the database, the ingestion, its pipeline's retry code and the recorder report their changes, and the
 * derived recording status goes to `onRecordingStatus`, coalesced by RecordingStatusPublisher. Without a recorder it is
 * always `disabled`.
 */
export function createRecordingRuntime(options: RecordingRuntimeOptions): RecordingRuntime {
  const {log} = options;
  const plan = recordingPlan(options.env, {gameHistory: options.gameHistory, log: event => log(event)});
  // ET-015c (G5): every input of the recording status reports its changes here.
  const changed = () => status.changed();
  // The recorder reaches storage through the history client, so a command before the open or after a failure answers
  // STORAGE_CLOSED (recorderClient).
  const recorder = plan.durableSelections.length ? new TripRecorderSink(recorderClient({get client() {return history.client;}}), {onChange: changed}) : undefined;
  // The selection that was recording or paused (durable delivery active, fresh v1 data) since it was selected: G3 rule 8.
  let recorded: SourceSelection | undefined;
  const v1 = new V1Ingestion({
    ...(options.connectGame ? {connectGame: options.connectGame} : {}),
    ...(options.connect ? {connect: options.connect} : {}),
    diagnose: (event, facts) => log(event, undefined, facts),
    onState: state => {
      if (recorded !== state.selection) recorded = state.durable.state === 'active' && (state.status === 'connected' || state.status === 'paused') ? state.selection : undefined;
      options.onV1State(state); if (recorder) changed();
    },
    ...(recorder ? {sink: recorder, durableSelections: plan.durableSelections, durableReady: () => history.state === 'open'} : {}),
    ...options.ingestionOverrides
  });
  // The durable history database (ET-013, OD-2), or the recording target that replaces it.
  const history: HistoryStorage = new HistoryStorage({localAppData: options.localAppData, log, createWorker: options.createWorker,
    target: plan.database, ...(recorder ? {onOpened: () => v1.durableAvailabilityChanged(), onStateChange: changed} : {}), ...options.historyOverrides});
  /** G3: the status from the current state of the database, the ingestion, its pipeline and the recorder. */
  const recordingStatus = (): RecordingHealth => {
    if (!recorder) return {state: 'disabled'};
    const current = v1.current, game = current.observation?.source.game;
    return deriveRecordingStatus({recorder: true, target: plan.database.purpose, history: {state: history.state, code: history.failureCode},
      durableSelections: plan.durableSelections, v1: current, retryCode: v1.durableRetryCode ?? null, recorded: recorded === current.selection,
      losses: recorder.losses(), trip: game ? recorder.tripSummary(game) : null});
  };
  const status = new RecordingStatusPublisher(recordingStatus, next => options.onRecordingStatus?.(next), options.statusOverrides);
  return {
    plan, v1, history, recordingStatus,
    start: () => { history.start(); status.start(); },
    stopStatus: () => status.close(),
    register: shutdown => {
      // Ends the v1 source and waits for its broker process; nothing is acknowledged afterwards (R14).
      shutdown.register('intake', {name: 'v1-ingestion', budgetMs: V1_INTAKE_BUDGET_MS, run: () => v1.stopSource()});
      // Drops queued durable work and waits for the one storage command in flight before the database closes (R14); then,
      // unless durable delivery failed, writes the pending one-second samples (ET-015b, H11).
      shutdown.register('flush', {name: 'recording-flush', budgetMs: RECORDING_FLUSH_BUDGET_MS, run: () => v1.flush()});
      shutdown.register('storage', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => history.close()});
    }
  };
}
