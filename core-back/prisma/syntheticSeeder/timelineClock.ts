import type { Prng } from "./prng";

/**
 * The chronological clock of the simulation.
 *
 * It models the Libyan market rhythm: the 3.5-year S-curve adoption, the
 * Saturday-Thursday peak, the Friday prayer dip, Ramadan/Eid and salary-day
 * spikes, and the four historical outage epochs.
 */

export interface TimelineConfig {
  start: Date;
  end: Date;
  months: number;
}

export const buildTimeline = (now: Date, yearsSpan: number): TimelineConfig => {
  const months = Math.max(1, Math.round(yearsSpan * 12));
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - months);
  start.setUTCHours(8, 0, 0, 0);
  return { start, end: now, months };
};

const isRamadan = (date: Date): boolean => {
  // Approximation of the Ramadan windows in the simulated 2023-2026 range.
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const windows: Record<number, [number, number, number, number]> = {
    2023: [3, 23, 4, 21],
    2024: [3, 11, 4, 9],
    2025: [3, 1, 3, 30],
    2026: [2, 18, 3, 19],
  };
  const window = windows[year];
  if (!window) return false;
  const [startMonth, startDay, endMonth, endDay] = window;
  const value = month * 100 + day;
  return value >= startMonth * 100 + startDay && value <= endMonth * 100 + endDay;
};

const isEidWindow = (date: Date): boolean => {
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  // The last ten days before Eid al-Fitr / Eid al-Adha.
  return (month === 4 && day >= 10) || (month === 6 && day >= 5 && day <= 15);
};

/** 1.0 at launch, growing to ~8x by the end of the simulation. */
export const adoptionMultiplier = (monthIndex: number, months: number): number => {
  const progress = Math.min(1, Math.max(0, monthIndex / Math.max(1, months - 1)));
  return 1 + 7 * progress * progress;
};

/** The per-day volume multiplier (weekday rhythm + seasonality). */
export const dayVolumeMultiplier = (date: Date, monthIndex: number, months: number): number => {
  const weekday = date.getUTCDay(); // 0 Sunday, 5 Friday, 6 Saturday
  let multiplier = adoptionMultiplier(monthIndex, months);
  if (weekday === 5) multiplier *= 0.72;
  if (weekday === 6) multiplier *= 1.05;
  const day = date.getUTCDate();
  if (day >= 25 || day <= 3) multiplier *= 1.35;
  if (isRamadan(date)) multiplier *= 1.8;
  if (isEidWindow(date)) multiplier *= 1.5;
  return multiplier;
};

/** The Tripoli local hour of a generated event. */
export const businessHour = (rng: Prng): number => {
  const roll = rng.next();
  if (roll < 0.08) return rng.int(0, 8);
  if (roll < 0.2) return rng.int(9, 11);
  if (roll < 0.55) return rng.int(12, 16);
  if (roll < 0.9) return rng.int(17, 22);
  return rng.int(22, 23);
};

export const dateAt = (day: Date, hour: number, minute: number, second: number): Date => {
  const value = new Date(day);
  value.setUTCHours(hour, minute, second, 0);
  return value;
};

export interface DayBucket {
  date: Date;
  monthIndex: number;
  multiplier: number;
}

export const iterateDays = (timeline: TimelineConfig): DayBucket[] => {
  const days: DayBucket[] = [];
  const cursor = new Date(timeline.start);
  let monthIndex = 0;
  let lastMonth = cursor.getUTCMonth();
  while (cursor <= timeline.end) {
    if (cursor.getUTCMonth() !== lastMonth) {
      monthIndex += 1;
      lastMonth = cursor.getUTCMonth();
    }
    days.push({
      date: new Date(cursor),
      monthIndex,
      multiplier: dayVolumeMultiplier(cursor, monthIndex, timeline.months),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};
