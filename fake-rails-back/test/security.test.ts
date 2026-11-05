import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `fake-rails-security-test-${process.pid}-${Date.now()}.sqlite`);

process.env.NODE_ENV = "test";
process.env.FAKE_RAILS_ADMIN_USER = "tester_admin";
process.env.FAKE_RAILS_ADMIN_PASSWORD = "Strong-Tester-Pass-2026!";
process.env.FAKE_RAILS_JWT_SECRET = "jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af";
process.env.FAKE_RAILS_SEEDER_TOKEN = "seed-Hv3Tn8Yq1Dz6Mk4Pw9Xc2Lb7Rg5Fj0Ua";
process.env.FAKE_RAILS_DATA_DIR = join(tmpdir(), "fake-rails-security-test-data");
process.env.FAKE_RAILS_DB_PATH = dbPath;
process.env.FAKE_RAILS_PORTAL_ACCOUNT_LOCKOUT = "3";

let server: import("node:http").Server;
let baseUrl = "";
let closeDb: () => void = () => undefined;

beforeAll(async () => {
  const { createApp } = await import("../index");
  closeDb = (await import("../engine/db")).closeDb;
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server?.close();
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
});

const login = (username: string, password: string, extra: Record<string, string> = {}) =>
  fetch(`${baseUrl}/portal-api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...extra },
    body: JSON.stringify({ username, password }),
  });

describe("fake-rails-back hardening", () => {
  test("seeder token comparison rejects wrong and accepts the right token", async () => {
    const call = (token: string) =>
      fetch(`${baseUrl}/portal-api/internal/seeder-handshake`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-fake-rails-seeder-token": token },
        body: JSON.stringify({ check: "PRE_FLIGHT_SEEDER_SYNC" }),
      });
    expect((await call("seed-wrong-token-wrong-token-wrong-0")).status).toBe(401);
    expect((await call("")).status).toBe(401);
    expect((await call(process.env.FAKE_RAILS_SEEDER_TOKEN!)).status).toBe(200);
  });

  test("the ?token= query JWT is accepted only for the SSE stream path", async () => {
    const { token } = (await (await login("tester_admin", "Strong-Tester-Pass-2026!")).json()) as { token: string };
    const viaQuery = await fetch(`${baseUrl}/portal-api/auth/me?token=${encodeURIComponent(token)}`);
    expect(viaQuery.status).toBe(401);
    const viaHeader = await fetch(`${baseUrl}/portal-api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(viaHeader.status).toBe(200);
  });

  test("per-account lockout applies regardless of the source address", async () => {
    // Each attempt comes from a different forwarded address; the account lockout (default 5, env-configurable)
    // must trip before the per-IP limit (10) would.
    let locked = false;
    for (let i = 0; i < 7 && !locked; i += 1) {
      const status = (await login("victim_user", `wrong-${i}`, { "x-forwarded-for": `203.0.113.${i + 1}` })).status;
      expect(status === 401 || status === 429).toBe(true);
      locked = status === 429;
    }
    expect(locked).toBe(true);
    expect((await login("victim_user", "wrong-again", { "x-forwarded-for": "198.51.100.77" })).status).toBe(429);
  });

  test("CIDR matcher uses real addresses incl. IPv4-mapped IPv6 and loopback", async () => {
    const { buildCidrMatcher, parseTrustProxy } = await import("../lib/security");
    const allowed = buildCidrMatcher("127.0.0.1/32,10.0.0.0/8");
    expect(allowed("127.0.0.1")).toBe(true);
    expect(allowed("::ffff:10.1.2.3")).toBe(true);
    expect(allowed("::1")).toBe(true);
    expect(allowed("203.0.113.9")).toBe(false);
    expect(allowed(undefined)).toBe(false);
    expect(parseTrustProxy("loopback")).toBe("loopback");
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("2")).toBe(2);
  });

  test("peerAllowlist blocks a disallowed peer even when X-Forwarded-For claims an allowed one", async () => {
    const { peerAllowlist } = await import("../lib/security");
    const middleware = peerAllowlist("10.0.0.0/8");
    let error: unknown;
    middleware({ socket: { remoteAddress: "203.0.113.9" }, headers: { "x-forwarded-for": "10.0.0.5" } } as never, {} as never, (e?: unknown) => {
      error = e;
    });
    expect((error as { statusCode?: number }).statusCode).toBe(403);
    let passed = false;
    middleware({ socket: { remoteAddress: "10.0.0.5" } } as never, {} as never, (e?: unknown) => {
      passed = e === undefined;
    });
    expect(passed).toBe(true);
  });

  test("weak/placeholder secrets are detected", async () => {
    const { weakSecretReason } = await import("../lib/security");
    expect(weakSecretReason("change-me-fake-rails-jwt-secret")).toBeDefined();
    expect(weakSecretReason("0123456789abcdef0123456789abcdef")).toBeDefined();
    expect(weakSecretReason("jwt-Rk7Qm2Xv9Lp4Zn8Bc3Wd6Th1Yg5Js0Af")).toBeUndefined();
  });
});
