import {test,expect,_electron as electron} from '@playwright/test';
import path from 'node:path';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {ElectronApplication, Page} from '@playwright/test';
import type {DesktopBridge} from '../../packages/contracts/src';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
// The owner lifted the native Windows application launch hold on October 11, 2026.

async function closeWithinDeadline(application: ElectronApplication): Promise<void> {
  const child = application.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('APP_CLOSE_TIMEOUT')), 8000);})
    ]);
    expect(child.exitCode).toBe(0);
  } catch (error) {
    // Limit cleanup to the process tree started by this test; preserve the failed outcome.
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      if (process.platform === 'win32') await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], {timeout: 5000, windowsHide: true});
      else child.kill('SIGKILL');
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// ET-017 PR-5 review (October 17, 2026): the application opens the dashboard and the overlay window, in either order, so
// firstWindow() could return the overlay ("Telemetry overlay") and the dashboard text was never found. Pick the dashboard
// by its URL: the renderer page without the overlay's ?view=overlay query. The 20 s bound matches the launch timeout.
const DASHBOARD_WINDOW_BOUND_MS = 20000;
function isDashboard(page: Page): boolean {
  try {
    const url = new URL(page.url());
    return url.protocol === 'file:' && /\/renderer\/index\.html$/.test(url.pathname) && url.search === '';
  } catch {return false;}
}
async function dashboardWindow(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + DASHBOARD_WINDOW_BOUND_MS;
  for (;;) {
    const found = application.windows().find(isDashboard);
    if (found) return found;
    if (Date.now() >= deadline) throw new Error('DASHBOARD_WINDOW_NOT_FOUND');
    // A page that exists but has not committed its URL yet fires no further window event; check again after a second.
    await application.waitForEvent('window', {timeout: 1000}).catch(() => undefined);
  }
}
test('Electron supervises service and SQLite worker with a sandboxed renderer',async () => {
  const temporary = await mkdtemp(path.join(tmpdir(),'ets2telemetry-startup-test-'));
  const executablePath = process.env.ETS2TELEMETRY_TEST_EXE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({...executablePath ? {executablePath,cwd:temporary} : {args:[path.resolve('.') ]},timeout:20000,env:{...process.env,TEMP:temporary,TMP:temporary,APPDATA:temporary,LOCALAPPDATA:temporary,ETS2TELEMETRY_PROFILE_DIR:path.join(temporary,'profile'),ETS2TELEMETRY_DIAGNOSTIC_DIR:path.join(temporary,'diagnostics')}});
    const window = await dashboardWindow(application);
    await expect(window.getByText('Telemetry service ready; isolated storage probe verified')).toBeVisible();
    expect(await window.evaluate(() => {const browserGlobal=globalThis as unknown as {require?:unknown;desktop:DesktopBridge};return {node:typeof browserGlobal.require,keys:Object.keys(browserGlobal.desktop)};})).toEqual({node:'undefined',keys:['getStatus','selectSource','subscribeLive','getAppState','subscribeAppState','exitApplication','setLanguage','setAutostart','setUnitProfile','setGearDisplay','setOverlayBackgroundOpacity', 'setOverlayEnabled','setOverlayLayout','setOverlaySections','beginOverlayEdit','setOverlayEditScale','resetOverlayEditPlacement','finishOverlayEdit','listJournalTrips','getJournalTrip','listJournalEvents','listJournalIntervals','listJournalSamples','exportJournalTrip','retryPluginSetup','choosePluginFolder','setPluginGameExcluded','showPluginFile','openPluginFolder','exportDiagnostics','uninstallApplication','getHardModeStatus','refreshHardMode','updateApplication','checkForUpdates']});
    // Every window (the dashboard and the overlay, in either order) must be sandboxed and isolated without Node integration.
    const preferences = await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(owner => {const contents=owner.webContents as unknown as {getLastWebPreferences():Electron.WebPreferences};const values=contents.getLastWebPreferences();return {sandbox:values.sandbox,isolation:values.contextIsolation,node:values.nodeIntegration};}));
    expect(preferences.length).toBeGreaterThan(0);
    for (const entry of preferences) expect(entry).toEqual({sandbox:true,isolation:true,node:false});
  } finally {
    try {
      if (application) await closeWithinDeadline(application);
      expect((await readdir(temporary)).filter(name => name.startsWith('ets2telemetry-probe-'))).toEqual([]);
    } finally {await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  }
});
