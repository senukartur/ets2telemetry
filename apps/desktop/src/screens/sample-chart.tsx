import React from 'react';
import type {AppLanguage, JournalGame, JournalSample, UnitProfiles} from '../../../../packages/contracts/src';
import {t, translateUnit} from '../i18n';
import {journalChart, chartSpeedY} from './journal-chart';
import {localTime} from '../journal-view';

/** Each segment has its own labelled elapsed axis, so a gap never becomes a connecting line or invented pause. */
export function SampleChart({samples, game, units, language = 'en'}: {samples: readonly JournalSample[]; game: JournalGame; units?: UnitProfiles; language?: AppLanguage}) {
  const chart = journalChart(samples, game, units), label = t('ui.chartPage', undefined, language);
  const zeroY = chartSpeedY(0, chart.domain);
  return <figure className="yu-chart" data-testid="trip.chart" aria-label={label}>
    <figcaption><strong>{label}</strong><p>{t('ui.chartNote', undefined, language)}</p></figcaption>
    {chart.segments.length ? chart.segments.map((segment, index) => {
      const duration = Math.max(1, segment.points.at(-1)!.elapsedSeconds);
      const points = segment.points.map(point => `${30 + point.elapsedSeconds / duration * 530},${chartSpeedY(point.speed, chart.domain)}`).join(' ');
      return <div key={segment.points[0].id} data-testid="trip.chart.segment">
        <svg viewBox="0 0 590 165" role="img" aria-label={`${label} ${index + 1}`}>
          <title>{label} {index + 1}</title><path d="M30 20 V130 H560" className="yu-chart-grid" />
          <text x="30" y="15">{chart.domain.max.toFixed(1)} {translateUnit(chart.unit, language)}</text>
          <text x="30" y="143">{chart.domain.min.toFixed(1)} {translateUnit(chart.unit, language)}</text>
          <line data-testid="trip.chart.zero" x1="30" x2="560" y1={zeroY} y2={zeroY} className="yu-chart-grid" /><text x="565" y={zeroY}>0</text>
          <polyline points={points} fill="none" className="yu-chart-line" />
          {segment.points.map(point => <circle data-speed={point.speed} key={point.id} cx={30 + point.elapsedSeconds / duration * 530} cy={chartSpeedY(point.speed, chart.domain)} r="2.5" className="yu-chart-point"><title>{point.elapsedSeconds.toFixed(1)} s: {point.speed.toFixed(1)} {translateUnit(chart.unit, language)} · {localTime(point.utcMs)}</title></circle>)}
          <text x="30" y="153">0 s</text><text x="510" y="153">{segment.points.at(-1)!.elapsedSeconds.toFixed(1)} s</text>
        </svg>
      </div>;
    }) : <p>{t('ui.unavailable', undefined, language)}</p>}
  </figure>;
}
