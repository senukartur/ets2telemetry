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

// #E2E8F0 on the #EDF1F7 chrome measures about 1.09:1, the near-identical #EEF2F7 about 1.01:1.
const HOVER_MIN_CONTRAST = 1.05;

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
  it('keeps the navigation and segment hover visible on the chrome surface', () => {
    expect(contrast(parseColor(token('--yu-hover-bg')), parseColor(token('--yu-bg-chrome')))).toBeGreaterThanOrEqual(HOVER_MIN_CONTRAST);
    expect(contrast(parseColor(token('--yu-neutral-bg')), parseColor(token('--yu-bg-chrome')))).toBeLessThan(HOVER_MIN_CONTRAST);
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
    expect(Object.fromEntries(['--yu-accent-text', '--yu-ok-graphic', '--yu-warn-graphic', '--yu-update-fg', '--yu-switch-thumb', '--yu-segment-selected-bg', '--yu-segment-selected-shadow', '--yu-menu-shadow', '--yu-hover-bg']
      .map(name => [name, dark.get(name)]))).toEqual({'--yu-accent-text': '#60A5FA', '--yu-ok-graphic': '#34D399', '--yu-warn-graphic': '#FBBF24', '--yu-update-fg': '#93C5FD',
      '--yu-switch-thumb': '#E2E8F0', '--yu-segment-selected-bg': '#1E293B', '--yu-segment-selected-shadow': 'none', '--yu-menu-shadow': '0 12px 32px #0006', '--yu-hover-bg': '#151D2C'});
  });
  it('scopes the dark palette and colour scheme to .yu-theme-dark and lets :root follow the resolved theme', () => {
    expect(appTokens).toContain(':root { color-scheme: light dark; }');
    expect(appTokens).toContain('.yu-theme-dark { color-scheme: dark; }');
    expect(appTokens).toMatch(/:root, \.yu-theme-dark \{/);
    expect(appTokens).not.toMatch(/^\s*color-scheme: dark;/m);
  });
  it('re-declares the shadcn mapping in the dark scope, with the dark --chart-3, and overrides it in light on :root only', () => {
    expect(css).toMatch(/:root, \.yu-theme-dark \{\s*--background: var\(--yu-bg-app\);[^}]*--chart-3: #2DD4BF;/);
    expect(lightBlock).toMatch(/^@media \(prefers-color-scheme: light\) \{\s*:root \{/);
    expect(lightBlock).not.toContain('.yu-theme-dark');
  });
  it('uses the hover token on the navigation rows and both segment controls', () => {
    for (const selector of ['.yu-nav-item:hover', '.yu-settings-nav button:hover', '.yu-journal-toolbar .yu-segmented button[aria-pressed="false"]:hover', '.yu-segment-option:not(:has([data-state="checked"])):not(:has(:disabled)):hover']) {
      expect(shell).toMatch(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ ?background: ?var\\(--yu-hover-bg\\)`));
    }
  });
  it('keeps the info hint button circular without global button min-height stretching it into an oval', () => {
    expect(shell).toMatch(/button:not\(\[role="radio"\]\):not\(\[role="switch"\]\):not\(\.yu-info-hint\)/);
    const blockMatch = /button\.yu-info-hint,\s*\.yu-info-hint\s*\{([^}]+)\}/.exec(shell);
    expect(blockMatch).toBeTruthy();
    if (!blockMatch) throw new Error('Missing .yu-info-hint block in shell.css');
    const decls = new Map([...blockMatch[1].matchAll(/([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1].trim(), m[2].trim()]));
    expect(decls.get('width')).toBe('22px');
    expect(decls.get('height')).toBe('22px');
    expect(decls.get('min-width')).toBe('22px');
    expect(decls.get('min-height')).toBe('22px');
    expect(decls.get('max-width')).toBe('22px');
    expect(decls.get('max-height')).toBe('22px');
    expect(decls.get('aspect-ratio')).toBe('1 / 1');
    expect(decls.get('border-radius')).toBe('50% !important');
  });
  // ET-110: the 32 px button minimum (specificity 0,3,1) outranked the chip rule (0,2,1) and made the sync chip taller.
  it('keeps the site sync chip at the 24 px chip height outside the global button rules', () => {
    const css = stripComments(shell);
    const globals = [...css.matchAll(/^button:not\(\[role="radio"\]\)[^{]*\{[^}]*\}/gm)].map(match => match[0]);
    expect(globals).toHaveLength(2);
    for (const rule of globals) expect(rule.slice(0, rule.indexOf(','))).toMatch(/:not\(\.yu-sync-chip\)$/);
    const chip = /\.yu-topbar button\.yu-sync-chip \{([^}]+)\}/.exec(css);
    if (!chip) throw new Error('Missing the top-bar sync chip rule in shell.css');
    const decls = new Map([...chip[1].matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
    expect(Object.fromEntries(['height', 'min-height', 'box-sizing', 'line-height'].map(name => [name, decls.get(name)]))).toEqual({height: 'var(--yu-control-h-xs)', 'min-height': 'var(--yu-control-h-xs)', 'box-sizing': 'border-box', 'line-height': '1'});
  });
  // ET-110: compact page content fills the window; only individual controls such as the token field keep a cap.
  it('sets no maximum width on the content column or a compact page root', () => {
    const css = stripComments(shell);
    for (const selector of ['.yu-content', '.yu-live-screen', '.yu-live', '.yu-settings', '.yu-journal', '.yu-trip', '.yu-account', '.yu-overlay-settings', '.yu-stack', '.yu-hard-mode']) {
      // Every rule whose selector list names the class exactly, alone or with others.
      const rules = [...css.matchAll(/(?<=^|\})\s*([^{}]+)\{([^}]*)\}/g)].filter(match => match[1].split(',').some(part => part.trim() === selector));
      if (selector !== '.yu-live-screen' && selector !== '.yu-hard-mode') expect(rules.length, selector).toBeGreaterThan(0);
      for (const rule of rules) expect(rule[2], selector).not.toMatch(/max-width/);
    }
    expect(css).not.toMatch(/max-width:\s*1[0-9]{3}px/);
  });
  // ET-110: a stopped sweep would leave an accent block that reads as a partial value; reduced motion shows even stripes instead.
  it('shows the first upload count as even stripes, not a stopped sweep, under reduced motion', () => {
    const css = stripComments(shell);
    const rule = /@media \(prefers-reduced-motion: reduce\) \{ \.yu-account progress:not\(\[value\]\) \{([^}]+)\} \}/.exec(css);
    if (!rule) throw new Error('Missing the reduced-motion rule for the indeterminate upload bar in shell.css');
    expect(rule[1]).toMatch(/animation: none !important;/);
    expect(rule[1]).toMatch(/background: repeating-linear-gradient\(90deg, var\(--yu-accent-light\) 0 6px, var\(--yu-border\) 6px 12px\);/);
  });
});
