import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import {
  buildPostgresPoolConfig,
  isPostgresUrl,
} from "../../lib/db/connectionConfig";
import { prismaTransactionOptions } from "../../lib/db/waitBudgets";

let baseClientInstance: PrismaClient | undefined;

const adapterFor = (databaseUrl: string) => {
  if (!isPostgresUrl(databaseUrl)) {
    throw new Error("DATABASE_URL must be a PostgreSQL URL");
  }
  return new PrismaPg(buildPostgresPoolConfig(databaseUrl));
};

export const createClientForUrl = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: adapterFor(databaseUrl),
    log: [],
    // Only when PG_TX_MAX_WAIT_MS is set (tests); otherwise Prisma's own defaults.
    ...(prismaTransactionOptions() ? { transactionOptions: prismaTransactionOptions() } : {}),
  });

export const createBaseClient = (): PrismaClient => createClientForUrl(env.DATABASE_URL);

export const getBaseClient = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient();
  }
  return baseClientInstance;
};
