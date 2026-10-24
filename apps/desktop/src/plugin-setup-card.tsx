import React, {useState} from 'react';
import type {AppLanguage, PluginGame, PluginSetupView} from '../../../packages/contracts/src';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {ActionResultRegion} from './action-result';
import type {ConnectionDiagnosis} from './connection-diagnosis';
import {actionResultId, createPluginActionController, PLUGIN_ACTION_ANSWERS as ANSWERS, pluginActionResultText, pluginActionSlot, pluginActionTriggerId, pluginTargetTestId as targetTestId,
  type PluginAction, type PluginActionOutcome, type PluginActionResult, type PluginActionRun} from './plugin-action-result';
import {connectionDiagnosisText, pluginSetupText} from './plugin-setup-text';
import * as BASE_COPY from './strings';
import {copyTable} from './screens/app-copy';

const PLUGIN_GAMES: readonly PluginGame[] = ['ets2', 'ats'];
/** Pending controls stay focusable (aria-disabled) and look disabled; only the disabled setup mode uses native `disabled`. */
const PENDING_CLASS = 'aria-disabled:opacity-50';

/**
 * The Live tab's Game plugin card (ET-017 PR-5, P18): per game, the state of each listed game folder, the "Manage the
 * plugin for this game" switch and "Choose game folder…"; "Show plugin file" and "Open game plugins folder" for a folder
 * that needs a manual copy; one Retry. PR-6 (P17) adds the connection diagnosis line at the top and "Export diagnostics…"
 * at the bottom, which stays available in every mode. It shows only main's pushed view, the diagnosis and the fixed
 * answers of the bridge methods, through plugin-setup-text.ts: never a path. The overlay is untouched.
 *
 * ET-045b: the answer of the last card action appears next to its control, with a severity (plugin-action-result.ts).
 * The card action controller there runs one action at a time, clears the shown result when an action starts and returns
 * focus to the trigger only when it was lost; this component holds its state and the DOM access.
 */
type PluginSetupCardProps = {language?: AppLanguage; view: PluginSetupView | undefined; diagnosis: ConnectionDiagnosis | undefined; onView: (view: PluginSetupView) => void};
export function PluginSetupCard(props: PluginSetupCardProps) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PluginActionResult | null>(null);
  const [controller] = useState(() => createPluginActionController({setPending, setResult,
    activeElement: () => globalThis.document.activeElement, body: () => globalThis.document.body,
    focus: id => globalThis.document.getElementById(id)?.focus()}));
  return <PluginSetupCardView {...props} pending={pending} result={result} run={controller.run} />;
}

/**
 * The card for a given pending state and current result, without state of its own. `run` starts an action through the
 * card action controller.
 */
export function PluginSetupCardView({view, diagnosis, onView, language = 'en', pending, result, run}: PluginSetupCardProps & {pending: boolean; result: PluginActionResult | null; run: PluginActionRun}) {
  const {DIAGNOSTICS_EXPORT_STRINGS, PLUGIN_STRINGS} = copyTable(BASE_COPY, language);
  if (!view) return null;
  const text = pluginSetupText(view, language);
  const connection = diagnosis ? connectionDiagnosisText(diagnosis, language) : undefined;
  const disabled = !text.actionable;
  const call = <T,>(action: PluginAction, start: () => Promise<T>, answer: (value: T) => PluginActionOutcome | null) => {void run(action, start, answer);};
  const withView = (answer: (next: PluginSetupView) => PluginActionOutcome | null) => (next: PluginSetupView) => {onView(next); return answer(next);};
  // The shown result, re-localized on every render; a folder that is no longer listed shows none.
  const folderLabel = (action: PluginAction) => action.kind === 'show-file' || action.kind === 'open-folder'
    ? text.games[action.game].targets.find(target => target.id === action.targetId)?.label ?? null : null;
  const shown = result ? {slot: pluginActionSlot(result.action), trigger: pluginActionTriggerId(result.action), text: pluginActionResultText(result, folderLabel(result.action), language)} : null;
  const region = (slot: string) => <ActionResultRegion slot={slot} result={shown?.slot === slot ? shown.text : null} />;
  /** The id, pending state and description of a trigger. */
  const trigger = (id: string) => ({id, 'data-testid': id, 'aria-disabled': pending || undefined,
    'aria-describedby': shown?.trigger === id && shown.text ? actionResultId(shown.slot) : undefined});
  return <Card size="sm" data-testid="plugin-card"><CardHeader><CardTitle><h2>{PLUGIN_STRINGS.title}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {connection ? <div className="space-y-1"><p><span className="font-medium">{PLUGIN_STRINGS.diagnosisLabel}: </span><span data-testid="plugin-diagnosis">{connection.line}</span></p>
        {connection.notes.map(note => <p key={note} className="text-sm text-muted-foreground" data-testid="plugin-diagnosis-note">{note}</p>)}</div> : null}
      {text.mode ? <Alert role="note"><AlertDescription data-testid="plugin-mode">{text.mode}</AlertDescription></Alert> : null}
      <p data-testid="plugin-bundled">{text.bundled}</p>
      {text.running ? <p role="status" data-testid="plugin-running">{text.running}</p> : null}
      {PLUGIN_GAMES.map(game => {
        const entry = text.games[game];
        return <section key={game} className="space-y-2" data-testid={`plugin-${game}`} aria-labelledby={`plugin-${game}-title`}>
          <h3 id={`plugin-${game}-title`} className="font-medium">{entry.title}</h3>
          <div className="flex items-center gap-2">
            <Switch {...trigger(`plugin-${game}-managed`)} className={PENDING_CLASS} checked={entry.managed} disabled={disabled}
              onCheckedChange={next => call({kind: 'manage', game}, () => window.desktop.setPluginGameExcluded(game, !next), withView(ANSWERS.manage))} />
            <Label htmlFor={`plugin-${game}-managed`}>{PLUGIN_STRINGS.manage}</Label>
          </div>
          {region(`plugin-${game}-managed`)}
          {entry.notes.map(note => <p key={note} className="text-sm text-muted-foreground">{note}</p>)}
          {entry.targets.map(target => <div key={target.id} className="space-y-1" data-testid={targetTestId(target.id)}>
            <p><span>{target.label}</span>: <Badge variant={target.state === 'installed' ? 'secondary' : target.state === 'blocked' ? 'destructive' : 'outline'} data-testid={`${targetTestId(target.id)}-state`}>{target.status}</Badge></p>
            {target.detail.map(line => <p key={line} className="text-sm">{line}</p>)}
            {target.manualCopy || target.openFolder ? <>
              <div className="flex flex-wrap gap-2">
                {target.manualCopy ? <Button size="sm" variant="outline" className={PENDING_CLASS} {...trigger(`${targetTestId(target.id)}-show-file`)}
                  onClick={() => call({kind: 'show-file', game, targetId: target.id}, () => window.desktop.showPluginFile(), ANSWERS.showFile)}>{PLUGIN_STRINGS.showFile}</Button> : null}
                {target.openFolder ? <Button size="sm" variant="outline" className={PENDING_CLASS} {...trigger(`${targetTestId(target.id)}-open-folder`)}
                  onClick={() => call({kind: 'open-folder', game, targetId: target.id}, () => window.desktop.openPluginFolder(target.id), ANSWERS.openFolder)}>{PLUGIN_STRINGS.openFolder}</Button> : null}
              </div>
              {region(targetTestId(target.id))}
            </> : null}
          </div>)}
          <Button size="sm" variant="outline" className={PENDING_CLASS} disabled={disabled} {...trigger(`plugin-${game}-choose`)}
            onClick={() => call({kind: 'choose-folder', game}, () => window.desktop.choosePluginFolder(game), ANSWERS.chooseFolder)}>{PLUGIN_STRINGS.chooseFolder}</Button>
          {region(`plugin-${game}-choose`)}
        </section>;
      })}
      <Button size="sm" className={PENDING_CLASS} disabled={disabled} {...trigger('plugin-retry')} onClick={() => call({kind: 'retry'}, () => window.desktop.retryPluginSetup(), withView(ANSWERS.retry))}>{PLUGIN_STRINGS.retry}</Button>
      {region('plugin-retry')}
      <div className="space-y-1">
        <Button size="sm" variant="outline" className={PENDING_CLASS} {...trigger('plugin-export-diagnostics')}
          onClick={() => call({kind: 'export-diagnostics'}, () => window.desktop.exportDiagnostics(), ANSWERS.exportDiagnostics)}>{DIAGNOSTICS_EXPORT_STRINGS.button}</Button>
        {region('plugin-export-diagnostics')}
        <p className="text-sm text-muted-foreground">{DIAGNOSTICS_EXPORT_STRINGS.note}</p>
      </div>
    </CardContent></Card>;
}
