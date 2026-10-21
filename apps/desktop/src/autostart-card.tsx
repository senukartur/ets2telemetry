import React, {useState} from 'react';
import type {AppLanguage, AutostartRegistrationStatus, SettingsView} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Switch} from '@/components/ui/switch';
import {Label} from '@/components/ui/label';
import {Badge} from '@/components/ui/badge';
import {t} from './i18n';
import {getAutostartBadgeVariant, getAutostartStatusBadgeText, getSettingsSaveErrorText} from './strings';

export interface AutostartCardProps {
  settings?: SettingsView;
  status?: AutostartRegistrationStatus;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
}

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
    <Card size="sm" data-testid="autostart-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>
            <h2>{t('s.autostart', undefined, language)}</h2>
          </CardTitle>
          <Badge variant={getAutostartBadgeVariant(status)} data-testid="autostart-status">
            {getAutostartStatusBadgeText(status, language)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('s.autostartD', undefined, language)}</p>
        <div className="flex items-center gap-3">
          <Switch
            id="autostart-toggle"
            data-testid="autostart-toggle"
            checked={settings?.autostart ?? false}
            disabled={locked || notInstalled}
            onCheckedChange={toggle}
          />
          <Label htmlFor="autostart-toggle" className="cursor-pointer">
            {t('s.autostart', undefined, language)}
          </Label>
        </div>
        {notInstalled ? (
          <p className="text-xs text-muted-foreground" data-testid="autostart-not-installed-note">
            {t('s.autostart.notInstalled', undefined, language)}
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
      </CardContent>
    </Card>
  );
}
