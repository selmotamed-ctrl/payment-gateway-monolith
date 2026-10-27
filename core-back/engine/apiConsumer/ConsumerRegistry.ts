import { invalidationBus, type InvalidationBus } from "../../lib/invalidationBus";
import { ApiConsumer, type ApiConsumerConfig } from "./ApiConsumer";

export interface ConsumerRegistryKey {
  gatewayId: string;
  env: string;
  credentialSetId: string;
  /**
   * The gateway version the attempt pins.
   *
   * Design v5 §9.1 rule 1 pins the configuration of an attempt, so the
   * outbound consumer is built from the pinned version and never from the
   * latest live one. The key carries the version, because two attempts of the
   * same gateway and environment may pin two different versions with two
   * different authentication recipes.
   */
  gatewayVersionId?: string;
}

export interface ConsumerRegistryOptions {
  loadConfig: (key: ConsumerRegistryKey) => Promise<ApiConsumerConfig>;
  createConsumer?: (config: ApiConsumerConfig) => ApiConsumer;
  invalidationBus?: InvalidationBus;
}

/**
 * The cache key of a consumer.
 *
 * The three mandatory parts keep the historical format, so a consumer that is
 * addressed without a version keeps its key. The pinned version is appended,
 * so the cache never hands the configuration of one version to an attempt
 * that pinned another one.
 */
export function consumerRegistryKey(key: ConsumerRegistryKey): string {
  const version = key.gatewayVersionId ? `:${key.gatewayVersionId}` : "";
  return `${key.gatewayId}:${key.env}:${key.credentialSetId}${version}`;
}

/**
 * The parts of a cache key. The identifiers are UUIDs, so the colon is a safe
 * separator.
 */
function parseRegistryKey(mapKey: string): {
  gatewayId: string;
  env: string;
  credentialSetId: string;
  gatewayVersionId?: string;
} {
  const [gatewayId = "", env = "", credentialSetId = "", gatewayVersionId] = mapKey.split(":");
  return {
    gatewayId,
    env,
    credentialSetId,
    ...(gatewayVersionId ? { gatewayVersionId } : {}),
  };
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
    for (const [key, promise] of this.consumersMap) {
      if (parseRegistryKey(key).credentialSetId !== credentialSetId) {
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
    for (const [key, promise] of this.consumersMap) {
      if (parseRegistryKey(key).gatewayId !== gatewayId) {
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
