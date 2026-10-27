import {DEFAULT_OVERLAY_OPACITY} from './overlay-opacity';
import type {OverlayLayout, OverlayPresentation, OverlaySectionId, OverlaySections, OverlaySettings} from '../../../packages/contracts/src';
import {DEFAULT_OVERLAY_PLACEMENTS} from './overlay-placement';

// Overlay layouts, sections, groups and presets (ET-012a). Pure data and validation, without Node built-ins, so main,
// both preloads, both renderers and plain Node tests share one definition.

export const OVERLAY_LAYOUTS: readonly OverlayLayout[] = Object.freeze(['strip', 'card', 'cluster', 'hud']);
/**
 * Canonical order: the settings file, the projection and every layout list sections in this order. A new section is
 * appended last (ET-052's `mandatory-break`), so the settings file's earlier keys keep their positions.
 */
export const OVERLAY_SECTION_IDS: readonly OverlaySectionId[] = Object.freeze(['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo',
  'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income', 'game-time', 'mandatory-break']);

export type OverlayGroupId = 'driving' | 'fuel' | 'job' | 'time';
export interface OverlayGroup {id: OverlayGroupId; sections: readonly OverlaySectionId[]}
/** Groups for the settings card and the strip's dividers; together they list every section once, in canonical order. */
const group = (id: OverlayGroupId, sections: OverlaySectionId[]): OverlayGroup => Object.freeze({id, sections: Object.freeze(sections)});
export const OVERLAY_GROUPS: readonly OverlayGroup[] = Object.freeze([
  group('driving', ['speed', 'gear', 'rpm']),
  group('fuel', ['fuel', 'range', 'sdk-consumption']),
  group('job', ['cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income']),
  group('time', ['game-time', 'mandatory-break'])
]);
/**
 * The sections the cluster's round gauge shows (ET-012a); every other enabled section goes to its side panel. The
 * view model and the cluster's reserved rows (overlay-rows.ts, ET-012d) share this one definition.
 */
export const CLUSTER_GAUGE_SECTIONS: ReadonlySet<OverlaySectionId> = new Set<OverlaySectionId>(['speed', 'gear', 'rpm']);
const GROUP_OF: ReadonlyMap<OverlaySectionId, OverlayGroupId> = new Map(OVERLAY_GROUPS.flatMap(group => group.sections.map(id => [id, group.id] as const)));
export function overlayGroupOf(id: OverlaySectionId): OverlayGroupId {
  return GROUP_OF.get(id)!;
}

function sectionsWith(enabled: readonly OverlaySectionId[]): OverlaySections {
  return Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, enabled.includes(id)])) as Record<OverlaySectionId, boolean>);
}
export const DEFAULT_OVERLAY_SECTIONS: OverlaySections = sectionsWith(OVERLAY_SECTION_IDS);
/** Strip layout with every section and the default placements; the defaults of a new or migrated settings file. */
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = Object.freeze({enabled: true, backgroundOpacity: DEFAULT_OVERLAY_OPACITY, layout: 'strip', sections: DEFAULT_OVERLAY_SECTIONS, placements: DEFAULT_OVERLAY_PLACEMENTS});

export type OverlayPresetId = 'everything' | 'job-focus' | 'driving-only';
/** Complete section records the settings card can apply in one save. */
export const OVERLAY_PRESETS: Readonly<Record<OverlayPresetId, OverlaySections>> = Object.freeze({
  'everything': DEFAULT_OVERLAY_SECTIONS,
  'job-focus': sectionsWith(['speed', 'gear', 'fuel', 'cargo', 'destination', 'distance-remaining', 'deadline']),
  'driving-only': sectionsWith(['speed', 'gear', 'rpm', 'fuel', 'range'])
});
export const OVERLAY_PRESET_IDS: readonly OverlayPresetId[] = Object.freeze(['everything', 'job-focus', 'driving-only']);

/**
 * Why a section may stay hidden in this version. `protocol-v1`: the live bridge carries protocol v0 only, which does not
 * transport the field. `trip-tracking`: distance driven needs trip accounting (ET-014). `ids-until-v1`: v0 carries
 * stable ids, not localized names.
 */
export type OverlayRequirement = 'protocol-v1' | 'trip-tracking' | 'ids-until-v1';
export const OVERLAY_SECTION_REQUIREMENTS: Readonly<Partial<Record<OverlaySectionId, OverlayRequirement>>> = Object.freeze({
  'origin': 'protocol-v1', 'distance-remaining': 'protocol-v1', 'deadline': 'protocol-v1', 'mandatory-break': 'protocol-v1', 'distance-driven': 'trip-tracking',
  'cargo': 'ids-until-v1', 'destination': 'ids-until-v1'
});

export function isOverlayLayout(value: unknown): value is OverlayLayout {
  return typeof value === 'string' && (OVERLAY_LAYOUTS as readonly string[]).includes(value);
}

/**
 * Strictly validates a complete section record from an untrusted caller: a plain object with exactly the fifteen own
 * data properties, booleans only, at least one true. Returns a fresh frozen copy, or undefined. Getters are never run.
 */
export function parseOverlaySections(value: unknown): OverlaySections | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== OVERLAY_SECTION_IDS.length) return undefined;
  const copy = {} as Record<OverlaySectionId, boolean>;
  for (const id of OVERLAY_SECTION_IDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, id);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'boolean') return undefined;
    copy[id] = descriptor.value;
  }
  return OVERLAY_SECTION_IDS.some(id => copy[id]) ? Object.freeze(copy) : undefined;
}

/** True when both records enable the same sections. */
export function sameSections(left: OverlaySections, right: OverlaySections): boolean {
  return OVERLAY_SECTION_IDS.every(id => left[id] === right[id]);
}
export function enabledSectionCount(sections: OverlaySections): number {
  return OVERLAY_SECTION_IDS.filter(id => sections[id]).length;
}

/** A Cluster gauge fraction (ET-045f): a finite number in [0, 1]. */
export function isGaugeFraction(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The projection with only valid gauge fractions (ET-045f): `speedRing` stays only on a current speed value and `ring` only
 * on a current RPM value, each a finite number in [0, 1]; every other copy is removed, and nothing else changes. Returns
 * the same object when nothing is removed, so the overlay preload can apply it to every delivery. A malformed fraction is
 * dropped (no arc) without dropping the update.
 */
export function overlayGauges(presentation: OverlayPresentation): OverlayPresentation {
  const sections: unknown = presentation.sections;
  if (!Array.isArray(sections)) return presentation;
  const current = presentation.freshness === 'current';
  let changed = false;
  const cleaned = (sections as OverlayPresentation['sections']).map(section => {
    if (typeof section !== 'object' || section === null || section.state !== 'value' || !('ring' in section || 'speedRing' in section)) return section;
    const keepSpeed = current && section.id === 'speed' && isGaugeFraction(section.speedRing);
    const keepRing = current && section.id === 'rpm' && isGaugeFraction(section.ring);
    if (('speedRing' in section && !keepSpeed) || ('ring' in section && !keepRing)) {
      changed = true;
      const {ring, speedRing, ...rest} = section;
      return {...rest, ...(keepRing ? {ring} : {}), ...(keepSpeed ? {speedRing} : {})};
    }
    return section;
  });
  return changed ? {...presentation, sections: cleaned} : presentation;
}

/**
 * The projection with only a valid urgency (ET-052 MB7): `urgency` stays only on the `mandatory-break` section in the value
 * state, on a current projection, and only as `soon` or `due`; every other copy is removed, and nothing else changes.
 * Returns the same object when nothing is removed, so the overlay preload can apply it to every delivery. A malformed or
 * misplaced urgency is dropped (no cue, no colour) without dropping the update; the text stays.
 */
export function overlayUrgency(presentation: OverlayPresentation): OverlayPresentation {
  const sections: unknown = presentation.sections;
  if (!Array.isArray(sections)) return presentation;
  const current = presentation.freshness === 'current';
  let changed = false;
  const cleaned = (sections as readonly unknown[]).map(entry => {
    if (typeof entry !== 'object' || entry === null || !('urgency' in entry)) return entry;
    const section = entry as {id?: unknown; state?: unknown; urgency?: unknown};
    if (current && section.id === 'mandatory-break' && section.state === 'value' && (section.urgency === 'soon' || section.urgency === 'due')) return entry;
    changed = true;
    return Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'urgency'));
  }) as OverlayPresentation['sections'];
  return changed ? {...presentation, sections: cleaned} : presentation;
}

/**
 * The overlay preload's view after its quiet deadline: stale, not paused, and every section it was showing becomes an
 * unavailable placeholder. The layout and the displayed units stay, so the overlay neither jumps nor shows old values.
 */
export function staleOverlay(presentation: OverlayPresentation): OverlayPresentation {
  return {...presentation, status: 'stale', freshness: 'stale', paused: false, speed: '—', fuel: '—',
    sections: presentation.sections.map(section => ({id: section.id, state: 'unavailable'}))};
}
