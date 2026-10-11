import {contextBridge, ipcRenderer} from 'electron';
import type {DesktopBridge, LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
let listener: ((update: LiveTelemetry) => void) | undefined;
let port: MessagePort | undefined;
function closePort(): void {port?.close(); port = undefined;}
ipcRenderer.on('telemetry:port', event => {
  closePort(); const next = event.ports[0];
  if (!listener || event.ports.length !== 1) {for (const incoming of event.ports) incoming.close(); return;}
  port = next;
  next.onmessage = event => {
    const data = event.data;
    if (!listener || !data || data.type !== 'live' || !Number.isSafeInteger(data.delivery)) {closePort(); return;}
    // Credits acknowledge callback consumption only, never persistence or a v0 wire message.
    try {listener(data.update);} finally {if (port === next) next.postMessage({type: 'consumed', delivery: data.delivery});}
  };
  next.start();
});
ipcRenderer.on('telemetry:service-state', (_event, update: LiveTelemetry) => {closePort(); listener?.(update);});
const bridge: DesktopBridge = {
  getStatus: () => ipcRenderer.invoke('scaffold:status'),
  selectSource: (source: SourceSelection) => {
    if (source !== 'game' && source !== 'ets2' && source !== 'ats' && source !== 'synthetic' && source !== 'replay') return Promise.reject(new Error('Invalid source selection'));
    return ipcRenderer.invoke('telemetry:select', source);
  },
  subscribeLive: callback => {
    if (typeof callback !== 'function' || listener) throw new Error('One live subscription is allowed');
    listener = callback; ipcRenderer.send('telemetry:subscribe');
    let active = true;
    return () => {if (!active) return; active = false; listener = undefined; closePort(); ipcRenderer.send('telemetry:unsubscribe');};
  }
};
contextBridge.exposeInMainWorld('desktop', Object.freeze(bridge));
