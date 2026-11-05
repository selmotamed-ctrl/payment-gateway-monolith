/**
 * Host allow-listing for payer redirect actions (3DS / bank pages).
 *
 * Kept free of Vue so it can be unit-tested directly.
 *
 * Rules:
 *  - https only (http is accepted solely for localhost/127.0.0.1/[::1] when `allowInsecureLocalhost` is set, i.e. DEV builds);
 *  - URL must be absolute (protocol-relative / relative URLs are rejected) and carry no credentials;
 *  - exact hostname match against the allow-list. There is NO bare `*`.
 *    Subdomains are accepted only through an explicit `*.example.com` entry, which matches
 *    subdomains of example.com but not example.com itself.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const isDevBuild = (): boolean => {
    const env = ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}) as Record<string, unknown>;
    return env.DEV === true;
};

const parseAbsolute = (url: string): URL | null => {
    if (typeof url !== "string" || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim())) {
        return null;
    }
    try {
        return new URL(url.trim());
    } catch {
        return null;
    }
};

export const hostOf = (url: string): string => parseAbsolute(url)?.hostname.toLowerCase() ?? "";

export const isAllowedRedirect = (
    url: string,
    allowlist?: string[],
    allowInsecureLocalhost: boolean = isDevBuild(),
): boolean => {
    if (!allowlist?.length) {
        return false;
    }
    const parsed = parseAbsolute(url);
    if (!parsed || parsed.username || parsed.password) {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (!host) {
        return false;
    }
    if (parsed.protocol !== "https:") {
        if (!(parsed.protocol === "http:" && allowInsecureLocalhost && LOCAL_HOSTS.has(host))) {
            return false;
        }
    }
    return allowlist.some((entry) => {
        const normalized = String(entry ?? "").trim().toLowerCase();
        if (!normalized || normalized === "*") {
            return false;
        }
        if (normalized.startsWith("*.")) {
            const suffix = normalized.slice(1); // ".example.com"
            return suffix.length > 1 && host.endsWith(suffix) && host.length > suffix.length;
        }
        return host === normalized;
    });
};
