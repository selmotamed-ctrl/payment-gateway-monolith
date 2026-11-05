/** Deep-link sanitiser: https and a small explicit set of wallet app schemes only. */
export const ALLOWED_DEEP_LINK_SCHEMES: readonly string[] = ["https:", "moamalat:", "evowallet:", "numopay:"];

export const safeDeepLink = (url: unknown, schemes: readonly string[] = ALLOWED_DEEP_LINK_SCHEMES): string | null => {
    if (typeof url !== "string" || !url.trim()) {
        return null;
    }
    try {
        const parsed = new URL(url.trim());
        if (!schemes.includes(parsed.protocol)) {
            return null;
        }
        if (parsed.protocol === "https:" && (parsed.username || parsed.password)) {
            return null;
        }
        return parsed.href;
    } catch {
        return null;
    }
};
