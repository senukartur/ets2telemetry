import {expect, it, vi} from 'vitest';
import {uploadView} from '../../apps/desktop/src/dashboard-upload/view';
import {initialDashboardUploadStatus, type DashboardUploadBridge, type DashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {DashboardUploadUiController} from '../../apps/desktop/src/dashboard-upload/ui-controller';
const origin = 'https://dashboard.example', owner = {origin, accountId: 'a', companyId: 'c', identityEpoch: 'e'};
const token = `vtc1_10000000-0000-4000-8000-000000000001_${'a'.repeat(43)}`;
const candidate: DashboardUploadStatus = {...initialDashboardUploadStatus(origin), state: 'confirmation-required', owner, candidateId: '20000000-0000-4000-8000-000000000001'};
const connected: DashboardUploadStatus = {...initialDashboardUploadStatus(origin), state: 'connected', owner};
function deferred<T>() {let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((a, b) => {resolve = a; reject = b;}); return {promise, resolve, reject};}
function fixture() {
  const context = deferred<DashboardUploadStatus>(), verify = deferred<DashboardUploadStatus>(), cancel = deferred<DashboardUploadStatus>(), confirm = deferred<DashboardUploadStatus>(), disconnect = deferred<DashboardUploadStatus>();
  let notify!: (status: DashboardUploadStatus) => void;
  const order: string[] = [], bridge: DashboardUploadBridge = {
    getDashboardUploadContext: vi.fn(() => {order.push('context'); return context.promise;}),
    subscribeDashboardUpload: vi.fn(listener => {order.push('subscribe'); notify = listener; return vi.fn();}),
    verifyDashboardUploadToken: vi.fn(() => verify.promise), cancelDashboardUpload: vi.fn(() => cancel.promise),
    confirmDashboardUpload: vi.fn(() => confirm.promise), disconnectDashboardUpload: vi.fn(() => disconnect.promise)
  };
  const controller = new DashboardUploadUiController(bridge); controller.start(); controller.setAccountActive(true);
  return {controller, bridge, order, context, verify, cancel, confirm, disconnect, notify: (status: DashboardUploadStatus) => notify(status)};
}
it('REG-010/012 subscribes before context and fences stale context and action replies against notifications', async () => {
  const f = fixture(); expect(f.order).toEqual(['subscribe', 'context']);
  f.notify(initialDashboardUploadStatus(origin)); f.context.resolve(initialDashboardUploadStatus(null)); await Promise.resolve();
  expect(f.controller.getSnapshot().status?.origin).toBe(origin);
  const pending = f.controller.verify(token); f.notify(connected); f.verify.resolve({...initialDashboardUploadStatus(origin), error: 'AUTHENTICATION'}); await pending;
  expect(f.controller.getSnapshot()).toMatchObject({status: connected, error: null, phase: 'idle'});
});
it('REG-010/012 cancels an abandoned candidate once and keeps the operation settling across navigation', async () => {
  const f = fixture(); f.notify(initialDashboardUploadStatus(origin));
  const pending = f.controller.verify(token); expect(await f.controller.verify(token)).toBe(false);
  f.controller.setAccountActive(false); f.controller.setAccountActive(true);
  f.verify.resolve(candidate); await Promise.resolve();
  expect(f.bridge.cancelDashboardUpload).toHaveBeenCalledExactlyOnceWith(candidate.candidateId);
  expect(f.controller.getSnapshot()).toMatchObject({phase: 'cancelling', abandoned: true});
  expect(await f.controller.verify(token)).toBe(false);
  f.cancel.resolve(initialDashboardUploadStatus(origin)); await pending;
  expect(f.controller.getSnapshot()).toMatchObject({phase: 'idle', status: {candidateId: null}});
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(token);
});
it('REG-010/012 preserves explicit confirmation across navigation and offers disconnect after settlement', async () => {
  const f = fixture(); f.notify(candidate); const pending = f.controller.confirm(); f.controller.setAccountActive(false);
  expect(f.bridge.confirmDashboardUpload).toHaveBeenCalledExactlyOnceWith(candidate.candidateId);
  expect(f.bridge.cancelDashboardUpload).not.toHaveBeenCalled();
  f.confirm.resolve(connected); await pending;
  const disconnect = f.controller.disconnect(); expect(f.controller.getSnapshot().phase).toBe('disconnecting');
  f.disconnect.resolve(initialDashboardUploadStatus(origin)); await disconnect;
  expect(f.controller.getSnapshot().status?.state).toBe('disconnected');
});
it('REG-010/012 validates without rewriting a token and rejects concurrent or unavailable drafts', async () => {
  const f = fixture(); f.notify(initialDashboardUploadStatus(null)); expect(await f.controller.verify(token)).toBe(false);
  f.notify(initialDashboardUploadStatus(origin)); expect(await f.controller.verify(` ${token}`)).toBe(false); expect(f.bridge.verifyDashboardUploadToken).not.toHaveBeenCalled();
  const pending = f.controller.verify(token); f.verify.reject(Error(token)); await pending;
  expect(f.controller.getSnapshot()).toMatchObject({phase: 'idle', error: 'RETIRED'}); expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(token);
});
it('REG-010/012 retains cancellation refusal until explicit retry and ignores retired document answers', async () => {
  const f = fixture(); f.notify(candidate); const pending = f.controller.cancel(); f.cancel.reject(Error('private')); await pending;
  expect(f.controller.getSnapshot().phase).toBe('cancel-failed'); expect(await f.controller.verify(token)).toBe(false);
  f.controller.stop(); f.notify(connected); expect(f.controller.getSnapshot().status).toEqual(candidate);
});

it('REG-010/012 cancels only the returned confirmation UUID and restores authoritative prior connection after settlement', async () => {
  const f = fixture(); f.notify(candidate); const pending = f.controller.cancel();
  await f.controller.confirm(); expect(f.bridge.confirmDashboardUpload).not.toHaveBeenCalled(); expect(f.bridge.cancelDashboardUpload).toHaveBeenCalledExactlyOnceWith(candidate.candidateId);
  f.cancel.resolve(connected); await pending; expect(f.controller.getSnapshot()).toMatchObject({phase: 'idle', abandoned: false, status: connected});
});
it.each(['unavailable', 'disconnected', 'verifying', 'confirmation-required', 'connecting', 'connected', 'paused', 'stopping'] as const)('REG-010/012 aligns form and controller admission for %s', async state => {
  const f = fixture(), status = {...initialDashboardUploadStatus(origin), state, ...(state === 'connected' ? {owner} : state === 'confirmation-required' ? {owner, candidateId: candidate.candidateId} : {})};
  f.notify(status); const allowed = state === 'disconnected' || state === 'connected' || state === 'paused';
  expect(uploadView(f.controller.getSnapshot(), 'en').canEnterToken).toBe(allowed);
  const result = f.controller.verify(token);
  if (allowed) {f.verify.resolve(initialDashboardUploadStatus(origin)); expect(await result).toBe(true); expect(f.bridge.verifyDashboardUploadToken).toHaveBeenCalledExactlyOnceWith(token);}
  else {expect(await result).toBe(false); expect(f.bridge.verifyDashboardUploadToken).not.toHaveBeenCalled(); expect(uploadView(f.controller.getSnapshot(), 'en').error).toBeTruthy();}
  expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(token); f.controller.stop();
});
it('REG-010/012 gives fixed nonsecret feedback when a service notification retires a visible token form before submission', async () => {
  const f = fixture(); f.notify(initialDashboardUploadStatus(origin)); expect(uploadView(f.controller.getSnapshot(), 'en').canEnterToken).toBe(true);
  f.notify({...initialDashboardUploadStatus(origin), state: 'unavailable'}); expect(await f.controller.verify(token)).toBe(false);
  const state = f.controller.getSnapshot(); expect(state.error).toBe('RETIRED'); expect(uploadView(state, 'en')).toMatchObject({available: true, canEnterToken: false, error: expect.stringContaining('restarted')});
  expect(f.bridge.verifyDashboardUploadToken).not.toHaveBeenCalled(); expect(JSON.stringify(state)).not.toContain(token); f.controller.stop();
});
