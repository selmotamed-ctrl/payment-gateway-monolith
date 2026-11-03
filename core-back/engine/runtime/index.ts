import type { PrismaLike } from "../db/ports";
import type { StorageEngine } from "../../lib/storageEngine/ports";
import { createPlatformRuntime, type PlatformRuntime } from "./platform";

let runtime: PlatformRuntime | undefined;
let runtimePromise: Promise<PlatformRuntime> | undefined;
let platformStorage: StorageEngine | undefined;

/**
 * Lazily builds the production runtime of `core-back`.
 *
 * The runtime owns the outbound consumer registry, the ledger poster, the
 * attempt repository and the universal rail engine, so the HTTP routes and the
 * durable workers always share the same instances (and therefore the same
 * caches and the same invalidation bus).
 */
export const setPlatformStorage = (storage: StorageEngine | undefined): void => {
  platformStorage = storage;
  if (runtime) {
    runtime.storage = storage;
  }
};

export const getPlatformRuntime = (db: PrismaLike): PlatformRuntime => {
  if (!runtime) {
    runtime = createPlatformRuntime(db, { storage: platformStorage });
  } else if (runtime.storage !== platformStorage) {
    runtime.storage = platformStorage;
  }
  return runtime;
};

export const getPlatformRuntimeAsync = async (db: PrismaLike): Promise<PlatformRuntime> => {
  if (runtime) {
    return runtime;
  }
  runtimePromise ??= (async () => {
    const built = createPlatformRuntime(db, { storage: platformStorage });
    runtime = built;
    return built;
  })().finally(() => {
    runtimePromise = undefined;
  });
  return runtimePromise;
};

export const resetPlatformRuntime = (): void => {
  runtime?.consumerRegistry.close();
  runtime = undefined;
  runtimePromise = undefined;
  platformStorage = undefined;
};

export type { PlatformRuntime };
