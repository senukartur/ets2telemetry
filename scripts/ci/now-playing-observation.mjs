import {spawn} from 'node:child_process';
import {once} from 'node:events';
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
  const native = await nativeWindow(application);
  assert.deepEqual(native.security, {sandbox: true, isolation: true, node: false}); assert.equal(native.focusable, false); assert.equal(native.movable, false);
  assert.equal(native.visible, false, 'Media without an active game must stay off the desktop'); result.desktopHidden = true;
  await dashboard.bringToFront();
  await dashboard.evaluate(() => globalThis.desktop.beginNowPlayingEdit());
  await widget.locator('.np-editing').waitFor();
  assert.equal((await nativeWindow(application)).visible, true); result.editPreview = true;
  assert.equal(await widget.locator('.np-title').innerText(), track.title);
  assert.equal(await widget.locator('.np-panel').evaluate(element => element.classList.contains('np-minimal')), true);
  result.minimal = true; await widget.screenshot({path: path.join(config.output, 'now-playing-minimal.png'), omitBackground: true});
  assert.equal((await nativeWindow(application)).topmost, true);
  await dashboard.evaluate(() => globalThis.desktop.finishNowPlayingEdit('cancel'));
  await dashboard.evaluate(() => globalThis.desktop.setNowPlayingStyle('full'));
  await dashboard.evaluate(() => globalThis.desktop.beginNowPlayingEdit());
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
  const spotify = {...source, sourceAppId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'};
  await inject(application, snapshot(track, [spotify]));
  await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'session', id: 's1'}));
  await inject(application, snapshot(track, [spotify]));
  await until(() => dashboard.locator('#now-playing-source').innerText(), text => text === 'Spotify', 'Source selector did not normalize Spotify');
  await widget.getByText('Spotify', {exact: true}).waitFor();
  assert.equal((await dashboard.evaluate(async () => (await globalThis.desktop.getAppState()).nowPlaying.sources[0])).sourceAppId, spotify.sourceAppId);
  result.sourceNormalized = true;
  await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'automatic'}));
  await dashboard.evaluate(() => globalThis.desktop.setNowPlayingBackgroundOpacity(40));
  await widget.waitForFunction(() => globalThis.getComputedStyle(globalThis.document.querySelector('.np-panel')).backgroundColor.includes('0.4'));
  assert.equal(await widget.locator('.np-title').evaluate(element => globalThis.getComputedStyle(element).opacity), '1'); result.backgroundOnlyOpacity = true;
  await inject(application, snapshot({...track, revision: 200, playback: 'paused'}, [{...source, playback: 'paused'}]));
  await widget.getByText('Paused', {exact: true}).waitFor(); assert.equal(await widget.locator('.np-artwork').count(), 0); result.pauseClearsArtwork = true;
  await dashboard.evaluate(() => globalThis.desktop.setLanguage('ru'));
  await widget.getByText('Пауза', {exact: true}).waitFor(); result.languages = ['en', 'ru'];
  await runNativeSelectionJourney({application, dashboard, widget, config}); result.nativeSelectionRoundTrip = true; result.nativeTransitionRecovered = true;
  await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'automatic'}));
  await inject(application, snapshot({...track, playback: 'paused'}, [{...source, playback: 'paused'}]));
  await dashboard.evaluate(() => globalThis.desktop.finishNowPlayingEdit('cancel'));
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
  assert.equal((await nativeWindow(application)).visible, false); result.closeToTray = true;
  await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-tray-action', 'open'));
  return result;
}
export async function verifyNowPlayingRestart({application, dashboard, record}) {
  const settings = await dashboard.evaluate(async () => (await globalThis.desktop.getAppState()).settings.nowPlaying);
  assert.deepEqual(settings, {enabled: true, style: 'full', backgroundOpacity: 40, position: {displayId: null, x: 1, y: 0.75}});
  const widget = await widgetOf(application); await inject(application, snapshot());
  await widget.getByTestId('now-playing-panel').waitFor({state: 'visible'}); record.restartPreserved = true;
  assert.equal((await nativeWindow(application)).visible, false, 'Restarted media without a game must stay hidden');
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

// This nonshipping provider runs the same SnapshotReader as WinRT; the app still receives only validated synthetic data.
async function runNativeSelectionJourney({application, dashboard, widget, config}) {
  const child = spawn(path.join(config.checkout, 'native/media-session-reader/build/Release/media-session-reader-provider-fixture.exe'), ['--parent', String(process.pid)], {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  let pending, buffer = Buffer.alloc(0), serial = 0;
  const fail = error => {if (pending) {clearTimeout(pending.guard); pending.reject(error); pending = undefined;}};
  child.on('error', fail); child.stdin.on('error', fail); child.on('exit', () => fail(new Error('Native provider exited before its response'))); child.stderr.resume();
  child.stdout.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (!pending || buffer.length > 1048580) throw new Error('Invalid native provider frame');
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(); if (length < 2 || length > 1048576) throw new Error('Invalid native provider length');
      if (buffer.length < length + 4) return;
      assert.equal(buffer.length, length + 4); const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(4)));
      assert.equal(value.requestId, pending.id); assert.equal(value.version, 1); assert.equal(value.type, 'snapshot');
      const completed = pending; pending = undefined; buffer = Buffer.alloc(0); clearTimeout(completed.guard); completed.resolve(value);
    } catch (error) {fail(error);}
  });
  const request = selectedId => new Promise((resolve, reject) => {
    const id = ++serial, bytes = Buffer.from(JSON.stringify({version: 1, type: 'snapshot', requestId: id, selectedId}));
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    // A real-process hang guard, independent of host speed; normal progress waits on actual framed responses.
    pending = {id, resolve, reject, guard: setTimeout(() => fail(new Error('Native provider response exceeded 5 seconds')), 5000)};
    child.stdin.write(Buffer.concat([header, bytes]));
  });
  const deliver = value => inject(application, {...value, requestId: 1});
  try {
    const initial = await request(null); const [a, b] = initial.sessions;
    assert.equal(initial.selected.id, a.id); assert.equal(a.current, true); await deliver(initial);
    await dashboard.evaluate(id => globalThis.desktop.selectNowPlayingSource({kind: 'session', id}), b.id);
    const explicit = await request(b.id); assert.equal(explicit.selected.id, b.id); await deliver(explicit);
    await dashboard.evaluate(() => globalThis.desktop.selectNowPlayingSource({kind: 'automatic'}));
    const automatic = await request(null); assert.equal(automatic.selected.id, b.id); assert.equal(automatic.sessions[0].current, true); await deliver(automatic);
    await dashboard.waitForFunction(async () => {const state = (await globalThis.desktop.getAppState()).nowPlaying; return state.state === 'playing' && state.error === null && state.sources.length === 2;});
    await widget.waitForFunction(() => globalThis.document.querySelector('.np-title')?.textContent === 'Provider track B');
    await dashboard.evaluate(id => globalThis.desktop.selectNowPlayingSource({kind: 'session', id}), b.id);
    const changing = await request(b.id); assert.equal(changing.selected, null); assert.equal(changing.error, null); await deliver(changing);
    const paused = await request(b.id); assert.equal(paused.selected.id, b.id); assert.equal(paused.selected.playback, 'paused'); await deliver(paused);
    await dashboard.waitForFunction(async () => {const state = (await globalThis.desktop.getAppState()).nowPlaying; return state.state === 'paused' && state.error === null && state.sources.length === 2;});
  } finally {
    if (child.exitCode === null && child.signalCode === null) {const closed = once(child, 'close'); child.stdin.end(); const kill = setTimeout(() => child.kill(), 500); await closed; clearTimeout(kill);}
  }
}
