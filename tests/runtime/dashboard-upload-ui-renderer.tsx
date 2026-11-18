import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DashboardUploadBridge} from '../../packages/contracts/src/dashboard-upload';
import type {JournalTripPage,JournalTripDetail} from '../../packages/contracts/src/journal';
import {AccountScreen} from '../../apps/desktop/src/dashboard-upload/account-screen';
import {SyncChip} from '../../apps/desktop/src/dashboard-upload/sync-chip';
import {JournalSyncBadge} from '../../apps/desktop/src/dashboard-upload/journal-sync';
import {QualificationScreen} from '../../apps/desktop/src/qualification/screen';
import {JournalQualificationBadge,JournalQualificationResult} from '../../apps/desktop/src/qualification/journal-result';
import type {QualificationBridge,QualificationCue} from '../../packages/contracts/src/qualification';
import {OverlayContent} from '../../apps/desktop/src/overlay-content';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import type {OverlayLayout} from '../../packages/contracts/src';
import {useDashboardUpload} from '../../apps/desktop/src/dashboard-upload/use-dashboard-upload';
import {t} from '../../apps/desktop/src/i18n';
import {Badge} from '@/components/ui/badge';
import '../../apps/desktop/src/index.css';
import '../../apps/desktop/src/renderer.css';

const bridge = (window as unknown as {uploadUi: DashboardUploadBridge & QualificationBridge & {listJournalTrips(query: object): Promise<{ok: true; value: JournalTripPage}>;getJournalTrip(uuid:string):Promise<{ok:true;value:JournalTripDetail}>}}).uploadUi;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
// Renderer-only gates expose initial-context and retained-status races without changing the isolated preload bridge.
const initialContext = deferred();
let verification = {promise: Promise.resolve(), resolve: () => {}};
let confirmationReply = {promise: Promise.resolve(), resolve: () => {}};
const controlledBridge: DashboardUploadBridge = {...bridge,
  getDashboardUploadContext: async () => {await initialContext.promise; return bridge.getDashboardUploadContext();},
  verifyDashboardUploadToken: async token => {await verification.promise; return bridge.verifyDashboardUploadToken(token);},
  confirmDashboardUpload: async candidateId => {const status = await bridge.confirmDashboardUpload(candidateId); await confirmationReply.promise; return status;}
};
function Fixture() {
  const [route, setRoute] = useState<'account' | 'journal'|'qualification'|'overlay'>('account'), [language, setLanguage] = useState<'en' | 'ru'>('en');
  const [layout,setLayout]=useState<OverlayLayout>('strip'),[cue,setCue]=useState<QualificationCue>('pass');
  const [contextPending, setContextPending] = useState(true), [holdingVerification, setHoldingVerification] = useState(false);
  const [holdingConfirmationReply, setHoldingConfirmationReply] = useState(false);
  const upload = useDashboardUpload(route === 'account', controlledBridge), heading = useRef<HTMLHeadingElement>(null);
  const qualificationEnabled=!!upload.state.status?.owner&&['connected','paused'].includes(upload.state.status.state)&&!upload.state.status.candidateId;
  const [page, setPage] = useState<JournalTripPage>(),[detail,setDetail]=useState<JournalTripDetail>();
  useEffect(() => {heading.current?.focus();}, [route]);
  useEffect(() => {document.documentElement.lang = language;}, [language]);
  useEffect(() => {void bridge.listJournalTrips({}).then(async result => {setPage(result.value);const row=result.value.sync?.rows.find(row=>row.qualification);if(row)setDetail((await bridge.getJournalTrip(row.tripUuid)).value);});}, []);
  return <div className="yu-app"><div className="yu-titlebar">Isolated upload presentation fixture</div><div className="yu-body"><aside className="yu-sidebar"><nav>
    <button className="yu-nav-item" data-testid="fixture.account" onClick={() => setRoute('account')}>{t('nav.account', undefined, language)}</button>
    <button className="yu-nav-item" data-testid="fixture.journal" onClick={() => setRoute('journal')}>{t('nav.journal', undefined, language)}</button>
    {qualificationEnabled?<button className="yu-nav-item" data-testid="fixture.qualification" onClick={()=>setRoute('qualification')}>{t('nav.qualification',undefined,language)}</button>:null}
    <button className="yu-nav-item" data-testid="fixture.overlay" onClick={()=>setRoute('overlay')}>Overlay</button>
    <button className="yu-nav-item" data-testid="fixture.language" onClick={() => setLanguage(value => value === 'en' ? 'ru' : 'en')}>{language}</button>
    {contextPending ? <button hidden data-testid="fixture.context.release" onClick={() => {initialContext.resolve(); setContextPending(false);}}>Release initial context</button> : null}
    <button hidden data-testid="fixture.verification.gate" onClick={() => {
      if (holdingVerification) verification.resolve(); else verification = deferred();
      setHoldingVerification(value => !value);
    }}>{holdingVerification ? 'Release verification' : 'Hold next verification'}</button>
    <button hidden data-testid="fixture.confirmation.gate" onClick={() => {
      if (holdingConfirmationReply) confirmationReply.resolve(); else confirmationReply = deferred();
      setHoldingConfirmationReply(value => !value);
    }}>{holdingConfirmationReply ? 'Release confirmation reply' : 'Hold confirmation reply'}</button>
  </nav></aside><div className="yu-column"><header className="yu-topbar"><span>{t(route === 'account' ? 'nav.account' : 'nav.journal', undefined, language)}</span>{/* ET-110: a production top-bar chip beside the sync button, so the smoke can compare their heights. */}
    <span className="yu-status-chips"><Badge variant="neutral" className="yu-chip" data-testid="fixture.chip">Chip</Badge><SyncChip state={upload.state} language={language} onOpen={() => setRoute('account')} /></span></header>
    <main className="yu-content" data-testid="fixture.content"><div className="yu-page-header"><h1 ref={heading} tabIndex={-1} data-testid="screen-title">{t(route==='qualification'?'nav.qualification':route === 'account' ? 'nav.account' : 'nav.journal', undefined, language)}</h1></div>
      {route==='account'?<AccountScreen {...upload} language={language} onOpenJournal={()=>setRoute('journal')}/>:route==='qualification'?<QualificationScreen language={language} enabled={qualificationEnabled} bridge={bridge}/>:route==='overlay'?<section data-testid="fixture.overlay.preview">
        <div>{(['strip','card','cluster','hud'] as const).map(value=><button key={value} data-testid={'fixture.layout.'+value} onClick={()=>setLayout(value)}>{value}</button>)}{(['pass','fail','neutral'] as const).map(value=><button key={value} data-testid={'fixture.cue.'+value} onClick={()=>setCue(value)}>{value}</button>)}</div>
        <div className="overlay" style={{width:'100%',height:400}}><OverlayContent view={overlayView({source:'ETS2',origin:'game',status:'connected',speed:'0',fuel:'0',speedUnit:'km/h',fuelUnit:'L',freshness:'current',layout,paused:false,sections:[],editing:false,language,hardMode:{state:'active'},qualification:cue})}/></div>
      </section>:<section data-testid="fixture.rows" className="yu-stack"><h2>{t('upload.column',undefined,language)}</h2>{page?.sync?.rows.map((row,index)=><div key={row.tripUuid}><span>Source {index+1} </span><JournalSyncBadge row={row} language={language}/><JournalQualificationBadge row={row} language={language}/></div>)}{detail?.qualification?<JournalQualificationResult row={detail.qualification.row} language={language}/>:null}</section>}
    </main>
  </div></div></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
