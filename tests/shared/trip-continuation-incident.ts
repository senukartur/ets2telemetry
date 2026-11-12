// ET-112b trip continuation incident corpus (REG-001, REG-003, REG-005, REG-008, REG-012, REG-014), shared by
// tests/unit/trip-membership.test.ts and tests/storage/trip-continuation.test.ts. Origin: synthetic. The shape is derived
// from the confirmed findings on card ET-112: one ETS2 external contract driven across three game processes, a service
// restart before the last one, equal job, odometer and game minute at the last restart with about 4.5 ml of fuel and 2 mm
// of position difference, 9,978 revenue at delivery against a different expected income, and a delivered game distance of
// 187,342.01049804688 m. Every ID, value and timestamp other than those is invented; the corpus holds no path, profile
// name, account ID or game ID from the incident. The last process uses the sanitized ET-112a log timing: its profile
// proof becomes available with the log header, 5,114 ms after process creation. Expected results are written by hand.
import type {EventRecord, JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {tripUuidFor} from '../../packages/telemetry-core/src/index';
import {incidentLocal, INCIDENT_PROCESS_CREATED_MS} from './profile-log-generation';
import {job, money, r} from './trip-messages';

/** Three plugin sessions, one per game process; the Script helper derives distinct process and clock IDs from them. */
export const INCIDENT_SESSIONS = ['10000000-0000-4000-8000-000000112001', '10000000-0000-4000-8000-000000112002', '10000000-0000-4000-8000-000000112003'] as const;

/** Job J: Berlin to Dresden, an external contract with synthetic IDs. Expected income deliberately differs from revenue. */
export const INCIDENT_JOB: JobConfiguration = job({
  sourceCityId: {available: true, value: 'synthetic_berlin'}, sourceCity: {available: true, value: 'Berlin'},
  sourceCompanyId: {available: true, value: 'synthetic_origin_company'}, sourceCompany: {available: true, value: 'Synthetic Origin Company'},
  destinationCityId: {available: true, value: 'synthetic_dresden'}, destinationCity: {available: true, value: 'Dresden'},
  destinationCompanyId: {available: true, value: 'synthetic_destination_company'}, destinationCompany: {available: true, value: 'Synthetic Destination Company'},
  cargoId: {available: true, value: 'synthetic_incident_cargo'}, cargo: {available: true, value: 'Synthetic Incident Cargo'},
  cargoMass: {available: true, value: 21_000, unit: 'kg'}, market: {available: true, value: 'external_contracts'},
  plannedDistance: {available: true, value: 192_000, unit: 'm'}, expectedIncome: money('10250', 'u64'),
  deliveryDeadline: {available: true, value: '20895', unit: 'min'}
});
/** J with an unavailable deadline, as one reading of a job without deadline evidence would carry it. */
export const INCIDENT_JOB_WITHOUT_DEADLINE: JobConfiguration = {...INCIDENT_JOB, deliveryDeadline: {available: false, reason: 'not-observed', unit: 'min'}};
/** J with the u32 maximum as its deadline; the SDK defines no sentinel, so identity treats it as unavailable. */
export const INCIDENT_JOB_U32_MAX_DEADLINE: JobConfiguration = {...INCIDENT_JOB, deliveryDeadline: {available: true, value: '4294967295', unit: 'min'}};
/** A different job of the same profile: another cargo to another destination. */
export const INCIDENT_OTHER_JOB: JobConfiguration = {...INCIDENT_JOB, cargoId: {available: true, value: 'synthetic_other_cargo'},
  destinationCityId: {available: true, value: 'synthetic_leipzig'}, destinationCity: {available: true, value: 'Leipzig'}, expectedIncome: money('8100', 'u64')};
/** The different job recorded without deadline evidence: it can neither join nor replace another job. */
export const INCIDENT_OTHER_JOB_WITHOUT_DEADLINE: JobConfiguration = {...INCIDENT_OTHER_JOB, deliveryDeadline: {available: false, reason: 'not-observed', unit: 'min'}};

export const INCIDENT_REVENUE = {raw: '9978', sdkType: 's64'} as const;
export const INCIDENT_DELIVERED_DISTANCE_M = 187342.01049804688;
/** The delivery record: the incident's revenue and game-reported distance on the shared delivery fixture. */
export function incidentDelivered(): EventRecord {
  const base = r.delivered(INCIDENT_REVENUE.raw) as Extract<EventRecord, {type: 'job.delivered'}>;
  return {...base, distance: {available: true, value: INCIDENT_DELIVERED_DISTANCE_M, unit: 'm'}};
}

/** One 1 Hz reading, `atMs` after the start of its process. */
export interface IncidentReading {atMs: number; odometerM: number; fuelL: number; x: number; gameMinutes: number; speedMps: number}
export interface IncidentSegment {
  session: string;
  /** UTC label of the process start. */
  startUtcMs: number;
  /** Profile proof is available from this offset; earlier readings and the opening event carry none. */
  profileFromMs: number;
  /** The storage service restarts before this segment. */
  serviceRestartBefore: boolean;
  end: 'game-exit' | 'delivered';
  readings: readonly IncidentReading[];
}

/** ET-112a: the header was written 5,114 ms after the process was created; the proof is admitted from then on. */
export const FINAL_PROCESS_PROFILE_DELAY_MS = incidentLocal(1, 31, 6) - INCIDENT_PROCESS_CREATED_MS;
/** The second process starts at the previous-session log header time of profile-log-generation.ts. */
const SECOND_PROCESS_START = incidentLocal(1, 13, 40);

// Driving at 20 m/s; every segment ends stopped at its save point and the next one resumes there.
export const INCIDENT_SEGMENTS: readonly IncidentSegment[] = [
  {session: INCIDENT_SESSIONS[0], startUtcMs: incidentLocal(0, 13, 0), profileFromMs: 0, serviceRestartBefore: false, end: 'game-exit', readings: [
    {atMs: 2_000, odometerM: 812_000, fuelL: 420, x: 1_000, gameMinutes: 9_000, speedMps: 20},
    {atMs: 3_000, odometerM: 812_020, fuelL: 419.99, x: 1_020, gameMinutes: 9_000, speedMps: 20},
    {atMs: 4_000, odometerM: 812_040, fuelL: 419.98, x: 1_040, gameMinutes: 9_001, speedMps: 0}]},
  {session: INCIDENT_SESSIONS[1], startUtcMs: SECOND_PROCESS_START, profileFromMs: 0, serviceRestartBefore: false, end: 'game-exit', readings: [
    {atMs: 2_000, odometerM: 812_040, fuelL: 419.98, x: 1_040, gameMinutes: 9_001, speedMps: 0},
    {atMs: 3_000, odometerM: 812_060, fuelL: 419.97, x: 1_060, gameMinutes: 9_001, speedMps: 20},
    {atMs: 4_000, odometerM: 812_080, fuelL: 419.96, x: 1_080, gameMinutes: 9_002, speedMps: 0}]},
  // Fuel -0.0045 L and position +0.002 m against the previous save point; odometer and game minute are equal.
  {session: INCIDENT_SESSIONS[2], startUtcMs: INCIDENT_PROCESS_CREATED_MS, profileFromMs: FINAL_PROCESS_PROFILE_DELAY_MS, serviceRestartBefore: true, end: 'delivered', readings: [
    {atMs: 2_000, odometerM: 812_080, fuelL: 419.9555, x: 1_080.002, gameMinutes: 9_002, speedMps: 0},
    {atMs: 3_000, odometerM: 812_100, fuelL: 419.9455, x: 1_100.002, gameMinutes: 9_002, speedMps: 20},
    {atMs: 6_000, odometerM: 812_160, fuelL: 419.9155, x: 1_160.002, gameMinutes: 9_003, speedMps: 20},
    {atMs: 7_000, odometerM: 812_180, fuelL: 419.9055, x: 1_180.002, gameMinutes: 9_003, speedMps: 0}]}
];

/** Every segment opens with a job.configured event as eventSeq 1. */
export const incidentTripUuid = (segment: number) => tripUuidFor(INCIDENT_SEGMENTS[segment].session, '1');
/** Hand-written expectation for the whole incident once every segment has admitted proof while its raw trip is open. */
export const INCIDENT_EXPECTED = {
  journalTrips: 1,
  rawTrips: 3,
  rootTripUuid: incidentTripUuid(0),
  sources: [...INCIDENT_SESSIONS],
  outcome: 'delivered',
  deliveredEvents: 1,
  revenue: INCIDENT_REVENUE,
  deliveredDistanceM: INCIDENT_DELIVERED_DISTANCE_M
} as const;
