import {
  invalidationBus,
  createPrismaInvalidationEventStore,
  payloadKeyOf,
  topicMatchesPattern,
  type CacheInvalidationDatabase,
  type CacheInvalidationEventRecord,
  type CacheInvalidationEventStore,
  type InvalidationBus,
  type InvalidationEvent,
} from "../invalidationBus";

/**
 * Configuration caching rules of design `high_scale_db_architecture_v2.md`
 * §2.9. There are three classes and they are deliberately not configurable in
 * a way that weakens the security class:
 *
 * | Class | Examples | Rule |
 * | --- | --- | --- |
 * | A | gateway versions, flows, steps, crypto profiles, status rules, error maps, notification templates by version | immutable or versioned; long TTL; no invalidation needed |
 * | B | platform settings, active velocity/AML rules, commission profiles, rails, routes (without health) | TTL <= 30 s plus bus invalidation; stores the row version |
 * | C | token revocation, merchant/wallet status, route health, credential-set status, maintenance windows | never cached longer than 2 s; money operations re-read the security row inside the transaction |
 */
export type ConfigCacheClass = "A" | "B" | "C";
export type CacheClass = ConfigCacheClass;

export const CONFIG_CACHE_CLASS_TTL_MS: Record<ConfigCacheClass, number> = {
  A: 24 * 60 * 60 * 1_000,
  B: 30_000,
  C: 2_000,
};

export const CONFIG_CACHE_TTL_MS = CONFIG_CACHE_CLASS_TTL_MS;
export const CACHE_CLASS_TTL_MS = CONFIG_CACHE_CLASS_TTL_MS;
export const IMMUTABLE_CONFIG_TTL_MS = CONFIG_CACHE_CLASS_TTL_MS.A;
export const TUNABLE_CONFIG_TTL_MS = CONFIG_CACHE_CLASS_TTL_MS.B;
export const SECURITY_CONFIG_TTL_MS = CONFIG_CACHE_CLASS_TTL_MS.C;

export const CONFIG_CACHE_POLL_INTERVAL_MS = 1_000;
export const CONFIG_CACHE_EVENT_RETENTION_MS = 60 * 60 * 1_000;
export const CONFIG_CACHE_PURGE_INTERVAL_MS = 60_000;
export const CONFIG_CACHE_BATCH_SIZE = 500;

export type ConfigCacheVersion = string | number | null;

/**
 * Optional Redis-compatible backing store. Values are JSON envelopes, so the
 * cache can be shared between nodes without coupling to a Redis client.
 */
export interface ConfigCacheRedis {
  get(key: string): Promise<string | null | undefined> | string | null | undefined;
  set(key: string, value: string, ttlMs: number): Promise<unknown> | unknown;
  del(key: string): Promise<unknown> | unknown;
  /** Optional alternative when the client exposes `setex` instead of `set`. */
  setex?(key: string, ttlSeconds: number, value: string): Promise<unknown> | unknown;
}

export interface ConfigCacheGetOptions<T> {
  cacheClass?: ConfigCacheClass;
  /** Clamped to the maximum of the class. */
  ttlMs?: number;
  version?: ConfigCacheVersion | ((value: T) => ConfigCacheVersion | undefined);
  /** Bus topics that invalidate this entry, e.g. `configuration:platform`. */
  topics?: readonly string[];
  /** Bypass the cache read and reload from the source (used inside a tx). */
  bypassCache?: boolean;
}

export interface ConfigCacheDefinition<T = unknown> {
  key: string;
  cacheClass: ConfigCacheClass;
  load: () => Promise<T>;
  topics?: readonly string[] | ((value: T) => readonly string[]);
  ttlMs?: number;
  version?: ConfigCacheVersion | ((value: T) => ConfigCacheVersion | undefined);
}

export interface ConfigCacheEntry<T = unknown> {
  cacheClass: ConfigCacheClass;
  key: string;
  value: T;
  version: ConfigCacheVersion;
  storedAt: number;
  expiresAt: number;
  topics: string[];
}

interface StoredConfigCacheEntry extends ConfigCacheEntry<unknown> {}

export interface ConfigCacheRegistryOptions {
  bus?: InvalidationBus;
  /** The `cache_invalidation_events` table or an already-built store. */
  database?: CacheInvalidationDatabase | CacheInvalidationEventStore;
  redis?: ConfigCacheRedis;
  now?: () => number;
  pollIntervalMs?: number;
  eventRetentionMs?: number;
  purgeIntervalMs?: number;
  batchSize?: number;
  maxEntries?: number;
  autoStart?: boolean;
  onError?: (error: unknown) => void;
}

export class ConfigCacheVersionChangedError extends Error {
  readonly code = "CONFIG_CACHE_VERSION_CHANGED";
  readonly key: string;
  readonly expected: ConfigCacheVersion;
  readonly actual: ConfigCacheVersion;

  constructor(key: string, expected: ConfigCacheVersion, actual: ConfigCacheVersion) {
    super(`Configuration '${key}' changed (cached version ${String(expected)}, current ${String(actual)})`);
    this.name = "ConfigCacheVersionChangedError";
    this.key = key;
    this.expected = expected;
    this.actual = actual;
  }
}

const isEventStore = (value: unknown): value is CacheInvalidationEventStore => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CacheInvalidationEventStore>;
  return typeof candidate.readAfter === "function" && typeof candidate.purgeBefore === "function";
};

const toBigInt = (value: bigint | number | string): bigint => {
  if (typeof value === "bigint") {
    return value;
  }
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

export const extractConfigVersion = (value: unknown): ConfigCacheVersion => {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const version = record.version ?? record.rowVersion;
    if (typeof version === "string" || typeof version === "number") {
      return version;
    }
  }
  return null;
};

const cacheKeyOf = (cacheClass: ConfigCacheClass, key: string): string => `${cacheClass}:${key}`;
const redisKeyOf = (cacheClass: ConfigCacheClass, key: string): string => `config-cache:${cacheClass}:${key}`;

const clampTtl = (cacheClass: ConfigCacheClass, requested: number | undefined): number => {
  const maximum = CONFIG_CACHE_CLASS_TTL_MS[cacheClass];
  const ttl = requested === undefined || !Number.isFinite(requested) ? maximum : Math.floor(requested);
  return Math.min(maximum, Math.max(1, ttl));
};

/**
 * A registry of the three cache classes with a memory map, an optional Redis
 * layer and bus/table invalidation. Class B entries retain the row `version`
 * so a money transaction can re-read the single row it depends on and abort
 * when it changed. Class C entries never live longer than two seconds.
 */
export class ConfigCacheRegistry {
  private readonly entries = new Map<string, StoredConfigCacheEntry>();
  private readonly definitions = new Map<string, ConfigCacheDefinition<unknown>>();
  private readonly bus?: InvalidationBus;
  private readonly redis?: ConfigCacheRedis;
  private readonly now: () => number;
  private readonly maxEntries: number;
  private readonly onError?: (error: unknown) => void;
  private source?: CacheInvalidationEventStore;
  private readonly pollIntervalMs: number;
  private readonly eventRetentionMs: number;
  private readonly purgeIntervalMs: number;
  private readonly batchSize: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastEventSeq = 0n;
  private lastPurgeAt = 0;
  private pollInFlight = false;
  private unsubscribeBus?: () => void;
  private started = false;
  private hits = 0;
  private misses = 0;

  constructor(options: ConfigCacheRegistryOptions = {}) {
    this.bus = options.bus;
    this.redis = options.redis;
    this.now = options.now ?? (() => Date.now());
    this.maxEntries = Math.max(16, options.maxEntries ?? 10_000);
    this.onError = options.onError;
    this.pollIntervalMs = options.pollIntervalMs ?? CONFIG_CACHE_POLL_INTERVAL_MS;
    this.eventRetentionMs = options.eventRetentionMs ?? CONFIG_CACHE_EVENT_RETENTION_MS;
    this.purgeIntervalMs = options.purgeIntervalMs ?? CONFIG_CACHE_PURGE_INTERVAL_MS;
    this.batchSize = options.batchSize ?? CONFIG_CACHE_BATCH_SIZE;
    if (options.database) {
      this.setDatabase(options.database);
    }
    // Listen immediately so a caller cannot forget to start the registry
    // before the first invalidation arrives. `start()` only adds the optional
    // database poller.
    this.subscribeToBus();
    if (options.autoStart) {
      this.start();
    }
  }

  register<T>(definition: ConfigCacheDefinition<T>): this;
  register<T>(
    cacheClass: ConfigCacheClass,
    key: string,
    load: () => Promise<T>,
    options?: Omit<ConfigCacheDefinition<T>, "cacheClass" | "key" | "load">,
  ): this;
  register<T>(
    definitionOrClass: ConfigCacheDefinition<T> | ConfigCacheClass,
    key?: string,
    load?: () => Promise<T>,
    options: Omit<ConfigCacheDefinition<T>, "cacheClass" | "key" | "load"> = {},
  ): this {
    const definition: ConfigCacheDefinition<T> = typeof definitionOrClass === "string"
      ? { cacheClass: definitionOrClass, key: key ?? "", load: load as () => Promise<T>, ...options }
      : definitionOrClass;
    this.definitions.set(definition.key, definition as ConfigCacheDefinition<unknown>);
    return this;
  }

  registerDefinition<T>(definition: ConfigCacheDefinition<T>): this {
    return this.register(definition);
  }

  getRegistered<T = unknown>(key: string): Promise<T> {
    const definition = this.definitions.get(key);
    if (!definition) {
      throw new Error(`Configuration cache key '${key}' is not registered`);
    }
    return this.get<T>(
      definition.cacheClass,
      key,
      definition.load as () => Promise<T>,
      {
        ...(definition.ttlMs === undefined ? {} : { ttlMs: definition.ttlMs }),
        ...(definition.version === undefined
          ? {}
          : { version: definition.version as ConfigCacheGetOptions<T>["version"] }),
      },
    );
  }

  async get<T>(
    cacheClass: ConfigCacheClass,
    key: string,
    loader: () => Promise<T>,
    options?: ConfigCacheGetOptions<T>,
  ): Promise<T>;
  async get<T>(
    key: string,
    loader: () => Promise<T>,
    options?: ConfigCacheGetOptions<T> & { cacheClass?: ConfigCacheClass },
  ): Promise<T>;
  async get<T>(
    cacheClassOrKey: ConfigCacheClass | string,
    keyOrLoader: string | (() => Promise<T>),
    loaderOrOptions?: (() => Promise<T>) | ConfigCacheGetOptions<T>,
    maybeOptions: ConfigCacheGetOptions<T> = {},
  ): Promise<T> {
    const classForm =
      (cacheClassOrKey === "A" || cacheClassOrKey === "B" || cacheClassOrKey === "C")
      && typeof keyOrLoader === "string";
    const cacheClass: ConfigCacheClass = classForm
      ? (cacheClassOrKey as ConfigCacheClass)
      : "B";
    const key: string = classForm ? (keyOrLoader as string) : cacheClassOrKey;
    const loader = (classForm ? loaderOrOptions : keyOrLoader) as () => Promise<T>;
    const options = (classForm ? maybeOptions : (loaderOrOptions as ConfigCacheGetOptions<T> | undefined)) ?? {};
    if (typeof loader !== "function") {
      throw new Error("ConfigCacheRegistry.get requires a loader function");
    }

    const definition = this.definitions.get(key);
    const definitionTopics = definition?.topics;
    const topics = options.topics
      ?? (typeof definitionTopics === "function" ? [] : definitionTopics)
      ?? [];
    const ttlMs = clampTtl(cacheClass, options.ttlMs ?? definition?.ttlMs);
    const mapKey = cacheKeyOf(cacheClass, key);

    if (!options.bypassCache) {
      const cached = this.readMemory<T>(mapKey);
      if (cached) {
        this.hits += 1;
        return cached.value;
      }
      const fromRedis = await this.readRedis<T>(cacheClass, key);
      if (fromRedis) {
        this.hits += 1;
        this.entries.set(mapKey, fromRedis);
        this.evictIfNeeded();
        return fromRedis.value as T;
      }
    }

    this.misses += 1;
    const value = await loader();
    const configuredVersion = options.version ?? definition?.version;
    const version = typeof configuredVersion === "function"
      ? configuredVersion(value) ?? null
      : configuredVersion ?? extractConfigVersion(value);
    const resolvedTopics = typeof definitionTopics === "function" ? definitionTopics(value) : topics;
    const entry: StoredConfigCacheEntry = {
      cacheClass,
      key,
      value,
      version,
      storedAt: this.now(),
      expiresAt: this.now() + ttlMs,
      topics: [...resolvedTopics],
    };
    this.entries.set(mapKey, entry);
    this.evictIfNeeded();
    await this.writeRedis(cacheClass, entry, ttlMs);
    return value;
  }

  getOrLoad = this.get.bind(this);
  load = this.get.bind(this);

  getClassA<T>(key: string, loader: () => Promise<T>, options: ConfigCacheGetOptions<T> = {}): Promise<T> {
    return this.get("A", key, loader, options);
  }

  getClassB<T>(key: string, loader: () => Promise<T>, options: ConfigCacheGetOptions<T> = {}): Promise<T> {
    return this.get("B", key, loader, options);
  }

  getClassC<T>(key: string, loader: () => Promise<T>, options: ConfigCacheGetOptions<T> = {}): Promise<T> {
    return this.get("C", key, loader, options);
  }

  getA = this.getClassA.bind(this);
  getB = this.getClassB.bind(this);
  getC = this.getClassC.bind(this);

  getImmutable = this.getClassA.bind(this);
  getTunable = this.getClassB.bind(this);
  getSecurity = this.getClassC.bind(this);
  getSecurityState = this.getClassC.bind(this);

  /** Reads a fresh security row and refreshes the <= 2 s entry. */
  revalidateClassC<T>(key: string, loader: () => Promise<T>, options: ConfigCacheGetOptions<T> = {}): Promise<T> {
    return this.get("C", key, loader, { ...options, bypassCache: true });
  }

  revalidateSecurityState = this.revalidateClassC.bind(this);
  revalidateSecurity = this.revalidateClassC.bind(this);
  revalidateWithinTransaction = this.revalidateClassC.bind(this);

  /**
   * Seeds an entry directly. Useful for a warm-up command and for tests; the
   * same class TTL caps as `get` apply.
   */
  async set<T>(
    cacheClass: ConfigCacheClass,
    key: string,
    value: T,
    options: ConfigCacheGetOptions<T> = {},
  ): Promise<T> {
    const definition = this.definitions.get(key);
    const definitionTopics = definition?.topics;
    const ttlMs = clampTtl(cacheClass, options.ttlMs ?? definition?.ttlMs);
    const configuredVersion = options.version ?? definition?.version;
    const version = typeof configuredVersion === "function"
      ? configuredVersion(value) ?? null
      : configuredVersion ?? extractConfigVersion(value);
    const topics = options.topics
      ?? (typeof definitionTopics === "function" ? [] : definitionTopics)
      ?? [];
    const entry: StoredConfigCacheEntry = {
      cacheClass,
      key,
      value,
      version,
      storedAt: this.now(),
      expiresAt: this.now() + ttlMs,
      topics: [...topics],
    };
    this.entries.set(cacheKeyOf(cacheClass, key), entry);
    this.evictIfNeeded();
    await this.writeRedis(cacheClass, entry, ttlMs);
    return value;
  }

  delete = this.invalidate.bind(this);
  seed = this.set.bind(this);

  /**
   * Class B version guard for a money transaction: re-read the single row the
   * operation depends on by primary key and throw if its version changed.
   * Call this inside the transaction, before writing money rows.
   */
  async revalidateVersion(
    cacheClass: ConfigCacheClass,
    key: string,
    readVersion: () => Promise<ConfigCacheVersion | undefined>,
  ): Promise<ConfigCacheVersion>;
  async revalidateVersion(
    key: string,
    readVersion: () => Promise<ConfigCacheVersion | undefined>,
  ): Promise<ConfigCacheVersion>;
  async revalidateVersion(
    cacheClassOrKey: ConfigCacheClass | string,
    keyOrReadVersion: string | (() => Promise<ConfigCacheVersion | undefined>),
    maybeReadVersion?: () => Promise<ConfigCacheVersion | undefined>,
  ): Promise<ConfigCacheVersion> {
    const classForm =
      (cacheClassOrKey === "A" || cacheClassOrKey === "B" || cacheClassOrKey === "C")
      && typeof keyOrReadVersion === "string";
    const cacheClass: ConfigCacheClass = classForm
      ? (cacheClassOrKey as ConfigCacheClass)
      : "B";
    const key: string = classForm ? (keyOrReadVersion as string) : cacheClassOrKey;
    const readVersion = (classForm ? maybeReadVersion : keyOrReadVersion) as
      | (() => Promise<ConfigCacheVersion | undefined>)
      | undefined;
    if (!readVersion) {
      throw new Error("ConfigCacheRegistry.revalidateVersion requires a version reader");
    }
    const entry = this.entries.get(cacheKeyOf(cacheClass, key));
    if (!entry || entry.expiresAt <= this.now()) {
      return (await readVersion()) ?? null;
    }
    const actual = (await readVersion()) ?? null;
    if (entry.version !== null && String(entry.version) !== String(actual)) {
      await this.invalidate(key);
      throw new ConfigCacheVersionChangedError(key, entry.version, actual);
    }
    return actual;
  }

  async isVersionCurrent(
    cacheClass: ConfigCacheClass,
    key: string,
    readVersion: () => Promise<ConfigCacheVersion | undefined>,
  ): Promise<boolean> {
    const entry = this.entries.get(cacheKeyOf(cacheClass, key));
    if (!entry || entry.expiresAt <= this.now()) {
      return true;
    }
    const actual = (await readVersion()) ?? null;
    return entry.version === null || String(entry.version) === String(actual);
  }

  assertVersionCurrent = this.revalidateVersion.bind(this);

  peek<T = unknown>(cacheClass: ConfigCacheClass, key: string): T | undefined {
    return this.readMemory<T>(cacheKeyOf(cacheClass, key))?.value;
  }

  versionOf(cacheClass: ConfigCacheClass, key: string): ConfigCacheVersion | undefined {
    return this.readMemory(cacheKeyOf(cacheClass, key))?.version;
  }

  /**
   * Removes every entry that matches an exact key, a `key:` prefix, a payload
   * key, or one of its registered bus topics. Returns the number removed.
   */
  async invalidate(keyOrTopic: string, payloadKey?: string | null): Promise<number> {
    const removed: StoredConfigCacheEntry[] = [];
    for (const [mapKey, entry] of this.entries) {
      if (this.entryMatches(entry, keyOrTopic, payloadKey ?? null)) {
        removed.push(entry);
        this.entries.delete(mapKey);
      }
    }
    for (const entry of removed) {
      await this.deleteRedis(entry.cacheClass, entry.key);
    }
    return removed.length;
  }

  invalidateKey = this.invalidate.bind(this);
  invalidateTopic = this.invalidate.bind(this);

  clearAll = this.invalidateAll.bind(this);
  clear = this.invalidateAll.bind(this);

  async invalidateAll(cacheClass?: ConfigCacheClass): Promise<void> {
    const removed: StoredConfigCacheEntry[] = [];
    for (const [mapKey, entry] of this.entries) {
      if (!cacheClass || entry.cacheClass === cacheClass) {
        removed.push(entry);
        this.entries.delete(mapKey);
      }
    }
    for (const entry of removed) {
      await this.deleteRedis(entry.cacheClass, entry.key);
    }
  }

  size(): number {
    return this.entries.size;
  }

  stats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.entries.size };
  }

  /** Attaches the `cache_invalidation_events` table for direct polling. */
  setDatabase(database: CacheInvalidationDatabase | CacheInvalidationEventStore): this {
    this.source = isEventStore(database)
      ? database
      : createPrismaInvalidationEventStore(database);
    return this;
  }

  /** Subscribes to the bus (idempotently) and starts the 1 s table poller. */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.subscribeToBus();
    if (this.source) {
      void this.pollOnce({ purge: true });
      this.pollTimer = setInterval(() => {
        void this.pollOnce();
      }, this.pollIntervalMs);
      (this.pollTimer as { unref?: () => void }).unref?.();
    }
  }

  stop(): void {
    this.started = false;
    this.unsubscribeBus?.();
    this.unsubscribeBus = undefined;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async close(): Promise<void> {
    this.stop();
    for (const entry of this.entries.values()) {
      await this.deleteRedis(entry.cacheClass, entry.key);
    }
    this.entries.clear();
    this.definitions.clear();
  }

  /**
   * Reads one batch of `cache_invalidation_events` after the last seen
   * sequence, invalidates matching entries and purges rows older than one
   * hour (at most once per minute unless `purge` is forced).
   */
  async pollOnce(options: { purge?: boolean } = {}): Promise<number> {
    if (!this.source || this.pollInFlight) {
      return 0;
    }
    this.pollInFlight = true;
    try {
      const rows: CacheInvalidationEventRecord[] = await this.source.readAfter(
        this.lastEventSeq,
        this.batchSize,
      );
      for (const row of rows) {
        const eventSeq = toBigInt(row.eventSeq);
        if (eventSeq > this.lastEventSeq) {
          this.lastEventSeq = eventSeq;
        }
        await this.invalidate(row.topic, row.payloadKey ?? null);
      }
      const now = this.now();
      if (options.purge === true || now - this.lastPurgeAt >= this.purgeIntervalMs) {
        this.lastPurgeAt = now;
        try {
          await this.source.purgeBefore(new Date(now - this.eventRetentionMs));
        } catch (error) {
          this.onError?.(error);
        }
      }
      return rows.length;
    } catch (error) {
      this.onError?.(error);
      if (!this.onError) {
        console.error("Config cache: cache_invalidation_events poll failed", error);
      }
      return 0;
    } finally {
      this.pollInFlight = false;
    }
  }

  lastSeenEventSeq(): bigint {
    return this.lastEventSeq;
  }

  pollInvalidationEvents = this.pollOnce.bind(this);
  startInvalidationPolling = this.start.bind(this);
  stopInvalidationPolling = this.stop.bind(this);

  private subscribeToBus(): void {
    if (!this.bus || this.unsubscribeBus) {
      return;
    }
    this.unsubscribeBus = this.bus.subscribe("*", (event) => this.onBusEvent(event));
  }

  private async onBusEvent(event: InvalidationEvent): Promise<void> {
    await this.invalidate(
      event.topic,
      event.payload && typeof event.payload === "object"
        ? payloadKeyOf(event.topic, event.payload)
        : null,
    );
  }

  private entryMatches(
    entry: StoredConfigCacheEntry,
    keyOrTopic: string,
    payloadKey: string | null,
  ): boolean {
    const key = entry.key;
    if (key === keyOrTopic || key.startsWith(`${keyOrTopic}:`)) {
      return true;
    }
    if (payloadKey && (key === payloadKey || key.endsWith(`:${payloadKey}`))) {
      return true;
    }
    for (const topic of entry.topics) {
      if (topic === keyOrTopic) {
        return true;
      }
      if (topicMatchesPattern(keyOrTopic, topic) || topicMatchesPattern(topic, keyOrTopic)) {
        return true;
      }
      if (payloadKey && (topic === payloadKey || topic.endsWith(`:${payloadKey}`))) {
        return true;
      }
    }
    return false;
  }

  private readMemory<T>(mapKey: string): ConfigCacheEntry<T> | undefined {
    const entry = this.entries.get(mapKey);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(mapKey);
      return undefined;
    }
    return entry as ConfigCacheEntry<T>;
  }

  private async readRedis<T>(
    cacheClass: ConfigCacheClass,
    key: string,
  ): Promise<StoredConfigCacheEntry | undefined> {
    if (!this.redis) {
      return undefined;
    }
    try {
      const raw = await this.redis.get(redisKeyOf(cacheClass, key));
      if (typeof raw !== "string" || raw.length === 0) {
        return undefined;
      }
      const parsed = JSON.parse(raw) as StoredConfigCacheEntry;
      if (
        !parsed
        || parsed.cacheClass !== cacheClass
        || parsed.key !== key
        || typeof parsed.expiresAt !== "number"
        || parsed.expiresAt <= this.now()
      ) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async writeRedis(
    cacheClass: ConfigCacheClass,
    entry: StoredConfigCacheEntry,
    ttlMs: number,
  ): Promise<void> {
    if (!this.redis) {
      return;
    }
    try {
      const value = JSON.stringify(entry);
      if (typeof this.redis.setex === "function") {
        await this.redis.setex(redisKeyOf(cacheClass, entry.key), Math.max(1, Math.ceil(ttlMs / 1_000)), value);
      } else {
        await this.redis.set(redisKeyOf(cacheClass, entry.key), value, ttlMs);
      }
    } catch {
      // The memory cache remains usable when Redis is down.
    }
  }

  private async deleteRedis(cacheClass: ConfigCacheClass, key: string): Promise<void> {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.del(redisKeyOf(cacheClass, key));
    } catch {
      // Best effort.
    }
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The process-wide registry. It listens to the shared invalidation bus; the
 * bus itself owns the `cache_invalidation_events` table poller.
 */
export const configCacheRegistry = new ConfigCacheRegistry({ bus: invalidationBus });

export default ConfigCacheRegistry;
