import React, {useState} from 'react';
import type {PluginGame, PluginSetupView} from '../../../packages/contracts/src';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import type {ConnectionDiagnosis} from './connection-diagnosis';
import {connectionDiagnosisText, diagnosticsExportText, pluginFolderChoiceText, pluginSetupText, pluginShowFileText} from './plugin-setup-text';
import {DIAGNOSTICS_EXPORT_STRINGS, PLUGIN_STRINGS} from './strings';

const PLUGIN_GAMES: readonly PluginGame[] = ['ets2', 'ats'];
/** A test id from a target id such as `ets2:steam:0`. */
const targetTestId = (id: string) => `plugin-target-${id.replaceAll(':', '-')}`;

/**
 * The Live tab's Game plugin card (ET-017 PR-5, P18): per game, the state of each listed game folder, the "Manage the
 * plugin for this game" switch and "Choose game folder…"; "Show plugin file" and "Open game plugins folder" for a folder
 * that needs a manual copy; one Retry. PR-6 (P17) adds the connection diagnosis line at the top and "Export diagnostics…"
 * at the bottom, which stays available in every mode. It shows only main's pushed view, the diagnosis and the fixed
 * answers of the bridge methods, through plugin-setup-text.ts: never a path. The overlay is untouched.
 */
export function PluginSetupCard({view, diagnosis, onView}: {view: PluginSetupView | undefined; diagnosis: ConnectionDiagnosis | undefined; onView: (view: PluginSetupView) => void}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!view) return null;
  const text = pluginSetupText(view);
  const connection = diagnosis ? connectionDiagnosisText(diagnosis) : undefined;
  const disabled = pending || !text.actionable;
  const call = <T,>(start: () => Promise<T>, answer: (value: T) => string | null) => {
    setPending(true); setResult(null);
    void start().then(value => {setResult(answer(value)); setPending(false);}, () => {setResult(PLUGIN_STRINGS.requestFailed); setPending(false);});
  };
  const withView = (next: PluginSetupView) => {onView(next); return null;};
  return <Card size="sm" data-testid="plugin-card"><CardHeader><CardTitle><h2>{PLUGIN_STRINGS.title}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {connection ? <div className="space-y-1"><p><span className="font-medium">{PLUGIN_STRINGS.diagnosisLabel}: </span><span data-testid="plugin-diagnosis">{connection.line}</span></p>
        {connection.notes.map(note => <p key={note} className="text-sm text-muted-foreground" data-testid="plugin-diagnosis-note">{note}</p>)}</div> : null}
      {text.mode ? <Alert><AlertDescription data-testid="plugin-mode">{text.mode}</AlertDescription></Alert> : null}
      <p data-testid="plugin-bundled">{text.bundled}</p>
      {text.running ? <p role="status" data-testid="plugin-running">{text.running}</p> : null}
      {PLUGIN_GAMES.map(game => {
        const entry = text.games[game];
        return <section key={game} className="space-y-2" data-testid={`plugin-${game}`} aria-labelledby={`plugin-${game}-title`}>
          <h3 id={`plugin-${game}-title`} className="font-medium">{entry.title}</h3>
          <div className="flex items-center gap-2">
            <Switch id={`plugin-${game}-managed`} data-testid={`plugin-${game}-managed`} checked={entry.managed} disabled={disabled}
              onCheckedChange={next => call(() => window.desktop.setPluginGameExcluded(game, !next), withView)} />
            <Label htmlFor={`plugin-${game}-managed`}>{PLUGIN_STRINGS.manage}</Label>
          </div>
          {entry.notes.map(note => <p key={note} className="text-sm text-muted-foreground">{note}</p>)}
          {entry.targets.map(target => <div key={target.id} className="space-y-1" data-testid={targetTestId(target.id)}>
            <p><span>{target.label}</span>: <Badge variant={target.state === 'installed' ? 'secondary' : target.state === 'blocked' ? 'destructive' : 'outline'} data-testid={`${targetTestId(target.id)}-state`}>{target.status}</Badge></p>
            {target.detail.map(line => <p key={line} className="text-sm">{line}</p>)}
            {target.manualCopy ? <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={pending} data-testid={`${targetTestId(target.id)}-show-file`}
                onClick={() => call(() => window.desktop.showPluginFile(), pluginShowFileText)}>{PLUGIN_STRINGS.showFile}</Button>
              <Button size="sm" variant="outline" disabled={pending} data-testid={`${targetTestId(target.id)}-open-folder`}
                onClick={() => call(() => window.desktop.openPluginFolder(target.id), () => null)}>{PLUGIN_STRINGS.openFolder}</Button>
            </div> : null}
          </div>)}
          <Button size="sm" variant="outline" disabled={disabled} data-testid={`plugin-${game}-choose`}
            onClick={() => call(() => window.desktop.choosePluginFolder(game), pluginFolderChoiceText)}>{PLUGIN_STRINGS.chooseFolder}</Button>
        </section>;
      })}
      <Button size="sm" disabled={disabled} data-testid="plugin-retry" onClick={() => call(() => window.desktop.retryPluginSetup(), withView)}>{PLUGIN_STRINGS.retry}</Button>
      <div className="space-y-1">
        <Button size="sm" variant="outline" disabled={pending} data-testid="plugin-export-diagnostics"
          onClick={() => call(() => window.desktop.exportDiagnostics(), diagnosticsExportText)}>{DIAGNOSTICS_EXPORT_STRINGS.button}</Button>
        <p className="text-sm text-muted-foreground">{DIAGNOSTICS_EXPORT_STRINGS.note}</p>
      </div>
      {result ? <p role="status" data-testid="plugin-result">{result}</p> : null}
    </CardContent></Card>;
}
