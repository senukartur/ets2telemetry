import {sameGameSource} from './live-state';
import type {LiveTelemetry} from '../../../packages/contracts/src';
import type {GearboxState, HShifterLayout} from '../../../packages/contracts/src/protocol-v1';
import type {DisplayUnits, GearDisplayMode} from '../../../packages/telemetry-core/src/display-profile';
import {CRAWLER_LABELS, deriveGearLabels, type GearLabelGame} from '../../../packages/telemetry-core/src/gear-labels';
import {buildLiveView, carriesField, isCurrent, type GearDisplay, type LiveDashboardView, type LiveField, type LiveFieldId} from '../../../packages/telemetry-core/src/live-view';
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
/** v0-carried fields that show v1's localized name for the same job (decision F4(c)). The truck row has its own guard. */
const NAMED_FIELDS: ReadonlySet<LiveFieldId> = new Set<LiveFieldId>(['cargo', 'destination-city']);

/**
 * `none`: v0 reports no job (or no observation yet). `no-v1`: v0 reports a job but no v1 observation is carried, so
 * nothing is compared. `mismatch`: a carried v1 observation reports no job or another cargo or destination city.
 */
export type JobIdentity = 'none' | 'no-v1' | 'match' | 'mismatch';
export interface LiveSources {
  v0View: LiveDashboardView;
  v0State?: NormalizedLiveState;
  /** Normalized v1 readings; consumers must still use `field` to enforce freshness and job identity. */
  v1State?: NormalizedLiveState;
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

/**
 * The last H-shifter layout seen, as a frozen copy. Every live update arrives as a new object, so an unchanged layout is
 * replaced by this copy and deriveGearLabels' identity-keyed memo hits instead of deriving again at up to 20 Hz. The
 * copy, not the caller's object, is kept, so a caller that later changes its own object cannot alter the memo.
 */
let lastLayout: HShifterLayout | undefined;
function stableLayout(layout: HShifterLayout): HShifterLayout {
  const last = lastLayout;
  if (last !== undefined && last.selectorCount === layout.selectorCount && last.slots.length === layout.slots.length &&
    last.slots.every((slot, index) => {
      const other = layout.slots[index];
      return slot.gear === other.gear && slot.handlePosition === other.handlePosition && slot.selectors === other.selectors;
    })) return last;
  const copy: HShifterLayout = Object.freeze({selectorCount: layout.selectorCount,
    slots: Object.freeze(layout.slots.map(slot => Object.freeze({gear: slot.gear, handlePosition: slot.handlePosition, selectors: slot.selectors}))) as HShifterLayout['slots']});
  lastLayout = copy;
  return copy;
}
/**
 * ET-050b B6: manual mode uses the gearbox-aware labels only while the v1 projection is carried and current, its truck
 * has the same model id as v0's (the ET-045a rule) and its layout validates against the gear counts. Anything else,
 * including a minor-0 source whose gearbox is `not-supported`, keeps the GD2 formula; a stale layout is never held.
 * The v1 source's game names the crawler (B5 as amended on October 26, 2026). Crawler mode (owner option B, October 26,
 * 2026) uses no layout, only the single crawler name of the source's game: v0's, else the carried v1 source's.
 */
function gearDisplay(mode: GearDisplayMode, applies: boolean, gearbox: GearboxState | undefined, game: GearLabelGame | undefined,
  sourceGame: GearLabelGame | undefined): GearDisplay {
  if (mode === 'crawler') return sourceGame === undefined ? {mode} : {mode, crawler: CRAWLER_LABELS[sourceGame].single};
  if (mode !== 'manual' || !applies || gearbox === undefined || game === undefined || !gearbox.hshifter.available) return {mode};
  const labels = deriveGearLabels({...gearbox, hshifter: {available: true, value: stableLayout(gearbox.hshifter.value)}}, game);
  return labels ? {mode, labels} : {mode};
}

/**
 * `gear` (ET-050) selects only how the gear row is formatted; every other field and every reading is unchanged. In
 * manual mode the labels follow the current v1 truck's gearbox layout when it applies (ET-050b B6), else the formula.
 */
export function liveSources(live: LiveTelemetry, units: DisplayUnits, gear: GearDisplayMode = 'automatic'): LiveSources {
  const v0State = live.observation ? normalizeV0State(live.observation.state) : undefined;
  const v1 = live.v1, v1Observation = v1?.observation, v0Source = live.observation?.source;
  const carried = v1 && v1Observation && v1.selection === live.selection &&
    (!v0Source || (v1Observation.source.origin === v0Source.origin && v1Observation.source.game === v0Source.game && (v0Source.origin !== 'game' || sameGameSource(v0Source, v1Observation.source)))) ? {v1, observation: v1Observation} : undefined;
  const v1Carried = carried !== undefined;
  const v1State = carried ? normalizeV1State(carried.observation.state, carried.observation.sourceStatus) : undefined;
  // The same currentness buildLiveView reports for the v1 view.
  const v1Current = carried !== undefined && isCurrent(carried.v1);
  // ET-045a: v0 carries only the truck's model id; v1's SDK brand and name describe the same truck only for the same id.
  const sameTruck = v0State?.truck.state === 'value' && v1State?.truck.state === 'value' && sameValue(v0State.truck.value.model.id, v1State.truck.value.model.id);
  const display = gearDisplay(gear, v1Current && sameTruck, carried?.observation.state.gearbox, carried?.observation.source.game,
    v0Source?.game ?? carried?.observation.source.game);
  const v0View = buildLiveView(live, v0State, units, display);
  const v1View = carried ? buildLiveView(carried.v1, v1State, units, display) : undefined;
  const v0Current = v0View.connection.current;
  const job = jobIdentity(v0State?.job.state === 'value' ? v0State.job.value : undefined, v1State?.job);
  const v0Fields = fieldsOf(v0View), v1Fields = v1View ? fieldsOf(v1View) : undefined;
  const field = (id: LiveFieldId): LiveField => {
    if (carriesField('v0', id)) {
      const base = v0Fields.get(id)!;
      // A localized name replaces the game id only for the same job (the truck: the same model id), and only while both
      // sources are current. Presence and currentness stay v0's.
      const sameEntity = NAMED_FIELDS.has(id) ? job === 'match' : id === 'truck' && sameTruck;
      const named = sameEntity && base.state === 'value' && v1Current ? v1Fields!.get(id)! : undefined;
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
    v0View, ...(v0State ? {v0State} : {}), ...(v1State ? {v1State} : {}), ...(v1View ? {v1View} : {}), v1Carried, v1Current, job,
    paused: v0Current ? v0View.connection.paused : v1Current && !!v1View?.connection.paused,
    field
  };
}
