/**
 * Business time in the Libyan week (AUTO-04, decision D2): Sunday to Thursday are business days, Friday and Saturday
 * are the weekend, and a platform-setting holiday calendar removes further days. All day boundaries are local
 * (`Africa/Tripoli` by default, UTC+2 with no daylight saving).
 */

export const DEFAULT_BUSINESS_TIME_ZONE = "Africa/Tripoli";

/** JavaScript weekday numbers (0 = Sunday) that are business days in Libya. */
export const LIBYAN_BUSINESS_WEEKDAYS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4]);

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalClock {
  /** `YYYY-MM-DD` of the local calendar day. */
  date: string;
  /** 0 = Sunday ... 6 = Saturday. */
  weekday: number;
  /** Minutes since local midnight, 0..1439. */
  minutes: number;
  /** Seconds past the minute (so a segment end can be computed to the second). */
  seconds: number;
}

export const localClock = (instant: Date, timeZone: string = DEFAULT_BUSINESS_TIME_ZONE): LocalClock => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
    seconds: Number(get("second")),
  };
};

export interface BusinessCalendar {
  timeZone?: string;
  /** `YYYY-MM-DD` dates that are not business days. */
  holidays?: ReadonlySet<string>;
  /** Defaults to Sunday..Thursday. */
  businessWeekdays?: ReadonlySet<number>;
}

export const isBusinessDay = (clock: Pick<LocalClock, "date" | "weekday">, calendar: BusinessCalendar = {}): boolean =>
  (calendar.businessWeekdays ?? LIBYAN_BUSINESS_WEEKDAYS).has(clock.weekday) && !(calendar.holidays?.has(clock.date) ?? false);

/**
 * Hours between `start` and `end` that fall on business days (the time of a weekend or a holiday does not count).
 * Walks the local days, so a request made on Thursday evening and still open on Sunday morning has run for the hours
 * of Thursday evening plus Sunday morning only.
 */
export const businessHoursBetween = (start: Date, end: Date, calendar: BusinessCalendar = {}): number => {
  if (!(end.getTime() > start.getTime())) return 0;
  const timeZone = calendar.timeZone ?? DEFAULT_BUSINESS_TIME_ZONE;
  let cursor = start.getTime();
  const endMs = end.getTime();
  let total = 0;
  // Bounded: a cash-out is never open for years, and a guard keeps a bad input from looping.
  for (let guard = 0; cursor < endMs && guard < 4000; guard += 1) {
    const local = localClock(new Date(cursor), timeZone);
    const sinceMidnightMs = (local.minutes * 60 + local.seconds) * 1000 + (cursor % 1000);
    const nextMidnight = cursor - sinceMidnightMs + 24 * 3_600_000;
    const segmentEnd = Math.min(endMs, nextMidnight);
    if (isBusinessDay(local, calendar)) total += (segmentEnd - cursor) / 3_600_000;
    cursor = segmentEnd;
  }
  return total;
};

/** Parses the `calendar.holidays` platform setting (an array of `YYYY-MM-DD`, ignoring anything malformed). */
export const parseHolidays = (value: unknown): Set<string> => {
  const holidays = new Set<string>();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry)) holidays.add(entry);
    }
  }
  return holidays;
};
