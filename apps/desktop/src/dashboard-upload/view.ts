import type {AppLanguage} from '../../../../packages/contracts/src';
import type {DashboardUploadError, DashboardUploadStatus} from '../../../../packages/contracts/src/dashboard-upload';
import type {JournalSyncRow} from '../../../../packages/contracts/src/journal';
import {t, type I18nKey} from '../i18n';
import {canVerifyDashboardUpload, type UploadUiState} from './ui-controller';

type UploadTone = 'error' | 'warn' | 'ok' | 'neutral';
export type UploadSyncKind = 'counting' | 'empty' | 'done' | 'syncing' | 'attention' | 'offline' | 'auth';
/** A known share with its fill colour, an indeterminate first count, or no bar at all. */
export type UploadSyncBar = {percent: number; fill: 'accent' | 'ok' | 'paused'} | 'indeterminate' | null;
export interface UploadProblem {id: 'identity' | 'held' | 'pressure' | 'error'; title: string; detail: string | null; journal: boolean}
export interface UploadSyncView {kind: UploadSyncKind; tone: UploadTone | 'info'; title: string; detail: string; bar: UploadSyncBar; lastUpload: string; problems: UploadProblem[]}

const LOCALES: Record<AppLanguage, string> = {en: 'en-GB', ru: 'ru-RU'};
const AUTH_ERRORS: readonly DashboardUploadError[] = ['AUTHENTICATION', 'CREDENTIAL_UNAVAILABLE'];
const OFFLINE_ERRORS: readonly DashboardUploadError[] = ['NETWORK', 'TIMEOUT'];
const SEVERE_ERRORS: readonly DashboardUploadError[] = ['RECONCILIATION', 'CONFIGURATION', 'UNSUPPORTED_CONTRACT'];
const SOFT_ERRORS: readonly string[] = ['UNCONFIGURED', 'CANCELLED', 'NETWORK', 'TIMEOUT', 'BUSY', 'RETIRED'];

/**
 * ET-110: the upload card shows one result. Known totals are the last complete count and stay until a newer count replaces
 * them, whatever the enumeration phase; only a first count without totals reads as counting. Priority: authentication,
 * then offline, then real problems, then counting, no trips, all sent and sending.
 */
function syncView(status: DashboardUploadStatus, language: AppLanguage): UploadSyncView {
  const p = status.progress, error = status.error;
  const text = (key: string, vars?: Record<string, string | number>) => t(`upload.${key}` as I18nKey, vars, language);
  const plural = (key: string, n: number, vars: Record<string, string | number>) => text(`${key}.${new Intl.PluralRules(LOCALES[language]).select(n)}`, vars);
  const known = p.distinctSources !== null && p.deliveredSources !== null;
  const total = p.distinctSources ?? 0, delivered = Math.min(p.deliveredSources ?? 0, total), counts = {delivered, total};
  const share = (fill: 'accent' | 'ok' | 'paused'): UploadSyncBar => known && total > 0 ? {percent: Math.min(100, delivered / total * 100), fill} : null;
  const problems: UploadProblem[] = [];
  if (p.identityPendingSources > 0) problems.push({id: 'identity', title: plural('problem.identity', p.identityPendingSources, {n: p.identityPendingSources}), detail: text('problem.identityNote'), journal: false});
  if (p.heldSources > 0) problems.push({id: 'held', title: plural('problem.held', p.heldSources, {n: p.heldSources}), detail: text('problem.heldNote'), journal: true});
  if (p.pressure) problems.push({id: 'pressure', title: text('problem.pressure'), detail: text('problem.pressureNote'), journal: false});
  const auth = !!error && AUTH_ERRORS.includes(error), offline = !!error && OFFLINE_ERRORS.includes(error);
  if (error && !auth && !offline) problems.push({id: 'error', title: text(`error.${error}`), detail: null, journal: false});
  const lastUpload = p.lastDurableUploadUtcMs === null ? text('never')
    : text('lastUpload', {time: new Intl.DateTimeFormat(LOCALES[language], {dateStyle: 'medium', timeStyle: 'short'}).format(p.lastDurableUploadUtcMs)});
  const view = (kind: UploadSyncKind, tone: UploadSyncView['tone'], title: string, detail: string, bar: UploadSyncBar): UploadSyncView => ({kind, tone, title, detail, bar, lastUpload, problems});
  if (auth) return view('auth', 'error', text('sync.auth'), known ? text('sync.authNote', counts) : text('sync.authUnknown'), share('paused'));
  if (offline) return view('offline', 'warn', text('sync.offline'), known ? text('sync.offlineNote', counts) : text('sync.offlineUnknown'), share('paused'));
  if (problems.length) return view('attention', error && SEVERE_ERRORS.includes(error) ? 'error' : 'warn', known ? plural('sync.attention', total, counts) : text('chip.attention'),
    known && total > delivered ? plural('sync.remaining', total - delivered, {n: total - delivered}) : text('sync.attentionNote'), share('accent'));
  if (!known) return view('counting', 'neutral', text('sync.counting'), text('sync.countingNote'), 'indeterminate');
  if (total === 0) return view('empty', 'ok', text('sync.empty'), text('sync.emptyNote'), null);
  if (delivered === total) return view('done', 'ok', text('sync.done'), text('sync.doneNote', counts), share('ok'));
  return view('syncing', 'info', plural('sync.syncing', total, counts), text('sync.syncingNote'), share('accent'));
}

export function uploadView(ui: UploadUiState, language: AppLanguage) {
  const status = ui.status;
  const text = (key: string, vars?: Record<string, string | number>) => t(`upload.${key}` as I18nKey, vars, language);
  const error = ui.error ?? status?.error;
  const busy = ui.phase !== 'idle';
  const state = busy ? ui.phase : status?.state ?? 'loading';
  const connected = !!status?.owner && ['connected', 'paused'].includes(status.state) && !status.candidateId;
  const sync = connected ? syncView(status, language) : null;
  const canEnterToken = canVerifyDashboardUpload(ui);
  // The chip and the live region name the state; only the chip repeats the sending count, so progress is never re-announced.
  const stateText = text(`state.${state}`);
  const chip = busy || !sync ? stateText : sync.kind === 'auth' ? text('chip.auth') : sync.kind === 'offline' ? text('chip.offline') : sync.kind === 'attention' ? text('chip.attention')
    : sync.kind === 'syncing' ? text('chip.syncing', {delivered: status!.progress.deliveredSources!, total: status!.progress.distinctSources!}) : text('state.connected');
  const headline = sync?.kind === 'syncing' && !busy ? text('state.connected') : chip;
  const tone: UploadTone = sync && !busy ? (sync.kind === 'auth' ? 'error' : sync.kind === 'offline' ? 'warn' : sync.kind === 'attention' ? (sync.tone === 'error' ? 'error' : 'warn') : 'ok')
    : error && !SOFT_ERRORS.includes(error) ? 'error'
    : (busy && ui.phase !== 'verifying') || error || status?.state === 'confirmation-required' || status?.state === 'connecting' ? 'warn' : 'neutral';
  const credential = status?.error === 'CREDENTIAL_UNAVAILABLE';
  return {
    available: !!status?.origin, busy, tone, headline, chip,
    error: error ? text(`error.${error}`) : null,
    // Every status error of a connection is shown as its state or a problem row; a refused action still needs its notice.
    showError: !!error && !!status?.origin && (!connected || (ui.error !== null && ui.error !== status.error)),
    canEnterToken,
    confirming: status?.state === 'confirmation-required' && !!status.candidateId && !ui.abandoned,
    connected,
    tokenReplacement: connected && canEnterToken,
    connectionTitle: busy ? stateText : sync?.kind === 'auth' ? text(credential ? 'credentialTitle' : 'authTitle') : text('connectedTitle'),
    connectionNote: sync?.kind === 'auth' ? text(credential ? 'error.CREDENTIAL_UNAVAILABLE' : 'authNote') : null,
    sync
  };
}
export function journalSyncView(row: JournalSyncRow, language: AppLanguage): {text: string; tone: UploadTone; hint: string} {
  return {text: t(`upload.row.${row.state}`, undefined, language),
    tone: (row.state === 'sent' ? 'ok' : row.state === 'held' ? 'error' : ['queued', 'sending', 'pending', 'identity-pending'].includes(row.state) ? 'warn' : 'neutral'),
    hint: t(row.reason ? `upload.rowReason.${row.reason}` : 'upload.assessed', undefined, language)};
}
