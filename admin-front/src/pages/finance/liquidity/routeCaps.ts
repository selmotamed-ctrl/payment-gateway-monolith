import Decimal from "decimal.js";

/** One row of `GET /finance/route-caps` (money as 4-decimal strings, utilisation in percent). */
export interface RouteCapRow {
    routeId: string;
    railCode: string;
    gatewayId: string;
    dailyCapAmount: string | null;
    dailyProcessedAmount: string;
    dailyCapRemaining: string | null;
    capExhausted: boolean;
    exclusionReason: string | null;
    utilisation: string | null;
}

export type CapTone = "success" | "warning" | "danger" | "neutral";

export interface RouteCapView {
    routeId: string;
    railCode: string;
    gatewayId: string;
    capped: boolean;
    cap: string | null;
    processed: string;
    remaining: string | null;
    /** 0..100, clamped for the progress bar; the real figure can exceed 100. */
    barPercent: number;
    utilisationLabel: string;
    exhausted: boolean;
    tone: CapTone;
}

const safeDecimal = (value: string | null | undefined): Decimal | null => {
    if (value === null || value === undefined || value === "") return null;
    try {
        return new Decimal(value);
    } catch {
        return null;
    }
};

/** 100%+ (or the server's DAILY_CAP_EXCEEDED) is a hard stop, 80%+ a warning. */
export const capTone = (percent: number | null, exhausted: boolean): CapTone => {
    if (exhausted) return "danger";
    if (percent === null) return "neutral";
    if (percent >= 100) return "danger";
    if (percent >= 80) return "warning";
    return "success";
};

export const toCapView = (row: RouteCapRow): RouteCapView => {
    const cap = safeDecimal(row.dailyCapAmount);
    const processed = safeDecimal(row.dailyProcessedAmount) ?? new Decimal(0);
    const reported = safeDecimal(row.utilisation);
    const computed = cap && cap.gt(0) ? processed.div(cap).mul(100) : null;
    const percent = reported ?? computed;
    const exhausted = row.capExhausted === true || row.exclusionReason === "DAILY_CAP_EXCEEDED";
    const percentNumber = percent === null ? null : percent.toNumber();
    return {
        routeId: row.routeId,
        railCode: row.railCode,
        gatewayId: row.gatewayId,
        capped: cap !== null,
        cap: cap ? cap.toFixed(4) : null,
        processed: processed.toFixed(4),
        remaining: row.dailyCapRemaining ?? (cap ? Decimal.max(cap.minus(processed), 0).toFixed(4) : null),
        barPercent: percentNumber === null ? 0 : Math.max(0, Math.min(100, percentNumber)),
        utilisationLabel: percentNumber === null ? "—" : `${percent!.toDecimalPlaces(1).toString()}%`,
        exhausted,
        tone: capTone(percentNumber, exhausted),
    };
};

/** Capped routes first, most utilised first; routes without a cap are only counted. */
export const buildCapViews = (rows: readonly RouteCapRow[]): { capped: RouteCapView[]; uncappedCount: number; exhaustedCount: number } => {
    const views = rows.map(toCapView);
    const capped = views.filter((view) => view.capped).sort((left, right) => {
        if (left.exhausted !== right.exhausted) return left.exhausted ? -1 : 1;
        return right.barPercent - left.barPercent || left.railCode.localeCompare(right.railCode);
    });
    return {
        capped,
        uncappedCount: views.length - capped.length,
        exhaustedCount: capped.filter((view) => view.exhausted).length,
    };
};
