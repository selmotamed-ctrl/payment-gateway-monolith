import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { createTestPki, startTestCore, type TestCore, type TestPki } from "./helpers/core";
import { signSession } from "./helpers/session";

const pki: TestPki = createTestPki("admin-back-academy");
const core: TestCore = await startTestCore(pki);

const { createApp } = await import("../index");
const { resetAcademyRateLimiterForTests } = await import("../api/protected/academy");
const { academyRouter } = await import("../api/protected/academy");

let edgeUrl: string;
let edgeServer: ReturnType<ReturnType<typeof createApp>["listen"]>;

const BASE = "/api/v1/admin/academy";
const supportToken = signSession({ sub: "u-support", role: "SUPPORT" });
const otherToken = signSession({ sub: "u-other", role: "SUPPORT" });
const securityToken = signSession({ sub: "u-sec", role: "SECURITY_ADMIN" });

beforeAll(() => {
  process.env.NODE_ENV = "test";
  process.env.CORE_BACK_URL = core.url;
  process.env.MTLS_CLIENT_CERT_PATH = pki.clientCert;
  process.env.MTLS_CLIENT_KEY_PATH = pki.clientKey;
  process.env.MTLS_CA_CERT_PATH = pki.caCert;
  process.env.ADMIN_LAN_CIDRS = "10.0.0.0/8,192.168.0.0/16,127.0.0.1/32";
});
beforeAll(async () => {
  const app = createApp();
  edgeServer = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => edgeServer.once("listening", resolve));
  const address = edgeServer.address();
  edgeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => edgeServer.close(() => resolve()));
  await core.close();
});
beforeEach(() => resetAcademyRateLimiterForTests());

const call = (method: string, path: string, options: { token?: string; body?: unknown } = {}) => {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${edgeUrl}${BASE}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
};

const lastBody = (): Record<string, unknown> => {
  const raw = core.requests.at(-1)?.body.toString("utf8") ?? "";
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

const validPut = {
  baseRev: 3,
  patch: {
    activeTrack: "FINANCE",
    guideRead: { "b01-01": { v: "1.0.0", at: "2026-11-01T10:00:00.000Z" } },
    lessons: { "m1-l1": { at: "2026-11-01T10:00:00.000Z", v: "1.0.0", checkScore: 2 } },
    labs: { "lab-flow-tracer": { bestScore: 90, attempts: 2, criticalErrors: 0, v: "1.0.0", passedAt: "2026-11-01T10:00:00.000Z" } },
  },
};

describe("academy proxy forwarding", () => {
  test("GET progress is forwarded to core with no-store", async () => {
    const response = await call("GET", "/progress", { token: supportToken });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const last = core.requests.at(-1)!;
    expect(last.url).toBe("/internal/admin/academy/progress");
    expect(last.method).toBe("GET");
  });

  test("eligibility, start and submit map to the internal paths", async () => {
    await call("GET", "/exams/exam-foundation/eligibility", { token: supportToken });
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/exams/exam-foundation/eligibility");

    await call("POST", "/exams/exam-foundation/start", { token: supportToken, body: { integrityAccepted: true } });
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/exams/exam-foundation/start");
    expect(lastBody()).toEqual({ integrityAccepted: true });

    await call("POST", "/exams/exam-foundation/submit", {
      token: supportToken,
      body: { sessionId: "s1", answers: { q1: "a", q2: ["b", "c"] } },
    });
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/exams/exam-foundation/submit");
    expect(lastBody()).toEqual({ sessionId: "s1", answers: { q1: "a", q2: ["b", "c"] } });
  });

  test("the caller's authorization header reaches core", async () => {
    await call("GET", "/progress", { token: supportToken });
    expect(String(core.requests.at(-1)?.headers.authorization)).toContain(supportToken);
  });
});

describe("academy body validation", () => {
  test("PUT progress with a valid patch is forwarded", async () => {
    const response = await call("PUT", "/progress", { token: supportToken, body: validPut });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/progress");
    expect(core.requests.at(-1)?.method).toBe("PUT");
    expect(lastBody()).toEqual(validPut);
  });

  test("server-owned and unknown keys are stripped before forwarding", async () => {
    const body = {
      ...validPut,
      rev: 99,
      extra: "x",
      patch: {
        ...validPut.patch,
        exams: { "exam-foundation": { attempts: [], v: "1.0.0", passedAt: "2026-01-01T00:00:00.000Z" } },
        badges: [{ id: "FOUNDATION_CERTIFIED" }],
        contentVersion: "9.9.9",
        _server: { open: {} },
        integrityAcceptedAt: "2026-01-01T00:00:00.000Z",
        schema: 1,
        lessons: { "m1-l1": { at: "2026-11-01T10:00:00.000Z", v: "1.0.0", checkScore: 2, hacked: true } },
      },
    };
    const response = await call("PUT", "/progress", { token: supportToken, body });
    expect(response.status).toBe(200);
    const sent = lastBody();
    expect(Object.keys(sent).sort()).toEqual(["baseRev", "patch"]);
    expect(Object.keys(sent.patch as object).sort()).toEqual(["activeTrack", "guideRead", "labs", "lessons"]);
    expect((sent.patch as { lessons: Record<string, object> }).lessons["m1-l1"]).toEqual({
      at: "2026-11-01T10:00:00.000Z",
      v: "1.0.0",
      checkScore: 2,
    });
  });

  test.each([
    ["missing baseRev", { patch: {} }],
    ["negative baseRev", { baseRev: -1, patch: {} }],
    ["fractional baseRev", { baseRev: 1.5, patch: {} }],
    ["missing patch", { baseRev: 0 }],
    ["bad checkScore", { baseRev: 0, patch: { lessons: { a: { at: "2026-11-01T10:00:00.000Z", v: "1", checkScore: 3 } } } }],
    ["bad date", { baseRev: 0, patch: { guideRead: { a: { v: "1", at: "not-a-date" } } } }],
    ["lab score over 100", { baseRev: 0, patch: { labs: { a: { bestScore: 101, attempts: 1, criticalErrors: 0, v: "1" } } } }],
    ["over-long guide version", { baseRev: 0, patch: { guideRead: { a: { v: "x".repeat(21), at: "2026-11-01T10:00:00.000Z" } } } }],
  ])("PUT progress with %s -> 400 and never reaches core", async (_name, body) => {
    const before = core.requests.length;
    const response = await call("PUT", "/progress", { token: supportToken, body });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });

  test("guideRead tombstone (empty version) is accepted", async () => {
    const response = await call("PUT", "/progress", {
      token: supportToken,
      body: { baseRev: 0, patch: { guideRead: { a: { v: "", at: "2026-11-01T10:00:00.000Z" } } } },
    });
    expect(response.status).toBe(200);
  });

  test("submit rejects a malformed body", async () => {
    const before = core.requests.length;
    const response = await call("POST", "/exams/exam-foundation/submit", {
      token: supportToken,
      body: { sessionId: "s", answers: { q1: 5 } },
    });
    expect(response.status).toBe(400);
    expect(core.requests.length).toBe(before);
  });
});

describe("academy team view gate", () => {
  test("403 ACADEMY_TEAM_FORBIDDEN without the SECURITY_ADMIN role", async () => {
    const before = core.requests.length;
    const response = await call("GET", "/team", { token: supportToken });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("ACADEMY_TEAM_FORBIDDEN");
    expect(core.requests.length).toBe(before);
  });

  test("SECURITY_ADMIN is forwarded", async () => {
    const response = await call("GET", "/team", { token: securityToken });
    expect(response.status).toBe(200);
    expect(core.requests.at(-1)?.url).toBe("/internal/admin/academy/team");
  });

  test("a session with an authority string but not the role is refused", async () => {
    const token = signSession({ sub: "u-x", role: "OPERATOR", authorities: ["SECURITY_ADMIN"] });
    const response = await call("GET", "/team", { token });
    expect(response.status).toBe(403);
  });
});

// The academy limiter is exercised on a mini app that mounts ONLY the academy router. Going through
// `createApp()` would also feed the process-wide per-IP admin limiter (600/min, shared by every test
// file), and 60+ requests per test would push other suites over it. The 429 happens before any
// forwarding, so requests under the limit only need to be "not 429".
describe("academy rate limit", () => {
  let miniServer: ReturnType<ReturnType<typeof express>["listen"]>;
  let miniUrl: string;
  beforeAll(async () => {
    const mini = express();
    mini.use("/api/v1/admin/academy", academyRouter);
    mini.use((_error: unknown, _request: unknown, response: express.Response, _next: unknown) => {
      response.status(500).json({ code: "TEST_STUB" });
    });
    miniServer = mini.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => miniServer.once("listening", resolve));
    const address = miniServer.address();
    miniUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => miniServer.close(() => resolve()));
  });
  const hit = (token: string): Promise<Response> =>
    fetch(`${miniUrl}${BASE}/progress`, { headers: { authorization: `Bearer ${token}` } });

  test("61st request within a minute -> 429 ACADEMY_RATE_LIMITED with Retry-After", async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await hit(supportToken)).status).not.toBe(429);
    }
    const limited = await hit(supportToken);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("ACADEMY_RATE_LIMITED");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  test("the limit is per user", async () => {
    for (let i = 0; i < 60; i += 1) await hit(supportToken);
    expect((await hit(supportToken)).status).toBe(429);
    expect((await hit(otherToken)).status).not.toBe(429);
  });

  test("resetAcademyRateLimiterForTests clears the window", async () => {
    for (let i = 0; i < 61; i += 1) await hit(supportToken);
    resetAcademyRateLimiterForTests();
    expect((await hit(supportToken)).status).not.toBe(429);
  });
});
