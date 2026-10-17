// Why the dashboard has no game connection (ET-017 P17): one pure classification over the plugin setup view, the live
// status and selection and the application health. The Game plugin card shows its fixed text, and the diagnostic bundle
// records it. Renderer-safe: type imports only. See docs/plugin-setup.md#connection-diagnosis.
import type {AppHealth, LiveTelemetry, PluginBlockReason, PluginGame, PluginSetupView, PluginTargetView, SourceSelection} from '../../../packages/contracts/src';

/**
 * The diagnosis codes in precedence order (P17): the first that applies wins. The rows below CONNECTED explain why a
 * selected game is not connected. PR-6 review: PLUGIN_BUNDLE_UNAVAILABLE and PLUGIN_NOT_CHECKED split from
 * PLUGIN_MISSING, whose advice (manage the game, Retry) does not help them.
 */
export const CONNECTION_DIAGNOSIS_CODES = Object.freeze([
  'SERVICE_UNAVAILABLE', 'CONNECTED', 'NO_GAME_SELECTED', 'SETUP_DISABLED', 'GAME_NOT_FOUND', 'PLUGIN_BLOCKED_PERMISSION', 'PLUGIN_UNRECOGNIZED',
  'PLUGIN_OUTDATED', 'PLUGIN_PENDING_GAME_CLOSE', 'PLUGIN_BUNDLE_UNAVAILABLE', 'PLUGIN_NOT_CHECKED', 'PLUGIN_MISSING', 'TRANSPORT_FAILED', 'NO_RUNNING_SOURCE'
] as const);
export type ConnectionDiagnosisCode = typeof CONNECTION_DIAGNOSIS_CODES[number];
/** The folder rows, in their precedence order. */
type FolderCode = 'PLUGIN_BLOCKED_PERMISSION' | 'PLUGIN_UNRECOGNIZED' | 'PLUGIN_OUTDATED' | 'PLUGIN_PENDING_GAME_CLOSE' | 'PLUGIN_BUNDLE_UNAVAILABLE'
  | 'PLUGIN_NOT_CHECKED' | 'PLUGIN_MISSING';
/**
 * Notes beside the headline. `PLUGIN_OUTDATED_ON_DISK`: a folder of the selected game still holds an older plugin of this
 * application. `OTHER_FOLDER_*`: another folder of the selected game has that folder row's problem while at least one
 * folder holds the current plugin, so the headline is about the connection instead (PR-6 review).
 */
export type ConnectionDiagnosisNote = 'PLUGIN_OUTDATED_ON_DISK' | 'OTHER_FOLDER_BLOCKED_PERMISSION' | 'OTHER_FOLDER_UNRECOGNIZED'
  | 'OTHER_FOLDER_PENDING_GAME_CLOSE' | 'OTHER_FOLDER_BUNDLE_UNAVAILABLE' | 'OTHER_FOLDER_NOT_CHECKED' | 'OTHER_FOLDER_MISSING';
export interface ConnectionDiagnosis {
  code: ConnectionDiagnosisCode;
  notes: readonly ConnectionDiagnosisNote[];
}

/** Block reasons that need Windows permissions the application does not have (P12): the manual copy helps. */
const PERMISSION_REASONS: readonly PluginBlockReason[] = ['PERMISSION_DENIED', 'READ_ONLY_FILE'];
/** Block reasons that end when the game, TruckersMP or the program that holds the file closes. */
const WAITING_REASONS: readonly PluginBlockReason[] = ['GAME_RUNNING', 'CLIENT_RUNNING', 'TARGET_LOCKED'];
/** Block reasons after which the folder's plugin could not be checked at all: a linked folder or a read failure. */
const UNCHECKED_REASONS: readonly PluginBlockReason[] = ['LINKED_FOLDER', 'IO_ERROR'];
/** Target states without this application's current plugin in place. */
const MISSING_STATES: readonly PluginTargetView['state'][] = ['missing', 'excluded', 'blocked'];

const notInstalledWith = (reasons: readonly PluginBlockReason[]) => (target: PluginTargetView) =>
  target.state !== 'installed' && target.reason !== null && reasons.includes(target.reason);
/** The folder rows in precedence order, each with its test and the note it becomes beside a current folder. */
const FOLDER_ROWS: readonly {code: FolderCode; note: ConnectionDiagnosisNote; applies: (target: PluginTargetView) => boolean}[] = [
  {code: 'PLUGIN_BLOCKED_PERMISSION', note: 'OTHER_FOLDER_BLOCKED_PERMISSION', applies: notInstalledWith(PERMISSION_REASONS)},
  {code: 'PLUGIN_UNRECOGNIZED', note: 'OTHER_FOLDER_UNRECOGNIZED', applies: notInstalledWith(['UNRECOGNIZED_FILE'])},
  {code: 'PLUGIN_OUTDATED', note: 'PLUGIN_OUTDATED_ON_DISK', applies: target => target.state === 'outdated'},
  {code: 'PLUGIN_PENDING_GAME_CLOSE', note: 'OTHER_FOLDER_PENDING_GAME_CLOSE', applies: notInstalledWith(WAITING_REASONS)},
  {code: 'PLUGIN_BUNDLE_UNAVAILABLE', note: 'OTHER_FOLDER_BUNDLE_UNAVAILABLE', applies: notInstalledWith(['BUNDLE_UNAVAILABLE'])},
  {code: 'PLUGIN_NOT_CHECKED', note: 'OTHER_FOLDER_NOT_CHECKED', applies: notInstalledWith(UNCHECKED_REASONS)},
  {code: 'PLUGIN_MISSING', note: 'OTHER_FOLDER_MISSING', applies: target => MISSING_STATES.includes(target.state)}
];

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
 * - The folder rows look at the selected game's listed folders: PLUGIN_BLOCKED_PERMISSION (`PERMISSION_DENIED`,
 *   `READ_ONLY_FILE`), PLUGIN_UNRECOGNIZED (`UNRECOGNIZED_FILE`), PLUGIN_OUTDATED (state `outdated`, from the file's hash on
 *   disk), PLUGIN_PENDING_GAME_CLOSE (`GAME_RUNNING`, `CLIENT_RUNNING`, `TARGET_LOCKED`), PLUGIN_BUNDLE_UNAVAILABLE
 *   (`BUNDLE_UNAVAILABLE`), PLUGIN_NOT_CHECKED (`LINKED_FOLDER`, `IO_ERROR`) and PLUGIN_MISSING (state `missing`,
 *   `excluded` or `blocked` for any other reason, which includes an excluded game). Without a folder that holds the
 *   current plugin, one folder in a row's condition is enough. With one (state `installed`, which means the bundled
 *   plugin is in place), the game can load the plugin from it: every folder row that applies to another folder becomes a
 *   note, and the headline falls through to the transport rows.
 * - TRANSPORT_FAILED: the live status is `incompatible` or `unavailable`.
 * - NO_RUNNING_SOURCE: anything else (`waiting`, `stale`, `disconnected`), with the plugin in place.
 * A pending discovery without folders and folders that are `working` fall through to the transport rows.
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
  // Each folder counts once, under the first folder row that applies to it (a blocked folder is not also missing).
  const firsts = new Set(targets.map(target => FOLDER_ROWS.find(row => row.applies(target))));
  const applying = FOLDER_ROWS.filter(row => firsts.has(row));
  const current = targets.some(target => target.state === 'installed');
  if (!current && applying.length) return result(applying[0].code);
  const notes = applying.map(row => row.note);
  return result(status === 'incompatible' || status === 'unavailable' ? 'TRANSPORT_FAILED' : 'NO_RUNNING_SOURCE', notes);
}
