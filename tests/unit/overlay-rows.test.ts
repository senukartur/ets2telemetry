import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';
import {
  CARD_BORDER_CSS, CARD_HEADER_GAP_CSS, CARD_HEADER_HEIGHT_CSS, CARD_PADDING_X_CSS, CARD_PADDING_Y_CSS, CARD_ROW_HEIGHT_CSS, CARD_SIGN_SLOT_CSS, cardHeroHeightCss, CLUSTER_GAUGE_SIZE_CSS,
  CLUSTER_PANEL_BORDER_CSS, CLUSTER_PANEL_PADDING_X_CSS, CLUSTER_PANEL_PADDING_Y_CSS, CLUSTER_ROW_GAP_CSS, CLUSTER_ROW_HEIGHT_CSS,
  CLUSTER_TAG_ROW_HEIGHT_CSS, HARD_MODE_ROWS, HUD_LINE_GAP_CSS, HUD_LINE_HEIGHT_CSS, HUD_TAG_ROW_HEIGHT_CSS, LAYOUT_BORDER_CSS, layoutContentCss, layoutReservedCss,
  layoutRowCount, ROW_LAYOUTS
} from '../../apps/desktop/src/overlay-rows';

// REG-016 partial: the reserved rows of the card, the cluster's side panel and the HUD (ET-012d decisions K2, K3 and K7).
// Every expected count and height below is the plan's hand-written table, worked out by hand from the CSS constants
// (CSS px at zoom 1, border-box, borders included): card 1 + 10 + 20 + 6 + 24 × n + 10 + 1 = 48 + 24n; cluster panel
// 1 + 8 + 18 + (3 + 18) × m + 8 + 1 = 36 + 21m; HUD 18 + (2 + 22) × n = 18 + 24n. n counts the enabled sections, m those
// outside the cluster's gauge (speed, gear and RPM). They are not produced by the implementation.
// ET-070 (owner decision D3; the requirement changed): the fixed Hard Mode indicator is one more row in every layout,
// whatever the sections, so the reserves are card 48 + 24(n + 1) = 72 + 24n, cluster panel 36 + 21(m + 1) = 57 + 21m and
// HUD 18 + 24(n + 1) = 42 + 24n, and each layout counts n + 1 (cluster m + 1) rows. n and m below still count sections.
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const ALL = DEFAULT_OVERLAY_SECTIONS;
// ET-052: the fifteenth section, the next mandatory break, adds one row to every layout; ET-071's sixteenth, cruise control,
// another (a panel row in the cluster). ET-084's seventeenth, the speed limit, adds one to the card and the HUD and none to the
// cluster, whose sign has no panel row. The historical rows below keep the sixteen sections of ET-071, the fifteen of ET-052 and
// the fourteen of ET-012d, so their hand-written numbers still test the same sets.
const WITHOUT_LIMIT = {...ALL, 'speed-limit': false};
const WITHOUT_CRUISE = {...WITHOUT_LIMIT, 'cruise-control': false};
const WITHOUT_BREAK = {...WITHOUT_CRUISE, 'mandatory-break': false};
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
  expect(HARD_MODE_ROWS).toBe(1);
  expect(CARD_SIGN_SLOT_CSS).toBe(74);
});

it.each([
  // ET-084: 72 + 24 × 17 = 480, 57 + 21 × 13 = 330 (the sign takes no panel row) and 42 + 24 × 17 = 450. With speed, gear and RPM
  // on the sign's hero needs no surplus.
  {name: 'every section', sections: ALL, n: 17, m: 13, card: 480, cluster: 330, hud: 450},
  // ET-071: 72 + 24 × 16 = 456, 57 + 21 × 13 = 330 (speed, gear and RPM are in the gauge; cruise control is a panel row) and
  // 42 + 24 × 16 = 426.
  {name: 'every section but the speed limit', sections: WITHOUT_LIMIT, n: 16, m: 13, card: 456, cluster: 330, hud: 426},
  // ET-070: 72 + 24 × 15 = 432, 57 + 21 × 12 = 309 and 42 + 24 × 15 = 402 (ET-052's 408, 288 and 378 without the Hard Mode row).
  {name: 'every section but the speed limit and cruise control', sections: WITHOUT_CRUISE, n: 15, m: 12, card: 432, cluster: 309, hud: 402},
  {name: 'every section but the speed limit, cruise control and the break', sections: WITHOUT_BREAK, n: 14, m: 11, card: 408, cluster: 288, hud: 378},
  {name: 'the break alone', sections: only('mandatory-break'), n: 1, m: 1, card: 96, cluster: 78, hud: 66},
  {name: 'cruise control alone', sections: only('cruise-control'), n: 1, m: 1, card: 96, cluster: 78, hud: 66},
  // ET-084: the sign alone: card 48 + 24 × 2 + a surplus of 74 − 24 = 50, so 146; cluster 57 (no panel row); HUD 42 + 24 = 66.
  {name: 'the speed limit alone', sections: only('speed-limit'), n: 1, m: 0, card: 146, cluster: 57, hud: 66},
  {name: 'every section without distance driven', sections: WITHOUT_DRIVEN, n: 13, m: 10, card: 384, cluster: 267, hud: 354},
  {name: 'every section without range and distance driven', sections: WITHOUT_RANGE_AND_DRIVEN, n: 12, m: 9, card: 360, cluster: 246, hud: 330},
  {name: 'also without game time', sections: ALSO_WITHOUT_GAME_TIME, n: 11, m: 8, card: 336, cluster: 225, hud: 306},
  {name: 'job-focus', sections: OVERLAY_PRESETS['job-focus'], n: 7, m: 5, card: 240, cluster: 162, hud: 210},
  // ET-084: driving-only includes cruise control and the speed limit: 72 + 24 × 7 = 240, 57 + 21 × 3 = 120 and 42 + 24 × 7 = 210.
  {name: 'driving-only', sections: OVERLAY_PRESETS['driving-only'], n: 7, m: 3, card: 240, cluster: 120, hud: 210},
  // Speed alone is in the cluster's gauge: its panel holds only the Hard Mode row, 57.
  {name: 'speed only', sections: only('speed'), n: 1, m: 0, card: 96, cluster: 57, hud: 66}
])('reserves $card / $cluster / $hud CSS px for $name', ({sections, n, m, card, cluster, hud}) => {
  expect({card: layoutRowCount('card', sections), cluster: layoutRowCount('cluster', sections), hud: layoutRowCount('hud', sections)})
    .toEqual({card: n + 1, cluster: m + 1, hud: n + 1});
  expect({card: layoutReservedCss('card', sections), cluster: layoutReservedCss('cluster', sections), hud: layoutReservedCss('hud', sections)})
    .toEqual({card, cluster, hud});
  // The content height leaves out the outer border on both sides: 2 px for the card and the cluster's panel, none for the HUD.
  expect({card: layoutContentCss('card', sections), cluster: layoutContentCss('cluster', sections), hud: layoutContentCss('hud', sections)})
    .toEqual({card: card - 2, cluster: cluster - 2, hud});
});

it('counts every enabled section in the cluster panel when no gauge section is enabled', () => {
  // Cruise control to the break are thirteen panel sections and the Hard Mode row: 36 + 21 × 14 = 330, as with every section
  // (ET-070, ET-071). The speed limit sign (ET-084) stands in the gauge's place, not in a panel row.
  const panelOnly = {...ALL, speed: false, gear: false, rpm: false};
  expect(layoutRowCount('cluster', panelOnly)).toBe(14);
  expect(layoutReservedCss('cluster', panelOnly)).toBe(330);
  // Gear alone shows only the gauge: the panel keeps only the Hard Mode row, 36 + 21 = 57; fuel adds a second, 78.
  expect(layoutReservedCss('cluster', only('gear'))).toBe(57);
  expect(layoutReservedCss('cluster', only('fuel'))).toBe(78);
});

// ET-084: the card's hero height for each of the eight subsets of speed (S), gear (G) and RPM (R) with the sign (L): one
// 24 px row per part plus one for the sign, at least the 74 px slot. Hand-derived: three parts + L is 96, surplus 0; two parts +
// L is 74, surplus 74 − 72 = 2; one part + L is 74, surplus 74 − 48 = 26; L alone is 74, surplus 74 − 24 = 50. The content is
// 46 + 24 × (parts + the sign + the Hard Mode row) + the surplus, so 46 + 120 = 166 for all four and 144 for every other subset
// (46 + 96 + 2, 46 + 72 + 26, 46 + 48 + 50), and the reserve 2 px more.
it.each([
  {parts: ['speed', 'gear', 'rpm'], hero: 96, content: 166}, {parts: ['speed', 'gear'], hero: 74, content: 144}, {parts: ['speed', 'rpm'], hero: 74, content: 144},
  {parts: ['gear', 'rpm'], hero: 74, content: 144}, {parts: ['speed'], hero: 74, content: 144}, {parts: ['gear'], hero: 74, content: 144}, {parts: ['rpm'], hero: 74, content: 144},
  {parts: [], hero: 74, content: 144}
] as {parts: OverlaySectionId[]; hero: number; content: number}[])('sizes the card hero $hero px for $parts with the speed limit sign', ({parts, hero, content}) => {
  expect(cardHeroHeightCss(parts.length, true)).toBe(hero);
  const sections = only(...parts, 'speed-limit');
  expect(layoutContentCss('card', sections)).toBe(content);
  expect(layoutReservedCss('card', sections)).toBe(content + 2);
  expect(layoutRowCount('card', sections)).toBe(parts.length + 2);
  // The sign never changes the other layouts' rows beyond its own HUD line.
  expect(layoutRowCount('cluster', sections)).toBe(1);
  expect(layoutRowCount('hud', sections)).toBe(parts.length + 2);
});
it.each([[3, 72], [2, 48], [1, 24], [0, 0]])('keeps the hero at one 24 px row per part without the sign: %d parts are %d px', (parts, hero) => {
  expect(cardHeroHeightCss(parts, false)).toBe(hero);
});
it('reserves the same height whatever the value of the sign, because it reads only the enabled sections', () => {
  // A reserve is a function of the section record alone: there is no value to pass in.
  expect(layoutReservedCss.length).toBe(2);
  expect(layoutReservedCss('card', ALL)).toBe(480);
  expect(layoutReservedCss('card', ALL)).toBe(layoutReservedCss('card', {...ALL}));
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
