import { invalidationBus, type InvalidationBus } from "../../lib/invalidationBus";
import { ApiConsumer, type ApiConsumerConfig } from "./ApiConsumer";

export interface ConsumerRegistryKey {
  gatewayId: string;
  env: string;
  credentialSetId: string;
}

export interface ConsumerRegistryOptions {
  loadConfig: (key: ConsumerRegistryKey) => Promise<ApiConsumerConfig>;
  createConsumer?: (config: ApiConsumerConfig) => ApiConsumer;
  invalidationBus?: InvalidationBus;
}

export function consumerRegistryKey(key: ConsumerRegistryKey): string {
  return `${key.gatewayId}:${key.env}:${key.credentialSetId}`;
}

export class ConsumerRegistry {
  readonly consumersMap = new Map<string, Promise<ApiConsumer>>();
  private readonly options: ConsumerRegistryOptions;
  private readonly unsubscribeInvalidation: () => void;

  constructor(options: ConsumerRegistryOptions) {
    this.options = options;
    const bus = options.invalidationBus ?? invalidationBus;
    this.unsubscribeInvalidation = bus.subscribe("credential:*", (event) => {
      const payload = event.payload as { credentialSetId?: string } | undefined;
      if (!payload?.credentialSetId) {
        return;
      }
      void this.invalidateCredential(payload.credentialSetId);
    });
  }

  getConsumer(key: ConsumerRegistryKey): Promise<ApiConsumer> {
    const mapKey = consumerRegistryKey(key);
    const cached = this.consumersMap.get(mapKey);
    if (cached) {
      return cached;
    }
    const promise = this.initialize(key);
    this.consumersMap.set(mapKey, promise);
    void promise.catch(() => {
      if (this.consumersMap.get(mapKey) === promise) {
        this.consumersMap.delete(mapKey);
      }
    });
    return promise;
  }

  async invalidateCredential(credentialSetId: string): Promise<void> {
    const prefix = `:${credentialSetId}`;
    for (const [key, promise] of this.consumersMap) {
      if (!key.endsWith(prefix)) {
        continue;
      }
      this.consumersMap.delete(key);
      try {
        const consumer = await promise;
        consumer.stop();
      } catch {
        continue;
      }
    }
  }

  async invalidateGateway(gatewayId: string): Promise<void> {
    const prefix = `${gatewayId}:`;
    for (const [key, promise] of this.consumersMap) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.consumersMap.delete(key);
      try {
        const consumer = await promise;
        consumer.stop();
      } catch {
        continue;
      }
    }
  }

  stopAll(): void {
    for (const promise of this.consumersMap.values()) {
      void promise.then((consumer) => consumer.stop()).catch(() => undefined);
    }
    this.consumersMap.clear();
  }

  close(): void {
    this.stopAll();
    this.unsubscribeInvalidation();
  }

  private async initialize(key: ConsumerRegistryKey): Promise<ApiConsumer> {
    const config = await this.options.loadConfig(key);
    return this.options.createConsumer ? this.options.createConsumer(config) : new ApiConsumer(config);
  }
}
