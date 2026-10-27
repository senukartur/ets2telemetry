import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {SettingsStore} from '../../apps/desktop/src/settings-store';
import {trayModel, type TrayInput} from '../../apps/desktop/src/tray-model';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import type {AppHealth, OverlayPresentation} from '../../packages/contracts/src';

describe('i18n settings lifecycle and reflection', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-i18n-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, {recursive: true, force: true});
  });

  it('starts in English by default, persists language switch to Russian across reloads, and reflects in tray and overlay', async () => {
    const store1 = new SettingsStore(tempDir);
    const initialView = await store1.load();
    expect(initialView.language).toBe('en');

    // 1. Initial English tray and overlay reflection
    const health: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
    const trayInputEn: TrayInput = {health, exiting: false, language: initialView.language};
    const trayEn = trayModel(trayInputEn);
    expect(trayEn.menu[0]).toEqual({kind: 'status', label: 'Service: ready · Storage self-test: verified'});
    expect(trayEn.menu[1]).toEqual({kind: 'status', label: 'Recording: off in this version'});
    expect(trayEn.menu[3]).toEqual({kind: 'open', label: 'Open Yukon Union Telemetry', enabled: true});
    expect(trayEn.menu[5]).toEqual({kind: 'exit', label: 'Exit Yukon Union Telemetry', enabled: true});

    const overlayPresentationEn: OverlayPresentation = {
      source: 'ETS2', origin: 'game', status: 'connected', speed: '80.0', speedUnit: 'km/h',
      fuel: '200.0', fuelUnit: 'L', freshness: 'current', layout: 'strip', paused: false,
      sections: [{id: 'speed', state: 'value', text: '80.0 km/h'}, {id: 'fuel', state: 'value', text: '200.0 L'}],
      editing: false, language: initialView.language
    };
    const overlayEn = overlayView(overlayPresentationEn);
    expect(overlayEn.items[0].label).toBe('Speed');
    expect(overlayEn.items[0].unit).toBe('km/h');
    expect(overlayEn.items[1].label).toBe('Fuel');
    expect(overlayEn.items[1].unit).toBe('L');

    // 2. Switch to Russian
    const updatedView = await store1.setLanguage('ru');
    expect(updatedView.language).toBe('ru');

    // 3. Verify file on disk has format v4 and language: "ru"
    const diskContent = JSON.parse(await fs.readFile(path.join(tempDir, 'settings.json'), 'utf8'));
    // ET-045e made the current settings format v8 (ET-049 took v7 first); ET-050 made it v9 (per-game gear display); ET-050b made it v10 (the crawler gear mode); ET-052 made it v11; ET-050b per-gearbox modes make it v12.
    expect(diskContent.version).toBe(12);
    expect(diskContent.language).toBe('ru');

    // 4. Verify Russian tray and overlay reflection
    const trayInputRu: TrayInput = {health, exiting: false, language: updatedView.language};
    const trayRu = trayModel(trayInputRu);
    expect(trayRu.menu[0]).toEqual({kind: 'status', label: 'Служба: готово · Проверка хранилища: проверено'});
    expect(trayRu.menu[1]).toEqual({kind: 'status', label: 'Запись: отключено в этой версии'});
    expect(trayRu.menu[3]).toEqual({kind: 'open', label: 'Открыть Yukon Union Telemetry', enabled: true});
    expect(trayRu.menu[5]).toEqual({kind: 'exit', label: 'Выход', enabled: true});

    const overlayPresentationRu: OverlayPresentation = {
      ...overlayPresentationEn,
      language: updatedView.language
    };
    const overlayRu = overlayView(overlayPresentationRu);
    expect(overlayRu.items[0].label).toBe('Скорость');
    expect(overlayRu.items[0].unit).toBe('км/ч');
    expect(overlayRu.items[1].label).toBe('Топливо');
    expect(overlayRu.items[1].unit).toBe('л');

    // 5. Simulate app restart: re-instantiate store from same directory
    const store2 = new SettingsStore(tempDir);
    const reloadedView = await store2.load();
    expect(reloadedView.language).toBe('ru');
    expect(reloadedView.state).toBe('loaded');

    // 6. Switch back to English and persist
    const switchedBackView = await store2.setLanguage('en');
    expect(switchedBackView.language).toBe('en');

    const store3 = new SettingsStore(tempDir);
    const thirdView = await store3.load();
    expect(thirdView.language).toBe('en');
  });
});
