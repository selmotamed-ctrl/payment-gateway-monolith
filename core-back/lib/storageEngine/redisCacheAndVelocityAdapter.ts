import type {
  CachePort,
  VelocityCheckDescriptor,
  VelocityEvaluationResult,
} from "./ports";

interface CacheEntry {
  value: unknown;
  expiresAtMs: number;
}

interface WindowEntry {
  atMs: number;
  amountMinor: bigint;
}

export const VELOCITY_LUA_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])
local maxCount = tonumber(ARGV[4])
local maxAmount = tonumber(ARGV[5])
local member = ARGV[6]
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
redis.call('ZADD', key, now, member)
local entries = redis.call('ZRANGE', key, 0, -1)
local count = #entries
local sum = 0
for i = 1, #entries do
  local parsed = string.match(entries[i], '^(%-?%d+):')
  if parsed then sum = sum + tonumber(parsed) end
end
redis.call('PEXPIRE', key, windowMs)
local countViolation = 1
if count <= maxCount then countViolation = 0 end
local amountViolation = 0
if maxAmount >= 0 and sum > maxAmount then amountViolation = 1 end
return {count, sum, countViolation, amountViolation}
`;

export class MemoryCacheAdapter implements CachePort {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly windows = new Map<string, WindowEntry[]>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private sequence = 0;

  public async get<T>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value as T;
  }

  public async getOrLoad<T>(
    key: string,
    ttlSec: number,
    loader: () => Promise<T>,
    options?: { l1TtlMs?: number },
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const pending = (async () => {
      const value = await loader();
      const ttlMs = options?.l1TtlMs ?? ttlSec * 1_000;
      this.entries.set(key, { value, expiresAtMs: Date.now() + ttlMs });
      return value;
    })();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  public async set<T>(key: string, value: T, ttlSec: number): Promise<void> {
    this.entries.set(key, {
      value,
      expiresAtMs: Date.now() + Math.max(1, ttlSec) * 1_000,
    });
  }

  public async del(keyOrPrefix: string): Promise<void> {
    if (this.entries.delete(keyOrPrefix)) {
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(keyOrPrefix)) {
        this.entries.delete(key);
      }
    }
  }

  public async incrWindowCounter(
    descriptors: VelocityCheckDescriptor[],
    incrementAmountMinor: bigint,
    nowEpochMs: number,
  ): Promise<VelocityEvaluationResult> {
    const violatedRuleIds: string[] = [];
    const flaggedRuleIds: string[] = [];
    const windowStats: Record<string, { count: number; amountMinor: bigint }> = {};

    for (const descriptor of descriptors) {
      const key = `${descriptor.ruleId}:${descriptor.scopeKey}:${descriptor.windowSeconds}`;
      const cutoff = nowEpochMs - descriptor.windowSeconds * 1_000;
      const existing = (this.windows.get(key) ?? []).filter((entry) => entry.atMs >= cutoff);
      existing.push({ atMs: nowEpochMs, amountMinor: incrementAmountMinor });
      this.windows.set(key, existing);

      const count = existing.length;
      const amountMinor = existing.reduce((sum, entry) => sum + entry.amountMinor, 0n);
      windowStats[descriptor.ruleId] = { count, amountMinor };

      if (count > descriptor.maxCount) {
        violatedRuleIds.push(descriptor.ruleId);
      }
      if (descriptor.maxAmountMinor !== null && amountMinor > descriptor.maxAmountMinor) {
        flaggedRuleIds.push(descriptor.ruleId);
      }
    }

    return {
      allowed: violatedRuleIds.length === 0 && flaggedRuleIds.length === 0,
      violatedRuleIds,
      flaggedRuleIds,
      windowStats,
    };
  }
}

type RedisClientLike = {
  isOpen: boolean;
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  del(keys: string | string[]): Promise<unknown>;
  evalSha(
    sha: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
  keys(pattern: string): Promise<string[]>;
  quit(): Promise<unknown>;
};

export interface RedisCacheOptions {
  url: string;
  keyPrefix?: string;
  clientFactory?: (url: string) => RedisClientLike;
}

export class RedisCacheAdapter implements CachePort {
  private readonly l1 = new MemoryCacheAdapter();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly keyPrefix: string;
  private readonly scriptShaPromise: Promise<string>;
  private sequence = 0;
  private clientPromise: Promise<RedisClientLike> | null = null;

  constructor(private readonly options: RedisCacheOptions) {
    this.keyPrefix = options.keyPrefix ?? "pgcache:";
    const client = this.client();
    this.scriptShaPromise = client.then((instance) => instance.scriptLoad(VELOCITY_LUA_SCRIPT));
  }

  private client(): Promise<RedisClientLike> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const factory =
          this.options.clientFactory ??
          ((url: string) => {
            const redisModule = require("redis") as {
              createClient: (config: { url: string }) => RedisClientLike;
            };
            return redisModule.createClient({ url });
          });
        const instance = factory(this.options.url);
        if (!instance.isOpen) {
          await instance.connect();
        }
        return instance;
      })();
    }
    return this.clientPromise;
  }

  private fullKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  public async get<T>(key: string): Promise<T | null> {
    const l1Value = await this.l1.get<T>(key);
    if (l1Value !== null) {
      return l1Value;
    }
    try {
      const raw = await (await this.client()).get(this.fullKey(key));
      if (raw === null) {
        return null;
      }
      const value = JSON.parse(raw) as T;
      await this.l1.set(key, value, 30);
      return value;
    } catch {
      return null;
    }
  }

  public async getOrLoad<T>(
    key: string,
    ttlSec: number,
    loader: () => Promise<T>,
    options?: { l1TtlMs?: number },
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }
    const pending = (async () => {
      const value = await loader();
      await this.set(key, value, ttlSec, options);
      return value;
    })();
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  public async set<T>(
    key: string,
    value: T,
    ttlSec: number,
    options?: { l1TtlMs?: number },
  ): Promise<void> {
    await this.l1.set(key, value, ttlSec);
    try {
      await (await this.client()).set(this.fullKey(key), JSON.stringify(value), {
        EX: Math.max(1, ttlSec),
      });
    } catch {
      // L1 still serves this node; Redis is a cache, never the source of truth.
    }
    void options;
  }

  public async del(keyOrPrefix: string): Promise<void> {
    await this.l1.del(keyOrPrefix);
    try {
      const client = await this.client();
      const keys = await client.keys(`${this.fullKey(keyOrPrefix)}*`);
      if (keys.length > 0) {
        await client.del(keys);
      }
    } catch {
      // Ignore cache invalidation transport failures.
    }
  }

  public async incrWindowCounter(
    descriptors: VelocityCheckDescriptor[],
    incrementAmountMinor: bigint,
    nowEpochMs: number,
  ): Promise<VelocityEvaluationResult> {
    const violatedRuleIds: string[] = [];
    const flaggedRuleIds: string[] = [];
    const windowStats: Record<string, { count: number; amountMinor: bigint }> = {};

    try {
      const client = await this.client();
      const sha = await this.scriptShaPromise;
      for (const descriptor of descriptors) {
        const key = this.fullKey(
          `vel:${descriptor.ruleId}:${descriptor.scopeKey}:${descriptor.windowSeconds}`,
        );
        const member = `${incrementAmountMinor.toString()}:${nowEpochMs}:${this.sequence++}`;
        const args = [
          String(nowEpochMs),
          String(descriptor.windowSeconds * 1_000),
          incrementAmountMinor.toString(),
          String(descriptor.maxCount),
          descriptor.maxAmountMinor === null ? "-1" : descriptor.maxAmountMinor.toString(),
          member,
        ];
        let result: unknown;
        try {
          result = await client.evalSha(sha, { keys: [key], arguments: args });
        } catch {
          result = await client.eval(VELOCITY_LUA_SCRIPT, { keys: [key], arguments: args });
        }
        const [countRaw, amountRaw, countViolation, amountViolation] = result as Array<
          number | string
        >;
        const count = Number(countRaw ?? 0);
        const amountMinor = BigInt(String(amountRaw ?? "0"));
        windowStats[descriptor.ruleId] = { count, amountMinor };
        if (Number(countViolation) === 1) {
          violatedRuleIds.push(descriptor.ruleId);
        }
        if (Number(amountViolation) === 1) {
          flaggedRuleIds.push(descriptor.ruleId);
        }
      }
    } catch {
      return this.l1.incrWindowCounter(descriptors, incrementAmountMinor, nowEpochMs);
    }

    return {
      allowed: violatedRuleIds.length === 0 && flaggedRuleIds.length === 0,
      violatedRuleIds,
      flaggedRuleIds,
      windowStats,
    };
  }

  public async close(): Promise<void> {
    try {
      await (await this.client()).quit();
    } catch {
      // Client may never have connected.
    }
  }
}
