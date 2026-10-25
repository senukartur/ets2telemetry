import type {AppLanguage, GearDisplayModes, LiveTelemetry, UnitProfiles} from '../../../packages/contracts/src';
import {resolveDisplayUnits} from '../../../packages/telemetry-core/src/display-profile';
import type {LiveField, LiveFieldId, LiveSectionId} from '../../../packages/telemetry-core/src/live-view';
import type {MissingReason} from '../../../packages/telemetry-core/src/readings';
import {liveSources} from './live-sources';
import {initialLive} from './live-state';
import * as BASE_COPY from './strings';
import {appCopy, copyTable, localizedMeasurement} from './screens/app-copy';
import {DEFAULT_UNIT_PROFILES, displayGame, gearDisplayFor, profileFor} from './unit-profiles';

// Text of the live telemetry card (ET-010b, protocol v1 fields ET-010c): telemetry-core's view model with the
// application's labels, reasons and notes. Pure, safe for renderer bundles and plain Node tests; formatting and
// conversion stay in telemetry-core.

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
/** `source`: the protocol v1 source section (ET-010c decision F5). */
export type LiveSectionTextId = LiveSectionId | 'source';
export interface LiveSectionText {
  id: LiveSectionTextId;
  testId: `live-section-${LiveSectionTextId}`;
  title: string;
  /** Set when the section's subject is absent while current, such as no job reported. */
  missing?: string;
  /** The protocol v1 source's `status: reason` line; only the source section has one. */
  status?: string;
  rows: LiveRowText[];
}
export interface LiveDashboardText {paused: boolean; sections: LiveSectionText[]}

/**
 * Translate generated absence copy before applying the SDK-name exclusion. A known SDK job market value shows its label
 * (ET-045a); an unknown one stays verbatim.
 */
export function liveFieldValue(field: LiveField, language: AppLanguage): string {
  if (field.state === 'value' && field.id === 'market') return BASE_COPY.getJobMarketText(field.text, language);
  return field.state === 'value' ? ((field.id === 'special-job' || field.id === 'cargo-loaded') ? field.text === 'yes' ? (language === 'ru' ? 'да' : 'yes') : (language === 'ru' ? 'нет' : 'no') : ['cargo', 'source-city', 'source-company', 'destination-city', 'destination-company', 'truck', 'truck-plate', 'trailers', 'game-mode'].includes(field.id) ? field.text : localizedMeasurement(field.text, language)) : appCopy(field.text, language);
}

function createLiveText(language: AppLanguage) {
 const {FIELD_NOTE_TEXT, LIVE_FIELD_TEXT, LIVE_SECTION_TEXT, STRINGS, VIEW_REASON_TEXT} = copyTable(BASE_COPY, language);
function rowText(field: LiveField, extraNote?: string): LiveRowText {
  const reason = (field.state === 'missing' || field.state === 'absent') && field.reason ? VIEW_REASON_TEXT[field.reason] : undefined;
  const notes = [...(field.notes ?? []).map(id => FIELD_NOTE_TEXT[id]), ...(extraNote ? [extraNote] : [])];
  const note = notes.length ? notes.join('; ') : undefined;
  return {id: field.id, testId: `live-${field.id}`, label: LIVE_FIELD_TEXT[field.id], value: liveFieldValue(field, language), ...(reason ? {reason} : {}), ...(note ? {note} : {})};
}

/**
 * Builds the card text for one bridge update. The units follow the same rule as the speed and fuel lines: the displayed
 * game's profile, or metric without a game. Every row has one source (ET-010c decision F4): rows protocol v0 carries
 * come from the v0 observation, the rest from the v1 projection under v1's own freshness, through the combiner in
 * live-sources.ts. Rows no protocol carries or that do not apply are not rendered, and a section without rows or a
 * missing subject is omitted. Before the first observation telemetry-core knows no protocol and reports every field as
 * not current; without v1 the card shows only the fields v0 carries, so the Position section never appears under v0.
 * The Protocol v1 source section appears once a v1 observation exists for the current selection.
 */
function liveDashboardText(live: LiveTelemetry | undefined, units: UnitProfiles = DEFAULT_UNIT_PROFILES, gearDisplay?: GearDisplayModes): LiveDashboardText {
  const telemetry = live ?? initialLive();
  const game = displayGame(telemetry);
  // ET-050: the gear row follows the displayed game's gear display mode, automatic without a game or settings.
  const sources = liveSources(telemetry, resolveDisplayUnits(game, {profile: profileFor(units, game)}), gearDisplayFor(gearDisplay, game));
  const sections: LiveSectionText[] = [];
  for (const section of sources.v0View.sections) {
    const rows: LiveRowText[] = [];
    for (const {id} of section.fields) {
      const field = sources.field(id);
      if (field.state === 'hidden' || LEGACY_ROW_IDS.has(id)) continue;
      rows.push(rowText(field));
    }
    if (!rows.length && !section.missing) continue;
    sections.push({id: section.id, testId: `live-section-${section.id}`, title: LIVE_SECTION_TEXT[section.id],
      ...(section.missing ? {missing: missingSubjectText(section.missing)} : {}), rows});
  }
  if (sources.v1Carried && telemetry.v1) {
    const rows = [rowText(sources.field('game-mode')), rowText(sources.field('event-loss'), STRINGS.liveEventLossNote)];
    sections.push({id: 'source', testId: 'live-section-source', title: STRINGS.liveSourceTitle, status: `${telemetry.v1.status}: ${telemetry.v1.reason}`, rows});
  }
  return {paused: sources.paused, sections};
}

/**
 * Only a job that was never reported reads as "No job reported". A job reading that was rejected or is not provided
 * keeps its reason, so the card never presents an unavailable job as the absence of a job.
 */
function missingSubjectText(reason: MissingReason): string {
  return reason === 'not-observed' ? STRINGS.liveNoJob : `${STRINGS.liveJobUnavailable} (${VIEW_REASON_TEXT[reason]})`;
}

 return liveDashboardText;
}
const builders = {en: createLiveText('en'), ru: createLiveText('ru')};
export const liveDashboardText = (live: LiveTelemetry | undefined, units: UnitProfiles = DEFAULT_UNIT_PROFILES, language: AppLanguage = 'en',
  gearDisplay?: GearDisplayModes): LiveDashboardText => builders[language](live, units, gearDisplay);
