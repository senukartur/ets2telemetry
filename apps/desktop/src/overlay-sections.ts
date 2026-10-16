import type {OverlayLayout, OverlayPresentation, OverlaySectionId, OverlaySections, OverlaySettings} from '../../../packages/contracts/src';
import {DEFAULT_OVERLAY_PLACEMENTS} from './overlay-placement';

// Overlay layouts, sections, groups and presets (ET-012a). Pure data and validation, without Node built-ins, so main,
// both preloads, both renderers and plain Node tests share one definition.

export const OVERLAY_LAYOUTS: readonly OverlayLayout[] = Object.freeze(['strip', 'card', 'cluster', 'hud']);
/** Canonical order: the settings file, the projection and every layout list sections in this order. */
export const OVERLAY_SECTION_IDS: readonly OverlaySectionId[] = Object.freeze(['speed', 'gear', 'rpm', 'fuel', 'range', 'sdk-consumption', 'cargo',
  'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income', 'game-time']);

export type OverlayGroupId = 'driving' | 'fuel' | 'job' | 'time';
export interface OverlayGroup {id: OverlayGroupId; sections: readonly OverlaySectionId[]}
/** Groups for the settings card and the strip's dividers; together they list every section once, in canonical order. */
const group = (id: OverlayGroupId, sections: OverlaySectionId[]): OverlayGroup => Object.freeze({id, sections: Object.freeze(sections)});
export const OVERLAY_GROUPS: readonly OverlayGroup[] = Object.freeze([
  group('driving', ['speed', 'gear', 'rpm']),
  group('fuel', ['fuel', 'range', 'sdk-consumption']),
  group('job', ['cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income']),
  group('time', ['game-time'])
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
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = Object.freeze({layout: 'strip', sections: DEFAULT_OVERLAY_SECTIONS, placements: DEFAULT_OVERLAY_PLACEMENTS});

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
  'origin': 'protocol-v1', 'distance-remaining': 'protocol-v1', 'deadline': 'protocol-v1', 'distance-driven': 'trip-tracking',
  'cargo': 'ids-until-v1', 'destination': 'ids-until-v1'
});

export function isOverlayLayout(value: unknown): value is OverlayLayout {
  return typeof value === 'string' && (OVERLAY_LAYOUTS as readonly string[]).includes(value);
}

/**
 * Strictly validates a complete section record from an untrusted caller: a plain object with exactly the fourteen own
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

/**
 * The overlay preload's view after its quiet deadline: stale, not paused, and every section it was showing becomes an
 * unavailable placeholder. The layout and the displayed units stay, so the overlay neither jumps nor shows old values.
 */
export function staleOverlay(presentation: OverlayPresentation): OverlayPresentation {
  return {...presentation, status: 'stale', freshness: 'stale', paused: false, speed: '—', fuel: '—',
    sections: presentation.sections.map(section => ({id: section.id, state: 'unavailable'}))};
}
