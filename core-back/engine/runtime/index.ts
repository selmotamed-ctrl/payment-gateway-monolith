import type { PrismaLike } from "../db/ports";
import { createPlatformRuntime, type PlatformRuntime } from "./platform";

const runtimes = new Map<PrismaLike, PlatformRuntime>();
const runtimePromises = new Map<PrismaLike, Promise<PlatformRuntime>>();
const runtimeTokens = new Map<PrismaLike, object>();

/**
 * Lazily builds one production runtime per database client.
 *
 * The HTTP tier runs on the transactional pool and the workers run on the
 * background pool. They must not share a runtime: sharing one would send worker
 * queries, including their ledger posts, back through the transactional client
 * that the runtime captured first.
 */
export const getPlatformRuntime = (db: PrismaLike): PlatformRuntime => {
  const existing = runtimes.get(db);
  if (existing) {
    return existing;
  }
  const built = createPlatformRuntime(db);
  runtimes.set(db, built);
  return built;
};

export const getPlatformRuntimeAsync = async (db: PrismaLike): Promise<PlatformRuntime> => {
  const existing = runtimes.get(db);
  if (existing) {
    return existing;
  }
  const pending = runtimePromises.get(db);
  if (pending) {
    return pending;
  }
  const token = {};
  const built = (async () => {
    const runtime = createPlatformRuntime(db);
    if (runtimeTokens.get(db) === token) {
      runtimes.set(db, runtime);
    }
    return runtime;
  })();
  const promise = built.finally(() => {
    if (runtimeTokens.get(db) === token) {
      runtimePromises.delete(db);
      runtimeTokens.delete(db);
    }
  });
  runtimeTokens.set(db, token);
  runtimePromises.set(db, promise);
  return promise;
};

export const resetPlatformRuntime = (db?: PrismaLike): void => {
  if (db) {
    const runtime = runtimes.get(db);
    runtime?.consumerRegistry.close();
    runtime?.configCache.close();
    runtimes.delete(db);
    runtimePromises.delete(db);
    runtimeTokens.delete(db);
    return;
  }
  for (const runtime of runtimes.values()) {
    runtime.consumerRegistry.close();
    runtime.configCache.close();
  }
  runtimes.clear();
  runtimePromises.clear();
  runtimeTokens.clear();
};

export type { PlatformRuntime };
