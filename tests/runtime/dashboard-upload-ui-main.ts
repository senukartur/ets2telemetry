import {app, BrowserWindow, ipcMain, session} from 'electron';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {initialDashboardUploadStatus, isDashboardUploadStatus, type DashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {UPLOAD_CHANNELS, validUploadArguments, type UploadAction} from '../../apps/desktop/src/dashboard-upload/contract';
import {validateJournalTripPage, type JournalSyncRow, type JournalTripListItem} from '../../packages/contracts/src/journal';

// This entry is built only in the marked runtime-smoke fixture directory; it imports no production main or uploader.
if (readFileSync(path.join(__dirname, '.upload-ui-root'), 'utf8') !== 'ets2telemetry.dashboard-upload.ui.v1\n') throw Error('INVALID_FIXTURE_ROOT');
app.setPath('userData', path.join(__dirname, 'profile'));
app.setPath('sessionData', path.join(__dirname, 'session'));
const origin = 'https://dashboard.example', owner = {origin, accountId: 'fixture-account', companyId: 'fixture-company', identityEpoch: 'fixture-epoch'};
let status = initialDashboardUploadStatus(origin), window: BrowserWindow;
let pending: ((status: DashboardUploadStatus) => void) | undefined;
let pendingKind: 'verify' | 'confirm' | null = null, failure: DashboardUploadStatus['error'] = null;
const counts = {verify: 0, confirm: 0, cancel: 0, disconnect: 0};
const denied = {navigation: 0, newWindow: 0};
const rows = ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent'].map((state, index): JournalSyncRow => ({tripUuid: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, state: state as JournalSyncRow['state'], materialVersion: index < 2 ? null : '2', latestRevision: index < 4 ? null : 1, lastDurableUploadUtcMs: state === 'sent' ? 5000 : null, reason: state === 'held' ? 'validation' : null}));
const absent = {available: false, reason: 'not-observed'} as const;
const trips = rows.map(({tripUuid}): JournalTripListItem => ({tripUuid, game: 'ets2', isHardMode: false, hardModeDetails: null, gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', closeReason: null, recordingCompleteness: 'partial', startedUtcMs: 1000, endedUtcMs: null, observedDistanceM: absent, fuelUsedL: absent, job: {source: 'event', sourceCity: absent, sourceCompany: absent, destinationCity: absent, destinationCompany: absent, cargo: absent, plannedDistance: {...absent, unit: 'm'}, expectedIncome: absent}}));
function publish(value: DashboardUploadStatus) {if (!isDashboardUploadStatus(value)) throw Error('INVALID_FIXTURE_STATUS'); status = structuredClone(value); window.webContents.send(UPLOAD_CHANNELS.status, status);}
const fixture = {
  counts, denied, owner, origin, rows,
  publish,
  fail(error: DashboardUploadStatus['error']) {failure = error;},
  settle(value: DashboardUploadStatus) {if (!pending) throw Error('NO_PENDING_FIXTURE_OPERATION'); const done = pending; pending = undefined; pendingKind = null; publish(value); done(structuredClone(status));},
  get pendingKind() {return pendingKind;},
  get status() {return structuredClone(status);}
};
(globalThis as unknown as {uploadUiFixture: typeof fixture}).uploadUiFixture = fixture;
void app.whenReady().then(async () => {
  const isolated = session.fromPartition('upload-ui-fixture');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {const url = new URL(details.url); allowed = url.protocol === 'file:' && decodeURIComponent(url.pathname).replace(/^\//, '').toLowerCase().startsWith(__dirname.replace(/\\/g, '/').toLowerCase() + '/');} catch { /* Refuse malformed URLs. */ }
    callback({cancel: !allowed});
  });
  window = new BrowserWindow({width: 1280, height: 800, show: false, webPreferences: {session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs')}});
  window.webContents.on('will-navigate', event => {denied.navigation++; event.preventDefault();});
  window.webContents.setWindowOpenHandler(() => {denied.newWindow++; return {action: 'deny'};});
  for (const action of ['context', 'verify', 'confirm', 'cancel', 'disconnect'] as UploadAction[]) ipcMain.handle(UPLOAD_CHANNELS[action], (event, ...args: unknown[]) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !validUploadArguments(action, args)) throw Error('INVALID_FIXTURE_REQUEST');
    if (action === 'context') return status;
    counts[action]++;
    if (pending) return {...status, error: 'BUSY'};
    if (failure) {const error = failure; failure = null; publish({...initialDashboardUploadStatus(origin), error}); return status;}
    if (action === 'cancel' || action === 'disconnect') {publish(initialDashboardUploadStatus(origin)); return status;}
    if (action === 'confirm' && args[0] !== status.candidateId) throw Error('INVALID_FIXTURE_CANDIDATE');
    publish(action === 'verify' ? {...initialDashboardUploadStatus(origin), state: 'verifying'} : {...status, state: 'connecting'});
    pendingKind = action;
    return new Promise<DashboardUploadStatus>(resolve => {pending = resolve;});
  });
  ipcMain.handle('journal:list-trips', (event, ...args: unknown[]) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || args.length !== 1 || JSON.stringify(args[0]) !== '{}') throw Error('INVALID_FIXTURE_JOURNAL');
    return {ok: true, value: validateJournalTripPage({database: {purpose: 'history', schemaVersion: 6}, trips, nextCursor: null, sync: {owner, connectionVersion: '1', rows}})};
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'tests', 'runtime', 'dashboard-upload-ui.html'));
  window.showInactive();
});
app.on('window-all-closed', () => app.quit());
