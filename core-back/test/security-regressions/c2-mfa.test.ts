import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateMfaCode, hashMfaCode, verifyPasswordOrDummy } from "../../lib/auth";
import {
  MFA_LOCK_COOLDOWN_MS,
  MFA_MAX_ATTEMPTS,
  MFA_MAX_ISSUES_PER_WINDOW,
  MFA_TTL_MS,
  issueMfaChallenge,
  openMfaCode,
  verifyMfaChallenge,
  type MfaStore,
} from "../../lib/auth/mfaChallenges";
import {
  assertLoginAllowed,
  assertMfaAllowed,
  recordLoginFailure,
  recordLoginSuccess,
  recordMfaFailure,
  resetAuthThrottles,
} from "../../lib/auth/throttle";
import { MemoryAuthStateStore, setAuthStateStore } from "../../lib/auth/sharedState";
import { createFakePrisma, fakeTable, resetFakeDatabase } from "../helpers/fakePrisma";

/** The fake assigns sequential ids; challenge ids are UUIDs, as in the database. */
const buildStore = (): MfaStore => {
  const fake = createFakePrisma() as unknown as Record<string, any>;
  const create = fake.mfaChallenge.create.bind(fake.mfaChallenge);
  fake.mfaChallenge.create = (args: { data: Record<string, unknown> }) =>
    create({ data: { id: randomUUID(), createdAt: new Date(), ...args.data } });
  return fake as unknown as MfaStore;
};

const USER = "11111111-1111-4111-8111-111111111111";
const issue = (store: MfaStore, over: Partial<Parameters<typeof issueMfaChallenge>[1]> = {}) =>
  issueMfaChallenge(store, { userId: USER, channel: "ADMIN", phoneLast4: "1234", ip: "10.0.0.1", ...over });

/** Reads the delivered code back from the (encrypted) notification, like the SMS worker does. */
const deliveredCode = async (): Promise<string> => {
  const rows = fakeTable("notification");
  const payload = rows[rows.length - 1]!.payloadJson as { codeCiphertext: string };
  return openMfaCode(payload.codeCiphertext);
};

const wrongCode = (right: string): string => (right === "000000" ? "000001" : "000000");

const expectCode = async (promise: Promise<unknown>, status: number, code: string): Promise<void> => {
  const error = (await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  )) as { statusCode?: number; code?: string } | null;
  expect(error).not.toBeNull();
  expect(error?.statusCode).toBe(status);
  expect(error?.code).toBe(code);
};

describe("C2 MFA challenge is server-side, single-use and bounded", () => {
  let store: MfaStore;
  beforeEach(() => {
    resetFakeDatabase();
    setAuthStateStore(new MemoryAuthStateStore());
    store = buildStore();
  });

  test("the code is never stored in plaintext: the notification carries ciphertext, the challenge an HMAC", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    expect(code).toMatch(/^\d{6}$/);
    const notification = fakeTable("notification")[0]!;
    expect(JSON.stringify(notification.payloadJson)).not.toContain(code);
    expect(Object.keys(notification.payloadJson as object)).toEqual(["codeCiphertext"]);
    const row = fakeTable("mfaChallenge")[0]!;
    expect(row.id).toBe(challengeId);
    expect(row.codeHash).toBe(hashMfaCode(USER, code));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.attempts).toBe(0);
    expect(row.maxAttempts).toBe(MFA_MAX_ATTEMPTS);
  });

  test("a correct code verifies once and the challenge cannot be replayed", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    await expect(verifyMfaChallenge(store, { challengeId, code, channel: "ADMIN" })).resolves.toEqual({ userId: USER });
    await expectCode(verifyMfaChallenge(store, { challengeId, code, channel: "ADMIN" }), 401, "MFA_CHALLENGE_INVALID");
    expect(fakeTable("mfaChallenge")[0]!.consumedAt).toBeInstanceOf(Date);
  });

  test("wrong guesses are counted and the challenge dies after the maximum, even for the right code", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    for (let attempt = 1; attempt < MFA_MAX_ATTEMPTS; attempt += 1) {
      await expectCode(
        verifyMfaChallenge(store, { challengeId, code: wrongCode(code), channel: "ADMIN" }),
        401,
        "MFA_CODE_INVALID",
      );
      expect(fakeTable("mfaChallenge")[0]!.attempts).toBe(attempt);
    }
    // The last allowed wrong guess locks the challenge.
    await expectCode(verifyMfaChallenge(store, { challengeId, code: wrongCode(code), channel: "ADMIN" }), 429, "MFA_LOCKED");
    await expectCode(verifyMfaChallenge(store, { challengeId, code, channel: "ADMIN" }), 429, "MFA_LOCKED");
    expect(fakeTable("mfaChallenge")[0]!.consumedAt ?? null).toBeNull();
    expect(fakeTable("mfaChallenge")[0]!.lockedAt).toBeInstanceOf(Date);
  });

  test("a locked user cannot restart the game with a fresh challenge during the cool-down", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
      await verifyMfaChallenge(store, { challengeId, code: wrongCode(code), channel: "ADMIN" }).catch(() => undefined);
    }
    await expectCode(issue(store), 429, "MFA_LOCKED");
    // After the cool-down the user can sign in again.
    const later = new Date(Date.now() + MFA_LOCK_COOLDOWN_MS + 60_000);
    await expect(issue(store, { now: later })).resolves.toBeDefined();
  });

  test("an expired challenge is refused", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    const late = new Date(Date.now() + MFA_TTL_MS + 1_000);
    await expectCode(verifyMfaChallenge(store, { challengeId, code, channel: "ADMIN", now: late }), 401, "MFA_CHALLENGE_INVALID");
  });

  test("a challenge is bound to the channel that issued it and malformed ids never reach the database", async () => {
    const { challengeId } = await issue(store);
    const code = await deliveredCode();
    await expectCode(verifyMfaChallenge(store, { challengeId, code, channel: "MERCHANT" }), 401, "MFA_CHALLENGE_INVALID");
    await expectCode(verifyMfaChallenge(store, { challengeId: "not-a-uuid", code, channel: "ADMIN" }), 401, "MFA_CHALLENGE_INVALID");
    await expectCode(verifyMfaChallenge(store, { challengeId: randomUUID(), code, channel: "ADMIN" }), 401, "MFA_CHALLENGE_INVALID");
  });

  test("a new challenge supersedes the previous one", async () => {
    const first = await issue(store);
    const firstCode = await deliveredCode();
    await issue(store);
    await expectCode(
      verifyMfaChallenge(store, { challengeId: first.challengeId, code: firstCode, channel: "ADMIN" }),
      401,
      "MFA_CHALLENGE_INVALID",
    );
  });

  test("SMS sends are throttled per user", async () => {
    for (let i = 0; i < MFA_MAX_ISSUES_PER_WINDOW; i += 1) await issue(store);
    await expectCode(issue(store), 429, "MFA_RATE_LIMITED");
    expect(fakeTable("notification")).toHaveLength(MFA_MAX_ISSUES_PER_WINDOW);
  });

  test("generated codes are six digits", () => {
    expect(generateMfaCode()).toMatch(/^\d{6}$/);
  });
});

describe("C2 login and MFA throttling", () => {
  beforeEach(async () => {
    setAuthStateStore(new MemoryAuthStateStore());
    await resetAuthThrottles();
  });

  test("repeated failures lock the identifier, a success clears the counter", async () => {
    for (let i = 0; i < 4; i += 1) await recordLoginFailure("Alice@Example.com", "10.0.0.9");
    await expect(assertLoginAllowed("alice@example.com", "10.0.0.9")).resolves.toBeUndefined();
    await recordLoginSuccess("alice@example.com");
    for (let i = 0; i < 5; i += 1) await recordLoginFailure("alice@example.com", "10.0.0.9");
    await expect(assertLoginAllowed("ALICE@example.com", "10.0.0.50")).rejects.toThrow();
    // Another identifier from another address is not affected.
    await expect(assertLoginAllowed("bob@example.com", "10.0.0.50")).resolves.toBeUndefined();
  });

  test("one address spraying many identifiers is throttled", async () => {
    for (let i = 0; i < 30; i += 1) await recordLoginFailure(`user-${i}@example.com`, "203.0.113.7");
    await expect(assertLoginAllowed("fresh@example.com", "203.0.113.7")).rejects.toThrow();
  });

  test("MFA failures per address are throttled", async () => {
    for (let i = 0; i < 20; i += 1) await recordMfaFailure("198.51.100.4");
    await expect(assertMfaAllowed("198.51.100.4")).rejects.toThrow();
    await expect(assertMfaAllowed("198.51.100.5")).resolves.toBeUndefined();
  });

  test("counters are shared through the store (a second instance sees the same lock)", async () => {
    // GAP-027: another core instance backed by the same shared store honours the lock.
    const shared = new MemoryAuthStateStore();
    setAuthStateStore(shared);
    for (let i = 0; i < 5; i += 1) await recordLoginFailure("carol@example.com", null);
    setAuthStateStore(shared);
    await expect(assertLoginAllowed("carol@example.com", null)).rejects.toThrow();
  });

  test("an unknown user is compared against a dummy hash and never verifies", async () => {
    await expect(verifyPasswordOrDummy("whatever-password", null)).resolves.toBe(false);
    await expect(verifyPasswordOrDummy("whatever-password", undefined)).resolves.toBe(false);
  });
});

describe("C2 route wiring", () => {
  const routeBody = (file: string, signature: string): string => {
    const source = readFileSync(file, "utf8");
    const start = source.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf("\n});", start));
  };

  test("both MFA routes verify through the stored challenge and are throttled", () => {
    for (const [file, signature] of [
      ["api/internal/admin.ts", 'router.post("/auth/mfa"'],
      ["api/internal/merchant.ts", 'router.post("/auth/mfa/verify"'],
    ] as const) {
      const body = routeBody(file, signature);
      expect(body).toContain("verifyMfaChallenge(");
      expect(body).toContain("assertMfaAllowed(");
      expect(body).toContain("recordMfaFailure(");
      expect(body).not.toMatch(/\$transaction/);
    }
  });

  test("both login routes throttle, use the dummy hash and issue a stored challenge", () => {
    for (const file of ["api/internal/admin.ts", "api/internal/merchant.ts"]) {
      const body = routeBody(file, 'router.post("/auth/login"');
      expect(body).toContain("assertLoginAllowed(");
      expect(body).toContain("verifyPasswordOrDummy(");
      expect(body).toContain("recordLoginFailure(");
      expect(body).toContain("issueMfaChallenge(");
    }
  });

  test("no module signs an MFA challenge token or stores the code in a notification payload", () => {
    const auth = readFileSync("lib/auth/index.ts", "utf8");
    expect(auth).not.toContain("signMfaChallenge");
    expect(auth).not.toContain("verifyMfaChallengeToken");
    for (const file of ["api/internal/admin.ts", "api/internal/merchant.ts"]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/payloadJson:\s*json\(\{\s*code\s*\}\)/);
    }
  });

  test("the phone-only verify-identity entrypoint no longer issues a session-capable challenge", () => {
    const body = routeBody("api/internal/merchant.ts", 'router.post("/auth/verify-identity"');
    expect(body).toContain("410");
    expect(body).not.toContain("client.");
    expect(body).not.toContain("challengeId");
  });
});
