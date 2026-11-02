/**
 * Turns `DATABASE_URL` into the config the MariaDB driver expects.
 *
 * MySQL 8 defaults new accounts to `caching_sha2_password`. Over a non-TLS
 * connection the first (uncached) login must fetch the server's RSA public key,
 * and the driver refuses that unless `allowPublicKeyRetrieval` is enabled. The
 * flag is not a Prisma connection-string parameter, so it is set on the pool
 * config here; migrations keep using the Prisma CLI, which handles it natively.
 */
export interface MariaDbPoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  allowPublicKeyRetrieval: boolean;
  connectionLimit?: number;
  acquireTimeout?: number;
  /**
   * Prisma persists every DateTime as UTC. Raw SQL comparisons against a
   * DATETIME column must therefore also bind the Date as UTC; with the driver
   * default ("local") a parameter such as `available_at <= ?` is shifted by
   * the host offset and the durable queue never sees a due job.
   */
  timezone: string;
}

export interface MariaDbPoolOverrides {
  connectionLimit?: number;
  acquireTimeout?: number;
  /** Alias used by the high-scale plan pseudocode. */
  defaultConnectionLimit?: number;
  /** Alias used by the high-scale plan pseudocode. */
  defaultAcquireTimeoutMs?: number;
}

export interface MariaDbPoolSettings extends MariaDbPoolOverrides {
  connectionLimit: number;
  acquireTimeout: number;
}

export const DEFAULT_TRANSACTIONAL_POOL_SIZE = 40;
export const DEFAULT_TRANSACTIONAL_ACQUIRE_TIMEOUT_MS = 3_000;
export const DEFAULT_BACKGROUND_POOL_SIZE = 15;
export const DEFAULT_BACKGROUND_ACQUIRE_TIMEOUT_MS = 15_000;

const positiveInteger = (value: string | undefined, fallback: number): number => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const isMysqlUrl = (databaseUrl: string): boolean => {
  try {
    const { protocol } = new URL(databaseUrl);
    return protocol === "mysql:" || protocol === "mariadb:";
  } catch {
    return false;
  }
};

export const buildMariaDbPoolConfig = (
  databaseUrl: string,
  overrides: MariaDbPoolOverrides = {},
): MariaDbPoolConfig => {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("DATABASE_URL is missing a database name");
  }
  const limit = url.searchParams.get("connectionLimit") ?? url.searchParams.get("connection_limit");
  const connectionLimit = overrides.connectionLimit
    ?? overrides.defaultConnectionLimit
    ?? (limit ? positiveInteger(limit, DEFAULT_TRANSACTIONAL_POOL_SIZE) : undefined);
  const acquireTimeout = overrides.acquireTimeout ?? overrides.defaultAcquireTimeoutMs;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    allowPublicKeyRetrieval: true,
    timezone: "Z",
    ...(connectionLimit !== undefined ? { connectionLimit } : {}),
    ...(acquireTimeout !== undefined ? { acquireTimeout } : {}),
  };
};

/**
 * The hot checkout/API pool. A stuck statement fails fast so a saturated
 * database never turns into an unbounded API queue.
 */
export const transactionalPoolSettings = (): MariaDbPoolSettings => ({
  connectionLimit: positiveInteger(
    process.env.DB_TRANSACTIONAL_POOL_SIZE,
    DEFAULT_TRANSACTIONAL_POOL_SIZE,
  ),
  acquireTimeout: positiveInteger(
    process.env.DB_TRANSACTIONAL_ACQUIRE_TIMEOUT_MS,
    DEFAULT_TRANSACTIONAL_ACQUIRE_TIMEOUT_MS,
  ),
});

/**
 * The worker, reconciliation and export pool. It waits longer because a
 * statement import or retention purge may briefly occupy every connection.
 */
export const backgroundPoolSettings = (): MariaDbPoolSettings => ({
  connectionLimit: positiveInteger(
    process.env.DB_BACKGROUND_POOL_SIZE,
    DEFAULT_BACKGROUND_POOL_SIZE,
  ),
  acquireTimeout: positiveInteger(
    process.env.DB_BACKGROUND_ACQUIRE_TIMEOUT_MS,
    DEFAULT_BACKGROUND_ACQUIRE_TIMEOUT_MS,
  ),
});
