/**
 * A deliberately small five-field cron implementation.
 *
 * Supported field syntax:
 *   *            any value
 *   a            a single value
 *   a-b          inclusive range
 *   a,b,c        list of values/ranges
 *   * /n         every n values
 *   a-b/n        every n values inside a range
 *   a/n          every n values from a to the end of the field
 *
 * The parser has no external dependencies. Times are evaluated in UTC so the
 * schedule is deterministic regardless of the host timezone.
 */

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  daysOfMonthWildcard: boolean;
  daysOfWeekWildcard: boolean;
}

interface FieldBounds {
  min: number;
  max: number;
  name: string;
}

const FIELD_BOUNDS: FieldBounds[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 7, name: "day-of-week" },
];

const fail = (message: string): never => {
  throw new Error(`invalid cron expression: ${message}`);
};

const parseValue = (value: string, bounds: FieldBounds, field: string): number => {
  if (!/^\d+$/.test(value)) fail(`${bounds.name} field "${field}" contains a non-numeric value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    fail(`${bounds.name} value ${value} is outside ${bounds.min}-${bounds.max}`);
  }
  return parsed;
};

export const parseCronField = (field: string, bounds: FieldBounds): number[] => {
  const trimmed = field.trim();
  if (!trimmed) fail("empty field");
  const values = new Set<number>();

  for (const part of trimmed.split(",")) {
    if (!part) fail(`empty list entry in "${field}"`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) fail(`too many step separators in "${part}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) fail(`step "${stepPart}" is not a positive integer`);
      step = Number(stepPart);
      if (step < 1) fail(`step "${stepPart}" is not a positive integer`);
    }

    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = bounds.min;
      end = bounds.max;
    } else if (rangePart?.includes("-")) {
      const [startPart, endPart, extraRange] = rangePart.split("-");
      if (extraRange !== undefined) fail(`malformed range "${rangePart}"`);
      if (startPart === undefined || endPart === undefined) fail(`malformed range "${rangePart}"`);
      start = parseValue(startPart!, bounds, field);
      end = parseValue(endPart!, bounds, field);
      if (start > end) fail(`range "${rangePart}" is descending`);
    } else {
      start = parseValue(rangePart ?? "", bounds, field);
      end = stepPart === undefined ? start : bounds.max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return [...values].sort((left, right) => left - right);
};

export const parseCronExpression = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) fail("expected five fields (minute hour day-of-month month day-of-week)");

  const [minuteField = "", hourField = "", dayField = "", monthField = "", weekDayField = ""] = fields;
  const minutes = parseCronField(minuteField, FIELD_BOUNDS[0]!);
  const hours = parseCronField(hourField, FIELD_BOUNDS[1]!);
  const daysOfMonth = parseCronField(dayField, FIELD_BOUNDS[2]!);
  const months = parseCronField(monthField, FIELD_BOUNDS[3]!);
  const rawDaysOfWeek = parseCronField(weekDayField, FIELD_BOUNDS[4]!);
  const daysOfWeek = [...new Set(rawDaysOfWeek.map((value) => (value === 7 ? 0 : value)))].sort(
    (left, right) => left - right,
  );

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    daysOfMonthWildcard: dayField.startsWith("*"),
    daysOfWeekWildcard: weekDayField.startsWith("*"),
  };
};

export const parseCron = (expression: string): ParsedCron => parseCronExpression(expression);
export const parseCronExpressionFields = (expression: string): ParsedCron => parseCronExpression(expression);

const utcDayMatches = (date: Date, cron: ParsedCron): boolean => {
  const dayOfMonth = cron.daysOfMonth.includes(date.getUTCDate());
  const dayOfWeek = cron.daysOfWeek.includes(date.getUTCDay());
  if (cron.daysOfMonthWildcard && cron.daysOfWeekWildcard) return true;
  if (cron.daysOfMonthWildcard) return dayOfWeek;
  if (cron.daysOfWeekWildcard) return dayOfMonth;
  return dayOfMonth || dayOfWeek;
};

/**
 * Returns the first matching instant strictly after `from`, in UTC.
 */
export const nextCronRun = (expression: string, from: Date = new Date()): Date => {
  if (Number.isNaN(from.getTime())) fail("base date is invalid");
  const cron = parseCronExpression(expression);

  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const limit = new Date(from.getTime());
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);

  while (candidate.getTime() <= limit.getTime()) {
    if (!cron.months.includes(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!utcDayMatches(candidate, cron)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.includes(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.includes(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(candidate.getTime());
  }

  return fail(`no matching run within five years for "${expression}"`);
};

export const getNextCronRun = nextCronRun;
export const nextCronOccurrence = nextCronRun;
export const getNextRun = nextCronRun;
export const nextRun = nextCronRun;
export type CronExpression = ParsedCron;

export const isValidCronExpression = (expression: string): boolean => {
  try {
    parseCronExpression(expression);
    return true;
  } catch {
    return false;
  }
};

export const cronMatches = (expression: string, date: Date): boolean => {
  const cron = parseCronExpression(expression);
  return (
    cron.minutes.includes(date.getUTCMinutes()) &&
    cron.hours.includes(date.getUTCHours()) &&
    utcDayMatches(date, cron) &&
    cron.months.includes(date.getUTCMonth() + 1)
  );
};
