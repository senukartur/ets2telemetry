import {contextBridge, ipcRenderer} from 'electron';
import type {DesktopBridge, LiveTelemetry} from '../../../packages/contracts/src';
import {initialLive, sourceSelection} from './live-state';
import {RecoveryBudget} from './recovery-budget';
let listener: ((update: LiveTelemetry) => void) | undefined;
let port: MessagePort | undefined;
let current: LiveTelemetry = initialLive();
let freshness: ReturnType<typeof setTimeout> | undefined;
let recovery: ReturnType<typeof setTimeout> | undefined;
let recoveryBudget = new RecoveryBudget();
let subscription = Symbol();
function clearFreshness(): void {clearTimeout(freshness); freshness = undefined;}
function clearRecovery(): void {clearTimeout(recovery); recovery = undefined;}
function closePort(): void {const previous = port; port = undefined; previous?.close();}
function stale(reason: string): void {
  clearFreshness(); current = {...current, status: 'stale', fresh: false, reason}; listener?.(current);
}
function publish(update: LiveTelemetry): void {
  clearFreshness(); current = update;
  // Quiet but open channels stay subscribed. Data expiry is separate from transport recovery.
  if (update.fresh) freshness = setTimeout(() => stale('Renderer has no recent current observation'), 500);
  listener?.(update);
}
function lost(next: MessagePort): void {
  if (port !== next || !listener) return;
  const owner = subscription;
  closePort(); stale('Live subscription closed; current interval is unknown');
  if (subscription !== owner || !listener) return;
  ipcRenderer.send('telemetry:unsubscribe');
  if (recoveryBudget.take() === undefined) return;
  recovery = setTimeout(() => {recovery = undefined; if (subscription === owner && listener && !port) ipcRenderer.send('telemetry:subscribe');}, 250);
}
ipcRenderer.on('telemetry:port', event => {
  clearRecovery(); clearFreshness(); closePort(); const next = event.ports[0];
  if (listener && current.fresh) stale('Replacement live subscription awaits a current observation');
  if (!listener || event.ports.length !== 1) {for (const incoming of event.ports) incoming.close(); return;}
  port = next;
  // Electron's renderer MessagePort includes the documented close-event extension.
  next.addEventListener('close', () => lost(next));
  next.onmessageerror = () => lost(next);
  next.onmessage = event => {
    if (port !== next) return;
    const data = event.data;
    if (!listener || !data || data.type !== 'live' || !Number.isSafeInteger(data.delivery) || data.delivery < 1) {lost(next); return;}
    // Credits acknowledge callback consumption only, never persistence or a v0 wire message.
    try {publish(data.update);} finally {if (port === next) {try {next.postMessage({type: 'consumed', delivery: data.delivery});} catch {lost(next);}}}
  };
  next.start();
});
ipcRenderer.on('telemetry:service-state', (_event, update: LiveTelemetry) => {
  const owner = subscription;
  clearRecovery(); closePort(); publish(update);
  // Remote close can clear main's intent before its failure notification arrives. Reassert only the active owner.
  if (listener && subscription === owner && (update.status === 'service-failed' || update.status === 'restarting')) ipcRenderer.send('telemetry:subscribe');
});
const bridge: DesktopBridge = {
  getStatus: () => ipcRenderer.invoke('scaffold:status'),
  selectSource: source => {
    try {return ipcRenderer.invoke('telemetry:select', sourceSelection(source));}
    catch (error) {return Promise.reject(error);}
  },
  subscribeLive: callback => {
    if (typeof callback !== 'function' || listener) throw new Error('One live subscription is allowed');
    subscription = Symbol(); listener = callback; current = initialLive(); recoveryBudget = new RecoveryBudget(); ipcRenderer.send('telemetry:subscribe');
    let active = true;
    return () => {if (!active) return; active = false; subscription = Symbol(); listener = undefined; clearFreshness(); clearRecovery(); closePort(); ipcRenderer.send('telemetry:unsubscribe');};
  }
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));
