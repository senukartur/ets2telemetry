import React, {useState} from 'react';
import type {AppLanguage, AutostartRegistrationStatus, SettingsView} from '../../../packages/contracts/src';
import {Switch} from '@/components/ui/switch';
import {Badge} from '@/components/ui/badge';
import {t} from './i18n';
import {SettingRow} from './shell/settings-layout';
import {getAutostartBadgeVariant, getAutostartStatusBadgeText, getSettingsSaveErrorText} from './strings';

export interface AutostartCardProps {
  settings?: SettingsView;
  status?: AutostartRegistrationStatus;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
}

/**
 * ET-057: one row of Settings > General > Interface. The switch's label is the setting's name; the badge is its registration.
 * ET-078: the explanation and the not-installed note are the row's hint.
 */
export function AutostartCard({settings, status, onSaved, onRequest, showSaveError}: AutostartCardProps) {
  const [request, setRequest] = useState<'idle' | 'saving' | 'failed'>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const locked = !settings?.writable || request === 'saving';
  const notInstalled = status === 'not-installed';

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
      <SettingRow label={t('s.autostart', undefined, language)} labelFor="autostart-toggle" hint={<>
        {t('s.autostartD', undefined, language)}
        {notInstalled ? <span className="block" data-testid="autostart-not-installed-note">{t('s.autostart.notInstalledNote', undefined, language)}</span> : null}
      </>}>
        <span className="yu-setting-controls">
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
      </SettingRow>
      {showSaveError && settings?.saveError ? (
        <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="autostart-save-error">
          {getSettingsSaveErrorText(settings.saveError, language)}
        </p>
      ) : request === 'failed' ? (
        <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="autostart-save-error">
          {t('s.autostart.saveFailed', undefined, language)}
        </p>
      ) : null}
    </div>
  );
}
