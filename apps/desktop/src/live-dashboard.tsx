import React, {useMemo, useState} from 'react';
import {ChevronRight, Clock, Coffee, Coins, Droplet, Flag, Hourglass, MapPin, Navigation, Package, TriangleAlert, WifiOff} from 'lucide-react';
import type {AppLanguage, GearDisplayModes, LiveTelemetry, RecordingHealth, UnitProfiles} from '../../../packages/contracts/src';
import type {LiveFieldId} from '../../../packages/telemetry-core/src/live-view';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Badge} from '@/components/ui/badge';
import {gameConnectionText, liveDashboardText, liveFieldValue, type LiveRowText} from './live-dashboard-text';
import {desktopLiveView, gaugeArc, liveGameMode, liveScreenState, liveSourcesPartial} from './screens/desktop-ui-view';
import {dashboardFuel, dashboardSpeed} from './speed-display';
import {displayProfile} from './unit-profiles';
import {getStrings} from './strings';
import {t, translateUnit} from './i18n';
import {InfoHint} from './info-hint';

/**
 * The next mandatory break's urgency (ET-052 D3): an icon, a word and a tone together, never colour alone. The accessible
 * name is the row label with the word; the icon is decorative.
 */
function BreakBadge({badge, testId}: {badge: NonNullable<LiveRowText['badge']>; testId: string}) {
  const Icon = badge.urgency === 'due' ? TriangleAlert : Hourglass;
  return <Badge variant={badge.urgency === 'due' ? 'error' : 'warn'} role="img" aria-label={badge.name} data-testid={testId} data-urgency={badge.urgency}><Icon aria-hidden="true" />{badge.text}</Badge>;
}

const COMPLETENESS_TONE = {complete: 'ok', partial: 'warn', unknown: 'neutral'} as const;

/**
 * The Live page (ET-074 compact layout): the instrument, the current job, This trip, Truck and Game session, and the
 * collapsed list of every field. `data-live-state` is connected, paused, partial, stale or waiting; stale values are
 * dimmed dashes, partial shows the current stream's values with the banner, and waiting shows dashes and the banner.
 * Values come only from the live view and the recording health.
 */
export function LiveDashboard({live, units, gearDisplay, recording, language = 'en', onSelect}: {onSelect?: (game: 'ets2' | 'ats') => Promise<void>; live: LiveTelemetry | undefined;
  units: UnitProfiles | undefined; gearDisplay?: GearDisplayModes; recording?: RecordingHealth; language?: AppLanguage}) {
  const [choosing, setChoosing] = useState(false), [choiceFailed, setChoiceFailed] = useState(false);
  const text = useMemo(() => liveDashboardText(live, units, language, gearDisplay), [live, units, language, gearDisplay]);
  const view = useMemo(() => desktopLiveView(live, units, gearDisplay), [live, units, gearDisplay]);
  const strings = getStrings(language), profile = displayProfile(live, units), sources = view.sources;
  const state = liveScreenState(live?.status, view.current, text.paused, liveSourcesPartial(live));
  const value = (id: LiveFieldId) => {const f = sources.field(id); return f.state === 'value' || f.state === 'absent' ? liveFieldValue(f, language) : '—';};
  const has = (id: LiveFieldId) => sources.field(id).state === 'value';
  const shown = (id: LiveFieldId) => sources.field(id).state !== 'hidden';
  const speedText = dashboardSpeed(live, profile, language), fuelText = dashboardFuel(live, profile, language);
  const hint = (label: string, text: string) => <InfoHint label={t('ui.moreAbout', {v: label}, language)}>{text}</InfoHint>;
  const rows = (entries: [string, string, string?][]) => <dl>{entries.map(([label, shownValue, testId]) => <div className="yu-kv" key={label}><dt>{label}</dt><dd data-testid={testId}>{shownValue}</dd></div>)}</dl>;
  const title = (key: 'live.job' | 'live.trip' | 'live.truck' | 'live.session') => <CardTitle><h2>{t(key, undefined, language)}</h2></CardTitle>;

  // The waiting banner: no current game, one current stream of two (partial, in either direction), or an incompatible v1
  // source beside current v0 data, where the banner names the version mismatch. A stream that went stale with no current
  // source shows its badge and dimmed dashes instead.
  const waiting = state === 'waiting' || state === 'partial' || state !== 'stale' && live?.v1?.status === 'incompatible';
  const status = live?.status ?? 'waiting';
  const connectionText = gameConnectionText(live, language);
  const consNote = t(sources.v0View.connection.game === 'ats' ? 'live.consNoteAts' : 'live.consNote', undefined, language);

  // Job: the body exists while v0 reports a job (current or stale); otherwise why there is none.
  const jobSection = sources.v0View.sections.find(section => section.id === 'job');
  const hasJob = sources.v0State?.job.state === 'value';
  const jobMissing = jobSection?.missing && jobSection.missing !== 'not-observed' ? text.sections.find(section => section.id === 'job')?.missing : undefined;
  const breakRow = text.sections.flatMap(section => section.rows).find(row => row.id === 'mandatory-break');
  const cargo = has('cargo') ? has('cargo-mass') ? `${value('cargo')} · ${value('cargo-mass')}` : value('cargo') : null;

  const trip = recording && 'trip' in recording ? recording.trip : null;
  const completeness = trip?.completeness ?? null;
  const mode = liveGameMode(sources);
  const protocol = live?.observation ? sources.v1Carried ? 'v0 + v1' : 'v0' : sources.v1Carried ? 'v1' : '—';

  return <div className="yu-live" data-testid="live-telemetry" data-live-state={state}>
    {waiting ? <div className="yu-connection" data-testid="live.waiting"><span className="yu-connection-icon" aria-hidden="true">{status === 'waiting' ? <Clock /> : <WifiOff />}</span><div>
      <strong>{state === 'partial' ? t('live.partialTitle', undefined, language) : status === 'waiting' ? t('live.waitTitle', undefined, language) : t(`ui.status.${status}`, undefined, language)}</strong>
      <p>{connectionText === strings.sourceWaiting ? t('live.waitText', undefined, language) : connectionText}</p></div></div> : null}
    {live?.selection === 'game' && live.reason === 'Both games are available; choose ETS2 or ATS' && onSelect ? <div className="flex flex-wrap gap-2" data-testid="live-game-choice" aria-busy={choosing}>
      {(['ets2', 'ats'] as const).map(game => <Button key={game} type="button" variant="outline" disabled={choosing} data-testid={`live-choose-${game}`} onClick={() => {
        setChoosing(true); setChoiceFailed(false); void onSelect(game).catch(() => setChoiceFailed(true)).finally(() => setChoosing(false));
      }}>{game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator'}</Button>)}
      {choosing ? <p role="status">{strings.sourceChoosing}</p> : null}{choiceFailed ? <p role="alert">{strings.sourceSelectionFailed}</p> : null}
    </div> : null}

    <Card className="yu-instrument" data-testid="live.instrument"><CardContent>
      <h2 className="sr-only">{t('live.instruments', undefined, language)}</h2>
      {/* The gauge geometry is unchanged (ET-045a/f): a 256° speed arc on the shared speedGaugeFraction scale, ticks every 10, labels every 20 and the inner RPM arc. */}
      <div className="yu-gauge" data-testid="live.instrument.gauge"><svg data-testid="live-speed-gauge" viewBox="0 0 260 238" role="img" aria-label={`${t('live.speed', undefined, language)}: ${speedText}; ${t('live.rpm', undefined, language)}: ${value('engine-rpm')}`}>
        <path d={gaugeArc(122, -128, 128)} className="yu-gauge-track" strokeWidth={10} />
        {view.speedRatio !== null && view.speedRatio > 0 ? <path d={gaugeArc(122, -128, -128 + 256 * view.speedRatio)} className="yu-gauge-speed" strokeWidth={10} /> : null}
        {Array.from({length: Math.floor(view.scaleMax / 10) + 1}, (_, i) => {const v = i * 10, angle = (-128 + 256 * v / view.scaleMax) * Math.PI / 180;
          return <g key={v}><line x1={130 + 111 * Math.sin(angle)} y1={130 - 111 * Math.cos(angle)} x2={130 + (v % 20 === 0 ? 101 : 106) * Math.sin(angle)} y2={130 - (v % 20 === 0 ? 101 : 106) * Math.cos(angle)} className="yu-gauge-tick-line" />{v % 20 === 0 ? <text x={130 + 88 * Math.sin(angle)} y={134 - 88 * Math.cos(angle)} textAnchor="middle" className="yu-gauge-tick">{v}</text> : null}</g>;})}
        <path d={gaugeArc(66, -100, 100)} className="yu-gauge-track" strokeWidth={5} />
        {view.rpmRatio !== null && view.rpmRatio > 0 ? <path d={gaugeArc(66, -100, -100 + 200 * view.rpmRatio)} className="yu-gauge-rpm" strokeWidth={5} /> : null}
        <text x={130} y={142} textAnchor="middle" className="yu-gauge-number" data-testid="live-speed-number">{view.speedText}</text>
        <text x={130} y={166} textAnchor="middle" className="yu-gauge-unit" data-testid="live-speed-unit">{translateUnit(view.units.speed, language)}</text>
        <text x={130} y={214} textAnchor="middle" className="yu-gauge-caption">{value('engine-rpm')}</text>
      </svg></div>
      <div className="yu-gear" data-testid="live.instrument.gear"><span className="yu-muted">{t('live.gear', undefined, language)}</span><strong>{value('gear')}</strong>
        {text.paused ? <Badge variant="warn" data-testid="live-paused">{strings.livePaused}</Badge> : null}
        {state === 'stale' ? <Badge variant="error" data-testid="live.stale"><WifiOff aria-hidden="true" />{t(`ui.status.${status}`, undefined, language)}</Badge> : null}
      </div>
      <div className="yu-fuel" data-testid="live.instrument.fuel">
        <div className="yu-tank" data-testid="live.instrument.tank" data-state={view.fuelRatio === null ? 'unavailable' : 'value'} aria-hidden="true">{view.fuelRatio === null ? <span className="yu-tank-unavailable">—</span> : <span className="yu-tank-track"><i style={{height: `${view.fuelRatio * 100}%`, background: view.fuelRatio < .3 ? 'var(--yu-progress-pending)' : 'var(--yu-ok-fg)'}} /></span>}</div>
        <div className="yu-fuel-info">
          <p className="yu-fuel-amount"><strong className="yu-metric" data-testid="fuel">{strings.fuelLabel}: {fuelText}</strong> <span className="yu-muted">{t('live.of', {v: value('fuel-capacity')}, language)} · {value('fuel-level')}</span></p>
          <dl className="yu-fuel-rows">
            <div><dt className="yu-label-hint"><Navigation aria-hidden="true" />{t('live.range', undefined, language)}{hint(t('live.range', undefined, language), t('live.rangeNote', undefined, language))}</dt>
              <dd><strong>{value('estimated-range')}</strong> <small>{t('live.rangeNote', undefined, language)}</small></dd></div>
            <div><dt className="yu-label-hint"><Droplet aria-hidden="true" />{t('live.cons', undefined, language)}{hint(t('live.cons', undefined, language), consNote)}</dt>
              <dd><strong>{value('sdk-average-consumption')}</strong> <small>{consNote}</small></dd></div>
          </dl>
        </div>
      </div>
    </CardContent></Card>

    <Card className="yu-live-card" data-testid="live.job"><CardHeader>{title('live.job')}
      {cargo !== null || has('market') || has('deadline') ? <div className="yu-tags" data-testid="live.job.tags">
        {cargo !== null ? <Badge variant="neutral" className="yu-tag" data-testid="live.job.cargo"><Package aria-hidden="true" />{cargo}</Badge> : null}
        {has('market') ? <Badge variant="neutral" className="yu-tag" data-testid="live.job.market">{value('market')}</Badge> : null}
        {has('deadline') ? <Badge variant="neutral" className="yu-tag" data-testid="live.job.deadline"><Clock aria-hidden="true" />{t('live.deadline', undefined, language)} {value('deadline')}</Badge> : null}
      </div> : null}</CardHeader>
      {hasJob ? <CardContent className="yu-job-body">
        <div className="yu-route" data-testid="live.job.route">
          <div className="yu-route-end"><MapPin aria-hidden="true" /><span><strong data-testid="live.job.origin">{value('source-city')}</strong><small>{value('source-company')}</small></span></div>
          <span className="yu-route-line" aria-hidden="true" />
          <div className="yu-route-end yu-route-destination"><span><strong data-testid="live.job.destination">{value('destination-city')}</strong><small>{value('destination-company')}</small></span><Flag aria-hidden="true" /></div>
        </div>
        <div className="yu-job-metrics">
          <div><span className="yu-label-hint"><Navigation aria-hidden="true" />{t('live.remaining', undefined, language)}{hint(t('live.remaining', undefined, language), t('live.plannedNote', undefined, language))}</span><strong>{value('route-remaining')}</strong><small>{t('live.planned', {v: value('planned-distance')}, language)}</small></div>
          <div><span className="yu-label-hint"><Coins aria-hidden="true" />{t('live.income', undefined, language)}{hint(t('live.income', undefined, language), t('j.incomeNote', undefined, language))}</span><strong>{value('expected-income')}</strong></div>
          {shown('mandatory-break') && breakRow ? <div data-testid="live.job.break"><span><Coffee aria-hidden="true" />{breakRow.label}</span>
            <span className="yu-job-break"><strong>{has('mandatory-break') ? breakRow.value : '—'}</strong>{breakRow.badge ? <BreakBadge badge={breakRow.badge} testId="live.job.break.badge" /> : null}</span>
            {breakRow.note ? <small>{breakRow.note}</small> : null}</div> : null}
        </div>
      </CardContent> : <CardContent><p className="yu-muted" data-testid="live.job.none">{jobMissing ?? t('live.noJobHint', undefined, language)}</p></CardContent>}
    </Card>

    <div className="yu-live-cards">
      {/* ET-057: This trip shows only what the recording health carries, the open trip's completeness; no placeholder rows. */}
      <Card className="yu-live-card" data-testid="live.trip"><CardHeader>{title('live.trip')}</CardHeader><CardContent><dl>
        <div className="yu-kv"><dt>{t('live.recording', undefined, language)}</dt><dd data-testid="live.trip.recording">{completeness ? <Badge variant={COMPLETENESS_TONE[completeness]}>{t(`complete.${completeness}`, undefined, language)}</Badge> : '—'}</dd></div>
      </dl></CardContent></Card>
      <Card className="yu-live-card" data-testid="live.truck"><CardHeader>{title('live.truck')}</CardHeader><CardContent>{rows([[t('live.truck', undefined, language), value('truck')],
        [t('live.plate', undefined, language), value('truck-plate')], [t('live.trailer', undefined, language), value('trailers')], [t('live.odometer', undefined, language), value('odometer')]])}</CardContent></Card>
      <Card className="yu-live-card" data-testid="live.session"><CardHeader>{title('live.session')}</CardHeader><CardContent>{rows([
        [t('live.clock', undefined, language), value('game-time')],
        ...shown('game-mode') ? [[t('live.mode', undefined, language), mode ? t(mode === 'haulmp' ? 'mode.haulmp' : mode === 'truckersmp' ? 'mode.tmp' : 'mode.sp', undefined, language) : '—', 'live.session.mode'] as [string, string, string]] : [],
        [t('live.protocol', undefined, language), protocol, 'live.session.protocol'],
        ...shown('event-loss') ? [[t('live.lostEvents', undefined, language), value('event-loss'), 'live.session.lostEvents'] as [string, string, string]] : []])}</CardContent></Card>
    </div>

    {/* ET-057: every telemetry field, with its notes and reasons, stays one click away instead of repeating the cards above. */}
    <Card size="sm" className="yu-live-details-card"><details className="yu-live-details" data-testid="live.details"><summary data-testid="live.details.toggle"><ChevronRight aria-hidden="true" />{t('ui.details', undefined, language)}</summary><div className="yu-live-fields">
      {text.sections.map(section => <section key={section.id} data-testid={section.testId} className="space-y-1"><h3 className="font-bold">{section.title}</h3>
        {section.missing ? <p data-testid="live-job-missing">{section.missing}</p> : null}{section.status ? <p data-testid="live-v1-status">{section.status}</p> : null}
        {section.rows.length ? <dl>{section.rows.map(row => <div key={row.id} className="yu-kv"><dt>{row.id === 'mandatory-break' ? <Coffee className="inline size-3 mr-1" aria-hidden="true" data-testid="live-mandatory-break-icon" /> : null}{row.label}{row.note ? <small className="block yu-muted" data-testid={`${row.testId}-note`}>{row.note}</small> : null}</dt><dd><span data-testid={row.testId}>{row.value}</span>{row.reason ? <> (<span data-testid={`${row.testId}-reason`}>{row.reason}</span>)</> : null}{row.badge ? <> <BreakBadge badge={row.badge} testId={`${row.testId}-badge`} /></> : null}</dd></div>)}</dl> : null}
      </section>)}
    </div></details></Card>
  </div>;
}
