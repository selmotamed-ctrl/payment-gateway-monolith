/**
 * Validation of the redirect URL returned by the Google sign-in/registration endpoint:
 * https, no credentials, and the host must be an allow-listed identity host.
 */
export const DEFAULT_IDENTITY_HOSTS: readonly string[] = ["accounts.google.com"];

/** `VITE_IDENTITY_HOSTS` is a comma-separated list of exact hostnames; falls back to Google. */
export const parseIdentityHosts = (raw: unknown): string[] => {
    const list = String(raw ?? "")
        .split(",")
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
    return list.length ? list : [...DEFAULT_IDENTITY_HOSTS];
};

export const isAllowedIdentityRedirect = (url: unknown, hosts: readonly string[] = DEFAULT_IDENTITY_HOSTS): boolean => {
    if (typeof url !== "string") {
        return false;
    }
    try {
        const parsed = new URL(url);
        return (
            parsed.protocol === "https:" &&
            !parsed.username &&
            !parsed.password &&
            hosts.map((h) => h.toLowerCase()).includes(parsed.hostname.toLowerCase())
        );
    } catch {
        return false;
    }
};

/** Fixed, same-origin return paths (never `location.href`, which can carry query/fragment data). */
export const GOOGLE_REDIRECT_PATHS = { login: "/login", register: "/register" } as const;
