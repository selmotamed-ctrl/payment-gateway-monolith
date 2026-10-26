import type { PrismaClient } from "../../generated/prisma/client";
import { REQUIRED_SCHEMA_VERSION } from "../schemaVersion";
import { getBaseClient } from "./base";

const clientProxy = new Proxy({} as PrismaClient, {
  get: (_target, property) => {
    const instance = getBaseClient();
    const value = Reflect.get(instance, property);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export const client = clientProxy;

let schemaVersionCheck: Promise<void> | undefined;

export const ensureSchemaVersion = async (): Promise<void> => {
  if (!schemaVersionCheck) {
    schemaVersionCheck = (async () => {
      const instance = getBaseClient();
      await instance.$connect();
      const rows = await instance.$queryRaw<Array<{ version: number }>>`
        SELECT "version"
        FROM "schema_versions"
        WHERE "id" = 1
      `;
      const version = rows[0]?.version;
      if (version !== REQUIRED_SCHEMA_VERSION) {
        throw new Error(
          `Database schema version ${version ?? "missing"} does not match required version ${REQUIRED_SCHEMA_VERSION}`,
        );
      }
    })().catch((error: unknown) => {
      schemaVersionCheck = undefined;
      throw error;
    });
  }

  return schemaVersionCheck;
};

type TransactionCallback = Parameters<PrismaClient["$transaction"]>[0];
export type CtxClient = TransactionCallback extends (tx: infer T, ...args: any[]) => any ? T : never;

export { getBaseClient as baseClient };
