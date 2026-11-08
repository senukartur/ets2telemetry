import React from 'react';
import type {AppLanguage, SettingsView} from '../../../packages/contracts/src';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {t} from './i18n';
import type {LanguageController} from './shell/use-language';
import {SettingRow} from './shell/settings-layout';
import {getSettingsSaveErrorText} from './strings';

export interface LanguageCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  onRequest?: () => void;
  showSaveError?: boolean;
  controller: LanguageController;
}

const LANGUAGE_OPTIONS: readonly {value: AppLanguage; labelKey: 'lang.en' | 'lang.ru'}[] = [
  {value: 'en', labelKey: 'lang.en'},
  {value: 'ru', labelKey: 'lang.ru'},
];

/** ET-073: one row of Settings > General > Interface; dropdown Select replaces radio group. ET-078: the note on game-provided names is the row's hint. */
export function LanguageCard({settings, showSaveError, controller}: LanguageCardProps) {
  const currentLanguage: AppLanguage = settings?.language ?? 'en';
  const {saving, failed: saveFailed, choose: chooseLanguage} = controller;
  return (
    <div data-testid="language-card">
      <SettingRow label={t('s.lang', undefined, currentLanguage)} labelId="language-label" hint={t('s.langD', undefined, currentLanguage)}>
        <Select
          disabled={!settings?.writable || saving}
          value={currentLanguage}
          onValueChange={chooseLanguage}
        >
          <SelectTrigger
            aria-labelledby="language-label"
            data-testid="language-select"
            data-value={currentLanguage}
            className="w-[180px]"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGE_OPTIONS.map(opt => (
              <SelectItem
                key={opt.value}
                value={opt.value}
                data-testid={`language-option-${opt.value}`}
              >
                {t(opt.labelKey, undefined, currentLanguage)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      {showSaveError && settings?.saveError ? (
        <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="language-save-error">
          {getSettingsSaveErrorText(settings.saveError, currentLanguage)}
        </p>
      ) : saveFailed ? (
        <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="language-save-error">
          {t('lang.saveFailed', undefined, currentLanguage)}
        </p>
      ) : null}
    </div>
  );
}
