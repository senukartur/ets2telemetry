import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {AppHealth} from '../../packages/contracts/src';
import {TRAY_TOOLTIP_LIMIT, TrayPresenter, trayModel, type TrayInput} from '../../apps/desktop/src/tray-model';
import {RECORDING_CODES} from '../../apps/desktop/src/recording-status';
import type {RecordingHealth, RecordingLosses, RecordingState} from '../../packages/contracts/src';

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
  const view = {setToolTip: vi.fn(), setMenu: vi.fn()};
  const presenter = new TrayPresenter(view, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now()});
  presenter.update(ready);
  presenter.update(withRecording({state: 'recording', target: 'synthetic', code: null, losses: NO_LOSSES, trip: null})); await vi.advanceTimersByTimeAsync(500);
  expect(view.setMenu).toHaveBeenCalledTimes(2); expect(view.setToolTip).toHaveBeenCalledOnce();
  expect(view.setMenu.mock.lastCall?.[0][1]).toEqual({kind: 'status', label: 'Recording: on · synthetic test database'});
  presenter.dispose();
});

it('applies only changed parts at most twice per second, ending with the latest state', async () => {
  const view = {setToolTip: vi.fn(), setMenu: vi.fn()};
  const presenter = new TrayPresenter(view, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>), now: () => Date.now()});
  presenter.update(ready);
  expect(view.setToolTip).toHaveBeenCalledOnce(); expect(view.setMenu).toHaveBeenCalledOnce();
  presenter.update(ready); await vi.advanceTimersByTimeAsync(1000);
  expect(view.setToolTip).toHaveBeenCalledOnce(); expect(view.setMenu).toHaveBeenCalledOnce();
  // Twenty status flips within one second produce at most two tooltip writes and end on the final state.
  for (let flip = 0; flip < 20; flip++) {
    presenter.update({...ready, source: {selection: 'ets2', status: flip % 2 ? 'connected' : 'stale'}}); await vi.advanceTimersByTimeAsync(50);
  }
  presenter.update({...ready, source: {selection: 'ets2', status: 'stale'}}); await vi.advanceTimersByTimeAsync(500);
  expect(view.setToolTip.mock.calls.length).toBeLessThanOrEqual(1 + 3);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nService ready · Source: ETS2 (stale)');
  // Source status changes do not alter the menu.
  expect(view.setMenu).toHaveBeenCalledOnce();
  presenter.update({...ready, health: health('failed', 'pending')}); presenter.update({...ready, exiting: true}, true);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting');
  presenter.dispose(); presenter.update(ready); await vi.advanceTimersByTimeAsync(1000);
  expect(view.setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting'); expect(vi.getTimerCount()).toBe(0);
});
