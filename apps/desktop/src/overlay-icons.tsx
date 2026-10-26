import React from 'react';
import {Activity, Banknote, Clock, Coffee, Cog, Droplet, Flag, Fuel, Gauge, MapPin, Milestone, Navigation, Package, Pause, Route, Timer, Unplug, type LucideIcon} from 'lucide-react';
import type {OverlaySectionId} from '../../../packages/contracts/src';
import type {OverlayTagId} from './overlay-view';

// Overlay icons (ET-012a): inline SVG from the pinned lucide-react package. No icon font, no image asset and nothing
// from the dashboard's shadcn components, so the overlay bundle stays isolated from the main window's stylesheet.

export const OVERLAY_SECTION_ICONS: Readonly<Record<OverlaySectionId, LucideIcon>> = Object.freeze({
  'speed': Gauge, 'gear': Cog, 'rpm': Activity, 'fuel': Fuel, 'range': Milestone, 'sdk-consumption': Droplet, 'cargo': Package, 'origin': MapPin,
  'destination': Flag, 'distance-driven': Route, 'distance-remaining': Navigation, 'deadline': Timer, 'expected-income': Banknote, 'game-time': Clock, 'mandatory-break': Coffee
});
const TAG_ICONS: Readonly<Partial<Record<OverlayTagId, LucideIcon>>> = Object.freeze({'paused': Pause, 'no-signal': Unplug});

/** A decorative icon; the section's label carries its meaning. */
export function SectionIcon({id, size = 16}: {id: OverlaySectionId; size?: number}) {
  const Icon = OVERLAY_SECTION_ICONS[id];
  return <Icon className="overlay-icon" size={size} aria-hidden="true" focusable="false" />;
}
export function TagIcon({id}: {id: OverlayTagId}) {
  const Icon = TAG_ICONS[id];
  return Icon ? <Icon className="overlay-icon" size={12} aria-hidden="true" focusable="false" /> : null;
}
