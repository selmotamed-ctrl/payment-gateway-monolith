import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import { Pool } from "pg";
import { createClientForUrl } from "../../prisma/client/base";
import { env } from "../env";
import { parsePostgresUrlList } from "../db/connectionConfig";
import {
  DedicatedAuditDatabaseDriver,
  DedicatedPostgresLogSink,
} from "./auditAndLogAdapters";
import type {
  AuditStorePort,
  LogSinkPort,
  ReadStorePort,
  StorageEngine,
  StorageHealth,
  UnitOfWorkPort,
  CachePort,
} from "./ports";
import { PostgresReplicaReadStore, type ReplicaNodeHandle } from "./readStoreAdapter";
import { MemoryCacheAdapter, RedisCacheAdapter } from "./redisCacheAndVelocityAdapter";
import { PostgresUnitOfWorkAdapter } from "./uowAdapter";
import { recordReadSource } from "./telemetry";

export interface StorageEngineOptions {
  primaryUrl?: string;
  replicaUrls?: string[];
  auditDatabaseUrl?: string | null;
  logDatabaseUrl?: string | null;
  redisUrl?: string | null;
  replicaMaxLagMs?: number;
  logBufferMax?: number;
  logFlushIntervalMs?: number;
  cache?: CachePort;
  onAfterCommit?: () => void;
}

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`STORAGE_PROBE_TIMEOUT after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const createStorageEngine = (options: StorageEngineOptions = {}): StorageEngine => {
  const primaryUrl = options.primaryUrl ?? env.DATABASE_URL;
  const replicaUrls =
    options.replicaUrls ?? parsePostgresUrlList(env.DATABASE_REPLICA_URLS);
  const auditDatabaseUrl =
    options.auditDatabaseUrl === undefined ? env.AUDIT_DATABASE_URL ?? null : options.auditDatabaseUrl;
  const logDatabaseUrl =
    options.logDatabaseUrl === undefined ? env.LOG_DATABASE_URL ?? null : options.logDatabaseUrl;
  const firstRedisNode = env.REDIS_NODES.split(",")
    .map((node) => node.trim())
    .filter(Boolean)[0];
  const redisUrl =
    options.redisUrl === undefined
      ? env.REDIS_URL ?? (firstRedisNode ? `redis://${firstRedisNode}` : null)
      : options.redisUrl;

  const primary = createClientForUrl(primaryUrl);
  const replicas: ReplicaNodeHandle[] = replicaUrls.map((url, index) => ({
    id: `replica-${index + 1}`,
    client: createClientForUrl(url),
    healthy: true,
    lastReplayLsn: "0/0",
    lagMs: 0,
    consecutiveFailures: 0,
  }));

  const readStore: ReadStorePort = new PostgresReplicaReadStore(
    primary,
    replicas,
    options.replicaMaxLagMs ?? env.READ_REPLICA_MAX_LAG_MS,
  );
  readStore.startLsnMonitor?.();

  const uow: UnitOfWorkPort = new PostgresUnitOfWorkAdapter(
    primary,
    options.onAfterCommit,
  );

  const cache: CachePort =
    options.cache ??
    (redisUrl
      ? new RedisCacheAdapter({ url: redisUrl })
      : new MemoryCacheAdapter());

  const auditPool = auditDatabaseUrl
    ? new Pool({ connectionString: auditDatabaseUrl, max: 5 })
    : null;
  const auditStore: AuditStorePort | null = auditPool
    ? new DedicatedAuditDatabaseDriver(auditPool)
    : null;

  const logPool = logDatabaseUrl
    ? new Pool({ connectionString: logDatabaseUrl, max: 5 })
    : null;
  const logSink: LogSinkPort = new DedicatedPostgresLogSink(
    logPool,
    options.logBufferMax ?? env.STORAGE_LOG_BUFFER_MAX,
    options.logFlushIntervalMs ?? env.STORAGE_LOG_FLUSH_INTERVAL_MS,
  );

  const engine: StorageEngine = {
    uow,
    readStore,
    cache,
    auditStore,
    logSink,
    primary,
    async health(): Promise<StorageHealth> {
      const started = performance.now();
      let primaryOk = false;
      let primaryDetail: string | undefined;
      try {
        await withTimeout(primary.$queryRaw(Prisma.sql`SELECT 1`), 2_000);
        primaryOk = true;
      } catch (error) {
        primaryDetail = error instanceof Error ? error.message : String(error);
      }
      const primaryLatency = Math.round(performance.now() - started);

      const replicaStates = await Promise.all(
        replicas.map(async (replica) => {
          try {
            await withTimeout(replica.client.$queryRaw(Prisma.sql`SELECT 1`), 2_000);
            return {
              id: replica.id,
              ok: true,
              healthy: replica.healthy,
              lagMs: replica.lagMs,
              lastReplayLsn: replica.lastReplayLsn,
            };
          } catch (error) {
            return {
              id: replica.id,
              ok: false,
              healthy: false,
              lagMs: replica.lagMs,
              lastReplayLsn: replica.lastReplayLsn,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );

      let cacheOk = true;
      let cacheDetail: string | undefined;
      try {
        await withTimeout(cache.set("__storage_health__", 1, 5), 1_000);
        cacheOk = (await withTimeout(cache.get("__storage_health__"), 1_000)) !== null;
      } catch (error) {
        cacheOk = false;
        cacheDetail = error instanceof Error ? error.message : String(error);
      }

      const auditOk = auditStore
        ? await withTimeout(
            (async () => {
              if (auditPool) {
                await auditPool.query("SELECT 1");
              }
              return true;
            })(),
            2_000,
          ).catch(() => false)
        : false;
      const logsOk = logPool
        ? await withTimeout(logPool.query("SELECT 1"), 2_000)
            .then(() => true)
            .catch(() => false)
        : false;

      return {
        primary: { ok: primaryOk, latencyMs: primaryLatency, detail: primaryDetail },
        replicas: replicaStates,
        cache: {
          ok: cacheOk,
          driver: redisUrl ? "redis" : "memory",
          detail: cacheDetail,
        },
        audit: { ok: auditOk, configured: Boolean(auditStore) },
        logs: { ok: logsOk, configured: Boolean(logPool) },
      };
    },
    async shutdown(): Promise<void> {
      readStore.stopLsnMonitor?.();
      await logSink.close?.();
      await cache.close?.();
      await Promise.allSettled([
        primary.$disconnect(),
        ...replicas.map((replica) => replica.client.$disconnect()),
        auditPool?.end() ?? Promise.resolve(),
        logPool?.end() ?? Promise.resolve(),
      ]);
    },
  };

  return engine;
};

let engineSingleton: StorageEngine | undefined;

export const getStorageEngine = (): StorageEngine => {
  if (!engineSingleton) {
    engineSingleton = createStorageEngine();
  }
  return engineSingleton;
};

export const setStorageEngine = (engine: StorageEngine | undefined): void => {
  engineSingleton = engine;
};

const consistencyFor = (minLsnHeader: string | undefined) =>
  minLsnHeader ? { atLeastLsn: minLsnHeader, maxWaitMs: 250 } : ("replica" as const);

/**
 * `ReadStorePort.execute` already falls back to the primary when the chosen
 * replica throws. The helpers below therefore only retry on the primary when
 * the read store itself failed BEFORE running the query (it never reached
 * `fn`); a query that fails on the primary is rethrown instead of being run a
 * second (or third) time, which previously doubled the load of every failing
 * read and hid caller bugs.
 */
const executeOnce = async <T>(
  engine: StorageEngine,
  primary: PrismaClient,
  minLsnHeader: string | undefined,
  fn: (reader: PrismaClient) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let reachedQuery = false;
  const tracked = (reader: PrismaClient): Promise<T> => {
    reachedQuery = true;
    return fn(reader);
  };
  try {
    const result = await engine.readStore.execute(consistencyFor(minLsnHeader), tracked, { timeoutMs });
    recordReadSource(result.servedBy, minLsnHeader);
    return result.data;
  } catch (error) {
    if (reachedQuery) {
      throw error;
    }
    recordReadSource("primary", minLsnHeader);
    return fn(primary);
  }
};

export const readThroughReplica = async <T>(
  minLsnHeader: string | undefined,
  fn: (reader: PrismaClient) => Promise<T>,
  timeoutMs = 3_000,
): Promise<T> => {
  const engine = getStorageEngine();
  return executeOnce(engine, engine.primary, minLsnHeader, fn, timeoutMs);
};

/**
 * Replica read with a safe primary fallback. When the storage engine has not
 * been initialised (unit tests, tools), the supplied primary client is used
 * directly instead of opening a new connection.
 */
export const readThroughReplicaOrPrimary = async <T>(
  primary: PrismaClient,
  minLsnHeader: string | undefined,
  fn: (reader: PrismaClient) => Promise<T>,
  timeoutMs = 3_000,
): Promise<T> => {
  const engine = engineSingleton;
  if (!engine) {
    return fn(primary);
  }
  return executeOnce(engine, primary, minLsnHeader, fn, timeoutMs);
};

export const getConfiguredAuditStore = (): AuditStorePort | null =>
  env.AUDIT_DATABASE_URL ? getStorageEngine().auditStore : null;

export const shutdownStorageEngine = async (): Promise<void> => {
  if (engineSingleton) {
    await engineSingleton.shutdown();
    engineSingleton = undefined;
  }
};

export * from "./ports";
export * from "./lsn";
export { storageTelemetry, recordReadSource } from "./telemetry";
export * from "./shardBalances";
export * from "./uuid";
export { PostgresUnitOfWorkAdapter } from "./uowAdapter";
export { PostgresReplicaReadStore } from "./readStoreAdapter";
export { MemoryCacheAdapter, RedisCacheAdapter } from "./redisCacheAndVelocityAdapter";
export {
  DedicatedAuditDatabaseDriver,
  DedicatedPostgresLogSink,
  computeAuditRowHash,
  computeAuditRowHashFromText,
} from "./auditAndLogAdapters";
export { OutboxRelayWorker, AuditShipperWorker } from "./outboxWorkers";
