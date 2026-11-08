import { extractApiError } from "@/utils/errors/extractor";

/** Compact date-time used by the ledger and operations views (browser locale). */
export const formatDateTime = (value: string | Date | null | undefined): string => {
    if (!value) return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
};

export const formatDate = (value: string | Date | null | undefined): string => {
    if (!value) return "—";
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit" }).format(date);
};

/** Stable error code of an API failure (`WALLET_NOT_ACTIVE`, `LEDGER_SHARD_PARITY_MISMATCH`...). */
export const errorCodeOf = (error: unknown): string => extractApiError(error as never)?.code ?? "";

/** `details` of the error envelope, when the server sent any (never rendered as raw JSON). */
export const errorDetailsOf = (error: unknown): Record<string, unknown> => {
    const details = (error as { response?: { data?: { details?: unknown } } })?.response?.data?.details;
    return details !== null && typeof details === "object" && !Array.isArray(details) ? (details as Record<string, unknown>) : {};
};

/** `body.data ?? body`: the portal API sometimes wraps payloads in `data`. */
export const unwrap = <T>(responseData: unknown): T => {
    const body = responseData as { data?: unknown } | null | undefined;
    return ((body && typeof body === "object" && "data" in body && body.data !== undefined ? body.data : body) ?? {}) as T;
};
