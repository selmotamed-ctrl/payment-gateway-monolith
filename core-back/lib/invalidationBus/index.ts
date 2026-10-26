import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface RedisCompatiblePublisher {
  publish(channel: string, message: string): Promise<number | void> | number | void;
}

export interface RedisCompatibleSubscriber {
  subscribe(channel: string, listener: (message: string) => void | Promise<void>): Promise<void> | void;
  unsubscribe(channel: string): Promise<void> | void;
}

export interface InvalidationBusOptions {
  namespace?: string;
  publisher?: RedisCompatiblePublisher;
  subscriber?: RedisCompatibleSubscriber;
}

export interface InvalidationEvent<T = unknown> {
  id: string;
  namespace: string;
  topic: string;
  payload: T;
  publishedAt: string;
}

export type InvalidationListener<T = unknown> = (event: InvalidationEvent<T>) => void | Promise<void>;

export class InvalidationBus {
  private readonly emitter = new EventEmitter();
  private readonly namespace: string;
  private readonly publisher?: RedisCompatiblePublisher;
  private readonly subscriber?: RedisCompatibleSubscriber;
  private readonly seen = new Set<string>();

  constructor(options: InvalidationBusOptions = {}) {
    this.namespace = options.namespace ?? "payment-gateway";
    this.publisher = options.publisher;
    this.subscriber = options.subscriber;
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
    this.seen.add(event.id);
    await this.emitLocal(event);
    if (this.publisher) {
      await this.publisher.publish(this.channel(topic), JSON.stringify(event));
    }
    return event;
  }

  subscribe<T>(topic: string, listener: InvalidationListener<T>): () => void {
    const channel = this.channel(topic);
    const wrapped = (event: InvalidationEvent<T>): void | Promise<void> => listener(event);
    this.emitter.on(channel, wrapped);
    let redisListener: ((message: string) => void | Promise<void>) | undefined;
    if (this.subscriber) {
      redisListener = (message: string): void => {
        void this.receiveRedisMessage(message);
      };
      void this.subscriber.subscribe(channel, redisListener);
    }
    return () => {
      this.emitter.off(channel, wrapped);
      if (this.subscriber && redisListener) {
        void this.subscriber.unsubscribe(channel);
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
    this.seen.clear();
  }

  private async emitLocal<T>(event: InvalidationEvent<T>): Promise<void> {
    const channel = this.channel(event.topic);
    const listeners = this.emitter.listeners(channel) as InvalidationListener<T>[];
    for (const listener of listeners) {
      await listener(event);
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
    this.seen.add(event.id);
    await this.emitLocal(event);
  }
}

export const invalidationBus = new InvalidationBus();
