import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestPki, startTestCore } from "./helpers/core";

const pki = createTestPki("admin-back");
const core = await startTestCore(pki);
const setEnv = () => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  // This suite exercises the cookie transport, so the option is on unless a
  // test flips it explicitly.
  process.env.SESSION_COOKIE_MODE = "true";
};
setEnv();

const { createApp } = await import("../index");
const { resetEnvCache } = await import("../lib/env");
const { captureSessionToken, SESSION_COOKIE_NAME } = await import("../lib/security/sessionCookie");
const express = (await import("express")).default;

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
beforeAll(async () => {
  setEnv();
  resetEnvCache();
  server = createApp().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await core.close();
});

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJwYXltZW50LWdhdGV3YXktYWRtaW4ifQ.c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJlc2lnbg";
const LOGOUT = "/api/v1/admin/auth/logout";

describe("GAP-019 server-side logout (admin edge)", () => {
  test("logout forwards the bearer to core's revoke endpoint and clears the cookie", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}${LOGOUT}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true });
    const call = core.requests[before]!;
    expect(call.url).toBe("/internal/admin/auth/logout");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE_NAME}=; `);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("logout without a credential never reaches core and still clears the cookie", async () => {
    const before = core.requests.length;
    const response = await fetch(`${base}${LOGOUT}`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(core.requests.length).toBe(before);
  });
});

describe("GAP-019 session cookie option (admin edge)", () => {
  test("a cookie session is forwarded to core as the bearer; writes need the csrf header", async () => {
    const before = core.requests.length;
    const cookie = `${SESSION_COOKIE_NAME}=${TOKEN}`;
    const missingCsrf = await fetch(`${base}${LOGOUT}`, { method: "POST", headers: { cookie } });
    expect(missingCsrf.status).toBe(403);
    expect(core.requests.length).toBe(before);
    const ok = await fetch(`${base}${LOGOUT}`, { method: "POST", headers: { cookie, "x-pg-csrf": "1" } });
    expect(ok.status).toBe(200);
    expect(core.requests.at(-1)?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("an explicit Authorization header wins over a cookie", async () => {
    const response = await fetch(`${base}${LOGOUT}`, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${"a".repeat(30)}`, authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("cookie mode moves the token out of the JSON body into an HttpOnly cookie", async () => {
    const app = express();
    app.post("/login", captureSessionToken, (_req, res) => {
      res.json({ token: TOKEN, expiresInSeconds: 43200, userInfo: { id: "u" } });
    });
    const run = async (mode: string) => {
      process.env.SESSION_COOKIE_MODE = mode;
      resetEnvCache();
      const srv = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => srv.once("listening", resolve));
      const port = (srv.address() as { port: number }).port;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/login`, { method: "POST" });
        return { cookie: res.headers.get("set-cookie"), body: (await res.json()) as Record<string, unknown> };
      } finally {
        srv.closeAllConnections?.();
        srv.close();
      }
    };
    try {
      const on = await run("true");
      expect(on.body.token).toBeUndefined();
      expect(on.body.sessionCookie).toBe(true);
      expect(on.cookie).toContain(`${SESSION_COOKIE_NAME}=${TOKEN}`);
      expect(on.cookie).toContain("HttpOnly");
      expect(on.cookie).toContain("SameSite=Strict");
      expect(on.cookie).toContain("Secure");
      const off = await run("false");
      expect(off.body.token).toBe(TOKEN);
      expect(off.cookie).toBeNull();
    } finally {
      delete process.env.SESSION_COOKIE_MODE;
      resetEnvCache();
    }
  });
});

describe("GAP-020 admin edge audience", () => {
  test("the admin guard only accepts the admin audience", async () => {
    const { extractAuthorityHints } = await import("../api/middleware/authorityGuard");
    const make = (aud: string) => {
      const payload = { typ: "session", iss: "payment-gateway-core", aud, role: "OPERATOR", authorities: ["x"], exp: Math.floor(Date.now() / 1000) + 600 };
      return `Bearer ${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${"A".repeat(43)}`;
    };
    expect(extractAuthorityHints(make("payment-gateway-admin"))).not.toBeNull();
    for (const aud of ["payment-gateway-merchant", "payment-gateway-edge", "payment-gateway-checkout"]) {
      expect(extractAuthorityHints(make(aud))).toBeNull();
    }
  });
});
