import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {NowPlayingSettingsCard} from '../../apps/desktop/src/now-playing/settings-card';
import {DEFAULT_SETTINGS} from '../../apps/desktop/src/settings-schema';
import type {NowPlayingView, SettingsView} from '../../packages/contracts/src';
const view: NowPlayingView = {state: 'no-session', sources: [], selection: {kind: 'automatic'}, error: null, edit: {active: false, placement: 'unavailable'}};
const settings: SettingsView = {...DEFAULT_SETTINGS, state: 'loaded', writable: true, saveError: null};
const render = (value: SettingsView, state = view) => renderToStaticMarkup(React.createElement(NowPlayingSettingsCard, {settings: value, view: state, onSaved: () => undefined}));
it('defaults off and hides dependent controls, preserving preferences while disabled', () => {
  const html = render(settings); expect(html).toContain('Show Now Playing'); expect(html).not.toContain('id="now-playing-source"'); expect(html).not.toContain('Minimal');
});
it.each(['en', 'ru'] as const)('renders both styles, bounded opacity and independent editing controls in %s', language => {
  const html = render({...settings, language, nowPlaying: {...settings.nowPlaying, enabled: true}});
  expect(html).toContain(language === 'en' ? 'Current track' : 'Текущий трек'); expect(html).toContain('now-playing-source'); expect(html).toContain('np-minimal'); expect(html).toContain('np-full'); expect(html).toContain('aria-valuemin="40"'); expect(html).toContain('aria-valuemax="100"');
  const editing = render({...settings, language, nowPlaying: {...settings.nowPlaying, enabled: true}}, {...view, edit: {active: true, placement: 'visible'}});
  expect(editing).toContain(language === 'en' ? 'Cancel' : 'Отмена'); expect(editing).toContain(language === 'en' ? 'Reset' : 'Сбросить');
});
