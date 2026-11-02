import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it} from 'vitest';
import {NowPlayingSettingsCard} from '../../apps/desktop/src/now-playing/settings-card';
import {CurrentTrack} from '../../apps/desktop/src/now-playing/renderer';
import {DEFAULT_SETTINGS} from '../../apps/desktop/src/settings-schema';
import type {NowPlayingDisplay, NowPlayingView, SettingsView} from '../../packages/contracts/src';
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
it.each(['en', 'ru'] as const)('omits missing titles outside editing while preserving artist, source and pause status in %s', language => {
  const display: NowPlayingDisplay = {generation: 1, language, style: 'full', backgroundOpacity: 80, editing: false, source: 'Chrome',
    track: {id: 's1', revision: 1, title: null, artist: 'Fixture artist', album: null, playback: 'paused', timeline: null, artwork: null}};
  const markup = (value: NowPlayingDisplay) => renderToStaticMarkup(React.createElement(CurrentTrack, {display: value}));
  const html = markup(display), placeholder = language === 'en' ? 'Current track' : 'Текущий трек';
  expect(html).not.toContain('np-title'); expect(html).not.toContain(placeholder);
  expect(html).toContain('Fixture artist'); expect(html).toContain('Chrome'); expect(html).toContain(language === 'en' ? 'Paused' : 'Пауза');
  expect(markup({...display, editing: true})).toContain(`<div class="np-title">${placeholder}</div>`);
  expect(markup({...display, track: {...display.track!, title: 'Supplied title'}})).toContain('<div class="np-title">Supplied title</div>');
  expect(markup({...display, track: null})).toBe('');
});
