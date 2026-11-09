import { DEFAULT_BUSINESS_TIME_ZONE, localClock } from "../engine/workers/deadlines/businessTime";
import { addLocalDays, startOfLocalDay } from "../engine/workers/regulatory/periods";

/**
 * A small five-field cron (minute hour day-of-month month day-of-week) evaluated in a time zone (default
 * `Africa/Tripoli`), used by the statement schedule worker (AUTO-07). Syntax per field: `*`, `a`, `a-b`, `a,b,c`,
 * a step after a star or a range (`every n`), and `a/n`. Day-of-week 0 and 7 are Sunday. When both day-of-month and day-of-week are restricted a day
 * matches if EITHER does (standard cron).
 */
export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const BOUNDS: Array<[number, number, string]> = [
  [0, 59, "minute"],
  [0, 23, "hour"],
  [1, 31, "day-of-month"],
  [1, 12, "month"],
  [0, 7, "day-of-week"],
];

const parseField = (field: string, [min, max, name]: [number, number, string]): Set<number> => {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw new Error(`invalid cron ${name} field "${field}"`);
    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron ${name} step in "${field}"`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range!.includes("-")) {
      [from, to] = range!.split("-").map(Number) as [number, number];
    } else {
      from = Number(range);
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) throw new Error(`cron ${name} value out of range in "${field}"`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
};

export const parseCron = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`a cron expression has five fields, got ${fields.length}`);
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, index) => parseField(field, BOUNDS[index]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  return { minutes, hours, daysOfMonth, months, daysOfWeek, domRestricted: fields[2] !== "*", dowRestricted: fields[4] !== "*" };
};

const dayMatches = (cron: ParsedCron, date: string): boolean => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  if (!cron.months.has(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const dom = cron.daysOfMonth.has(day);
  const dow = cron.daysOfWeek.has(weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  return dom && dow;
};

/** Scheduled minutes (minutes since local midnight) of a matching day, ascending. */
const minutesOfDay = (cron: ParsedCron): number[] => {
  const out: number[] = [];
  for (const hour of [...cron.hours].sort((a, b) => a - b)) for (const minute of [...cron.minutes].sort((a, b) => a - b)) out.push(hour * 60 + minute);
  return out;
};

/**
 * The latest scheduled instant at or before `instant`, looking back at most `maxDays` days (null when none). Scheduled
 * times are local clock times: `0 6 * * *` is 06:00 in the zone.
 */
export const lastScheduledAtOrBefore = (
  cron: ParsedCron,
  instant: Date,
  options: { timeZone?: string; maxDays?: number } = {},
): Date | null => {
  const zone = options.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
  const local = localClock(instant, zone);
  const times = minutesOfDay(cron);
  let date = local.date;
  for (let back = 0; back <= (options.maxDays ?? 400); back += 1) {
    if (dayMatches(cron, date)) {
      const limit = back === 0 ? local.minutes : 1439;
      for (let index = times.length - 1; index >= 0; index -= 1) {
        if (times[index]! <= limit) return new Date(startOfLocalDay(date, zone).getTime() + times[index]! * 60_000);
      }
    }
    date = addLocalDays(date, -1);
  }
  return null;
};
