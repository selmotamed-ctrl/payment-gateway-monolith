import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import {
  backgroundPoolSettings,
  buildMariaDbPoolConfig,
  isMysqlUrl,
  transactionalPoolSettings,
  type MariaDbPoolOverrides,
} from "../../lib/db/connectionConfig";
import { installQueryBudgetInstrumentation } from "../../lib/db/queryBudgetTracker";

let baseClientInstance: PrismaClient | undefined;
let backgroundClientInstance: PrismaClient | undefined;

const adapterFor = (databaseUrl: string, overrides: MariaDbPoolOverrides = {}) =>
  isMysqlUrl(databaseUrl)
    ? new PrismaMariaDb(buildMariaDbPoolConfig(databaseUrl, overrides) as never)
    : new PrismaMariaDb(databaseUrl);

export const createBaseClient = (
  overrides: MariaDbPoolOverrides = {},
  databaseUrl = env.DATABASE_URL,
): PrismaClient =>
  installQueryBudgetInstrumentation(
    new PrismaClient({
      adapter: adapterFor(databaseUrl, overrides),
      log: [{ emit: "event", level: "query" }],
    }) as unknown as PrismaClient,
  );

/**
 * The hot transactional pool used by checkout, merchant APIs and interactive
 * admin mutations.
 */
export const getDbTransactional = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient(transactionalPoolSettings());
  }
  return baseClientInstance;
};

/**
 * The isolated worker/reconciliation/export pool. It never shares connections
 * with the transactional pool, even when both point at the same database URL.
 */
export const getDbBackground = (): PrismaClient => {
  if (!backgroundClientInstance) {
    backgroundClientInstance = createBaseClient(
      backgroundPoolSettings(),
      process.env.DATABASE_BACKGROUND_URL?.trim() || env.DATABASE_URL,
    );
  }
  return backgroundClientInstance;
};

const proxyFor = (getInstance: () => PrismaClient): PrismaClient =>
  new Proxy({} as PrismaClient, {
    get: (_target, property) => {
      const instance = getInstance();
      const value = Reflect.get(instance, property);
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });

export const dbTransactional = proxyFor(getDbTransactional);
export const dbBackground = proxyFor(getDbBackground);

/** Backwards-compatible alias: the base client is the transactional pool. */
export const getBaseClient = getDbTransactional;
