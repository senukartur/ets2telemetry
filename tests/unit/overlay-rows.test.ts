import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';
import {
  CARD_BORDER_CSS, CARD_HEADER_GAP_CSS, CARD_HEADER_HEIGHT_CSS, CARD_PADDING_X_CSS, CARD_PADDING_Y_CSS, CARD_ROW_HEIGHT_CSS, CLUSTER_GAUGE_SIZE_CSS,
  CLUSTER_PANEL_BORDER_CSS, CLUSTER_PANEL_PADDING_X_CSS, CLUSTER_PANEL_PADDING_Y_CSS, CLUSTER_ROW_GAP_CSS, CLUSTER_ROW_HEIGHT_CSS,
  CLUSTER_TAG_ROW_HEIGHT_CSS, HUD_LINE_GAP_CSS, HUD_LINE_HEIGHT_CSS, HUD_TAG_ROW_HEIGHT_CSS, LAYOUT_BORDER_CSS, layoutContentCss, layoutReservedCss,
  layoutRowCount, ROW_LAYOUTS
} from '../../apps/desktop/src/overlay-rows';

// REG-016 partial: the reserved rows of the card, the cluster's side panel and the HUD (ET-012d decisions K2, K3 and K7).
// Every expected count and height below is the plan's hand-written table, worked out by hand from the CSS constants
// (CSS px at zoom 1, border-box, borders included): card 1 + 10 + 20 + 6 + 24 × n + 10 + 1 = 48 + 24n; cluster panel
// 1 + 8 + 18 + (3 + 18) × m + 8 + 1 = 36 + 21m; HUD 18 + (2 + 22) × n = 18 + 24n. n counts the enabled sections, m those
// outside the cluster's gauge (speed, gear and RPM). They are not produced by the implementation.
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const ALL = DEFAULT_OVERLAY_SECTIONS;
// ET-052: the fifteenth section, the next mandatory break, adds one row to every layout. The historical rows below keep the
// fourteen sections of ET-012d (no break), so their hand-written numbers still test the same sets.
const WITHOUT_BREAK = {...ALL, 'mandatory-break': false};
const WITHOUT_DRIVEN = {...WITHOUT_BREAK, 'distance-driven': false};
const WITHOUT_RANGE_AND_DRIVEN = {...WITHOUT_DRIVEN, range: false};
const ALSO_WITHOUT_GAME_TIME = {...WITHOUT_RANGE_AND_DRIVEN, 'game-time': false};

it('fixes the hand-written row constants of each layout', () => {
  expect({border: CARD_BORDER_CSS, paddingY: CARD_PADDING_Y_CSS, paddingX: CARD_PADDING_X_CSS, header: CARD_HEADER_HEIGHT_CSS, headerGap: CARD_HEADER_GAP_CSS,
    row: CARD_ROW_HEIGHT_CSS}).toEqual({border: 1, paddingY: 10, paddingX: 14, header: 20, headerGap: 6, row: 24});
  expect({border: CLUSTER_PANEL_BORDER_CSS, paddingY: CLUSTER_PANEL_PADDING_Y_CSS, paddingX: CLUSTER_PANEL_PADDING_X_CSS, tags: CLUSTER_TAG_ROW_HEIGHT_CSS,
    gap: CLUSTER_ROW_GAP_CSS, row: CLUSTER_ROW_HEIGHT_CSS, gauge: CLUSTER_GAUGE_SIZE_CSS})
    .toEqual({border: 1, paddingY: 8, paddingX: 10, tags: 18, gap: 3, row: 18, gauge: 200});
  expect({tags: HUD_TAG_ROW_HEIGHT_CSS, gap: HUD_LINE_GAP_CSS, line: HUD_LINE_HEIGHT_CSS}).toEqual({tags: 18, gap: 2, line: 22});
  expect(LAYOUT_BORDER_CSS).toEqual({card: 1, cluster: 1, hud: 0});
  expect(ROW_LAYOUTS).toEqual(['card', 'cluster', 'hud']);
});

it.each([
  // ET-052: 48 + 24 × 15 = 408, 36 + 21 × 12 = 288 (speed, gear and RPM are in the gauge) and 18 + 24 × 15 = 378.
  {name: 'every section', sections: ALL, n: 15, m: 12, card: 408, cluster: 288, hud: 378},
  {name: 'every section but the break', sections: WITHOUT_BREAK, n: 14, m: 11, card: 384, cluster: 267, hud: 354},
  {name: 'the break alone', sections: only('mandatory-break'), n: 1, m: 1, card: 72, cluster: 57, hud: 42},
  {name: 'every section without distance driven', sections: WITHOUT_DRIVEN, n: 13, m: 10, card: 360, cluster: 246, hud: 330},
  {name: 'every section without range and distance driven', sections: WITHOUT_RANGE_AND_DRIVEN, n: 12, m: 9, card: 336, cluster: 225, hud: 306},
  {name: 'also without game time', sections: ALSO_WITHOUT_GAME_TIME, n: 11, m: 8, card: 312, cluster: 204, hud: 282},
  {name: 'job-focus', sections: OVERLAY_PRESETS['job-focus'], n: 7, m: 5, card: 216, cluster: 141, hud: 186},
  {name: 'driving-only', sections: OVERLAY_PRESETS['driving-only'], n: 5, m: 2, card: 168, cluster: 78, hud: 138},
  {name: 'speed only', sections: only('speed'), n: 1, m: 0, card: 72, cluster: 36, hud: 42}
])('reserves $card / $cluster / $hud CSS px for $name', ({sections, n, m, card, cluster, hud}) => {
  expect({card: layoutRowCount('card', sections), cluster: layoutRowCount('cluster', sections), hud: layoutRowCount('hud', sections)})
    .toEqual({card: n, cluster: m, hud: n});
  expect({card: layoutReservedCss('card', sections), cluster: layoutReservedCss('cluster', sections), hud: layoutReservedCss('hud', sections)})
    .toEqual({card, cluster, hud});
  // The content height leaves out the outer border on both sides: 2 px for the card and the cluster's panel, none for the HUD.
  expect({card: layoutContentCss('card', sections), cluster: layoutContentCss('cluster', sections), hud: layoutContentCss('hud', sections)})
    .toEqual({card: card - 2, cluster: cluster - 2, hud});
});

it('counts every enabled section in the cluster panel when no gauge section is enabled', () => {
  // Fuel to the break are twelve panel sections: 36 + 21 × 12 = 288, as with every section (ET-052).
  const panelOnly = {...ALL, speed: false, gear: false, rpm: false};
  expect(layoutRowCount('cluster', panelOnly)).toBe(12);
  expect(layoutReservedCss('cluster', panelOnly)).toBe(288);
  // Gear alone shows only the gauge: no panel row.
  expect(layoutReservedCss('cluster', only('gear'))).toBe(36);
  expect(layoutReservedCss('cluster', only('fuel'))).toBe(57);
});

it('never reserves more for a subset of the sections than for all of them', () => {
  const all = Object.fromEntries(ROW_LAYOUTS.map(layout => [layout, layoutReservedCss(layout, ALL)]));
  for (let mask = 1; mask < 1 << OVERLAY_SECTION_IDS.length; mask++) {
    const sections = only(...OVERLAY_SECTION_IDS.filter((_id, index) => (mask & (1 << index)) !== 0));
    for (const layout of ROW_LAYOUTS) {
      const reserved = layoutReservedCss(layout, sections);
      if (reserved > all[layout]) throw new Error(`mask ${mask} in ${layout}: ${reserved} > ${all[layout]}`);
    }
  }
});

it('matches the card, cluster and HUD rules in renderer.css', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8');
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`Missing rule ${selector}`);
    return match[1];
  };
  // The values of one property in a rule body, by exact property name: `line-height: 24px` never satisfies `height`, and
  // a second declaration of the same property, which would override the first, shows up as a second value.
  const values = (body: string, property: string) => body.split(';').map(declaration => /^\s*([\w-]+)\s*:\s*(.*?)\s*$/s.exec(declaration))
    .flatMap(match => match && match[1] === property ? [match[2]] : []);
  const declares = (selector: string, declarations: Record<string, string>) => {
    const body = rule(selector);
    for (const [property, value] of Object.entries(declarations)) expect(values(body, property), `${selector} ${property}`).toEqual([value]);
  };
  // Every height assumes border-box sizing and the 1 px surface border of the card and the cluster's panel.
  declares('.overlay *, .overlay *::before, .overlay *::after', {'box-sizing': 'border-box'});
  expect(values(rule('.overlay-surface'), 'border')).toEqual([expect.stringMatching(new RegExp(`^${CARD_BORDER_CSS}px solid `))]);
  // Card. The description list and its values keep no default margins, which the row model does not count.
  declares('.overlay-card-body', {padding: `${CARD_PADDING_Y_CSS}px ${CARD_PADDING_X_CSS}px`});
  declares('.overlay-card-header', {height: `${CARD_HEADER_HEIGHT_CSS}px`, 'margin-bottom': `${CARD_HEADER_GAP_CSS}px`, 'flex-wrap': 'nowrap', overflow: 'hidden'});
  declares('.overlay-rows', {margin: '0'});
  declares('.overlay-row', {height: `${CARD_ROW_HEIGHT_CSS}px`, overflow: 'hidden', 'align-items': 'center', padding: '0'});
  expect(values(rule('.overlay-row'), 'border-top')).toEqual([expect.stringMatching(/^1px solid /)]);
  declares('.overlay-row dd', {margin: '0'});
  // Cluster: the panel takes its content height; only the fixed rows bound it.
  declares('.overlay-panel', {padding: `${CLUSTER_PANEL_PADDING_Y_CSS}px ${CLUSTER_PANEL_PADDING_X_CSS}px`, gap: `${CLUSTER_ROW_GAP_CSS}px`});
  expect(values(rule('.overlay-panel'), 'max-height').filter(value => value !== '100%')).toEqual([]);
  expect(values(rule('.overlay-panel'), 'height')).toEqual([]);
  declares('.overlay-panel-tags', {height: `${CLUSTER_TAG_ROW_HEIGHT_CSS}px`, 'flex-wrap': 'nowrap', overflow: 'hidden'});
  declares('.overlay-panel-row', {height: `${CLUSTER_ROW_HEIGHT_CSS}px`, 'align-items': 'center', overflow: 'hidden'});
  declares('.overlay-gauge', {height: `${CLUSTER_GAUGE_SIZE_CSS}px`});
  // HUD.
  declares('.overlay-hud-lines', {gap: `${HUD_LINE_GAP_CSS}px`});
  declares('.overlay-hud-tags', {height: `${HUD_TAG_ROW_HEIGHT_CSS}px`, overflow: 'hidden'});
  declares('.overlay-hud-line', {height: `${HUD_LINE_HEIGHT_CSS}px`, 'align-items': 'center', overflow: 'hidden'});
  // The row model counts no margin around a row, tag row or surface, and only the card header's 6 px gap; no padding on
  // the root or a layout root pushes a surface down from the window's top (review pass 3).
  const nonzero = (selector: string, prefix: string) => rule(selector).split(';').map(declaration => /^\s*([\w-]+)\s*:\s*(.*?)\s*$/s.exec(declaration))
    .flatMap(match => match && match[1].startsWith(prefix) && match[2] !== '0' ? [`${match[1]}: ${match[2]}`] : []);
  for (const selector of ['.overlay-row', '.overlay-panel-row', '.overlay-panel-tags', '.overlay-hud-line', '.overlay-hud-tags', '.overlay-panel', '.overlay-hud-lines',
    '.overlay-card-body', '.overlay-cluster-body']) expect(nonzero(selector, 'margin'), `${selector} margins`).toEqual([]);
  for (const selector of ['.overlay', '.overlay-card', '.overlay-cluster', '.overlay-hud']) expect(nonzero(selector, 'padding'), `${selector} padding`).toEqual([]);
});
