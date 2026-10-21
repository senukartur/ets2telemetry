import type {JournalGame, JournalSample, UnitProfiles} from '../../../../packages/contracts/src';
import {resolveDisplayUnits} from '../../../../packages/telemetry-core/src/display-profile';
import {convertSpeed} from '../../../../packages/telemetry-core/src/units';
import {DEFAULT_UNIT_PROFILES} from '../unit-profiles';

export interface ChartPoint {id: string; elapsedSeconds: number; speed: number; utcMs: number}
export interface ChartSegment {points: ChartPoint[]}
/** Current page only. Source-monotonic time determines continuity; UTC is a label, never an x-axis or duration. */
export function journalChart(samples: readonly JournalSample[], game: JournalGame, profiles: UnitProfiles = DEFAULT_UNIT_PROFILES) {
  const unit = resolveDisplayUnits(game, {profile: profiles[game]}).speed;
  const segments: ChartSegment[] = [];
  let previous: JournalSample | undefined, start = 0n;
  for (const sample of samples.slice(0, 300)) {
    const ns = BigInt(sample.monotonicNs);
    if (!sample.speed.available || !Number.isFinite(sample.speed.value)) {previous = undefined; continue;}
    const prior = previous ? BigInt(previous.monotonicNs) : null;
    // Sampling occupies source seconds. A missing second, a backwards/duplicate instant or a new clock starts a segment.
    if (!previous || previous.sourceClockId !== sample.sourceClockId || prior === null || ns <= prior || ns / 1_000_000_000n - prior / 1_000_000_000n > 1n) {
      start = ns; segments.push({points: []});
    }
    segments[segments.length - 1].points.push({id: sample.id, elapsedSeconds: Number(ns - start) / 1e9,
      speed: convertSpeed(sample.speed.value, unit), utcMs: sample.utcMs});
    previous = sample;
  }
  return {unit, segments, sampleCount: Math.min(samples.length, 300)};
}
