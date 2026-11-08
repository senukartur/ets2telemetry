import {expect, it, vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DASHBOARD_UPLOAD_ERRORS, initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import type {DashboardUploadBridge} from '../../packages/contracts/src/dashboard-upload';
import {uploadView, journalSyncView} from '../../apps/desktop/src/dashboard-upload/view';
import {DashboardUploadUiController, unavailableUploadUi, type UploadUiState} from '../../apps/desktop/src/dashboard-upload/ui-controller';
import {AccountScreen} from '../../apps/desktop/src/dashboard-upload/account-screen';
import {t, type I18nKey} from '../../apps/desktop/src/i18n';

// Substitute presentation primitives only; the runtime fixture checks the real shared controls and styles.
type Props = Record<string, unknown> & {children?: React.ReactNode};
const omit = (props: Props, keys: string[]) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key)));
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/badge', () => ({Badge: (props: Props) => React.createElement('span', omit(props, ['variant']))}));
vi.mock('@/components/ui/button', () => ({Button: (props: Props) => React.createElement('button', omit(props, ['variant', 'size']))}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
it.each(['en', 'ru'] as const)('REG-009/010/014 distinguishes availability, candidate and actual connection in %s', language => {
  const ui = unavailableUploadUi(); expect(uploadView(ui, language)).toMatchObject({available: false, canEnterToken: false, percent: null});
  ui.status = initialDashboardUploadStatus('https://dashboard.example'); expect(uploadView(ui, language)).toMatchObject({available: true, canEnterToken: true, connected: false});
  const unknown = uploadView(ui, language); ui.status.progress = {...ui.status.progress, enumeration: 'complete', distinctSources: 0, deliveredSources: 0, lastDurableUploadUtcMs: 0};
  expect(uploadView(ui, language).distinct).toBe('0'); expect(uploadView(ui, language).lastUpload).not.toBe(unknown.lastUpload);
  ui.status.progress = {...ui.status.progress, distinctSources: 10, deliveredSources: 2, queuedEvents: 900}; expect(uploadView(ui, language).percent).toBe(20);
  ui.status.progress.enumeration = 'changing'; expect(uploadView(ui, language).percent).toBeNull();
  for (const error of DASHBOARD_UPLOAD_ERRORS) {ui.error = error; expect(uploadView(ui, language).error).not.toMatch(/⟦|undefined|accepted|принят/);}
});

const origin = 'https://dashboard.example';
const owner = {origin, accountId: 'synthetic-account', companyId: 'synthetic-company', identityEpoch: 'synthetic-epoch'};
const candidateId = '20000000-0000-4000-8000-000000000001';
const uiState = (): UploadUiState => ({status: initialDashboardUploadStatus(origin), phase: 'idle', abandoned: false, error: null});
const controller = new DashboardUploadUiController({} as DashboardUploadBridge);
const render = (state: UploadUiState, language: 'en' | 'ru') => renderToStaticMarkup(React.createElement(AccountScreen, {state, controller, language}));
const copy = (key: string, language: 'en' | 'ru') => renderToStaticMarkup(React.createElement(React.Fragment, null, t(`upload.${key}` as I18nKey, undefined, language)));

it.each(['en', 'ru'] as const)('REG-009/010/014 renders compact connection and separate history authorization in %s', language => {
  const unavailable = render(unavailableUploadUi(), language);
  expect(unavailable).toContain(copy('unconfigured', language)); expect(unavailable).toContain(copy('local', language));
  for (const control of ['account.form', 'account.confirmation', 'account.counts', 'account.firstSync', 'account.disconnect']) expect(unavailable).not.toContain(`data-testid="${control}"`);
  const state = uiState(), disconnected = render(state, language);
  expect(disconnected).toContain('type="password"'); expect(disconnected).toContain('aria-pressed="false"');
  expect(disconnected).toContain(copy('tokenNote', language)); expect(disconnected.match(/<li>/g)).toHaveLength(4);
  expect(disconnected).not.toContain('data-testid="account.confirm"');
  state.status = {...state.status!, state: 'confirmation-required', owner, candidateId};
  const confirmation = render(state, language);
  for (const value of Object.values(owner)) expect(confirmation).toContain(value);
  for (const key of ['scope', 'binding', 'historyDriver', 'preview', 'confirm', 'cancel']) expect(confirmation).toContain(copy(key, language));
  expect(confirmation).not.toContain('data-testid="account.form"'); expect(confirmation).not.toContain('<progress');
});

it.each(['en', 'ru'] as const)('REG-009/014 keeps five different metrics, unknown totals and replacement-token access in %s', language => {
  const state = uiState();
  state.status = {...state.status!, state: 'connected', owner, progress: {...state.status!.progress, pendingSources: 6, queuedEvents: 900, identityPendingSources: 1, heldSources: 2, distinctSources: 10, deliveredSources: 2, enumeration: 'complete'}};
  const connected = render(state, language);
  for (const key of ['pendingSources', 'queuedEvents', 'identityPendingSources', 'heldSources', 'lastUpload']) expect(connected).toContain(copy(key, language));
  for (const value of [6, 900, 1, 2]) expect(connected).toContain(`<strong>${value}</strong>`);
  expect(connected).toContain('value="20"'); expect(connected).toContain(copy('never', language));
  expect(connected).toContain(copy('enumerationNote', language)); expect(connected).toContain(copy('acceptance', language));
  expect(connected).not.toContain('data-testid="account.explanation"');
  expect(connected.indexOf('data-testid="account.disconnect"')).toBeLessThan(connected.indexOf('data-testid="account.form"'));
  state.status.progress = {...state.status.progress, distinctSources: null, deliveredSources: null, enumeration: 'calculating'};
  const unknown = render(state, language);
  expect(unknown).toContain(copy('unknown', language)); expect(unknown).not.toMatch(/<progress[^>]*value=/);
  state.status.progress = {...state.status.progress, distinctSources: 20, deliveredSources: 2, enumeration: 'changing'};
  expect(render(state, language)).not.toMatch(/<progress[^>]*value=/);
});

it.each(['en', 'ru'] as const)('REG-009/010/014 retains busy, refusal and recovery feedback in %s', language => {
  expect(render({...uiState(), status: null}, language)).toContain(copy('state.loading', language));
  for (const phase of ['verifying', 'confirming', 'cancelling', 'cancel-failed', 'disconnecting'] as const) {
    const state = uiState(); state.phase = phase;
    if (['confirming', 'cancelling', 'cancel-failed'].includes(phase)) state.status = {...state.status!, state: 'confirmation-required', owner, candidateId};
    if (['cancelling', 'cancel-failed'].includes(phase)) state.abandoned = true;
    const html = render(state, language);
    expect(html).toContain(copy(`state.${phase}`, language)); expect(html).not.toContain('data-testid="account.form"');
    if (phase === 'cancel-failed') expect(html).toContain(copy('retryCancel', language));
    if (phase === 'confirming') expect(html).toContain(copy('commit', language));
  }
  const connecting = uiState(); connecting.status!.state = 'connecting';
  expect(render(connecting, language)).toContain(copy('commit', language));
  for (const error of DASHBOARD_UPLOAD_ERRORS.filter(error => error !== 'UNCONFIGURED')) {
    const state = uiState(); state.status = {...state.status!, state: 'paused', owner, error};
    const html = render(state, language);
    expect(html).toContain(copy(`error.${error}`, language)); expect(html).toContain('data-testid="account.disconnect"');
    expect(html).toContain('data-testid="account.form"'); expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toMatch(/⟦|undefined/);
  }
  const pressure = uiState(); pressure.status = {...pressure.status!, state: 'paused', owner, progress: {...pressure.status!.progress, pressure: true}};
  expect(render(pressure, language)).toContain(copy('pressure', language));
});
it.each(['en', 'ru'] as const)('REG-014 maps only authoritative row states to localized badges in %s', language => {
  for (const state of ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent'] as const) {
    const view = journalSyncView({tripUuid: '', state, materialVersion: null, latestRevision: null, lastDurableUploadUtcMs: null, reason: state === 'held' ? 'validation' : null}, language);
    expect(view.text).not.toMatch(/⟦|accepted|принят/); expect(view.tone).toBe(state === 'sent' ? 'ok' : state === 'held' ? 'error' : ['unavailable', 'unbound'].includes(state) ? 'neutral' : 'warn');
  }
});
