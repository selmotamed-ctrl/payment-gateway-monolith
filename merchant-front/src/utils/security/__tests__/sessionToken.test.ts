import { describe, expect, test } from "bun:test";
import {
    COOKIE_SESSION_TOKEN,
    revokeServerSession,
    sessionHeaders,
    tokenFromLoginPayload,
} from "../sessionToken";

describe("merchant session token helpers (GAP-019)", () => {
    test("a login payload yields the bearer token, or the cookie sentinel in cookie mode", () => {
        expect(tokenFromLoginPayload({ token: "abc.def.ghi" })).toBe("abc.def.ghi");
        expect(tokenFromLoginPayload({ sessionCookie: true })).toBe(COOKIE_SESSION_TOKEN);
        expect(tokenFromLoginPayload({ mfaRequired: true })).toBeUndefined();
    });

    test("cookie sessions send the csrf marker and never an Authorization header", () => {
        expect(sessionHeaders(COOKIE_SESSION_TOKEN)).toEqual({ "X-Pg-Csrf": "1" });
        expect(sessionHeaders("abc.def.ghi")).toEqual({ Authorization: "Bearer abc.def.ghi" });
        expect(sessionHeaders(null)).toEqual({});
    });

    test("logout calls the server revoke endpoint and swallows failures", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const ok = (async (url: string, init: RequestInit) => {
            calls.push({ url, init });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;
        expect(await revokeServerSession(ok, "/api/v1/merchant/auth/logout", "abc.def.ghi")).toBe(true);
        expect(calls[0]?.url).toBe("/api/v1/merchant/auth/logout");
        expect(calls[0]?.init.method).toBe("POST");
        expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer abc.def.ghi");
        const boom = (async () => {
            throw new Error("offline");
        }) as unknown as typeof fetch;
        expect(await revokeServerSession(boom, "/x", "abc.def.ghi")).toBe(false);
        expect(await revokeServerSession(ok, "/x", null)).toBe(false);
    });
});
