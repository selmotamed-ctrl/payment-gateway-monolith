import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";

let baseClientInstance: PrismaClient | undefined;

export const createBaseClient = (): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaMariaDb(env.DATABASE_URL),
    log: [],
  });

export const getBaseClient = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient();
  }
  return baseClientInstance;
};
