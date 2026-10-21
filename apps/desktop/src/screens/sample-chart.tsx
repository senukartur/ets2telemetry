import React from 'react';
import type {AppLanguage, JournalGame, JournalSample, UnitProfiles} from '../../../../packages/contracts/src';
import {t, translateUnit} from '../i18n';
import {journalChart} from './journal-chart';
import {localTime} from '../journal-view';

/** Each segment has its own labelled elapsed axis, so a gap never becomes a connecting line or invented pause. */
export function SampleChart({samples, game, units, language = 'en'}: {samples: readonly JournalSample[]; game: JournalGame; units?: UnitProfiles; language?: AppLanguage}) {
  const chart = journalChart(samples, game, units), label = t('ui.chartPage', undefined, language);
  const maxSpeed = Math.max(1, ...chart.segments.flatMap(segment => segment.points.map(point => point.speed)));
  return <figure className="yu-chart" data-testid="trip.chart" aria-label={label}>
    <figcaption><strong>{label}</strong><p>{t('ui.chartNote', undefined, language)}</p></figcaption>
    {chart.segments.length ? chart.segments.map((segment, index) => {
      const duration = Math.max(1, segment.points.at(-1)!.elapsedSeconds);
      const points = segment.points.map(point => `${30 + point.elapsedSeconds / duration * 530},${130 - Math.max(0, point.speed) / maxSpeed * 100}`).join(' ');
      return <div key={segment.points[0].id} data-testid="trip.chart.segment">
        <svg viewBox="0 0 590 165" role="img" aria-label={`${label} ${index + 1}`}>
          <title>{label} {index + 1}</title><path d="M30 20 V130 H560" className="yu-chart-grid" />
          <text x="30" y="15">{maxSpeed.toFixed(1)} {translateUnit(chart.unit, language)}</text>
          <polyline points={points} fill="none" className="yu-chart-line" />
          {segment.points.map(point => <circle key={point.id} cx={30 + point.elapsedSeconds / duration * 530} cy={130 - Math.max(0, point.speed) / maxSpeed * 100} r="2.5" className="yu-chart-point"><title>{point.elapsedSeconds.toFixed(1)} s: {point.speed.toFixed(1)} {translateUnit(chart.unit, language)} · {localTime(point.utcMs)}</title></circle>)}
          <text x="30" y="153">0 s</text><text x="510" y="153">{segment.points.at(-1)!.elapsedSeconds.toFixed(1)} s</text>
        </svg>
      </div>;
    }) : <p>{t('ui.unavailable', undefined, language)}</p>}
  </figure>;
}
