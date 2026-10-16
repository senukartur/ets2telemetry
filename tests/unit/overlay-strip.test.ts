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
    'origin': 300, 'destination': 300, 'distance-driven': 150, 'distance-remaining': 150, 'deadline': 220, 'expected-income': 300, 'game-time': 200});
  expect({slots: STRIP_TAG_SLOTS, tag: STRIP_TAG_MAX_WIDTH_CSS, row: STRIP_ROW_HEIGHT_CSS, border: STRIP_BORDER_CSS, padding: STRIP_PADDING_X_CSS,
    gap: STRIP_COLUMN_GAP_CSS}).toEqual({slots: 2, tag: 96, row: 36, border: 1, padding: 12, gap: 14});
});

it.each([
  // Inner 1254: tags, speed, gear, rpm, fuel, range, sdk = 1210; cargo, origin, destination, distance driven = 1092
  // (distance remaining would reach 1256); distance remaining, deadline, income, game time = 912.
  {name: 'every section at 1280 (1920 x 1080)', sections: ALL, width: 1280, rows: 3, height: 110},
  {name: 'every section at 1248 (1280 x 720)', sections: ALL, width: 1248, rows: 3, height: 110},
  {name: 'every section at 768 (800 x 600)', sections: ALL, width: 768, rows: 6, height: 218},
  {name: 'every section at 928 (960 x 540)', sections: ALL, width: 928, rows: 5, height: 182},
  {name: 'every section at 1247 (fractional client)', sections: ALL, width: 1247, rows: 3, height: 110},
  {name: 'every section at the 480 minimum', sections: ALL, width: 480, rows: 10, height: 362},
  {name: 'speed only at the 480 minimum', sections: only('speed'), width: 480, rows: 1, height: 38},
  {name: 'every section at 1258 (scale 1.5)', sections: ALL, width: 1258, rows: 3, height: 110},
  {name: 'every section at 944 (scale 2)', sections: ALL, width: 944, rows: 4, height: 146},
  {name: 'every section at 1279 (scale 1.1)', sections: ALL, width: 1279, rows: 3, height: 110},
  {name: 'speed only at 1279 (scale 1.01)', sections: only('speed'), width: 1279, rows: 1, height: 38},
  {name: 'driving-only at 768', sections: OVERLAY_PRESETS['driving-only'], width: 768, rows: 2, height: 74},
  {name: 'driving-only at 928', sections: OVERLAY_PRESETS['driving-only'], width: 928, rows: 2, height: 74},
  {name: 'driving-only at 1248', sections: OVERLAY_PRESETS['driving-only'], width: 1248, rows: 1, height: 38},
  {name: 'job-focus at 1280', sections: OVERLAY_PRESETS['job-focus'], width: 1280, rows: 2, height: 74},
  {name: 'all but RPM and cargo at 1280', sections: {...ALL, rpm: false, cargo: false}, width: 1280, rows: 3, height: 110}
])('reserves $rows rows for $name', ({sections, width, rows, height}) => {
  expect(stripRowCount(sections, width)).toBe(rows);
  expect(stripCssHeight(rows)).toBe(height);
});

it('fills a row exactly to the inner width and wraps one pixel below it', () => {
  // Driving-only: tags 96 + 96, speed 140, gear 90, rpm 130, fuel 190 and range 140 with six 14 px gaps = 966.
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 992)).toBe(1);
  expect(stripRowCount(OVERLAY_PRESETS['driving-only'], 991)).toBe(2);
});

it('reserves nothing when one item could not fit a row', () => {
  // Cargo, origin, destination and expected income are 300 wide: the inner width must be at least 300.
  expect(stripRowCount(ALL, 325)).toBeUndefined();
  expect(stripRowCount(ALL, 326)).toBeDefined();
  expect(stripRowCount(only('speed'), 325)).toBe(2);
  for (const width of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0]) expect(stripRowCount(ALL, width)).toBeUndefined();
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

it('matches the strip rules in renderer.css', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8');
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&');
    const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!match) throw new Error(`Missing rule ${selector}`);
    return match[1];
  };
  const row = rule('.overlay-strip-row');
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
});
