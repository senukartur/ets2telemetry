import React, {useState} from 'react';
import {Button} from '@/components/ui/button';
import {SettingRow, SettingsSection} from './shell/settings-layout';
import {UNINSTALL_STRINGS as BASE_STRINGS} from './strings';
import type {AppLanguage, AppUninstallResult} from '../../../packages/contracts/src';
import {copyTable} from './screens/app-copy';
import {appUninstallResultText} from './uninstall-text';

/**
 * The uninstall section of Settings > About (ET-018 PR-4, plan U8 and U9; a compact row since ET-078): one button and the
 * data-loss warning, always visible under it. Main asks for confirmation in its own dialog, checks every game folder first
 * and answers with fixed codes and target ids; the card shows the answer through uninstall-text.ts, never a path. A
 * portable or development copy answers that uninstalling is available only in an installed copy.
 */
export function UninstallCard({language = 'en'}: {language?: AppLanguage}) {
  const UNINSTALL_STRINGS = copyTable(BASE_STRINGS, language);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AppUninstallResult | 'refused' | null>(null);
  const answer = result === null ? null : result === 'refused' ? {line: UNINSTALL_STRINGS.requestFailed, folders: []} : appUninstallResultText(result, language);
  const uninstall = () => {
    setPending(true); setResult(null);
    void window.desktop.uninstallApplication().then(result => {setResult(result); setPending(result.outcome === 'started');},
      () => {setResult('refused'); setPending(false);});
  };
  // No section name: the row below is labelled with the same title, which would otherwise be announced twice.
  return <SettingsSection testId="uninstall-card">
    <SettingRow label={UNINSTALL_STRINGS.title} hint={UNINSTALL_STRINGS.warningTitle}>
      <Button size="sm" variant="destructive" disabled={pending} data-testid="uninstall-button" onClick={uninstall}>{pending && !answer ? UNINSTALL_STRINGS.pending : UNINSTALL_STRINGS.button}</Button>
    </SettingRow>
    {/* The warning stays visible under the button, never behind a hint (installer lifecycle reads it). */}
    <div className="yu-uninstall-warning" data-testid="uninstall-warning"><ul>{UNINSTALL_STRINGS.warning.map(line => <li key={line}>{line}</li>)}</ul></div>
    {answer ? <div className="yu-uninstall-result" role="status"><p data-testid="uninstall-result">{answer.line}</p>
      {answer.folders.map(line => <p key={line} data-testid="uninstall-blocked-folder">{line}</p>)}</div> : null}
  </SettingsSection>;
}
