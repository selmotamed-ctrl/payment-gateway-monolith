/** Locale-aware date helpers shared by the Academy pages (formerly exported from ExamBriefing). */

export const fmtDateTime = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
};

export const fmtDate = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(date);
};

/** Short numeric date used in compact chips and tables. */
export const fmtDateShort = (value: string | null | undefined): string => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(date);
};

export const percent = (value: number, max: number): number => (max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0);

/**
 * Wrap authored (English-only) content, such as a lesson title, in a Unicode first-strong isolate before
 * it is interpolated into a translated sentence, so Arabic punctuation never jumps around it in RTL.
 */
export const isolate = (text: string): string => `⁨${text}⁩`;
