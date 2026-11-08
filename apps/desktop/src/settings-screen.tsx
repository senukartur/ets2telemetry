import React, {useState} from 'react';
import type {AppLanguage, AppState, LiveTelemetry, PluginSetupView, SettingsView, SourceSelection, UnitGame} from '../../../packages/contracts/src';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Label} from '@/components/ui/label';
import {RadioGroup, RadioGroupItem} from '@/components/ui/radio-group';
import logo from './assets/logo.png';
import huninnFontLicense from './assets/huninn-OFL.txt?raw';
import huninnFontLicenseUrl from './assets/huninn-OFL.txt?url';
import {AutostartCard} from './autostart-card';
import {CHANNEL} from './channel';
import {connectionDiagnosis} from './connection-diagnosis';
import {GearDisplayCard} from './gear-display-card';
import {t} from './i18n';
import {LanguageCard} from './language-card';
import {NowPlayingSettingsCard} from './now-playing/settings-card';
import {OverlaySettingsCard} from './overlay-settings-card';
import {DiagnosticsExportRow, PluginSetupCardView, type PluginActions} from './plugin-setup-card';
import {recordingStatusText} from './recording-status-text';
import {connectionTone, serviceTone, storageTone} from './screens/desktop-ui-view';
import {SettingRow, SettingsPanelHeader, SettingsSection} from './shell/settings-layout';
import type {LanguageController} from './shell/use-language';
import {
  getAppErrorText, getServiceHealthText, getSettingsSaveErrorText, getSettingsStateText, getStorageHealthText, getStrings, getUnitGameText, getUnitProfileText
} from './strings';
import {UninstallCard} from './uninstall-card';
import {AboutUpdateCheck, VersionLine} from './update-control';
import {DEFAULT_UNIT_PROFILES, isUnitProfile, UNIT_GAMES, UNIT_PROFILE_IDS} from './unit-profiles';

/** The Settings panels in the order of the sub-navigation (ET-078, mockup T5). */
export const SETTINGS_PANELS = ['general', 'overlay', 'plugin', 'data', 'about'] as const;
export type SettingsPanel = typeof SETTINGS_PANELS[number];
/** The card whose request made main's last settings save; main's one `saveError` is shown only there. */
export type SettingsCard = 'units' | 'gear' | 'overlay' | 'language' | 'autostart';

export interface SettingsScreenProps {
  hidden: boolean;
  language: AppLanguage;
  panel: SettingsPanel;
  onPanel: (panel: SettingsPanel) => void;
  app: AppState | undefined;
  live: LiveTelemetry | undefined;
  /** The startup line (dashboard-startup.ts) that smokes wait on. */
  startup: string;
  onSaved: (view: SettingsView) => void;
  lastCard: SettingsCard;
  onRequest: (card: SettingsCard) => void;
  languageController: LanguageController;
  /** The one card action controller of the Game plugin card and the diagnostics export (usePluginActions). */
  pluginActions: PluginActions;
  onPlugins: (plugins: PluginSetupView) => void;
  /** A refused source selection; the dashboard shows it on the startup line. */
  onSourceFailed: () => void;
}

/**
 * Settings (ET-078, mockup T5): a sub-navigation of native buttons, so Tab, Enter and Space work, and five panels that stay
 * mounted and switch through `hidden`, so a save or an action in flight and its result survive a panel switch. The
 * selected panel is the dashboard's state and survives route changes within a session. Every control, lock and message is
 * the one the panels had before; only the layout is compact.
 */
export function SettingsScreen(props: SettingsScreenProps) {
  const {hidden, language, panel, onPanel} = props;
  return <div hidden={hidden} className="yu-settings" data-testid="settings.screen">
    <nav className="yu-settings-nav" aria-label={t('s.nav', undefined, language)} data-testid="settings.nav">{SETTINGS_PANELS.map(id =>
      <button key={id} type="button" aria-current={panel === id ? 'page' : undefined} data-testid={`settings.nav.${id}`} onClick={() => onPanel(id)}>{t(`s.${id}`, undefined, language)}</button>)}</nav>
    <div className="yu-settings-panels">
      <div hidden={panel !== 'general'} className="yu-settings-panel" data-testid="settings.general"><GeneralPanel {...props} /></div>
      {/* ET-079 restyles the overlay card; until then the panel hosts it unchanged, without a panel header. */}
      <div hidden={panel !== 'overlay'} className="yu-settings-panel" data-testid="settings.overlay">
        <OverlaySettingsCard settings={props.app?.settings} edit={props.app?.overlayEdit} onSaved={props.onSaved} onRequest={() => props.onRequest('overlay')} showSaveError={props.lastCard === 'overlay'} />
      </div>
      <div hidden={panel !== 'plugin'} className="yu-settings-panel" data-testid="settings.plugin"><PluginPanel {...props} /></div>
      <div hidden={panel !== 'data'} className="yu-settings-panel" data-testid="settings.data"><DiagnosticsPanel {...props} /></div>
      <div hidden={panel !== 'about'} className="yu-settings-panel" data-testid="settings.about"><AboutPanel {...props} /></div>
    </div>
  </div>;
}

function GeneralPanel({language, app, onSaved, lastCard, onRequest, languageController}: SettingsScreenProps) {
  const [units, setUnits] = useState<'idle' | 'saving' | 'failed'>('idle');
  const settings = app?.settings, strings = getStrings(language);
  const choose = (game: UnitGame, value: string) => {
    if (!isUnitProfile(value)) return;
    onRequest('units'); setUnits('saving');
    void window.desktop.setUnitProfile(game, value).then(view => {
      onSaved(view); setUnits('idle');
    }, () => setUnits('failed'));
  };
  const showSettingsState = settings && settings.state !== 'loaded' && settings.state !== 'defaults';
  return <>
    <SettingsPanelHeader title={t('s.general', undefined, language)} sub={t('s.general.sub', undefined, language)} />
    {/* ET-057: how the saved settings were read is shown only when it matters (defaults kept, read-only or invalid file). */}
    {showSettingsState ? <Alert><AlertDescription data-testid="settings-state">{getSettingsStateText(settings.state, language)}</AlertDescription></Alert> : null}
    <SettingsSection label={t('s.interface', undefined, language)}>
      <LanguageCard settings={settings} onSaved={onSaved} controller={languageController} showSaveError={lastCard === 'language'} />
      <AutostartCard settings={settings} status={app?.autostart} onSaved={onSaved} onRequest={() => onRequest('autostart')} showSaveError={lastCard === 'autostart'} />
      <SettingRow label={t('s.close', undefined, language)} hint={strings.closeToTray} hintTestId="close-to-tray">
        <span className="yu-setting-value">{t('s.closeV', undefined, language)}</span>
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={strings.unitsTitle} note={t('s.units.note', undefined, language)} testId="settings.units">
      {UNIT_GAMES.map(game => <SettingRow key={game} label={getUnitGameText(game, language)} labelId={`units-${game}-label`}>
        {/* A choice shows as selected only after main saved it; a failed save leaves the previous one. */}
        <RadioGroup aria-labelledby={`units-${game}-label`} data-testid={`units-${game}`} className="yu-segmented" value={settings?.units[game] ?? DEFAULT_UNIT_PROFILES[game]}
          disabled={!settings?.writable || units === 'saving'} onValueChange={value => choose(game, value)}>
          {UNIT_PROFILE_IDS.map(option => <div key={option} className="yu-segment-option">
            <RadioGroupItem value={option} id={`units-${game}-${option}`} /><Label htmlFor={`units-${game}-${option}`}>{getUnitProfileText(option, language)}</Label>
          </div>)}
        </RadioGroup>
      </SettingRow>)}
      {/* A refused save is reported by main in the settings view; other request failures only locally. */}
      {settings?.saveError && lastCard === 'units' ? <p role="status" className="yu-setting-msg" data-testid="settings-error">{getSettingsSaveErrorText(settings.saveError, language)}</p>
        : units === 'failed' ? <p role="status" className="yu-setting-msg" data-testid="settings-error">{strings.unitsSaveFailed}</p> : null}
    </SettingsSection>
    <GearDisplayCard settings={settings} onSaved={onSaved} onRequest={() => onRequest('gear')} showSaveError={lastCard === 'gear'} />
    <NowPlayingSettingsCard settings={settings} view={app?.nowPlaying} onSaved={onSaved} />
  </>;
}

function PluginPanel({language, app, live, pluginActions, onPlugins}: SettingsScreenProps) {
  const diagnosis = app ? connectionDiagnosis(app.plugins, live?.status ?? 'waiting', live?.selection ?? 'game', app.health) : undefined;
  return <>
    <SettingsPanelHeader title={t('s.plugin', undefined, language)} sub={t('s.plugin.sub', undefined, language)} />
    <PluginSetupCardView language={language} view={app?.plugins} diagnosis={diagnosis} onView={onPlugins} {...pluginActions} />
  </>;
}

function DiagnosticsPanel({language, app, live, startup, pluginActions, onSourceFailed}: SettingsScreenProps) {
  const strings = getStrings(language), health = app?.health, status = live?.status ?? 'waiting';
  const problem = health && (health.service === 'failed' || health.service === 'restarting') && health.lastError;
  // ET-015c PR-4 (G8): the recording status text; until main's first push the status is not known.
  const recording = recordingStatusText(health?.recording ?? {state: 'unknown'}, language);
  const recordingAlertVariant = health?.recording.state === 'retrying' ? 'default' : 'destructive';
  return <>
    <SettingsPanelHeader title={t('s.data', undefined, language)} sub={t('s.data.sub', undefined, language)} />
    <SettingsSection label={strings.sourceLabel}>
      <SettingRow label={strings.sourceLabel} labelFor="settings-source-select" hint={t('s.data.sourceD', undefined, language)}>
        <select id="settings-source-select" data-testid="source-select" value={live?.selection ?? 'game'} onChange={event => {void window.desktop.selectSource(event.target.value as SourceSelection).catch(onSourceFailed);}}>
          <option value="game">{strings.sourceSelectPrompt}</option><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option>
          <option value="synthetic">{strings.sourceSyntheticFixture}</option><option value="replay">{strings.sourceReplayFixture}</option>
        </select>
      </SettingRow>
      <SettingRow label={t('s.data.state', undefined, language)} hint={<>
        <p data-testid="startup-status">{startup}</p>
        <p className="yu-telemetry-status" data-testid="telemetry-status">{status}: {live?.reason ?? strings.startupWaiting}</p>
        <p>{t('ui.origin', undefined, language)}: {live?.observation?.source.origin ?? (live?.selection === 'synthetic' || live?.selection === 'replay' ? live.selection : 'game')}; {t(live?.fresh ? 'ui.current' : 'ui.notCurrent', undefined, language)}; {t('ui.coverageUnknown', undefined, language)}.</p>
      </>}>
        <Badge variant={connectionTone(live?.status)} data-testid="settings.data.status">{t(`ui.status.${status}`, undefined, language)}</Badge>
      </SettingRow>
    </SettingsSection>
    <SettingsSection title={strings.healthTitle}>
      <div className="yu-health-body">
        {problem ? <Alert variant="destructive" data-testid="health-alert"><AlertTitle>{strings.serviceFailedTitle}</AlertTitle><AlertDescription>{getAppErrorText(problem, language)}</AlertDescription></Alert> : null}
        <dl className="yu-health" data-testid="app-health">
          <dt>{strings.serviceLabel}</dt><dd data-testid="health-service">{health ? <Badge variant={serviceTone(health.service)}>{getServiceHealthText(health.service, language)}</Badge> : '—'}</dd>
          <dt>{strings.storageLabel}</dt><dd data-testid="health-storage">{health ? <Badge variant={storageTone(health.storage)}>{getStorageHealthText(health.storage, language)}</Badge> : '—'}</dd>
          <dt>{strings.recordingLabel}</dt><dd data-testid="health-recording">{health ? recording.headline : '—'}</dd>
          {health && recording.detail.length ? <dd className="yu-health-more" data-testid="health-recording-detail">{recording.detail.map(line => <p key={line}>{line}</p>)}</dd> : null}
          {health && recording.losses.length ? <dd className="yu-health-more" data-testid="health-recording-losses">{recording.losses.map(line => <p key={line}>{line}</p>)}</dd> : null}
          {health?.lastError && !problem ? <><dt>{strings.lastErrorLabel}</dt><dd>{getAppErrorText(health.lastError, language)}</dd></> : null}
        </dl>
        {health && recording.alert ? <Alert variant={recordingAlertVariant}><AlertTitle>{strings.recordingProblemTitle}</AlertTitle>
          <AlertDescription data-testid="health-recording-alert">{recording.alert}</AlertDescription></Alert> : null}
        <p data-testid="prototype-notice" className="yu-muted">{recording.notice}</p>
      </div>
    </SettingsSection>
    {/* Like the Game plugin card that held the export before ET-078, the bundle section waits for main's first push. */}
    {app ? <SettingsSection label={t('s.data.bundle', undefined, language)} testId="settings.data.bundle">
      <DiagnosticsExportRow language={language} {...pluginActions} />
    </SettingsSection> : null}
  </>;
}

function AboutPanel({language, app}: SettingsScreenProps) {
  return <>
    <SettingsPanelHeader title={t('s.about', undefined, language)} />
    {/* No name of its own: the panel's heading already says "About" and the brand block names the application. */}
    <SettingsSection>
      <div className="yu-about-brand" data-testid="settings.about.brand"><img src={logo} alt="" width={56} height={56} />
        <div><h3>{CHANNEL.displayName}</h3><p>{t('app.sub', undefined, language)}</p><VersionLine info={app?.application} language={language} testId="settings.about.version" /></div></div>
      <SettingRow label={t('s.about.updates', undefined, language)} className="yu-about-update"><AboutUpdateCheck view={app?.update} language={language} /></SettingRow>
      <details className="yu-font-license" data-testid="settings.about.font-license">
        <summary><span className="yu-setting-text"><span className="yu-setting-label">{t('s.about.font', undefined, language)}</span><span className="yu-setting-hint">Huninn · SIL Open Font License 1.1</span></span>
          <span className="yu-font-license-toggle">{t('s.about.license', undefined, language)}</span></summary>
        <pre data-license-asset={huninnFontLicenseUrl}>{huninnFontLicense}</pre>
      </details>
    </SettingsSection>
    <UninstallCard language={language} />
  </>;
}
