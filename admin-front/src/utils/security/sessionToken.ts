/**
 * Session token helpers shared by the login pages, the api client and logout (GAP-019).
 *
 * With the edge's `SESSION_COOKIE_MODE=true` the login response carries
 * `sessionCookie: true` instead of a token: the real session lives in an HttpOnly cookie
 * that JavaScript cannot read, and the client only keeps this non-secret sentinel.
 */
export const COOKIE_SESSION_TOKEN = "cookie-session";
export const CSRF_HEADER = "X-Pg-Csrf";

export const isCookieSession = (token: string | null | undefined): boolean => token === COOKIE_SESSION_TOKEN;

/** The token to keep in the client session after a login/MFA response (or undefined). */
export const tokenFromLoginPayload = (payload: any): string | undefined => {
    if (typeof payload?.token === "string" && payload.token.length > 0) {
        return payload.token;
    }
    return payload?.sessionCookie === true ? COOKIE_SESSION_TOKEN : undefined;
};

/** Request headers for the current session token (bearer, or csrf marker for a cookie session). */
export const sessionHeaders = (token: string | null | undefined): Record<string, string> => {
    if (!token) {
        return {};
    }
    return isCookieSession(token) ? { [CSRF_HEADER]: "1" } : { Authorization: `Bearer ${token}` };
};

/**
 * Best-effort server-side logout: asks the edge to revoke the session and clear the cookie.
 * Never throws; the caller always clears the local session afterwards.
 */
export const revokeServerSession = async (
    fetchImpl: typeof fetch,
    url: string,
    token: string | null | undefined,
): Promise<boolean> => {
    if (!token) {
        return false;
    }
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
            const response = await fetchImpl(url, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...sessionHeaders(token) },
                body: "{}",
                credentials: "same-origin",
                cache: "no-store",
                signal: controller.signal,
            });
            return response.ok;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return false;
    }
};
