import { poolConnectTimeoutMs } from "./waitBudgets";

export const isPostgresUrl = (databaseUrl: string): boolean => {
  try {
    const { protocol } = new URL(databaseUrl);
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
};

export interface PostgresPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  application_name: string;
}

export const buildPostgresPoolConfig = (
  databaseUrl: string,
  options: { max?: number; applicationName?: string } = {},
): PostgresPoolConfig => {
  const url = new URL(databaseUrl);
  const limit =
    options.max ??
    Number(url.searchParams.get("connection_limit") ?? url.searchParams.get("pool_max") ?? 20);
  return {
    connectionString: databaseUrl,
    max: Number.isFinite(limit) && limit > 0 ? limit : 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: poolConnectTimeoutMs(5_000),
    application_name: options.applicationName ?? "pg-core-back",
  };
};

export const parsePostgresUrlList = (raw: string): string[] =>
  raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && isPostgresUrl(entry));
