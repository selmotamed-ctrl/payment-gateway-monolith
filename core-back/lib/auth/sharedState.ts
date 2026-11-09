import { env } from "../env";

/**
 * Shared, TTL-bound state for authentication back-pressure (login/MFA throttles) and
 * the session revoke list.
 *
 * Policy (GAP-027 / GAP-019):
 * - When `REDIS_URL` is configured, state lives in Redis and is shared by every core
 *   instance.
 * - If Redis is not configured, or a Redis call fails, the call degrades to a
 *   per-process in-memory store. That is a deliberate availability-over-strictness
 *   policy: login must keep working during a Redis outage, and the durable MFA
 *   protection (attempt counter on `mfa_challenges`) plus the 12h session lifetime
 *   bound the exposure. Keys never contain a clear identifier: callers hash them.
 */
export interface AuthStateStore {
  /** Increments a counter, starting a fresh window of `windowMs` when none is active. */
  incrWindow(key: string, windowMs: number): Promise<number>;
  /** Marks a key as set for `ttlMs`. */
  setFlag(key: string, ttlMs: number): Promise<void>;
  /** Remaining lifetime of a flag in ms (0 when absent). */
  flagRemainingMs(key: string): Promise<number>;
  del(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

const MAX_ENTRIES = 20_000;

export class MemoryAuthStateStore implements AuthStateStore {
  private readonly counters = new Map<string, { count: number; expiresAt: number }>();
  private readonly flags = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  private prune(): void {
    const now = this.now();
    if (this.counters.size + this.flags.size < MAX_ENTRIES) return;
    for (const [key, entry] of this.counters) if (entry.expiresAt <= now) this.counters.delete(key);
    for (const [key, expiresAt] of this.flags) if (expiresAt <= now) this.flags.delete(key);
    for (const map of [this.counters, this.flags] as Array<Map<string, unknown>>) {
      if (map.size >= MAX_ENTRIES) {
        // Under a key flood, drop the oldest half rather than grow without bound.
        let toDrop = Math.floor(map.size / 2);
        for (const key of map.keys()) {
          if (toDrop-- <= 0) break;
          map.delete(key);
        }
      }
    }
  }

  async incrWindow(key: string, windowMs: number): Promise<number> {
    this.prune();
    const now = this.now();
    let entry = this.counters.get(key);
    if (!entry || entry.expiresAt <= now) {
      entry = { count: 0, expiresAt: now + windowMs };
      this.counters.set(key, entry);
    }
    entry.count += 1;
    return entry.count;
  }

  async setFlag(key: string, ttlMs: number): Promise<void> {
    this.prune();
    this.flags.set(key, this.now() + ttlMs);
  }

  async flagRemainingMs(key: string): Promise<number> {
    const expiresAt = this.flags.get(key);
    if (expiresAt === undefined) return 0;
    const remaining = expiresAt - this.now();
    if (remaining <= 0) {
      this.flags.delete(key);
      return 0;
    }
    return remaining;
  }

  async del(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.counters.delete(key);
      this.flags.delete(key);
    }
  }

  async clear(): Promise<void> {
    this.counters.clear();
    this.flags.clear();
  }
}

export interface RedisLike {
  isOpen: boolean;
  connect(): Promise<unknown>;
  /** Atomic increment-with-window (see `INCR_WINDOW_LUA`). */
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  /** `SET key value PX ttl`: value and expiry are written in ONE command. */
  set(key: string, value: string, options: { PX: number }): Promise<unknown>;
  pTTL(key: string): Promise<number>;
  del(keys: string | string[]): Promise<unknown>;
}

/**
 * INCR and the window expiry in one atomic step. The previous `INCR` then `PEXPIRE` could be interrupted between
 * the two (a crash, a dropped connection), leaving a counter with no expiry that kept an account throttled forever.
 * The expiry is also re-applied when a key is found without one.
 */
export const INCR_WINDOW_LUA = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export class RedisAuthStateStore implements AuthStateStore {
  private clientPromise: Promise<RedisLike> | null = null;

  constructor(
    private readonly url: string,
    private readonly keyPrefix = "pgauth:",
    private readonly clientFactory?: (url: string) => RedisLike,
  ) {}

  private client(): Promise<RedisLike> {
    this.clientPromise ??= (async () => {
      const factory =
        this.clientFactory ??
        ((url: string) =>
          (require("redis") as { createClient: (config: { url: string }) => RedisLike }).createClient({ url }));
      const instance = factory(this.url);
      if (!instance.isOpen) await instance.connect();
      return instance;
    })().catch((error) => {
      this.clientPromise = null;
      throw error;
    });
    return this.clientPromise;
  }

  async incrWindow(key: string, windowMs: number): Promise<number> {
    const client = await this.client();
    const full = this.keyPrefix + key;
    return Number(await client.eval(INCR_WINDOW_LUA, { keys: [full], arguments: [String(Math.max(1, windowMs))] }));
  }

  async setFlag(key: string, ttlMs: number): Promise<void> {
    const client = await this.client();
    const full = this.keyPrefix + key;
    // One command: a flag written without its expiry (a lockout or a revocation that never ends) cannot exist.
    await client.set(full, "1", { PX: Math.max(1, Math.round(ttlMs)) });
  }

  async flagRemainingMs(key: string): Promise<number> {
    const ttl = await (await this.client()).pTTL(this.keyPrefix + key);
    return ttl > 0 ? ttl : 0;
  }

  async del(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await (await this.client()).del(keys.map((key) => this.keyPrefix + key));
  }

  async clear(): Promise<void> {
    // Intentionally a no-op for Redis: only the memory store is wiped by tests.
  }
}

/** Redis first, in-memory fallback on any failure (see the policy above). */
export class FallbackAuthStateStore implements AuthStateStore {
  constructor(
    private readonly primary: AuthStateStore,
    private readonly fallback: AuthStateStore = new MemoryAuthStateStore(),
  ) {}

  async incrWindow(key: string, windowMs: number): Promise<number> {
    try {
      return await this.primary.incrWindow(key, windowMs);
    } catch {
      return this.fallback.incrWindow(key, windowMs);
    }
  }

  async setFlag(key: string, ttlMs: number): Promise<void> {
    // Mirrored locally so a flag written during an outage is still honoured on this node.
    await this.fallback.setFlag(key, ttlMs);
    try {
      await this.primary.setFlag(key, ttlMs);
    } catch {
      // degraded: local only
    }
  }

  async flagRemainingMs(key: string): Promise<number> {
    const local = await this.fallback.flagRemainingMs(key);
    try {
      return Math.max(local, await this.primary.flagRemainingMs(key));
    } catch {
      return local;
    }
  }

  async del(keys: string[]): Promise<void> {
    await this.fallback.del(keys);
    try {
      await this.primary.del(keys);
    } catch {
      // ignore
    }
  }

  async clear(): Promise<void> {
    await this.fallback.clear();
    await this.primary.clear();
  }
}

let store: AuthStateStore | undefined;

export const getAuthStateStore = (): AuthStateStore => {
  if (!store) {
    const url = env.REDIS_URL;
    store = url ? new FallbackAuthStateStore(new RedisAuthStateStore(url)) : new MemoryAuthStateStore();
  }
  return store;
};

/** Test hook: inject a store, or with no argument reset to the env-derived one. */
export const setAuthStateStore = (next?: AuthStateStore): void => {
  store = next;
};
