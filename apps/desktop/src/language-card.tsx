import React, {useState} from 'react';
import type {AppLanguage, SettingsView} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Label} from '@/components/ui/label';
import {t} from './i18n';
import {getSettingsSaveErrorText} from './strings';

export interface LanguageCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
}

export function LanguageCard({settings, onSaved, onRequest, showSaveError}: LanguageCardProps) {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const currentLanguage: AppLanguage = settings?.language ?? 'en';

  const chooseLanguage = (lang: string) => {
    if (lang !== 'en' && lang !== 'ru') return;
    if (lang === currentLanguage) return;
    onRequest?.();
    setSaving(true);
    setSaveFailed(false);
    void window.desktop.setLanguage(lang).then(
      view => {
        setSaving(false);
        onSaved(view);
      },
      () => {
        setSaving(false);
        setSaveFailed(true);
      }
    );
  };

  return (
    <Card size="sm" data-testid="language-card">
      <CardHeader>
        <CardTitle>
          <h2>{t('s.lang', undefined, currentLanguage)}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('s.langD', undefined, currentLanguage)}</p>
        <RadioGroup
          aria-label={t('s.lang', undefined, currentLanguage)}
          data-testid="language-radio-group"
          value={currentLanguage}
          disabled={!settings?.writable || saving}
          onValueChange={chooseLanguage}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="en" id="language-en" />
            <Label htmlFor="language-en">English</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="ru" id="language-ru" />
            <Label htmlFor="language-ru">Русский</Label>
          </div>
        </RadioGroup>
        {showSaveError && settings?.saveError ? (
          <p role="status" className="text-sm text-destructive" data-testid="language-save-error">
            {getSettingsSaveErrorText(settings.saveError, currentLanguage)}
          </p>
        ) : saveFailed ? (
          <p role="status" className="text-sm text-destructive" data-testid="language-save-error">
            {t('lang.saveFailed', undefined, currentLanguage)}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
