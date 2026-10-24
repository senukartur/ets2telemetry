// ET-045c local DPI probe, built and run by Run-OverlayBoundsProbe.ps1 inside a bounded Job. It opens no game, discovery,
// production settings, preload, history or user data: an isolated profile under the output directory, a blank page and
// windows with the production overlay window options. It records what Windows actually applies for the setBounds
// sequences of the ET-045c hypotheses (H-stale, H-min), then replays the owner's sections sequence through the real
// OverlayController. It asserts only completion and the controller's postcondition: inside the client, or hidden.
import {app, BrowserWindow, screen, type Rectangle} from 'electron';
import path from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {OVERLAY_TOPMOST_LEVEL, OverlayController, type OverlayBoundsEvent, type OverlayBoundsFacts} from '../../apps/desktop/src/overlay-controller';
import {overlayBounds} from '../../apps/desktop/src/overlay-geometry';
import {OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';

const [root, output] = process.argv.slice(2);
app.setPath('userData', path.join(output, 'profile')); app.setPath('sessionData', path.join(output, 'profile'));
app.on('window-all-closed', () => undefined);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 20000);
// A transparent page whose dashed outline spans the renderer viewport, as the edit overlay's `.overlay` root does.
const PAGE = 'data:text/html,' + encodeURIComponent('<!doctype html><html><body style="margin:0;background:transparent">' +
  '<div style="box-sizing:border-box;height:100vh;outline:2px dashed #e33;outline-offset:-2px"></div></body></html>');

/** The production overlay window options of main.ts, without its preload; its own in-memory session. */
async function overlayWindow(width: number, height: number): Promise<BrowserWindow> {
  const window = new BrowserWindow({width, height, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    webPreferences: {partition: 'ets2telemetry-bounds-probe', contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.setIgnoreMouseEvents(true); window.setFocusable(false); window.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL);
  await window.loadURL(PAGE);
  return window;
}
async function observe(window: BrowserWindow, label: string, requested: Rectangle) {
  const immediate = {bounds: window.getBounds(), content: window.getContentBounds()};
  await pause(250);
  const viewport = await window.webContents.executeJavaScript('[innerWidth, innerHeight]') as [number, number];
  return {label, requested, immediate, after250ms: {bounds: window.getBounds(), content: window.getContentBounds(), viewport},
    scaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor, visible: window.isVisible()};
}
const rect = (x: number, y: number, width: number, height: number): Rectangle => ({x, y, width, height});

void app.whenReady().then(async () => {
  const fixture = validateMessage(JSON.parse(await readFile(path.join(root, 'tests/fixtures/protocol-v0/snapshot.json'), 'utf8')));
  if (fixture.kind !== 'snapshot') throw new Error('Wrong fixture');
  const display = screen.getPrimaryDisplay(), area = display.workArea;
  const x = area.x + 100, y = area.y + 100, two = rect(x, y, 640, 40), one = rect(x, y + 19, 640, 21);
  const sequences = [];
  // (a) Raw sequences, each on a fresh window.
  {
    const window = await overlayWindow(640, 59);
    window.setBounds(two); window.showInactive(); await pause(250);
    window.setBounds(one); sequences.push(await observe(window, 'visible 640x40 to 640x21, top +19', one));
    window.destroy();
  }
  {
    const window = await overlayWindow(640, 59);
    window.setBounds(two); window.setBounds(one); sequences.push(await observe(window, 'hidden 640x40 to 640x21, top +19', one));
    window.showInactive(); window.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL); window.moveTop();
    sequences.push(await observe(window, 'same, after showInactive', one));
    window.destroy();
  }
  {
    // The base edit order (ET-012b decision M7) on a hidden window last placed at 640 x 40.
    const window = await overlayWindow(640, 59);
    window.setBounds(two); window.showInactive(); await pause(250); window.hide();
    window.setIgnoreMouseEvents(false); window.setFocusable(true); window.setSkipTaskbar(true); window.setMovable(true);
    window.setBounds(one); window.showInactive(); window.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL); window.moveTop();
    sequences.push(await observe(window, 'base edit order: hidden, interactive, setBounds(21), showInactive, topmost', one));
    window.hide(); window.setMovable(false); window.setIgnoreMouseEvents(true); window.setFocusable(false); window.setSkipTaskbar(true);
    window.destroy();
  }
  {
    const window = await overlayWindow(300, 384);
    window.setBounds(rect(x, y, 300, 384)); window.showInactive(); await pause(250);
    window.setBounds(one); sequences.push(await observe(window, 'visible card 300x384 to 640x21', one));
    window.destroy();
  }
  {
    const window = await overlayWindow(640, 59);
    window.setBounds(two); window.showInactive(); await pause(250);
    const shrink = rect(x, y, 640, 21); window.setBounds(shrink); sequences.push(await observe(window, 'pure shrink 640x40 to 640x21', shrink));
    window.destroy();
  }
  {
    const window = await overlayWindow(640, 59);
    window.setBounds(one); window.showInactive(); await pause(250);
    const moved = rect(x + 100, y + 38, 640, 21); window.setBounds(moved); sequences.push(await observe(window, 'pure move 640x21', moved));
    window.destroy();
  }

  // (b) The real controller with Electron's screen, replaying the owner's sequence: Strip {0.8485, 1, 0.5}, Job focus
  // while driving, the game in the background, Driving only saved, then edit mode with the dashboard in front.
  const scale = display.scaleFactor;
  const clientDip = rect(area.x + 50, area.y + 50, Math.floor(Math.min(area.width - 100, 2560 / scale)), Math.floor(Math.min(area.height - 100, 1440 / scale)));
  const physical = screen.dipToScreenRect(null, clientDip);
  const state = structuredClone(fixture.data.state);
  state.window = {available: true, value: {handle: '1', x: physical.x, y: physical.y, width: physical.width, height: physical.height,
    dpi: Math.round(96 * scale), foreground: true, minimized: false, displayMode: 'windowed'}};
  const live: LiveTelemetry = {...initialLive('ats'), status: 'connected', fresh: true, observation: {source: {...fixture.source, game: 'ats', origin: 'game'},
    state, capture: fixture.capture, seq: fixture.seq, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: fixture.data.continuity}}};
  const placement = {x: 0.8485, y: 1, scale: 0.5}, reports: {event: OverlayBoundsEvent; facts: OverlayBoundsFacts}[] = [];
  const window = await overlayWindow(640, 59);
  window.webContents.setZoomFactor(0.5);
  const controller = new OverlayController(window, screen, () => undefined, 'strip',
    {placement, sections: OVERLAY_PRESETS['job-focus'], boundsReport: (event, facts) => reports.push({event, facts})});
  const client = screen.screenToDipRect(null, physical), steps: (Awaited<ReturnType<typeof observe>> & {editState: ReturnType<OverlayController['editState']>})[] = [];
  // The requested rectangle is what overlayBounds gives for the step's sections; a layout that does not fit has none.
  const step = async (label: string, sections: keyof typeof OVERLAY_PRESETS) => {
    const requested = overlayBounds('strip', client, placement, OVERLAY_PRESETS[sections]) ?? rect(0, 0, 0, 0);
    steps.push({...(await observe(window, label, requested)), editState: controller.editState()});
  };
  controller.loaded(true); controller.update(live); await step('driving, Job focus, game in front', 'job-focus');
  if (!state.window.available) throw new Error('Expected window metadata');
  state.window.value.foreground = false; controller.update(live); await step('game in the background', 'job-focus');
  controller.setLayout('strip', placement, OVERLAY_PRESETS['driving-only']); await step('Driving only saved', 'driving-only');
  controller.beginEdit(true); await step('edit mode, dashboard in front', 'driving-only');
  controller.update(live); await step('edit mode, next update', 'driving-only');
  controller.endEdit();
  state.window.value.foreground = true; controller.update(live); await step('driving, Driving only, game in front', 'driving-only');
  const final = window.getBounds(), shown = window.isVisible();
  const inside = final.x >= client.x - 1 && final.y >= client.y - 1 && final.x + final.width <= client.x + client.width + 1 && final.y + final.height <= client.y + client.height + 1;
  assert.ok(!shown || inside, 'A shown overlay must lie inside the client area');
  window.destroy();
  await writeFile(path.join(output, 'result.json'), JSON.stringify({passed: true, synthetic: true, electron: process.versions.electron,
    primaryDisplay: {scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: area}, sequences,
    controller: {physicalClient: physical, client, placement, steps, reports, final: {bounds: final, visible: shown, inside}}}, null, 2));
  clearTimeout(deadline); app.exit(0);
}).catch(async (error: unknown) => {
  await writeFile(path.join(output, 'failure.txt'), String(error)); clearTimeout(deadline); app.exit(1);
});
