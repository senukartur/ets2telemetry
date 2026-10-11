'use strict';
const { app, BrowserWindow, Menu, Tray, nativeImage, screen, session, utilityProcess } = require('electron');
const path = require('node:path');
const { validate } = require('./codec.cjs');
const { updateOverlayBounds } = require('./overlay-window.cjs');
const game = process.argv.find((arg) => arg.startsWith('--game='))?.slice(7);
const sid = process.argv.find((arg) => arg.startsWith('--sid='))?.slice(6);
const profile = process.argv.find((arg) => arg.startsWith('--profile='))?.slice(10);
const suffix = process.argv.find((arg) => arg.startsWith('--pipe-suffix='))?.slice(14) ?? '';
if (!['eut2', 'ats'].includes(game) || !/^S-1-[0-9-]+$/.test(sid) || !profile || !path.isAbsolute(profile) || (suffix && !/^\.synthetic\.[1-9][0-9]{0,9}$/.test(suffix))) {
  console.error('SP-01 requires --game=eut2|ats --sid=<current Windows SID> --profile=<absolute isolated directory>');
  app.exit(2);
} else {
  app.setPath('userData', profile);
  let overlay, service, tray, timer, snapshot, received = 0, quitting = false, loaded = false;
  async function start() {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file://') }));
    overlay = new BrowserWindow({ width: 280, height: 96, show: false, frame: false, transparent: true,
      resizable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false } });
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    overlay.webContents.on('will-navigate', (event) => event.preventDefault());
    overlay.on('close', (event) => { if (!quitting) { event.preventDefault(); overlay.hide(); } });
    await overlay.loadFile(path.join(__dirname, '../dist/index.html')); loaded = true;
    tray = new Tray(nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='));
    tray.setToolTip('ETS2Telemetry SP-01 — experimental');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: `SP-01 ${game}: speed/fuel only`, enabled: false }, { label: 'Exit SP-01', click: () => app.quit() }]));
    service = utilityProcess.fork(path.join(__dirname, 'service.cjs'), [game, sid, suffix], { serviceName: 'SP-01 experimental pipe client' });
    service.on('message', (message) => {
      if (message?.type !== 'snapshot') return;
      try { snapshot = message.value === null ? null : validate(message.value, game); received = performance.now(); }
      catch { snapshot = null; }
    });
    service.on('exit', (code) => { snapshot = null; console.log(`SP01_SERVICE_EXIT:${code}`); });
    timer = setInterval(() => {
      const value = performance.now() - received < 500 ? snapshot : null;
      if (!loaded) return;
      overlay.webContents.send('sp01:snapshot', value);
      if (!value?.window.visible) { overlay.hide(); return; }
      const rect = screen.screenToDipRect(null, value.window);
      updateOverlayBounds(overlay, rect);
      if (!overlay.isVisible()) overlay.showInactive();
    }, 50);
  }
  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true; clearInterval(timer); tray?.destroy();
    if (service?.pid) {
      event.preventDefault();
      const deadline = setTimeout(() => { console.error('SP01_SERVICE_STOP_TIMEOUT'); service.kill(); app.exit(1); }, 500);
      service.once('exit', (code) => { clearTimeout(deadline); if (code === 0) app.quit(); else app.exit(1); });
      service.postMessage({ type: 'stop' });
    }
  });
  app.on('window-all-closed', () => { /* Explicit tray exit owns application shutdown. */ });
  app.whenReady().then(start).catch((error) => { console.error(error); app.exit(1); });
}
