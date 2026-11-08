import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {DashboardUploadBridge} from '../../packages/contracts/src/dashboard-upload';
import type {JournalTripPage} from '../../packages/contracts/src/journal';
import {AccountScreen} from '../../apps/desktop/src/dashboard-upload/account-screen';
import {SyncChip} from '../../apps/desktop/src/dashboard-upload/sync-chip';
import {JournalSyncBadge} from '../../apps/desktop/src/dashboard-upload/journal-sync';
import {useDashboardUpload} from '../../apps/desktop/src/dashboard-upload/use-dashboard-upload';
import {t} from '../../apps/desktop/src/i18n';
import '../../apps/desktop/src/index.css';

const bridge = (window as unknown as {uploadUi: DashboardUploadBridge & {listJournalTrips(query: object): Promise<{ok: true; value: JournalTripPage}>}}).uploadUi;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve = done;});
  return {promise, resolve};
}
// Renderer-only gates expose initial-context and retained-status races without changing the isolated preload bridge.
const initialContext = deferred();
let verification = {promise: Promise.resolve(), resolve: () => {}};
const controlledBridge: DashboardUploadBridge = {...bridge,
  getDashboardUploadContext: async () => {await initialContext.promise; return bridge.getDashboardUploadContext();},
  verifyDashboardUploadToken: async token => {await verification.promise; return bridge.verifyDashboardUploadToken(token);}
};
function Fixture() {
  const [route, setRoute] = useState<'account' | 'journal'>('account'), [language, setLanguage] = useState<'en' | 'ru'>('en');
  const [contextPending, setContextPending] = useState(true), [holdingVerification, setHoldingVerification] = useState(false);
  const upload = useDashboardUpload(route === 'account', controlledBridge), heading = useRef<HTMLHeadingElement>(null);
  const [page, setPage] = useState<JournalTripPage>();
  useEffect(() => {heading.current?.focus();}, [route]);
  useEffect(() => {document.documentElement.lang = language;}, [language]);
  useEffect(() => {void bridge.listJournalTrips({}).then(result => setPage(result.value));}, []);
  return <div className="yu-app"><div className="yu-titlebar">Isolated upload presentation fixture</div><div className="yu-body"><aside className="yu-sidebar"><nav>
    <button className="yu-nav-item" data-testid="fixture.account" onClick={() => setRoute('account')}>{t('nav.account', undefined, language)}</button>
    <button className="yu-nav-item" data-testid="fixture.journal" onClick={() => setRoute('journal')}>{t('nav.journal', undefined, language)}</button>
    <button className="yu-nav-item" data-testid="fixture.language" onClick={() => setLanguage(value => value === 'en' ? 'ru' : 'en')}>{language}</button>
    {contextPending ? <button hidden data-testid="fixture.context.release" onClick={() => {initialContext.resolve(); setContextPending(false);}}>Release initial context</button> : null}
    <button hidden data-testid="fixture.verification.gate" onClick={() => {
      if (holdingVerification) verification.resolve(); else verification = deferred();
      setHoldingVerification(value => !value);
    }}>{holdingVerification ? 'Release verification' : 'Hold next verification'}</button>
  </nav></aside><div className="yu-column"><header className="yu-topbar"><span>{t(route === 'account' ? 'nav.account' : 'nav.journal', undefined, language)}</span><SyncChip state={upload.state} language={language} onOpen={() => setRoute('account')} /></header>
    <main className="yu-content" data-testid="fixture.content"><div className="yu-page-header"><h1 ref={heading} tabIndex={-1} data-testid="screen-title">{t(route === 'account' ? 'nav.account' : 'nav.journal', undefined, language)}</h1></div>{route === 'account' ? <AccountScreen {...upload} language={language} /> : <section data-testid="fixture.rows" className="yu-stack"><h2>{t('upload.column', undefined, language)}</h2>{page?.sync?.rows.map((row, index) => <div key={row.tripUuid}><span>Source {index + 1} </span><JournalSyncBadge row={row} language={language} /></div>)}</section>}</main>
  </div></div></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
