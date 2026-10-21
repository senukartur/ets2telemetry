import {useState} from 'react';
import type {SettingsView} from '../../../../packages/contracts/src';
/** Shared committed-save authority for the shell menu and General panel; survives navigation. */
export function useLanguageController(settings: SettingsView | undefined, onSaved: (view: SettingsView) => void, onRequest: () => void) {
  const [saving, setSaving] = useState(false), [failed, setFailed] = useState(false);
  const choose = (language: string) => {
    if (language !== 'en' && language !== 'ru' || language === settings?.language || saving) return;
    onRequest(); setSaving(true); setFailed(false);
    void window.desktop.setLanguage(language).then(view => {onSaved(view); setSaving(false);}, () => {setFailed(true); setSaving(false);});
  };
  return {saving, failed, choose};
}
export type LanguageController = ReturnType<typeof useLanguageController>;
