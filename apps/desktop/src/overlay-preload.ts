import {contextBridge, ipcRenderer} from 'electron';
import type {OverlayBridge, OverlayPresentation} from '../../../packages/contracts/src';
import {overlayGauges, overlayUrgency, staleOverlay} from './overlay-sections';
import {RecoveryBudget} from './recovery-budget';

let listener: ((update: OverlayPresentation) => void) | undefined;
let port: MessagePort | undefined;
let owner = Symbol();
let recovery: ReturnType<typeof setTimeout> | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let budget = new RecoveryBudget();
const unavailable: OverlayPresentation = {source: 'No game', origin: 'none', status: 'waiting', speed: '—', fuel: '—', speedUnit: 'km/h', fuelUnit: 'L', freshness: 'unavailable',
  layout: 'strip', paused: false, sections: [], editing: false};
let current = unavailable;
function close(): void {const previous = port; port = undefined; previous?.close(); clearTimeout(expiry); expiry = undefined;}
// Stale keeps the layout and the section list, each section as an unavailable placeholder, so nothing old looks current.
function invalidate(): void {current = staleOverlay(current); listener?.(current);}
function recover(generation: symbol): void {
  if (generation !== owner || !listener || port || recovery !== undefined) return;
  if (budget.take() === undefined) {
    // Keep one cancellable wait; a quiet document can recover after the sliding budget expires.
    recovery = setTimeout(() => {recovery = undefined; recover(generation);}, 60000);
    return;
  }
  recovery = setTimeout(() => {recovery = undefined; if (generation === owner && listener && !port) ipcRenderer.send('overlay:subscribe');}, 250);
}
function lost(next: MessagePort): void {
  if (port !== next || !listener) return;
  const generation = owner; close(); invalidate();
  if (generation !== owner || !listener) return;
  ipcRenderer.send('overlay:unsubscribe');
  recover(generation);
}
ipcRenderer.on('overlay:port', event => {
  clearTimeout(recovery); recovery = undefined; close(); invalidate();
  if (!listener || event.ports.length !== 1) {for (const incoming of event.ports) incoming.close(); return;}
  const next = port = event.ports[0];
  next.addEventListener('close', () => lost(next)); next.onmessageerror = () => lost(next);
  next.onmessage = (event: MessageEvent<{type?: string; delivery?: number; update?: OverlayPresentation} | undefined>) => {
    if (port !== next) return;
    const data = event.data;
    if (!listener || !data || data.type !== 'live' || !Number.isSafeInteger(data.delivery) || data.delivery! < 1 || !data.update) {lost(next); return;}
    // ET-045f: only valid gauge fractions reach the renderer; a malformed one is dropped without dropping the update.
    // ET-052: likewise the break urgency, allowed only on a current mandatory-break value.
    clearTimeout(expiry); current = overlayUrgency(overlayGauges(data.update));
    // The read-only projection has no native coordinates or SDK state. Main owns both expiry gates.
    if (current.freshness === 'current') expiry = setTimeout(() => {expiry = undefined; invalidate();}, 500);
    try {listener(current);} finally {if (port === next) {try {next.postMessage({type: 'consumed', delivery: data.delivery});} catch {lost(next);}}}
  };
  next.start();
});
const bridge: OverlayBridge = {
  subscribeOverlay: callback => {
    if (typeof callback !== 'function' || listener) throw new Error('One overlay subscription is allowed');
    owner = Symbol(); listener = callback; budget = new RecoveryBudget(); current = unavailable; ipcRenderer.send('overlay:subscribe');
    let active = true;
    return () => {if (!active) return; active = false; owner = Symbol(); listener = undefined; clearTimeout(recovery); recovery = undefined; close(); ipcRenderer.send('overlay:unsubscribe');};
  }
};
contextBridge.exposeInMainWorld('overlay', Object.freeze(bridge));
