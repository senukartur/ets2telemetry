import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {AppLanguage} from '../../packages/contracts/src';
import {initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
import {ShellSlot, ShellSlotsProvider} from '../../apps/desktop/src/shell/shell-slots';
import {SidebarNav} from '../../apps/desktop/src/shell/sidebar-nav';
import {TopBar} from '../../apps/desktop/src/shell/top-bar';
import {SyncChip} from '../../apps/desktop/src/dashboard-upload/sync-chip';
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

it('gives a page a place at the end of the top bar, and renders a slot only once the shell has mounted it (ET-076)', () => {
  const html = bar('journal', 'en');
  expect(html).toContain('<div class="yu-topbar-actions"></div>');
  expect(html.indexOf('yu-topbar-actions')).toBeGreaterThan(html.lastIndexOf('shell.status.'));
  const content = React.createElement('span', null, 'Refresh');
  expect(renderToStaticMarkup(React.createElement(ShellSlot, {name: 'actions', children: content}))).toBe('');
  expect(renderToStaticMarkup(React.createElement(ShellSlotsProvider, {actions: null, subline: null, children: React.createElement(ShellSlot, {name: 'subline', children: content})}))).toBe('');
});
