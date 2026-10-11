'use strict';
const { app, BrowserWindow, screen, session, utilityProcess } = require('electron');
const path = require('node:path');
const { updateOverlayBounds } = require('../app/overlay-window.cjs');
const profile = process.argv.find((arg) => arg.startsWith('--profile='))?.slice(10);
if (!profile || !path.isAbsolute(profile)) throw new Error('Absolute isolated profile required');
app.setPath('userData', profile);
let win, service, quitting = false, writes = 0, heartbeats = 0;
app.on('window-all-closed', () => {});
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  if (service?.pid) {
    event.preventDefault();
    const timer = setTimeout(() => { console.error('WINDOW_GEOMETRY_SERVICE_STOP_TIMEOUT'); service.kill(); app.exit(1); }, 500);
    service.once('exit', (code) => { clearTimeout(timer); if (code === 0) app.quit(); else app.exit(1); });
    service.postMessage({ type: 'stop' });
  }
});
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
  win = new BrowserWindow({ width: 280, height: 96, show: false, frame: false, transparent: true,
    resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
  win.setIgnoreMouseEvents(true); win.setFocusable(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>SP01 synthetic window regression</title><style>body{margin:0;font:16px sans-serif;color:white}main{height:80px;padding:8px;box-sizing:border-box;background:#245178;border:3px solid #ffe54d}</style></head><body><main>SYNTHETIC geometry regression<br>Fixed 280 x 96</main></body></html>'));
  const nativeSetBounds = win.setBounds.bind(win);
  win.setBounds = (...args) => { writes++; return nativeSetBounds(...args); };
  service = utilityProcess.fork(path.join(__dirname, 'window-geometry.service.cjs'), [], { serviceName: 'SP01 synthetic window regression' });
  service.on('message', (message) => { if (message?.type === 'heartbeat') heartbeats++; });
  service.on('exit', (code) => console.log(`WINDOW_GEOMETRY_SERVICE_EXIT:${code}`));
  const state = () => ({ bounds: win.getBounds(), contentBounds: win.getContentBounds(), visible: win.isVisible(), focusable: win.isFocusable(), focused: win.isFocused(), writes });
  const area = screen.getPrimaryDisplay().workArea;
  const anchor = { x: area.x + 20, y: area.y + 40 };
  const moved = { x: anchor.x + 160, y: anchor.y + 90 };
  updateOverlayBounds(win, anchor); win.showInactive();
  globalThis.__sp01WindowRegression = {
    info: () => ({ browserPid: process.pid, handle: win.getNativeWindowHandle().readBigUInt64LE().toString(), versions: process.versions, display: screen.getDisplayMatching(win.getBounds()), displays: screen.getAllDisplays(), state: state(), anchor, moved, heartbeats,
      security: (() => { const p = win.webContents.getLastWebPreferences(); return { sandbox: p.sandbox, isolation: p.contextIsolation, node: p.nodeIntegration }; })() }),
    step: async (stage) => {
      const records = [], sample = () => records.push({ stage, utc: new Date().toISOString(), ...state() });
      if (stage === 'initial') updateOverlayBounds(win, anchor);
      else if (stage === 'same-anchor' || stage === 'same-moved-anchor') {
        const rect = stage === 'same-anchor' ? anchor : moved;
        for (let index = 0; index < (stage === 'same-anchor' ? 80 : 20); index++) {
          updateOverlayBounds(win, rect); sample(); await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return records;
      } else if (stage === 'moved' || stage === 'repaired') updateOverlayBounds(win, moved);
      else if (stage === 'seeded-oversize') nativeSetBounds({ ...win.getBounds(), width: 282, height: 420 });
      else if (stage === 'hidden') win.hide();
      else if (stage === 'shown-inactive') { updateOverlayBounds(win, moved); win.showInactive(); updateOverlayBounds(win, moved); }
      else if (stage === 'returned-anchor') updateOverlayBounds(win, anchor);
      else throw new Error('Unknown regression stage');
      sample(); return records;
    }
  };
}).catch((error) => { console.error(error); app.exit(1); });
