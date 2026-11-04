import type { Prng } from "./prng";

/**
 * The chronological clock of the simulation.
 *
 * It models the Libyan market rhythm: the multi-year adoption curve, the
 * Friday prayer dip, Ramadan / pre-Eid / salary-day spikes and the Eid
 * holiday trough.
 *
 * Every "local" hour is an `Africa/Tripoli` wall-clock hour. Libya has used
 * UTC+2 all year (no DST) since 2013, so a local hour is stored as
 * `hour - 2` UTC. (The previous clock wrote the Tripoli hour straight into
 * the UTC field, which shifted every business-hours chart by two hours.)
 */

export const TRIPOLI_UTC_OFFSET_HOURS = 2;
const OFFSET_MS = TRIPOLI_UTC_OFFSET_HOURS * 3_600_000;

export interface TimelineConfig {
  start: Date;
  end: Date;
  months: number;
}

export const buildTimeline = (now: Date, yearsSpan: number): TimelineConfig => {
  const months = Math.max(1, Math.round(yearsSpan * 12));
  const start = new Date(now);
  start.setUTCMonth(start.getUTCMonth() - months);
  // 08:00 Tripoli on the first simulated day.
  start.setUTCHours(8 - TRIPOLI_UTC_OFFSET_HOURS, 0, 0, 0);
  return { start, end: new Date(now), months };
};

/** The Tripoli calendar day of a UTC instant, as a `Date.UTC(y, m, d)` key. */
export const tripoliDay = (instant: Date): Date => {
  const shifted = new Date(instant.getTime() + OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
};

/** The Tripoli wall-clock hour (0-23) of a UTC instant. */
export const tripoliHour = (instant: Date): number => new Date(instant.getTime() + OFFSET_MS).getUTCHours();

/** Converts a Tripoli calendar day + wall-clock time into the UTC instant. */
export const tripoliDateTime = (day: Date, hour: number, minute: number, second: number): Date =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, second) - OFFSET_MS);

/** Legacy alias: the old API took a day and an hour; the hour is now Tripoli time. */
export const dateAt = tripoliDateTime;

const ymd = (date: Date): number => date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

/** Ramadan (first day, last day) per Gregorian year, Libyan moon-sighting approximations. */
const RAMADAN: Record<number, [number, number]> = {
  2021: [20210413, 20210512],
  2022: [20220402, 20220501],
  2023: [20230323, 20230420],
  2024: [20240311, 20240409],
  2025: [20250301, 20250329],
  2026: [20260218, 20260319],
  2027: [20270208, 20270309],
  2028: [20280128, 20280225],
};
/** Eid al-Fitr and Eid al-Adha (first day) per year. */
const EIDS: Record<number, [number, number]> = {
  2021: [20210513, 20210720],
  2022: [20220502, 20220709],
  2023: [20230421, 20230628],
  2024: [20240410, 20240616],
  2025: [20250330, 20250606],
  2026: [20260320, 20260527],
  2027: [20270310, 20270516],
  2028: [20280226, 20280505],
};

const dayNumber = (value: number): number => {
  const year = Math.floor(value / 10_000);
  const month = Math.floor((value % 10_000) / 100) - 1;
  const day = value % 100;
  return Date.UTC(year, month, day) / 86_400_000;
};

export const isRamadan = (day: Date): boolean => {
  const window = RAMADAN[day.getUTCFullYear()];
  if (!window) return false;
  const value = ymd(day);
  return value >= window[0] && value <= window[1];
};

/** The ten days before Eid al-Adha (Eid al-Fitr's run-up is already Ramadan). */
export const isPreEidAdha = (day: Date): boolean => {
  const eids = EIDS[day.getUTCFullYear()];
  if (!eids) return false;
  const delta = dayNumber(eids[1]) - Math.floor(day.getTime() / 86_400_000);
  return delta >= 1 && delta <= 10;
};

/** The first three Eid days: shops close, collections dip. */
export const isEidHoliday = (day: Date): boolean => {
  const eids = EIDS[day.getUTCFullYear()];
  if (!eids) return false;
  const today = Math.floor(day.getTime() / 86_400_000);
  return eids.some((eid) => {
    const delta = today - dayNumber(eid);
    return delta >= 0 && delta <= 2;
  });
};

/** 1.0 at launch, growing to 8x by the end of the simulation. */
export const adoptionMultiplier = (monthIndex: number, months: number): number => {
  const progress = Math.min(1, Math.max(0, monthIndex / Math.max(1, months - 1)));
  return 1 + 7 * progress * progress;
};

/** The per-day volume multiplier (weekday rhythm + seasonality) of a Tripoli calendar day. */
export const dayVolumeMultiplier = (date: Date, monthIndex: number, months: number): number => {
  const day = tripoliDay(date);
  const weekday = day.getUTCDay(); // 0 Sunday, 5 Friday, 6 Saturday
  let multiplier = adoptionMultiplier(monthIndex, months);
  if (weekday === 5) multiplier *= 0.72;
  if (weekday === 6) multiplier *= 1.05;
  const dom = day.getUTCDate();
  if (dom >= 25 || dom <= 3) multiplier *= 1.35;
  if (isEidHoliday(day)) multiplier *= 0.55;
  else if (isRamadan(day)) multiplier *= 1.8;
  else if (isPreEidAdha(day)) multiplier *= 1.5;
  return multiplier;
};

/**
 * The Tripoli local hour of a generated event. Outside Ramadan the peak is
 * the early afternoon and the evening; during Ramadan activity moves to the
 * hours after iftar. Fridays skip the 11:30-14:30 prayer window.
 */
export const businessHour = (rng: Prng, day?: Date): number => {
  const ramadan = day ? isRamadan(day) : false;
  const friday = day ? day.getUTCDay() === 5 : false;
  const roll = rng.next();
  let hour: number;
  if (ramadan) {
    if (roll < 0.05) hour = rng.int(2, 9);
    else if (roll < 0.25) hour = rng.int(10, 15);
    else if (roll < 0.35) hour = rng.int(16, 18);
    else if (roll < 0.85) hour = rng.int(19, 23);
    else hour = rng.int(0, 1);
  } else if (roll < 0.04) hour = rng.int(0, 7);
  else if (roll < 0.2) hour = rng.int(8, 11);
  else if (roll < 0.55) hour = rng.int(12, 16);
  else if (roll < 0.93) hour = rng.int(17, 21);
  else hour = rng.int(22, 23);
  if (friday && hour >= 11 && hour <= 14 && rng.chance(80)) hour = rng.int(15, 21);
  return hour;
};

export interface DayBucket {
  /** The Tripoli calendar day (`Date.UTC(y, m, d)`). */
  date: Date;
  monthIndex: number;
  multiplier: number;
}

export const iterateDays = (timeline: TimelineConfig): DayBucket[] => {
  const days: DayBucket[] = [];
  const cursor = tripoliDay(timeline.start);
  const last = tripoliDay(timeline.end);
  let monthIndex = 0;
  let lastMonth = cursor.getUTCMonth();
  while (cursor <= last) {
    if (cursor.getUTCMonth() !== lastMonth) {
      monthIndex += 1;
      lastMonth = cursor.getUTCMonth();
    }
    days.push({
      date: new Date(cursor),
      monthIndex,
      multiplier: dayVolumeMultiplier(new Date(cursor.getTime() + 12 * 3_600_000 - OFFSET_MS), monthIndex, timeline.months),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
};

/** Never later than the simulation clock. */
export const clampToEnd = (timeline: TimelineConfig, value: Date): Date =>
  value.getTime() > timeline.end.getTime() ? new Date(timeline.end) : value;
