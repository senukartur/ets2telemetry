import React, {useState} from 'react';
import {Circle, CircleCheck, CircleX, Clock, type LucideIcon} from 'lucide-react';
import type {AppLanguage, PluginGame, PluginSetupView, PluginTargetState} from '../../../packages/contracts/src';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {ActionResultRegion} from './action-result';
import type {ConnectionDiagnosis} from './connection-diagnosis';
import {actionResultId, createPluginActionController, PLUGIN_ACTION_ANSWERS as ANSWERS, pluginActionResultText, pluginActionSlot, pluginActionTriggerId, pluginTargetTestId as targetTestId,
  type PluginAction, type PluginActionOutcome, type PluginActionResult, type PluginActionRun} from './plugin-action-result';
import {connectionDiagnosisText, pluginSetupText} from './plugin-setup-text';
import * as BASE_COPY from './strings';
import {copyTable} from './screens/app-copy';
import {pluginTargetTone} from './screens/desktop-ui-view';
import {SettingRow, SettingsSection} from './shell/settings-layout';
import {InfoHint} from './info-hint';
import {t} from './i18n';

const PLUGIN_GAMES: readonly PluginGame[] = ['ets2', 'ats'];
/** Pending controls stay focusable (aria-disabled) and look disabled; only the disabled setup mode uses native `disabled`. */
const PENDING_CLASS = 'aria-disabled:opacity-50';
/** The icon beside a folder's status word; the word carries the state, the icon only repeats it. */
const TARGET_ICON: Readonly<Record<PluginTargetState, LucideIcon>> = Object.freeze({installed: CircleCheck, outdated: Clock, blocked: CircleX,
  missing: Circle, excluded: Circle, working: Circle});

/** The one card action controller's state: the pending flag, the current result and its `run`. */
export interface PluginActions {pending: boolean; result: PluginActionResult | null; run: PluginActionRun}

/**
 * ET-045b: the card action controller (plugin-action-result.ts) with its state and DOM access. It runs one action at a
 * time, clears the shown result when an action starts and returns focus to the trigger only when it was lost. ET-078: the
 * dashboard holds one for the Game plugin card and "Export diagnostics…" on Settings > Diagnostics together, so both still
 * share one pending action and one current result.
 */
export function usePluginActions(): PluginActions {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PluginActionResult | null>(null);
  const [controller] = useState(() => createPluginActionController({setPending, setResult,
    activeElement: () => globalThis.document.activeElement, body: () => globalThis.document.body,
    focus: id => globalThis.document.getElementById(id)?.focus()}));
  return {pending, result, run: controller.run};
}

/** The id, pending state and description of a trigger whose result is `shown`. */
const triggerProps = (id: string, pending: boolean, shown: {slot: string; trigger: string; text: unknown} | null) => ({id, 'data-testid': id, 'aria-disabled': pending || undefined,
  'aria-describedby': shown?.trigger === id && shown.text ? actionResultId(shown.slot) : undefined});

/**
 * Settings > Game plugin (ET-017 PR-5, P18; compact rows since ET-078): per game, the state of each listed game folder, the
 * "Manage the plugin for this game" switch and "Choose game folder…"; "Show plugin file" and "Open game plugins folder"
 * for a folder that needs a manual copy; one Retry. PR-6 (P17) adds the connection diagnosis line at the top. It shows only
 * main's pushed view, the diagnosis and the fixed answers of the bridge methods, through plugin-setup-text.ts: never a
 * path. The overlay is untouched.
 *
 * ET-045b: the answer of the last card action appears next to its control, with a severity (plugin-action-result.ts).
 * The card has no state of its own; `run` starts an action through the shared card action controller (usePluginActions).
 */
type PluginSetupCardProps = {language?: AppLanguage; view: PluginSetupView | undefined; diagnosis: ConnectionDiagnosis | undefined; onView: (view: PluginSetupView) => void};
export function PluginSetupCardView({view, diagnosis, onView, language = 'en', pending, result, run}: PluginSetupCardProps & PluginActions) {
  const {PLUGIN_STRINGS} = copyTable(BASE_COPY, language);
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
  const trigger = (id: string) => triggerProps(id, pending, shown);
  return <SettingsSection label={PLUGIN_STRINGS.title} testId="plugin-card">
    <div className="yu-plugin-top">
      {connection ? <p className="flex flex-wrap items-center"><span className="font-medium">{PLUGIN_STRINGS.diagnosisLabel}:&nbsp;</span><span data-testid="plugin-diagnosis">{connection.line}</span>
        <InfoHint label={t('ui.moreAbout', {v: PLUGIN_STRINGS.diagnosisLabel}, language)}>
          {connection.notes.map(note => <span key={note} className="block" data-testid="plugin-diagnosis-note">{note}</span>)}
          <span className="block text-xs text-muted-foreground" data-testid="plugin-bundled">{text.bundled}</span>
        </InfoHint></p> : <p className="yu-muted" data-testid="plugin-bundled">{text.bundled}</p>}
      {text.mode ? <Alert role="note"><AlertDescription data-testid="plugin-mode">{text.mode}</AlertDescription></Alert> : null}
      {text.running ? <p role="status" data-testid="plugin-running">{text.running}</p> : null}
    </div>
    {PLUGIN_GAMES.map(game => {
      const entry = text.games[game];
      return <section key={game} className="yu-plugin-game" data-testid={`plugin-${game}`} aria-labelledby={`plugin-${game}-title`}>
        <div className="yu-plugin-game-head">
          <Badge variant={game}>{game.toUpperCase()}</Badge>
          <h4 id={`plugin-${game}-title`}>{entry.title}</h4>
          <div className="yu-plugin-manage">
            <Switch {...trigger(`plugin-${game}-managed`)} className={PENDING_CLASS} checked={entry.managed} disabled={disabled}
              onCheckedChange={next => call({kind: 'manage', game}, () => window.desktop.setPluginGameExcluded(game, !next), withView(ANSWERS.manage))} />
            <Label htmlFor={`plugin-${game}-managed`}>{PLUGIN_STRINGS.manage}</Label>
          </div>
          {region(`plugin-${game}-managed`)}
        </div>
        {entry.notes.map(note => <p key={note} className="yu-plugin-note">{note}</p>)}
        {entry.targets.map(target => {
          const Icon = TARGET_ICON[target.state];
          return <div key={target.id} className="yu-plugin-target" data-testid={targetTestId(target.id)}>
            <p className="yu-plugin-target-head"><span className="yu-plugin-folder">{target.label}</span>
              <Badge variant={pluginTargetTone(target.state)} data-testid={`${targetTestId(target.id)}-state`}><Icon aria-hidden="true" />{target.status}</Badge></p>
            {target.detail.map(line => <p key={line}>{line}</p>)}
            {target.manualCopy || target.openFolder ? <>
              <div className="yu-plugin-actions">
                {target.manualCopy ? <Button size="sm" variant="outline" className={PENDING_CLASS} {...trigger(`${targetTestId(target.id)}-show-file`)}
                  onClick={() => call({kind: 'show-file', game, targetId: target.id}, () => window.desktop.showPluginFile(), ANSWERS.showFile)}>{PLUGIN_STRINGS.showFile}</Button> : null}
                {target.openFolder ? <Button size="sm" variant="ghost" className={PENDING_CLASS} {...trigger(`${targetTestId(target.id)}-open-folder`)}
                  onClick={() => call({kind: 'open-folder', game, targetId: target.id}, () => window.desktop.openPluginFolder(target.id), ANSWERS.openFolder)}>{PLUGIN_STRINGS.openFolder}</Button> : null}
              </div>
              {region(targetTestId(target.id))}
            </> : null}
          </div>;
        })}
        <Button size="sm" variant="ghost" className={PENDING_CLASS} disabled={disabled} {...trigger(`plugin-${game}-choose`)}
          onClick={() => call({kind: 'choose-folder', game}, () => window.desktop.choosePluginFolder(game), ANSWERS.chooseFolder)}>{PLUGIN_STRINGS.chooseFolder}</Button>
        {region(`plugin-${game}-choose`)}
      </section>;
    })}
    <div className="yu-plugin-footer">
      <Button size="sm" className={PENDING_CLASS} disabled={disabled} {...trigger('plugin-retry')} onClick={() => call({kind: 'retry'}, () => window.desktop.retryPluginSetup(), withView(ANSWERS.retry))}>{PLUGIN_STRINGS.retry}</Button>
      {region('plugin-retry')}
    </div>
  </SettingsSection>;
}

/**
 * Settings > Diagnostics: "Export diagnostics…" (ET-017 PR-6, P17), available in every plugin setup mode. ET-078 moved it
 * from the Game plugin card; it keeps its ids and runs through the same card action controller, and its result region
 * follows the button directly.
 */
export function DiagnosticsExportRow({language = 'en', pending, result, run}: {language?: AppLanguage} & PluginActions) {
  const {DIAGNOSTICS_EXPORT_STRINGS} = copyTable(BASE_COPY, language);
  const shown = result?.action.kind === 'export-diagnostics'
    ? {slot: pluginActionSlot(result.action), trigger: pluginActionTriggerId(result.action), text: pluginActionResultText(result, null, language)} : null;
  const slot = 'plugin-export-diagnostics';
  return <SettingRow label={t('s.data.bundle', undefined, language)} hint={DIAGNOSTICS_EXPORT_STRINGS.note}>
    <Button size="sm" variant="outline" className={PENDING_CLASS} {...triggerProps(slot, pending, shown)}
      onClick={() => {void run({kind: 'export-diagnostics'}, () => window.desktop.exportDiagnostics(), ANSWERS.exportDiagnostics);}}>{DIAGNOSTICS_EXPORT_STRINGS.button}</Button>
    <ActionResultRegion slot={slot} result={shown?.slot === slot ? shown.text : null} />
  </SettingRow>;
}
