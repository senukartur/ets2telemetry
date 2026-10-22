import type {OverlayLayout, OverlayPresentation, OverlaySectionId} from '../../../packages/contracts/src';
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
  /** The formatted text, or a dash while unavailable. Speed and fuel hold the number only; `unit` holds the unit. */
  value: string;
  unit?: string;
  detail?: string;
  detailTestId?: string;
  /** Context that must stay beside the value, such as "SDK mean" (never a trip average). */
  caption?: string;
  /** Engine RPM ring fraction in [0, 1]. */
  ring?: number;
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
}

/** What the overlay shows before main's first delivery: no signal, no sections. */
export const OVERLAY_PLACEHOLDER: OverlayPresentation = Object.freeze({source: 'No game', origin: 'none', status: 'waiting', speed: '—', speedUnit: 'km/h',
  fuel: '—', fuelUnit: 'L', freshness: 'unavailable', layout: 'strip', paused: false, sections: Object.freeze([]), editing: false, language: 'en'});
const DASH = '—';
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
      unavailable: !available
    };
    // Speed and fuel keep the separate number and unit of the ET-008 smoke contract; the unit stays visible beside a dash.
    if (section.id === 'speed') return {...base, value: available ? presentation.speed : DASH, unit: translateUnit(presentation.speedUnit, language)};
    if (section.id === 'fuel') return {...base, value: available ? presentation.fuel : DASH, unit: translateUnit(language === 'ru' && presentation.fuelUnit === 'US gal' ? 'gal' : presentation.fuelUnit, language),
      ...(available && section.detail ? {detail: section.detail, detailTestId: 'overlay-fuel-level'} : {})};
    let value = available ? section.text : DASH;
    if (available) {
      if (section.id === 'game-time') {
        value = localizeGameTimeString(value, language);
      } else if (section.id === 'deadline') {
        value = localizeDeadlineString(value, language);
      } else if (['rpm', 'sdk-consumption', 'range', 'distance-driven', 'distance-remaining', 'expected-income'].includes(section.id)) {
        value = localizedMeasurement(value, language);
      }
    }
    // Cargo detail is the numeric cargo-mass field (SECTION_FIELDS); name/company details retain SDK bytes.
    return {...base, value,
      ...(available && section.detail ? {detail: section.id === 'cargo' ? localizedMeasurement(section.detail, language) : section.detail, detailTestId: `overlay-${section.id}-detail`} : {}),
      ...(available && section.ring !== undefined ? {ring: section.ring} : {}),
      ...(section.id === 'sdk-consumption' ? {caption: strings.overlaySdkMean} : {})};
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
    editing: presentation.editing === true, contentAnchorY: contentAnchorY(presentation)
  };
}

/** Card hierarchy uses precisely the existing reserved rows, including every subset of speed/gear/RPM. */
export function overlayCardParts(view: Pick<OverlayView, 'items'>) {
  const hero = view.items.filter(item => CLUSTER_GAUGE_SECTIONS.has(item.id));
  return {hero, rows: view.items.filter(item => !CLUSTER_GAUGE_SECTIONS.has(item.id)), heroHeight: hero.length * CARD_ROW_HEIGHT_CSS};
}
