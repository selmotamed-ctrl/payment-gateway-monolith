/**
 * Builds the public pay-link URL from a configured checkout base URL
 * (`VITE_CHECKOUT_BASE_URL`, e.g. https://pay.example.ly). Falls back to the previous
 * behaviour (the current origin) when it is unset or not an http(s) origin.
 */
export const resolveCheckoutBase = (configured: unknown, fallbackOrigin: string): string => {
    const raw = typeof configured === "string" ? configured.trim() : "";
    if (raw) {
        try {
            const parsed = new URL(raw);
            if ((parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password) {
                return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
            }
        } catch {
            /* fall through to fallback */
        }
    }
    return fallbackOrigin.replace(/\/+$/, "");
};

export const buildCheckoutUrl = (linkKey: string, configured: unknown, fallbackOrigin: string): string =>
    `${resolveCheckoutBase(configured, fallbackOrigin)}/pay/${encodeURIComponent(linkKey)}`;
