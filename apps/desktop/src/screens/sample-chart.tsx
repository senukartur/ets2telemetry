import React, {useId} from 'react';
import type {AppLanguage, JournalGame, JournalSample, UnitProfiles} from '../../../../packages/contracts/src';
import {t, translateUnit} from '../i18n';
import {chartGapLegend, chartLayout, chartSpeedY, journalChart, type ChartGap} from './journal-chart';
import {journalDurationText, localTime} from '../journal-view';

const bandLabel = (seconds: number | null, language: AppLanguage) => seconds === null ? '?'
  : seconds < 60 ? t('tr.durS', {s: seconds}, language) : seconds < 3600 ? t('tr.durM', {m: Math.floor(seconds / 60)}, language) : t('tr.durH', {h: Math.floor(seconds / 3600)}, language);
/** A kind's total of known lengths never hides that some of its gaps have none. */
function gapText(gap: Pick<ChartGap, 'kind' | 'seconds'> & {count: number; unknown: number}, language: AppLanguage) {
  if (gap.kind === 'source-change') return t('tr.gapSource', {n: gap.count}, language);
  if (gap.seconds === null) return t('tr.gapUnknown', undefined, language);
  const known = t(gap.kind === 'no-samples' ? 'tr.gap' : 'tr.gapNoSpeed', {d: journalDurationText(gap.seconds, language)}, language);
  return gap.unknown > 0 ? `${known} · ${t('tr.ivUnknown', {n: gap.unknown}, language)}` : known;
}

/**
 * All segments of the page on one axis. Each segment has its own polyline, area and elapsed labels, and a gap is a hatched
 * band between segments, so a line never crosses a gap and no pause is invented.
 */
export function SampleChart({samples, game, units, language = 'en'}: {samples: readonly JournalSample[]; game: JournalGame; units?: UnitProfiles; language?: AppLanguage}) {
  const hatch = `yu-trip-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const chart = journalChart(samples, game, units), layout = chartLayout(chart), label = t('ui.chartPage', undefined, language);
  const zeroY = chartSpeedY(0, chart.domain), unit = translateUnit(chart.unit, language);
  const legend = chartGapLegend(chart.gaps).map(entry => ({kind: entry.kind, text: gapText(entry, language)}));
  const drawn = chart.segments.length > 0 || chart.gaps.length > 0;
  return <figure className="yu-chart" data-testid="trip.chart" aria-label={label}>
    <figcaption><strong>{label}</strong><p>{t('ui.chartNote', undefined, language)}</p></figcaption>
    {drawn ? <svg viewBox="0 0 590 165" role="img" aria-label={[label, ...legend.map(entry => entry.text)].join('. ')}>
      <title>{label}</title>
      <defs><pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" className="yu-trip-hatch-fill" /><line x1="0" y1="0" x2="0" y2="6" className="yu-trip-hatch-line" /></pattern></defs>
      <path d="M30 20 V130 H560" className="yu-chart-grid" />
      <text x="30" y="15">{chart.domain.max.toFixed(1)} {unit}</text>
      <text x="30" y="143">{chart.domain.min.toFixed(1)} {unit}</text>
      <line data-testid="trip.chart.zero" x1="30" x2="560" y1={zeroY} y2={zeroY} className="yu-chart-grid" /><text x="565" y={zeroY}>0</text>
      {chart.segments.map((segment, index) => {
        const place = layout.segments[index], last = segment.points.at(-1)!;
        const coordinates = segment.points.map(point => ({point, x: place.x + point.elapsedSeconds / place.duration * place.width, y: chartSpeedY(point.speed, chart.domain)}));
        const line = coordinates.map(({x, y}) => `${x},${y}`).join(' ');
        const area = `${coordinates[0].x},${zeroY} ${line} ${coordinates.at(-1)!.x},${zeroY}`;
        const isolated = segment.points.length === 1;
        return <g key={segment.points[0].id} data-testid="trip.chart.segment">
          {isolated ? null : <><polygon points={area} className="yu-trip-chart-area" /><polyline points={line} fill="none" className="yu-chart-line" /></>}
          {coordinates.map(({point, x, y}) => <circle data-speed={point.speed} key={point.id} cx={x} cy={y} r="2.5" className={isolated ? 'yu-chart-point' : 'yu-trip-chart-hit'}><title>{`${point.elapsedSeconds.toFixed(1)} s: ${point.speed.toFixed(1)} ${unit} · ${localTime(point.utcMs)}`}</title></circle>)}
          {place.width >= 70 ? <><text x={place.x} y="153">{t('tr.durS', {s: 0}, language)}</text><text x={place.x + place.width} y="153" textAnchor="end">{t('tr.durS', {s: last.elapsedSeconds.toFixed(1)}, language)}</text></> : null}
        </g>;
      })}
      {layout.bands.map(band => <g key={`${band.gap.afterSegment}`} data-testid="trip.chart.gap" data-kind={band.gap.kind}>
        <rect x={band.x} y="20" width={band.width} height="110" fill={`url(#${hatch})`}><title>{gapText({...band.gap, count: 1, unknown: 0}, language)}</title></rect>
        {band.width >= 20 ? <text x={band.x + band.width / 2} y="75" textAnchor="middle" className="yu-trip-chart-band-label">{bandLabel(band.gap.seconds, language)}</text> : null}
      </g>)}
    </svg> : <p>{t('ui.unavailable', undefined, language)}</p>}
    {drawn ? <div className="yu-trip-legend">
      <span><span aria-hidden="true" className="yu-trip-legend-line" />{unit}, {t('tr.samples', undefined, language)}</span>
      {legend.length ? <span data-testid="trip.chart.gaps" className="yu-trip-legend-gaps">{legend.map(entry => <span key={entry.kind} data-kind={entry.kind}><span aria-hidden="true" className="yu-trip-legend-band" />{entry.text}</span>)}</span> : null}
    </div> : null}
  </figure>;
}
