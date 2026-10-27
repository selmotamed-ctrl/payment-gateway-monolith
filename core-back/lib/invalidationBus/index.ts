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
  private readonly seen = new Set<string>();
  private readonly subscriptions = new Map<string, Set<InvalidationListener<never>>>();

  constructor(options: InvalidationBusOptions = {}) {
    this.namespace = options.namespace ?? "payment-gateway";
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
    this.seenLimit = options.seenLimit ?? 2048;
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
      await this.publisher.publish(this.channel(topic), JSON.stringify(event));
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

export const invalidationBus = new InvalidationBus();
