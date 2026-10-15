import type {LiveTelemetry, UnitProfiles} from '../../../packages/contracts/src';
import {resolveDisplayUnits} from '../../../packages/telemetry-core/src/display-profile';
import {buildLiveView, carriesField, type LiveFieldId, type LiveSectionId} from '../../../packages/telemetry-core/src/live-view';
import {normalizeV0State} from '../../../packages/telemetry-core/src/normalize-v0';
import type {MissingReason} from '../../../packages/telemetry-core/src/readings';
import {initialLive} from './live-state';
import {FIELD_NOTE_TEXT, LIVE_FIELD_TEXT, LIVE_SECTION_TEXT, STRINGS, VIEW_REASON_TEXT} from './strings';
import {DEFAULT_UNIT_PROFILES, displayGame, profileFor} from './unit-profiles';

// Text of the live telemetry card (ET-010b): telemetry-core's view model with the application's labels, reasons and
// notes. Pure, safe for renderer bundles and plain Node tests; formatting and conversion stay in telemetry-core.

/**
 * Speed and fuel keep their existing dashboard paragraphs (`Speed: …`, `Fuel: …`), which the overlay, smokes and
 * settings already depend on, so the card does not repeat them (ET-010b decision B1).
 */
export const LEGACY_ROW_IDS: ReadonlySet<LiveFieldId> = new Set<LiveFieldId>(['speed', 'fuel']);

export interface LiveRowText {
  id: LiveFieldId;
  testId: `live-${LiveFieldId}`;
  label: string;
  /** The formatted value, `unavailable` or `none`. */
  value: string;
  /** Why the value is `unavailable` or `none`. */
  reason?: string;
  /** Context for the label, such as "SDK mean, not a trip average". */
  note?: string;
}
export interface LiveSectionText {
  id: LiveSectionId;
  testId: `live-section-${LiveSectionId}`;
  title: string;
  /** Set when the section's subject is absent while current, such as no job reported. */
  missing?: string;
  rows: LiveRowText[];
}
export interface LiveDashboardText {paused: boolean; sections: LiveSectionText[]}

/**
 * Builds the card text for one bridge update. The units follow the same rule as the speed and fuel lines: the displayed
 * game's profile, or metric without a game. The bridge carries protocol v0 only; ET-010c adds v1. Rows the protocol does
 * not carry or that do not apply are not rendered, and a section without rows or a missing subject is omitted. Before
 * the first observation telemetry-core knows no protocol and reports every field as not current; the card still shows
 * only the fields v0 carries, so the Position section never appears under v0.
 */
export function liveDashboardText(live: LiveTelemetry | undefined, units: UnitProfiles = DEFAULT_UNIT_PROFILES): LiveDashboardText {
  const telemetry = live ?? initialLive();
  const state = telemetry.observation ? normalizeV0State(telemetry.observation.state) : undefined;
  const game = displayGame(telemetry);
  const view = buildLiveView(telemetry, state, resolveDisplayUnits(game, {profile: profileFor(units, game)}));
  const sections: LiveSectionText[] = [];
  for (const section of view.sections) {
    const rows: LiveRowText[] = [];
    for (const field of section.fields) {
      if (field.state === 'hidden' || LEGACY_ROW_IDS.has(field.id) || (!state && !carriesField('v0', field.id))) continue;
      const reason = (field.state === 'missing' || field.state === 'absent') && field.reason ? VIEW_REASON_TEXT[field.reason] : undefined;
      const note = field.notes?.length ? field.notes.map(id => FIELD_NOTE_TEXT[id]).join('; ') : undefined;
      rows.push({id: field.id, testId: `live-${field.id}`, label: LIVE_FIELD_TEXT[field.id], value: field.text,
        ...(reason ? {reason} : {}), ...(note ? {note} : {})});
    }
    if (!rows.length && !section.missing) continue;
    sections.push({id: section.id, testId: `live-section-${section.id}`, title: LIVE_SECTION_TEXT[section.id],
      ...(section.missing ? {missing: missingSubjectText(section.missing)} : {}), rows});
  }
  return {paused: view.connection.paused, sections};
}

/**
 * Only a job that was never reported reads as "No job reported". A job reading that was rejected or is not provided
 * keeps its reason, so the card never presents an unavailable job as the absence of a job.
 */
function missingSubjectText(reason: MissingReason): string {
  return reason === 'not-observed' ? STRINGS.liveNoJob : `${STRINGS.liveJobUnavailable} (${VIEW_REASON_TEXT[reason]})`;
}
