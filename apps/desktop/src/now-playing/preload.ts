import {contextBridge, ipcRenderer} from 'electron';
import type {NowPlayingBridge, NowPlayingDisplay} from '../../../../packages/contracts/src/now-playing';
import {isDisplay, record} from './contract';
let callback: ((value: NowPlayingDisplay) => void) | undefined, port: MessagePort | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let generation = -1, delivery = 0, documentGeneration = -1;
let authorizedDocument = -1;
type LocalCode='DOCUMENT_ENVELOPE_REJECTED'|'PORT_ENVELOPE_REJECTED'|'DISPLAY_ENVELOPE_REJECTED'|'DISPLAY_INVALID'|'DISPLAY_GENERATION_REGRESSED'|'PORT_MESSAGE_ERROR'|'CREDIT_SEND_FAILED'|'PEER_CLOSED'|'DISPLAY_EXPIRED';
const reported=new Set<LocalCode>();
function diagnose(code:LocalCode):void {if(reported.has(code))return;reported.add(code);try{console.warn('NOW_PLAYING_LOCAL',code);}catch{/* Local diagnostics cannot change rejection or credit. */}}
let current: NowPlayingDisplay = {generation: 0, language: 'en', style: 'minimal', backgroundOpacity: 80, editing: false, source: null, track: null};
function clear(): void {clearTimeout(expiry); expiry = undefined; const previous = port; port = undefined; previous?.close();}
function invalidate(): void {current = {...current, source: null, track: null}; callback?.(current);}
ipcRenderer.on('now-playing:port', (event, value: unknown) => {
  // A zero-port message authorizes this committed document; its later subscription echoes the generation.
  if (event.ports.length === 0) {
    if (!record(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) < 0 || Number(value.generation) < authorizedDocument) {diagnose('DOCUMENT_ENVELOPE_REJECTED');return;}
    if (Number(value.generation) > authorizedDocument) {reported.clear();clear(); invalidate();}
    authorizedDocument = Number(value.generation);
    if (callback && !port) ipcRenderer.send('now-playing:subscribe', authorizedDocument);
    return;
  }
  if (!callback || event.ports.length !== 1 || !record(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.generation) || Number(value.generation) !== authorizedDocument || Number(value.generation) <= documentGeneration) {diagnose('PORT_ENVELOPE_REJECTED');for (const incoming of event.ports) incoming.close(); return;}
  clear(); invalidate(); documentGeneration = Number(value.generation); generation = -1; delivery = 0;
  const next = port = event.ports[0];
  const lost = (code:LocalCode) => {if (port !== next) return;diagnose(code);clear(); invalidate();};
  next.addEventListener('close',()=>lost('PEER_CLOSED')); next.onmessageerror = ()=>lost('PORT_MESSAGE_ERROR');
  next.onmessage = (event: MessageEvent<unknown>) => {
    if (port !== next || !callback) return;
    const value = event.data;
    if (!record(value) || Object.keys(value).length !== 3 || value.type !== 'live' || !Number.isSafeInteger(value.delivery) || Number(value.delivery) <= delivery) {lost('DISPLAY_ENVELOPE_REJECTED'); return;}
    if(!isDisplay(value.update)){lost('DISPLAY_INVALID');return;}
    if(value.update.generation<generation){lost('DISPLAY_GENERATION_REGRESSED');return;}
    generation = value.update.generation; delivery = Number(value.delivery); current = value.update;
    clearTimeout(expiry); expiry = setTimeout(()=>{diagnose('DISPLAY_EXPIRED');invalidate();}, 5000);
    try {callback(current);} finally {if (port === next) {try {next.postMessage({type: 'consumed', delivery});} catch {lost('CREDIT_SEND_FAILED');}}}
  };
  next.start();
});
const bridge: NowPlayingBridge = Object.freeze({subscribeNowPlaying: (listener: (value: NowPlayingDisplay) => void) => {
  if (typeof listener !== 'function' || callback) throw new Error('One current track subscription is allowed');
  callback = listener; documentGeneration = -1; if (authorizedDocument >= 0) ipcRenderer.send('now-playing:subscribe', authorizedDocument);
  let active = true;
  return () => {if (!active) return; active = false; callback = undefined; clear(); if (authorizedDocument >= 0) ipcRenderer.send('now-playing:unsubscribe', authorizedDocument);};
}});
contextBridge.exposeInMainWorld('nowPlaying', bridge);
