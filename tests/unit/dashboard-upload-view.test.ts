import {expect, it, vi} from 'vitest';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DASHBOARD_UPLOAD_ERRORS, initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import type {DashboardUploadBridge, DashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
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

const origin = 'https://dashboard.example';
const owner = {origin, accountId: 'synthetic-account', companyId: 'synthetic-company', identityEpoch: 'synthetic-epoch'};
const candidateId = '20000000-0000-4000-8000-000000000001';
const uiState = (): UploadUiState => ({status: initialDashboardUploadStatus(origin), phase: 'idle', abandoned: false, error: null});
const controller = new DashboardUploadUiController({} as DashboardUploadBridge);
const render = (state: UploadUiState, language: 'en' | 'ru') => renderToStaticMarkup(React.createElement(AccountScreen, {state, controller, language, onOpenJournal: () => undefined}));
const copy = (key: string, language: 'en' | 'ru') => renderToStaticMarkup(React.createElement(React.Fragment, null, t(`upload.${key}` as I18nKey, undefined, language)));
type Progress = Partial<DashboardUploadStatus['progress']>;
const linked = (progress: Progress, change: Partial<DashboardUploadStatus> = {}): UploadUiState => {
  const state = uiState(); state.status = {...state.status!, state: 'connected', owner, ...change, progress: {...state.status!.progress, ...progress}}; return state;
};
// The part of the page between two test ids, for checks that a value appears only inside one region.
const outside = (html: string, testId: string) => {const start = html.indexOf(`data-testid="${testId}"`), end = html.indexOf('</details>', start); return html.slice(0, start) + html.slice(end);};

it.each(['en', 'ru'] as const)('REG-009/010/014 distinguishes availability, candidate and actual connection in %s', language => {
  expect(uploadView(unavailableUploadUi(), language)).toMatchObject({available: false, canEnterToken: false, connected: false, sync: null});
  expect(uploadView(uiState(), language)).toMatchObject({available: true, canEnterToken: true, connected: false, sync: null});
  const candidate = uiState(); candidate.status = {...candidate.status!, state: 'confirmation-required', owner, candidateId};
  expect(uploadView(candidate, language)).toMatchObject({confirming: true, connected: false, canEnterToken: false});
  for (const error of DASHBOARD_UPLOAD_ERRORS) {const state = uiState(); state.error = error; expect(uploadView(state, language).error).not.toMatch(/⟦|undefined|accepted|принят/);}
});

// A rejected first token leaves a paused (or connected) status without an owner: the page reads as not connected, never as a
// paused upload, and the error stays visible as its own notice.
it.each(['en', 'ru'] as const)('REG-010/012 words an ownerless connected or paused status as not connected in %s (ET-110)', language => {
  const notConnected = t('upload.state.disconnected', undefined, language), paused = t('upload.state.paused', undefined, language);
  for (const change of [{state: 'paused', error: 'AUTHENTICATION'}, {state: 'connected', error: null}] as const) {
    const state = uiState(); state.status = {...state.status!, ...change, owner: null};
    expect(uploadView(state, language)).toMatchObject({chip: notConnected, headline: notConnected, tone: 'neutral', connected: false, canEnterToken: true, sync: null,
      showError: change.error !== null, ...(change.error ? {noticeTone: 'error', error: t('upload.error.AUTHENTICATION', undefined, language)} : {})});
    const html = render(state, language);
    expect(html).toMatch(new RegExp(`data-testid="account.phase"><svg[^>]*>.*?</svg>${notConnected}</span>`));
    expect(html).not.toContain(paused); expect(html).toContain('data-testid="account.form"');
    if (change.error) expect(html).toContain('data-tone="error" data-testid="account.error"'); else expect(html).not.toContain('account.error');
  }
});

it.each(['en', 'ru'] as const)('REG-009/010 keeps the last known totals and percentage whatever the enumeration phase in %s (ET-110)', language => {
  const complete = uploadView(linked({enumeration: 'complete', distinctSources: 10, deliveredSources: 2}), language).sync!;
  expect(complete).toMatchObject({kind: 'syncing', bar: {percent: 20, fill: 'accent'}});
  // A recount in progress publishes 'changing' or 'scanning' with the previous totals: the result must not change.
  for (const enumeration of ['changing', 'scanning', 'calculating'] as const) expect(uploadView(linked({enumeration, distinctSources: 10, deliveredSources: 2}), language).sync).toEqual(complete);
  const done = uploadView(linked({enumeration: 'changing', distinctSources: 6, deliveredSources: 6}), language).sync!;
  expect(done).toMatchObject({kind: 'done', bar: {percent: 100, fill: 'ok'}});
  const first = uploadView(linked({enumeration: 'calculating', distinctSources: null, deliveredSources: null}), language).sync!;
  expect(first).toMatchObject({kind: 'counting', bar: 'indeterminate', title: language === 'en' ? 'Counting saved trips…' : 'Подсчёт сохранённых рейсов…'});
  const html = render(linked({enumeration: 'calculating', distinctSources: null, deliveredSources: null}), language);
  expect(html).toMatch(/<progress[^>]*max="100"/); expect(html).not.toMatch(/<progress[^>]*value=/);
  expect(render(linked({enumeration: 'changing', distinctSources: 10, deliveredSources: 2}), language)).toMatch(/<progress[^>]*value="20"/);
});

it('REG-009/010/014 words each upload state, chip and plural count from the dictionaries', () => {
  const sync = (language: 'en' | 'ru', progress: Progress, change?: Partial<DashboardUploadStatus>) => {const view = uploadView(linked(progress, change), language); return {chip: view.chip, title: view.sync!.title, detail: view.sync!.detail, kind: view.sync!.kind};};
  const totals = {enumeration: 'complete' as const, distinctSources: 6, deliveredSources: 4};
  expect(sync('en', {...totals, deliveredSources: 6})).toEqual({kind: 'done', chip: 'Connected', title: 'All trips sent', detail: '6 of 6. New and changed trips upload automatically.'});
  expect(sync('ru', {...totals, deliveredSources: 6})).toEqual({kind: 'done', chip: 'Подключено', title: 'Все рейсы отправлены', detail: '6 из 6. Новые и изменённые рейсы отправятся автоматически.'});
  expect(sync('en', totals)).toEqual({kind: 'syncing', chip: 'Uploading 4 of 6', title: 'Uploading: 4 of 6 trips', detail: 'Runs in the background; you can keep driving.'});
  expect(sync('ru', totals)).toEqual({kind: 'syncing', chip: 'Отправка 4 из 6', title: 'Отправка: 4 из 6 рейсов', detail: 'Идёт в фоне — можно продолжать ездить.'});
  expect(sync('en', {...totals, distinctSources: 0, deliveredSources: 0})).toMatchObject({kind: 'empty', chip: 'Connected', title: 'No saved trips yet'});
  expect(sync('ru', {...totals, distinctSources: 0, deliveredSources: 0})).toMatchObject({kind: 'empty', chip: 'Подключено', title: 'Сохранённых рейсов пока нет'});
  expect(sync('en', {...totals, identityPendingSources: 1, heldSources: 1})).toEqual({kind: 'attention', chip: 'Needs attention', title: 'Sent 4 of 6 trips', detail: '2 trips are not sent yet; see the details below.'});
  expect(sync('ru', {...totals, identityPendingSources: 1, heldSources: 1})).toEqual({kind: 'attention', chip: 'Нужно внимание', title: 'Отправлено 4 из 6 рейсов', detail: '2 рейса пока не отправлены — подробности ниже.'});
  expect(sync('en', totals, {state: 'paused', error: 'NETWORK'})).toEqual({kind: 'offline', chip: 'No network', title: 'No network: uploading is paused', detail: 'Sent 4 of 6. Uploading resumes by itself when the network returns.'});
  expect(sync('ru', totals, {state: 'paused', error: 'TIMEOUT'})).toEqual({kind: 'offline', chip: 'Нет сети', title: 'Нет сети — отправка на паузе', detail: 'Отправлено 4 из 6. Отправка продолжится сама, когда сеть вернётся.'});
  expect(sync('en', totals, {state: 'paused', error: 'AUTHENTICATION'})).toEqual({kind: 'auth', chip: 'New token needed', title: 'Uploading stopped', detail: 'Sent 4 of 6. Uploading resumes after you enter a new token.'});
  expect(sync('ru', totals, {state: 'paused', error: 'CREDENTIAL_UNAVAILABLE'})).toEqual({kind: 'auth', chip: 'Нужен новый токен', title: 'Отправка остановлена', detail: 'Отправлено 4 из 6. Отправка продолжится после ввода нового токена.'});
  // Unknown totals: the states keep their meaning without inventing counts.
  expect(sync('en', {distinctSources: null, deliveredSources: null}, {state: 'paused', error: 'NETWORK'}).detail).toBe('Uploading resumes by itself when the network returns.');
  expect(sync('ru', {distinctSources: null, deliveredSources: null, heldSources: 1})).toMatchObject({kind: 'attention', title: 'Нужно внимание', detail: 'Подробности ниже.'});
  expect(uploadView(uiState(), 'en').chip).toBe('Not connected'); expect(uploadView(uiState(), 'ru').chip).toBe('Не подключено');
  for (const [n, ru] of [[1, 'Отправка: 0 из 1 рейса'], [2, 'Отправка: 0 из 2 рейсов'], [5, 'Отправка: 0 из 5 рейсов'], [21, 'Отправка: 0 из 21 рейса']] as const) expect(sync('ru', {...totals, distinctSources: n, deliveredSources: 0}).title).toBe(ru);
  expect(sync('en', {...totals, distinctSources: 1, deliveredSources: 0}).title).toBe('Uploading: 0 of 1 trip');
  const problems = (language: 'en' | 'ru', n: number) => uploadView(linked({...totals, identityPendingSources: n, heldSources: n}), language).sync!.problems.map(problem => problem.title);
  expect(problems('en', 1)).toEqual(['1 trip is waiting for its job to be confirmed', '1 trip is on hold']);
  expect(problems('en', 2)).toEqual(['2 trips are waiting for their jobs to be confirmed', '2 trips are on hold']);
  expect(problems('ru', 1)).toEqual(['1 рейс ждёт подтверждения заказа', '1 рейс приостановлен']);
  expect(problems('ru', 2)).toEqual(['2 рейса ждут подтверждения заказа', '2 рейса приостановлены']);
  expect(problems('ru', 5)).toEqual(['5 рейсов ждут подтверждения заказа', '5 рейсов приостановлены']);
  expect(problems('ru', 21)).toEqual(['21 рейс ждёт подтверждения заказа', '21 рейс приостановлен']);
});

// pendingSources is read on every status cycle and the totals only when a count completes: a new or changed trip found after
// the last count must not read as all sent. A change may still compare equal and send nothing, so the card says the trips
// are being prepared, without counts, and the chip stays the connected word.
it.each([
  ['en', 'Connected', 'Preparing new and changed trips', 'Runs in the background; you can keep driving.'],
  ['ru', 'Подключено', 'Подготовка новых и изменённых рейсов', 'Идёт в фоне — можно продолжать ездить.']
] as const)('REG-009/010 never reads as all sent while trips are pending in %s (ET-110)', (language, chip, title, detail) => {
  for (const counts of [{distinctSources: 6, deliveredSources: 6}, {distinctSources: 0, deliveredSources: 0}]) {
    const view = uploadView(linked({enumeration: 'complete', ...counts, pendingSources: 2}), language);
    expect(view).toMatchObject({chip, headline: chip, tone: 'ok', sync: {kind: 'preparing', title, detail, bar: 'indeterminate', problems: []}});
    const html = render(linked({enumeration: 'complete', ...counts, pendingSources: 2}), language);
    expect(html).not.toContain(copy('sync.done', language)); expect(html).not.toContain(copy('sync.empty', language));
    expect(html).toContain('data-kind="preparing"'); expect(html).toContain(title); expect(html).not.toMatch(/<progress[^>]*value=/);
  }
  // Once the next count includes them, the counted sending line and chip return.
  expect(uploadView(linked({enumeration: 'complete', distinctSources: 8, deliveredSources: 6, pendingSources: 2}), language)).toMatchObject({chip: language === 'en' ? 'Uploading 6 of 8' : 'Отправка 6 из 8', sync: {kind: 'syncing', bar: {percent: 75}}});
});

it.each(['en', 'ru'] as const)('REG-009/014 lists only real problems and links held trips to the Journal in %s', language => {
  const totals = {enumeration: 'complete' as const, distinctSources: 10, deliveredSources: 10};
  expect(uploadView(linked({...totals, pendingSources: 0, queuedEvents: 900}), language).sync).toMatchObject({kind: 'done', problems: []});
  const html = render(linked({...totals, pendingSources: 0, queuedEvents: 900}), language);
  expect(html).not.toContain('data-testid="account.problems"'); expect(html).not.toContain('900');
  const ids = (progress: Progress, change?: Partial<DashboardUploadStatus>) => uploadView(linked({...totals, ...progress}, change), language).sync!.problems.map(problem => [problem.id, problem.journal]);
  expect(ids({identityPendingSources: 1})).toEqual([['identity', false]]);
  expect(ids({heldSources: 3})).toEqual([['held', true]]);
  expect(ids({pressure: true})).toEqual([['pressure', false]]);
  expect(ids({}, {state: 'paused', error: 'RECONCILIATION'})).toEqual([['error', false]]);
  for (const error of ['NETWORK', 'TIMEOUT', 'AUTHENTICATION', 'CREDENTIAL_UNAVAILABLE'] as const) expect(ids({}, {state: 'paused', error})).toEqual([]);
  const held = render(linked({...totals, deliveredSources: 9, heldSources: 1, pressure: true}), language);
  expect(held).toContain('data-testid="account.problem.held"'); expect(held).toContain('data-testid="account.problem.pressure"');
  expect(held).toContain(`data-testid="account.openJournal">`); expect(held).not.toContain('<a ');
  expect(held).toContain(copy('problem.heldNote', language)); expect(held).toContain(copy('problem.pressureNote', language));
  expect(uploadView(linked(totals, {state: 'paused', error: 'RECONCILIATION'}), language)).toMatchObject({tone: 'error', sync: {kind: 'attention', tone: 'error'}});
  expect(uploadView(linked({...totals, heldSources: 1}), language)).toMatchObject({tone: 'warn', sync: {tone: 'warn'}});
});

it.each(['en', 'ru'] as const)('REG-009/010/014 renders one connection card, one upload card and collapsed details in %s', language => {
  const state = linked({enumeration: 'complete', distinctSources: 10, deliveredSources: 2, pendingSources: 8, queuedEvents: 900, lastDurableUploadUtcMs: 5000});
  const html = render(state, language);
  for (const id of ['account.status', 'account.firstSync', 'account.disconnect', 'account.details', 'account.lastUpload']) expect(html).toContain(`data-testid="${id}"`);
  for (const id of ['account.form', 'account.token.input', 'account.counts', 'account.explanation', 'account.token', 'account.disconnect.prompt']) expect(html).not.toContain(`data-testid="${id}"`);
  expect(html).toContain(`data-testid="account.phase">${copy('connectedTitle', language)}</h2>`);
  expect(html).toContain(`data-testid="account.origin">${origin}</p>`);
  expect(html).toMatch(/<details class="yu-account-details" data-testid="account.details"><summary>/); expect(html).not.toMatch(/<details[^>]*open/);
  for (const value of [owner.accountId, owner.companyId, owner.identityEpoch]) {expect(html).toContain(value); expect(outside(html, 'account.details')).not.toContain(value);}
  expect(html).toContain(copy('firstSync', language)); expect(html).not.toContain(copy('never', language));
  expect(html).not.toMatch(/queued events|enumerat|acceptance|accepted|событи|перечислен|принят/i);
  expect(html.match(/role="status"/g)).toHaveLength(1);
  expect(render(linked({lastDurableUploadUtcMs: null}), language)).toContain(`data-testid="account.lastUpload">${copy('never', language)}</span>`);
});

it.each(['en', 'ru'] as const)('REG-010/012 offers a token only without a working one, inside the connection card after an authentication failure in %s', language => {
  for (const error of DASHBOARD_UPLOAD_ERRORS.filter(error => error !== 'UNCONFIGURED')) {
    const html = render(linked({}, {state: 'paused', error}), language), replacement = ['AUTHENTICATION', 'CREDENTIAL_UNAVAILABLE'].includes(error);
    expect(html).toContain('data-testid="account.disconnect"'); expect(html.match(/role="status"/g)).toHaveLength(1); expect(html).not.toMatch(/⟦|undefined/);
    expect(html.includes('data-testid="account.form"'), error).toBe(replacement);
    // A status error of the connection is its state or a problem row, never a duplicated notice.
    expect(html).not.toContain('data-testid="account.error"');
    if (replacement) {
      expect(html.indexOf('data-testid="account.form"')).toBeGreaterThan(html.indexOf('data-testid="account.status"'));
      expect(html.indexOf('data-testid="account.form"')).toBeLessThan(html.indexOf('data-testid="account.firstSync"'));
      expect(html).toContain(copy('newToken', language)); expect(html).toContain(copy('replace', language)); expect(html).toContain(copy('replaceHint', language));
      expect(html).toContain(`data-testid="account.origin">${origin}</p>`);
      expect(html).toContain(copy(error === 'AUTHENTICATION' ? 'authTitle' : 'credentialTitle', language));
    } else if (!['NETWORK', 'TIMEOUT'].includes(error)) expect(html).toContain(copy(`error.${error}`, language));
  }
  expect(render(linked({}), language)).not.toContain('data-testid="account.form"');
  // A refused action is still a notice on the connected page.
  const refused = linked({}); refused.error = 'BUSY';
  expect(render(refused, language)).toContain(`data-testid="account.error">${copy('error.BUSY', language)}</p>`);
});

it.each(['en', 'ru'] as const)('REG-009/010/014 renders the setup steps, the separate history confirmation and the unavailable notice in %s', language => {
  const unavailable = render(unavailableUploadUi(), language);
  expect(unavailable).toContain(`data-testid="account.unconfigured">${copy('unconfigured', language)}</p>`);
  for (const control of ['account.form', 'account.confirmation', 'account.firstSync', 'account.disconnect', 'account.status']) expect(unavailable).not.toContain(`data-testid="${control}"`);
  const state = uiState(), disconnected = render(state, language);
  expect(disconnected).toContain('type="password"'); expect(disconnected).toContain('aria-pressed="false"');
  expect(disconnected.match(/<li>/g)).toHaveLength(3); for (const step of [1, 2, 3]) expect(disconnected).toContain(copy(`step${step}`, language));
  expect(disconnected).toContain(`data-testid="account.verify">${copy('save', language)}</button>`); expect(disconnected).toContain(origin);
  expect(disconnected).not.toContain(copy('replaceHint', language)); expect(disconnected).not.toContain('aria-describedby');
  expect(disconnected).not.toContain('data-testid="account.confirm"'); expect(disconnected).not.toContain('data-testid="account.details"');
  state.status = {...state.status!, state: 'confirmation-required', owner, candidateId};
  const confirmation = render(state, language);
  for (const value of Object.values(owner)) expect(confirmation).toContain(value);
  for (const key of ['confirmTitle', 'scope', 'binding', 'historyDriver', 'preview', 'confirm', 'cancel']) expect(confirmation).toContain(copy(key, language));
  expect(confirmation).not.toContain('data-testid="account.form"'); expect(confirmation).not.toContain('<progress'); expect(confirmation).not.toMatch(/accepted|принят/);
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
  const cancelled = uiState(); cancelled.status!.error = 'CANCELLED';
  expect(render(cancelled, language)).toContain(`data-testid="account.error">${copy('error.CANCELLED', language)}</p>`);
  const disconnecting = linked({}); disconnecting.phase = 'disconnecting';
  const html = render(disconnecting, language);
  expect(html).toContain(`data-testid="account.phase">${copy('state.disconnecting', language)}</h2>`); expect(html).toContain('disabled="" data-testid="account.disconnect"');
});

it.each(['en', 'ru'] as const)('REG-012 keeps replacement verification cancellation and recovery inside the authentication layout in %s', language => {
  for (const error of ['AUTHENTICATION', 'CREDENTIAL_UNAVAILABLE'] as const) {
    const state = linked({}, {state: 'paused', error}); state.phase = 'verifying';
    const verifying = render(state, language);
    expect(verifying).toContain('data-testid="account.status"');
    expect(verifying).toContain(`data-testid="account.phase">${copy('state.verifying', language)}</h2>`);
    expect(verifying).toContain(`data-testid="account.cancel">${copy('cancel', language)}</button>`);
    expect(verifying).not.toContain('data-testid="account.form"');
    expect(verifying).toContain('disabled="" data-testid="account.disconnect"');
    state.abandoned = true;
    expect(render(state, language)).toContain(`disabled="" data-testid="account.cancel">${copy('cancel', language)}</button>`);
    state.phase = 'cancel-failed'; state.error = 'RETIRED';
    const recovery = render(state, language);
    expect(recovery).toContain(`data-testid="account.cancel">${copy('retryCancel', language)}</button>`);
    expect(recovery).toContain(copy('error.RETIRED', language));
    expect(recovery).not.toContain('data-testid="account.form"');
  }
});
it.each(['en', 'ru'] as const)('REG-014 maps only authoritative row states to localized badges in %s', language => {
  for (const state of ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent'] as const) {
    const view = journalSyncView({tripUuid: '', state, materialVersion: null, latestRevision: null, lastDurableUploadUtcMs: null, reason: state === 'held' ? 'validation' : null}, language);
    expect(view.text).not.toMatch(/⟦|accepted|принят/); expect(view.tone).toBe(state === 'sent' ? 'ok' : state === 'held' ? 'error' : ['unavailable', 'unbound'].includes(state) ? 'neutral' : 'warn');
  }
});
