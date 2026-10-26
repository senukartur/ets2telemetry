import type {AppLanguage, OverlayLayout, OverlayPresentation, OverlaySectionId, OverlayUrgency} from '../../../packages/contracts/src';
import {DEFAULT_OVERLAY_OPACITY, isOverlayOpacity} from './overlay-opacity';
import {CARD_ROW_HEIGHT_CSS} from './overlay-rows';
import {localizedMeasurement} from './screens/app-copy';
import {CLUSTER_GAUGE_SECTIONS, OVERLAY_GROUPS, type OverlayGroupId} from './overlay-sections';
import {getOverlaySectionShortText, getOverlaySectionText, getStrings} from './strings';
import {localizeDeadlineString, localizeGameTimeString, translateUnit} from './i18n';

// Pure renderer view model. Main/telemetry-core own numeric conversion and rounding; this view arranges their text
// and localizes known app-owned units, deadlines, clocks and provenance notes. It never reparses numbers or SDK names.
// formatter-localization.test.ts binds these localization paths to real formatter output; unit-profiles.test.ts guards
// against duplicated numeric conversion constants and rounding here.

export interface OverlayItem {
  id: OverlaySectionId;
  testId: `overlay-${OverlaySectionId}`;
  /** Full label for the card layout. */
  label: string;
  /** Short label for the strip, cluster panel and HUD. */
  short: string;
  /** The formatted text, or a dash while unavailable. Speed, fuel and RPM hold the number only; `unit` holds the unit. */
  value: string;
  unit?: string;
  /**
   * Widest value text the strip reserves for this section (ET-045d), so a value change such as 99 to 100 never resizes the
   * section or moves its neighbours. Rendered invisibly; set only for speed, gear and RPM.
   */
  reserve?: string;
  detail?: string;
  detailTestId?: string;
  /** Engine RPM ring fraction in [0, 1]. */
  ring?: number;
  /** Speed arc fraction in [0, 1] on the speed gauge scale (ET-045f); set only on an available speed. */
  speedRing?: number;
  /**
   * The next mandatory break's urgency (ET-052): the renderer marks the item with it (a colour token, an underline when
   * due, `data-urgency`) and `urgencyName` is the state word appended to the item's accessible name (for assistive
   * technology; the visible cues are the colour and, when due, the underline). Set only on the `mandatory-break` item while it shows a value.
   */
  urgency?: OverlayUrgency;
  urgencyName?: string;
  unavailable: boolean;
}
export type OverlayTagId = 'paused' | 'no-signal' | 'stale' | 'origin';
export interface OverlayTag {id: OverlayTagId; testId: `overlay-tag-${OverlayTagId}`; text: string}
export interface OverlayItemGroup {id: OverlayGroupId; items: OverlayItem[]}
export interface OverlayView {
  layout: OverlayLayout;
  source: OverlayPresentation['source'];
  origin: OverlayPresentation['origin'];
  status: OverlayPresentation['status'];
  freshness: OverlayPresentation['freshness'];
  paused: boolean;
  /** Not current: placeholders and icons are dimmed. Values are never kept, so nothing dimmed is a last-known value. */
  dim: boolean;
  tags: OverlayTag[];
  items: OverlayItem[];
  /** Groups with at least one item, in order; the strip draws a divider between neighbours. */
  groups: OverlayItemGroup[];
  /** Cluster gauge parts; set only when speed, gear or RPM is shown. */
  gauge?: {speed?: OverlayItem; gear?: OverlayItem; rpm?: OverlayItem};
  /** Items outside the cluster gauge, in order. */
  panel: OverlayItem[];
  /** The overlay edit mode (ET-012b): the renderer outlines the overlay and makes it a drag region. */
  editing: boolean;
  contentAnchorY: number;
  backgroundOpacity: number;
}

/** What the overlay shows before main's first delivery: no signal, no sections. */
export const OVERLAY_PLACEHOLDER: OverlayPresentation = Object.freeze({source: 'No game', origin: 'none', status: 'waiting', speed: '—', speedUnit: 'km/h',
  fuel: '—', fuelUnit: 'L', freshness: 'unavailable', layout: 'strip', paused: false, sections: Object.freeze([]), editing: false, language: 'en'});
const DASH = '—';
/**
 * ET-052: the longest expected break text, "00 h 00 min" in the viewer's language, in the strip's CSS reserve like the other
 * stable widths (ET-045d), so a value change such as "9 min" to "1 h 05 min" never resizes the section. It is built with
 * the same localization as the value, so the Russian "ч" and "мин" are never under-reserved.
 */
const BREAK_RESERVE = '00 h 00 min';
const reserveFor = (id: OverlaySectionId, language: AppLanguage): string | undefined =>
  id === 'mandatory-break' ? localizeDeadlineString(BREAK_RESERVE, language) : VALUE_RESERVES[id];
/**
 * Stable value widths of the strip (ET-045d W1): a three-digit speed, a reverse gear with one digit ("R0" is wider than
 * "00" in Onest's tabular figures) and a four-digit RPM. A wider value grows under the section's cap and ellipsis.
 * ET-050 (GD6): the gear reserve does not depend on the gear display mode. It lists the reverse form and both manual
 * range-splitter forms on separate lines ("R0", "0H", "0L"), and the strip's CSS reserves the widest line, so switching
 * modes or shifting between 1L and 1H never resizes the section. Window sizes and the row model are unchanged.
 * ET-050b (B8) adds the gearbox-aware crawler labels "LH" and "LL" as two more lines, so a crawler gear never widens the
 * section either; the 90 px cap, row heights and window sizes stay the same. The ETS2 crawler labels "C1" and "C2"
 * (B5 as amended on October 26, 2026) are two more lines.
 */
const VALUE_RESERVES: Partial<Record<OverlaySectionId, string>> = {speed: '000', gear: 'R0\n0H\n0L\nLH\nLL\nC1\nC2', rpm: '0000'};
/** telemetry-core's formatRpm always ends in this suffix; only that exact form is split into number and unit. */
const RPM_SUFFIX = ' rpm';
/** Old projections retain their layout anchor; malformed provided values never become CSS/native coordinates. */
export function contentAnchorY(presentation: Pick<OverlayPresentation, 'layout' | 'contentAnchorY'>): number {
  const value = presentation.contentAnchorY;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : presentation.layout === 'cluster' ? 1 : 0;
}

export function overlayView(presentation: OverlayPresentation = OVERLAY_PLACEHOLDER): OverlayView {
  const language = presentation.language ?? 'en';
  const strings = getStrings(language);
  const items = presentation.sections.map((section): OverlayItem => {
    const available = section.state === 'value';
    const base = {
      id: section.id,
      testId: `overlay-${section.id}` as const,
      label: getOverlaySectionText(section.id, language),
      short: getOverlaySectionShortText(section.id, language),
      unavailable: !available,
      ...(reserveFor(section.id, language) ? {reserve: reserveFor(section.id, language)} : {})
    };
    // Speed and fuel keep the separate number and unit of the ET-008 smoke contract; the unit stays visible beside a dash.
    if (section.id === 'speed') return {...base, value: available ? presentation.speed : DASH, unit: translateUnit(presentation.speedUnit, language),
      ...(available && section.speedRing !== undefined ? {speedRing: section.speedRing} : {})};
    if (section.id === 'fuel') return {...base, value: available ? presentation.fuel : DASH, unit: translateUnit(language === 'ru' && presentation.fuelUnit === 'US gal' ? 'gal' : presentation.fuelUnit, language),
      ...(available && section.detail ? {detail: section.detail, detailTestId: 'overlay-fuel-level'} : {})};
    // ET-045d (W2): the RPM number and its unit are separate like speed and fuel, so the strip can reserve the number's
    // width and the cluster can size the unit apart. Only the fixed suffix is split; no number is parsed.
    if (section.id === 'rpm') {
      if (!available) return {...base, value: DASH, unit: translateUnit('rpm', language)};
      const ring = section.ring !== undefined ? {ring: section.ring} : {};
      return section.text.endsWith(RPM_SUFFIX) ? {...base, value: section.text.slice(0, -RPM_SUFFIX.length), unit: translateUnit('rpm', language), ...ring}
        : {...base, value: section.text, ...ring};
    }
    let value = available ? section.text : DASH;
    if (available) {
      if (section.id === 'game-time') {
        value = localizeGameTimeString(value, language);
      } else if (section.id === 'deadline' || section.id === 'mandatory-break') {
        value = localizeDeadlineString(value, language);
      } else if (['sdk-consumption', 'range', 'distance-driven', 'distance-remaining', 'expected-income'].includes(section.id)) {
        value = localizedMeasurement(value, language);
      }
    }
    // ET-052: the validated urgency (the overlay preload strips any other) and the state word for the accessible name.
    const urgency = available && section.id === 'mandatory-break' && (section.urgency === 'soon' || section.urgency === 'due') ? section.urgency : undefined;
    // Cargo detail is the numeric cargo-mass field (SECTION_FIELDS); name/company details retain SDK bytes.
    return {...base, value,
      ...(urgency ? {urgency, urgencyName: urgency === 'due' ? strings.overlayBreakDue : strings.overlayBreakSoon} : {}),
      ...(available && section.detail ? {detail: section.id === 'cargo' ? localizedMeasurement(section.detail, language) : section.detail, detailTestId: `overlay-${section.id}-detail`} : {}),
      ...(available && section.ring !== undefined ? {ring: section.ring} : {})};
  });
  const byId = new Map(items.map(item => [item.id, item]));
  const groups = OVERLAY_GROUPS.map(group => ({id: group.id, items: group.sections.flatMap(id => byId.get(id) ?? [])})).filter(group => group.items.length > 0);
  const gaugeShown = items.some(item => CLUSTER_GAUGE_SECTIONS.has(item.id));
  const tags: OverlayTag[] = [];
  if (presentation.freshness === 'stale') tags.push({id: 'stale', testId: 'overlay-tag-stale', text: strings.overlayStale});
  else if (presentation.freshness === 'unavailable') tags.push({id: 'no-signal', testId: 'overlay-tag-no-signal', text: strings.overlayNoSignal});
  else if (presentation.paused) tags.push({id: 'paused', testId: 'overlay-tag-paused', text: strings.overlayPaused});
  if (presentation.origin === 'synthetic' || presentation.origin === 'replay')
    tags.push({id: 'origin', testId: 'overlay-tag-origin', text: presentation.origin === 'synthetic' ? strings.overlaySynthetic : strings.overlayReplay});
  return {
    layout: presentation.layout, source: presentation.source, origin: presentation.origin, status: presentation.status, freshness: presentation.freshness,
    paused: presentation.paused, dim: presentation.freshness !== 'current', tags, items, groups,
    ...(gaugeShown ? {gauge: {speed: byId.get('speed'), gear: byId.get('gear'), rpm: byId.get('rpm')}} : {}),
    panel: gaugeShown ? items.filter(item => !CLUSTER_GAUGE_SECTIONS.has(item.id)) : items,
    backgroundOpacity: isOverlayOpacity(presentation.backgroundOpacity) ? presentation.backgroundOpacity : DEFAULT_OVERLAY_OPACITY,
    editing: presentation.editing === true, contentAnchorY: contentAnchorY(presentation)
  };
}

/** Card hierarchy uses precisely the existing reserved rows, including every subset of speed/gear/RPM. */
export function overlayCardParts(view: Pick<OverlayView, 'items'>) {
  const hero = view.items.filter(item => CLUSTER_GAUGE_SECTIONS.has(item.id));
  return {hero, rows: view.items.filter(item => !CLUSTER_GAUGE_SECTIONS.has(item.id)), heroHeight: hero.length * CARD_ROW_HEIGHT_CSS};
}
