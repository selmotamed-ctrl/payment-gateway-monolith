import { DEFAULT_BUSINESS_TIME_ZONE, isBusinessDay, localClock, type BusinessCalendar } from "../deadlines/businessTime";

/**
 * Reporting periods and filing due dates in Libyan local time (AUTO-16). Boundaries are local midnights of
 * `Africa/Tripoli` (UTC+2, no daylight saving), expressed as UTC instants; a period is the half-open range `[start, end)`.
 */
export type ReturnPeriod = "MONTHLY" | "QUARTERLY" | "ANNUAL";

export interface ReportPeriod {
  /** Stable idempotency key: `2026-10`, `2026-Q3`, `2026`, or `2026-11-04` for a business-day batch. */
  key: string;
  start: Date;
  end: Date;
}

const pad = (value: number): string => String(value).padStart(2, "0");

const parseDate = (date: string): { year: number; month: number; day: number } => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return { year, month, day };
};

/** `YYYY-MM-DD` plus `days` calendar days (negative allowed). */
export const addLocalDays = (date: string, days: number): string => {
  const { year, month, day } = parseDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
};

/** The UTC instant at which local day `date` starts in `timeZone`. */
export const startOfLocalDay = (date: string, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): Date => {
  const { year, month, day } = parseDate(date);
  let guess = Date.UTC(year, month - 1, day);
  // The offset is found by looking at what local clock the guess shows, twice (the second pass absorbs a daylight-saving edge).
  for (let pass = 0; pass < 2; pass += 1) {
    const local = localClock(new Date(guess), timeZone);
    const shown = parseDate(local.date);
    const localAsUtc = Date.UTC(shown.year, shown.month - 1, shown.day) + local.minutes * 60_000 + local.seconds * 1000;
    guess -= localAsUtc - Date.UTC(year, month - 1, day);
  }
  return new Date(guess);
};

/** Today's local date. */
export const localDate = (instant: Date, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): string => localClock(instant, timeZone).date;

const periodBounds = (period: ReturnPeriod, year: number, indexInYear: number): { startDate: string; endDate: string; key: string } => {
  if (period === "MONTHLY") {
    const month = indexInYear + 1;
    return {
      startDate: `${year}-${pad(month)}-01`,
      endDate: month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`,
      key: `${year}-${pad(month)}`,
    };
  }
  if (period === "QUARTERLY") {
    const firstMonth = indexInYear * 3 + 1;
    return {
      startDate: `${year}-${pad(firstMonth)}-01`,
      endDate: firstMonth + 3 > 12 ? `${year + 1}-01-01` : `${year}-${pad(firstMonth + 3)}-01`,
      key: `${year}-Q${indexInYear + 1}`,
    };
  }
  return { startDate: `${year}-01-01`, endDate: `${year + 1}-01-01`, key: String(year) };
};

/** The `count` most recent CLOSED periods (end at or before `now`), newest first. */
export const closedPeriods = (
  period: ReturnPeriod,
  now: Date,
  count: number,
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
): ReportPeriod[] => {
  const { year, month } = parseDate(localDate(now, timeZone));
  const perYear = period === "MONTHLY" ? 12 : period === "QUARTERLY" ? 4 : 1;
  const current = period === "MONTHLY" ? month - 1 : period === "QUARTERLY" ? Math.floor((month - 1) / 3) : 0;
  const result: ReportPeriod[] = [];
  for (let back = 1; back <= count; back += 1) {
    const absolute = year * perYear + current - back;
    const bounds = periodBounds(period, Math.floor(absolute / perYear), ((absolute % perYear) + perYear) % perYear);
    const end = startOfLocalDay(bounds.endDate, timeZone);
    if (end.getTime() > now.getTime()) continue;
    result.push({ key: bounds.key, start: startOfLocalDay(bounds.startDate, timeZone), end });
  }
  return result;
};

/** The filing due instant: `dueDays` local days after the period end (the end of local day `dueDays`). */
export const dueAfterPeriod = (end: Date, dueDays: number, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): Date =>
  startOfLocalDay(addLocalDays(localDate(end, timeZone), Math.max(0, Math.floor(dueDays))), timeZone);

/**
 * Business-day batches (the large-transaction report): the batch of business day B covers B's midnight up to the
 * midnight of the NEXT business day (so a Thursday batch also holds the Friday and Saturday weekend), and it is
 * complete once that instant has passed. Returns the `count` most recent complete batches, newest first.
 */
export const businessDayBatches = (
  now: Date,
  count: number,
  calendar: BusinessCalendar = {},
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
): ReportPeriod[] => {
  const tz = calendar.timeZone ?? timeZone;
  const dayInfo = (date: string) => ({ date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() });
  const isBusiness = (date: string): boolean => isBusinessDay(dayInfo(date), calendar);
  const result: ReportPeriod[] = [];
  let cursor = localDate(now, tz);
  for (let scanned = 0; scanned < 90 && result.length < count; scanned += 1) {
    cursor = addLocalDays(cursor, -1);
    if (!isBusiness(cursor)) continue;
    let next = addLocalDays(cursor, 1);
    for (let guard = 0; guard < 30 && !isBusiness(next); guard += 1) next = addLocalDays(next, 1);
    const end = startOfLocalDay(next, tz);
    if (end.getTime() > now.getTime()) continue;
    result.push({ key: cursor, start: startOfLocalDay(cursor, tz), end });
  }
  return result;
};

/** Due date of a business-day batch: the end of the first business day after the batch closes ("next business day"). */
export const dueAfterBatch = (
  end: Date,
  calendar: BusinessCalendar = {},
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
): Date => {
  const tz = calendar.timeZone ?? timeZone;
  let date = localDate(end, tz);
  for (let guard = 0; guard < 30; guard += 1) {
    if (isBusinessDay({ date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() }, calendar)) break;
    date = addLocalDays(date, 1);
  }
  return startOfLocalDay(addLocalDays(date, 1), tz);
};

/** Subtracts `days` BUSINESS days from `instant` (the reminder lead: due minus 3 business days), landing on local midnight. */
export const minusBusinessDays = (
  instant: Date,
  days: number,
  calendar: BusinessCalendar = {},
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
): Date => {
  const tz = calendar.timeZone ?? timeZone;
  let date = localDate(instant, tz);
  let remaining = Math.max(0, Math.floor(days));
  for (let guard = 0; guard < 400 && remaining > 0; guard += 1) {
    date = addLocalDays(date, -1);
    if (isBusinessDay({ date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay() }, calendar)) remaining -= 1;
  }
  return startOfLocalDay(date, tz);
};
