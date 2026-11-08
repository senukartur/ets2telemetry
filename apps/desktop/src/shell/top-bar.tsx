import React from 'react';
import {Flame, Plug} from 'lucide-react';
import type {AppLanguage} from '../../../../packages/contracts/src';
import {Badge} from '@/components/ui/badge';
import {t} from '../i18n';
import {routeGroup, type ShellRoute, type StatusChip} from '../screens/desktop-ui-view';

interface TopBarProps {
  route: ShellRoute;
  language: AppLanguage;
  connection: StatusChip;
  plugin: StatusChip;
  hardMode: StatusChip;
  /** The site sync chip (`SyncChip`), which renders nothing while synchronization is not configured. */
  children?: React.ReactNode;
}

/**
 * The compact top bar (ET-074): breadcrumbs on the left, the status chips on the right in the order game, plugin, Hard Mode
 * and site sync. Every chip carries its state in words; the tone repeats it. The group is not a live region, because the
 * game chip changes many times a second while the stream connects.
 */
export function TopBar({route, language, connection, plugin, hardMode, children}: TopBarProps) {
  return <header className="yu-topbar" data-testid="shell.topbar">
    <nav className="yu-breadcrumb" aria-label={t('shell.breadcrumb', undefined, language)} data-testid="shell.breadcrumb">
      <span>{t(`nav.group.${routeGroup(route)}`, undefined, language)}</span>
      <span className="yu-breadcrumb-separator" aria-hidden="true">/</span>
      <span aria-current="page">{t(`nav.${route}`, undefined, language)}</span>
    </nav>
    <div className="yu-status-chips" role="group" aria-label={t('shell.status', undefined, language)} data-testid="shell.status">
      <Badge variant={connection.tone} className="yu-chip" data-testid="shell.status.connection"><span className="yu-chip-dot" aria-hidden="true" />{connection.text}</Badge>
      <Badge variant={plugin.tone} className="yu-chip" data-testid="shell.status.plugin"><Plug aria-hidden="true" />{plugin.text}</Badge>
      <Badge variant={hardMode.tone} className="yu-chip" data-testid="shell.status.hardMode"><Flame aria-hidden="true" />{hardMode.text}</Badge>
      {children}
    </div>
  </header>;
}
