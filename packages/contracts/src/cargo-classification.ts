export const CARGO_GROUPS = ['adr', 'bulk', 'construction', 'containers', 'fragile', 'gooseneck', 'inloader', 'liquid',
  'livestock', 'machinery', 'oversize', 'refrigerated'] as const;
export type CargoGroup = typeof CARGO_GROUPS[number];
export const ADR_CLASSES = [1, 2, 3, 4, 6, 8] as const;
export type AdrClass = typeof ADR_CLASSES[number];

/** Versioned classification captured with the opening of a recorded job. Null at the transport boundary means unavailable. */
export interface CargoClassification {
  version: 1;
  fragility: number | null;
  fragile: boolean;
  valuable: boolean;
  adr: {state: 'none' | 'unsupported'} | {state: 'class'; class: AdrClass};
  overweight: boolean;
  oversize: boolean | null;
  groups: CargoGroup[];
}

export function fragileCargo(fragility: number | null): boolean {
  // SCS uses a float comparison and applies the default sensitivity to a defined cargo with no explicit value.
  return Math.fround(fragility ?? 1) >= Math.fround(0.7);
}

export function isCargoId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.]{0,127}$/.test(value);
}

const exact = (value: object, keys: string) => Object.keys(value).sort().join(',') === keys;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isAdrClass(value: unknown): value is AdrClass {
  return ADR_CLASSES.some(item => item === value);
}

export function isCargoClassification(value: unknown): value is CargoClassification {
  if (!record(value) || !exact(value, 'adr,fragile,fragility,groups,oversize,overweight,valuable,version') || value.version !== 1
    || value.fragility !== null && (typeof value.fragility !== 'number' || value.fragility < 0 || !Number.isFinite(Math.fround(value.fragility)))
    || value.fragile !== fragileCargo(value.fragility)
    || typeof value.valuable !== 'boolean' || typeof value.overweight !== 'boolean'
    || value.oversize !== null && typeof value.oversize !== 'boolean' || !record(value.adr)) return false;
  const {adr, groups} = value;
  if (adr.state === 'class' ? !exact(adr, 'class,state') || !isAdrClass(adr.class)
    : !exact(adr, 'state') || (adr.state !== 'none' && adr.state !== 'unsupported')) return false;
  if (!Array.isArray(groups) || groups.length > CARGO_GROUPS.length) return false;
  let last = -1;
  for (const group of groups as unknown[]) {
    const position = CARGO_GROUPS.findIndex(name => name === group);
    if (position <= last) return false;
    last = position;
  }
  return true;
}
