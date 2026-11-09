/** Native window colours per resolved theme (ET-082). Pure, so tests read them without Electron; docs/design/ui-spec.md describes them. */
export const WINDOW_CHROME = Object.freeze({
  dark: Object.freeze({background: '#0E1525', titleBar: '#0A101D', symbols: '#94A3B8'}),
  light: Object.freeze({background: '#F5F7FB', titleBar: '#EDF1F7', symbols: '#4A5A70'})
});

const TITLE_BAR_HEIGHT = 32;

/** The window background painted before the stylesheet loads, so the first frame already has the resolved theme. */
export const windowBackground = (dark: boolean): string => (dark ? WINDOW_CHROME.dark : WINDOW_CHROME.light).background;

/** The native title bar overlay of the dashboard window for the resolved theme. */
export function titleBarOverlayOptions(dark: boolean): {color: string; symbolColor: string; height: number} {
  const chrome = dark ? WINDOW_CHROME.dark : WINDOW_CHROME.light;
  return {color: chrome.titleBar, symbolColor: chrome.symbols, height: TITLE_BAR_HEIGHT};
}
