import type { PrismaLike } from "../db/ports";
import { createPlatformRuntime, type PlatformRuntime } from "./platform";

/**
 * One runtime per database client. The transactional pool (HTTP routes) and
 * the background pool (workers) therefore never share a cache entry or an
 * outbound consumer built against the wrong pool, but every route that passes
 * the same client still gets the same instances.
 */
let runtimes = new WeakMap<object, PlatformRuntime>();
let runtimePromises = new WeakMap<object, Promise<PlatformRuntime>>();
const createdRuntimes = new Set<PlatformRuntime>();

const keyOf = (db: PrismaLike): object => db as unknown as object;

const closeRuntime = (runtime: PlatformRuntime): void => {
  try {
    runtime.consumerRegistry.close();
  } catch {
    // The registry has no async shutdown contract; a failure here must not
    // prevent the other runtimes from being released.
  }
  createdRuntimes.delete(runtime);
};

/**
 * Lazily builds the production runtime of `core-back`.
 *
 * The runtime owns the outbound consumer registry, the ledger poster, the
 * attempt repository and the universal rail engine, so the HTTP routes and the
 * durable workers always share the same instances for the same client (and
 * therefore the same caches and the same invalidation bus).
 */
export const getPlatformRuntime = (db: PrismaLike): PlatformRuntime => {
  const key = keyOf(db);
  const existing = runtimes.get(key);
  if (existing) {
    return existing;
  }
  const runtime = createPlatformRuntime(db);
  runtimes.set(key, runtime);
  createdRuntimes.add(runtime);
  return runtime;
};

export const getPlatformRuntimeAsync = async (db: PrismaLike): Promise<PlatformRuntime> => {
  const key = keyOf(db);
  const existing = runtimes.get(key);
  if (existing) {
    return existing;
  }
  const pending = runtimePromises.get(key);
  if (pending) {
    return pending;
  }
  const promise = (async () => {
    const built = createPlatformRuntime(db);
    runtimes.set(key, built);
    createdRuntimes.add(built);
    return built;
  })().finally(() => {
    runtimePromises.delete(key);
  });
  runtimePromises.set(key, promise);
  return promise;
};

/**
 * Releases the runtime of one client, or every runtime when no client is
 * given (tests and graceful shutdown).
 */
export const resetPlatformRuntime = (db?: PrismaLike): void => {
  if (db) {
    const key = keyOf(db);
    const runtime = runtimes.get(key);
    if (runtime) {
      closeRuntime(runtime);
    }
    runtimes.delete(key);
    runtimePromises.delete(key);
    return;
  }
  for (const runtime of createdRuntimes) {
    closeRuntime(runtime);
  }
  runtimes = new WeakMap<object, PlatformRuntime>();
  runtimePromises = new WeakMap<object, Promise<PlatformRuntime>>();
  createdRuntimes.clear();
};

export type { PlatformRuntime };
