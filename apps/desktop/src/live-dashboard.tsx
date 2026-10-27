import React, {useMemo} from 'react';
import {Clock, Coffee, Flag, Gauge, Hourglass, MapPin, Package, TriangleAlert, Truck, WifiOff} from 'lucide-react';
import type {AppLanguage, GearboxGearDisplays, GearDisplayModes, LiveTelemetry, UnitProfiles} from '../../../packages/contracts/src';
import type {LiveFieldId} from '../../../packages/telemetry-core/src/live-view';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Badge} from '@/components/ui/badge';
import {liveDashboardText, liveFieldValue, type LiveRowText} from './live-dashboard-text';
import {desktopLiveView, gaugeArc} from './screens/desktop-ui-view';
import {dashboardFuel, dashboardSpeed} from './speed-display';
import {displayProfile} from './unit-profiles';
import {getStrings} from './strings';
import {t, translateUnit} from './i18n';

/**
 * The next mandatory break's urgency (ET-052 D3): an icon, a word and a tone together, never colour alone. The accessible
 * name is the row label with the word; the icon is decorative.
 */
function BreakBadge({badge, testId}: {badge: NonNullable<LiveRowText['badge']>; testId: string}) {
  const Icon = badge.urgency === 'due' ? TriangleAlert : Hourglass;
  return <Badge variant={badge.urgency === 'due' ? 'error' : 'warn'} role="img" aria-label={badge.name} data-testid={testId} data-urgency={badge.urgency}><Icon aria-hidden="true" />{badge.text}</Badge>;
}

export function LiveDashboard({live, units, gearDisplay, gearboxes, language = 'en'}: {live: LiveTelemetry | undefined; units: UnitProfiles | undefined; gearDisplay?: GearDisplayModes;
  gearboxes?: GearboxGearDisplays; language?: AppLanguage}) {
  const text = useMemo(() => liveDashboardText(live, units, language, gearDisplay, gearboxes), [live, units, language, gearDisplay, gearboxes]);
  const view = useMemo(() => desktopLiveView(live, units, gearDisplay, gearboxes), [live, units, gearDisplay, gearboxes]);
  const strings = getStrings(language), profile = displayProfile(live, units);
  const value = (id: LiveFieldId) => {const f = view.sources.field(id); return f.state === 'value' || f.state === 'absent' ? liveFieldValue(f, language) : '—';};
  const speedText = dashboardSpeed(live, profile, language), fuelText = dashboardFuel(live, profile, language);
  const details = (ids: [string, LiveFieldId][]) => <dl>{ids.map(([label, id]) => <div className="yu-kv" key={id}><dt>{label}</dt><dd>{value(id)}</dd></div>)}</dl>;
  return <div className="yu-stack" data-testid="live-telemetry">
    {!view.current ? <div className="yu-connection" data-testid="live.waiting"><WifiOff aria-hidden="true" /><div><strong>{t(`ui.status.${live?.status ?? 'waiting'}`, undefined, language)}</strong><p>{live?.status === 'waiting' || !live ? t('st.waitT', undefined, language) : t('ui.notCurrent', undefined, language)}</p></div></div> : null}
    <div className="yu-live-top">
      <Card className={`yu-instrument ${view.current ? '' : 'yu-not-current'}`} data-testid="live.instrument"><CardContent>
        <div className="yu-gauge" data-testid="live.instrument.gauge"><svg data-testid="live-speed-gauge" viewBox="0 0 260 238" role="img" aria-label={`${t('live.speed', undefined, language)}: ${speedText}; ${t('live.rpm', undefined, language)}: ${value('engine-rpm')}`}>
          <path d={gaugeArc(122, -128, 128)} className="yu-gauge-track" strokeWidth={10} />
          {view.speedRatio !== null && view.speedRatio > 0 ? <path d={gaugeArc(122, -128, -128 + 256 * view.speedRatio)} className="yu-gauge-speed" strokeWidth={10} /> : null}
          {Array.from({length: Math.floor(view.scaleMax / 10) + 1}, (_, i) => {const v = i * 10, angle = (-128 + 256 * v / view.scaleMax) * Math.PI / 180;
            return <g key={v}><line x1={130 + 111 * Math.sin(angle)} y1={130 - 111 * Math.cos(angle)} x2={130 + (v % 20 === 0 ? 101 : 106) * Math.sin(angle)} y2={130 - (v % 20 === 0 ? 101 : 106) * Math.cos(angle)} stroke="var(--yu-text-muted)" />{v % 20 === 0 ? <text x={130 + 88 * Math.sin(angle)} y={134 - 88 * Math.cos(angle)} textAnchor="middle" className="yu-gauge-tick">{v}</text> : null}</g>;})}
          <path d={gaugeArc(66, -100, 100)} className="yu-gauge-track" strokeWidth={5} />
          {view.rpmRatio !== null && view.rpmRatio > 0 ? <path d={gaugeArc(66, -100, -100 + 200 * view.rpmRatio)} className="yu-gauge-rpm" strokeWidth={5} /> : null}
          <text x={130} y={142} textAnchor="middle" className="yu-gauge-number" data-testid="live-speed-number">{view.speedText}</text>
          <text x={130} y={166} textAnchor="middle" className="yu-gauge-unit" data-testid="live-speed-unit">{translateUnit(view.units.speed, language)}</text>
          <text x={130} y={214} textAnchor="middle" className="yu-gauge-caption">{value('engine-rpm')}</text>
        </svg></div>
        <div className="yu-gear" data-testid="live.instrument.gear"><span className="yu-muted">{t('live.gear', undefined, language)}</span><strong>{value('gear')}</strong></div>
        <div className="yu-fuel" data-testid="live.instrument.fuel"><div className="yu-tank" data-testid="live.instrument.tank" data-state={view.fuelRatio === null ? 'unavailable' : 'value'} aria-hidden="true">{view.fuelRatio === null ? <span className="yu-tank-unavailable">—</span> : <i style={{height: `${view.fuelRatio * 100}%`, background: view.fuelRatio < .3 ? 'var(--yu-progress-pending)' : 'var(--yu-ok-fg)'}} />}</div><div className="yu-stack">
          <div><p className="yu-muted">{t('live.fuel', undefined, language)}</p><strong className="yu-metric" data-testid="fuel">{strings.fuelLabel}: {fuelText}</strong><p className="yu-muted">{t('live.of', {v: value('fuel-capacity')}, language)} · {value('fuel-level')}</p></div>
          <div><p className="yu-muted">{t('live.range', undefined, language)} · {t('live.rangeNote', undefined, language)}</p><strong>{value('estimated-range')}</strong></div>
          <div><p className="yu-muted">{t('live.cons', undefined, language)}</p><strong>{value('sdk-average-consumption')}</strong><p className="yu-muted text-xs">{t(view.sources.v0View.connection.game === 'ats' ? 'live.consNoteAts' : 'live.consNote', undefined, language)}</p></div>
        </div></div>
        {text.paused ? <Badge variant="warn" data-testid="live-paused">{strings.livePaused}</Badge> : null}
      </CardContent></Card>
    </div>
      <Card data-testid="live.job"><CardHeader><CardTitle><h2 className="flex gap-2"><Package className="size-4" aria-hidden="true" />{t('live.job', undefined, language)}</h2></CardTitle></CardHeader><CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2"><Badge variant="neutral">{value('cargo')}</Badge><Badge variant="neutral">{value('cargo-mass')}</Badge><Badge variant="neutral">{value('market')}</Badge></div>
        <div className="yu-route" data-testid="live.job.route"><div><MapPin aria-hidden="true" /><strong data-testid="live.job.origin">{value('source-city')}</strong><p>{value('source-company')}</p></div><span aria-hidden="true">→</span><div className="text-right"><Flag aria-hidden="true" /><strong data-testid="live.job.destination">{value('destination-city')}</strong><p>{value('destination-company')}</p></div></div>
        <div className="yu-job-metrics"><div><span>{t('live.remaining', undefined, language)}</span><strong>{value('route-remaining')}</strong><small>{t('live.planned', {v: value('planned-distance')}, language)}</small></div><div><span>{t('live.income', undefined, language)}</span><strong>{value('expected-income')}</strong></div><div><span><Clock className="inline size-3" aria-hidden="true" /> {t('live.deadline', undefined, language)}</span><strong>{value('deadline')}</strong></div></div>
        <p className="yu-muted text-xs">{t('ui.observedProgress', undefined, language)}</p>
      </CardContent></Card>
    <div className="yu-live-bottom"><Card data-testid="live.trip"><CardHeader><CardTitle><h2>{t('live.trip', undefined, language)}</h2></CardTitle></CardHeader><CardContent><dl>{(['live.realTime', 'live.gameTime', 'live.fuelUsed'] as const).map(key => <div className="yu-kv" key={key}><dt>{t(key, undefined, language)}</dt><dd>—</dd></div>)}</dl><p className="yu-muted text-xs">{t('ui.unavailable', undefined, language)}</p></CardContent></Card>
      <Card data-testid="live.truck"><CardHeader><CardTitle><h2 className="flex gap-2"><Truck className="size-4" aria-hidden="true" />{t('live.truck', undefined, language)}</h2></CardTitle></CardHeader><CardContent>{details([[t('live.truck', undefined, language), 'truck'], [t('live.plate', undefined, language), 'truck-plate'], [t('live.trailer', undefined, language), 'trailers'], [t('live.odometer', undefined, language), 'odometer']])}</CardContent></Card>
      <Card data-testid="live.session"><CardHeader><CardTitle><h2 className="flex gap-2"><Gauge className="size-4" aria-hidden="true" />{t('live.session', undefined, language)}</h2></CardTitle></CardHeader><CardContent>{details([[t('live.clock', undefined, language), 'game-time'], [t('live.mode', undefined, language), 'game-mode'], [t('live.lostEvents', undefined, language), 'event-loss']])}<p className="yu-muted">{t('live.protocol', undefined, language)}: {view.sources.v0View.connection.protocol ?? '—'}</p></CardContent></Card></div>
    <Card size="sm" data-testid="live.details"><CardHeader><CardTitle><h2>{t('ui.details', undefined, language)}</h2></CardTitle></CardHeader><CardContent className="yu-live-fields">
      {text.sections.map(section => <section key={section.id} data-testid={section.testId} className="space-y-1"><h3 className="font-semibold">{section.title}</h3>
        {section.missing ? <p data-testid="live-job-missing">{section.missing}</p> : null}{section.status ? <p data-testid="live-v1-status">{section.status}</p> : null}
        {section.rows.length ? <dl>{section.rows.map(row => <div key={row.id} className="yu-kv"><dt>{row.id === 'mandatory-break' ? <Coffee className="inline size-3 mr-1" aria-hidden="true" data-testid="live-mandatory-break-icon" /> : null}{row.label}{row.note ? <small className="block yu-muted" data-testid={`${row.testId}-note`}>{row.note}</small> : null}</dt><dd><span data-testid={row.testId}>{row.value}</span>{row.reason ? <> (<span data-testid={`${row.testId}-reason`}>{row.reason}</span>)</> : null}{row.badge ? <> <BreakBadge badge={row.badge} testId={`${row.testId}-badge`} /></> : null}</dd></div>)}</dl> : null}
      </section>)}
    </CardContent></Card>
  </div>;
}
