import {app, BrowserWindow, ipcMain, utilityProcess} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import type {ScaffoldStatus} from '../../../packages/contracts/src';
import {processEntrypoint} from './entrypoints';
import {createDiagnostics} from './diagnostics';
import {ServiceSupervisor} from './service-supervisor';

// Installer lifecycle runs before any windows, service, or storage worker.
if (squirrelStartup) app.quit();
else {
  const diagnosticDirectory = process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  const log = createDiagnostics(diagnosticDirectory || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ETS2Telemetry', 'logs'), Boolean(diagnosticDirectory));
  const supervisor = new ServiceSupervisor(log, code => app.exit(code));
  let window: BrowserWindow | undefined;
  let status: ScaffoldStatus | undefined;
  log('APP_START', {electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged});
  process.on('uncaughtException', error => supervisor.fail('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', error => supervisor.fail('UNHANDLED_REJECTION', error));
  app.on('before-quit', event => {event.preventDefault(); supervisor.stop();});
  app.on('window-all-closed', () => supervisor.stop());

  try {
    const profile = process.env.ETS2TELEMETRY_PROFILE_DIR;
    if (profile) {
      if (!path.isAbsolute(profile)) throw new Error('Diagnostic profile must be absolute');
      mkdirSync(profile, {recursive: true});
      app.setPath('userData', profile);
      app.setPath('sessionData', profile);
    }
  } catch (error) {supervisor.fail('PROFILE_SETUP_FAILED', error);}

  app.whenReady().then(() => {
    if (supervisor.stopping) return;
    const entrypoint = processEntrypoint(__dirname, 'telemetry-service');
    if (!existsSync(entrypoint)) throw new Error('Missing physical telemetry service entrypoint');
    const service = utilityProcess.fork(entrypoint, [], {serviceName: 'ETS2Telemetry telemetry service', stdio: 'pipe'});
    supervisor.attach(service);
    // Always drain both streams. The bounded logger limits retained diagnostics, not reading.
    service.stdout?.on('data', chunk => log('SERVICE_STDOUT', String(chunk)));
    service.stderr?.on('data', chunk => log('SERVICE_STDERR', String(chunk)));
    service.once('spawn', () => log('SERVICE_SPAWN', {pid: service.pid}));
    service.once('exit', code => supervisor.serviceExited(code));
    // Utility-process messages are untyped; only the discriminator is inspected here.
    service.on('message', (message: {type?: unknown} | null | undefined) => {
      if (supervisor.stopping) return;
      if (message?.type === 'ready') {
        if (!supervisor.ready()) return;
        status = {service: 'ready', storage: 'verified', synthetic: true};
        window = new BrowserWindow({width: 800, height: 500, webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false
        }});
        window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
        window.webContents.on('will-navigate', event => event.preventDefault());
        window.webContents.on('render-process-gone', (_event, details) => supervisor.fail('RENDER_PROCESS_GONE', details));
        void window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
          .then(() => log('WINDOW_LOADED')).catch(error => supervisor.fail('WINDOW_LOAD_FAILED', error));
      } else if (message?.type === 'failed') supervisor.fail('SERVICE_START_FAILED', message);
      else supervisor.fail('SERVICE_INVALID_MESSAGE');
    });
    ipcMain.handle('scaffold:status', event => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !status) throw new Error('Untrusted status request');
      return status;
    });
  }).catch(error => supervisor.fail('APP_START_FAILED', error));
}
