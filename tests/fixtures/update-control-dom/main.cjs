// ET-055 PR-7: the Electron main script of tests/unit/update-control-dom.test.ts. It opens the bundled page in a hidden,
// sandboxed window with an isolated userData folder, waits for the page's `window.__result`, prints it on one stdout line
// and exits. It exits 7 after 30 s in any case. Nothing of the application, its profile or its data is involved.
const {app, BrowserWindow} = require('electron');

app.setPath('userData', process.env.DOM_USER_DATA);
app.disableHardwareAcceleration();
setTimeout(() => app.exit(7), 30000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({show: false, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
  await window.loadFile(process.env.DOM_PAGE);
  for (;;) {
    const result = await window.webContents.executeJavaScript('window.__result ?? null');
    if (result) {
      process.stdout.write(`DOM_RESULT ${JSON.stringify(result)}\n`);
      app.exit(0);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}, error => {
  process.stdout.write(`DOM_FAILED ${String(error)}\n`);
  app.exit(8);
});
