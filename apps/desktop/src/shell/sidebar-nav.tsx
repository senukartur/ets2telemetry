import React from 'react';
import {BookOpen, Cloud, Flame, Gauge, Settings2, type LucideIcon} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {t} from '../i18n';
import {NAV_GROUPS, type ShellRoute} from '../screens/desktop-ui-view';

const ICONS: Record<ShellRoute, LucideIcon> = {live: Gauge, hardMode: Flame, journal: BookOpen, settings: Settings2, account: Cloud};

/**
 * The grouped sidebar navigation (ET-074): Drive, Application and Company. Items are real buttons with `aria-current` on
 * the active one; a label that does not fit wraps to a second line inside its span instead of being cut off.
 */
export function SidebarNav({route, language, onNavigate}: {route: ShellRoute; language: AppLanguage; onNavigate: (route: ShellRoute) => void}) {
  return <nav aria-label={t('app.window', undefined, language)} data-testid="shell.sidebar.nav">{NAV_GROUPS.map(group => <div key={group.id} className="yu-nav-section">
    <p className="yu-nav-group" data-testid={`shell.sidebar.group.${group.id}`}>{t(`nav.group.${group.id}`, undefined, language)}</p>
    {group.routes.map(id => {
      const Icon = ICONS[id];
      return <button key={id} type="button" className="yu-nav-item" aria-current={route === id ? 'page' : undefined} onClick={() => onNavigate(id)} data-testid={`tab-${id}`}>
        <Icon aria-hidden="true" /><span className="yu-nav-label">{t(`nav.${id}`, undefined, language)}</span>
      </button>;
    })}
  </div>)}</nav>;
}
