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

export interface InvalidationBusOptions {
  namespace?: string;
  publisher?: RedisCompatiblePublisher;
  subscriber?: RedisCompatibleSubscriber;
  /** Maximum number of remembered event ids used for cross-node de-duplication. */
  seenLimit?: number;
  /** Receives Redis transport failures without taking the local bus down. */
  onRedisError?: (error: unknown) => void;
}

export interface InvalidationEvent<T = unknown> {
  id: string;
  namespace: string;
  topic: string;
  payload: T;
  publishedAt: string;
}

export type InvalidationListener<T = unknown> = (event: InvalidationEvent<T>) => void | Promise<void>;

/**
 * The topic vocabulary shared by the cache registry, the consumer registry and
 * the checkout SSE streams. A keyed topic is `domain:key`; the wildcard form
 * is `domain:*`.
 */
export const invalidationTopics = {
  platformSettings: (key?: string) => (key ? `settings:${key}` : "settings"),
  activeRules: (key?: string) => (key ? `rules:${key}` : "rules"),
  systemGlAccounts: (key?: string) => (key ? `gl:${key}` : "gl"),
  notificationTemplates: (key?: string) => (key ? `template:${key}` : "template"),
  credentials: (credentialSetId: string) => `credential:${credentialSetId}`,
  gateways: (gatewayId: string) => `gateway:${gatewayId}`,
  flow: (key?: string) => (key ? `flow:${key}` : "flow"),
  auth: (key?: string) => (key ? `auth:${key}` : "auth"),
  attempt: (attemptId: string) => `attempt:${attemptId}`,
  configuration: (scope: string) => `configuration:${scope}`,
} as const;

export const invalidationTopicPatterns = {
  platformSettings: "settings:*",
  activeRules: "rules:*",
  systemGlAccounts: "gl:*",
  notificationTemplates: "template:*",
  credentials: "credential:*",
  gateways: "gateway:*",
  flow: "flow:*",
  auth: "auth:*",
  attempts: "attempt:*",
  configuration: "configuration:*",
} as const;

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

export class InvalidationBus {
  private readonly emitter = new EventEmitter();
  private readonly namespace: string;
  private readonly publisher?: RedisCompatiblePublisher;
  private readonly subscriber?: RedisCompatibleSubscriber;
  private readonly seenLimit: number;
  private readonly onRedisError: (error: unknown) => void;
  private readonly seen = new Set<string>();
  private readonly subscriptions = new Map<string, Set<InvalidationListener<never>>>();

  constructor(options: InvalidationBusOptions = {}) {
    this.namespace = options.namespace ?? "payment-gateway";
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.seenLimit = options.seenLimit ?? 2048;
    this.onRedisError = options.onRedisError ?? (() => undefined);
    this.emitter.setMaxListeners(0);
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
      try {
        await this.publisher.publish(this.channel(topic), JSON.stringify(event));
      } catch (error) {
        this.onRedisError(error);
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
        void Promise.resolve(this.subscriber.psubscribe(this.channel(topic), redisListener)).catch(
          (error: unknown) => this.onRedisError(error),
        );
      } else {
        void Promise.resolve(this.subscriber.subscribe(this.channel(topic), redisListener)).catch(
          (error: unknown) => this.onRedisError(error),
        );
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
          void Promise.resolve(this.subscriber.punsubscribe(this.channel(topic))).catch(
            (error: unknown) => this.onRedisError(error),
          );
        } else {
          void Promise.resolve(this.subscriber.unsubscribe(this.channel(topic))).catch(
            (error: unknown) => this.onRedisError(error),
          );
        }
      }
    };
  }

  async invalidateCredential(credentialSetId: string, reason = "credential-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.credentials(credentialSetId), { credentialSetId, reason });
  }

  async invalidateGateway(gatewayId: string, reason = "gateway-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.gateways(gatewayId), { gatewayId, reason });
  }

  async invalidateConfiguration(scope: string, reason = "configuration-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.configuration(scope), { scope, reason });
  }

  async invalidatePlatformSettings(key?: string, reason = "platform-settings-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.platformSettings(key), { key: key ?? null, reason });
  }

  async invalidateActiveRules(key?: string, reason = "active-rules-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.activeRules(key), { key: key ?? null, reason });
  }

  async invalidateSystemGlAccounts(key?: string, reason = "system-gl-accounts-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.systemGlAccounts(key), { key: key ?? null, reason });
  }

  async invalidateNotificationTemplate(key?: string, reason = "notification-template-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.notificationTemplates(key), { key: key ?? null, reason });
  }

  async invalidateFlow(key?: string, reason = "flow-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.flow(key), { key: key ?? null, reason });
  }

  async invalidateAuth(key?: string, reason = "auth-invalidated"): Promise<void> {
    await this.publish(invalidationTopics.auth(key), { key: key ?? null, reason });
  }

  async invalidateAttempt(attemptId: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.publish(invalidationTopics.attempt(attemptId), { attemptId, ...payload });
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
    this.subscriptions.clear();
    this.seen.clear();
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

interface BunRedisClient {
  connect(): Promise<void>;
  publish(channel: string, message: string): Promise<number>;
  subscribe(channel: string, listener: (message: string) => void): Promise<number>;
  unsubscribe(channel: string): Promise<void>;
}

type BunRedisConstructor = new (url?: string) => BunRedisClient;

const createRedisAdapters = (
  redisUrl: string,
  onRedisError: (error: unknown) => void,
): Pick<InvalidationBusOptions, "publisher" | "subscriber"> | undefined => {
  const runtime = (globalThis as { Bun?: { RedisClient?: BunRedisConstructor } }).Bun;
  const RedisClient = runtime?.RedisClient;
  if (!RedisClient) {
    return undefined;
  }
  let publisher: BunRedisClient;
  let subscriber: BunRedisClient;
  try {
    publisher = new RedisClient(redisUrl);
    subscriber = new RedisClient(redisUrl);
  } catch (error) {
    onRedisError(error);
    return undefined;
  }
  let publisherReady: Promise<void> | undefined;
  let subscriberReady: Promise<void> | undefined;
  const ensurePublisher = (): Promise<void> => {
    if (!publisherReady) {
      publisherReady = publisher.connect();
    }
    return publisherReady;
  };
  const ensureSubscriber = (): Promise<void> => {
    if (!subscriberReady) {
      subscriberReady = subscriber.connect();
    }
    return subscriberReady;
  };
  return {
    publisher: {
      publish: async (channel, message) => {
        await ensurePublisher();
        return publisher.publish(channel, message);
      },
    },
    subscriber: {
      subscribe: async (channel, listener) => {
        await ensureSubscriber();
        await subscriber.subscribe(channel, listener);
      },
      unsubscribe: (channel) => subscriber.unsubscribe(channel),
    },
  };
};

export const createInvalidationBus = (options: InvalidationBusOptions = {}): InvalidationBus =>
  new InvalidationBus(options);

/**
 * Keeps the in-process bus when REDIS_URL is absent. When it is configured,
 * Bun's optional Redis client carries events across nodes; a Redis failure is
 * reported but never prevents the local delivery that already happened.
 */
export const createInvalidationBusFromEnv = (
  options: InvalidationBusOptions & { redisUrl?: string } = {},
): InvalidationBus => {
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    return new InvalidationBus(options);
  }
  const errors: unknown[] = [];
  const onRedisError = (error: unknown): void => {
    options.onRedisError?.(error);
    if (errors.length === 0) {
      errors.push(error);
      console.warn(
        `[invalidation-bus] Redis transport unavailable (${error instanceof Error ? error.message : String(error)}); continuing with the local bus`,
      );
    }
  };
  const adapters = createRedisAdapters(redisUrl, onRedisError);
  if (!adapters) {
    console.warn("[invalidation-bus] REDIS_URL is set but Bun.RedisClient is unavailable; using the local bus");
    return new InvalidationBus({ ...options, onRedisError });
  }
  return new InvalidationBus({
    ...options,
    ...adapters,
    namespace: options.namespace ?? process.env.INVALIDATION_BUS_NAMESPACE ?? "payment-gateway",
    onRedisError,
  });
};

export const invalidationBus = createInvalidationBusFromEnv();
