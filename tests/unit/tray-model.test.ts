import {crc32, inflateSync} from 'node:zlib';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {AppHealth} from '../../packages/contracts/src';
import {TRAY_TOOLTIP_LIMIT, TrayPresenter, trayModel, trayTone, type TrayInput} from '../../apps/desktop/src/tray-model';
import {RECORDING_CODES} from '../../apps/desktop/src/recording-status';
import type {RecordingHealth, RecordingLosses, RecordingState} from '../../packages/contracts/src';
import {TRAY_ICON_REPRESENTATIONS, TRAY_TONE_RGB, trayIconPng, type TrayIconSize, type TrayTone} from '../../apps/desktop/src/tray-icon';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const health = (service: AppHealth['service'], storage: AppHealth['storage'] = 'verified'): AppHealth => ({service, storage, recording: {state: 'disabled'}, lastError: null});
const ready: TrayInput = {health: health('ready'), exiting: false, source: {selection: 'ets2', status: 'connected'}};

it('builds the status, recording, open and exit menu and disables actions while exiting', () => {
  expect(trayModel(ready).menu).toEqual([
    {kind: 'status', label: 'Service: ready · Storage self-test: verified'},
    {kind: 'status', label: 'Recording: off in this version'},
    {kind: 'separator'},
    {kind: 'open', label: 'Open ETS2Telemetry', enabled: true},
    {kind: 'separator'},
    {kind: 'exit', label: 'Exit ETS2Telemetry', enabled: true}
  ]);
  const exiting = trayModel({...ready, exiting: true});
  expect(exiting.menu.filter(item => item.kind === 'open' || item.kind === 'exit').every(item => 'enabled' in item && !item.enabled)).toBe(true);
  expect(exiting.tooltip).toBe('ETS2Telemetry\nExiting');
});

it('builds localized Russian menu and tooltip when language is ru', () => {
  const ruReady: TrayInput = {...ready, language: 'ru'};
  expect(trayModel(ruReady).menu).toEqual([
    {kind: 'status', label: 'Служба: готово · Проверка хранилища: проверено'},
    {kind: 'status', label: 'Запись: отключено в этой версии'},
    {kind: 'separator'},
    {kind: 'open', label: 'Открыть ETS2Telemetry', enabled: true},
    {kind: 'separator'},
    {kind: 'exit', label: 'Выход', enabled: true}
  ]);
  expect(trayModel(ruReady).tooltip).toBe('ETS2Telemetry\nСлужба готово · Источник: ETS2 (connected)');
  const exiting = trayModel({...ruReady, exiting: true});
  expect(exiting.tooltip).toBe('ETS2Telemetry\nЗавершение работы');
});

it('keeps tooltips within the notification-area limit and free of readings or paths', () => {
  expect(trayModel({...ready, health: health('starting', 'pending')}).tooltip).toBe('ETS2Telemetry\nStarting');
  expect(trayModel(ready).tooltip).toBe('ETS2Telemetry\nService ready · Source: ETS2 (connected)');
  expect(trayModel({...ready, health: health('restarting', 'pending')}).tooltip).toBe('ETS2Telemetry\nService restarting');
  for (const service of ['starting', 'ready', 'restarting', 'failed', 'stopping'] as const) for (const selection of ['game', 'ets2', 'ats', 'synthetic', 'replay'] as const)
    for (const status of ['waiting', 'connected', 'service-failed', 'incompatible'] as const) for (const exiting of [false, true])
      expect(trayModel({health: health(service), exiting, source: {selection, status}}).tooltip.length).toBeLessThanOrEqual(TRAY_TOOLTIP_LIMIT);
});

// ET-015c PR-4 (G8): the second status line shows the recording status; the expected lines are written by hand.
const NO_LOSSES: RecordingLosses = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
const withRecording = (recording: RecordingHealth): TrayInput => ({...ready, health: {...ready.health, recording}});
const recordingLine = (input: TrayInput) => trayModel(input).menu[1];
it('shows the recording status as the second status line', () => {
  expect(recordingLine(withRecording({state: 'unknown'}))).toEqual({kind: 'status', label: 'Recording: not known'});
  expect(recordingLine(withRecording({state: 'recording', target: 'synthetic', code: null, losses: NO_LOSSES, trip: null})))
    .toEqual({kind: 'status', label: 'Recording: on · synthetic test database'});
  expect(recordingLine(withRecording({state: 'retrying', target: 'history', code: 'DISK_FULL', losses: {...NO_LOSSES, lostEvents: 3}, trip: null})))
    .toEqual({kind: 'status', label: 'Recording: retrying, the disk is full'});
  expect(recordingLine(withRecording({state: 'live-only', target: 'replay', code: 'ACK_AHEAD_OF_STORAGE', losses: NO_LOSSES, trip: null})))
    .toEqual({kind: 'status', label: 'Recording: not this game session · replay test database'});
  // The line stays while exiting; only the actions are disabled. The tooltip never carries it.
  expect(recordingLine({...withRecording({state: 'unknown'}), exiting: true})).toEqual({kind: 'status', label: 'Recording: not known'});
  expect(trayModel(withRecording({state: 'unknown'})).tooltip).toBe('ETS2Telemetry\nService ready · Source: ETS2 (connected)');
});
it('keeps every recording line within the notification-area limit', () => {
  const states: RecordingState[] = ['opening', 'waiting', 'recording', 'paused', 'interrupted', 'retrying', 'not-recorded-source', 'live-only', 'stopped'];
  for (const state of states) for (const target of ['history', 'synthetic', 'replay'] as const) for (const code of [null, ...RECORDING_CODES]) {
    const label = recordingLine(withRecording({state, target, code, losses: NO_LOSSES, trip: null}));
    expect(label.kind === 'status' && label.label.startsWith('Recording: ') && label.label.length <= TRAY_TOOLTIP_LIMIT).toBe(true);
  }
});
it('rebuilds only the menu when the recording status changes', async () => {
  const view = {setToolTip: vi.fn(), setMenu: vi.fn(), setTone: vi.fn()};
  const presenter = new TrayPresenter(view, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now()});
  presenter.update(ready);
  presenter.update(withRecording({state: 'recording', target: 'synthetic', code: null, losses: NO_LOSSES, trip: null})); await vi.advanceTimersByTimeAsync(500);
  expect(view.setMenu).toHaveBeenCalledTimes(2); expect(view.setToolTip).toHaveBeenCalledOnce(); expect(view.setTone).toHaveBeenCalledOnce();
  expect(view.setMenu.mock.lastCall?.[0][1]).toEqual({kind: 'status', label: 'Recording: on · synthetic test database'});
  presenter.dispose();
});

it('selects ready, busy and failed tones from health', () => {
  expect(trayTone(health('ready'), false)).toBe('ready');
  for (const service of ['starting', 'restarting', 'stopping'] as const) expect(trayTone(health(service), false)).toBe('busy');
  expect(trayTone(health('failed'), false)).toBe('failed');
  expect(trayTone(health('ready'), true)).toBe('busy');
});

it('applies only changed parts at most twice per second, ending with the latest state', async () => {
  const view = {setToolTip: vi.fn(), setMenu: vi.fn(), setTone: vi.fn()};
  const presenter = new TrayPresenter(view, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now()});
  presenter.update(ready);
  expect(view.setToolTip).toHaveBeenCalledOnce(); expect(view.setMenu).toHaveBeenCalledOnce(); expect(view.setTone).toHaveBeenCalledExactlyOnceWith('ready');
  presenter.update(ready); await vi.advanceTimersByTimeAsync(1000);
  expect(view.setToolTip).toHaveBeenCalledOnce(); expect(view.setMenu).toHaveBeenCalledOnce();
  // Twenty status flips within one second produce at most two tooltip writes and end on the final state.
  for (let flip = 0; flip < 20; flip++) {
    presenter.update({...ready, source: {selection: 'ets2', status: flip % 2 ? 'connected' : 'stale'}}); await vi.advanceTimersByTimeAsync(50);
  }
  presenter.update({...ready, source: {selection: 'ets2', status: 'stale'}}); await vi.advanceTimersByTimeAsync(500);
  expect(view.setToolTip.mock.calls.length).toBeLessThanOrEqual(1 + 3);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nService ready · Source: ETS2 (stale)');
  // Source status changes alter neither the menu nor the icon.
  expect(view.setMenu).toHaveBeenCalledOnce(); expect(view.setTone).toHaveBeenCalledOnce();
  presenter.update({...ready, health: health('failed', 'pending')}); presenter.update({...ready, exiting: true}, true);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting'); expect(view.setTone).toHaveBeenLastCalledWith('busy');
  presenter.dispose(); presenter.update(ready); await vi.advanceTimersByTimeAsync(1000);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting'); expect(vi.getTimerCount()).toBe(0);
});

function chunks(png: Buffer) {
  const result: {type: string; data: Buffer; crcValid: boolean}[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    result.push({type, data, crcValid: png.readUInt32BE(offset + 8 + length) === crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0});
    offset += 12 + length;
  }
  return result;
}
function pixels(png: Buffer, size: number) {
  const parsed = chunks(png);
  expect(parsed.map(entry => entry.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  expect(parsed.every(entry => entry.crcValid)).toBe(true);
  const header = parsed[0].data;
  expect([header.readUInt32BE(0), header.readUInt32BE(4), header[8], header[9], header[10], header[11], header[12]]).toEqual([size, size, 8, 6, 0, 0, 0]);
  const rows = inflateSync(parsed[1].data);
  expect(rows.length).toBe(size * (1 + size * 4));
  for (let y = 0; y < size; y++) expect(rows[y * (1 + size * 4)]).toBe(0); // Filter byte 0: no filtering.
  return (x: number, y: number) => [...rows.subarray(y * (1 + size * 4) + 1 + x * 4, y * (1 + size * 4) + 1 + x * 4 + 4)];
}
it('provides valid RGBA PNG representations for every notification-area scale', () => {
  expect(TRAY_ICON_REPRESENTATIONS.map(entry => [entry.size, entry.scaleFactor])).toEqual([[16, 1], [20, 1.25], [24, 1.5], [32, 2]]);
  for (const {size} of TRAY_ICON_REPRESENTATIONS) {
    const reference = pixels(trayIconPng(size, 'ready'), size);
    for (const tone of Object.keys(TRAY_TONE_RGB) as TrayTone[]) {
      const png = trayIconPng(size, tone);
      expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const pixel = pixels(png, size);
      // Rounded tile corners stay (nearly) transparent; the lower right status dot carries the exact tone colour.
      expect(pixel(0, 0)[3]).toBeLessThan(16);
      const dot = Math.floor(size * 0.79);
      expect(pixel(dot, dot)).toEqual([...TRAY_TONE_RGB[tone], 255]);
      // Only the status dot changes with the tone; the bear tile is shared.
      let changed = 0;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (pixel(x, y).join() !== reference(x, y).join()) {
        changed++; expect(x + y).toBeGreaterThanOrEqual(size);
      }
      expect(changed).toBeLessThan(size * size / 4);
    }
  }
  expect(() => trayIconPng(4 as TrayIconSize, 'ready')).toThrow(); expect(() => trayIconPng(16, 'unknown' as TrayTone)).toThrow();
});
it('uses visibly distinct colours for each health tone', () => {
  const tones = Object.values(TRAY_TONE_RGB);
  for (const [index, left] of tones.entries()) for (const right of tones.slice(index + 1))
    expect(Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])).toBeGreaterThan(80);
});
