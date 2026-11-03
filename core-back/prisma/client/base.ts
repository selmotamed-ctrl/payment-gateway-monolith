import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import {
  buildMariaDbPoolConfig,
  buildPrismaTransactionOptions,
  isMysqlUrl,
  type DbPoolName,
} from "../../lib/db/connectionConfig";

const clients: Record<DbPoolName, PrismaClient | undefined> = {
  transactional: undefined,
  background: undefined,
};

const pools = new WeakMap<object, DbPoolName>();

const adapterFor = (databaseUrl: string, pool: DbPoolName) =>
  isMysqlUrl(databaseUrl)
    ? new PrismaMariaDb(buildMariaDbPoolConfig(databaseUrl, pool) as never)
    : new PrismaMariaDb(databaseUrl);

/**
 * Creates a client for one of the two pools. The default keeps the historical
 * `createBaseClient()` behaviour (the transactional pool).
 */
export const createBaseClient = (pool: DbPoolName = "transactional"): PrismaClient => {
  const client = new PrismaClient({
    adapter: adapterFor(env.DATABASE_URL, pool),
    log: [],
  });
  pools.set(client as unknown as object, pool);
  return client;
};

export const getTransactionalClient = (): PrismaClient =>
  clients.transactional ?? (clients.transactional = createBaseClient("transactional"));

export const getBackgroundClient = (): PrismaClient =>
  clients.background ?? (clients.background = createBaseClient("background"));

/**
 * Backwards-compatible alias: `baseClient`/`getBaseClient` are the
 * transactional pool, never the background pool.
 */
export const getBaseClient = (): PrismaClient => getTransactionalClient();

const proxyFor = (pool: DbPoolName): PrismaClient => {
  const proxy = new Proxy({} as PrismaClient, {
    get: (_target, property) => {
      const instance = pool === "background" ? getBackgroundClient() : getTransactionalClient();
      const value = Reflect.get(instance, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
  pools.set(proxy as unknown as object, pool);
  return proxy;
};

/** The transactional pool: checkout, merchant API and admin writes. */
export const dbTransactional = proxyFor("transactional");

/** The background pool: workers, rollups, verifier and exports. */
export const dbBackground = proxyFor("background");

/** The pool a client/proxy belongs to, when it was created here. */
export const poolOfClient = (client: unknown): DbPoolName | undefined => {
  if (!client || (typeof client !== "object" && typeof client !== "function")) {
    return undefined;
  }
  return pools.get(client as object);
};

/** Prisma transaction options (timeouts) matching the client's pool. */
export const prismaTransactionOptionsForClient = (
  client: unknown,
): { maxWait: number; timeout: number } =>
  buildPrismaTransactionOptions(poolOfClient(client) ?? "transactional");

/** Test/shutdown helper: closes both pools and forgets their instances. */
export const disconnectClients = async (): Promise<void> => {
  const instances = [clients.transactional, clients.background].filter(
    (client): client is PrismaClient => client !== undefined,
  );
  clients.transactional = undefined;
  clients.background = undefined;
  await Promise.all(instances.map((client) => client.$disconnect().catch(() => undefined)));
};
