import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface RedisCompatiblePublisher {
  publish(channel: string, message: string): Promise<number | void> | number | void;
}

export interface RedisCompatibleSubscriber {
  subscribe(channel: string, listener: (message: string) => void | Promise<void>): Promise<void> | void;
  unsubscribe(channel: string): Promise<void> | void;
  /** Optional pattern subscription used for wildcard topics such as `credential:*`. */
  psubscribe?(pattern: string, listener: (message: string) => void | Promise<void>): Promise<void> | void;
  punsubscribe?(pattern: string): Promise<void> | void;
}

/**
 * The row shape of `cache_invalidation_events` (design §2.9). The table has
 * only four columns; the bus stores one row per published invalidation and
 * every node polls it every second, then purges rows older than one hour.
 */
export interface CacheInvalidationEventRecord {
  eventSeq: bigint | number | string;
  topic: string;
  payloadKey?: string | null;
  createdAt?: Date | string | null;
}

export interface AppendedCacheInvalidationEvent {
  eventSeq?: bigint | number | string;
  topic?: string;
  payloadKey?: string | null;
}

/**
 * The store abstraction. The Prisma implementation is created by
 * `attachDatabase`; a test or a different backend can provide its own.
 */
export interface CacheInvalidationEventStore {
  append(topic: string, payloadKey: string | null): Promise<AppendedCacheInvalidationEvent | void>;
  readAfter(eventSeq: bigint | number | string, limit: number): Promise<CacheInvalidationEventRecord[]>;
  purgeBefore(cutoff: Date): Promise<number>;
}

export interface CacheInvalidationDatabase {
  cacheInvalidationEvent?: {
    create(args: { data: { topic: string; payloadKey: string | null } }): Promise<Record<string, unknown>>;
    findMany(args: {
      where: { eventSeq: { gt: bigint | number | string } };
      orderBy: { eventSeq: "asc" };
      take: number;
      select?: Record<string, boolean>;
    }): Promise<CacheInvalidationEventRecord[]>;
    deleteMany(args: { where: { createdAt: { lt: Date } } }): Promise<{ count?: number }>;
  };
}

export interface InvalidationBusOptions {
  namespace?: string;
  publisher?: RedisCompatiblePublisher;
  subscriber?: RedisCompatibleSubscriber;
  /** Maximum number of remembered event ids used for cross-node de-duplication. */
  seenLimit?: number;
  /** Optional durable/event-table backend (or an already-built store). */
  database?: CacheInvalidationDatabase | CacheInvalidationEventStore;
}

export interface InvalidationEvent<T = unknown> {
  id: string;
  namespace: string;
  topic: string;
  payload: T;
  publishedAt: string;
}

export type InvalidationListener<T = unknown> = (event: InvalidationEvent<T>) => void | Promise<void>;

export interface DatabasePollingOptions {
  /** Design §2.9: poll every second. */
  intervalMs?: number;
  /** Design §2.9: keep one hour of events. */
  purgeAfterMs?: number;
  /** How often the purge statement runs. */
  purgeIntervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export const DEFAULT_INVALIDATION_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_INVALIDATION_RETENTION_MS = 60 * 60 * 1_000;
export const DEFAULT_INVALIDATION_PURGE_INTERVAL_MS = 60_000;
export const DEFAULT_INVALIDATION_BATCH_SIZE = 500;

/**
 * Matches a concrete topic against a subscription pattern. Only a trailing
 * `*` wildcard is supported, e.g. `credential:*`.
 */
export const topicMatchesPattern = (topic: string, pattern: string): boolean => {
  if (pattern === topic) {
    return true;
  }
  if (!pattern.endsWith("*")) {
    return false;
  }
  const prefix = pattern.slice(0, -1);
  return topic.startsWith(prefix);
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

const isEventStore = (value: unknown): value is CacheInvalidationEventStore => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<CacheInvalidationEventStore>;
  return typeof candidate.readAfter === "function" && typeof candidate.purgeBefore === "function";
};

/**
 * Derives the `payload_key` column from the payload. The column is nullable,
 * so an event without an obvious key still persists its topic.
 */
export const payloadKeyOf = (topic: string, payload: unknown): string | null => {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["payloadKey", "credentialSetId", "gatewayId", "scope", "key", "id"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  const separator = topic.lastIndexOf(":");
  return separator >= 0 ? topic.slice(separator + 1) : null;
};

/** Builds the store backed by the `cache_invalidation_events` table. */
export const createPrismaInvalidationEventStore = (
  database: CacheInvalidationDatabase,
): CacheInvalidationEventStore => ({
  append: async (topic, payloadKey) => {
    const row = await database.cacheInvalidationEvent?.create({
      data: { topic, payloadKey },
    });
    return row
      ? { eventSeq: row.eventSeq as bigint | number | string | undefined, topic, payloadKey }
      : undefined;
  },
  readAfter: async (eventSeq, limit) => {
    if (!database.cacheInvalidationEvent) {
      return [];
    }
    return database.cacheInvalidationEvent.findMany({
      where: { eventSeq: { gt: eventSeq } },
      orderBy: { eventSeq: "asc" },
      take: limit,
      select: { eventSeq: true, topic: true, payloadKey: true, createdAt: true },
    });
  },
  purgeBefore: async (cutoff) => {
    if (!database.cacheInvalidationEvent) {
      return 0;
    }
    const result = await database.cacheInvalidationEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return Number(result?.count ?? 0);
  },
});

export class InvalidationBus {
  private readonly emitter = new EventEmitter();
  private readonly namespace: string;
  private readonly publisher?: RedisCompatiblePublisher;
  private readonly subscriber?: RedisCompatibleSubscriber;
  private readonly seenLimit: number;
  private readonly seen = new Set<string>();
  private readonly subscriptions = new Map<string, Set<InvalidationListener<never>>>();
  private databaseStore?: CacheInvalidationEventStore;
  private pollTimer?: ReturnType<typeof setInterval>;
  private lastEventSeq = 0n;
  private pollInFlight = false;
  private lastPurgeAt = 0;
  private readonly selfPublishedEventSeqs = new Set<bigint>();
  private pollOptions: Required<Pick<DatabasePollingOptions, "intervalMs" | "purgeAfterMs" | "purgeIntervalMs" | "batchSize">> = {
    intervalMs: DEFAULT_INVALIDATION_POLL_INTERVAL_MS,
    purgeAfterMs: DEFAULT_INVALIDATION_RETENTION_MS,
    purgeIntervalMs: DEFAULT_INVALIDATION_PURGE_INTERVAL_MS,
    batchSize: DEFAULT_INVALIDATION_BATCH_SIZE,
  };
  private onPollError?: (error: unknown) => void;

  constructor(options: InvalidationBusOptions = {}) {
    this.namespace = options.namespace ?? "payment-gateway";
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.seenLimit = options.seenLimit ?? 2048;
    this.emitter.setMaxListeners(0);
    if (options.database) {
      this.setDatabase(options.database);
    }
  }

  channel(topic: string): string {
    if (!topic || /[\r\n]/.test(topic)) {
      throw new Error("Invalid invalidation topic");
    }
    return `${this.namespace}:invalidation:${topic}`;
  }

  async publish<T>(topic: string, payload: T): Promise<InvalidationEvent<T>> {
    const event: InvalidationEvent<T> = {
      id: randomUUID(),
      namespace: this.namespace,
      topic,
      payload,
      publishedAt: new Date().toISOString(),
    };
    this.remember(event.id);
    await this.emitLocal(event);
    if (this.publisher) {
      await this.publisher.publish(this.channel(topic), JSON.stringify(event));
    }
    if (this.databaseStore) {
      try {
        const stored = await this.databaseStore.append(topic, payloadKeyOf(topic, payload));
        if (stored?.eventSeq !== undefined) {
          // The local emit already happened. Do not deliver this node's own
          // row a second time when the poller catches up with it.
          this.selfPublishedEventSeqs.add(toBigInt(stored.eventSeq));
          while (this.selfPublishedEventSeqs.size > 4096) {
            const oldest = this.selfPublishedEventSeqs.values().next();
            if (oldest.done) break;
            this.selfPublishedEventSeqs.delete(oldest.value);
          }
        }
      } catch (error) {
        // The in-process/Redis invalidation already happened; a database
        // outage must not fail the business operation that published it.
        this.onPollError?.(error);
        if (!this.onPollError) {
          console.error(`Invalidation bus: could not persist '${topic}'`, error);
        }
      }
    }
    return event;
  }

  subscribe<T>(topic: string, listener: InvalidationListener<T>): () => void {
    const listeners = this.subscriptions.get(topic) ?? new Set<InvalidationListener<never>>();
    listeners.add(listener as InvalidationListener<never>);
    this.subscriptions.set(topic, listeners);

    let redisListener: ((message: string) => void | Promise<void>) | undefined;
    if (this.subscriber) {
      redisListener = (message: string): void => {
        void this.receiveRedisMessage(message);
      };
      const isWildcard = topic.endsWith("*");
      if (isWildcard && this.subscriber.psubscribe) {
        void this.subscriber.psubscribe(this.channel(topic), redisListener);
      } else {
        void this.subscriber.subscribe(this.channel(topic), redisListener);
      }
    }

    return () => {
      const current = this.subscriptions.get(topic);
      current?.delete(listener as InvalidationListener<never>);
      if (current && current.size === 0) {
        this.subscriptions.delete(topic);
      }
      if (this.subscriber && redisListener) {
        const isWildcard = topic.endsWith("*");
        if (isWildcard && this.subscriber.punsubscribe) {
          void this.subscriber.punsubscribe(this.channel(topic));
        } else {
          void this.subscriber.unsubscribe(this.channel(topic));
        }
      }
    };
  }

  async invalidateCredential(credentialSetId: string, reason = "credential-invalidated"): Promise<void> {
    await this.publish(`credential:${credentialSetId}`, { credentialSetId, reason });
  }

  async invalidateGateway(gatewayId: string, reason = "gateway-invalidated"): Promise<void> {
    await this.publish(`gateway:${gatewayId}`, { gatewayId, reason });
  }

  async invalidateConfiguration(scope: string, reason = "configuration-invalidated"): Promise<void> {
    await this.publish(`configuration:${scope}`, { scope, reason });
  }

  /**
   * Attaches the `cache_invalidation_events` table. Publishing then appends a
   * row, and `startDatabasePolling` delivers rows written by other nodes.
   */
  attachDatabase(database: CacheInvalidationDatabase | CacheInvalidationEventStore): this {
    this.setDatabase(database);
    return this;
  }

  setDatabase(database: CacheInvalidationDatabase | CacheInvalidationEventStore): void {
    this.databaseStore = isEventStore(database)
      ? database
      : createPrismaInvalidationEventStore(database);
  }

  hasDatabase(): boolean {
    return this.databaseStore !== undefined;
  }

  startDatabasePolling(options: DatabasePollingOptions = {}): void {
    if (!this.databaseStore) {
      throw new Error("Invalidation bus: attach the cache_invalidation_events store before polling");
    }
    this.stopDatabasePolling();
    this.pollOptions = {
      intervalMs: options.intervalMs ?? DEFAULT_INVALIDATION_POLL_INTERVAL_MS,
      purgeAfterMs: options.purgeAfterMs ?? DEFAULT_INVALIDATION_RETENTION_MS,
      purgeIntervalMs: options.purgeIntervalMs ?? DEFAULT_INVALIDATION_PURGE_INTERVAL_MS,
      batchSize: options.batchSize ?? DEFAULT_INVALIDATION_BATCH_SIZE,
    };
    this.onPollError = options.onError;
    this.lastPurgeAt = 0;
    void this.pollDatabaseOnce({ purge: true });
    this.pollTimer = setInterval(() => {
      void this.pollDatabaseOnce();
    }, this.pollOptions.intervalMs);
    // Do not keep a CLI process or a test runner alive just because the bus
    // is polling.
    (this.pollTimer as { unref?: () => void }).unref?.();
  }

  stopDatabasePolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  isDatabasePolling(): boolean {
    return this.pollTimer !== undefined;
  }

  /**
   * Reads one batch after the last seen `event_seq`, emits the events locally,
   * and purges rows older than the retention window (at most once per minute).
   */
  async pollDatabaseOnce(options: { purge?: boolean } = {}): Promise<number> {
    if (!this.databaseStore || this.pollInFlight) {
      return 0;
    }
    this.pollInFlight = true;
    try {
      const rows = await this.databaseStore.readAfter(this.lastEventSeq, this.pollOptions.batchSize);
      let delivered = 0;
      for (const row of rows) {
        const eventSeq = toBigInt(row.eventSeq);
        if (eventSeq > this.lastEventSeq) {
          this.lastEventSeq = eventSeq;
        }
        const payloadKey = row.payloadKey ?? null;
        if (this.selfPublishedEventSeqs.delete(eventSeq)) {
          continue;
        }
        await this.emitLocal({
          id: `db:${String(row.eventSeq)}`,
          namespace: this.namespace,
          topic: row.topic,
          payload: {
            source: "cache_invalidation_events",
            eventSeq: String(row.eventSeq),
            ...(payloadKey === null ? {} : { payloadKey }),
          },
          publishedAt: row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : typeof row.createdAt === "string"
              ? row.createdAt
              : new Date().toISOString(),
        });
        delivered += 1;
      }
      const now = Date.now();
      const purgeDue =
        options.purge === true
        || now - this.lastPurgeAt >= this.pollOptions.purgeIntervalMs;
      if (purgeDue) {
        this.lastPurgeAt = now;
        try {
          await this.purgeDatabaseEvents(new Date(now - this.pollOptions.purgeAfterMs));
        } catch (error) {
          this.onPollError?.(error);
        }
      }
      return delivered;
    } catch (error) {
      this.onPollError?.(error);
      if (!this.onPollError) {
        console.error("Invalidation bus: cache_invalidation_events poll failed", error);
      }
      return 0;
    } finally {
      this.pollInFlight = false;
    }
  }

  async purgeDatabaseEvents(cutoff: Date = new Date(Date.now() - DEFAULT_INVALIDATION_RETENTION_MS)): Promise<number> {
    if (!this.databaseStore) {
      return 0;
    }
    return this.databaseStore.purgeBefore(cutoff);
  }

  /** The last `event_seq` consumed by the poller (useful for health checks). */
  lastSeenEventSeq(): bigint {
    return this.lastEventSeq;
  }

  async close(): Promise<void> {
    this.stopDatabasePolling();
    this.emitter.removeAllListeners();
    this.subscriptions.clear();
    this.seen.clear();
    this.selfPublishedEventSeqs.clear();
    this.databaseStore = undefined;
  }

  private async emitLocal<T>(event: InvalidationEvent<T>): Promise<void> {
    for (const [pattern, listeners] of this.subscriptions) {
      if (!topicMatchesPattern(event.topic, pattern)) {
        continue;
      }
      for (const listener of listeners) {
        await (listener as InvalidationListener<T>)(event);
      }
    }
    const generic = this.emitter.listeners("invalidation") as InvalidationListener<T>[];
    for (const listener of generic) {
      await listener(event);
    }
  }

  private async receiveRedisMessage(message: string): Promise<void> {
    let event: InvalidationEvent;
    try {
      event = JSON.parse(message) as InvalidationEvent;
    } catch {
      return;
    }
    if (!event.id || event.namespace !== this.namespace || this.seen.has(event.id)) {
      return;
    }
    this.remember(event.id);
    await this.emitLocal(event);
  }

  private remember(id: string): void {
    this.seen.add(id);
    while (this.seen.size > this.seenLimit) {
      const oldest = this.seen.values().next();
      if (oldest.done) {
        break;
      }
      this.seen.delete(oldest.value);
    }
  }
}

export const invalidationBus = new InvalidationBus();

/** Explicit alias for a bus whose invalidation events are persisted in MariaDB. */
export class DatabaseInvalidationBus extends InvalidationBus {}

export const createInvalidationEventStore = createPrismaInvalidationEventStore;
