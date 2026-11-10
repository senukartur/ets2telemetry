import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {AppLanguage} from '../../packages/contracts/src';
import {initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {ShellSlot, ShellSlotsProvider} from '../../apps/desktop/src/shell/shell-slots';
import {SidebarNav} from '../../apps/desktop/src/shell/sidebar-nav';
import {TopBar} from '../../apps/desktop/src/shell/top-bar';
import {SyncChip} from '../../apps/desktop/src/dashboard-upload/sync-chip';
import {ThemedLogo} from '../../apps/desktop/src/shell/themed-logo';
import {unavailableUploadUi} from '../../apps/desktop/src/dashboard-upload/ui-controller';
import type {ShellRoute} from '../../apps/desktop/src/screens/desktop-ui-view';

// ET-074: the compact shell's grouped sidebar and its top bar with breadcrumbs and the status chips. The badge keeps its
// variant as an attribute; everything else is the real markup. Expected texts are written by hand from en.ts and ru.ts.
vi.mock('@/components/ui/badge', () => ({
  Badge: ({variant, children, ...props}: {variant?: string; children?: React.ReactNode}) => React.createElement('span', {...props, 'data-variant': variant}, children)
}));

const ROUTES: readonly ShellRoute[] = ['live', 'hardMode', 'journal', 'settings', 'account'];
const nav = (route: ShellRoute, language: AppLanguage) => renderToStaticMarkup(React.createElement(SidebarNav, {route, language, onNavigate: () => undefined}));
const chips = {connection: {text: 'ETS2 · Single-player', tone: 'ok'}, plugin: {text: 'Plugin 2/2', tone: 'ok'}, hardMode: {text: 'Hard Mode 10/12', tone: 'warn'}} as const;
const bar = (route: ShellRoute, language: AppLanguage, sync?: React.ReactNode) => renderToStaticMarkup(React.createElement(TopBar, {route, language, ...chips}, sync));

it.each([
  ['en', ['Drive', 'Application', 'Company'], ['Live', 'Hard Mode', 'Journal', 'Settings', 'Account &amp; sync']],
  ['ru', ['Вождение', 'Программа', 'Компания'], ['Сейчас', 'Hard Mode', 'Журнал', 'Настройки', 'Аккаунт и синхронизация']]
] as const)('groups the sidebar into three labelled sections with wrapping labels in %s', (language, groups, labels) => {
  for (const route of ROUTES) {
    const html = nav(route, language);
    expect([...html.matchAll(/<p class="yu-nav-group"[^>]*>([^<]+)<\/p>/g)].map(match => match[1])).toEqual(groups);
    expect([...html.matchAll(/data-testid="(tab-[a-zA-Z]+)"/g)].map(match => match[1])).toEqual(ROUTES.map(id => `tab-${id}`));
    // Each label sits in its own span, the element the stylesheet lets wrap; the icon is decorative.
    expect([...html.matchAll(/<span class="yu-nav-label">([^<]+)<\/span>/g)].map(match => match[1])).toEqual(labels);
    expect(html.match(/<button type="button" class="yu-nav-item"[^>]*>/g)).toHaveLength(5);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*data-testid="tab-${route}"`));
    expect(html.match(/<svg[^>]*aria-hidden="true"/g)).toHaveLength(5);
  }
});

it.each([
  ['en', {live: 'Drive', hardMode: 'Drive', journal: 'Drive', settings: 'Application', account: 'Company'}, {live: 'Live', settings: 'Settings', account: 'Account &amp; sync'}, 'You are here', 'Status'],
  ['ru', {live: 'Вождение', hardMode: 'Вождение', journal: 'Вождение', settings: 'Программа', account: 'Компания'}, {live: 'Сейчас', settings: 'Настройки', account: 'Аккаунт и синхронизация'}, 'Где вы', 'Состояние']
] as const)('shows the group and page as breadcrumbs and the chips in their order in %s', (language, groups, pages, breadcrumb, status) => {
  for (const route of ROUTES) {
    const html = bar(route, language);
    expect(html).toContain(`<nav class="yu-breadcrumb" aria-label="${breadcrumb}" data-testid="shell.breadcrumb"><span>${groups[route]}</span><span class="yu-breadcrumb-separator" aria-hidden="true">/</span><span aria-current="page">`);
    if (route in pages) expect(html).toContain(`<span aria-current="page">${pages[route as keyof typeof pages]}</span>`);
    expect(html).toContain(`role="group" aria-label="${status}"`);
    expect(html).not.toContain('role="status"');
  }
  const html = bar('live', language);
  expect([...html.matchAll(/data-testid="(shell\.status\.[a-zA-Z]+)"/g)].map(match => match[1])).toEqual(['shell.status.connection', 'shell.status.plugin', 'shell.status.hardMode']);
  expect(html).toContain('data-variant="ok"><span class="yu-chip-dot" aria-hidden="true"></span>ETS2 · Single-player</span>');
  expect(html).toMatch(/data-testid="shell.status.hardMode" data-variant="warn"><svg[^>]*lucide-flame[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Hard Mode 10\/12<\/span>/);
});

it('shows the site sync chip last and only when synchronization is configured', () => {
  const unconfigured = bar('live', 'en', React.createElement(SyncChip, {state: unavailableUploadUi(), language: 'en', onOpen: () => undefined}));
  expect(unconfigured).not.toContain('shell.status.sync');
  const configured = unavailableUploadUi(); configured.status = initialDashboardUploadStatus('https://dashboard.example');
  const html = bar('live', 'en', React.createElement(SyncChip, {state: configured, language: 'en', onOpen: () => undefined}));
  expect(html).toMatch(/<button type="button" class="yu-sync-chip"[^>]*data-testid="shell.status.sync"[^>]*aria-label="Account &amp; sync: [^"]+"/);
  expect([...html.matchAll(/data-testid="(shell\.status\.[a-zA-Z]+)"/g)].map(match => match[1]).at(-1)).toBe('shell.status.sync');
});

// ET-110: the sync chip names the connection in one or two words; only sending adds the count. Texts from en.ts and ru.ts.
it.each([
  ['en', [['Connected', 'ok', 'lucide-cloud'], ['Uploading 4 of 6', 'ok', 'lucide-cloud'], ['No network', 'warn', 'lucide-cloud-off'], ['New token needed', 'error', 'lucide-cloud'], ['Needs attention', 'warn', 'lucide-cloud'], ['Uploading', 'ok', 'lucide-cloud']], 'Account &amp; sync: '],
  ['ru', [['Подключено', 'ok', 'lucide-cloud'], ['Отправка 4 из 6', 'ok', 'lucide-cloud'], ['Нет сети', 'warn', 'lucide-cloud-off'], ['Нужен новый токен', 'error', 'lucide-cloud'], ['Нужно внимание', 'warn', 'lucide-cloud'], ['Отправка', 'ok', 'lucide-cloud']], 'Аккаунт и синхронизация: ']
] as const)('words the site sync chip by the upload state in %s', (language, expected, prefix) => {
  const owner = {origin: 'https://dashboard.example', accountId: 'a', companyId: 'c', identityEpoch: 'e'};
  const base = initialDashboardUploadStatus(owner.origin), progress = {...base.progress, enumeration: 'complete' as const, distinctSources: 6, deliveredSources: 6};
  const states = [{progress}, {progress: {...progress, deliveredSources: 4}}, {state: 'paused' as const, error: 'NETWORK' as const, progress}, {state: 'paused' as const, error: 'AUTHENTICATION' as const, progress}, {progress: {...progress, heldSources: 1}}, {progress: {...progress, pendingSources: 2}}];
  states.forEach((change, index) => {
    const state = unavailableUploadUi(); state.status = {...base, state: 'connected', owner, ...change};
    const html = renderToStaticMarkup(React.createElement(SyncChip, {state, language, onOpen: () => undefined}));
    const [text, tone, icon] = expected[index];
    expect(html).toContain(`data-tone="${tone}"`); expect(html).toContain(`aria-label="${prefix}${text}"`);
    expect(html).toMatch(new RegExp(`<svg[^>]*${icon}[ "][^>]*aria-hidden="true"[^>]*>.*?</svg>${text}</button>$`));
  });
});

it.each([['en', 'Not connected', 'Account &amp; sync: '], ['ru', 'Не подключено', 'Аккаунт и синхронизация: ']] as const)('words an ownerless paused upload as not connected on the sync chip in %s (ET-110)', (language, text, prefix) => {
  const state = unavailableUploadUi(); state.status = {...initialDashboardUploadStatus('https://dashboard.example'), state: 'paused', error: 'AUTHENTICATION', owner: null};
  const html = renderToStaticMarkup(React.createElement(SyncChip, {state, language, onOpen: () => undefined}));
  expect(html).toContain('data-tone="neutral"'); expect(html).toContain(`aria-label="${prefix}${text}"`); expect(html).toMatch(new RegExp(`</svg>${text}</button>$`));
});

it('gives a page a place at the end of the top bar, and renders a slot only once the shell has mounted it (ET-076)', () => {
  const html = bar('journal', 'en');
  expect(html).toContain('<div class="yu-topbar-actions"></div>');
  expect(html.indexOf('yu-topbar-actions')).toBeGreaterThan(html.lastIndexOf('shell.status.'));
  const content = React.createElement('span', null, 'Refresh');
  expect(renderToStaticMarkup(React.createElement(ShellSlot, {name: 'actions', children: content}))).toBe('');
  expect(renderToStaticMarkup(React.createElement(ShellSlotsProvider, {actions: null, subline: null, children: React.createElement(ShellSlot, {name: 'subline', children: content})}))).toBe('');
});

// ET-082: the logo picks its variant from the resolved theme by itself.
it('renders the dark logo for the light theme and the white logo otherwise', () => {
  const html = renderToStaticMarkup(React.createElement(ThemedLogo));
  expect(html).toMatch(/^<picture><source media="\(prefers-color-scheme: light\)" srcSet="[^"]*logo-dark[^"]*"\/><img src="[^"]*logo\.png[^"]*" alt=""\/><\/picture>$/);
});
