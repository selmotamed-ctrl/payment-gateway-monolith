import { describe, expect, test } from "bun:test";
import {
  RedisCacheAdapter,
  VelocityUnavailableError,
  parseVelocityFailurePolicy,
  type VelocityFailurePolicy,
} from "../../lib/storageEngine/redisCacheAndVelocityAdapter";
import type { VelocityCheckDescriptor } from "../../lib/storageEngine/ports";

const rule = (ruleId: string, maxCount = 1): VelocityCheckDescriptor => ({
  ruleId,
  scopeKey: "merchant-1",
  windowSeconds: 60,
  maxCount,
  maxAmountMinor: null,
});

type Script = (sha: string | null, args: string[]) => Promise<unknown>;

const redisDouble = (behaviour: { script?: Script; scriptLoad?: () => Promise<string>; hang?: boolean }) => ({
  isOpen: true,
  connect: async () => undefined,
  get: async () => null,
  set: async () => undefined,
  del: async () => undefined,
  keys: async () => [],
  quit: async () => undefined,
  scriptLoad: behaviour.scriptLoad ?? (async () => "sha"),
  evalSha: async (sha: string, options: { arguments: string[] }) => {
    if (behaviour.hang) return new Promise(() => undefined);
    return (behaviour.script ?? (async () => [1, "1", 0, 0]))(sha, options.arguments);
  },
  eval: async (_script: string, options: { arguments: string[] }) => {
    if (behaviour.hang) return new Promise(() => undefined);
    return (behaviour.script ?? (async () => [1, "1", 0, 0]))(null, options.arguments);
  },
});

const adapter = (
  policy: VelocityFailurePolicy | undefined,
  behaviour: Parameters<typeof redisDouble>[0],
  extra: { timeoutMs?: number; onDegraded?: () => void } = {},
) =>
  new RedisCacheAdapter({
    url: "redis://unused",
    keyPrefix: "t:",
    velocityFailurePolicy: policy,
    velocityCommandTimeoutMs: extra.timeoutMs,
    onVelocityDegraded: extra.onDegraded,
    clientFactory: () => redisDouble(behaviour),
  });

const down: Script = async () => {
  throw new Error("REDIS_DOWN");
};

describe("GAP-031 velocity failure policy", () => {
  test("parses the policy and defaults to local-fallback", () => {
    expect(parseVelocityFailurePolicy("FAIL-CLOSED")).toBe("fail-closed");
    expect(parseVelocityFailurePolicy(" fail-open ")).toBe("fail-open");
    expect(parseVelocityFailurePolicy("nonsense")).toBe("local-fallback");
    expect(parseVelocityFailurePolicy(undefined)).toBe("local-fallback");
  });

  test("healthy Redis is not degraded", async () => {
    const result = await adapter(undefined, {}).incrWindowCounter([rule("r1")], 5n, 1_000);
    expect(result.degraded).toBeUndefined();
    expect(result.windowStats.r1).toEqual({ count: 1, amountMinor: 1n });
  });

  test("local-fallback (default) keeps enforcing per node and flags the result degraded", async () => {
    let degraded = 0;
    const cache = adapter(undefined, { script: down }, { onDegraded: () => (degraded += 1) });
    const first = await cache.incrWindowCounter([rule("r1")], 5n, 1_000);
    expect(first.degraded).toBe(true);
    expect(first.allowed).toBe(true);
    const second = await cache.incrWindowCounter([rule("r1")], 5n, 1_001);
    expect(second.violatedRuleIds).toEqual(["r1"]);
    expect(second.allowed).toBe(false);
    expect(degraded).toBe(2);
    expect(cache.degradedVelocityEvaluations).toBe(2);
  });

  test("fail-open allows without counting", async () => {
    const cache = adapter("fail-open", { script: down });
    for (const at of [1, 2, 3]) {
      const result = await cache.incrWindowCounter([rule("r1")], 5n, at);
      expect(result).toMatchObject({ allowed: true, degraded: true, violatedRuleIds: [], windowStats: {} });
    }
  });

  test("fail-closed throws VelocityUnavailableError", async () => {
    const cache = adapter("fail-closed", { script: down });
    const error = await cache.incrWindowCounter([rule("r1")], 5n, 1).catch((e) => e);
    expect(error).toBeInstanceOf(VelocityUnavailableError);
    expect((error as VelocityUnavailableError).code).toBe("VELOCITY_STORE_UNAVAILABLE");
  });

  test("a hung Redis is cut off by the command timeout instead of stalling the payment", async () => {
    const cache = adapter("local-fallback", { hang: true }, { timeoutMs: 20 });
    const started = Date.now();
    const result = await cache.incrWindowCounter([rule("r1")], 5n, 1);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.degraded).toBe(true);
    const closed = adapter("fail-closed", { hang: true }, { timeoutMs: 20 });
    await expect(closed.incrWindowCounter([rule("r1")], 5n, 1)).rejects.toBeInstanceOf(VelocityUnavailableError);
  });

  test("a failure midway only degrades the descriptors Redis did not apply", async () => {
    let calls = 0;
    const cache = adapter("local-fallback", {
      script: async () => {
        calls += 1;
        if (calls === 1) return [3, "15", 1, 0];
        throw new Error("REDIS_DOWN");
      },
    });
    const result = await cache.incrWindowCounter([rule("r1", 2), rule("r2", 5)], 5n, 1_000);
    expect(result.degraded).toBe(true);
    // r1 comes from Redis (violated there), r2 from the local window (count 1)
    expect(result.violatedRuleIds).toEqual(["r1"]);
    expect(result.windowStats.r1).toEqual({ count: 3, amountMinor: 15n });
    expect(result.windowStats.r2).toEqual({ count: 1, amountMinor: 5n });
  });

  test("an unreachable Redis at construction is not an unhandled rejection", async () => {
    const cache = new RedisCacheAdapter({
      url: "redis://unused",
      velocityFailurePolicy: "fail-open",
      clientFactory: () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const result = await cache.incrWindowCounter([rule("r1")], 5n, 1);
    expect(result.degraded).toBe(true);
    await cache.close();
  });
});
