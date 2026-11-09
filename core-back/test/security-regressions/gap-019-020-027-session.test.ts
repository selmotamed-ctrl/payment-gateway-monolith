import { beforeEach, describe, expect, test } from "bun:test";
import { sign } from "jsonwebtoken";
import { SESSION_AUDIENCES, signSession, verifySessionToken } from "../../lib/auth";
import { isSessionRevoked, revokeSession } from "../../lib/auth/revocation";
import { INCR_WINDOW_LUA } from "../../lib/auth/sharedState";
import {
  FallbackAuthStateStore,
  MemoryAuthStateStore,
  RedisAuthStateStore,
  setAuthStateStore,
  type RedisLike,
} from "../../lib/auth/sharedState";
import { assertLoginAllowed, recordLoginFailure } from "../../lib/auth/throttle";

const claims = {
  sub: "user-1",
  role: "OPERATOR",
  merchantId: null,
  authorities: ["merchant:read"],
  appScopeIds: [],
  mfa: true,
};

beforeEach(() => setAuthStateStore(new MemoryAuthStateStore()));

describe("GAP-020 per-channel audience", () => {
  test("each channel gets its own audience and a unique jti", () => {
    const admin = verifySessionToken(signSession(claims, "admin"));
    const merchant = verifySessionToken(signSession(claims, "merchant"));
    expect(admin.channel).toBe("admin");
    expect(merchant.channel).toBe("merchant");
    expect(admin.jti).not.toBe(merchant.jti);
    expect(SESSION_AUDIENCES.admin).not.toBe(SESSION_AUDIENCES.merchant);
  });

  test("a token for another channel or the legacy shared audience is refused", () => {
    const merchantToken = signSession(claims, "merchant");
    expect(() => verifySessionToken(merchantToken, "admin")).toThrow();
    expect(() => verifySessionToken(merchantToken, "merchant")).not.toThrow();
    expect(() => verifySessionToken(signSession(claims, "checkout"), "admin")).toThrow();
    const decoded = JSON.parse(Buffer.from(merchantToken.split(".")[1]!, "base64url").toString("utf8"));
    expect(decoded.aud).toBe("payment-gateway-merchant");
    const forged = sign({ ...claims, typ: "session" }, "wrong-key", {
      algorithm: "HS256",
      issuer: "payment-gateway-core",
      audience: "payment-gateway-edge",
    });
    expect(() => verifySessionToken(forged)).toThrow();
  });
});

describe("GAP-019 revoke list", () => {
  test("a revoked jti is reported revoked until it would have expired", async () => {
    const session = verifySessionToken(signSession(claims, "admin"));
    expect(await isSessionRevoked(session.jti)).toBe(false);
    await revokeSession(session.jti!, session.exp!);
    expect(await isSessionRevoked(session.jti)).toBe(true);
    expect(await isSessionRevoked("another-session")).toBe(false);
  });

  test("the revoke ttl is bounded by the token expiry", async () => {
    let now = 1_000_000;
    const store = new MemoryAuthStateStore(() => now);
    setAuthStateStore(store);
    await revokeSession("jti-x", now / 1000 + 60, now);
    expect(await isSessionRevoked("jti-x")).toBe(true);
    now += 61_000;
    expect(await isSessionRevoked("jti-x")).toBe(false);
  });

  test("authDoubleCheck enforces revocation and the channel audience", async () => {
    const source = await Bun.file(new URL("../../api/middleware/authDoubleCheck.ts", import.meta.url)).text();
    expect(source).toContain("isSessionRevoked(claims.jti)");
    expect(source).toContain('principal.sessionChannel !== "admin"');
    expect(source).toContain('principal.sessionChannel !== "merchant"');
    for (const file of ["admin", "merchant"]) {
      const route = await Bun.file(new URL(`../../api/internal/${file}.ts`, import.meta.url)).text();
      expect(route).toContain('router.post("/auth/logout"');
    }
  });
});

describe("GAP-027 shared throttle state", () => {
  const fakeRedis = (): RedisLike & { data: Map<string, { v: string; exp: number }> } => {
    const data = new Map<string, { v: string; exp: number }>();
    return {
      data,
      isOpen: true,
      connect: async () => undefined,
      eval: async (script, { keys, arguments: args }) => {
        // Emulates INCR_WINDOW_LUA: INCR, and PEXPIRE when the key is new or has no expiry.
        expect(script).toBe(INCR_WINDOW_LUA);
        const entry = data.get(keys[0]!) ?? { v: "0", exp: Infinity };
        entry.v = String(Number(entry.v) + 1);
        if (Number(entry.v) === 1 || entry.exp === Infinity) entry.exp = Date.now() + Number(args[0]);
        data.set(keys[0]!, entry);
        return Number(entry.v);
      },
      set: async (key, value, options) => {
        data.set(key, { v: value, exp: Date.now() + options.PX });
        return "OK";
      },
      pTTL: async (key) => {
        const entry = data.get(key);
        return entry ? (entry.exp === Infinity ? -1 : entry.exp - Date.now()) : -2;
      },
      del: async (keys) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
        return 1;
      },
    };
  };

  test("two core instances over one Redis share the lock", async () => {
    const redis = fakeRedis();
    const instanceA = new RedisAuthStateStore("redis://x", "t:", () => redis);
    const instanceB = new RedisAuthStateStore("redis://x", "t:", () => redis);
    setAuthStateStore(instanceA);
    for (let i = 0; i < 5; i += 1) await recordLoginFailure("dave@example.com", null);
    setAuthStateStore(instanceB);
    await expect(assertLoginAllowed("dave@example.com", null)).rejects.toThrow();
    // Keys never carry the clear identifier.
    expect([...redis.data.keys()].some((key) => key.includes("dave"))).toBe(false);
  });

  test("no throttle counter or lock flag can exist in Redis without an expiry", async () => {
    const redis = fakeRedis();
    setAuthStateStore(new RedisAuthStateStore("redis://x", "t:", () => redis));
    for (let i = 0; i < 6; i += 1) await recordLoginFailure("grace@example.com", "203.0.113.5");
    await revokeSession("jti-atomic", Math.floor(Date.now() / 1000) + 3600);
    expect(redis.data.size).toBeGreaterThan(3);
    for (const [key, entry] of redis.data) {
      expect([key, Number.isFinite(entry.exp)]).toEqual([key, true]);
    }
  });

  test("a Redis outage degrades to in-memory counters instead of failing login", async () => {
    const broken: RedisLike = {
      isOpen: true,
      connect: async () => undefined,
      eval: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
      pTTL: async () => {
        throw new Error("down");
      },
      del: async () => {
        throw new Error("down");
      },
    };
    setAuthStateStore(new FallbackAuthStateStore(new RedisAuthStateStore("redis://x", "t:", () => broken)));
    for (let i = 0; i < 5; i += 1) await recordLoginFailure("erin@example.com", null);
    await expect(assertLoginAllowed("erin@example.com", null)).rejects.toThrow();
    await expect(assertLoginAllowed("frank@example.com", null)).resolves.toBeUndefined();
  });
});
