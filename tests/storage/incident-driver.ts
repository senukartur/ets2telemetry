// A compact copy of the ET-112 incident corpus driver of tests/storage/trip-continuation.test.ts (`drive`), for the
// history repair suite (ET-112g). Origin: synthetic (tests/shared/trip-continuation-incident.ts). One process of the
// corpus through the storage API: job.configured opens eventSeq 1 with proof only when the proof exists 999 ms into the
// process, 1 Hz readings follow, the member's Hard Mode checks are written once (the batch is sent twice), then a timer
// restart (game exit) or the delivery closes the trip as eventSeq 2.
import type {HardModeCounts, HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import type {SampleInput, Storage, TripEffect} from '../../packages/storage/src/index';
import {evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {INCIDENT_JOB, incidentDelivered, type IncidentSegment} from '../shared/trip-continuation-incident';
import {GAME_CLOCK_1, r, Script} from '../shared/trip-messages';
import {ok, uploadGame} from './helpers';

export const SCOPE = 'a'.repeat(64), OTHER_SCOPE = 'c'.repeat(64);
/** Extra synthetic sessions for segments outside the three incident processes. */
export const EXTRA_SESSIONS = ['10000000-0000-4000-8000-000000112004', '10000000-0000-4000-8000-000000112005', '10000000-0000-4000-8000-000000112006'] as const;
const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const absent = {available: false, reason: 'not-observed'} as const;
const atNs = (atMs: number) => (1_000_000_000_000n + BigInt(atMs) * 1_000_000n).toString();

export interface DriveOptions {
  job?: JobConfiguration; scope?: string; end?: IncidentSegment['end'] | 'open'; checks?: HardModeCounts;
  /** Commit the session as game origin (a history database). */
  game?: boolean;
}
export function drive(storage: Storage, segment: IncidentSegment, options: DriveOptions = {}): {uuid: string; script: Script} {
  const script = new Script(segment.session, 'ets2', {utcMs: segment.startUtcMs}), values = options.job ?? INCIDENT_JOB, process = script.welcome().source.processInstanceId;
  const origin = <T extends {source: {origin: string}}>(message: T): T => options.game ? uploadGame(message) : message;
  const profile: ProfileObservation = {version: 1, scope: options.scope ?? SCOPE, binding: 'b'.repeat(64), game: 'ets2', pluginSessionId: script.session, processInstanceId: process,
    sourceClockId: script.clockId, afterMonotonicNs: atNs(segment.profileFromMs), loadGeneration: 1};
  ok(storage.upsertSession({message: origin(script.welcome())}));
  const configured = origin(script.event(r.jobConfigured(values))), uuid = tripUuidFor(script.session, configured.data.eventSeq);
  ok(storage.commitEvent({message: configured, ...(segment.profileFromMs <= 999 ? {profile} : {}), effects: [{kind: 'trip.open', tripUuid: uuid, game: 'ets2', gameMode: mode,
    jobConfiguration: 'this-event', startedUtcMs: segment.startUtcMs + 1_000, recordingCompleteness: 'complete'}, {kind: 'event.attribute', tripUuid: uuid, attribution: 'trip'}]}));
  for (const [index, reading] of segment.readings.entries()) {
    const row: SampleInput = {tripUuid: uuid, utcMs: segment.startUtcMs + reading.atMs, sourceClockId: script.clockId, monotonicNs: atNs(reading.atMs),
      odometer: {available: true, value: reading.odometerM}, fuel: {available: true, value: reading.fuelL}, speed: {available: true, value: reading.speedMps},
      gameTime: {minutes: {available: true, value: reading.gameMinutes}, clockId: GAME_CLOCK_1}, position: {available: true, value: {x: reading.x, y: 0, z: 0}},
      averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent,
      recording: {...(reading.atMs >= segment.profileFromMs ? {profile} : {}), job: values, truck: 'verified-truck', processInstanceId: process,
        ...(index > 0 ? {previous: {tripUuid: uuid, sourceClockId: script.clockId, monotonicNs: atNs(segment.readings[index - 1].atMs)}} : {})}};
    ok(storage.appendSamples(script.session, [row], {uniqueSeconds: true}));
  }
  const end = options.end ?? segment.end, last = segment.readings.at(-1)!.atMs;
  const checks = options.checks ?? segment.checks, total = checks.passingChecks + checks.failingChecks + checks.unknownChecks, at = segment.startUtcMs + last;
  const observation: HardModeObservation = segment.profileVerified
    ? {assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), at, 'local'), binding: 'e'.repeat(64), pluginSessionId: segment.session, sourceMonotonicNs: '0'}
    : {assessment: unknownHardMode(at, 'source-unproven'), binding: null, pluginSessionId: segment.session, sourceMonotonicNs: null, diagnostic: 'profile-verification'};
  if (total > 0) for (let sent = 0; sent < 2; sent++) ok(storage.observeHardMode('ets2', {...observation, batch: {tripUuid: uuid, producer: `90000000-0000-4000-8000-${segment.session.slice(-12)}`, sequence: total, ...checks}}, segment.profileVerified));
  if (end === 'open') return {uuid, script};
  const delivered = end === 'delivered', message = origin(script.event(delivered ? incidentDelivered() : r.timersRestart(), {advanceMs: last}));
  const effects: TripEffect[] = [{kind: 'trip.close', tripUuid: uuid, outcome: delivered ? 'delivered' : 'none', closeReason: delivered ? 'outcome' : 'restart',
    ...(delivered ? {outcomeEvent: 'this-event' as const} : {}), recordingCompleteness: 'partial', endedUtcMs: segment.startUtcMs + last + 1_000}];
  ok(storage.commitEvent({message, effects}));
  return {uuid, script};
}
