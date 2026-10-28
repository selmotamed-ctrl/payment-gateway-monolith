import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";
import { buildMariaDbPoolConfig, isMysqlUrl } from "../../lib/db/connectionConfig";

let baseClientInstance: PrismaClient | undefined;

const adapterFor = (databaseUrl: string) =>
  isMysqlUrl(databaseUrl)
    ? new PrismaMariaDb(buildMariaDbPoolConfig(databaseUrl) as never)
    : new PrismaMariaDb(databaseUrl);

export const createBaseClient = (): PrismaClient =>
  new PrismaClient({
    adapter: adapterFor(env.DATABASE_URL),
    log: [],
  });

export const getBaseClient = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient();
  }
  return baseClientInstance;
};
