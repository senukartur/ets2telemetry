import {app, BrowserWindow, ipcMain, session} from 'electron';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {initialDashboardUploadStatus, isDashboardUploadStatus, type DashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {UPLOAD_CHANNELS, validUploadArguments, type UploadAction} from '../../apps/desktop/src/dashboard-upload/contract';
import {validateJournalTripPage,validateJournalTripDetail,type JournalSyncRow, type JournalTripListItem} from '../../packages/contracts/src/journal';
import {initialQualificationState,isQualificationState,type QualificationGame,type QualificationState,type QualificationWire} from '../../packages/contracts/src/qualification';
import {QUALIFICATION_CHANNELS,validQualificationArguments} from '../../apps/desktop/src/qualification/contract';

// This entry is built only in the marked runtime-smoke fixture directory; it imports no production main or uploader.
if (readFileSync(path.join(__dirname, '.upload-ui-root'), 'utf8') !== 'ets2telemetry.dashboard-upload.ui.v1\n') throw Error('INVALID_FIXTURE_ROOT');
app.setPath('userData', path.join(__dirname, 'profile'));
app.setPath('sessionData', path.join(__dirname, 'session'));
const origin = 'https://dashboard.example', owner = {origin, accountId: '00000000-0000-4000-8000-000000000005', companyId: 'fixture-company', identityEpoch: 'fixture-epoch'};
let status = initialDashboardUploadStatus(origin), window: BrowserWindow;
let pending: ((status: DashboardUploadStatus) => void) | undefined;
let pendingKind: 'verify' | 'confirm' | null = null, failure: DashboardUploadStatus['error'] = null;
const counts = {verify: 0, confirm: 0, cancel: 0, disconnect: 0};
const denied = {navigation: 0, newWindow: 0, permissions: 0};
const rows = ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent'].map((state, index): JournalSyncRow => ({tripUuid: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, state: state as JournalSyncRow['state'], materialVersion: index < 2 ? null : '2', latestRevision: index < 4 ? null : 1, lastDurableUploadUtcMs: state === 'sent' ? 5000 : null, reason: state === 'held' ? 'validation' : null}));
const absent = {available: false, reason: 'not-observed'} as const;
const companion=JSON.parse(readFileSync(path.join(__dirname,'companion-v1.json'),'utf8')) as {schema:string;value:unknown}[];
const qualificationStates=Object.fromEntries((['ets2','ats'] as const).map(game=>{
  const snapshot=structuredClone(companion.find(item=>item.schema==='Qualification'&&(item.value as QualificationWire['Qualification']).game===game)!.value) as QualificationWire['Qualification'];
  return [game,{...initialQualificationState(game,owner),snapshot,availability:'ready',stale:false,fetchedUtcMs:1795000000000}];
})) as Record<QualificationGame,QualificationState>;
const result=structuredClone(companion.filter(item=>item.schema==='ResultBatch').flatMap(item=>(item.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!);
rows[7].qualification={current:{availability:result.assessment!.availability,outcome:result.assessment!.outcome},awaiting:false,latest:{companyDecision:result.companyDecision,credit:result.credit}};
const trips = rows.map(({tripUuid}): JournalTripListItem => ({tripUuid, game: 'ets2', isHardMode: false, hardModeDetails: null, gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', closeReason: null, recordingCompleteness: 'partial', startedUtcMs: 1000, endedUtcMs: null, observedDistanceM: absent, fuelUsedL: absent, job: {source: 'event', sourceCity: absent, sourceCompany: absent, destinationCity: absent, destinationCompany: absent, cargo: absent, market: absent, isSpecialJob: absent, plannedDistance: {...absent, unit: 'm'}, expectedIncome: absent}}));
const fixtureJob=(JSON.parse(readFileSync(path.join(__dirname,'journal-job.json'),'utf8')) as {data:{record:Record<string,unknown>}}).data.record;delete fixtureJob.type;
const detail=validateJournalTripDetail({database:{purpose:'history',schemaVersion:11},trip:{...trips[7],pluginSessionId:result.source.pluginSessionId,openedBy:'event',openedEventSeq:'1',outcomeEventSeq:null,closedBy:null},
  job:{source:'event',eventSeq:'1',checkpointNextEventSeq:null,values:fixtureJob},truck:null,trailers:{items:[],total:0},outcomeDetails:null,money:{incomplete:false,totals:[],unavailable:[]},
  window:{known:true,pluginSessionId:result.source.pluginSessionId,fromEventSeq:'1',throughEventSeq:null,end:'open'},intervals:{items:[],total:0,nextCursor:null},samples:{count:0,firstUtcMs:null,lastUtcMs:null},exportBounds:{committedThroughEventSeq:'1',lastSampleId:null,lastIntervalId:null},
  qualification:{owner,connectionVersion:'1',row:{...rows[7],qualification:{current:result,previous:null,awaiting:false,latest:{companyDecision:result.companyDecision,credit:result.credit}}}}});
function publish(value: DashboardUploadStatus) {if (!isDashboardUploadStatus(value)) throw Error('INVALID_FIXTURE_STATUS'); status = structuredClone(value); window.webContents.send(UPLOAD_CHANNELS.status, status);}
const fixture = {
  counts, denied, owner, origin, rows,
  publish,
  fail(error: DashboardUploadStatus['error']) {failure = error;},
  settle(value: DashboardUploadStatus) {if (!pending) throw Error('NO_PENDING_FIXTURE_OPERATION'); const done = pending; pending = undefined; pendingKind = null; publish(value); done(structuredClone(status));},
  get pendingKind() {return pendingKind;},
  get status() {return structuredClone(status);}
  ,qualification(game:QualificationGame,change:Partial<QualificationState>={}){const state={...qualificationStates[game],...change};if(!isQualificationState(state))throw Error('INVALID_QUALIFICATION_FIXTURE');qualificationStates[game]=state;window.webContents.send(QUALIFICATION_CHANNELS.status,state);return state;}
};
(globalThis as unknown as {uploadUiFixture: typeof fixture}).uploadUiFixture = fixture;
void app.whenReady().then(async () => {
  const isolated = session.fromPartition('upload-ui-fixture');
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => {denied.permissions++; callback(false);});
  isolated.setPermissionCheckHandler(() => {denied.permissions++; return false;});
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
  for(const action of ['get','refresh'] as const)ipcMain.handle(QUALIFICATION_CHANNELS[action],(event,...args:unknown[])=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||!validQualificationArguments(args))throw Error('INVALID_QUALIFICATION_FIXTURE_REQUEST');
    return status.owner&&['connected','paused'].includes(status.state)?qualificationStates[args[0] as QualificationGame]:initialQualificationState(args[0] as QualificationGame);
  });
  ipcMain.handle('journal:list-trips', (event, ...args: unknown[]) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || args.length !== 1 || JSON.stringify(args[0]) !== '{}') throw Error('INVALID_FIXTURE_JOURNAL');
    return {ok: true, value: validateJournalTripPage({database: {purpose: 'history', schemaVersion: 6}, trips, nextCursor: null, sync: {owner, connectionVersion: '1', rows}})};
  });
  ipcMain.handle('journal:get-trip',(event,...args:unknown[])=>{
    if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame||args.length!==1||args[0]!==rows[7].tripUuid)throw Error('INVALID_FIXTURE_JOURNAL');
    return {ok:true,value:detail};
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'tests', 'runtime', 'dashboard-upload-ui.html'));
  window.showInactive();
});
app.on('window-all-closed', () => app.quit());
