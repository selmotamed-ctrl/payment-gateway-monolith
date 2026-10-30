/**
 * Deterministic xoshiro128** PRNG.
 *
 * The same `SYNTHETIC_SEED_KEY` always yields the same 3.5-year history, so a
 * demo environment can be rebuilt byte-for-byte and a failing assertion can be
 * replayed.
 */
const splitmix32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
};

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export class Prng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === "number" ? seed : hashString(seed);
    const next = splitmix32(numeric);
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
  }

  next(): number {
    const result = Math.imul(this.rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = this.rotl(this.s3, 11);
    return result / 4294967296;
  }

  private rotl(value: number, bits: number): number {
    return ((value << bits) | (value >>> (32 - bits))) >>> 0;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  chance(percent: number): boolean {
    return this.next() * 100 < percent;
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }

  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights).filter(([, weight]) => Number(weight) > 0) as Array<[T, number]>;
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1]![0];
  }

  /** A decimal string with the given number of fraction digits. */
  decimal(min: number, max: number, digits = 4): string {
    const value = min + this.next() * (max - min);
    return value.toFixed(digits);
  }

  /** Deterministic RFC-4122-shaped id (v7-like prefix, counter suffix). */
  id(prefix = "00000000-0000-7000-8000-"): string {
    return `${prefix}${Math.floor(this.next() * 0xffffffffffff).toString(16).padStart(12, "0")}`;
  }
}

export const uuid = (seed: string): string => {
  const rng = new Prng(seed);
  const hex = Array.from({ length: 32 }, () => Math.floor(rng.next() * 16).toString(16)).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
