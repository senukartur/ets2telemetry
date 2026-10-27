import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';
import {
  STRIP_BORDER_CSS, STRIP_COLUMN_GAP_CSS, STRIP_ITEM_MAX_WIDTH_CSS, STRIP_PADDING_X_CSS, STRIP_ROW_HEIGHT_CSS, STRIP_TAG_MAX_WIDTH_CSS, STRIP_TAG_SLOTS,
  stripCssHeight, stripRowCount
} from '../../apps/desktop/src/overlay-strip';

// REG-016 partial: the strip's reserved rows (ET-012c decisions S2-S4). The expected rows and heights are the plan's
// hand-written geometry table, worked out by hand from the maximum widths, not produced by the implementation. The CSS
// inner width is the CSS width minus the two 1 px borders and the two 12 px paddings.
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const ALL = DEFAULT_OVERLAY_SECTIONS;

it('fixes the hand-written maximum widths of every strip item', () => {
  expect(STRIP_ITEM_MAX_WIDTH_CSS).toEqual({'speed': 140, 'gear': 90, 'rpm': 130, 'fuel': 190, 'range': 140, 'sdk-consumption': 230, 'cargo': 300,
    'origin': 300, 'destination': 300, 'distance-driven': 150, 'distance-remaining': 150, 'deadline': 220, 'expected-income': 300, 'game-time': 200, 'mandatory-break': 150});
  expect({slots: STRIP_TAG_SLOTS, tag: STRIP_TAG_MAX_WIDTH_CSS, row: STRIP_ROW_HEIGHT_CSS, border: STRIP_BORDER_CSS, padding: STRIP_PADDING_X_CSS,
    gap: STRIP_COLUMN_GAP_CSS}).toEqual({slots: 2, tag: 96, row: 38, border: 1, padding: 12, gap: 14});
});

it.each([
  // Inner 1254: tags, speed, gear, rpm, fuel, range, sdk = 1210; cargo, origin, destination, distance driven = 1092
  // (distance remaining would reach 1256); distance remaining, deadline, income, game time, break = 1076 (912 before the
  // ET-052 break section, which added 14 + 150 and changes no row count at this width).
  // ET-052: at 944 (scale 2) the break no longer fits the row that ended at game time (912 + 164 = 1076 > 918), so the
  // fifth row holds it alone: 5 rows, 192, where 14 sections fitted 4 rows, 154. The other rows are unchanged.
  {name: 'every section at 1280 (1920 x 1080)', sections: ALL, width: 1280, rows: 3, height: 116},
  {name: 'every section at 1248 (1280 x 720)', sections: ALL, width: 1248, rows: 3, height: 116},
  {name: 'every section at 768 (800 x 600)', sections: ALL, width: 768, rows: 6, height: 230},
  {name: 'every section at 928 (960 x 540)', sections: ALL, width: 928, rows: 5, height: 192},
  {name: 'every section at 1247 (fractional client)', sections: ALL, width: 1247, rows: 3, height: 116},
  {name: 'every section at the 480 minimum', sections: ALL, width: 480, rows: 10, height: 382},
  {name: 'speed only at the 480 minimum', sections: only('speed'), width: 480, rows: 1, height: 40},
  {name: 'every section at 1258 (scale 1.5)', sections: ALL, width: 1258, rows: 3, height: 116},
  {name: 'every section at 944 (scale 2)', sections: ALL, width: 944, rows: 5, height: 192},
  {name: 'every section at 1279 (scale 1.1)', sections: ALL, width: 1279, rows: 3, height: 116},
  {name: 'speed only at 1279 (scale 1.01)', sections: only('speed'), width: 1279, rows: 1, height: 40},
  {name: 'driving-only at 768', sections: OVERLAY_PRESETS['driving-only'], width: 768, rows: 2, height: 78},
  {name: 'driving-only at 928', sections: OVERLAY_PRESETS['driving-only'], width: 928, rows: 2, height: 78},
  {name: 'driving-only at 1248', sections: OVERLAY_PRESETS['driving-only'], width: 1248, rows: 1, height: 40},
  {name: 'job-focus at 1280', sections: OVERLAY_PRESETS['job-focus'], width: 1280, rows: 2, height: 78},
  {name: 'all but RPM and cargo at 1280', sections: {...ALL, rpm: false, cargo: false}, width: 1280, rows: 3, height: 116}
])('reserves $rows rows for $name', ({sections, width, rows, height}) => {
  expect(stripRowCount(sections, width)).toBe(rows);
  expect(stripCssHeight(rows)).toBe(height);
});

it('fills a row exactly to the inner width and wraps one pixel below it', () => {
  // Driving-only: tags 96 + 96, speed 140, gear 90, rpm 130, fuel 190 and range 140 with six 14 px gaps = 966.
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 992)).toBe(1);
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 991)).toBe(2);
});

it('reserves the next mandatory break its own 150 px slot (ET-052)', () => {
  // Game time 200 and the break 150 with the two 96 px tags and three 14 px gaps take 584: inner 584 is CSS width 610.
  const pair = only('game-time', 'mandatory-break');
  expect(stripRowCount(pair, 610)).toBe(1);
  expect(stripRowCount(pair, 609)).toBe(2);
  // The break alone with the tags: 96 + 96 + 150 + two gaps = 370, so a CSS width of 396 fits one row and 395 two.
  expect(stripRowCount(only('mandatory-break'), 396)).toBe(1);
  expect(stripRowCount(only('mandatory-break'), 395)).toBe(2);
  // Removing the break from every section gives back the 14-section rows at 944: four rows, 154.
  expect(stripRowCount({...ALL, 'mandatory-break': false}, 944)).toBe(4);
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
  // The reviewer's case: an 800 x 600 client at scale 0.75 gives a 768 DIP strip, CSS width floor(768 / 0.75) = 1024.
  // Two 96 px tags, cargo 300, origin 300 and distance driven 150 with four 14 px gaps take 998. At zoom 1 the inner
  // width is 1024 − 2 − 24 = 998: one row. At 0.75 it is floor(1024 − 2 × 1.3333 − 24) = floor(997.33) = 997: two rows.
  const sections = only('cargo', 'origin', 'distance-driven');
  expect(stripRowCount(sections, 1024)).toBe(1);
  expect(stripRowCount(sections, 1024, 0.75)).toBe(2);
  // At 0.5 the border is 2 CSS px: every section at 1280 has an inner width of 1280 − 4 − 24 = 1252, still three rows
  // (1210, 1092, then distance remaining would reach 1256); at 480 it is 452, still ten rows.
  expect(stripRowCount(ALL, 1280, 0.5)).toBe(3);
  expect(stripRowCount(ALL, 480, 0.5)).toBe(10);
  // At zoom 1 and above the border stays 1 CSS px: the exact fit of driving-only at 992 holds at scale 2.
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 992, 2)).toBe(1);
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 992, 0.99)).toBe(2);
});

it('never reserves more rows for a subset of the sections than for all of them', () => {
  const widths = [480, 640, 768, 928, 992, 1248, 1280], all = widths.map(width => stripRowCount(ALL, width)!);
  for (let mask = 1; mask < 1 << OVERLAY_SECTION_IDS.length; mask++) {
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
  for (let run = 0; run < 5000; run++) {
    const width = 480 + Math.floor(next() * 801), inner = width - 26;
    let enabled = OVERLAY_SECTION_IDS.filter(() => next() < 0.5);
    if (!enabled.length) enabled = [OVERLAY_SECTION_IDS[Math.floor(next() * OVERLAY_SECTION_IDS.length)]];
    // Zero, one or two tags; every value somewhere between empty and its maximum width.
    const tags = Array.from({length: Math.floor(next() * 3)}, () => next() * STRIP_TAG_MAX_WIDTH_CSS);
    const items = [...tags, ...enabled.map(id => next() * STRIP_ITEM_MAX_WIDTH_CSS[id])];
    const reserved = stripRowCount(only(...enabled), width)!;
    if (flexLines(items, inner) > reserved) throw new Error(`run ${run}: ${enabled.join(',')} at ${width} needs ${flexLines(items, inner)} > ${reserved}`);
  }
});

it('reserves at least as many rows as any rendered strip needs at every scale, with the snapped border', () => {
  const next = random(0x0750);
  for (let run = 0; run < 5000; run++) {
    // A DIP width and a scale with two decimals; the real CSS inner width is width / scale minus the snapped borders.
    const scale = Math.round((0.5 + next() * 1.5) * 100) / 100, width = Math.round(480 * scale) + Math.floor(next() * 801 * scale);
    const inner = width / scale - 2 * Math.max(1, 1 / scale) - 24;
    let enabled = OVERLAY_SECTION_IDS.filter(() => next() < 0.5);
    if (!enabled.length) enabled = [OVERLAY_SECTION_IDS[Math.floor(next() * OVERLAY_SECTION_IDS.length)]];
    // Values at their maximum width half of the time, so lines land on the boundary.
    const size = (cap: number) => next() < 0.5 ? cap : next() * cap;
    const items = [...Array.from({length: Math.floor(next() * 3)}, () => size(STRIP_TAG_MAX_WIDTH_CSS)), ...enabled.map(id => size(STRIP_ITEM_MAX_WIDTH_CSS[id]))];
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
