import {expect, it} from 'vitest';
import {DASHBOARD_UPLOAD_ERRORS, initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {uploadView, journalSyncView} from '../../apps/desktop/src/dashboard-upload/view';
import {unavailableUploadUi} from '../../apps/desktop/src/dashboard-upload/ui-controller';
it.each(['en', 'ru'] as const)('REG-009/010/014 distinguishes availability, candidate and actual connection in %s', language => {
  const ui = unavailableUploadUi(); expect(uploadView(ui, language)).toMatchObject({available: false, canEnterToken: false, percent: null});
  ui.status = initialDashboardUploadStatus('https://dashboard.example'); expect(uploadView(ui, language)).toMatchObject({available: true, canEnterToken: true, connected: false});
  const unknown = uploadView(ui, language); ui.status.progress = {...ui.status.progress, enumeration: 'complete', distinctSources: 0, deliveredSources: 0, lastDurableUploadUtcMs: 0};
  expect(uploadView(ui, language).distinct).toBe('0'); expect(uploadView(ui, language).lastUpload).not.toBe(unknown.lastUpload);
  ui.status.progress = {...ui.status.progress, distinctSources: 10, deliveredSources: 2, queuedEvents: 900}; expect(uploadView(ui, language).percent).toBe(20);
  ui.status.progress.enumeration = 'changing'; expect(uploadView(ui, language).percent).toBeNull();
  for (const error of DASHBOARD_UPLOAD_ERRORS) {ui.error = error; expect(uploadView(ui, language).error).not.toMatch(/⟦|undefined|accepted|принят/);}
});
it.each(['en', 'ru'] as const)('REG-014 maps only authoritative row states to localized badges in %s', language => {
  for (const state of ['unavailable', 'unbound', 'identity-pending', 'pending', 'queued', 'sending', 'held', 'sent'] as const) {
    const view = journalSyncView({tripUuid: '', state, materialVersion: null, latestRevision: null, lastDurableUploadUtcMs: null, reason: state === 'held' ? 'validation' : null}, language);
    expect(view.text).not.toMatch(/⟦|accepted|принят/); expect(view.tone).toBe(state === 'sent' ? 'ok' : state === 'held' ? 'error' : ['unavailable', 'unbound'].includes(state) ? 'neutral' : 'warn');
  }
});
