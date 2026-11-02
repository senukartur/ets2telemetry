import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, it} from 'vitest';
import {DEFAULT_SETTINGS, migrateToCurrent, parseSettings, serializeSettings} from '../../apps/desktop/src/settings-schema';
import {DEFAULT_NOW_PLAYING} from '../../apps/desktop/src/now-playing/contract';
import {SettingsStore} from '../../apps/desktop/src/settings-store';
it('purely migrates v11 defaults without changing existing fields or SQLite, and independently falls back invalid media fields', () => {
  const old = {...DEFAULT_SETTINGS, nowPlaying: undefined, format: 'ets2telemetry.settings', version: 11, language: 'ru', autostart: true};
  const before = structuredClone(old), migrated = migrateToCurrent(old, 11);
  expect(migrated).toEqual({...old, version: 12, nowPlaying: {enabled: false, style: 'minimal', backgroundOpacity: 80, position: {displayId: null, x: 1, y: 0.75}}}); expect(old).toEqual(before);
  const current = {...DEFAULT_SETTINGS, format: 'ets2telemetry.settings', version: 12, nowPlaying: {enabled: true, style: 'bad', backgroundOpacity: 39, position: {displayId: null, x: 2, y: 0}}};
  const parsed = parseSettings(Buffer.from(JSON.stringify(current)));
  expect(parsed).toMatchObject({state: 'loaded-with-fallbacks', settings: {nowPlaying: {...DEFAULT_NOW_PLAYING, enabled: true}}, fallbackFields: ['nowPlaying.style', 'nowPlaying.backgroundOpacity', 'nowPlaying.position']});
});
it('preserves startup bytes and preferences through durable media saves and restart in an isolated directory', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'et061-settings-'));
  try {
    const file = path.join(directory, 'settings.json'), old = JSON.stringify({...DEFAULT_SETTINGS, nowPlaying: undefined, format: 'ets2telemetry.settings', version: 11});
    await writeFile(file, old); const store = new SettingsStore(directory); await store.load(); expect(await readFile(file, 'utf8')).toBe(old);
    await store.setNowPlayingStyle('full'); await store.setNowPlayingBackgroundOpacity(40); await store.setNowPlayingPosition({displayId: '2', x: 0.4, y: 0.6});
    await store.setNowPlayingEnabled(true); await store.setNowPlayingEnabled(false);
    const bytes = await readFile(file, 'utf8'), restarted = new SettingsStore(directory);
    expect((await restarted.load()).nowPlaying).toEqual({enabled: false, style: 'full', backgroundOpacity: 40, position: {displayId: '2', x: 0.4, y: 0.6}});
    expect(bytes).toBe(serializeSettings({...DEFAULT_SETTINGS, nowPlaying: store.view().nowPlaying})); expect(await readFile(file, 'utf8')).toBe(bytes);
  } finally {await rm(directory, {recursive: true, force: true});}
});
