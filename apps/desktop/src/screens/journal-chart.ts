import type {JournalGame, JournalSample, UnitProfiles} from '../../../../packages/contracts/src';
import {resolveDisplayUnits} from '../../../../packages/telemetry-core/src/display-profile';
import {convertSpeed} from '../../../../packages/telemetry-core/src/units';
import {DEFAULT_UNIT_PROFILES} from '../unit-profiles';

export interface ChartPoint {id: string; elapsedSeconds: number; speed: number; utcMs: number}
export interface ChartSegment {points: ChartPoint[]}
export type ChartGapKind = 'no-samples' | 'no-speed' | 'excluded' | 'source-change';
/**
 * A break between two segments of the page; `afterSegment` is the segment before it, -1 for a break before the first.
 * `seconds` counts whole missing source seconds within one clock. A source change or a backwards instant has no length.
 */
export interface ChartGap {afterSegment: number; kind: ChartGapKind; seconds: number | null}
export type JournalChartView = ReturnType<typeof journalChart>;

const sourceSecond = (sample: JournalSample) => BigInt(sample.monotonicNs) / 1_000_000_000n;
const sameSource = (a: JournalSample, b: JournalSample) => a.pluginSessionId === b.pluginSessionId && a.sourceClockId === b.sourceClockId;
/** The undrawn samples since the last drawn one; `excluded` when any of them is outside the trip's accounting. */
interface Hole {first: JournalSample; last: JournalSample; excluded: boolean}
/** An excluded sample usually has a valid speed, so a hole holding one never claims that the speed was missing. */
const holeKind = (hole: Hole): ChartGapKind => hole.excluded ? 'excluded' : 'no-speed';

/** Why `sample` cannot continue the segment that ended at `before`, or null when it can. */
function breakBefore(before: JournalSample | undefined, sample: JournalSample, hole: Hole | undefined): Omit<ChartGap, 'afterSegment'> | null {
  if (!before) return hole ? {kind: holeKind(hole), seconds: sameSource(hole.first, sample) ? Math.max(0, Number(sourceSecond(sample) - sourceSecond(hole.first))) : null} : null;
  if (!sameSource(before, sample) || BigInt(sample.monotonicNs) <= BigInt(before.monotonicNs)) return {kind: 'source-change', seconds: null};
  // Sampling occupies source seconds, so the seconds strictly between the two are the missing ones.
  const missing = Number(sourceSecond(sample) - sourceSecond(before) - 1n);
  if (hole) return {kind: holeKind(hole), seconds: Math.max(0, missing)};
  return missing > 0 ? {kind: 'no-samples', seconds: missing} : null;
}

/** Current page only. Source-monotonic time determines continuity; UTC is a label, never an x-axis or duration. */
export function journalChart(samples: readonly JournalSample[], game: JournalGame, profiles: UnitProfiles = DEFAULT_UNIT_PROFILES) {
  const unit = resolveDisplayUnits(game, {profile: profiles[game]}).speed;
  const segments: ChartSegment[] = [], gaps: ChartGap[] = [];
  let drawn: JournalSample | undefined, hole: Hole | undefined, start = 0n;
  for (const sample of samples.slice(0, 300)) {
    const excluded = sample.accountingIncluded === false;
    if (excluded || !sample.speed.available || !Number.isFinite(sample.speed.value)) {
      hole = {first: hole?.first ?? sample, last: sample, excluded: excluded || (hole?.excluded ?? false)};
      continue;
    }
    const ns = BigInt(sample.monotonicNs), gap = breakBefore(drawn, sample, hole);
    if (gap) gaps.push({afterSegment: segments.length - 1, ...gap});
    if (gap || !drawn) {start = ns; segments.push({points: []});}
    segments[segments.length - 1].points.push({id: sample.id, elapsedSeconds: Number(ns - start) / 1e9,
      speed: convertSpeed(sample.speed.value, unit), utcMs: sample.utcMs});
    drawn = sample; hole = undefined;
  }
  // Undrawn samples at the end of the page have no later sample to close them, and the band must still show.
  if (hole) {
    const from = drawn ?? hole.first, offset = drawn ? 0n : 1n;
    gaps.push({afterSegment: segments.length - 1, kind: holeKind(hole), seconds: sameSource(from, hole.last) ? Math.max(0, Number(sourceSecond(hole.last) - sourceSecond(from) + offset)) : null});
  }
  const speeds = segments.flatMap(segment => segment.points.map(point => point.speed));
  const min = Math.min(0, ...speeds), upper = Math.max(0, ...speeds), max = upper === min ? min + 1 : upper;
  return {unit, segments, gaps, sampleCount: Math.min(samples.length, 300), domain: {min, max}};
}

/** Signed speed geometry; the domain includes zero and has a nonzero span, even for an all-zero page. */
export const chartSpeedY = (speed: number, domain: {min: number; max: number}) => 130 - (speed - domain.min) / (domain.max - domain.min) * 100;

const PLOT_LEFT = 30, PLOT_WIDTH = 530;
export interface ChartSegmentLayout {x: number; width: number; duration: number}
export interface ChartBandLayout {x: number; width: number; gap: ChartGap}
/**
 * Places every segment and gap band along one x-axis. A segment gets a width proportional to its seconds; a band gets a
 * fixed width that says nothing about its length, because a long gap would squash the data and a source change has none.
 */
export function chartLayout(view: Pick<JournalChartView, 'segments' | 'gaps'>): {segments: ChartSegmentLayout[]; bands: ChartBandLayout[]} {
  const bandWidth = view.gaps.length ? Math.min(28, 265 / view.gaps.length) : 0;
  const durations = view.segments.map(segment => Math.max(1, segment.points.at(-1)?.elapsedSeconds ?? 0));
  const total = durations.reduce((sum, duration) => sum + duration, 0);
  const free = PLOT_WIDTH - bandWidth * view.gaps.length;
  const segments: ChartSegmentLayout[] = [], bands: ChartBandLayout[] = [];
  let x = PLOT_LEFT;
  const placeBands = (afterSegment: number) => {
    for (const gap of view.gaps.filter(item => item.afterSegment === afterSegment)) {bands.push({x, width: bandWidth, gap}); x += bandWidth;}
  };
  placeBands(-1);
  durations.forEach((duration, index) => {
    const width = free * duration / total;
    segments.push({x, width, duration}); x += width;
    placeBands(index);
  });
  return {segments, bands};
}

/** One legend line per kind: how many bands, the seconds of those that have a length (null when none has), and how many have none. */
export function chartGapLegend(gaps: readonly ChartGap[]): {kind: ChartGapKind; seconds: number | null; count: number; unknown: number}[] {
  return (['no-samples', 'no-speed', 'excluded', 'source-change'] as const).flatMap(kind => {
    const matching = gaps.filter(gap => gap.kind === kind), known = matching.filter(gap => gap.seconds !== null);
    return matching.length ? [{kind, seconds: known.length ? known.reduce((sum, gap) => sum + (gap.seconds ?? 0), 0) : null, count: matching.length, unknown: matching.length - known.length}] : [];
  });
}
