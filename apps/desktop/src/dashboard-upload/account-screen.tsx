import React, {useEffect, useRef, useState} from 'react';
import {Cloud, Eye, EyeOff, ShieldCheck} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {isDashboardToken} from '../../../../packages/contracts/src/dashboard-upload';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Label} from '@/components/ui/label';
import {CHANNEL} from '../channel';
import {t, type I18nKey} from '../i18n';
import {uploadView} from './view';
import type {DashboardUploadUiController, UploadUiState} from './ui-controller';

export function AccountScreen({state, controller, language}: {state: UploadUiState; controller: DashboardUploadUiController; language: AppLanguage}) {
  const [token, setToken] = useState(''), [visible, setVisible] = useState(false), [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const view = uploadView(state, language), status = state.status;
  const text = (key: string) => t(`upload.${key}` as I18nKey, undefined, language);
  const clear = () => {if (input.current) input.current.value = ''; setToken(''); setVisible(false); setInvalid(false);};
  useEffect(() => () => {if (input.current) input.current.value = '';}, []);
  const cancel = () => {clear(); void controller.cancel();};
  return <div className="yu-stack" data-testid="account.screen">
    <p className="yu-muted">{text('intro')}</p>
    <div className="yu-account-grid">
      <Card data-testid="account.token"><CardHeader><CardTitle><h2><Cloud aria-hidden="true" /> {text('connection')}</h2></CardTitle></CardHeader><CardContent className="space-y-4">
        {!status ? <p role="status">{text('state.loading')}</p> : !view.available ? <Alert><AlertDescription data-testid="account.unconfigured">{text('unconfigured')}</AlertDescription></Alert> : <>
          <div className="yu-upload-identifiers"><span>{text('origin')}</span><strong>{status.origin}</strong><span>{text('channel')}</span><strong>{CHANNEL.displayName}</strong></div>
          {view.canEnterToken ? <form onSubmit={event => {
            event.preventDefault();
            if (!isDashboardToken(token)) {setInvalid(true); return;}
            const submitted = token; clear(); void controller.verify(submitted);
          }} className="space-y-3" data-testid="account.form">
            <Label htmlFor="dashboard-upload-token">{text('token')}</Label>
            <div className="yu-upload-token"><input className="yu-token-input" ref={input} id="dashboard-upload-token" name="dashboard-token" type={visible ? 'text' : 'password'} value={token} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} aria-invalid={invalid} aria-describedby="upload-token-note" onChange={event => {setToken(event.target.value); setInvalid(false);}} data-testid="account.token.input" />
              <Button type="button" variant="outline" onClick={() => setVisible(value => !value)} aria-label={text(visible ? 'hide' : 'show')} aria-pressed={visible} data-testid="account.token.visibility">{visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</Button></div>
            <p id="upload-token-note" className="yu-muted">{text('tokenNote')}</p>
            {invalid ? <p role="alert">{text('error.INVALID_TOKEN')}</p> : null}
            <Button type="submit" data-testid="account.verify">{text('save')}</Button>
          </form> : null}
          {view.confirming && status.owner ? <section className="space-y-3" data-testid="account.confirmation" aria-labelledby="upload-confirm-heading">
            <h3 id="upload-confirm-heading" className="font-semibold">{text('confirmTitle')}</h3>
            <Owner owner={status.owner} language={language} />
            <p>{text('scope')}</p><p>{text('binding')}</p><p className="yu-muted">{text('historyDriver')}</p>
            <p data-testid="account.preview">{text('preview')}</p>
            <div className="flex flex-wrap gap-2"><Button onClick={() => {clear(); void controller.confirm();}} disabled={view.busy} data-testid="account.confirm"><ShieldCheck aria-hidden="true" />{text('confirm')}</Button><Button variant="outline" onClick={cancel} disabled={view.busy} data-testid="account.cancel">{text('cancel')}</Button></div>
          </section> : null}
          {state.phase === 'verifying' ? <Button variant="outline" onClick={cancel} disabled={state.abandoned} data-testid="account.cancel">{text('cancel')}</Button> : null}
          {state.phase === 'cancel-failed' ? <Button variant="outline" onClick={cancel} data-testid="account.cancel">{text('retryCancel')}</Button> : null}
          {state.phase === 'confirming' || status.state === 'connecting' ? <p>{text('commit')}</p> : null}
        </>}
        <p className="yu-muted">{text('local')}</p><p className="yu-muted">{text('acceptance')}</p>
      </CardContent></Card>
      <Card data-testid="account.status"><CardHeader><CardTitle><h2>{text('status')}</h2></CardTitle></CardHeader><CardContent className="space-y-4">
        <div role="status" data-testid="account.phase"><Badge variant={view.tone}><Cloud aria-hidden="true" />{view.headline}</Badge></div>
        {view.error && view.available ? <Alert variant={view.tone === 'error' ? 'destructive' : 'default'}><AlertDescription data-testid="account.error">{view.error}</AlertDescription></Alert> : null}
        {view.connected && status?.owner ? <><Owner owner={status.owner} language={language} /><Button variant="destructive" disabled={view.busy} onClick={() => {clear(); void controller.disconnect();}} data-testid="account.disconnect">{text('disconnect')}</Button><p className="yu-muted">{text('disconnectNote')}</p></> : null}
        {view.connected && status ? <>
          <dl className="yu-upload-identifiers" data-testid="account.counts">{(['pendingSources', 'identityPendingSources', 'heldSources', 'queuedEvents'] as const).map(key => <React.Fragment key={key}><dt>{text(key)}</dt><dd>{status.progress[key]}</dd></React.Fragment>)}<dt>{text('lastUpload')}</dt><dd data-testid="account.lastUpload">{view.lastUpload}</dd></dl>
          {status.progress.pressure ? <p>{text('pressure')}</p> : null}
          <section className="space-y-2" data-testid="account.firstSync" aria-labelledby="upload-progress-heading"><h3 id="upload-progress-heading" className="font-semibold">{text('firstSync')}</h3><p>{view.enumeration}</p>
            <p>{t('upload.delivered', {delivered: view.delivered, total: view.distinct}, language)}</p>
            <progress aria-label={text('firstSync')} max={100} {...(view.percent === null ? {} : {value: view.percent})} />
            <p className="yu-muted">{text('enumerationNote')}</p>
          </section>
        </> : null}
      </CardContent></Card>
    </div>
  </div>;
}
function Owner({owner, language}: {owner: NonNullable<UploadUiState['status']>['owner']; language: AppLanguage}) {
  if (!owner) return null;
  return <dl className="yu-upload-identifiers" data-testid="account.owner">{(['origin', 'accountId', 'companyId', 'identityEpoch'] as const).map(key => <React.Fragment key={key}><dt>{t(`upload.${key}` as I18nKey, undefined, language)}</dt><dd>{owner[key]}</dd></React.Fragment>)}</dl>;
}
