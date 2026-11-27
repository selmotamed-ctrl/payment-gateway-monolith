import type { FilterValues } from "@pg/ui";

export type DisputeView = "open" | "resolved" | "all";

export const DISPUTE_OPEN_STATES = ["OPENED", "EVIDENCE_REQUESTED", "EVIDENCE_SUBMITTED"];
export const DISPUTE_RESOLVED_STATES = ["WON", "LOST", "EXPIRED", "WITHDRAWN"];

/** Reads a route query value, accepting the array form vue-router uses for repeated keys. */
export const queryString = (value: unknown): string => {
    if (Array.isArray(value)) {
        for (const entry of value) {
            if (typeof entry === "string" && entry.trim()) return entry.trim();
        }
        return "";
    }
    return typeof value === "string" ? value.trim() : "";
};

const attemptScope = (filters: FilterValues): FilterValues => {
    const attemptId = queryString(filters.attemptId);
    const merchantId = queryString(filters.merchantId);
    return {
        ...(attemptId ? { attemptId } : {}),
        ...(merchantId ? { merchantId } : {}),
    };
};

export const initialDisputeFilters = (attemptId: string, merchantId: string): FilterValues => {
    if (attemptId) {
        return {
            ...(merchantId ? { merchantId } : {}),
            attemptId,
        };
    }
    return {
        ...(merchantId ? { merchantId } : {}),
        status: [...DISPUTE_OPEN_STATES],
    };
};

export const disputeViewFilters = (view: DisputeView, current: FilterValues = {}): FilterValues => ({
    ...attemptScope(current),
    ...(view === "open"
        ? { status: [...DISPUTE_OPEN_STATES] }
        : view === "resolved"
          ? { status: [...DISPUTE_RESOLVED_STATES] }
          : {}),
});
