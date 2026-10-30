import React from 'react';
import type {AppLanguage, SettingsView} from '../../../packages/contracts/src';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {Label} from '@/components/ui/label';
import {t} from './i18n';
import {InfoHint} from './info-hint';
import type {LanguageController} from './shell/use-language';
import {getSettingsSaveErrorText} from './strings';

export interface LanguageCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
  controller: LanguageController;
}

/** ET-057: one row of Settings > General > Interface; the note on game-provided names is behind the Info icon. */
export function LanguageCard({settings, showSaveError, controller}: LanguageCardProps) {
  const currentLanguage: AppLanguage = settings?.language ?? 'en';
  const {saving, failed: saveFailed, choose: chooseLanguage} = controller;
  const label = t('s.lang', undefined, currentLanguage);
  return (
    <div data-testid="language-card">
      <div className="yu-setting-row">
        <span id="language-label">{label}<InfoHint label={t('ui.moreAbout', {v: label}, currentLanguage)}>{t('s.langD', undefined, currentLanguage)}</InfoHint></span>
        <RadioGroup
          aria-labelledby="language-label"
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
      </div>
      {showSaveError && settings?.saveError ? (
        <p role="status" className="text-sm text-destructive" data-testid="language-save-error">
          {getSettingsSaveErrorText(settings.saveError, currentLanguage)}
        </p>
      ) : saveFailed ? (
        <p role="status" className="text-sm text-destructive" data-testid="language-save-error">
          {t('lang.saveFailed', undefined, currentLanguage)}
        </p>
      ) : null}
    </div>
  );
}
