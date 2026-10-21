import React from 'react';
import type {AppLanguage, SettingsView} from '../../../packages/contracts/src';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Label} from '@/components/ui/label';
import {t} from './i18n';
import type {LanguageController} from './shell/use-language';
import {getSettingsSaveErrorText} from './strings';

export interface LanguageCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
  controller: LanguageController;
}

export function LanguageCard({settings, showSaveError, controller}: LanguageCardProps) {
  const currentLanguage: AppLanguage = settings?.language ?? 'en';
  const {saving, failed: saveFailed, choose: chooseLanguage} = controller;
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
          data-testid="language-radio-group" className="yu-segmented"
          value={currentLanguage}
          disabled={!settings?.writable || saving}
          onValueChange={chooseLanguage}
        >
          <div className="yu-segment-option">
            <RadioGroupItem value="en" id="language-en" />
            <Label htmlFor="language-en">{t('lang.en', undefined, currentLanguage)}</Label>
          </div>
          <div className="yu-segment-option">
            <RadioGroupItem value="ru" id="language-ru" />
            <Label htmlFor="language-ru">{t('lang.ru', undefined, currentLanguage)}</Label>
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
