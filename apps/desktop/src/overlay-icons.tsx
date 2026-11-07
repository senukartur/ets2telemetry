import React from 'react';
import {Activity, Banknote, Check, CircleGauge, Clock, Coffee, Cog, Droplet, Flag, Flame, Fuel, Gauge, MapPin, Milestone, Navigation, Package, Pause, Route, Timer, Unplug, X, type LucideIcon} from 'lucide-react';
import type {OverlaySectionId} from '../../../packages/contracts/src';
import type {OverlayHardModeCue, OverlayTagId} from './overlay-view';

// Overlay icons (ET-012a): inline SVG from the pinned lucide-react package. No icon font, no image asset and nothing
// from the dashboard's shadcn components, so the overlay bundle stays isolated from the main window's stylesheet.

export const OVERLAY_SECTION_ICONS: Readonly<Record<OverlaySectionId, LucideIcon>> = Object.freeze({
  'speed': Gauge, 'gear': Cog, 'rpm': Activity, 'cruise-control': CircleGauge, 'fuel': Fuel, 'range': Milestone, 'sdk-consumption': Droplet, 'cargo': Package, 'origin': MapPin,
  'destination': Flag, 'distance-driven': Route, 'distance-remaining': Navigation, 'deadline': Timer, 'expected-income': Banknote, 'game-time': Clock, 'mandatory-break': Coffee
});
const TAG_ICONS: Readonly<Partial<Record<OverlayTagId, LucideIcon>>> = Object.freeze({'paused': Pause, 'no-signal': Unplug});

/** A decorative icon; the section's label carries its meaning. */
export function SectionIcon({id, size = 16}: {id: OverlaySectionId; size?: number}) {
  const Icon = OVERLAY_SECTION_ICONS[id];
  return <Icon className="overlay-icon" size={size} aria-hidden="true" focusable="false" />;
}
/** The Hard Mode indicator's flame (ET-070, D1), decorative like the section icons. */
export function HardModeIcon({size = 16}: {size?: number}) {
  return <Flame className="overlay-icon" size={size} aria-hidden="true" focusable="false" />;
}
/**
 * The indicator's non-colour cue in a fixed 14 px slot: a check when active, a cross when lost and an empty slot of the same
 * width when not active, so a state change never resizes the indicator. Decorative: the accessible name carries the state.
 */
export function HardModeCue({cue}: {cue: OverlayHardModeCue}) {
  const Icon = cue === 'check' ? Check : cue === 'cross' ? X : undefined;
  return <span className="overlay-hm-cue" data-cue={cue} aria-hidden="true">{Icon ? <Icon className="overlay-icon" size={14} aria-hidden="true" focusable="false" /> : null}</span>;
}
export function TagIcon({id}: {id: OverlayTagId}) {
  const Icon = TAG_ICONS[id];
  return Icon ? <Icon className="overlay-icon" size={12} aria-hidden="true" focusable="false" /> : null;
}
