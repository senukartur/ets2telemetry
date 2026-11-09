import {expect, it} from 'vitest';
import {titleBarOverlayOptions, windowBackground, WINDOW_CHROME} from '../../apps/desktop/src/window-theme';

// ET-082: the native window colours for each resolved theme. Expected values are written by hand from the design tokens; the
// dark ones are the constants the window used before the light theme.
it('keeps the dark window chrome at the constants used before the light theme', () => {
  expect(WINDOW_CHROME.dark).toEqual({background: '#0E1525', titleBar: '#0A101D', symbols: '#94A3B8'});
  expect(titleBarOverlayOptions(true)).toEqual({color: '#0A101D', symbolColor: '#94A3B8', height: 32});
  expect(windowBackground(true)).toBe('#0E1525');
});
it('uses the light chrome surfaces and caption symbols in the light theme', () => {
  expect(WINDOW_CHROME.light).toEqual({background: '#F5F7FB', titleBar: '#EDF1F7', symbols: '#4A5A70'});
  expect(titleBarOverlayOptions(false)).toEqual({color: '#EDF1F7', symbolColor: '#4A5A70', height: 32});
  expect(windowBackground(false)).toBe('#F5F7FB');
});
