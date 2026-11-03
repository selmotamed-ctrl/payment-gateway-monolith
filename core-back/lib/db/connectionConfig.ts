/**
 * Turns `DATABASE_URL` into the config the MariaDB driver expects.
 *
 * MySQL 8 defaults new accounts to `caching_sha2_password`. Over a non-TLS
 * connection the first (uncached) login must fetch the server's RSA public key,
 * and the driver refuses that unless `allowPublicKeyRetrieval` is enabled. The
 * flag is not a Prisma connection-string parameter, so it is set on the pool
 * config here; migrations keep using the Prisma CLI, which handles it natively.
 *
 * Two pools are used (design `high_scale_db_architecture_v2.md` §2.6/§2.11):
 *
 *   - `transactional` (40 connections by default) for checkout, merchant API
 *     and admin writes;
 *   - `background` (15 connections by default) for workers, rollups, the
 *     verifier and exports.
 *
 * Both pools set `READ COMMITTED` on every new session. The per-pool limits,
 * acquisition/statement timeouts and transaction timeouts can be overridden
 * with the environment variables documented in `POOL_ENV_KEYS` below.
 */
export interface MariaDbPoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  allowPublicKeyRetrieval: boolean;
  /** Pool size. Defaults to 40 (transactional) or 15 (background). */
  connectionLimit: number;
  /** Maximum time to wait for a pooled connection, in milliseconds. */
  acquireTimeout: number;
  /** Initial TCP connection timeout, in milliseconds. */
  connectTimeout: number;
  /** Driver-side command timeout, in milliseconds. */
  queryTimeout: number;
  /** Idle pooled connections are released after this many seconds. */
  idleTimeout: number;
  /** Every new session runs with this isolation level. */
  transactionIsolation: "READ COMMITTED";
  /** `innodb_lock_wait_timeout` applied to every new session, in seconds. */
  lockWaitTimeoutSeconds: number;
  /** Maximum statement time requested from the server, in milliseconds. */
  maxStatementTimeMs: number;
  /** Application transaction timeout, in milliseconds. */
  transactionTimeoutMs: number;
  /** Statements executed before a pooled connection is handed to Prisma. */
  initSql: string[];
  /**
   * Prisma persists every DateTime as UTC. Raw SQL comparisons against a
   * DATETIME column must therefore also bind the Date as UTC; with the driver
   * default ("local") a parameter such as `available_at <= ?` is shifted by
   * the host offset and the durable queue never sees a due job.
   */
  timezone: string;
}

export type DbPoolName = "transactional" | "background";

export interface DbPoolSettings {
  connectionLimit: number;
  acquireTimeoutMs: number;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  transactionTimeoutMs: number;
  lockWaitTimeoutSeconds: number;
  idleTimeoutSeconds: number;
}

/**
 * The default sizes are per node. The cluster total must stay below
 * `max_connections - 20` (design §2.11).
 */
export const DEFAULT_DB_POOL_SETTINGS: Record<DbPoolName, DbPoolSettings> = {
  transactional: {
    connectionLimit: 40,
    acquireTimeoutMs: 10_000,
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 15_000,
    transactionTimeoutMs: 15_000,
    lockWaitTimeoutSeconds: 5,
    idleTimeoutSeconds: 1_800,
  },
  background: {
    connectionLimit: 15,
    acquireTimeoutMs: 30_000,
    connectTimeoutMs: 10_000,
    statementTimeoutMs: 120_000,
    transactionTimeoutMs: 60_000,
    lockWaitTimeoutSeconds: 30,
    idleTimeoutSeconds: 1_800,
  },
};

/**
 * Canonical environment names. Each accepts the listed aliases so existing
 * deployment files can keep their own spelling without changing behaviour.
 */
export const POOL_ENV_KEYS: Record<DbPoolName, Record<keyof DbPoolSettings, readonly string[]>> = {
  transactional: {
    connectionLimit: [
      "DB_TRANSACTIONAL_CONNECTION_LIMIT",
      "DB_TRANSACTIONAL_POOL_SIZE",
      "DB_POOL_TRANSACTIONAL_SIZE",
      "DB_TRANSACTIONAL_MAX_CONNECTIONS",
      "DB_TX_POOL_SIZE",
    ],
    acquireTimeoutMs: [
      "DB_TRANSACTIONAL_ACQUIRE_TIMEOUT_MS",
      "DB_TRANSACTIONAL_ACQUIRE_TIMEOUT",
      "DB_TX_ACQUIRE_TIMEOUT_MS",
    ],
    connectTimeoutMs: ["DB_CONNECT_TIMEOUT_MS", "DB_CONNECT_TIMEOUT"],
    statementTimeoutMs: [
      "DB_TRANSACTIONAL_STATEMENT_TIMEOUT_MS",
      "DB_TRANSACTIONAL_MAX_STATEMENT_TIME_MS",
      "DB_TX_STATEMENT_TIMEOUT_MS",
    ],
    transactionTimeoutMs: [
      "DB_TRANSACTIONAL_TRANSACTION_TIMEOUT_MS",
      "DB_TRANSACTIONAL_TIMEOUT_MS",
      "DB_TX_TRANSACTION_TIMEOUT_MS",
    ],
    lockWaitTimeoutSeconds: ["DB_TRANSACTIONAL_LOCK_WAIT_TIMEOUT_S", "DB_TX_LOCK_WAIT_TIMEOUT_S"],
    idleTimeoutSeconds: ["DB_IDLE_TIMEOUT_S"],
  },
  background: {
    connectionLimit: [
      "DB_BACKGROUND_CONNECTION_LIMIT",
      "DB_BACKGROUND_POOL_SIZE",
      "DB_POOL_BACKGROUND_SIZE",
      "DB_BACKGROUND_MAX_CONNECTIONS",
      "DB_BG_POOL_SIZE",
    ],
    acquireTimeoutMs: [
      "DB_BACKGROUND_ACQUIRE_TIMEOUT_MS",
      "DB_BACKGROUND_ACQUIRE_TIMEOUT",
      "DB_BG_ACQUIRE_TIMEOUT_MS",
    ],
    connectTimeoutMs: ["DB_CONNECT_TIMEOUT_MS", "DB_CONNECT_TIMEOUT"],
    statementTimeoutMs: [
      "DB_BACKGROUND_STATEMENT_TIMEOUT_MS",
      "DB_BACKGROUND_MAX_STATEMENT_TIME_MS",
      "DB_BG_STATEMENT_TIMEOUT_MS",
    ],
    transactionTimeoutMs: [
      "DB_BACKGROUND_TRANSACTION_TIMEOUT_MS",
      "DB_BACKGROUND_TIMEOUT_MS",
      "DB_BG_TRANSACTION_TIMEOUT_MS",
    ],
    lockWaitTimeoutSeconds: ["DB_BACKGROUND_LOCK_WAIT_TIMEOUT_S", "DB_BG_LOCK_WAIT_TIMEOUT_S"],
    idleTimeoutSeconds: ["DB_IDLE_TIMEOUT_S"],
  },
};

const firstDefined = <T>(values: Array<T | undefined>): T | undefined =>
  values.find((value) => value !== undefined);

const positiveInteger = (value: string | number | undefined): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
};

const envValue = (
  environment: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined => firstDefined(names.map((name) => environment[name]));

/**
 * Resolves the effective settings of one pool. An explicit override wins over
 * the environment, which wins over the defaults.
 */
export const resolveDbPoolSettings = (
  pool: DbPoolName,
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<DbPoolSettings> = {},
): DbPoolSettings => {
  const defaults = DEFAULT_DB_POOL_SETTINGS[pool];
  const keys = POOL_ENV_KEYS[pool];
  const fromEnv = (field: keyof DbPoolSettings): number | undefined =>
    positiveInteger(envValue(environment, keys[field]));
  return {
    connectionLimit:
      positiveInteger(overrides.connectionLimit) ?? fromEnv("connectionLimit") ?? defaults.connectionLimit,
    acquireTimeoutMs:
      positiveInteger(overrides.acquireTimeoutMs) ?? fromEnv("acquireTimeoutMs") ?? defaults.acquireTimeoutMs,
    connectTimeoutMs:
      positiveInteger(overrides.connectTimeoutMs) ?? fromEnv("connectTimeoutMs") ?? defaults.connectTimeoutMs,
    statementTimeoutMs:
      positiveInteger(overrides.statementTimeoutMs) ?? fromEnv("statementTimeoutMs") ?? defaults.statementTimeoutMs,
    transactionTimeoutMs:
      positiveInteger(overrides.transactionTimeoutMs) ?? fromEnv("transactionTimeoutMs") ?? defaults.transactionTimeoutMs,
    lockWaitTimeoutSeconds:
      positiveInteger(overrides.lockWaitTimeoutSeconds)
      ?? fromEnv("lockWaitTimeoutSeconds")
      ?? defaults.lockWaitTimeoutSeconds,
    idleTimeoutSeconds:
      positiveInteger(overrides.idleTimeoutSeconds) ?? fromEnv("idleTimeoutSeconds") ?? defaults.idleTimeoutSeconds,
  };
};

export const isMysqlUrl = (databaseUrl: string): boolean => {
  try {
    const { protocol } = new URL(databaseUrl);
    return protocol === "mysql:" || protocol === "mariadb:";
  } catch {
    return false;
  }
};

export interface BuildMariaDbPoolConfigOptions {
  pool?: DbPoolName;
  /** Explicit values used by tests and by callers that already resolved env. */
  connectionLimit?: number;
  acquireTimeoutMs?: number;
  connectTimeoutMs?: number;
  statementTimeoutMs?: number;
  transactionTimeoutMs?: number;
  lockWaitTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  environment?: NodeJS.ProcessEnv;
}

const normaliseOptions = (
  input: DbPoolName | BuildMariaDbPoolConfigOptions | undefined,
): BuildMariaDbPoolConfigOptions => {
  if (typeof input === "string") {
    return { pool: input };
  }
  return input ?? {};
};

/**
 * The session statements are deliberately portable between MariaDB and MySQL:
 * `SET SESSION TRANSACTION ISOLATION LEVEL` and `innodb_lock_wait_timeout`
 * exist on both. MariaDB-only variables are not sent here, so a MySQL
 * deployment never fails to connect because of an unknown session variable.
 */
const buildInitSql = (settings: DbPoolSettings): string[] => [
  "SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED",
  `SET SESSION innodb_lock_wait_timeout = ${settings.lockWaitTimeoutSeconds}`,
];

export const buildMariaDbPoolConfig = (
  databaseUrl: string,
  poolOrOptions: DbPoolName | BuildMariaDbPoolConfigOptions = "transactional",
): MariaDbPoolConfig => {
  const options = normaliseOptions(poolOrOptions);
  const pool = options.pool ?? "transactional";
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) {
    throw new Error("DATABASE_URL is missing a database name");
  }

  const environment = options.environment ?? process.env;
  const settings = resolveDbPoolSettings(pool, environment, {
    ...(positiveInteger(options.connectionLimit) !== undefined
      ? { connectionLimit: positiveInteger(options.connectionLimit) }
      : {}),
    ...(positiveInteger(options.acquireTimeoutMs) !== undefined
      ? { acquireTimeoutMs: positiveInteger(options.acquireTimeoutMs) }
      : {}),
    ...(positiveInteger(options.connectTimeoutMs) !== undefined
      ? { connectTimeoutMs: positiveInteger(options.connectTimeoutMs) }
      : {}),
    ...(positiveInteger(options.statementTimeoutMs) !== undefined
      ? { statementTimeoutMs: positiveInteger(options.statementTimeoutMs) }
      : {}),
    ...(positiveInteger(options.transactionTimeoutMs) !== undefined
      ? { transactionTimeoutMs: positiveInteger(options.transactionTimeoutMs) }
      : {}),
    ...(positiveInteger(options.lockWaitTimeoutSeconds) !== undefined
      ? { lockWaitTimeoutSeconds: positiveInteger(options.lockWaitTimeoutSeconds) }
      : {}),
    ...(positiveInteger(options.idleTimeoutSeconds) !== undefined
      ? { idleTimeoutSeconds: positiveInteger(options.idleTimeoutSeconds) }
      : {}),
  });

  // A connection limit embedded in the URL is still honoured when no explicit
  // environment override or option is present (the historical behaviour).
  const urlLimit = positiveInteger(
    url.searchParams.get("connectionLimit") ?? url.searchParams.get("connection_limit") ?? undefined,
  );
  if (
    urlLimit !== undefined
    && options.connectionLimit === undefined
    && envValue(environment, POOL_ENV_KEYS[pool].connectionLimit) === undefined
  ) {
    settings.connectionLimit = urlLimit;
  }
  const urlAcquireTimeout = positiveInteger(
    url.searchParams.get("acquireTimeout") ?? url.searchParams.get("acquire_timeout") ?? undefined,
  );
  if (
    urlAcquireTimeout !== undefined
    && options.acquireTimeoutMs === undefined
    && envValue(environment, POOL_ENV_KEYS[pool].acquireTimeoutMs) === undefined
  ) {
    settings.acquireTimeoutMs = urlAcquireTimeout;
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    allowPublicKeyRetrieval: true,
    connectionLimit: settings.connectionLimit,
    acquireTimeout: settings.acquireTimeoutMs,
    connectTimeout: settings.connectTimeoutMs,
    queryTimeout: settings.statementTimeoutMs,
    idleTimeout: settings.idleTimeoutSeconds,
    transactionIsolation: "READ COMMITTED",
    lockWaitTimeoutSeconds: settings.lockWaitTimeoutSeconds,
    maxStatementTimeMs: settings.statementTimeoutMs,
    transactionTimeoutMs: settings.transactionTimeoutMs,
    initSql: buildInitSql(settings),
    timezone: "Z",
  };
};

export const buildTransactionalPoolConfig = (
  databaseUrl: string,
  options: BuildMariaDbPoolConfigOptions = {},
): MariaDbPoolConfig => buildMariaDbPoolConfig(databaseUrl, { ...options, pool: "transactional" });

export const buildBackgroundPoolConfig = (
  databaseUrl: string,
  options: BuildMariaDbPoolConfigOptions = {},
): MariaDbPoolConfig => buildMariaDbPoolConfig(databaseUrl, { ...options, pool: "background" });

/** The Prisma transaction options matching a pool (§2.6 timeouts). */
export const buildPrismaTransactionOptions = (
  pool: DbPoolName = "transactional",
  environment: NodeJS.ProcessEnv = process.env,
): { maxWait: number; timeout: number } => {
  const settings = resolveDbPoolSettings(pool, environment);
  return {
    maxWait: settings.acquireTimeoutMs,
    timeout: settings.transactionTimeoutMs,
  };
};
