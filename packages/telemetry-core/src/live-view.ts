// Pure live dashboard view model. The renderer builds it per bridge update (at most 20 Hz) from the existing
// LiveTelemetry projection; it adds no IPC, storage or trip effect. Field `text` holds the formatted value only;
// labels and reason texts are the application's (apps/desktop/src/strings.ts).
import type {LiveTelemetry} from '../../contracts/src';
import {deadlineRemaining, fuelLevel} from './derived';
import type {DisplayProfileId, DisplayUnits, GameId} from './display-profile';
import {
  formatBearing, formatBoolean, formatConsumption, formatDeadline, formatDistance, formatGameTime, formatGear, formatMass, formatMoney,
  formatPercent, formatPosition, formatRpm, formatSpeed, formatVolume
} from './format';
import {missing, valueOf, type GameModeView, type LiveTrailer, type LiveTruck, type MissingReason, type NamedEntity, type NormalizedLiveState, type Reading} from './readings';

export type ViewReason = MissingReason | 'not-current' | 'zero-consumption';
/** Context a label must carry. `sdk-mean`: the SDK's own average, never a trip average. */
export type FieldNote =
  'sdk-mean' | 'ats-mostly-static' | 'game-estimate' | 'job-offer-excludes-ferry' | 'game-time' | 'game-world-coordinates' | 'cargo-market-only';
export type LiveFieldId =
  'speed' | 'gear' | 'engine-rpm' | 'fuel' | 'fuel-capacity' | 'fuel-level' | 'sdk-average-consumption' | 'estimated-range' | 'odometer' |
  'route-remaining' | 'game-time' | 'deadline' | 'cargo' | 'source-city' | 'source-company' | 'destination-city' | 'destination-company' |
  'cargo-mass' | 'market' | 'special-job' | 'cargo-loaded' | 'planned-distance' | 'expected-income' | 'truck' | 'truck-plate' | 'trailers' |
  'position' | 'bearing' | 'game-mode' | 'event-loss';
/**
 * `value`: a current formatted value. `missing`: the row shows "unavailable" with a reason. `hidden`: the row is not
 * shown, because the protocol in use does not carry the field or the field does not apply (for example no job).
 */
export interface LiveField {id: LiveFieldId; state: 'value' | 'missing' | 'hidden'; text: string; reason?: ViewReason; notes?: readonly FieldNote[]}
export type LiveSectionId = 'motion' | 'fuel' | 'distance' | 'time' | 'job' | 'vehicle' | 'position';
/** `missing` is set when the section's subject is absent while current, such as no job reported. */
export interface LiveSection {id: LiveSectionId; fields: LiveField[]; missing?: MissingReason}
export interface LiveConnectionView {
  status: LiveTelemetry['status'];
  /** Fresh connected or paused telemetry with an observation; every other status hides all values. */
  current: boolean;
  /** Current values shown under a "game paused" banner. */
  paused: boolean;
  simulation: NormalizedLiveState['simulation'] | undefined;
  origin: 'game' | 'synthetic' | 'replay' | 'none';
  /** Synthetic or replay data, which is never real history. */
  flagged: boolean;
  game: GameId | undefined;
  profile: DisplayProfileId;
  protocol: NormalizedLiveState['protocol'] | undefined;
  /** v1 only; hidden under v0. */
  gameMode: LiveField;
  /** v1 only; hidden under v0. */
  eventLoss: LiveField;
}
export interface LiveDashboardView {connection: LiveConnectionView; sections: LiveSection[]}

/** Current means fresh, connected or paused, and backed by an observation. Stale values are never shown as current. */
export function isCurrent(live: LiveTelemetry): boolean {
  return live.fresh && (live.status === 'connected' || live.status === 'paused') && !!live.observation;
}

type Formatted = string | {reason: ViewReason};
function field<T>(id: LiveFieldId, current: boolean, reading: Reading<T>, format: (value: T) => Formatted, notes?: readonly FieldNote[]): LiveField {
  const extra = notes?.length ? {notes} : {};
  if (reading.state === 'missing' && reading.reason === 'not-carried') return {id, state: 'hidden', text: '', reason: 'not-carried', ...extra};
  if (!current) return {id, state: 'missing', text: 'unavailable', reason: 'not-current', ...extra};
  if (reading.state === 'missing') return {id, state: 'missing', text: 'unavailable', reason: reading.reason, ...extra};
  const formatted = format(reading.value);
  return typeof formatted === 'string' ? {id, state: 'value', text: formatted, ...extra} : {id, state: 'missing', text: 'unavailable', reason: formatted.reason, ...extra};
}
const hidden = (id: LiveFieldId, reason?: ViewReason, notes?: readonly FieldNote[]): LiveField => ({id, state: 'hidden', text: '', ...(reason ? {reason} : {}), ...(notes ? {notes} : {})});
const text = (value: string) => value === '' ? '(empty)' : value;

/** First non-empty value in order; then a provided empty value; otherwise the first meaningful missing reason. */
function firstText(...readings: Reading<string>[]): Reading<string> {
  const filled = readings.find(reading => reading.state === 'value' && reading.value !== '');
  if (filled) return filled;
  const empty = readings.find(reading => reading.state === 'value');
  if (empty) return empty;
  return readings.find(reading => reading.state === 'missing' && reading.reason !== 'not-carried') ?? readings[0];
}
/** Localized name, else stable id (a provided empty name falls through to the id). */
export const entityText = (entity: NamedEntity): Reading<string> => firstText(entity.name, entity.id);
/** Brand and model name, else the model name, else the model id. */
export function truckText(truck: LiveTruck): Reading<string> {
  const model = entityText(truck.model);
  const brand = truck.brand.name;
  if (truck.model.name.state === 'value' && truck.model.name.value !== '' && brand.state === 'value' && brand.value !== '') return valueOf(`${brand.value} ${truck.model.name.value}`);
  return model;
}
/** Trailer name, else body type, else id: job trailers usually arrive without a name (concept.md, October 13, 2026). */
export const trailerText = (trailer: LiveTrailer): Reading<string> => firstText(trailer.model.name, trailer.bodyType, trailer.model.id);

/** Occupied trailer slots in slot order, joined by ", "; empty slots are skipped. */
function trailersText(trailers: Reading<Reading<LiveTrailer>[]>): Reading<string> {
  if (trailers.state === 'missing') return trailers;
  const names = trailers.value.flatMap(slot => slot.state === 'value' ? [trailerText(slot.value)] : []);
  if (!names.length) return missing('not-observed');
  if (names.every(name => name.state === 'missing')) return names[0];
  return valueOf(names.map(name => name.state === 'value' ? text(name.value) : 'unavailable').join(', '));
}

function gameModeText(mode: GameModeView): string {
  if (mode.mode === 'unknown') return 'unknown';
  // A weak result, such as a single-player guess from a missing module, always states its weak evidence.
  return `${mode.mode === 'truckersmp' ? 'TruckersMP' : 'single-player'} (${mode.confidence} evidence, ${mode.method})`;
}

export function buildLiveView(live: LiveTelemetry, state: NormalizedLiveState | undefined, units: DisplayUnits): LiveDashboardView {
  const current = isCurrent(live) && state !== undefined;
  const observation = live.observation;
  const origin = observation?.source.origin ?? 'none';
  const game: GameId | undefined = observation?.source.game ?? (live.selection === 'ets2' || live.selection === 'ats' ? live.selection : undefined);
  // Without a normalized state no field is known to be carried; every value is shown as not current.
  const s = state ?? unknownState();
  const f = <T>(id: LiveFieldId, reading: Reading<T>, format: (value: T) => Formatted, notes?: readonly FieldNote[]) => field(id, current, reading, format, notes);

  const job = s.job;
  const jobValue = job.state === 'value' ? job.value : undefined;
  const noJob: MissingReason | undefined = current && job.state === 'missing' && job.reason !== 'not-carried' ? job.reason : undefined;
  // Job rows: the job's own value; hidden with the job's reason while current without a job ("no job reported");
  // otherwise not current like every other row.
  const jobField = <T>(id: LiveFieldId, pick: (value: NonNullable<typeof jobValue>) => Reading<T>, format: (value: T) => Formatted, notes?: readonly FieldNote[]) => {
    if (jobValue) return f(id, pick(jobValue), format, notes);
    if (job.state === 'missing' && (current || job.reason === 'not-carried')) return hidden(id, job.reason, notes);
    return f(id, missing<T>('not-observed'), format, notes);
  };
  const market = jobValue?.market;
  const cargoMarket = market?.state === 'value' && market.value === 'cargo_market';

  const truck = s.truck;
  const averageNotes: FieldNote[] = game === 'ats' ? ['sdk-mean', 'ats-mostly-static'] : ['sdk-mean'];
  const placement = s.worldPlacement;
  const sections: LiveSection[] = [
    {id: 'motion', fields: [
      f('speed', s.speed, value => formatSpeed(value, units.speed)),
      f('gear', s.gear, formatGear),
      f('engine-rpm', s.engineRpm, formatRpm)
    ]},
    {id: 'fuel', fields: [
      f('fuel', s.fuel, value => formatVolume(value, units.volume, 1)),
      f('fuel-capacity', s.fuelCapacity, value => formatVolume(value, units.volume, 0)),
      f('fuel-level', fuelLevel(s.fuel, s.fuelCapacity), formatPercent),
      f('sdk-average-consumption', s.averageConsumption, value => {
        const formatted = formatConsumption(value, units.consumption);
        return 'text' in formatted ? formatted.text : formatted;
      }, averageNotes),
      f('estimated-range', s.estimatedRange, value => formatDistance(value, units.distance, 0), ['game-estimate'])
    ]},
    {id: 'distance', fields: [
      f('odometer', s.odometer, value => formatDistance(value.meters, units.distance, 1)),
      f('route-remaining', s.navigationDistance, value => formatDistance(value.meters, units.distance, 1))
    ]},
    {id: 'time', fields: [
      f('game-time', s.gameTime.minutes, formatGameTime, ['game-time']),
      jobField('deadline', value => deadlineRemaining(value.deliveryDeadline, s.gameTime.minutes), formatDeadline, ['game-time'])
    ]},
    {id: 'job', ...(noJob ? {missing: noJob} : {}), fields: [
      jobField('cargo', value => entityText(value.cargo), text),
      jobField('source-city', value => entityText(value.sourceCity), text),
      jobField('source-company', value => entityText(value.sourceCompany), text),
      jobField('destination-city', value => entityText(value.destinationCity), text),
      jobField('destination-company', value => entityText(value.destinationCompany), text),
      jobField('cargo-mass', value => value.cargoMass, value => formatMass(value, units.mass)),
      jobField('market', value => value.market, text),
      jobField('special-job', value => value.isSpecialJob, formatBoolean),
      // SDK 1.15 defines cargo.loaded only for the cargo market; elsewhere it is always true and is not shown.
      jobValue && !cargoMarket
        ? hidden('cargo-loaded', market?.state === 'missing' ? market.reason : undefined, ['cargo-market-only'])
        : jobField('cargo-loaded', value => value.cargoLoaded, formatBoolean, ['cargo-market-only']),
      jobField('planned-distance', value => value.plannedDistance, value => formatDistance(value.meters, units.distance, 0), ['job-offer-excludes-ferry']),
      jobField('expected-income', value => value.expectedIncome, formatMoney)
    ]},
    {id: 'vehicle', fields: [
      f('truck', truck.state === 'value' ? truckText(truck.value) : truck, text),
      f('truck-plate', truck.state === 'value' ? truck.value.licensePlate : truck, text),
      f('trailers', trailersText(s.trailers), value => value)
    ]},
    {id: 'position', fields: [
      f('position', placement, value => formatPosition(value.position), ['game-world-coordinates']),
      f('bearing', placement, value => formatBearing(value.orientation.heading), ['game-world-coordinates'])
    ]}
  ];

  return {
    connection: {
      status: live.status, current, paused: current && (live.status === 'paused' || s.simulation === 'paused'),
      simulation: state?.simulation, origin, flagged: origin === 'synthetic' || origin === 'replay', game, profile: units.profile,
      protocol: state?.protocol,
      gameMode: f('game-mode', s.gameMode, gameModeText),
      eventLoss: f('event-loss', s.eventLoss, counts => Object.values(counts).reduce((sum, count) => sum + count, 0n).toString())
    },
    sections
  };
}

/** Placeholder state used only when no normalized state exists, so that every field reads as not current. */
function unknownState(): NormalizedLiveState {
  const none = missing<never>('not-observed');
  return {
    protocol: 'v0', simulation: 'unavailable', speed: none, gear: none, engineRpm: none, fuel: none, fuelCapacity: none, averageConsumption: none,
    estimatedRange: none, odometer: none, navigationDistance: none, gameTime: {minutes: none, clockId: ''}, worldPlacement: none, job: none,
    truck: none, trailers: none, gameMode: none, eventLoss: none, configurationRevision: '0'
  };
}
