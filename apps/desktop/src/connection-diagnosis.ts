// Why the dashboard has no game connection (ET-017 P17): one pure classification over the plugin setup view, the live
// status and selection and the application health. The Game plugin card shows its fixed text, and the diagnostic bundle
// records it. Renderer-safe: type imports only. See docs/plugin-setup.md#connection-diagnosis.
import type {AppHealth, LiveTelemetry, PluginBlockReason, PluginGame, PluginSetupView, PluginTargetView, SourceSelection} from '../../../packages/contracts/src';

/**
 * The diagnosis codes in precedence order (P17): the first that applies wins. The rows below CONNECTED explain why a
 * selected game is not connected.
 */
export const CONNECTION_DIAGNOSIS_CODES = Object.freeze([
  'SERVICE_UNAVAILABLE', 'CONNECTED', 'NO_GAME_SELECTED', 'SETUP_DISABLED', 'GAME_NOT_FOUND', 'PLUGIN_BLOCKED_PERMISSION', 'PLUGIN_UNRECOGNIZED',
  'PLUGIN_OUTDATED', 'PLUGIN_PENDING_GAME_CLOSE', 'PLUGIN_MISSING', 'TRANSPORT_FAILED', 'NO_RUNNING_SOURCE'
] as const);
export type ConnectionDiagnosisCode = typeof CONNECTION_DIAGNOSIS_CODES[number];
/** A note beside CONNECTED: a game folder of the selected game still holds an older plugin of this application. */
export type ConnectionDiagnosisNote = 'PLUGIN_OUTDATED_ON_DISK';
export interface ConnectionDiagnosis {
  code: ConnectionDiagnosisCode;
  notes: readonly ConnectionDiagnosisNote[];
}

/** Block reasons that need Windows permissions the application does not have (P12): the manual copy helps. */
const PERMISSION_REASONS: readonly PluginBlockReason[] = ['PERMISSION_DENIED', 'READ_ONLY_FILE'];
/** Block reasons that end when the game, TruckersMP or the program that holds the file closes. */
const WAITING_REASONS: readonly PluginBlockReason[] = ['GAME_RUNNING', 'CLIENT_RUNNING', 'TARGET_LOCKED'];
/** Target states without this application's current plugin in place. */
const MISSING_STATES: readonly PluginTargetView['state'][] = ['missing', 'excluded', 'blocked'];

/** The games a selection connects to; the "Select a game" placeholder and the fixtures connect to none. */
function selectedGames(selection: SourceSelection): readonly PluginGame[] {
  return selection === 'ets2' || selection === 'ats' ? [selection] : [];
}

/**
 * Classifies the connection (P17). Mapping onto the current types:
 * - SERVICE_UNAVAILABLE: the service health is not `ready`, or the live status is `service-failed` or `restarting`.
 * - CONNECTED: the live status is `connected` or `paused`, for any selection.
 * - NO_GAME_SELECTED: the selection is the `game` placeholder, `synthetic` or `replay`.
 * - SETUP_DISABLED: plugin setup is `disabled` in this launch, so no game folder was checked.
 * - GAME_NOT_FOUND: the selected game's discovery finished and listed no game folder.
 * - Rows 6-10 look at the selected game's listed folders; one folder in that condition is enough:
 *   PLUGIN_BLOCKED_PERMISSION (`PERMISSION_DENIED`, `READ_ONLY_FILE`), PLUGIN_UNRECOGNIZED (`UNRECOGNIZED_FILE`),
 *   PLUGIN_OUTDATED (state `outdated`, from the file's hash on disk), PLUGIN_PENDING_GAME_CLOSE (`GAME_RUNNING`,
 *   `CLIENT_RUNNING`, `TARGET_LOCKED`) and PLUGIN_MISSING (state `missing`, `excluded` or `blocked` for any other reason,
 *   which includes an excluded game).
 * - TRANSPORT_FAILED: the live status is `incompatible` or `unavailable`.
 * - NO_RUNNING_SOURCE: anything else (`waiting`, `stale`, `disconnected`), with the plugin in place.
 * A pending discovery without folders and folders that are `working` or `installed` fall through to the transport rows.
 */
export function connectionDiagnosis(plugins: PluginSetupView, status: LiveTelemetry['status'], selection: SourceSelection, health: AppHealth): ConnectionDiagnosis {
  const games = selectedGames(selection);
  const targets = games.flatMap(game => plugins.games[game].targets);
  const result = (code: ConnectionDiagnosisCode, notes: readonly ConnectionDiagnosisNote[] = []): ConnectionDiagnosis => ({code, notes});
  if (health.service !== 'ready' || status === 'service-failed' || status === 'restarting') return result('SERVICE_UNAVAILABLE');
  if (status === 'connected' || status === 'paused') {
    // Only setup that can see folders reports them; a disabled launch lists none.
    return result('CONNECTED', targets.some(target => target.state === 'outdated') ? ['PLUGIN_OUTDATED_ON_DISK'] : []);
  }
  if (!games.length) return result('NO_GAME_SELECTED');
  if (plugins.mode === 'disabled') return result('SETUP_DISABLED');
  if (games.every(game => plugins.games[game].discovery !== 'pending' && plugins.games[game].targets.length === 0)) return result('GAME_NOT_FOUND');
  const reason = (reasons: readonly PluginBlockReason[]) => targets.some(target => target.reason !== null && reasons.includes(target.reason));
  if (reason(PERMISSION_REASONS)) return result('PLUGIN_BLOCKED_PERMISSION');
  if (reason(['UNRECOGNIZED_FILE'])) return result('PLUGIN_UNRECOGNIZED');
  if (targets.some(target => target.state === 'outdated')) return result('PLUGIN_OUTDATED');
  if (targets.some(target => target.state !== 'installed' && target.reason !== null && WAITING_REASONS.includes(target.reason))) return result('PLUGIN_PENDING_GAME_CLOSE');
  if (targets.some(target => MISSING_STATES.includes(target.state))) return result('PLUGIN_MISSING');
  if (status === 'incompatible' || status === 'unavailable') return result('TRANSPORT_FAILED');
  return result('NO_RUNNING_SOURCE');
}
