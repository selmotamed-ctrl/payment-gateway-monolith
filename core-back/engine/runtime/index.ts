import type { PrismaLike } from "../db/ports";
import { createPlatformRuntime, type PlatformRuntime } from "./platform";

let runtime: PlatformRuntime | undefined;
let runtimePromise: Promise<PlatformRuntime> | undefined;

/**
 * Lazily builds the production runtime of `core-back`.
 *
 * The runtime owns the outbound consumer registry, the ledger poster, the
 * attempt repository and the universal rail engine, so the HTTP routes and the
 * durable workers always share the same instances (and therefore the same
 * caches and the same invalidation bus).
 */
export const getPlatformRuntime = (db: PrismaLike): PlatformRuntime => {
  if (!runtime) {
    runtime = createPlatformRuntime(db);
  }
  return runtime;
};

export const getPlatformRuntimeAsync = async (db: PrismaLike): Promise<PlatformRuntime> => {
  if (runtime) {
    return runtime;
  }
  runtimePromise ??= (async () => {
    const built = createPlatformRuntime(db);
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
};

export type { PlatformRuntime };
