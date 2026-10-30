import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {PluginSetupView} from '../../packages/contracts/src';
import {ActionResultRegion} from '../../apps/desktop/src/action-result';
import {PluginSetupCard, PluginSetupCardView} from '../../apps/desktop/src/plugin-setup-card';
import type {ActionResultText} from '../../apps/desktop/src/plugin-action-result';

// REG-015 (ET-045b): the markup of an action result and its live regions. Only the shadcn containers are substituted;
// the Alert keeps its real default `role="alert"`, so an explicit role must override it.
type Props = Record<string, unknown> & {children?: React.ReactNode};
const strip = (keys: string[]) => (props: Props) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key)));
vi.mock('@/components/ui/alert', () => ({
  Alert: (props: Props) => React.createElement('div', {'data-slot': 'alert', role: 'alert', ...props}),
  AlertTitle: (props: Props) => React.createElement('div', {'data-slot': 'alert-title', ...props}),
  AlertDescription: (props: Props) => React.createElement('div', {'data-slot': 'alert-description', ...props})
}));
vi.mock('@/components/ui/card', () => ({Card: (props: Props) => React.createElement('div', strip(['size'])(props)), CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/badge', () => ({Badge: (props: Props) => React.createElement('span', strip(['variant'])(props))}));
vi.mock('@/components/ui/button', () => ({Button: (props: Props) => React.createElement('button', strip(['size', 'variant'])(props))}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
vi.mock('@/components/ui/switch', () => ({Switch: (props: Props) => React.createElement('button', {role: 'switch', 'aria-checked': Boolean(props.checked), ...strip(['checked', 'onCheckedChange'])(props)})}));

const text = (severity: ActionResultText['severity'], severityWord: string): ActionResultText =>
  ({severity, severityWord, title: `${severityWord} — Game folder for American Truck Simulator`, message: 'Fixed answer.'});
const region = (result: ActionResultText | null) => renderToStaticMarkup(React.createElement(ActionResultRegion, {slot: 'plugin-ats-choose', result}));
const politeOpen = '<div role="status" aria-live="polite" aria-atomic="true">';

describe('an action result', () => {
  it.each([['info', 'Information', 'lucide-info'], ['success', 'Done', 'lucide-circle-check'], ['refused', 'Refused', 'lucide-ban']] as const)(
    'shows %s with its word and icon inside the polite live region', (severity, word, icon) => {
      const html = region(text(severity, word));
      expect(html.startsWith(`<div data-testid="plugin-ats-choose-result-region" class="yu-action-result-region">${politeOpen}<div data-slot="alert"`)).toBe(true);
      expect(html).toContain(`id="plugin-ats-choose-result" data-testid="plugin-ats-choose-result" data-severity="${severity}" class="yu-action-result"`);
      expect(html).not.toContain('role="alert"');
      expect(html).toMatch(new RegExp(`<svg[^>]*class="lucide ${icon}[^"]*"[^>]*aria-hidden="true"`));
      expect(html).toContain(`<span data-testid="plugin-ats-choose-result-severity">${word}</span> — Game folder for American Truck Simulator`);
      expect(html).toContain('data-testid="plugin-ats-choose-result-message">Fixed answer.</div>');
    });
  it('shows a failure alone as an assertive alert, outside the polite region', () => {
    const html = region(text('failed', 'Failed'));
    expect(html).toContain(`${politeOpen}</div><div data-slot="alert" role="alert" id="plugin-ats-choose-result"`);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toMatch(/<svg[^>]*class="lucide lucide-circle-x[^"]*"[^>]*aria-hidden="true"/);
    expect(html).toContain('data-severity="failed"');
  });
  it('shows a title without the severity word as it is, without repeating the word', () => {
    const html = region({severity: 'info', severityWord: 'Information', title: 'Game folder for American Truck Simulator', message: 'Fixed answer.'});
    expect(html).toContain('data-testid="plugin-ats-choose-result-title">Game folder for American Truck Simulator</div>');
    expect(html).not.toContain('Information');
  });
  it('keeps an empty polite region before any result', () => {
    expect(region(null)).toBe(`<div data-testid="plugin-ats-choose-result-region" class="yu-action-result-region">${politeOpen}</div></div>`);
  });
});

describe('the Game plugin card before any action', () => {
  const view: PluginSetupView = {mode: 'test-root', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
    ets2: {excluded: false, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: [{id: 'ets2:steam:0', source: 'steam', ordinal: 0, state: 'blocked',
      reason: 'PERMISSION_DENIED', installed: {version: '0.1.0', sha256Prefix: 'aaaaaaaaaaaa'}, lastFailure: null}]},
    ats: {excluded: false, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: []}}};
  const html = renderToStaticMarkup(React.createElement(PluginSetupCard, {view, diagnosis: undefined, onView: () => undefined, language: 'en'}));
  it('has an empty live region right after every trigger', () => {
    for (const [trigger, slot] of [['plugin-ets2-managed', 'plugin-ets2-managed'], ['plugin-ats-managed', 'plugin-ats-managed'], ['plugin-ets2-choose', 'plugin-ets2-choose'],
      ['plugin-ats-choose', 'plugin-ats-choose'], ['plugin-retry', 'plugin-retry'], ['plugin-export-diagnostics', 'plugin-export-diagnostics'],
      ['plugin-target-ets2-steam-0-show-file', 'plugin-target-ets2-steam-0'], ['plugin-target-ets2-steam-0-open-folder', 'plugin-target-ets2-steam-0']]) {
      expect(html, trigger).toContain(`id="${trigger}" data-testid="${trigger}"`);
      expect(html, slot).toContain(`<div data-testid="${slot}-result-region" class="yu-action-result-region">${politeOpen}</div></div>`);
    }
    // The switch's region follows its row; a button's region follows the button or its row.
    expect(html).toMatch(/Retry<\/button><div data-testid="plugin-retry-result-region"/);
    expect(html).toMatch(/Choose game folder…<\/button><div data-testid="plugin-ats-choose-result-region"/);
    expect(html).toMatch(/Export diagnostics…<\/button><div data-testid="plugin-export-diagnostics-result-region"/);
    expect(html).toMatch(/Manage the plugin for this game<\/label><\/div><div data-testid="plugin-ets2-managed-result-region"/);
    expect(html).toMatch(/Open game plugins folder<\/button><\/div><div data-testid="plugin-target-ets2-steam-0-result-region"/);
  });
  it('has no result, no card-wide result line and no pending or described control', () => {
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('data-severity');
    expect(html).not.toContain('plugin-result"');
    expect(html).not.toContain('aria-disabled="');
    // ET-057: only the Info hints are described (by their own text); no control is described by a result.
    expect(html.match(/aria-describedby="plugin-[^"]*"/g)).toBeNull();
  });
  it('shows a stored rejected call as an alert in its own folder row, described by the button that started it', () => {
    const stored = renderToStaticMarkup(React.createElement(PluginSetupCardView, {view, diagnosis: undefined, onView: () => undefined, language: 'en', pending: false, run: () => null,
      result: {action: {kind: 'show-file', game: 'ets2', targetId: 'ets2:steam:0'}, outcome: {kind: 'request-failed'}}}));
    expect(stored).toContain(`Open game plugins folder</button></div><div data-testid="plugin-target-ets2-steam-0-result-region" class="yu-action-result-region">${politeOpen}</div>`
      + '<div data-slot="alert" role="alert" id="plugin-target-ets2-steam-0-result" data-testid="plugin-target-ets2-steam-0-result" data-severity="failed" class="yu-action-result">');
    expect(stored).toContain('<span data-testid="plugin-target-ets2-steam-0-result-severity">Failed</span> — Plugin file for Euro Truck Simulator 2 (Steam folder 1)');
    expect(stored).toContain('data-testid="plugin-target-ets2-steam-0-result-message">The request failed; nothing changed.</div>');
    expect(stored.match(/role="alert"/g)).toHaveLength(1);
    expect(stored.match(/aria-describedby="plugin-[^"]*"/g)).toEqual(['aria-describedby="plugin-target-ets2-steam-0-result"']);
    expect(stored).toMatch(/id="plugin-target-ets2-steam-0-show-file" data-testid="plugin-target-ets2-steam-0-show-file" aria-describedby="plugin-target-ets2-steam-0-result"/);
    expect(stored).not.toContain('aria-disabled="');
  });
  it('marks every control pending while a call runs, keeping them focusable', () => {
    const pending = renderToStaticMarkup(React.createElement(PluginSetupCardView, {view, diagnosis: undefined, onView: () => undefined, language: 'en', pending: true, run: () => null, result: null}));
    expect(pending.match(/aria-disabled="true"/g)).toHaveLength(8);
    expect(pending).not.toMatch(/ disabled=""/);
  });
  it('marks the static mode note as a note, not an alert', () => {
    expect(html).toContain('<div data-slot="alert" role="note"><div data-slot="alert-description" data-testid="plugin-mode">Test mode: plugin setup works only inside a test folder.</div></div>');
  });
});
