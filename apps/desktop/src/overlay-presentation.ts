import type {LiveTelemetry, OverlayPresentation, OverlaySectionId, OverlaySectionView, OverlaySettings, UnitProfiles} from '../../../packages/contracts/src';
import {resolveDisplayUnits} from '../../../packages/telemetry-core/src/display-profile';
import {carriesField, type LiveFieldId} from '../../../packages/telemetry-core/src/live-view';
import {liveSources, V1_JOB_FIELDS} from './live-sources';
import {DEFAULT_OVERLAY_SETTINGS, OVERLAY_SECTION_IDS} from './overlay-sections';
import {DEFAULT_UNIT_PROFILES, displayGame, isExplicitFixture, profileFor, speedNumber, speedUnit, volumeNumber, volumeUnit} from './unit-profiles';

/** Full scale of the engine RPM ring (ET-012a decision L12). Neither v0 nor v1 carries the SDK's `rpm.limit`. */
export const RPM_RING_FULL_SCALE = 3000;

/**
 * The telemetry-core fields behind each overlay section: `parts` are joined with ", " into the section text, `detail`
 * is a secondary value. Distance driven has no field: it needs trip accounting (ET-014), and the odometer is never used
 * as a stand-in (REG-008).
 */
const SECTION_FIELDS: Readonly<Record<OverlaySectionId, {parts: readonly LiveFieldId[]; detail?: LiveFieldId}>> = Object.freeze({
  'speed': {parts: ['speed']},
  'gear': {parts: ['gear']},
  'rpm': {parts: ['engine-rpm']},
  'fuel': {parts: ['fuel'], detail: 'fuel-level'},
  'range': {parts: ['estimated-range']},
  'sdk-consumption': {parts: ['sdk-average-consumption']},
  'cargo': {parts: ['cargo'], detail: 'cargo-mass'},
  'origin': {parts: ['source-city', 'source-company']},
  'destination': {parts: ['destination-city', 'destination-company']},
  'distance-driven': {parts: []},
  'distance-remaining': {parts: ['route-remaining']},
  'deadline': {parts: ['deadline']},
  'expected-income': {parts: ['expected-income']},
  'game-time': {parts: ['game-time']}
});
/** The ET-008 baseline sections keep a visible dash while current without data (REG-009: unavailable is not zero). */
const BASELINE_SECTIONS: ReadonlySet<OverlaySectionId> = new Set<OverlaySectionId>(['speed', 'fuel']);

/**
 * The overlay's read-only display projection, built in main. Canonical v0 m/s and liters remain unchanged; values are
 * formatted by telemetry-core in the persisted profile of the displayed game (ETS2 metric and ATS US customary by
 * default; metric without a game), exactly as the dashboard's live telemetry card formats them.
 *
 * Section rules (ET-012a decisions L5 and L6): a disabled section, or one whose fields the protocol in use does not
 * carry, is left out. While current a section with a value shows it; one without data is left out, except speed and
 * fuel, which stay `unavailable`. While not current (stale, no signal, disconnected or an origin/game mismatch) the
 * overlay keeps the shape of `previous`, the projection main published last: each remaining section it showed, plus
 * speed and fuel, becomes `unavailable`, so the layout does not jump and no stale value looks current. Sections that
 * were hidden stay hidden until the data is current again, as in the overlay preload's own expiry (`staleOverlay`).
 *
 * Protocol v1 (ET-010c decision F7): parts v0 does not carry come from the v1 projection through the same combiner as
 * the dashboard card (live-sources.ts). The overall state stays v0's, and a v1 part has a value only while the v0 data
 * is current, the v1 data is current and, for job parts, both describe the same job. A section shown before whose v1
 * data is no longer eligible becomes `unavailable`; one never shown stays out; a mixed section keeps its v0 part. v1
 * never authorizes placement or visibility: main places the overlay from the v0 observation's window only.
 *
 * `editing` (ET-012b) only marks the overlay edit mode for the renderer; it changes no section or value.
 */
export function overlayPresentation(live: LiveTelemetry, units: UnitProfiles = DEFAULT_UNIT_PROFILES, overlay: OverlaySettings = DEFAULT_OVERLAY_SETTINGS,
  previous?: OverlayPresentation, editing = false): OverlayPresentation {
  const observation = live.observation;
  const explicitFixture = isExplicitFixture(live);
  const game = displayGame(live), profile = profileFor(units, game);
  const current = live.fresh && (live.status === 'connected' || live.status === 'paused') &&
    (explicitFixture || (observation?.source.origin === 'game' && observation.source.game === live.selection));
  const state = observation?.state;
  const sources = liveSources(live, resolveDisplayUnits(game, {profile}));
  const valueOf = (id: LiveFieldId) => {const field = sources.field(id); return field.state === 'value' ? field.text : undefined;};
  // A part protocol v0 does not carry needs a v1 observation of this selection and origin (decision F7).
  const carried = (part: LiveFieldId) => carriesField('v0', part) || sources.v1Carried;
  // A v1 part that would have a value were v1 current and, for the job, the same job as v0's. Without a v0 job the job
  // parts have no data, so their section is left out rather than kept as a dash.
  const ineligible = (part: LiveFieldId) => !carriesField('v0', part) &&
    (V1_JOB_FIELDS.has(part) ? sources.job === 'mismatch' || (sources.job === 'match' && !sources.v1Current) : !sources.v1Current);
  const shown = new Set<OverlaySectionId>(previous?.sections.map(section => section.id) ?? []);
  const sections: OverlaySectionView[] = [];
  for (const id of OVERLAY_SECTION_IDS) {
    const {parts, detail} = SECTION_FIELDS[id];
    if (!overlay.sections[id] || !parts.some(carried)) continue;
    if (!current) {
      if (shown.has(id) || BASELINE_SECTIONS.has(id)) sections.push({id, state: 'unavailable'});
      continue;
    }
    const texts = parts.map(valueOf).filter((text): text is string => text !== undefined);
    if (!texts.length) {
      // A section shown before keeps a dash while its v1 data is not current or describes another job.
      if (BASELINE_SECTIONS.has(id) || (shown.has(id) && parts.some(ineligible))) sections.push({id, state: 'unavailable'});
      continue;
    }
    const detailText = detail ? valueOf(detail) : undefined;
    const rpm = sources.v0State?.engineRpm;
    const ring = id === 'rpm' && rpm?.state === 'value' && Number.isFinite(rpm.value) ? Math.min(1, Math.max(0, rpm.value / RPM_RING_FULL_SCALE)) : undefined;
    sections.push({id, state: 'value', text: texts.join(', '), ...(detailText ? {detail: detailText} : {}), ...(ring === undefined ? {} : {ring})});
  }
  return {
    source: game === 'ats' ? 'ATS' : game === 'ets2' ? 'ETS2' : 'No game', origin: observation?.source.origin ?? 'none', status: live.status,
    speed: current && state?.speed.available ? speedNumber(state.speed.value, profile) : '—',
    speedUnit: speedUnit(profile),
    fuel: current && state?.fuel.available ? volumeNumber(state.fuel.value, profile) : '—',
    fuelUnit: volumeUnit(profile),
    freshness: current ? 'current' : live.status === 'stale' ? 'stale' : 'unavailable',
    layout: overlay.layout,
    paused: current && sources.v0View.connection.paused,
    sections,
    editing
  };
}
