import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {WINDOW_CHROME} from '../../apps/desktop/src/window-theme';

// ET-082: static checks of the two palettes. The light theme must stay legible and complete, the dark one must keep its values.
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const appTokens = read('apps/desktop/src/shell/tokens.css');
const designTokens = read('docs/design/tokens.css');
const shell = read('apps/desktop/src/shell/shell.css');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const declarations = (block: string) => new Map([...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(match => [`--${match[1]}`, match[2].trim()]));

const css = stripComments(appTokens);
const darkBlock = css.slice(css.indexOf(':root, .yu-theme-dark {'), css.indexOf('\n}\n', css.indexOf(':root, .yu-theme-dark {')));
const lightBlock = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
const dark = declarations(darkBlock), light = declarations(lightBlock);

type Rgba = [number, number, number, number];
function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [parseInt(hex[1].slice(0, 2), 16), parseInt(hex[1].slice(2, 4), 16), parseInt(hex[1].slice(4, 6), 16), 1];
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), Number(rgba[4])];
  throw new Error(`Unsupported colour: ${value}`);
}
const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
const luminance = ([r, g, b]: Rgba) => {
  const channel = (value: number) => {const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;};
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a: Rgba, b: Rgba) => {const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05);};
const token = (name: string): string => {
  const value = light.get(name);
  if (!value) throw new Error(`No light value for ${name}`);
  return value;
};

const SURFACES = ['--yu-bg-app', '--yu-bg-chrome', '--yu-bg-card', '--yu-bg-raised', '--yu-bg-inset', '--yu-bg-input', '--yu-nav-active-bg', '--yu-gear-bg'] as const;
const TEXT = ['--yu-text', '--yu-text-strong', '--yu-text-secondary', '--yu-text-muted', '--yu-text-subtle', '--yu-accent-text', '--yu-selected-fg', '--yu-update-fg',
  '--yu-ok-fg', '--yu-warn-fg', '--yu-err-fg', '--yu-neutral-fg', '--yu-ets2-fg', '--yu-ats-fg'] as const;
const TINTED = [['--yu-ok-fg', '--yu-ok-bg'], ['--yu-warn-fg', '--yu-warn-bg'], ['--yu-err-fg', '--yu-err-bg'], ['--yu-ets2-fg', '--yu-ets2-bg'], ['--yu-ats-fg', '--yu-ats-bg'], ['--yu-selected-fg', '--yu-selected-bg']] as const;
// The surfaces a status tint is composited over: the page, chrome and card (never over a raised or tinted surface).
const TINT_SURFACES = ['--yu-bg-app', '--yu-bg-chrome', '--yu-bg-card', '--yu-bg-inset'] as const;

describe('the light theme palette', () => {
  it.each(TEXT.flatMap(text => SURFACES.map(surface => [text, surface] as const)))('keeps %s readable on %s', (text, surface) => {
    expect(contrast(parseColor(token(text)), parseColor(token(surface)))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(TINTED.flatMap(([text, tint]) => TINT_SURFACES.map(surface => [text, tint, surface] as const)))('keeps %s readable on %s over %s', (text, tint, surface) => {
    expect(contrast(parseColor(token(text)), over(parseColor(token(tint)), parseColor(token(surface))))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(['--yu-border-input', '--yu-border-strong'].flatMap(line => ['--yu-bg-card', '--yu-bg-app'].map(surface => [line, surface] as const)))('keeps the %s outline visible on %s', (line, surface) => {
    expect(contrast(parseColor(token(line)), parseColor(token(surface)))).toBeGreaterThanOrEqual(3);
  });
  it('overrides every dark colour token', () => {
    const colours = [...dark].filter(([, value]) => /#|rgba?\(|linear-gradient|^none$/.test(value)).map(([name]) => name);
    expect(colours.length).toBeGreaterThan(50);
    expect(colours.filter(name => !light.has(name))).toEqual([]);
  });
  it('overrides --chart-3, a raw colour of the shadcn mapping', () => {
    expect(light.get('--chart-3')).toBe('#0D9488');
    expect(css.indexOf('--chart-3: #2DD4BF')).toBeLessThan(css.indexOf('@media (prefers-color-scheme: light)'));
  });
});

describe('the shared files and the dark scope', () => {
  it('keeps the design copy starting with the exact application tokens', () => {
    expect(designTokens.startsWith(appTokens)).toBe(true);
  });
  it('matches the native window chrome to the page and chrome tokens', () => {
    expect(WINDOW_CHROME.dark).toMatchObject({background: dark.get('--yu-bg-app'), titleBar: dark.get('--yu-bg-chrome')});
    expect(WINDOW_CHROME.light).toMatchObject({background: light.get('--yu-bg-app'), titleBar: light.get('--yu-bg-chrome')});
  });
  it('gives the new tokens the dark values their call sites resolved before', () => {
    expect(Object.fromEntries(['--yu-accent-text', '--yu-ok-graphic', '--yu-warn-graphic', '--yu-update-fg', '--yu-switch-thumb', '--yu-segment-selected-bg', '--yu-segment-selected-shadow', '--yu-menu-shadow']
      .map(name => [name, dark.get(name)]))).toEqual({'--yu-accent-text': '#60A5FA', '--yu-ok-graphic': '#34D399', '--yu-warn-graphic': '#FBBF24', '--yu-update-fg': '#93C5FD',
      '--yu-switch-thumb': '#E2E8F0', '--yu-segment-selected-bg': '#1E293B', '--yu-segment-selected-shadow': 'none', '--yu-menu-shadow': '0 12px 32px #0006'});
  });
  it('scopes the dark palette and colour scheme to .yu-theme-dark and lets :root follow the resolved theme', () => {
    expect(appTokens).toContain(':root { color-scheme: light dark; }');
    expect(appTokens).toContain('.yu-theme-dark { color-scheme: dark; }');
    expect(appTokens).toMatch(/:root, \.yu-theme-dark \{/);
    expect(appTokens).not.toMatch(/^\s*color-scheme: dark;/m);
  });
  it('keeps the shell free of the literal colours the theme replaced', () => {
    expect(shell).not.toMatch(/color: #93C5FD|box-shadow: 0 12px 32px #0006/);
  });
});
