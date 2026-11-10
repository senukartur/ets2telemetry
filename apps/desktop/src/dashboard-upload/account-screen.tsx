import React, {useEffect, useRef, useState} from 'react';
import {BookOpen, ChevronRight, CircleCheck, Cloud, CloudOff, CloudUpload, Eye, EyeOff, Hourglass, KeyRound, LogOut, ShieldCheck, TriangleAlert} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {isDashboardToken, type DashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Label} from '@/components/ui/label';
import {t, type I18nKey} from '../i18n';
import {uploadView, type UploadSyncKind} from './view';
import type {DashboardUploadUiController, UploadUiState} from './ui-controller';

const SYNC_ICONS: Record<UploadSyncKind, typeof Cloud> = {counting: Hourglass, empty: Cloud, done: CircleCheck, syncing: CloudUpload, attention: TriangleAlert, offline: CloudOff, auth: KeyRound};

/**
 * ET-110 Account & sync (mockups T7, T7a, T7b): an intro and at most two cards. A connection shows its card and the upload
 * result; without a working token the page shows only the token entry, and a verified token its separate confirmation.
 */
export function AccountScreen({state, controller, language, onOpenJournal}: {state: UploadUiState; controller: DashboardUploadUiController; language: AppLanguage; onOpenJournal: () => void}) {
  const [token, setToken] = useState(''), [visible, setVisible] = useState(false), [invalid, setInvalid] = useState(false), [asking, setAsking] = useState(false);
  const input = useRef<HTMLInputElement>(null), confirmation = useRef<HTMLHeadingElement>(null), statusHeading = useRef<HTMLHeadingElement>(null);
  const question = useRef<HTMLParagraphElement>(null), disconnectTrigger = useRef<HTMLButtonElement>(null), restoreTrigger = useRef(false);
  const view = uploadView(state, language), status = state.status;
  const hasStatus = status !== null, prompt = asking && view.connected;
  const previous = useRef({hasStatus, confirming: view.confirming, connected: view.connected, canEnterToken: view.canEnterToken});
  const text = (key: string) => t(`upload.${key}` as I18nKey, undefined, language);
  const clear = () => {if (input.current) input.current.value = ''; setToken(''); setVisible(false); setInvalid(false);};
  useEffect(() => () => {if (input.current) input.current.value = '';}, []);
  useEffect(() => {
    // Initial context loading keeps route focus; later task transitions may move it, never progress notifications. Token
    // entry takes focus only when the page becomes the setup layout, so a background authentication failure does not.
    if (previous.current.hasStatus) {
      if (view.confirming && !previous.current.confirming) confirmation.current?.focus();
      else if (view.connected && !previous.current.connected) statusHeading.current?.focus();
      else if (view.canEnterToken && !view.connected && (previous.current.connected || !previous.current.canEnterToken)) input.current?.focus();
    }
    previous.current = {hasStatus, confirming: view.confirming, connected: view.connected, canEnterToken: view.canEnterToken};
  }, [hasStatus, view.confirming, view.connected, view.canEnterToken]);
  // A question about a connection that ended is dropped, so a later connection does not open it again.
  if (asking && !view.connected) setAsking(false);
  useEffect(() => {
    if (prompt) question.current?.focus();
    else if (restoreTrigger.current) {restoreTrigger.current = false; disconnectTrigger.current?.focus();}
  }, [prompt]);
  const closePrompt = () => {restoreTrigger.current = true; setAsking(false);};
  const disconnect = () => {setAsking(false); clear(); statusHeading.current?.focus(); void controller.disconnect();};
  const cancel = () => {clear(); void controller.cancel();};
  const cancellation = state.phase === 'verifying' ? <Button variant="outline" onClick={cancel} disabled={state.abandoned} data-testid="account.cancel">{text('cancel')}</Button> : state.phase === 'cancel-failed' ? <Button variant="outline" onClick={cancel} data-testid="account.cancel">{text('retryCancel')}</Button> : null;
  const tokenForm = (replacement: boolean) => view.canEnterToken ? <form onSubmit={event => {
    event.preventDefault();
    if (!isDashboardToken(token)) {setInvalid(true); return;}
    const submitted = token; clear(); void controller.verify(submitted);
  }} className="yu-account-form" data-testid="account.form">
    <Label htmlFor="dashboard-upload-token">{text(replacement ? 'newToken' : 'token')}</Label>
    <div className="yu-account-token-row"><div className="yu-upload-token"><input className="yu-token-input" ref={input} id="dashboard-upload-token" name="dashboard-token" type={visible ? 'text' : 'password'} value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} aria-invalid={invalid}
      aria-describedby={[replacement ? 'upload-token-hint' : '', invalid ? 'upload-token-error' : ''].filter(Boolean).join(' ') || undefined} onChange={event => {setToken(event.target.value); setInvalid(false);}} data-testid="account.token.input" />
      <Button type="button" variant="ghost" size="icon" onClick={() => setVisible(value => !value)} aria-label={text(visible ? 'hide' : 'show')} aria-pressed={visible} data-testid="account.token.visibility">{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>
      <Button type="submit" data-testid="account.verify">{text(replacement ? 'replace' : 'save')}</Button></div>
    {replacement ? <p id="upload-token-hint" className="yu-muted">{text('replaceHint')}</p> : null}
    {invalid ? <p id="upload-token-error" role="alert">{text('error.INVALID_TOKEN')}</p> : null}
  </form> : null;
  const phase = <Badge variant={view.tone} data-testid="account.phase"><Cloud aria-hidden="true" />{view.headline}</Badge>;
  const commit = state.phase === 'confirming' || status?.state === 'connecting' ? <p className="yu-account-notice" data-tone="warn">{text('commit')}</p> : null;
  // One persistent live region for every layout: it announces the state word, never the sending count.
  const feedback = <div role="status" aria-atomic="true" className="yu-account-feedback"><span className="sr-only">{text('status')}: {view.headline}</span>{view.showError ? <p className="yu-account-notice" data-tone={view.tone === 'error' ? 'error' : 'warn'} data-testid="account.error">{view.error}</p> : null}</div>;
  let body: React.ReactNode;
  if (!status) body = <Card data-testid="account.token"><CardHeader className="yu-account-header"><CardTitle><h2><Cloud aria-hidden="true" />{text('connection')}</h2></CardTitle>{phase}</CardHeader><CardContent><p>{text('state.loading')}</p></CardContent></Card>;
  else if (!view.available) body = <Card><CardContent className="yu-account-row"><span className="yu-account-tile" data-tone="neutral" aria-hidden="true"><CloudOff /></span><p className="yu-account-main" data-testid="account.unconfigured">{text('unconfigured')}</p></CardContent></Card>;
  else if (view.confirming && status.owner) body = <Card data-testid="account.confirmation">
    <CardHeader className="yu-account-header"><CardTitle><h2 ref={confirmation} tabIndex={-1} id="upload-confirm-heading">{text('confirmTitle')}</h2></CardTitle>{phase}</CardHeader>
    <CardContent>
      <Owner owner={status.owner} fields={['origin', 'accountId', 'companyId', 'identityEpoch']} language={language} />
      <p>{text('scope')}</p><div className="yu-account-notice" data-tone="warn"><p>{text('binding')}</p><p>{text('historyDriver')}</p></div>
      <p className="yu-account-preview" data-testid="account.preview">{text('preview')}</p>
      <div className="yu-account-actions"><Button onClick={() => {clear(); void controller.confirm();}} disabled={view.busy} data-testid="account.confirm"><ShieldCheck aria-hidden="true" />{text('confirm')}</Button><Button variant="outline" onClick={cancel} disabled={view.busy} data-testid="account.cancel">{text('cancel')}</Button></div>
      {commit}
    </CardContent></Card>;
  else if (view.connected && view.sync) {
    const sync = view.sync, Icon = SYNC_ICONS[sync.kind], auth = sync.kind === 'auth';
    body = <>
      <Card data-testid="account.status"><CardContent className="yu-account-connection">
        <div className="yu-account-row">
          <span className="yu-account-tile" data-tone={auth ? 'error' : 'ok'} aria-hidden="true">{auth ? <KeyRound /> : <Cloud />}</span>
          <div className="yu-account-main">
            <h2 ref={statusHeading} tabIndex={-1} data-testid="account.phase">{view.connectionTitle}</h2>
            <p className="yu-account-origin" data-testid="account.origin">{status.origin}</p>
            {view.connectionNote ? <p className="yu-muted">{view.connectionNote}</p> : null}
          </div>
          {prompt ? null : <Button ref={disconnectTrigger} variant="outline" disabled={view.busy} onClick={() => setAsking(true)} data-testid="account.disconnect"><LogOut aria-hidden="true" />{text('disconnect')}</Button>}
        </div>
        {prompt ? <div role="group" className="yu-account-ask" aria-labelledby="upload-disconnect-question" aria-describedby="upload-disconnect-note" data-testid="account.disconnect.prompt"
          onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); closePrompt();}}}>
          <div className="yu-account-main"><p ref={question} tabIndex={-1} id="upload-disconnect-question" className="yu-account-question">{text('disconnectQuestion')}</p><p id="upload-disconnect-note" className="yu-muted">{text('disconnectNote')}</p></div>
          <div className="yu-account-actions"><Button variant="destructive" disabled={view.busy} onClick={disconnect} data-testid="account.disconnect.confirm">{text('disconnect')}</Button><Button variant="outline" onClick={closePrompt} data-testid="account.disconnect.cancel">{text('cancel')}</Button></div>
        </div> : null}
        {cancellation ? <div className="yu-account-section">{cancellation}</div> : null}
        {view.tokenReplacement ? <div className="yu-account-section">{tokenForm(true)}</div> : null}
        <details className="yu-account-details" data-testid="account.details"><summary><ChevronRight aria-hidden="true" />{text('details')}</summary>
          <Owner owner={status.owner} fields={['accountId', 'companyId', 'identityEpoch']} language={language} /></details>
      </CardContent></Card>
      <Card data-testid="account.firstSync" data-kind={sync.kind}><CardHeader className="yu-account-header"><CardTitle><h2>{text('firstSync')}</h2></CardTitle><span className="yu-muted" data-testid="account.lastUpload">{sync.lastUpload}</span></CardHeader><CardContent>
        <div className="yu-account-row"><span className="yu-account-tile" data-tone={sync.tone} aria-hidden="true"><Icon /></span>
          <div className="yu-account-main"><p id="upload-progress-title" className="yu-account-result" data-testid="account.sync.title">{sync.title}</p><p id="upload-progress-detail" className="yu-muted" data-testid="account.sync.detail">{sync.detail}</p></div></div>
        {sync.bar ? <progress aria-labelledby="upload-progress-title" aria-describedby="upload-progress-detail" max={100} data-fill={sync.bar === 'indeterminate' ? 'accent' : sync.bar.fill} {...(sync.bar === 'indeterminate' ? {} : {value: sync.bar.percent})} /> : null}
        {sync.problems.length ? <ul className="yu-account-problems" aria-label={text('problems')} data-testid="account.problems">{sync.problems.map(problem => <li key={problem.id} data-testid={`account.problem.${problem.id}`} data-tone={problem.id === 'identity' ? 'neutral' : 'warn'}>
          {problem.id === 'identity' ? <Hourglass aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          <div className="yu-account-main"><p className="yu-account-problem">{problem.title}</p>{problem.detail ? <p className="yu-muted">{problem.detail}</p> : null}</div>
          {problem.journal ? <Button variant="link" onClick={onOpenJournal} data-testid="account.openJournal"><BookOpen aria-hidden="true" />{text('openJournal')}</Button> : null}
        </li>)}</ul> : null}
      </CardContent></Card>
    </>;
  } else body = <Card data-testid="account.token"><CardHeader className="yu-account-header"><CardTitle><h2><Cloud aria-hidden="true" />{text('connection')}</h2></CardTitle>{phase}</CardHeader><CardContent>
    <p className="yu-account-service">{text('origin')}: <span className="yu-account-origin">{status.origin}</span></p>
    {status.state !== 'connecting' && state.phase !== 'confirming' ? <ol className="yu-account-steps">{[1, 2, 3].map(step => <li key={step}>{text(`step${step}`)}</li>)}</ol> : null}
    {tokenForm(false)}
    {cancellation}
    {commit}
  </CardContent></Card>;
  return <div className="yu-account yu-stack" data-testid="account.screen">
    <p className="yu-page-sub">{text('intro')}</p>
    {feedback}
    {body}
  </div>;
}
function Owner({owner, fields, language}: {owner: DashboardOwner | null; fields: readonly (keyof DashboardOwner)[]; language: AppLanguage}) {
  if (!owner) return null;
  return <dl className="yu-account-owner" data-testid="account.owner">{fields.map(key => <div key={key}><dt>{t(`upload.${key}` as I18nKey, undefined, language)}</dt><dd>{owner[key]}</dd></div>)}</dl>;
}
