import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import {
  buildMariaDbPoolConfig,
  buildPostgresPoolConfig,
  isMysqlUrl,
  isPostgresUrl,
} from "../../lib/db/connectionConfig";

let baseClientInstance: PrismaClient | undefined;

const adapterFor = (databaseUrl: string) => {
  if (isPostgresUrl(databaseUrl)) {
    return new PrismaPg(buildPostgresPoolConfig(databaseUrl));
  }
  if (isMysqlUrl(databaseUrl)) {
    return new PrismaMariaDb(buildMariaDbPoolConfig(databaseUrl) as never);
  }
  return new PrismaMariaDb(databaseUrl);
};

export const createClientForUrl = (databaseUrl: string): PrismaClient =>
  new PrismaClient({
    adapter: adapterFor(databaseUrl),
    log: [],
  });

export const createBaseClient = (): PrismaClient => createClientForUrl(env.DATABASE_URL);

export const getBaseClient = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient();
  }
  return baseClientInstance;
};
