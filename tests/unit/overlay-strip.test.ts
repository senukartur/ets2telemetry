import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';
import {
  STRIP_BORDER_CSS, STRIP_COLUMN_GAP_CSS, STRIP_FIXED_WIDTH_SECTIONS, STRIP_HARD_MODE_MAX_WIDTH_CSS, STRIP_ITEM_MAX_WIDTH_CSS, STRIP_PADDING_X_CSS, STRIP_ROW_HEIGHT_CSS,
  STRIP_TAG_MAX_WIDTH_CSS, STRIP_TAG_SLOTS, stripCssHeight, stripRowCount
} from '../../apps/desktop/src/overlay-strip';

// REG-016 partial: the strip's reserved rows (ET-012c decisions S2-S4). The expected rows and heights are the plan's
// hand-written geometry table, worked out by hand from the maximum widths, not produced by the implementation. The CSS
// inner width is the CSS width minus the two 1 px borders and the two 12 px paddings.
// Current maximum-width sequence: tags 112, 112, speed 140, speed limit 32, gear 90, RPM 130, cruise 140,
// fuel 190, range 140, SDK consumption 230, cargo/origin/destination 300 each, driven/remaining 150 each,
// deadline 220, income 300, game time 200, mandatory break/rest state 150 each, Hard Mode/qualification 140. Gaps are 14 px.
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const ALL = DEFAULT_OVERLAY_SECTIONS;
// Expected rendered order, independent of the production strip order constant.
const STRIP_ORDER: readonly OverlaySectionId[] = ['speed', 'speed-limit', 'gear', 'rpm', 'cruise-control', 'fuel', 'range',
  'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-driven', 'distance-remaining', 'deadline', 'expected-income',
  'game-time', 'mandatory-break', 'rest-state'];

it('fixes the hand-written maximum widths of every strip item', () => {
  expect(STRIP_ITEM_MAX_WIDTH_CSS).toEqual({'speed': 140, 'gear': 90, 'rpm': 130, 'cruise-control': 140, 'speed-limit': 32, 'fuel': 190, 'range': 140, 'sdk-consumption': 230, 'cargo': 300,
    'origin': 300, 'destination': 300, 'distance-driven': 150, 'distance-remaining': 150, 'deadline': 220, 'expected-income': 300, 'game-time': 200, 'mandatory-break': 150, 'rest-state': 150});
  expect({slots: STRIP_TAG_SLOTS, tag: STRIP_TAG_MAX_WIDTH_CSS, row: STRIP_ROW_HEIGHT_CSS, border: STRIP_BORDER_CSS, padding: STRIP_PADDING_X_CSS,
    gap: STRIP_COLUMN_GAP_CSS}).toEqual({slots: 2, tag: 112, row: 38, border: 1, padding: 12, gap: 14});
  expect(STRIP_HARD_MODE_MAX_WIDTH_CSS).toBe(140);
  // ET-084: only the speed limit sign is always exactly its cap, so a limit, no limit and no reading take the same width.
  expect([...STRIP_FIXED_WIDTH_SECTIONS]).toEqual(['speed-limit']);
});

it.each([
  // Inner 1254: row totals are 1198 (through range), 1172 (SDK consumption through destination),
  // 1240 (driven distance through mandatory break), 304 (rest state and the fixed indicator).
  // Inner 1222/1221/1232: the third row ends at game time, 1076; the fourth holds both breaks and the fixed indicator, 468.
  // Inner 742: rows end at RPM 686, consumption 742, origin 614, remaining distance 628, income 534, fixed indicator 682.
  // Inner 902: rows end at cruise 840, cargo 902, driven distance 778, income 698, fixed indicator 682.
  // Inner 918: the same first three rows; game time ends the fourth at 912, both breaks and the fixed indicator end at 468.
  // Inner 454: totals 438, 388, 344, 230, 300, 300, 300, 314, 220, 300, 364, 304: twelve rows.
  // Speed alone uses 112 + 112 + 140 + two gaps = 392, then the fixed indicator would reach 546 > 454: two rows.
  {name: 'every section at 1280 (1920 x 1080)', sections: ALL, width: 1280, rows: 4, height: 154},
  {name: 'every section at 1248 (1280 x 720)', sections: ALL, width: 1248, rows: 4, height: 154},
  // With the sign after speed: rows end at RPM (686), consumption (742), origin (614), distance remaining (628),
  // income (534), and fixed indicator (682, including game time, mandatory break and rest state): six rows, inner width 742.
  {name: 'every section at 768 (800 x 600)', sections: ALL, width: 768, rows: 6, height: 230},
  {name: 'every section at 928 (960 x 540)', sections: ALL, width: 928, rows: 5, height: 192},
  {name: 'every section at 1247 (fractional client)', sections: ALL, width: 1247, rows: 4, height: 154},
  {name: 'every section at the 480 minimum', sections: ALL, width: 480, rows: 12, height: 458},
  {name: 'speed only at the 480 minimum', sections: only('speed'), width: 480, rows: 2, height: 78},
  {name: 'every section at 1258 (scale 1.5)', sections: ALL, width: 1258, rows: 4, height: 154},
  {name: 'every section at 944 (scale 2)', sections: ALL, width: 944, rows: 5, height: 192},
  {name: 'every section at 1279 (scale 1.1)', sections: ALL, width: 1279, rows: 4, height: 154},
  {name: 'speed only at 1279 (scale 1.01)', sections: only('speed'), width: 1279, rows: 1, height: 40},
  // Driving-only, inner 742: RPM ends row one at 686; cruise, fuel, range and the fixed indicator fill row two to 652.
  // Inner 902: cruise ends row one at 840; fuel, range and the fixed indicator fill row two to 498.
  // Inner 1222/1234: range ends row one at 1198; the fixed indicator would reach 1352 and needs a second row.
  // One row therefore needs CSS width 1352 + 26 = 1378 at zoom 1.
  {name: 'driving-only at 768', sections: OVERLAY_PRESETS['driving-only'], width: 768, rows: 2, height: 78},
  {name: 'driving-only at 928', sections: OVERLAY_PRESETS['driving-only'], width: 928, rows: 2, height: 78},
  {name: 'driving-only at 1248', sections: OVERLAY_PRESETS['driving-only'], width: 1248, rows: 2, height: 78},
  {name: 'driving-only at 1260', sections: OVERLAY_PRESETS['driving-only'], width: 1260, rows: 2, height: 78},
  {name: 'driving-only at 1378', sections: OVERLAY_PRESETS['driving-only'], width: 1378, rows: 1, height: 40},
  {name: 'job-focus at 1280', sections: OVERLAY_PRESETS['job-focus'], width: 1280, rows: 2, height: 78},
  {name: 'all but RPM and cargo at 1280', sections: {...ALL, rpm: false, cargo: false}, width: 1280, rows: 3, height: 116}
])('reserves $rows rows for $name', ({sections, width, rows, height}) => {
  expect(stripRowCount(sections, width)).toBe(rows);
  expect(stripCssHeight(rows)).toBe(height);
});

// ET-119 reserves 40 additional pixels in the fixed indicator for the optional qualification medal.
it('fills a row exactly to the inner width and wraps one pixel below it', () => {
  // Driving-only: tags 112 + 112, speed 140, gear 90, rpm 130, fuel 190 and range 140 with six 14 px gaps = 998; ET-070 adds
  // the fixed indicator's 14 + 140 = 1152, ET-071 cruise control's 14 + 140 = 1306 and ET-084 the speed limit's 14 + 32 =
  // 1352, an inner width of CSS width 1378.
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 1378)).toBe(1);
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 1377)).toBe(2);
  // Without the speed limit and cruise control it is 1152 inner px at CSS width 1178.
  const withoutCruise = {...OVERLAY_PRESETS['driving-only'], 'cruise-control': false, 'speed-limit': false};
  expect(stripRowCount(withoutCruise, 1178)).toBe(1);
  expect(stripRowCount(withoutCruise, 1177)).toBe(2);
});

it('reserves cruise control its own 140 px slot (ET-071)', () => {
  // Cruise control alone with the tags and the indicator: 112 + 112 + 140 + 140 with three gaps = 546, CSS width 572.
  expect(stripRowCount(only('cruise-control'), 572)).toBe(1);
  expect(stripRowCount(only('cruise-control'), 571)).toBe(2);
  // Removing it and ET-084's speed limit from every section at 1280 gives three rows (1242, 1092, then the indicator at 1230).
  expect(stripRowCount({...ALL, 'cruise-control': false, 'speed-limit': false, 'rest-state': false}, 1280)).toBe(3);
});

it('reserves the speed limit sign its own 32 px slot (ET-084)', () => {
  // The sign alone with the tags and the indicator: 112 + 112 + 32 + 140 with three gaps = 438, CSS width 464.
  expect(stripRowCount(only('speed-limit'), 464)).toBe(1);
  expect(stripRowCount(only('speed-limit'), 463)).toBe(2);
  // At 1280 it costs no row: the first row ends at range, 1198 of the inner 1254, where SDK consumption did not fit before either.
  expect(stripRowCount(ALL, 1280)).toBe(stripRowCount({...ALL, 'speed-limit': false}, 1280));
  // At 768 (inner 742), placing the sign after speed keeps consumption on the second row and the total at six rows.
  expect(stripRowCount({...ALL, 'speed-limit': false}, 768)).toBe(6);
  expect(stripRowCount(ALL, 768)).toBe(6);
});

it('reserves the next mandatory break its own 150 px slot (ET-052)', () => {
  // Game time 200 and the break 150 with the two 112 px tags and three 14 px gaps take 616; the 154 px fixed-indicator
  // addition reaches 770: inner 770 is CSS width 796.
  const pair = only('game-time', 'mandatory-break');
  expect(stripRowCount(pair, 796)).toBe(1);
  expect(stripRowCount(pair, 795)).toBe(2);
  // The break alone with the tags: 112 + 112 + 150 + two gaps = 402, 556 with the indicator, so a CSS width of 582 fits one
  // row and 581 two.
  expect(stripRowCount(only('mandatory-break'), 582)).toBe(1);
  expect(stripRowCount(only('mandatory-break'), 581)).toBe(2);
  // Removing the break from every section at 944 (inner 918) ends the fourth row at game time (912), so the indicator
  // (912 + 154 = 1066) takes a fifth row of its own, as the break did: five rows.
  expect(stripRowCount({...ALL, 'mandatory-break': false}, 944)).toBe(5);
});

it('reserves nothing when one item could not fit a row', () => {
  // Cargo, origin, destination and expected income are 300 wide: the inner width must be at least 300.
  expect(stripRowCount(ALL, 325)).toBeUndefined();
  expect(stripRowCount(ALL, 326)).toBeDefined();
  expect(stripRowCount(only('speed'), 325)).toBe(2);
  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) expect(stripRowCount(ALL, width)).toBeUndefined();
});

it('models the surface border as at least one device pixel below zoom 1', () => {
  // Chromium snaps a nonzero border thinner than one device pixel up to one device pixel, so below zoom 1 the 1 px
  // border takes 1 / scale CSS px: the inner width is floor(CSS width − 2 × max(1, 1 / scale) − 24).
  // The reviewer's case, re-derived for ET-070: two 112 px tags, cargo 300, origin 300, distance driven 150 and the Hard
  // Mode/qualification indicator 140 with five 14 px gaps take 224 + 750 + 140 + 70 = 1184. At CSS width 1210 and zoom 1 the inner
  // width is 1210 − 2 − 24 = 1184: one row. At 0.75 it is floor(1210 − 2 × 1.3333 − 24) = 1183: two rows.
  const sections = only('cargo', 'origin', 'distance-driven');
  expect(stripRowCount(sections, 1210)).toBe(1);
  expect(stripRowCount(sections, 1210, 0.75)).toBe(2);
  // At 0.5 the border is 2 CSS px: every section at 1280 has an inner width of 1280 − 4 − 24 = 1252, four rows as at 1254
  // (1198 through range, 1172 through destination, 1240 through mandatory break, then rest state/Hard Mode); at 480 it is 452, twelve
  // rows as at 454.
  expect(stripRowCount(ALL, 1280, 0.5)).toBe(4);
  expect(stripRowCount(ALL, 480, 0.5)).toBe(12);
  // At zoom 1 and above the border stays 1 CSS px: the exact fit of driving-only at 1378 holds at scale 2, and at
  // 0.99 the snapped border leaves floor(1378 − 2 × 1.0101 − 24) = 1351 of the 1352 it needs.
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 1378, 2)).toBe(1);
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 1378, 0.99)).toBe(2);
});

it.each([0, 1, 2, 3])('never reserves more rows for a subset of sections than for all of them (partition %i)', partition => {
  const widths = [480, 640, 768, 928, 992, 1248, 1280], all = widths.map(width => stripRowCount(ALL, width)!);
  const partitionSize = 1 << (OVERLAY_SECTION_IDS.length - 2);
  for (let mask = Math.max(1, partition * partitionSize); mask < (partition + 1) * partitionSize; mask++) {
    const sections = only(...OVERLAY_SECTION_IDS.filter((_id, index) => (mask & (1 << index)) !== 0));
    widths.forEach((width, index) => {
      const rows = stripRowCount(sections, width);
      if (rows === undefined || rows > all[index]) throw new Error(`mask ${mask} at ${width}: ${String(rows)} > ${all[index]}`);
    });
  }
});

/** Deterministic PRNG (mulberry32), so the sweep is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * A test-local model of CSS flex-wrap line collection (Flexbox §9.3): items in DOM order, each at its outer
 * hypothetical main size, are collected onto a line until the next one, after the column gap, would overflow the inner
 * width. A line always takes at least one item.
 */
function flexLines(widths: number[], inner: number): number {
  let lines = 0, used = 0;
  for (const width of widths) {
    if (lines === 0 || used + STRIP_COLUMN_GAP_CSS + width > inner) {lines++; used = width;} else used += STRIP_COLUMN_GAP_CSS + width;
  }
  return Math.max(lines, 1);
}

it('reserves at least as many rows as any rendered strip with values up to their maximum widths needs', () => {
  const next = random(0x012c);
  for (let run = 0; run < 5400; run++) {
    const width = 480 + Math.floor(next() * 801), inner = width - 26;
    let enabled = STRIP_ORDER.filter(() => next() < 0.5);
    if (!enabled.length) enabled = [OVERLAY_SECTION_IDS[Math.floor(next() * OVERLAY_SECTION_IDS.length)]];
    // Zero, one or two tags; every value somewhere between empty and its maximum width; the Hard Mode indicator last (ET-070).
    const tags = Array.from({length: Math.floor(next() * 3)}, () => next() * STRIP_TAG_MAX_WIDTH_CSS);
    const items = [...tags, ...enabled.map(id => next() * STRIP_ITEM_MAX_WIDTH_CSS[id]), next() * STRIP_HARD_MODE_MAX_WIDTH_CSS];
    const reserved = stripRowCount(only(...enabled), width)!;
    if (flexLines(items, inner) > reserved) throw new Error(`run ${run}: ${enabled.join(',')} at ${width} needs ${flexLines(items, inner)} > ${reserved}`);
  }
});

it('reserves at least as many rows as any rendered strip needs at every scale, with the snapped border', () => {
  const next = random(0x0750);
  for (let run = 0; run < 5400; run++) {
    // A DIP width and a scale with two decimals; the real CSS inner width is width / scale minus the snapped borders.
    const scale = Math.round((0.5 + next() * 1.5) * 100) / 100, width = Math.round(480 * scale) + Math.floor(next() * 801 * scale);
    const inner = width / scale - 2 * Math.max(1, 1 / scale) - 24;
    let enabled = STRIP_ORDER.filter(() => next() < 0.5);
    if (!enabled.length) enabled = [OVERLAY_SECTION_IDS[Math.floor(next() * OVERLAY_SECTION_IDS.length)]];
    // Values at their maximum width half of the time, so lines land on the boundary.
    const size = (cap: number) => next() < 0.5 ? cap : next() * cap;
    const items = [...Array.from({length: Math.floor(next() * 3)}, () => size(STRIP_TAG_MAX_WIDTH_CSS)), ...enabled.map(id => size(STRIP_ITEM_MAX_WIDTH_CSS[id])),
      size(STRIP_HARD_MODE_MAX_WIDTH_CSS)];
    const reserved = stripRowCount(only(...enabled), Math.floor(width / scale), scale);
    if (reserved === undefined || flexLines(items, inner) > reserved)
      throw new Error(`run ${run}: ${enabled.join(',')} at ${width} DIP and ${scale} needs ${flexLines(items, inner)} > ${String(reserved)}`);
  }
});

it('matches the strip rules in renderer.css', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8');
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`Missing rule ${selector}`);
    return match[1];
  };
  // Every maximum width and the border model assume border-box sizing.
  expect(rule('.overlay *, .overlay *::before, .overlay *::after')).toContain('box-sizing: border-box;');
  const row = rule('.overlay-strip-row');
  expect(row).toContain('flex-wrap: wrap;');
  expect(row).toMatch(/(?:^|;)\s*width: 100%;/);
  expect(row).toContain('max-width: 100%;');
  expect(row).toContain(`column-gap: ${STRIP_COLUMN_GAP_CSS}px;`);
  expect(row).toContain(`padding: 0 ${STRIP_PADDING_X_CSS}px;`);
  // The surface takes its content height; a fixed height would clip the reserved rows.
  expect(row).not.toMatch(/(^|[;\s])height\s*:/);
  expect(row).not.toMatch(/row-gap|(^|[;\s])gap\s*:/);
  expect(rule('.overlay-strip-row > *')).toContain(`height: ${STRIP_ROW_HEIGHT_CSS}px;`);
  expect(rule('.overlay-surface')).toContain(`border: ${STRIP_BORDER_CSS}px solid`);
  expect(rule('.overlay-group-start')).toContain('padding-left: 15px;');
  expect(rule('.overlay-strip .overlay-item')).toMatch(/min-width: 0;[^}]*overflow: hidden;/);
  expect(rule('.overlay-strip .overlay-value')).toMatch(/min-width: 0;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
  expect(rule('.overlay-strip .overlay-tag')).toContain('overflow: hidden;');
  // ET-050 (GD6): the invisible reserve keeps the lines of the gear's multi-line reserve and adds no height.
  const reserve = rule('.overlay-strip .overlay-value[data-reserve]::after');
  expect(reserve).toContain('content: attr(data-reserve);');
  expect(reserve).toContain('height: 0;');
  expect(reserve).toContain('visibility: hidden;');
  expect(reserve).toContain('white-space: pre;');
});

// ET-052 (MB10): the break's urgency cues in the stylesheet. Soon is orange and due is red and underlined, set on the item by
// its data-urgency attribute; the colours are the two overlay tokens, which the design tokens file repeats byte for byte.
// Contrast of the tokens on the #0B1120 panel was computed by hand with the WCAG 2.x formula (docs/validation/et-052.md).
it('colours the break by urgency from two tokens and underlines only due, changing no size', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`Missing rule ${selector}`);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };
  const soon = rule('.overlay [data-urgency="soon"] .overlay-value'), due = rule('.overlay [data-urgency="due"] .overlay-value');
  expect(soon).toContain('color: var(--yu-ov-break-soon);'); expect(soon).not.toContain('text-decoration');
  expect(due).toContain('color: var(--yu-ov-break-due);'); expect(due).toContain('text-decoration: underline;');
  for (const body of [soon, due]) expect(body).not.toMatch(/(^|[;\s])(height|width|padding|margin|font-size|font-weight|border|display)\s*:/);
  const tokens = readFileSync('apps/desktop/src/shell/overlay-tokens.css', 'utf8'), design = readFileSync('docs/design/tokens.css', 'utf8');
  for (const [name, value] of [['--yu-ov-break-soon', '#FB923C'], ['--yu-ov-break-due', '#F87171']]) {
    expect(tokens, name).toContain(`${name}: ${value};`); expect(design, name).toContain(`${name}: ${value};`);
  }
});

// ET-070 (D1-D4): the Hard Mode indicator's colours come from three state tokens, which the design tokens file repeats byte
// for byte, and its cue sits in a fixed 14 px slot, so a state change (check, nothing, cross) never changes its width. The
// strike-through changes no size either.
it('colours the Hard Mode indicator by state from three tokens with a fixed cue slot, changing no size', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8');
  const rule = (selector: string) => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) throw new Error(`Missing rule ${selector}`);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };
  for (const state of ['active', 'inactive', 'lost']) expect(rule(`.overlay-hard-mode[data-state="${state}"]`)).toContain(`--yu-ov-hm: var(--yu-ov-hm-${state});`);
  expect(rule('.overlay-hard-mode .overlay-icon, .overlay-hard-mode .overlay-value, .overlay-hard-mode .overlay-hm-text')).toContain('color: var(--yu-ov-hm);');
  const cue = rule('.overlay-hm-cue');
  expect(cue).toContain('flex: none;'); expect(cue).toContain('width: 14px;'); expect(cue).toContain('height: 14px;');
  const struck = rule('.overlay-hm-struck');
  expect(struck).toContain('text-decoration: line-through;');
  expect(struck).not.toMatch(/(^|[;\s])(height|width|padding|margin|font-size|font-weight|border|display)\s*:/);
  const tokens = readFileSync('apps/desktop/src/shell/overlay-tokens.css', 'utf8'), design = readFileSync('docs/design/tokens.css', 'utf8');
  for (const [name, value] of [['--yu-ov-hm-active', '#8FD3AE'], ['--yu-ov-hm-inactive', '#E8C58A'], ['--yu-ov-hm-lost', '#F87171']]) {
    expect(tokens, name).toContain(`${name}: ${value};`); expect(design, name).toContain(`${name}: ${value};`);
  }
});
