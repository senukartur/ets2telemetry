import React, {useEffect, useRef, useState} from 'react';
import {Cloud, Eye, EyeOff, ShieldCheck} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {isDashboardToken} from '../../../../packages/contracts/src/dashboard-upload';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Label} from '@/components/ui/label';
import {CHANNEL} from '../channel';
import {t, type I18nKey} from '../i18n';
import {uploadView} from './view';
import type {DashboardUploadUiController, UploadUiState} from './ui-controller';

export function AccountScreen({state, controller, language}: {state: UploadUiState; controller: DashboardUploadUiController; language: AppLanguage}) {
  const [token, setToken] = useState(''), [visible, setVisible] = useState(false), [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null), confirmation = useRef<HTMLHeadingElement>(null), statusHeading = useRef<HTMLHeadingElement>(null);
  const view = uploadView(state, language), status = state.status;
  const hasStatus = status !== null;
  const previous = useRef({hasStatus, confirming: view.confirming, connected: view.connected, canEnterToken: view.canEnterToken});
  const text = (key: string) => t(`upload.${key}` as I18nKey, undefined, language);
  const clear = () => {if (input.current) input.current.value = ''; setToken(''); setVisible(false); setInvalid(false);};
  useEffect(() => () => {if (input.current) input.current.value = '';}, []);
  useEffect(() => {
    // Initial context loading keeps route focus; later task transitions may move it, never progress notifications.
    if (previous.current.hasStatus) {
      if (view.confirming && !previous.current.confirming) confirmation.current?.focus();
      else if (view.connected && !previous.current.connected) statusHeading.current?.focus();
      else if (view.canEnterToken && !previous.current.canEnterToken) input.current?.focus();
    }
    previous.current = {hasStatus, confirming: view.confirming, connected: view.connected, canEnterToken: view.canEnterToken};
  }, [hasStatus, view.confirming, view.connected, view.canEnterToken]);
  const cancel = () => {clear(); void controller.cancel();};
  const cancellation = state.phase === 'verifying' ? <Button variant="outline" onClick={cancel} disabled={state.abandoned} data-testid="account.cancel">{text('cancel')}</Button> : state.phase === 'cancel-failed' ? <Button variant="outline" onClick={cancel} data-testid="account.cancel">{text('retryCancel')}</Button> : null;
  const tokenForm = view.canEnterToken ? <form onSubmit={event => {
    event.preventDefault();
    if (!isDashboardToken(token)) {setInvalid(true); return;}
    const submitted = token; clear(); void controller.verify(submitted);
  }} className="yu-account-form" data-testid="account.form">
    <Label htmlFor="dashboard-upload-token">{text('token')}</Label>
    <div className="yu-upload-token"><input className="yu-token-input" ref={input} id="dashboard-upload-token" name="dashboard-token" type={visible ? 'text' : 'password'} value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} aria-invalid={invalid} aria-describedby={invalid ? 'upload-token-note upload-token-error' : 'upload-token-note'} onChange={event => {setToken(event.target.value); setInvalid(false);}} data-testid="account.token.input" />
      <Button type="button" variant="ghost" size="icon" onClick={() => setVisible(value => !value)} aria-label={text(visible ? 'hide' : 'show')} aria-pressed={visible} data-testid="account.token.visibility">{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>
    <p id="upload-token-note" className="yu-muted">{text('tokenNote')}</p>
    {invalid ? <p id="upload-token-error" role="alert">{text('error.INVALID_TOKEN')}</p> : null}
    <div className="yu-account-actions"><Button type="submit" data-testid="account.verify">{text('save')}</Button></div>
  </form> : null;
  const phase = <Badge variant={view.tone} data-testid="account.phase"><Cloud aria-hidden="true" />{view.headline}</Badge>;
  const feedback = <div role="status" aria-atomic="true" className="yu-account-feedback"><span className="sr-only">{text('status')}: {view.headline}</span>{view.error && view.available ? <p className="yu-account-notice" data-tone={view.tone} data-testid="account.error">{view.error}</p> : null}</div>;
  return <div className="yu-account yu-stack" data-testid="account.screen">
    <p className="yu-page-sub">{text('intro')}</p>
    <div className={view.connected ? 'yu-stack' : 'yu-account-grid'}>
      {view.connected && status ? <>
        <Card data-testid="account.status"><CardHeader className="yu-account-header"><CardTitle><h2 ref={statusHeading} tabIndex={-1}>{text('status')}</h2></CardTitle>{phase}</CardHeader><CardContent>
          {feedback}{cancellation}<Owner owner={status.owner} language={language} />
          <dl className="yu-account-metrics" data-testid="account.counts">{(['pendingSources', 'queuedEvents', 'identityPendingSources', 'heldSources'] as const).map(key => <div key={key}><dt>{text(key)}</dt><dd><strong>{status.progress[key]}</strong><p>{text(`${key}Note`)}</p></dd></div>)}<div><dt>{text('lastUpload')}</dt><dd className="yu-account-date"><span data-testid="account.lastUpload">{view.lastUpload}</span><p>{text('lastUploadNote')}</p></dd></div></dl>
          {status.progress.pressure ? <p className="yu-account-notice" data-tone="warn">{text('pressure')}</p> : null}
        </CardContent></Card>
        <Card data-testid="account.firstSync"><CardHeader className="yu-account-header"><CardTitle><h2 id="upload-progress-heading">{text('firstSync')}</h2></CardTitle><Badge variant="neutral">{view.enumeration}</Badge></CardHeader><CardContent>
          <p className="yu-account-delivered">{t('upload.delivered', {delivered: view.delivered, total: view.distinct}, language)}</p>
          <progress aria-labelledby="upload-progress-heading" aria-describedby="upload-progress-note" max={100} {...(view.percent === null ? {} : {value: view.percent})} />
          <p id="upload-progress-note" className="yu-muted">{text('enumerationNote')}</p>
        </CardContent></Card>
        <Card><CardContent className="yu-account-disconnect"><div><h2>{text('disconnect')}</h2><p className="yu-muted">{text('disconnectNote')}</p></div><Button variant="destructive" disabled={view.busy} onClick={() => {clear(); void controller.disconnect();}} data-testid="account.disconnect">{text('disconnect')}</Button></CardContent></Card>
        {tokenForm ? <Card data-testid="account.token"><CardHeader><CardTitle><h2>{text('reverify')}</h2></CardTitle></CardHeader><CardContent>{tokenForm}</CardContent></Card> : null}
      </> : <>
        <Card data-testid="account.token"><CardHeader className="yu-account-header"><CardTitle><h2><Cloud aria-hidden="true" />{text('connection')}</h2></CardTitle>{phase}</CardHeader><CardContent>
          {feedback}
          {!status ? <p>{text('state.loading')}</p> : !view.available ? <p className="yu-account-notice" data-testid="account.unconfigured">{text('unconfigured')}</p> : <>
            {view.confirming && status.owner ? <section data-testid="account.confirmation" aria-labelledby="upload-confirm-heading">
              <h3 ref={confirmation} tabIndex={-1} id="upload-confirm-heading">{text('confirmTitle')}</h3>
              <Owner owner={status.owner} language={language} />
              <p>{text('scope')}</p><div className="yu-account-notice" data-tone="warn"><p>{text('binding')}</p><p>{text('historyDriver')}</p></div>
              <p className="yu-account-preview" data-testid="account.preview">{text('preview')}</p>
              <div className="yu-account-actions"><Button onClick={() => {clear(); void controller.confirm();}} disabled={view.busy} data-testid="account.confirm"><ShieldCheck aria-hidden="true" />{text('confirm')}</Button><Button variant="outline" onClick={cancel} disabled={view.busy} data-testid="account.cancel">{text('cancel')}</Button></div>
            </section> : <><dl className="yu-account-metadata"><div><dt>{text('origin')}</dt><dd>{status.origin}</dd></div><div><dt>{text('channel')}</dt><dd>{CHANNEL.displayName}</dd></div></dl>{tokenForm}</>}
            {cancellation}
            {state.phase === 'confirming' || status.state === 'connecting' ? <p className="yu-account-notice" data-tone="warn">{text('commit')}</p> : null}
          </>}
          <p className="yu-muted yu-account-local">{text('local')}</p>
        </CardContent></Card>
        {view.available ? <Card data-testid="account.explanation"><CardHeader><CardTitle><h2>{text('howItWorks')}</h2></CardTitle></CardHeader><CardContent><ol className="yu-account-steps">{[1, 2, 3, 4].map(step => <li key={step}><strong>{text(`step${step}Title`)}</strong><p>{text(`step${step}`)}</p></li>)}</ol></CardContent></Card> : null}
      </>}
    </div>
    <div className="yu-muted yu-account-footer yu-stack">{view.connected ? <p>{text('local')}</p> : null}<p>{text('acceptance')}</p></div>
  </div>;
}
function Owner({owner, language}: {owner: NonNullable<UploadUiState['status']>['owner']; language: AppLanguage}) {
  if (!owner) return null;
  return <dl className="yu-account-owner" data-testid="account.owner">{(['origin', 'accountId', 'companyId', 'identityEpoch'] as const).map(key => <div key={key}><dt>{t(`upload.${key}` as I18nKey, undefined, language)}</dt><dd>{owner[key]}</dd></div>)}</dl>;
}
