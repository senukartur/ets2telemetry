import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SampleChart} from '../../apps/desktop/src/screens/sample-chart';
import {describe, expect, it} from 'vitest';
import type {JournalSample} from '../../packages/contracts/src';
import {journalChart, chartSpeedY} from '../../apps/desktop/src/screens/journal-chart';
const value = (value: number) => ({available: true as const, value});
const sample = (id: number, changes: Partial<JournalSample> = {}): JournalSample => ({id: String(id), tripUuid: null, utcMs: 1000 + id * 1000,
  sourceClockId: 'clock-a', monotonicNs: String(id * 1e9), gameTime: null, speed: value(10), fuel: value(0), averageConsumption: value(0), estimatedRange: value(0),
  engineRpm: value(0), gear: value(0), odometer: value(0), position: {available: false, reason: 'not-observed'}, ...changes});
describe('current-page speed chart (REG-002/003/008/009/014)', () => {
  it('converts canonical speed and retains zero without using UTC for elapsed time', () => {
    const view = journalChart([sample(10, {utcMs: 90_000, speed: value(0)}), sample(11, {utcMs: 1})], 'ets2');
    expect(view).toEqual({unit: 'km/h', sampleCount: 2, domain: {min: 0, max: 36}, segments: [{points: [
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
