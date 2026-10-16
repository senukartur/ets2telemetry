import type {LiveTelemetry} from '../../../packages/contracts/src';
import type {DisplayUnits} from '../../../packages/telemetry-core/src/display-profile';
import {buildLiveView, carriesField, type LiveDashboardView, type LiveField, type LiveFieldId} from '../../../packages/telemetry-core/src/live-view';
import {normalizeV0State} from '../../../packages/telemetry-core/src/normalize-v0';
import {normalizeV1State} from '../../../packages/telemetry-core/src/normalize-v1';
import type {LiveJob, NormalizedLiveState, Reading} from '../../../packages/telemetry-core/src/readings';

// The one combiner of the v0 observation and the protocol v1 projection (ET-010c, decision F4). The dashboard card and
// main's overlay projection both read every field through it, so they cannot disagree about which protocol a value
// comes from. Pure, safe for renderer bundles and plain Node tests.

/** Fields only v1 carries that describe the job; they count only for the job v0 reports (decision F4(b)). */
export const V1_JOB_FIELDS: ReadonlySet<LiveFieldId> = new Set<LiveFieldId>([
  'deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job', 'cargo-loaded'
]);
/** v0-carried fields that show v1's localized name for the same job (decision F4(c)). */
const NAMED_FIELDS: ReadonlySet<LiveFieldId> = new Set<LiveFieldId>(['cargo', 'destination-city']);

/**
 * `none`: v0 reports no job (or no observation yet). `no-v1`: v0 reports a job but no v1 observation is carried, so
 * nothing is compared. `mismatch`: a carried v1 observation reports no job or another cargo or destination city.
 */
export type JobIdentity = 'none' | 'no-v1' | 'match' | 'mismatch';
export interface LiveSources {
  v0View: LiveDashboardView;
  v0State?: NormalizedLiveState;
  /** Set while `v1Carried`. */
  v1View?: LiveDashboardView;
  /**
   * A v1 observation exists for the update's selection and, when v0 has an observation, comes from the same origin and
   * game (decision F4(e)). Without it every v1-only field is hidden, exactly as before ET-010c.
   */
  v1Carried: boolean;
  /** Carried, fresh, connected or paused v1 data. */
  v1Current: boolean;
  job: JobIdentity;
  /** v0 decides while current; otherwise current v1 data may report a paused game (decision F4(d)). */
  paused: boolean;
  /** The field to display: v0 for what v0 carries, v1 for the rest, with the job guard applied. */
  field(id: LiveFieldId): LiveField;
}

const sameValue = (left: Reading<string>, right: Reading<string>) => left.state === 'value' && right.state === 'value' && left.value === right.value;
function jobIdentity(v0: LiveJob | undefined, v1: NormalizedLiveState['job'] | undefined): JobIdentity {
  if (!v0) return 'none';
  if (!v1) return 'no-v1';
  if (v1.state !== 'value') return 'mismatch';
  return sameValue(v0.cargo.id, v1.value.cargo.id) && sameValue(v0.destinationCity.id, v1.value.destinationCity.id) ? 'match' : 'mismatch';
}
function fieldsOf(view: LiveDashboardView): Map<LiveFieldId, LiveField> {
  const fields = new Map<LiveFieldId, LiveField>(view.sections.flatMap(section => section.fields.map(field => [field.id, field] as const)));
  fields.set('game-mode', view.connection.gameMode); fields.set('event-loss', view.connection.eventLoss);
  return fields;
}
const notCurrent = (field: LiveField): LiveField => ({id: field.id, state: 'missing', text: 'unavailable', reason: 'not-current', ...(field.notes ? {notes: field.notes} : {})});

export function liveSources(live: LiveTelemetry, units: DisplayUnits): LiveSources {
  const v0State = live.observation ? normalizeV0State(live.observation.state) : undefined;
  const v0View = buildLiveView(live, v0State, units);
  const v1 = live.v1, v1Observation = v1?.observation, v0Source = live.observation?.source;
  const carried = v1 && v1Observation && v1.selection === live.selection &&
    (!v0Source || (v1Observation.source.origin === v0Source.origin && v1Observation.source.game === v0Source.game)) ? {v1, observation: v1Observation} : undefined;
  const v1Carried = carried !== undefined;
  const v1State = carried ? normalizeV1State(carried.observation.state, carried.observation.sourceStatus) : undefined;
  const v1View = carried ? buildLiveView(carried.v1, v1State, units) : undefined;
  const v0Current = v0View.connection.current, v1Current = !!v1View?.connection.current;
  const job = jobIdentity(v0State?.job.state === 'value' ? v0State.job.value : undefined, v1State?.job);
  const v0Fields = fieldsOf(v0View), v1Fields = v1View ? fieldsOf(v1View) : undefined;
  const field = (id: LiveFieldId): LiveField => {
    if (carriesField('v0', id)) {
      const base = v0Fields.get(id)!;
      // A localized name replaces the game id only for the same job, and only while both sources are current.
      const named = NAMED_FIELDS.has(id) && base.state === 'value' && v1Current && job === 'match' ? v1Fields!.get(id)! : undefined;
      return named?.state === 'value' ? {...base, text: named.text} : base;
    }
    if (!v1Fields) return {id, state: 'hidden', text: '', reason: 'not-carried'};
    const v1Field = v1Fields.get(id)!;
    if (!V1_JOB_FIELDS.has(id) || job === 'match') return v1Field;
    // No v0 job: the job rows do not apply. Another job: v1's values are not the current job's, so they are not current;
    // a row v1 itself hides for its job (cargo loaded outside the cargo market) stays hidden.
    if (job === 'none') return {id, state: 'hidden', text: '', ...(v1Field.notes ? {notes: v1Field.notes} : {})};
    return v1Field.state === 'hidden' && v1State?.job.state === 'value' ? v1Field : notCurrent(v1Field);
  };
  return {
    v0View, ...(v0State ? {v0State} : {}), ...(v1View ? {v1View} : {}), v1Carried, v1Current, job,
    paused: v0Current ? v0View.connection.paused : v1Current && !!v1View?.connection.paused,
    field
  };
}
