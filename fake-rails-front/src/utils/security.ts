/** Pure helpers for the fake-rails frontend (postMessage target origin, redirect validation). */

const toOrigin = (value: unknown): string | null => {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    try {
        const u = new URL(value.trim());
        return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
    } catch {
        return null;
    }
};

/**
 * Origin the widget may post messages to: the configured checkout origin (`VITE_CHECKOUT_ORIGIN`),
 * else the embedding parent's origin (ancestorOrigins / referrer). Never "*"; null means "do not post".
 */
export const resolveCheckoutOrigin = (configured: unknown, ancestorOrigin?: unknown, referrer?: unknown): string | null =>
    toOrigin(configured) ?? toOrigin(ancestorOrigin) ?? toOrigin(referrer);

/** Only absolute http(s) URLs (no credentials) may be navigated to. */
export const isSafeRedirectUrl = (url: unknown): boolean => {
    if (typeof url !== "string") {
        return false;
    }
    try {
        const u = new URL(url);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
    } catch {
        return false;
    }
};
