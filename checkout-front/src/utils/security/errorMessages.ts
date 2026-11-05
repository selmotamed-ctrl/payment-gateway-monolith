/**
 * Maps server error codes to i18n catalogue keys. Raw server text is never displayed.
 * Every returned key exists in `constants/i18nCatalogue.ts` (EN + AR).
 */
const CODE_TO_KEY: Record<string, string> = {
    "network-error": "Network Error Try Again",
    RATE_LIMITED: "Too Many Requests",
    TOO_MANY_REQUESTS: "Too Many Requests",
    VALIDATION_ERROR: "Invalid Payment Details",
    INVALID_REQUEST: "Invalid Payment Details",
    LINK_EXPIRED: "This Payment Link Is No Longer Available",
    LINK_NOT_FOUND: "This Payment Link Is No Longer Available",
    ATTEMPT_EXPIRED: "Payment Attempt Expired",
    APP_SUSPENDED: "Payment Temporarily Unavailable",
    PLATFORM_SUSPENDED: "Payment Temporarily Unavailable",
};

export const DEFAULT_ERROR_KEY = "Something went wrong";

export const errorKeyForCode = (code: unknown, status?: unknown): string => {
    const normalized = typeof code === "string" ? code : "";
    const mapped = CODE_TO_KEY[normalized] ?? CODE_TO_KEY[normalized.toUpperCase()];
    if (mapped) {
        return mapped;
    }
    if (status === 429) {
        return "Too Many Requests";
    }
    if (status === 400 || status === 422) {
        return "Invalid Payment Details";
    }
    return DEFAULT_ERROR_KEY;
};

export const ERROR_CATALOGUE_KEYS: readonly string[] = [...new Set([...Object.values(CODE_TO_KEY), DEFAULT_ERROR_KEY])];
