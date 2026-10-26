import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";
import { env } from "../../lib/env";

let baseClientInstance: PrismaClient | undefined;

export const createBaseClient = (): PrismaClient =>
  new PrismaClient({
    adapter: new PrismaPg(env.DATABASE_URL),
    log: [],
  });

export const getBaseClient = (): PrismaClient => {
  if (!baseClientInstance) {
    baseClientInstance = createBaseClient();
  }
  return baseClientInstance;
};
