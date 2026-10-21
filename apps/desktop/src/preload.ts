import {contextBridge, ipcRenderer} from 'electron';
import type {AppState, DesktopBridge, LiveTelemetry} from '../../../packages/contracts/src';
import {initialLive, sourceSelection} from './live-state';
import {expiredV1, liveV1Key, parseLiveV1, RENDERER_V1_EXPIRED_REASON, V1_LIVE_EXPIRY_MS} from './live-v1';
import {RecoveryBudget} from './recovery-budget';
import {isOverlayLayout, parseOverlaySections} from './overlay-sections';
import {isOverlayEditOutcome, parseOverlayEditScale} from './overlay-placement';
import {isUnitGame, isUnitProfile} from './unit-profiles';
import {isAppLanguage} from './settings-schema';
import {copyTripsQuery, isPageArgument, JOURNAL_CHANNELS, JOURNAL_EXPORT_CHANNEL} from './journal-contract';
import {isJournalUuid} from '../../../packages/contracts/src/journal';
import {DIAGNOSTICS_EXPORT_CHANNEL, isPluginGame, isPluginTargetId, PLUGIN_CHANNELS} from './plugin-setup-contract';
import {UNINSTALL_CHANNEL} from './uninstall-contract';
let listener: ((update: LiveTelemetry) => void) | undefined;
let port: MessagePort | undefined;
let current: LiveTelemetry = initialLive();
let freshness: ReturnType<typeof setTimeout> | undefined;
let windowFreshness: ReturnType<typeof setTimeout> | undefined;
let sdkReceiptKey: string | undefined;
let sdkExpiry = 0;
let windowReceiptKey: string | undefined;
let windowExpiry = 0;
// The protocol v1 projection expires on its own clock (ET-010c decision F3); v0 receipts never renew it.
let v1Freshness: ReturnType<typeof setTimeout> | undefined;
let v1ReceiptKey: string | undefined;
let v1Expiry = 0;
let recovery: ReturnType<typeof setTimeout> | undefined;
let recoveryBudget = new RecoveryBudget();
let subscription = Symbol();
function clearFreshness(): void {clearTimeout(freshness); freshness = undefined; clearTimeout(windowFreshness); windowFreshness = undefined; clearTimeout(v1Freshness); v1Freshness = undefined;}
function clearRecovery(): void {clearTimeout(recovery); recovery = undefined;}
function closePort(): void {const previous = port; port = undefined; previous?.close();}
function stale(reason: string): void {
  clearFreshness(); current = {...current, status: 'stale', fresh: false, reason,
    ...(current.observation ? {observation: {...current.observation, windowFresh: false}} : {}), ...(current.v1 ? {v1: expiredStale(current.v1, reason)} : {})}; listener?.(current);
}
/** A v1 projection that is no longer fresh stays as it is; a fresh one becomes stale with the given reason. */
function expiredStale(v1: NonNullable<LiveTelemetry['v1']>, reason: string): NonNullable<LiveTelemetry['v1']> {return v1.fresh ? expiredV1(v1, reason) : v1;}
/** The update without a v1 projection that fails validation for its selection (ET-010c decision F2). */
function acceptedV1(update: LiveTelemetry): LiveTelemetry {
  if (update.v1 === undefined || parseLiveV1(update.v1, update.selection)) return update;
  const stripped = {...update}; delete stripped.v1; return stripped;
}
function publish(incoming: LiveTelemetry): void {
  const update = acceptedV1(incoming);
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
  const v1Key = liveV1Key(update.v1);
  if (v1Key === undefined || v1Key !== v1ReceiptKey) {v1ReceiptKey = v1Key; v1Expiry = now + V1_LIVE_EXPIRY_MS;}
  if (update.v1?.fresh) {
    if (now >= v1Expiry) current = {...current, v1: expiredV1(update.v1, RENDERER_V1_EXPIRED_REASON)};
    else v1Freshness = setTimeout(() => {
      v1Freshness = undefined;
      if (current.v1) {current = {...current, v1: expiredV1(current.v1, RENDERER_V1_EXPIRED_REASON)}; listener?.(current);}
    }, v1Expiry - now);
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
  else if (listener && current.v1?.fresh) {current = {...current, v1: expiredV1(current.v1, 'Replacement live subscription awaits a current observation')}; listener(current);}
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
    subscription = Symbol(); listener = callback; current = initialLive(); sdkReceiptKey = windowReceiptKey = v1ReceiptKey = undefined; recoveryBudget = new RecoveryBudget(); ipcRenderer.send('telemetry:subscribe');
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
  setLanguage: language => isAppLanguage(language)
    ? ipcRenderer.invoke('settings:set-language', language)
    : Promise.reject(new Error('Invalid language request')),
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
  },
  // ET-012b overlay edit mode: fixed channels; only a validated scale or outcome is forwarded, and main validates again.
  beginOverlayEdit: () => ipcRenderer.invoke('overlay-edit:begin'),
  setOverlayEditScale: scale => {
    const value = parseOverlayEditScale(scale);
    return value === undefined ? Promise.reject(new Error('Invalid overlay edit request')) : ipcRenderer.invoke('overlay-edit:set-scale', value);
  },
  resetOverlayEditPlacement: () => ipcRenderer.invoke('overlay-edit:reset'),
  finishOverlayEdit: outcome => isOverlayEditOutcome(outcome)
    ? ipcRenderer.invoke('overlay-edit:finish', outcome)
    : Promise.reject(new Error('Invalid overlay edit request')),
  // ET-016 journal reads (J10): fixed channels; only a fresh copy of a validated filter, or a validated UUID and cursor
  // (null when absent), is forwarded, and main validates again and fixes the page size.
  listJournalTrips: query => {
    const copy = copyTripsQuery(query);
    return copy ? ipcRenderer.invoke(JOURNAL_CHANNELS.trips, copy) : Promise.reject(new Error('Invalid journal request'));
  },
  getJournalTrip: tripUuid => isJournalUuid(tripUuid) ? ipcRenderer.invoke(JOURNAL_CHANNELS.trip, tripUuid) : Promise.reject(new Error('Invalid journal request')),
  listJournalEvents: (tripUuid, cursor) => journalPage('events', tripUuid, cursor),
  listJournalIntervals: (tripUuid, cursor) => journalPage('intervals', tripUuid, cursor),
  listJournalSamples: (tripUuid, cursor) => journalPage('samples', tripUuid, cursor),
  // ET-016 PR-5 (J16): only a validated trip UUID is forwarded; main validates it again, owns the Save dialog and the file
  // writer, and answers with fixed codes and row counts, never a path.
  exportJournalTrip: tripUuid => isJournalUuid(tripUuid) ? ipcRenderer.invoke(JOURNAL_EXPORT_CHANNEL, tripUuid) : Promise.reject(new Error('Invalid journal request')),
  // ET-017 plugin setup (P16): fixed channels; only a validated game, exclusion flag or target id is forwarded, and main
  // validates again. Main owns the folder dialog, Explorer and the game folders; no answer carries a path.
  retryPluginSetup: () => ipcRenderer.invoke(PLUGIN_CHANNELS.retry),
  choosePluginFolder: game => isPluginGame(game) ? ipcRenderer.invoke(PLUGIN_CHANNELS.chooseFolder, game) : Promise.reject(new Error('Invalid plugin setup request')),
  setPluginGameExcluded: (game, excluded) => isPluginGame(game) && typeof excluded === 'boolean'
    ? ipcRenderer.invoke(PLUGIN_CHANNELS.setExcluded, game, excluded)
    : Promise.reject(new Error('Invalid plugin setup request')),
  showPluginFile: () => ipcRenderer.invoke(PLUGIN_CHANNELS.showFile),
  openPluginFolder: targetId => isPluginTargetId(targetId) ? ipcRenderer.invoke(PLUGIN_CHANNELS.openFolder, targetId) : Promise.reject(new Error('Invalid plugin setup request')),
  // ET-017 PR-6 (P17): no argument is forwarded; main owns the Save dialog and the bundle and answers with a fixed outcome.
  exportDiagnostics: () => ipcRenderer.invoke(DIAGNOSTICS_EXPORT_CHANNEL),
  // ET-018 PR-4 (U8): no argument may reach main, which checks again; main owns both dialogs and answers with fixed codes and
  // target ids, never a path.
  uninstallApplication: (...args: unknown[]) => args.length === 0 ? ipcRenderer.invoke(UNINSTALL_CHANNEL) : Promise.reject(new Error('Invalid uninstall request'))
};
/** One page request of a trip: exactly the UUID and the cursor, or null for the first page. */
function journalPage<T>(kind: 'events' | 'intervals' | 'samples', tripUuid: unknown, cursor: unknown): Promise<T> {
  return isPageArgument(kind, tripUuid, cursor)
    ? ipcRenderer.invoke(JOURNAL_CHANNELS[kind], tripUuid, cursor ?? null) as Promise<T>
    : Promise.reject(new Error('Invalid journal request'));
}
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));
