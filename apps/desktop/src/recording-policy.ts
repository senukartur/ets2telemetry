// The recording gate of the telemetry service (ET-015a, R3). It decides which database the service opens and which
// source selections may request durable protocol v1 delivery. Since the owner's explicit authorization of October 25,
// 2026 (DECISION-LOG.md, "Game history recording enablement") the ETS2 and ATS selections record real history over
// durable protocol v1. ETS2TELEMETRY_RECORDING can only redirect the service to a synthetic or replay database in the
// synthetic directory; it can never select the history path or make a game source durable.
// See docs/telemetry-service-v1.md#recording-gate.
import type {SourceSelection} from '../../../packages/contracts/src';

/**
 * Whether game selections (ETS2, ATS) record real history. The explicit `boolean` annotation keeps the type checker
 * and lint from treating the branches that read it as constant. A unit test is a tripwire on its value.
 */
export const GAME_HISTORY_RECORDING: boolean = true;
/** The environment variable that selects a synthetic or replay recording target: `synthetic:<name>` or `replay:<name>`. */
export const RECORDING_TARGET_VARIABLE = 'ETS2TELEMETRY_RECORDING';
/** The name of a synthetic or replay database file without its `.sqlite` extension; no separator, dot or capital. */
export const RECORDING_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
const TARGET_PATTERN = /^(synthetic|replay):([a-z0-9-]{1,64})$/;

/**
 * The database the service opens: the production history database, or a named synthetic or replay database at
 * `%LOCALAPPDATA%\ETS2Telemetry\synthetic\<name>.sqlite`, whose purpose accepts only that origin.
 */
export type RecordingDatabase = {purpose: 'history'} | {purpose: 'synthetic' | 'replay'; name: string};
export interface RecordingPlan {
  database: RecordingDatabase;
  /** The selections whose v1 connections may request durable delivery; empty means no sink is constructed. */
  durableSelections: readonly SourceSelection[];
}
export interface RecordingPlanOptions {
  /** GAME_HISTORY_RECORDING in production; injectable so tests can check the enabled branch. */
  gameHistory: boolean;
  /** Fixed codes only; receives RECORDING_TARGET_REJECTED for an invalid variable. */
  log?: (event: string) => void;
}

/**
 * Builds the service's recording plan from its environment.
 *
 * - Unset (or empty): the history database. Game selections are durable only when `gameHistory` is true.
 * - `synthetic:<name>` or `replay:<name>`, name `[a-z0-9-]{1,64}`: that database **instead of** history, and only the
 *   matching selection is durable. Game selections stay live-only whatever `gameHistory` says, because the database's
 *   purpose refuses their origin.
 * - Anything else: RECORDING_TARGET_REJECTED is logged once and the default applies.
 */
export function recordingPlan(env: Readonly<Record<string, string | undefined>>, options: RecordingPlanOptions): RecordingPlan {
  const history: RecordingPlan = {database: {purpose: 'history'}, durableSelections: options.gameHistory ? ['ets2', 'ats'] : []};
  const value = env[RECORDING_TARGET_VARIABLE];
  if (value === undefined || value === '') return history;
  const match = TARGET_PATTERN.exec(value);
  if (!match) { options.log?.('RECORDING_TARGET_REJECTED'); return history; }
  const purpose = match[1] as 'synthetic' | 'replay';
  return {database: {purpose, name: match[2]}, durableSelections: [purpose]};
}
