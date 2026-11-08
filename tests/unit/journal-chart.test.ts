import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SampleChart} from '../../apps/desktop/src/screens/sample-chart';
import {describe, expect, it} from 'vitest';
import type {JournalSample} from '../../packages/contracts/src';
import {chartGapLegend, chartLayout, journalChart, chartSpeedY} from '../../apps/desktop/src/screens/journal-chart';
const value = (value: number) => ({available: true as const, value});
const sample = (id: number, changes: Partial<JournalSample> = {}): JournalSample => ({id: String(id), tripUuid: null, utcMs: 1000 + id * 1000,
  sourceClockId: 'clock-a', monotonicNs: String(id * 1e9), gameTime: null, speed: value(10), fuel: value(0), averageConsumption: value(0), estimatedRange: value(0),
  engineRpm: value(0), gear: value(0), odometer: value(0), position: {available: false, reason: 'not-observed'}, ...changes});
describe('current-page speed chart (REG-002/003/008/009/014)', () => {
  it('converts canonical speed and retains zero without using UTC for elapsed time', () => {
    const view = journalChart([sample(10, {utcMs: 90_000, speed: value(0)}), sample(11, {utcMs: 1})], 'ets2');
    expect(view).toEqual({unit: 'km/h', sampleCount: 2, domain: {min: 0, max: 36}, gaps: [], segments: [{points: [
      {id: '10', elapsedSeconds: 0, speed: 0, utcMs: 90_000}, {id: '11', elapsedSeconds: 1, speed: 36, utcMs: 1}]}]});
    expect(journalChart([sample(1)], 'ats').segments[0].points[0].speed).toBeCloseTo(22.3693629205, 8);
  });
  it('breaks at unavailable values and missing seconds without inventing a pause or bridging the gap', () => {
    const view = journalChart([sample(1), sample(2, {speed: {available: false, reason: 'invalid'}}), sample(3), sample(5), sample(6)], 'ets2');
    expect(view.segments.map(segment => segment.points.map(point => [point.id, point.elapsedSeconds]))).toEqual([[['1', 0]], [['3', 0]], [['5', 0], ['6', 1]]]);
  });
  it('separates source-clock changes, backwards instants and duplicate instants even when UTC increases', () => {
    const view = journalChart([sample(1), sample(2, {sourceClockId: 'clock-b'}), sample(3, {sourceClockId: 'clock-b', monotonicNs: '2000000000'}),
      sample(4, {sourceClockId: 'clock-b', monotonicNs: '1000000000'}), sample(5, {sourceClockId: 'clock-b', monotonicNs: '2000000000'})], 'ets2');
    expect(view.segments.map(segment => segment.points.map(point => point.id))).toEqual([['1'], ['2'], ['3'], ['4', '5']]);
  });
  it('limits work to the current 300 samples and never sorts by clock labels', () => {
    const view = journalChart(Array.from({length: 400}, (_, index) => sample(index, {utcMs: 900_000 - index})), 'ets2');
    expect(view.sampleCount).toBe(300); expect(view.segments).toHaveLength(1); expect(view.segments[0].points).toHaveLength(300);
    expect(view.segments[0].points.at(-1)).toEqual({id: '299', elapsedSeconds: 299, speed: 36, utcMs: 899701});
    expect(journalChart([], 'ets2').segments).toEqual([]);
  });
});

it.each(['metric', 'us-customary'] as const)('preserves signed geometry relative to zero for %s pages', profile => {
  for (const speeds of [[-10, 0, 10], [-10, -5], [0, 0]]) {
    const view = journalChart(speeds.map((speed, id) => sample(id, {speed: value(speed)})), 'ets2', {ets2: profile, ats: profile});
    const zero = chartSpeedY(0, view.domain);
    expect(view.domain.min).toBeLessThanOrEqual(0); expect(view.domain.max).toBeGreaterThan(view.domain.min);
    for (const point of view.segments[0].points) {
      const y = chartSpeedY(point.speed, view.domain); expect(Number.isFinite(y)).toBe(true); expect(y).toBeGreaterThanOrEqual(30); expect(y).toBeLessThanOrEqual(130);
      if (point.speed < 0) expect(y).toBeGreaterThan(zero);
      else if (point.speed > 0) expect(y).toBeLessThan(zero);
      else expect(y).toBe(zero);
    }
  }
});

it.each(['en', 'ru'] as const)('renders signed SVG points and titles on both unit profiles in %s', language => {
  for (const profile of ['metric', 'us-customary'] as const) {
    const svg = renderToStaticMarkup(React.createElement(SampleChart, {samples: [-10, 0, 10].map((speed, id) => sample(id, {speed: value(speed)})), game: 'ets2', units: {ets2: profile, ats: profile}, language}));
    expect(svg).toContain('data-testid="trip.chart.zero"');
    expect(svg).toContain('y1="80"'); expect(svg).toContain('cy="130"'); expect(svg).toContain('cy="80"'); expect(svg).toContain('cy="30"');
    expect(svg).toContain(profile === 'metric' ? '-36.0' : '-22.4');
    expect(svg).toContain(language === 'ru' ? profile === 'metric' ? 'км/ч' : 'миль/ч' : profile === 'metric' ? 'km/h' : 'mph');
  }
});

describe('chart gaps (ET-077; REG-002/003/008/009/014)', () => {
  const invalid = {speed: {available: false, reason: 'invalid'}} as const;
  it('classifies each break and counts whole missing source seconds, never UTC', () => {
    const view = journalChart([sample(1, {utcMs: 900_000}), sample(2, invalid), sample(3, {utcMs: 5}), sample(5), sample(6)], 'ets2');
    expect(view.gaps).toEqual([{afterSegment: 0, kind: 'no-speed', seconds: 1}, {afterSegment: 1, kind: 'no-samples', seconds: 1}]);
    expect(journalChart([sample(1), sample(2, {accountingIncluded: false}), sample(3)], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'no-speed', seconds: 1}]);
  });
  it('gives a source change and a backwards instant no length', () => {
    expect(journalChart([sample(1), sample(2, {sourceClockId: 'clock-b'})], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'source-change', seconds: null}]);
    expect(journalChart([sample(1), sample(2, {pluginSessionId: 'other'})], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'source-change', seconds: null}]);
    expect(journalChart([sample(3), sample(4, {monotonicNs: '1000000000'})], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'source-change', seconds: null}]);
    expect(journalChart([sample(3), sample(4, {monotonicNs: '3000000000'})], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'source-change', seconds: null}]);
  });
  it('keeps a gap at the start and at the end of the page visible', () => {
    expect(journalChart([sample(1, invalid), sample(2, invalid), sample(3)], 'ets2').gaps).toEqual([{afterSegment: -1, kind: 'no-speed', seconds: 2}]);
    expect(journalChart([sample(1), sample(2, invalid), sample(3, invalid)], 'ets2').gaps).toEqual([{afterSegment: 0, kind: 'no-speed', seconds: 2}]);
    const empty = journalChart([sample(1, invalid), sample(2, invalid)], 'ets2');
    expect(empty.segments).toEqual([]); expect(empty.gaps).toEqual([{afterSegment: -1, kind: 'no-speed', seconds: 2}]);
    expect(journalChart([sample(1), sample(2)], 'ets2').gaps).toEqual([]);
  });
  it('gives segments a width by their seconds and gaps a fixed band', () => {
    const view = journalChart([...Array.from({length: 10}, (_, id) => sample(id)), sample(20), sample(21)], 'ets2');
    const layout = chartLayout(view);
    expect(view.gaps).toEqual([{afterSegment: 0, kind: 'no-samples', seconds: 10}]);
    expect(layout.segments[0].x).toBeCloseTo(30, 8); expect(layout.segments[0].width).toBeCloseTo(451.8, 8);
    expect(layout.bands[0].x).toBeCloseTo(481.8, 8); expect(layout.bands[0].width).toBe(28);
    expect(layout.segments[1].x).toBeCloseTo(509.8, 8); expect(layout.segments[1].width).toBeCloseTo(50.2, 8);
    const many = Array.from({length: 20}, (_, index) => ({afterSegment: index, kind: 'no-samples' as const, seconds: 1}));
    const segments = Array.from({length: 20}, () => ({points: [{id: 'x', elapsedSeconds: 1, speed: 0, utcMs: 0}]}));
    expect(chartLayout({segments, gaps: many}).bands[0].width).toBe(13.25);
  });
  it('aggregates the legend per kind and keeps the count of bands without a length', () => {
    expect(chartGapLegend([{afterSegment: 0, kind: 'no-samples', seconds: 10}, {afterSegment: 1, kind: 'source-change', seconds: null}, {afterSegment: 2, kind: 'no-samples', seconds: 5}, {afterSegment: 3, kind: 'source-change', seconds: null}]))
      .toEqual([{kind: 'no-samples', seconds: 15, count: 2}, {kind: 'source-change', seconds: null, count: 2}]);
    expect(chartGapLegend([])).toEqual([]);
  });
  const render = (language: 'en' | 'ru') => renderToStaticMarkup(React.createElement(SampleChart, {samples: [sample(0), sample(1), sample(2), sample(10), sample(11), sample(30)], game: 'ets2', language}));
  it('draws no line across a band and a hatched band for each gap', () => {
    const svg = render('en');
    const bands = [...svg.matchAll(/data-testid="trip\.chart\.gap"[^>]*><rect x="([\d.]+)" y="20" width="([\d.]+)"[^>]*fill="url\(#([^"]+)\)"/g)].map(match => ({left: Number(match[1]), right: Number(match[1]) + Number(match[2]), pattern: match[3]}));
    expect(bands).toHaveLength(2);
    for (const band of bands) expect(svg).toContain(`<pattern id="${band.pattern}"`);
    const lines = [...svg.matchAll(/<polyline points="([^"]+)"/g)].map(match => match[1].split(' ').map(point => Number(point.split(',')[0])));
    expect(lines).toHaveLength(2);
    for (const line of lines) for (const band of bands) expect(line.every(x => x <= band.left) || line.every(x => x >= band.right)).toBe(true);
    expect(svg.match(/data-testid="trip\.chart\.segment"/g)).toHaveLength(3);
    expect(svg.match(/<svg/g)).toHaveLength(1);
    // The last sample is alone in its segment: it has no line of its own and only its point stays visible.
    expect(svg.match(/class="yu-chart-point"/g)).toHaveLength(1);
  });
  it.each([['en', 'no samples for 25 s', '7 s', '18 s'], ['ru', 'нет сэмплов 25 с', '7 с', '18 с']] as const)('names the gaps in real text in %s', (language, legend, first, second) => {
    const svg = render(language);
    expect(svg).toContain('data-testid="trip.chart.gaps"'); expect(svg).toContain(legend);
    expect(svg).toContain(`>${first}</text>`); expect(svg).toContain(`>${second}</text>`);
  });
  it('shows a page without any drawable sample as a band with no line', () => {
    const svg = renderToStaticMarkup(React.createElement(SampleChart, {samples: [sample(1, invalid), sample(2, invalid)], game: 'ets2', language: 'en'}));
    expect(svg).toContain('data-testid="trip.chart.gap"'); expect(svg).toContain('no speed for 2 s'); expect(svg).not.toContain('<polyline');
  });
});
