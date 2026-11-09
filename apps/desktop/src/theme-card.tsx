import React, {useState} from 'react';
import type {AppLanguage, SettingsView, ThemePreference} from '../../../packages/contracts/src';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import {t} from './i18n';
import {DEFAULT_THEME, isThemePreference} from './settings-schema';
import {SettingRow} from './shell/settings-layout';
import {getSettingsSaveErrorText} from './strings';

export interface ThemeCardProps {
  settings?: SettingsView;
  onSaved: (view: SettingsView) => void;
  /** Called before each request, so that the dashboard shows main's save error in this card. */
  onRequest?: () => void;
  /** True when this card made the last settings request. */
  showSaveError?: boolean;
}

const THEME_OPTIONS: readonly {value: ThemePreference; labelKey: 'theme.light' | 'theme.dark' | 'theme.system'}[] = [
  {value: 'light', labelKey: 'theme.light'},
  {value: 'dark', labelKey: 'theme.dark'},
  {value: 'system', labelKey: 'theme.system'},
];

/**
 * ET-082: the Light / Dark / System row of Settings > General > Interface (mockup T5). Only the theme main has committed is
 * selected, so a failed save leaves the previous one; the group is disabled while a save is in flight and while the
 * settings cannot be saved.
 */
export function ThemeCard({settings, onSaved, onRequest, showSaveError}: ThemeCardProps) {
  const [request, setRequest] = useState<'idle' | 'saving' | 'failed'>('idle');
  const language: AppLanguage = settings?.language ?? 'en';
  const choose = (value: string) => {
    if (!isThemePreference(value)) return;
    onRequest?.(); setRequest('saving');
    void window.desktop.setTheme(value).then(view => {onSaved(view); setRequest('idle');}, () => setRequest('failed'));
  };
  return <div data-testid="theme-card">
    <SettingRow label={t('s.theme', undefined, language)} labelId="theme-label" hint={t('s.themeD', undefined, language)} hintTestId="theme-hint">
      <RadioGroup aria-labelledby="theme-label" data-testid="theme-select" className="yu-segmented" value={settings?.theme ?? DEFAULT_THEME}
        disabled={!settings?.writable || request === 'saving'} onValueChange={choose}>
        {THEME_OPTIONS.map(option => <div key={option.value} className="yu-segment-option">
          <RadioGroupItem value={option.value} id={`theme-${option.value}`} data-testid={`theme-${option.value}`} /><Label htmlFor={`theme-${option.value}`}>{t(option.labelKey, undefined, language)}</Label>
        </div>)}
      </RadioGroup>
    </SettingRow>
    {/* A refused save is reported by main in the settings view; other request failures only locally. */}
    {showSaveError && settings?.saveError ? <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="theme-save-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
      : request === 'failed' && showSaveError !== false ? <p role="status" className="yu-setting-msg text-sm text-destructive" data-testid="theme-save-error">{t('theme.saveFailed', undefined, language)}</p> : null}
  </div>;
}
