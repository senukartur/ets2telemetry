import type {AppLanguage, OverlayPresentation, OverlaySectionId, OverlaySectionView, OverlaySettings} from '../../../packages/contracts/src';
import {CRUISE_CONTROL_OFF} from '../../../packages/telemetry-core/src/cruise-control';
import {OVERLAY_NOMINAL_SIZE} from './overlay-geometry';
import {overlayZoom} from './overlay-placement';
import {CLUSTER_GAUGE_SIZE_CSS, layoutReservedCss} from './overlay-rows';
import {OVERLAY_SECTION_IDS} from './overlay-sections';
import {stripCssHeight, stripRowCount, STRIP_ITEM_MAX_WIDTH_CSS, STRIP_PADDING_X_CSS} from './overlay-strip';

export type ExampleCruiseState = 'active' | 'off' | 'unavailable';

/** Invented display data only: this module accepts settings, never telemetry or application state. */
export function overlayExample(settings: OverlaySettings, language: AppLanguage, cruise: ExampleCruiseState): OverlayPresentation {
  const examples: Record<OverlaySectionId, OverlaySectionView> = {
    speed: {id: 'speed', state: 'value', text: '84 km/h', speedRing: 0.56},
    gear: {id: 'gear', state: 'value', text: '12'},
    rpm: {id: 'rpm', state: 'value', text: '1420 rpm', ring: 1420 / 3000},
    'cruise-control': cruise === 'unavailable' ? {id: 'cruise-control', state: 'unavailable'}
      : {id: 'cruise-control', state: 'value', text: cruise === 'active' ? '90 km/h' : CRUISE_CONTROL_OFF},
    'speed-limit': {id: 'speed-limit', state: 'value', text: '90 km/h'},
    fuel: {id: 'fuel', state: 'value', text: '620 L', detail: '72%'},
    range: {id: 'range', state: 'value', text: '1820 km'},
    'sdk-consumption': {id: 'sdk-consumption', state: 'value', text: '34 L/100 km'},
    cargo: {id: 'cargo', state: 'value', text: 'Machine parts', detail: '18 t'},
    origin: {id: 'origin', state: 'value', text: 'Northport'},
    destination: {id: 'destination', state: 'value', text: 'Pinehaven'},
    'distance-driven': {id: 'distance-driven', state: 'value', text: '286 km'},
    'distance-remaining': {id: 'distance-remaining', state: 'value', text: '412 km'},
    deadline: {id: 'deadline', state: 'value', text: '8 h 25 min'},
    'expected-income': {id: 'expected-income', state: 'value', text: '24680 EUR'},
    'game-time': {id: 'game-time', state: 'value', text: '14:35'},
    'mandatory-break': {id: 'mandatory-break', state: 'value', text: '3 h 15 min'}
  };
  return {source: 'ETS2', origin: 'none', status: 'connected', freshness: 'current', paused: false, editing: false,
    language, layout: settings.layout, backgroundOpacity: settings.backgroundOpacity, contentAnchorY: 0,
    speed: '84', speedUnit: 'km/h', fuel: '620', fuelUnit: 'L', hardMode: {state: 'active'},
    sections: OVERLAY_SECTION_IDS.filter(id => settings.sections[id]).map(id => examples[id])};
}

/** Preview-only fit reserves transformed bounds; it never changes the saved scale or native geometry. */
export function overlayPreviewSize(settings: OverlaySettings, scale: number, availableWidth: number) {
  const zoom = overlayZoom(scale), width = Math.max(1, availableWidth);
  if (settings.layout === 'strip') {
    // At large scales a minimum logical width still fits a whole item. Fit the result to this preview only.
    const widest = Math.max(...OVERLAY_SECTION_IDS.filter(id => settings.sections[id]).map(id => STRIP_ITEM_MAX_WIDTH_CSS[id]), 100);
    const cssWidth = Math.max(width / zoom, widest + 2 * STRIP_PADDING_X_CSS + 4);
    const cssHeight = stripCssHeight(stripRowCount(settings.sections, cssWidth) ?? 1);
    const factor = Math.min(zoom, width / cssWidth);
    return {cssWidth, cssHeight, factor, width: cssWidth * factor, height: cssHeight * factor};
  }
  const cssWidth = OVERLAY_NOMINAL_SIZE[settings.layout].width;
  const cssHeight = Math.max(layoutReservedCss(settings.layout, settings.sections), settings.layout === 'cluster' ? CLUSTER_GAUGE_SIZE_CSS : 0);
  const factor = Math.min(zoom, width / cssWidth);
  return {cssWidth, cssHeight, factor, width: cssWidth * factor, height: cssHeight * factor};
}
