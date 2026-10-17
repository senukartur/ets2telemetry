import {test,expect,_electron as electron} from '@playwright/test';
import path from 'node:path';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {ElectronApplication} from '@playwright/test';
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
test('Electron supervises service and SQLite worker with a sandboxed renderer',async () => {
  const temporary = await mkdtemp(path.join(tmpdir(),'ets2telemetry-startup-test-'));
  const executablePath = process.env.ETS2TELEMETRY_TEST_EXE;
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({...executablePath ? {executablePath,cwd:temporary} : {args:[path.resolve('.') ]},timeout:20000,env:{...process.env,TEMP:temporary,TMP:temporary,APPDATA:temporary,LOCALAPPDATA:temporary,ETS2TELEMETRY_PROFILE_DIR:path.join(temporary,'profile'),ETS2TELEMETRY_DIAGNOSTIC_DIR:path.join(temporary,'diagnostics')}});
    const window = await application.firstWindow();
    await expect(window.getByText('Telemetry service ready; isolated storage probe verified')).toBeVisible();
    expect(await window.evaluate(() => {const browserGlobal=globalThis as unknown as {require?:unknown;desktop:DesktopBridge};return {node:typeof browserGlobal.require,keys:Object.keys(browserGlobal.desktop)};})).toEqual({node:'undefined',keys:['getStatus','selectSource','subscribeLive','getAppState','subscribeAppState','exitApplication','setUnitProfile','setOverlayLayout','setOverlaySections','beginOverlayEdit','setOverlayEditScale','resetOverlayEditPlacement','finishOverlayEdit','listJournalTrips','getJournalTrip','listJournalEvents','listJournalIntervals','listJournalSamples','exportJournalTrip']});
    expect(await application.evaluate(({BrowserWindow}) => {const contents=BrowserWindow.getAllWindows()[0].webContents as unknown as {getLastWebPreferences():Electron.WebPreferences};const preferences=contents.getLastWebPreferences();return {sandbox:preferences.sandbox,isolation:preferences.contextIsolation,node:preferences.nodeIntegration};})).toEqual({sandbox:true,isolation:true,node:false});
  } finally {
    try {
      if (application) await closeWithinDeadline(application);
      expect((await readdir(temporary)).filter(name => name.startsWith('ets2telemetry-probe-'))).toEqual([]);
    } finally {await rm(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
  }
});
