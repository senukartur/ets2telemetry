import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {settingsPanel} from './ui-navigation.mjs';
import {until} from './lifecycle-observation.mjs';

const marker = 'ets2telemetry.now-playing.synthetic-smoke.v1\n';
export async function prepareNowPlayingSmoke(config) {await writeFile(path.join(config.profile, '.ets2telemetry-now-playing-smoke'), marker, {flag: 'wx'});}
const source = {id: 's1', sourceAppId: 'Synthetic Chrome', playback: 'playing', current: true};
const track = {id: 's1', revision: 1, title: 'Fictional northern road', artist: 'Synthetic artist', album: 'Fixture album', playback: 'playing', timeline: {start: 0, end: 240000, position: 60000, lastUpdatedUtc: 0, rate: null}, artwork: null};
const snapshot = (selected = track, sessions = [source]) => ({version: 1, type: 'snapshot', requestId: 1, sessions, selected, error: null});
const inject = async (application, value) => {assert.equal(await application.evaluate(({app}, value) => app.emit('ets2telemetry:diagnostic-now-playing', value), value), true, 'Isolated media fixture is not authorized');};
const widgetOf = application => until(() => Promise.resolve(application.windows().find(page => /now-playing\.html$/.test(page.url()))), Boolean, 'Current track renderer did not load');
const nativeWindow = application => application.evaluate(({BrowserWindow}) => {
  const widget = BrowserWindow.getAllWindows().find(window => /now-playing\.html$/.test(window.webContents.getURL()));
  if (!widget) return null;
  const prefs = widget.webContents.getLastWebPreferences();
  return {visible: widget.isVisible(), focusable: widget.isFocusable(), movable: widget.isMovable(), topmost: widget.isAlwaysOnTop(), bounds: widget.getBounds(), security: {sandbox: prefs.sandbox, isolation: prefs.contextIsolation, node: prefs.nodeIntegration}};
});
export async function runNowPlayingSmoke({application, dashboard, config}) {
  const result = {origin: 'synthetic', realMediaObserved: false};
  await settingsPanel(dashboard, 'general');
  assert.equal(await dashboard.locator('#now-playing-source').count(), 0);
  await dashboard.getByTestId('now-playing-enabled').click();
  await dashboard.locator('#now-playing-source').waitFor({state: 'visible'});
  const widget = await widgetOf(application);
  await widget.waitForFunction(() => typeof globalThis.nowPlaying === 'object');
  assert.deepEqual(await widget.evaluate(() => ({keys: Object.keys(globalThis.nowPlaying), frozen: Object.isFrozen(globalThis.nowPlaying), node: typeof globalThis.require, desktop: typeof globalThis.desktop})), {keys: ['subscribeNowPlaying'], frozen: true, node: 'undefined', desktop: 'undefined'});
  await inject(application, snapshot());
  await widget.getByTestId('now-playing-panel').waitFor({state: 'visible'});
  assert.equal(await widget.locator('.np-title').innerText(), track.title);
  assert.equal(await widget.locator('.np-panel').evaluate(element => element.classList.contains('np-minimal')), true);
  result.minimal = true; await widget.screenshot({path: path.join(config.output, 'now-playing-minimal.png'), omitBackground: true});
  const native = await nativeWindow(application);
  assert.deepEqual(native.security, {sandbox: true, isolation: true, node: false}); assert.equal(native.focusable, false); assert.equal(native.movable, false); assert.equal(native.topmost, true);
  await dashboard.evaluate(() => globalThis.desktop.setNowPlayingStyle('full'));
  await widget.locator('.np-full').waitFor();
  assert.equal(await widget.locator('.np-album').innerText(), 'Fixture album');
  assert.equal(await widget.locator('.np-times').innerText(), '1:00\n4:00');
  result.full = true;
  // Real PNG bytes generated in the observer, then validated by the product's PNG boundary and CSP.
  for (const [width, height] of [[80, 80], [40, 80], [150, 83]]) {
    const png = await dashboard.evaluate(([width, height]) => {const canvas = globalThis.document.createElement('canvas'); canvas.width = width; canvas.height = height; const context = canvas.getContext('2d'); context.fillStyle = '#294761'; context.fillRect(0, 0, width, height); return canvas.toDataURL('image/png').split(',')[1];}, [width, height]);
    await inject(application, snapshot({...track, revision: width, artwork: {png, width, height}}));
    await widget.waitForFunction(([width, height]) => {const image = globalThis.document.querySelector('.np-artwork'); return image?.naturalWidth === width && image.naturalHeight === height && globalThis.getComputedStyle(image).objectFit === 'contain';}, [width, height]);
  }
  result.artworkShapes = ['square', 'portrait', 'wide']; await widget.screenshot({path: path.join(config.output, 'now-playing-full.png'), omitBackground: true});
  await dashboard.evaluate(() => globalThis.desktop.setNowPlayingBackgroundOpacity(40));
  await widget.waitForFunction(() => globalThis.getComputedStyle(globalThis.document.querySelector('.np-panel')).backgroundColor.includes('0.4'));
  assert.equal(await widget.locator('.np-title').evaluate(element => globalThis.getComputedStyle(element).opacity), '1'); result.backgroundOnlyOpacity = true;
  await inject(application, snapshot({...track, revision: 200, playback: 'paused'}, [{...source, playback: 'paused'}]));
  await widget.getByText('Paused', {exact: true}).waitFor(); assert.equal(await widget.locator('.np-artwork').count(), 0); result.pauseClearsArtwork = true;
  await dashboard.evaluate(() => globalThis.desktop.setLanguage('ru'));
  await widget.getByText('Пауза', {exact: true}).waitFor(); result.languages = ['en', 'ru'];
  await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'session', id: 's1'}));
  await inject(application, snapshot(null, [{id: 's2', sourceAppId: 'Synthetic other player', playback: 'playing', current: true}]));
  await dashboard.waitForFunction(async () => (await globalThis.desktop.getAppState()).nowPlaying.state === 'unavailable');
  await until(() => nativeWindow(application), value => value?.visible === false, 'Unavailable explicit source stayed visible'); result.explicitSourceLoss = true;
  await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'automatic'}));
  await inject(application, snapshot(null, []));
  await dashboard.waitForFunction(async () => (await globalThis.desktop.getAppState()).nowPlaying.state === 'no-session'); result.noSessionClears = true;
  await dashboard.bringToFront();
  await dashboard.evaluate(() => globalThis.desktop.beginNowPlayingEdit());
  await widget.locator('.np-editing').waitFor();
  assert.equal(await widget.locator('.np-title').innerText(), 'Текущий трек');
  assert.equal(await dashboard.evaluate(() => globalThis.desktop.beginOverlayEdit().then(() => false, () => true)), true); result.editExclusion = true;
  await dashboard.evaluate(() => globalThis.desktop.resetNowPlayingEditPlacement());
  await dashboard.evaluate(() => globalThis.desktop.finishNowPlayingEdit('cancel')); result.cancel = true;
  await dashboard.evaluate(() => globalThis.desktop.beginNowPlayingEdit());
  await dashboard.evaluate(() => globalThis.desktop.resetNowPlayingEditPlacement());
  await dashboard.evaluate(() => globalThis.desktop.finishNowPlayingEdit('save')); result.resetSave = true;
  await inject(application, snapshot());
  await widget.getByTestId('now-playing-panel').waitFor({state: 'visible'});
  await dashboard.close();
  assert.equal((await nativeWindow(application)).visible, true); result.closeToTray = true;
  await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-tray-action', 'open'));
  return result;
}
export async function verifyNowPlayingRestart({application, dashboard, record}) {
  const settings = await dashboard.evaluate(async () => (await globalThis.desktop.getAppState()).settings.nowPlaying);
  assert.deepEqual(settings, {enabled: true, style: 'full', backgroundOpacity: 40, position: {displayId: null, x: 1, y: 0.75}});
  const widget = await widgetOf(application); await inject(application, snapshot());
  await widget.getByTestId('now-playing-panel').waitFor({state: 'visible'}); record.restartPreserved = true;
  await dashboard.evaluate(() => globalThis.desktop.setNowPlayingEnabled(false));
  await until(() => nativeWindow(application), value => value === null, 'Disable did not destroy current track window'); record.disableRetires = true;
}

export async function nowPlayingRendererPages(application) {
  return until(() => {
    const pages = application.windows();
    const dashboard = pages.filter(page => /renderer\/index\.html$/.test(page.url()));
    const overlay = pages.filter(page => /renderer\/index\.html\?view=overlay$/.test(page.url()));
    const widget = pages.filter(page => /renderer\/now-playing\.html$/.test(page.url()));
    return Promise.resolve(pages.length === 3 && dashboard.length === 1 && overlay.length === 1 && widget.length === 1 ? {dashboard: dashboard[0], overlay: overlay[0]} : null);
  }, Boolean, 'Expected exactly dashboard, overlay and current-track renderers');
}
