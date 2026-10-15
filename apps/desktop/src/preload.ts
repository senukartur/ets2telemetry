import {contextBridge, ipcRenderer} from 'electron';
import type {AppState, DesktopBridge, LiveTelemetry} from '../../../packages/contracts/src';
import {initialLive, sourceSelection} from './live-state';
import {RecoveryBudget} from './recovery-budget';
import {isOverlayLayout, parseOverlaySections} from './overlay-sections';
import {isUnitGame, isUnitProfile} from './unit-profiles';
let listener: ((update: LiveTelemetry) => void) | undefined;
let port: MessagePort | undefined;
let current: LiveTelemetry = initialLive();
let freshness: ReturnType<typeof setTimeout> | undefined;
let windowFreshness: ReturnType<typeof setTimeout> | undefined;
let sdkReceiptKey: string | undefined;
let sdkExpiry = 0;
let windowReceiptKey: string | undefined;
let windowExpiry = 0;
let recovery: ReturnType<typeof setTimeout> | undefined;
let recoveryBudget = new RecoveryBudget();
let subscription = Symbol();
function clearFreshness(): void {clearTimeout(freshness); freshness = undefined; clearTimeout(windowFreshness); windowFreshness = undefined;}
function clearRecovery(): void {clearTimeout(recovery); recovery = undefined;}
function closePort(): void {const previous = port; port = undefined; previous?.close();}
function stale(reason: string): void {
  clearFreshness(); current = {...current, status: 'stale', fresh: false, reason,
    ...(current.observation ? {observation: {...current.observation, windowFresh: false}} : {})}; listener?.(current);
}
function publish(update: LiveTelemetry): void {
  clearFreshness(); current = update;
  const now = performance.now(), observation = update.observation;
  const sourceKey = observation ? `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.capture.clockId}` : undefined;
  const sdkKey = observation ? `${sourceKey}|${observation.capture.monotonicNs}|${observation.receivedMonotonicMs}` : undefined;
  if (!observation || sdkKey !== sdkReceiptKey) {sdkReceiptKey = sdkKey; sdkExpiry = now + 500;}
  const windowKey = observation ? `${sourceKey}|${observation.windowReceivedMonotonicMs}` : undefined;
  if (!observation || windowKey !== windowReceiptKey) {windowReceiptKey = windowKey; windowExpiry = now + 250;}
  // Quiet but open channels stay subscribed. Data expiry is separate from transport recovery.
  if (update.fresh) {
    if (now >= sdkExpiry) current = {...current, status: 'stale', fresh: false, reason: 'Renderer has no recent SDK capture'};
    else freshness = setTimeout(() => {
      freshness = undefined; current = {...current, status: 'stale', fresh: false, reason: 'Renderer has no recent SDK capture'}; listener?.(current);
    }, sdkExpiry - now);
  }
  if (observation?.windowFresh) {
    if (now >= windowExpiry) current = {...current, observation: {...observation, windowFresh: false}};
    else windowFreshness = setTimeout(() => {
      windowFreshness = undefined;
      if (current.observation) {current = {...current, observation: {...current.observation, windowFresh: false}}; listener?.(current);}
    }, windowExpiry - now);
  }
  listener?.(current);
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
  if (listener && (current.fresh || current.observation?.windowFresh)) stale('Replacement live subscription awaits a current observation');
  if (!listener || event.ports.length !== 1) {for (const incoming of event.ports) incoming.close(); return;}
  port = next;
  // Electron's renderer MessagePort includes the documented close-event extension.
  next.addEventListener('close', () => lost(next));
  next.onmessageerror = () => lost(next);
  // This private port is supplied by main; its update payload is produced by the typed service.
  next.onmessage = (event: MessageEvent<{type: string; delivery: number; update: LiveTelemetry} | undefined>) => {
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
let appStateListener: ((state: AppState) => void) | undefined;
// Main pushes fixed health codes only after this document subscribed through the trusted main frame.
ipcRenderer.on('app:state', (_event, state: AppState) => {appStateListener?.(state);});
const bridge: DesktopBridge = {
  getStatus: () => ipcRenderer.invoke('scaffold:status'),
  selectSource: source => {
    try {return ipcRenderer.invoke('telemetry:select', sourceSelection(source));}
    catch (error) {return Promise.reject(error instanceof Error ? error : new Error('Invalid source selection'));}
  },
  subscribeLive: callback => {
    if (typeof callback !== 'function' || listener) throw new Error('One live subscription is allowed');
    subscription = Symbol(); listener = callback; current = initialLive(); sdkReceiptKey = windowReceiptKey = undefined; recoveryBudget = new RecoveryBudget(); ipcRenderer.send('telemetry:subscribe');
    let active = true;
    return () => {if (!active) return; active = false; subscription = Symbol(); listener = undefined; clearFreshness(); clearRecovery(); closePort(); ipcRenderer.send('telemetry:unsubscribe');};
  },
  getAppState: () => ipcRenderer.invoke('app:get-state'),
  subscribeAppState: callback => {
    if (typeof callback !== 'function' || appStateListener) throw new Error('One application state subscription is allowed');
    appStateListener = callback; ipcRenderer.send('app:subscribe-state');
    let active = true;
    return () => {if (!active) return; active = false; appStateListener = undefined; ipcRenderer.send('app:unsubscribe-state');};
  },
  // Exit takes no arguments: the reason is fixed by main as a renderer request.
  exitApplication: () => ipcRenderer.invoke('app:exit'),
  // Only the two fixed enums reach main, which validates them again; nothing else is forwarded.
  setUnitProfile: (game, profile) => isUnitGame(game) && isUnitProfile(profile)
    ? ipcRenderer.invoke('settings:set-unit-profile', game, profile)
    : Promise.reject(new Error('Invalid unit profile request')),
  // One fixed layout id only; main validates it again.
  setOverlayLayout: layout => isOverlayLayout(layout)
    ? ipcRenderer.invoke('settings:set-overlay-layout', layout)
    : Promise.reject(new Error('Invalid overlay layout request')),
  // Only a fresh copy of a complete, strictly validated section record is forwarded; main validates it again.
  setOverlaySections: sections => {
    const copy = parseOverlaySections(sections);
    return copy ? ipcRenderer.invoke('settings:set-overlay-sections', {...copy}) : Promise.reject(new Error('Invalid overlay sections request'));
  }
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));
