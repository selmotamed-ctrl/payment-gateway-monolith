import { currentLocale } from "./locale";

const pad = (value: number) => String(value).padStart(2, "0");

/** Calendar date as `YYYY-MM-DD` (local, no timezone drift). */
export const toIsoDate = (date: Date | string | null | undefined): string => {
    const parsed = typeof date === "string" ? fromIsoDate(date) : date;
    if (!parsed || Number.isNaN(parsed.getTime())) return "";
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
};

/**
 * Parses `YYYY-MM-DD` into a local Date. Impossible calendar dates
 * (`2026-02-31`) return `null` instead of silently rolling into March.
 */
export const fromIsoDate = (value: unknown): Date | null => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    // Local noon keeps the calendar day stable in every UTC offset.
    const date = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return date;
};

/** Local midnight of the given calendar day. */
export const startOfDay = (date: Date): Date =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

/** Local noon of the given calendar day (stable for date-only maths). */
export const startOfCalendarDay = (date: Date): Date =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);

export const sameDay = (a: Date | null | undefined, b: Date | null | undefined): boolean =>
    Boolean(
        a &&
            b &&
            a.getFullYear() === b.getFullYear() &&
            a.getMonth() === b.getMonth() &&
            a.getDate() === b.getDate(),
    );

export const addDays = (date: Date, days: number): Date => {
    const next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
    next.setDate(next.getDate() + days);
    return next;
};

export const todayIso = (): string => toIsoDate(new Date());

export type PgDateRange = { start: string; end: string };

export const lastNDaysRange = (days: number, end: Date = new Date()): PgDateRange => ({
    start: toIsoDate(addDays(end, -(Math.max(1, days) - 1))),
    end: toIsoDate(end),
});

export const last7Days = (end?: Date): PgDateRange => lastNDaysRange(7, end);
export const last30Days = (end?: Date): PgDateRange => lastNDaysRange(30, end);
export const last90Days = (end?: Date): PgDateRange => lastNDaysRange(90, end);
export const todayRange = (end: Date = new Date()): PgDateRange => ({ start: toIsoDate(end), end: toIsoDate(end) });

export const monthToDate = (end: Date = new Date()): PgDateRange => ({
    start: toIsoDate(new Date(end.getFullYear(), end.getMonth(), 1, 12)),
    end: toIsoDate(end),
});

export const lastMonth = (end: Date = new Date()): PgDateRange => ({
    start: toIsoDate(new Date(end.getFullYear(), end.getMonth() - 1, 1, 12)),
    end: toIsoDate(new Date(end.getFullYear(), end.getMonth(), 0, 12)),
});

export const quarterToDate = (end: Date = new Date()): PgDateRange => {
    const quarterStartMonth = Math.floor(end.getMonth() / 3) * 3;
    return { start: toIsoDate(new Date(end.getFullYear(), quarterStartMonth, 1, 12)), end: toIsoDate(end) };
};

export const yearToDate = (end: Date = new Date()): PgDateRange => ({
    start: toIsoDate(new Date(end.getFullYear(), 0, 1, 12)),
    end: toIsoDate(end),
});

export const shiftIsoMonth = (iso: string, months: number): string => {
    const date = fromIsoDate(iso) ?? new Date();
    const shifted = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
    return toIsoDate(shifted);
};

export const isoMonthKey = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;

const WEEKDAYS_LTR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;
const WEEKDAYS_AR = ["أحد", "اثن", "ثلا", "أرب", "خمي", "جمع", "سبت"] as const;

/**
 * The calendar grid is always Sunday→Saturday in English LTR. Arabic rotates
 * the labels but the grid still mirrors logically through CSS `direction`.
 */
export const weekdayLabels = (locale: "en" | "ar" = currentLocale.value): readonly string[] =>
    locale === "ar" ? WEEKDAYS_AR : WEEKDAYS_LTR;

export const MONTH_NAMES_EN = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
] as const;

export const monthLabel = (date: Date, locale: "en" | "ar" = currentLocale.value): string =>
    locale === "ar" ? `${date.getFullYear()} ${String(date.getMonth() + 1).padStart(2, "0")}` : `${MONTH_NAMES_EN[date.getMonth()]} ${date.getFullYear()}`;

/** Display `Nov 26, 2026` (or `2026-11-26` in Arabic) without UTC drift. */
export const formatDisplayDate = (iso: string, locale: "en" | "ar" = currentLocale.value): string => {
    const date = fromIsoDate(iso);
    if (!date) return "";
    if (locale === "ar") return toIsoDate(date);
    return `${MONTH_NAMES_EN[date.getMonth()]!.slice(0, 3)} ${String(date.getDate()).padStart(2, "0")}, ${date.getFullYear()}`;
};
