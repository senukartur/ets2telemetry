// A small deterministic generator for seeded test campaigns (mulberry32): the same seed always picks the same values, so
// a failure that prints its seed reproduces exactly. Not for anything but test inputs.

/** Returns a function that yields the next value in [0, 1) for this seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** An integer in [min, max] from a generator. */
export const between = (random: () => number, min: number, max: number) => min + Math.floor(random() * (max - min + 1));
/** One element of a non-empty list from a generator. */
export const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];
/**
 * A generator for seed number `seed` of a campaign: mulberry32 after spreading the seed with the 32-bit golden-ratio
 * multiplier, because the first values of mulberry32 for consecutive small seeds lie close together.
 */
export const campaignRandom = (seed: number) => mulberry32(Math.imul(seed, 0x9e3779b1));
