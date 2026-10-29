import React, {useState} from 'react';
import type {AppLanguage, AutostartRegistrationStatus, SettingsView} from '../../../packages/contracts/src';
import {Switch} from '@/components/ui/switch';
import {Label} from '@/components/ui/label';
import {Badge} from '@/components/ui/badge';
import {t} from './i18n';
import {InfoHint} from './info-hint';
import {getAutostartBadgeVariant, getAutostartStatusBadgeText, getSettingsSaveErrorText} from './strings';

export interface AutostartCardProps {
  settings?: SettingsView;
  status?: AutostartRegistrationStatus;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
}

/** ET-057: one row of Settings > General > Interface. The switch's label is the setting's name; the badge is its registration. */
export function AutostartCard({settings, status, onSaved, onRequest, showSaveError}: AutostartCardProps) {
  const [request, setRequest] = useState<'idle' | 'saving' | 'failed'>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const locked = !settings?.writable || request === 'saving';
  const notInstalled = status === 'not-installed';
  const label = t('s.autostart', undefined, language);

  const toggle = (enabled: boolean) => {
    onRequest?.();
    setRequest('saving');
    void window.desktop.setAutostart(enabled).then(
      view => {
        onSaved(view);
        setRequest('idle');
      },
      () => setRequest('failed')
    );
  };

  return (
    <div data-testid="autostart-card">
      <div className="yu-setting-row">
        <span><Label htmlFor="autostart-toggle" className="cursor-pointer">{label}</Label>
          <InfoHint label={t('ui.moreAbout', {v: label}, language)}>{t('s.autostartD', undefined, language)}</InfoHint></span>
        <span className="flex items-center gap-3">
          <Badge variant={getAutostartBadgeVariant(status)} data-testid="autostart-status">
            {getAutostartStatusBadgeText(status, language)}
          </Badge>
          <Switch
            id="autostart-toggle"
            data-testid="autostart-toggle"
            checked={settings?.autostart ?? false}
            disabled={locked || notInstalled}
            onCheckedChange={toggle}
          />
        </span>
      </div>
      {notInstalled ? (
        <p className="text-xs text-muted-foreground" data-testid="autostart-not-installed-note">
          {t('s.autostart.notInstalledNote', undefined, language)}
        </p>
      ) : null}
      {showSaveError && settings?.saveError ? (
        <p role="status" className="text-sm text-destructive" data-testid="autostart-save-error">
          {getSettingsSaveErrorText(settings.saveError, language)}
        </p>
      ) : request === 'failed' ? (
        <p role="status" className="text-sm text-destructive" data-testid="autostart-save-error">
          {t('s.autostart.saveFailed', undefined, language)}
        </p>
      ) : null}
    </div>
  );
}
