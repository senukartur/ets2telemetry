import type {AppLanguage} from '../../../../packages/contracts/src';
import type {JournalSyncRow} from '../../../../packages/contracts/src/journal';
import {t, type I18nKey} from '../i18n';
import type {UploadUiState} from './ui-controller';

export function uploadView(ui: UploadUiState, language: AppLanguage) {
  const status = ui.status, p = status?.progress;
  const text = (key: string) => t(`upload.${key}` as I18nKey, undefined, language);
  const error = ui.error ?? status?.error;
  const busy = ui.phase !== 'idle';
  const state = busy ? ui.phase : status?.state ?? 'loading';
  const tone = error && !['UNCONFIGURED', 'CANCELLED', 'NETWORK', 'TIMEOUT', 'BUSY', 'RETIRED'].includes(error) ? 'error' :
    busy || error || (p && (p.pendingSources || p.identityPendingSources || p.heldSources || p.pressure)) || status?.state === 'paused' ? 'warn' : status?.state === 'connected' ? 'ok' : 'neutral';
  const known = p?.enumeration === 'complete' && p.distinctSources !== null && p.deliveredSources !== null;
  return {
    available: !!status?.origin, busy, tone: tone as 'error' | 'warn' | 'ok' | 'neutral', headline: text(`state.${state}`),
    error: error ? text(`error.${error}`) : null,
    canEnterToken: !!status?.origin && !status.candidateId && !busy && !['verifying', 'connecting', 'stopping'].includes(status.state),
    confirming: status?.state === 'confirmation-required' && !!status.candidateId && !ui.abandoned,
    connected: !!status?.owner && ['connected', 'paused'].includes(status.state) && !status.candidateId,
    enumeration: p ? text(`enumeration.${p.enumeration}`) : text('state.loading'),
    delivered: p?.deliveredSources === null || !p ? text('unknown') : String(p.deliveredSources),
    distinct: p?.distinctSources === null || !p ? text('unknown') : String(p.distinctSources),
    percent: known ? p.distinctSources === 0 ? 0 : Math.min(100, p.deliveredSources! / p.distinctSources! * 100) : null,
    lastUpload: p?.lastDurableUploadUtcMs == null ? text('never') : new Intl.DateTimeFormat(language === 'ru' ? 'ru-RU' : 'en-GB', {dateStyle: 'medium', timeStyle: 'short'}).format(p.lastDurableUploadUtcMs)
  };
}
export function journalSyncView(row: JournalSyncRow, language: AppLanguage) {
  return {text: t(`upload.row.${row.state}` as I18nKey, undefined, language),
    tone: (row.state === 'sent' ? 'ok' : row.state === 'held' ? 'error' : ['queued', 'sending', 'pending', 'identity-pending'].includes(row.state) ? 'warn' : 'neutral') as 'ok' | 'warn' | 'error' | 'neutral',
    hint: t((row.reason ? `upload.rowReason.${row.reason}` : 'upload.assessed') as I18nKey, undefined, language)};
}
