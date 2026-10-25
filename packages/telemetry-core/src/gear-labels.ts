// Gearbox-aware gear labels (ET-050b, decisions B3–B5). The SDK carries no gear names, only the H-shifter slot table
// (handle position and selector bits per gear) and the gear counts, so the labels are an inference from that table:
// a crawler, range-splitter numbering and L/H suffixes. Any layout this derivation does not recognize gives
// `undefined`, and the caller falls back to the ET-050 GD2 formula. Labels are display text only; storage, samples,
// the journal and the export keep the raw gear index.
import type {GearboxState, HShifterLayout, HShifterSlot} from '../../contracts/src/protocol-v1';

/** Display labels by gear: forward gears 1..F and reverse gears 1..R (the absolute value of the negative index). */
export interface GearLabels {forward: ReadonlyMap<number, string>; reverse: ReadonlyMap<number, string>}

/**
 * The crawler names (B5): one constant for both games, which an ETS2 crawler observation may change. `single` names a
 * crawler cell without a splitter pair; `low` and `high` name its lower and higher splitter gear.
 */
export const CRAWLER_LABELS = {single: 'L', low: 'LL', high: 'LH'} as const;

interface Cell {low: boolean; split: Map<number, number>}
interface SlotLabel {label: string; crawler: boolean; number: number; higher: boolean}

/**
 * A selector bit's class from its same-position forward pairs (step 2): `unused` when no pair holds two different
 * gears, and undefined when its pairs differ both by 1 and by more.
 */
function classifyBit(forward: readonly HShifterSlot[], bySelectors: ReadonlyMap<number, number>, bit: number): 'splitter' | 'range' | 'unused' | undefined {
  let splitter = 0, range = 0;
  for (const slot of forward) {
    if ((slot.selectors & bit) !== 0) continue;
    const other = bySelectors.get(slot.handlePosition * 64 + (slot.selectors | bit));
    if (other === undefined || other <= 0) continue;
    const delta = Math.abs(other - slot.gear);
    // Equal gears in both states carry no information about the bit (a cell without a split, step 6).
    if (delta === 1) splitter++;
    else if (delta > 1) range++;
  }
  if (splitter > 0 && range === 0) return 'splitter';
  if (range > 0 && splitter === 0) return 'range';
  return splitter === 0 && range === 0 ? 'unused' : undefined;
}

function derive(forwardGears: number, reverseGears: number, layout: HShifterLayout): GearLabels | undefined {
  const {selectorCount, slots} = layout;
  if (!Number.isSafeInteger(forwardGears) || forwardGears < 0 || !Number.isSafeInteger(reverseGears) || reverseGears < 0) return undefined;
  if (!Number.isSafeInteger(selectorCount) || selectorCount < 0 || selectorCount > 6) return undefined;
  // Step 1: every slot is well formed, each (position, selectors) pair is unique, and the slot gears are exactly
  // 1..F and −1..−R.
  const bySelectors = new Map<number, number>();
  const forwardSeen = new Set<number>(), reverseSeen = new Set<number>();
  for (const slot of slots) {
    const {gear, handlePosition, selectors} = slot;
    if (!Number.isSafeInteger(gear) || gear === 0 || !Number.isSafeInteger(handlePosition) || handlePosition < 0 ||
      !Number.isSafeInteger(selectors) || selectors < 0 || selectors >= 2 ** selectorCount) return undefined;
    const key = handlePosition * 64 + selectors;
    if (bySelectors.has(key)) return undefined;
    bySelectors.set(key, gear);
    if (gear > forwardGears || -gear > reverseGears) return undefined;
    (gear > 0 ? forwardSeen : reverseSeen).add(Math.abs(gear));
  }
  if (forwardSeen.size !== forwardGears || reverseSeen.size !== reverseGears) return undefined;
  const forward = slots.filter(slot => slot.gear > 0);
  // Step 2: classify each selector bit from the forward gears; reverse gears are always R1..Rn (B4). A bit that never
  // changes a forward gear, because its slots are neutral or repeat the gear, is unused and ignored (review amendment).
  let rangeBit: number | undefined, splitterBit: number | undefined;
  for (let index = 0; index < selectorCount; index++) {
    const bit = 1 << index, kind = classifyBit(forward, bySelectors, bit);
    if (kind === undefined) return undefined;
    if (kind === 'unused') continue;
    if (kind === 'range') { if (rangeBit !== undefined) return undefined; rangeBit = bit; }
    else { if (splitterBit !== undefined) return undefined; splitterBit = bit; }
  }
  const reverse = new Map<number, string>();
  for (let gear = 1; gear <= reverseGears; gear++) reverse.set(gear, `R${gear}`);
  if (forward.length === 0) return {forward: new Map(), reverse};
  // Step 3: the low range is the range state that holds gear 1.
  const rangeState = (slot: HShifterSlot) => rangeBit !== undefined && (slot.selectors & rangeBit) !== 0;
  const firstSlot = forward.find(slot => slot.gear === 1);
  if (firstSlot === undefined) return undefined;
  const lowState = rangeState(firstSlot);
  const cells = new Map<number, {low?: Cell; high?: Cell}>();
  for (const slot of forward) {
    const low = rangeState(slot) === lowState;
    const position = cells.get(slot.handlePosition) ?? {};
    cells.set(slot.handlePosition, position);
    const cell = (low ? position.low : position.high) ?? {low, split: new Map<number, number>()};
    if (low) position.low = cell; else position.high = cell;
    const state = splitterBit !== undefined && (slot.selectors & splitterBit) !== 0 ? 1 : 0;
    // Ignored bits may fold several slots into one cell state; they must agree on the gear.
    const held = cell.split.get(state);
    if (held !== undefined && held !== slot.gear) return undefined;
    cell.split.set(state, slot.gear);
  }
  const minGear = (cell: Cell) => Math.min(...cell.split.values());
  // Step 4: with a range bit, a position without high-range gears is the crawler, which needs gears below every other
  // position's low-range gears. More than one such position is unrecognized (B5).
  let crawler: number | undefined;
  if (rangeBit !== undefined) {
    const lowOnly = [...cells].filter(([, position]) => position.high === undefined).map(([handle]) => handle);
    if (lowOnly.length > 1) return undefined;
    crawler = lowOnly[0];
  }
  const others = [...cells].filter(([handle]) => handle !== crawler);
  // Step 5: every other position needs a low-range cell, and both ranges when a range bit exists.
  const numbered: {handle: number; low: Cell; high?: Cell}[] = [];
  for (const [handle, position] of others) {
    if (position.low === undefined || (rangeBit !== undefined && position.high === undefined)) return undefined;
    numbered.push({handle, low: position.low, high: position.high});
  }
  if (crawler !== undefined) {
    const crawlerCell = cells.get(crawler)?.low;
    if (crawlerCell === undefined) return undefined;
    const top = Math.max(...crawlerCell.split.values());
    if (numbered.some(position => minGear(position.low) <= top)) return undefined;
  }
  numbered.sort((a, b) => minGear(a.low) - minGear(b.low));
  const count = numbered.length;
  // Step 6: L/H only where both splitter states of a cell map to distinct gears.
  const labels = new Map<number, SlotLabel>();
  const assign = (cell: Cell, crawlerCell: boolean, number: number): boolean => {
    const states = [...cell.split.values()];
    const split = states.length === 2 && states[0] !== states[1];
    for (const gear of states) {
      const higher = split && gear === Math.max(...states);
      const label = crawlerCell
        ? (split ? (higher ? CRAWLER_LABELS.high : CRAWLER_LABELS.low) : CRAWLER_LABELS.single)
        : `${number}${split ? (higher ? 'H' : 'L') : ''}`;
      const previous = labels.get(gear);
      // A gear in several slots must get one label.
      if (previous !== undefined && previous.label !== label) return false;
      labels.set(gear, {label, crawler: crawlerCell, number, higher});
    }
    return true;
  };
  const crawlerCell = crawler === undefined ? undefined : cells.get(crawler)?.low;
  if (crawlerCell !== undefined && !assign(crawlerCell, true, 0)) return undefined;
  for (const [rank, position] of numbered.entries()) {
    if (!assign(position.low, false, rank + 1)) return undefined;
    if (position.high !== undefined && !assign(position.high, false, count + rank + 1)) return undefined;
  }
  // Ascending gears must give strictly ascending labels: crawler first, then by number, L before H. This rejects a
  // range or splitter direction that differs between positions and two gears that share a label.
  const forwardLabels = new Map<number, string>();
  let previous: SlotLabel | undefined;
  for (let gear = 1; gear <= forwardGears; gear++) {
    const current = labels.get(gear);
    if (current === undefined) return undefined;
    if (previous !== undefined) {
      const order = Number(current.crawler === false) - Number(previous.crawler === false) || current.number - previous.number ||
        Number(current.higher) - Number(previous.higher);
      if (order <= 0) return undefined;
    }
    forwardLabels.set(gear, current.label);
    previous = current;
  }
  return {forward: forwardLabels, reverse};
}

interface CacheEntry {forwardGears: number; reverseGears: number; labels: GearLabels | undefined}
const cache = new WeakMap<HShifterLayout, CacheEntry>();

/**
 * Derives display labels from a gearbox reading (ET-050b B3–B5), or returns `undefined` when the counts or the
 * H-shifter layout are unavailable or the layout is not recognized:
 * 1. the slot gears are exactly forward 1..F and reverse −1..−R, with one slot per (handle position, selectors) pair;
 * 2. each selector bit is a splitter when its same-position forward pairs differ by 1 and a range when they differ
 *    by more; a bit without a pair of different gears is unused and ignored, while a bit with both kinds or a second
 *    bit of the same kind is unrecognized, and so is a cell whose ignored bits map different gears to one state;
 * 3. the low range is the range state that holds gear 1;
 * 4. with a range bit, the one handle position without high-range gears is the crawler, whose gears lie below every
 *    other position's low-range gears; two such positions are unrecognized;
 * 5. the other positions are numbered 1..n in the low range by ascending gear and n+1..2n in the high range;
 * 6. a cell whose two splitter states map to distinct gears gets L (lower) and H (higher);
 * 7. the crawler is `L` without a splitter pair and `LL`/`LH` with one; reverse is R1..Rn; neutral stays N.
 * The result is memoized in a WeakMap keyed by the layout object's identity and shared, so callers must not change
 * the result, and a layout must not be mutated in place after it is passed here. A new layout object per update
 * simply misses the cache and is derived again, which is cheap.
 */
export function deriveGearLabels(gearbox: GearboxState): GearLabels | undefined {
  const {forwardGears, reverseGears, hshifter} = gearbox;
  if (!forwardGears.available || !reverseGears.available || !hshifter.available) return undefined;
  const layout = hshifter.value;
  const cached = cache.get(layout);
  if (cached !== undefined && cached.forwardGears === forwardGears.value && cached.reverseGears === reverseGears.value) return cached.labels;
  const labels = derive(forwardGears.value, reverseGears.value, layout);
  cache.set(layout, {forwardGears: forwardGears.value, reverseGears: reverseGears.value, labels});
  return labels;
}
