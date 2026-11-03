import { describe, expect, test } from "bun:test";
import { createClient } from "redis";
import {
  MemoryCacheAdapter,
  RedisCacheAdapter,
} from "../../lib/storageEngine/redisCacheAndVelocityAdapter";
import type { VelocityCheckDescriptor } from "../../lib/storageEngine/ports";
import {
  REDIS_URL,
  describeRedis,
  uniqueId,
} from "./helpers/db";

const descriptor = (
  overrides: Partial<VelocityCheckDescriptor> = {},
): VelocityCheckDescriptor => ({
  ruleId: "velocity-1",
  scopeKey: "merchant-1",
  windowSeconds: 10,
  maxCount: 10,
  maxAmountMinor: null,
  ...overrides,
});

describe("MemoryCacheAdapter", () => {
  test("single-flights 100 concurrent loaders into one call", async () => {
    const cache = new MemoryCacheAdapter();
    let loads = 0;
    const loader = async (): Promise<{ answer: number }> => {
      loads += 1;
      await Bun.sleep(20);
      return { answer: 42 };
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => cache.getOrLoad("single-flight", 60, loader)),
    );
    expect(loads).toBe(1);
    expect(results.every((value) => value.answer === 42)).toBe(true);
    const cached = await cache.getOrLoad("single-flight", 60, loader);
    expect(cached.answer).toBe(42);
    expect(loads).toBe(1);
  });

  test("honours TTLs and removes expired entries", async () => {
    const cache = new MemoryCacheAdapter();
    let loads = 0;
    const loader = async (): Promise<number> => {
      loads += 1;
      return loads;
    };
    await cache.getOrLoad("short-l1", 60, loader, { l1TtlMs: 10 });
    expect(loads).toBe(1);
    await Bun.sleep(30);
    expect(await cache.get<number>("short-l1")).toBeNull();
    await cache.getOrLoad("short-l1", 60, loader, { l1TtlMs: 10 });
    expect(loads).toBe(2);

    await cache.set("short-set", 1, 1);
    expect(await cache.get<number>("short-set")).toBe(1);
    await Bun.sleep(1_050);
    expect(await cache.get<number>("short-set")).toBeNull();
  });

  test("deletes an exact key or every key under a prefix", async () => {
    const cache = new MemoryCacheAdapter();
    await cache.set("prefix:a", 1, 60);
    await cache.set("prefix:b", 2, 60);
    await cache.set("other", 3, 60);
    await cache.del("prefix:");
    expect(await cache.get<number>("prefix:a")).toBeNull();
    expect(await cache.get<number>("prefix:b")).toBeNull();
    expect(await cache.get<number>("other")).toBe(3);

    await cache.set("exact", 4, 60);
    await cache.del("exact");
    expect(await cache.get<number>("exact")).toBeNull();
  });

  test("counts and sums a sliding window, including violations", async () => {
    const cache = new MemoryCacheAdapter();
    const now = 1_000_000;
    const rule = descriptor({ maxCount: 2, maxAmountMinor: 100n });
    const first = await cache.incrWindowCounter([rule], 40n, now);
    expect(first).toEqual({
      allowed: true,
      violatedRuleIds: [],
      flaggedRuleIds: [],
      windowStats: { "velocity-1": { count: 1, amountMinor: 40n } },
    });
    const second = await cache.incrWindowCounter([rule], 40n, now + 1_000);
    expect(second.allowed).toBe(true);
    expect(second.windowStats["velocity-1"]).toEqual({ count: 2, amountMinor: 80n });

    const third = await cache.incrWindowCounter([rule], 40n, now + 2_000);
    expect(third.allowed).toBe(false);
    expect(third.violatedRuleIds).toEqual(["velocity-1"]);
    expect(third.flaggedRuleIds).toEqual(["velocity-1"]);
    expect(third.windowStats["velocity-1"]).toEqual({ count: 3, amountMinor: 120n });
  });

  test("prunes entries exactly at the now-window boundary", async () => {
    const cache = new MemoryCacheAdapter();
    const rule = descriptor({ windowSeconds: 10, maxCount: 100 });
    await cache.incrWindowCounter([rule], 5n, 10_000);
    const boundary = await cache.incrWindowCounter([rule], 5n, 20_000);
    expect(boundary.windowStats["velocity-1"]?.count).toBe(2);
    const afterBoundary = await cache.incrWindowCounter([rule], 5n, 20_001);
    expect(afterBoundary.windowStats["velocity-1"]?.count).toBe(2);
    expect(afterBoundary.windowStats["velocity-1"]?.amountMinor).toBe(10n);
  });

  test("evaluates multiple descriptors independently and treats null amount as unconstrained", async () => {
    const cache = new MemoryCacheAdapter();
    const countRule = descriptor({ ruleId: "count", maxCount: 1 });
    const amountRule = descriptor({
      ruleId: "amount",
      maxCount: 100,
      maxAmountMinor: 10n,
    });
    const result = await cache.incrWindowCounter([countRule, amountRule], 20n, 5_000);
    expect(result.allowed).toBe(false);
    expect(result.violatedRuleIds).toEqual([]);
    expect(result.flaggedRuleIds).toEqual(["amount"]);
    expect(result.windowStats).toEqual({
      count: { count: 1, amountMinor: 20n },
      amount: { count: 1, amountMinor: 20n },
    });
  });
});

describeRedis("RedisCacheAdapter (live Redis)", () => {
  test("connects, round-trips JSON through L2 and deletes prefixes", async () => {
    const prefix = `${uniqueId("redis-prefix")}:`;
    const writer = new RedisCacheAdapter({ url: REDIS_URL, keyPrefix: prefix });
    const reader = new RedisCacheAdapter({ url: REDIS_URL, keyPrefix: prefix });
    try {
      const value = {
        id: "merchant-1",
        amount: "1234.5000",
        nested: [1, { ok: true, nil: null }],
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      await writer.set("object", value, 60);
      expect(await writer.get<typeof value>("object")).toEqual(value);
      // A second adapter has an empty L1, so this read came from Redis.
      expect(await reader.get<typeof value>("object")).toEqual(value);

      await writer.set("a:1", { n: 1 }, 60);
      await writer.set("a:2", { n: 2 }, 60);
      await writer.set("b:1", { n: 3 }, 60);
      await writer.del("a:");
      expect(await reader.get<{ n: number }>("a:1")).toBeNull();
      expect(await reader.get<{ n: number }>("a:2")).toBeNull();
      expect(await reader.get<{ n: number }>("b:1")).toEqual({ n: 3 });
    } finally {
      await writer.del("");
      await writer.close();
      await reader.close();
    }
  });

  test("the Lua sliding window flags count and amount violations", async () => {
    const prefix = `${uniqueId("redis-velocity")}:`;
    const cache = new RedisCacheAdapter({ url: REDIS_URL, keyPrefix: prefix });
    try {
      const rule = descriptor({ maxCount: 2, maxAmountMinor: 100n });
      const now = 1_700_000_000_000;
      const first = await cache.incrWindowCounter([rule], 10n, now);
      const second = await cache.incrWindowCounter([rule], 20n, now + 1);
      const third = await cache.incrWindowCounter([rule], 80n, now + 2);
      expect(first.windowStats["velocity-1"]).toEqual({ count: 1, amountMinor: 10n });
      expect(second.windowStats["velocity-1"]).toEqual({ count: 2, amountMinor: 30n });
      expect(third.allowed).toBe(false);
      expect(third.violatedRuleIds).toEqual(["velocity-1"]);
      expect(third.flaggedRuleIds).toEqual(["velocity-1"]);
      expect(third.windowStats["velocity-1"]).toEqual({ count: 3, amountMinor: 110n });
    } finally {
      await cache.del("");
      await cache.close();
    }
  });

  test("falls back from EVALSHA to EVAL when Redis reports NOSCRIPT", async () => {
    const real = createClient({ url: REDIS_URL });
    real.on("error", () => undefined);
    await real.connect();
    let failNextSha = true;
    const wrapper = {
      isOpen: true,
      connect: async (): Promise<unknown> => undefined,
      get: (key: string) => real.get(key),
      set: (key: string, value: string, options?: { EX?: number }) =>
        real.set(key, value, options as never),
      del: (keys: string | string[]) => real.del(keys),
      evalSha: async (
        sha: string,
        options: { keys: string[]; arguments: string[] },
      ): Promise<unknown> => {
        if (failNextSha) {
          failNextSha = false;
          throw new Error("NOSCRIPT No matching script");
        }
        return real.evalSha(sha, options as never);
      },
      eval: (script: string, options: { keys: string[]; arguments: string[] }) =>
        real.eval(script, options as never),
      scriptLoad: (script: string) => real.scriptLoad(script),
      keys: (pattern: string) => real.keys(pattern),
      quit: async (): Promise<unknown> => undefined,
    };
    const cache = new RedisCacheAdapter({
      url: REDIS_URL,
      keyPrefix: `${uniqueId("redis-eval-fallback")}:`,
      clientFactory: () => wrapper,
    });
    try {
      const rule = descriptor({ maxCount: 10 });
      const first = await cache.incrWindowCounter([rule], 5n, 1_000);
      expect(first.windowStats["velocity-1"]?.count).toBe(1);
      const second = await cache.incrWindowCounter([rule], 5n, 1_001);
      expect(second.windowStats["velocity-1"]?.count).toBe(2);
      expect(failNextSha).toBe(false);
    } finally {
      await cache.del("");
      await cache.close();
      await real.quit();
    }
  });

  test("falls back to L1/memory when the Redis transport is down", async () => {
    const broken = {
      isOpen: true,
      connect: async (): Promise<unknown> => undefined,
      get: async (): Promise<string | null> => {
        throw new Error("REDIS_DOWN");
      },
      set: async (): Promise<unknown> => {
        throw new Error("REDIS_DOWN");
      },
      del: async (): Promise<unknown> => {
        throw new Error("REDIS_DOWN");
      },
      evalSha: async (): Promise<unknown> => {
        throw new Error("REDIS_DOWN");
      },
      eval: async (): Promise<unknown> => {
        throw new Error("REDIS_DOWN");
      },
      scriptLoad: async (): Promise<string> => "sha",
      keys: async (): Promise<string[]> => {
        throw new Error("REDIS_DOWN");
      },
      quit: async (): Promise<unknown> => undefined,
    };
    const cache = new RedisCacheAdapter({
      url: "redis://127.0.0.1:1",
      keyPrefix: `${uniqueId("redis-down")}:`,
      clientFactory: () => broken,
    });
    try {
      await cache.set("value", { ok: true }, 60);
      expect(await cache.get<{ ok: boolean }>("value")).toEqual({ ok: true });
      const loaded = await cache.getOrLoad("loaded", 60, async () => 42);
      expect(loaded).toBe(42);
      const result = await cache.incrWindowCounter([descriptor({ maxCount: 1 })], 7n, 10);
      expect(result.windowStats["velocity-1"]).toEqual({ count: 1, amountMinor: 7n });
      const violated = await cache.incrWindowCounter([descriptor({ maxCount: 1 })], 7n, 11);
      expect(violated.violatedRuleIds).toEqual(["velocity-1"]);
    } finally {
      await cache.close();
    }
  });
});
