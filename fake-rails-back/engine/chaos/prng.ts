/**
 * Small deterministic PRNG (mulberry32) plus weighted samplers.
 *
 * The seeder and the chaos engine both need reproducible draws. A seeded
 * generator makes a scenario suite replayable: the same seed always produces
 * the same fate for the same transaction.
 */
export class Prng {
  private state: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === "number" ? seed : hashString(seed);
    this.state = numeric >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }

  chance(percent: number): boolean {
    return this.next() * 100 < percent;
  }

  weighted<T extends string>(weights: Record<T, number>): T | undefined {
    const entries = Object.entries(weights).filter(([, weight]) => Number(weight) > 0) as Array<[T, number]>;
    if (entries.length === 0) return undefined;
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

export const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

export const randomSeed = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
