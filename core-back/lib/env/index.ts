import { z } from "zod";

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return value;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return value;
}, z.boolean());

const postgresUrl = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine(
      (value) => /^postgres(ql)?:\/\//i.test(value),
      `${label} must be a PostgreSQL URL (postgresql://user:password@host:port/database)`,
    );

const optionalPostgresUrl = (label: string) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => /^postgres(ql)?:\/\//i.test(value),
      `${label} must be a PostgreSQL URL (postgresql://user:password@host:port/database)`,
    )
    .optional();

const filePath = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank`);

export const envSchema = z.strictObject({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: postgresUrl("DATABASE_URL"),
  /**
   * Session-scoped endpoint for the singleton-worker leader election.
   *
   * PostgreSQL advisory locks live on ONE backend session, so this URL must
   * reach PostgreSQL directly or through a session-pooled PgBouncer database
   * (never a transaction-pooled one). Deploy generates a session alias when
   * PgBouncer is enabled; without PgBouncer it falls back to DATABASE_URL.
   */
  LEADER_ELECTION_DATABASE_URL: optionalPostgresUrl("LEADER_ELECTION_DATABASE_URL"),
  /** True when the deployment fronts PostgreSQL with PgBouncer (transaction pooling for normal traffic). */
  PGBOUNCER_ENABLED: booleanFromEnvironment.default(false),
  /** Comma-separated streaming replica URLs used by ReadStore routing. */
  DATABASE_REPLICA_URLS: z.string().default(""),
  /** Dedicated tamper-evident audit database (pg_audit_db). */
  AUDIT_DATABASE_URL: optionalPostgresUrl("AUDIT_DATABASE_URL"),
  /** Dedicated high-volume operational/step log database (pg_logs_db). */
  LOG_DATABASE_URL: optionalPostgresUrl("LOG_DATABASE_URL"),
  /** L1 + L2 Redis cache / velocity engine. */
  REDIS_URL: z.string().min(1).optional(),
  REDIS_NODES: z.string().default(""),
  READ_REPLICA_MAX_LAG_MS: z.coerce.number().int().nonnegative().default(2000),
  STORAGE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  STORAGE_LOG_BUFFER_MAX: z.coerce.number().int().positive().max(100_000).default(5000),
  STORAGE_LOG_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(250),
  /** Initial routing width of system GL accounts (wallets start at 1). Accounts are widened later by the shard scaler. 1..256. */
  STORAGE_SHARD_COUNT: z.coerce.number().int().positive().max(256).default(16),
  // Processed outbox_events / shipped audit_outbox rows are pruned after this
  // window (0 disables pruning). The dedicated audit DB is the durable copy.
  STORAGE_OUTBOX_RETENTION_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  STORAGE_AUDIT_OUTBOX_RETENTION_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  /** pg-backup-daemon mTLS control plane. */
  BACKUP_DAEMON_URL: z.url().optional(),
  BACKUP_DAEMON_CA_CERT_PATH: z.string().min(1).optional(),
  BACKUP_DAEMON_CLIENT_CERT_PATH: z.string().min(1).optional(),
  BACKUP_DAEMON_CLIENT_KEY_PATH: z.string().min(1).optional(),
  BACKUP_DAEMON_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  MTLS_CA_CERT_PATH: filePath("MTLS_CA_CERT_PATH"),
  MTLS_SERVER_CERT_PATH: filePath("MTLS_SERVER_CERT_PATH"),
  MTLS_SERVER_KEY_PATH: filePath("MTLS_SERVER_KEY_PATH"),
  KMS_MASTER_KEY: z
    .string()
    .min(16, "KMS_MASTER_KEY must be at least 16 characters long"),
  TRUST_PROXY: booleanFromEnvironment.default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * The master switch of the durable workers. It defaults to `true` because
   * the statement upload and the dispute intake are queue-only routes: an
   * API that answers `202 Accepted` without a queue drain loses the work.
   * The startup guard refuses to boot when this is explicitly disabled.
   */
  WORKER_ENABLED: booleanFromEnvironment.default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(50),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().max(100).default(4),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
  /**
   * How long a merchant stays screened before the periodic re-screening (L2)
   * picks it up again.
   */
  WORKER_RESCREEN_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  /**
   * How often the KYB expiry, notice, suspension and periodic re-verification
   * worker runs.
   */
  WORKER_KYB_EXPIRY_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  /**
   * How many KYB documents or merchants the worker checks in one pass.
   */
  WORKER_KYB_EXPIRY_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(200),
  /**
   * The record retention worker (OD-4). It purges the regulatory evidence
   * that passed the retention period, and it is off unless a deployment
   * turns it on.
   */
  WORKER_RETENTION_ENABLED: booleanFromEnvironment.default(false),
  /**
   * How often the retention worker runs.
   */
  WORKER_RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /**
   * How many rows the retention worker purges in one batch.
   */
  WORKER_RETENTION_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(500),
  /**
   * The dry run of the retention worker: it reports what it would purge
   * without deleting anything.
   */
  RETENTION_DRY_RUN: booleanFromEnvironment.default(false),
  /**
   * The ledger checkpoint worker keeps every shard's checkpoint close to its head with a verified O(delta)
   * proof (no locks, payments are never delayed). It is on by default; it is idempotent and safe to disable.
   */
  WORKER_LEDGER_CHECKPOINT_ENABLED: booleanFromEnvironment.default(true),
  /** How often the checkpoint worker looks for shards that need a checkpoint. */
  WORKER_LEDGER_CHECKPOINT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** How many shards the checkpoint worker captures in one pass. */
  WORKER_LEDGER_CHECKPOINT_BATCH_SIZE: z.coerce.number().int().positive().max(10_000).default(50),
  /** A shard is checkpointed once this many lines were posted since its last checkpoint. */
  LEDGER_CHECKPOINT_MIN_LINES: z.coerce.number().int().positive().default(5000),
  /** ... or once it has any new line and its checkpoint is older than this (milliseconds). */
  LEDGER_CHECKPOINT_MAX_AGE_MS: z.coerce.number().int().positive().default(900_000),
  /**
   * The ledger shard scaler measures the posting rate of every shard and widens a GL account that stays hot.
   * It is ON by default and widens accounts itself (audited as GL_ACCOUNT_SHARDS_SCALED). Set
   * LEDGER_SHARD_SCALER_DRY_RUN=true to make it only audit what it would do (GL_ACCOUNT_SHARDS_SCALE_PROPOSED).
   */
  WORKER_LEDGER_SHARD_SCALER_ENABLED: booleanFromEnvironment.default(true),
  /** How often the shard scaler samples the shard sequences. */
  WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** Detect and audit only (no account is widened). Off by default: the scaler widens hot accounts automatically. */
  LEDGER_SHARD_SCALER_DRY_RUN: booleanFromEnvironment.default(false),
  /**
   * Automatic repair of a shard that keeps failing its checkpoint proof: only a persistent PARITY failure with an
   * intact sequence is recomputed from the journal. Anything else (a GAP, a damaged sequence, a large correction) is
   * left to a person. Set LEDGER_SHARD_AUTO_REPAIR_ENABLED=false to turn it off.
   */
  LEDGER_SHARD_AUTO_REPAIR_ENABLED: booleanFromEnvironment.default(true),
  /** Consecutive failed proofs required before an automatic repair (checks are retried about every 10 minutes). */
  LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES: z.coerce.number().int().min(1).default(3),
  /** Largest correction (absolute, in money units) an automatic repair may apply; a larger one is left to a person. */
  LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT: z.coerce.number().nonnegative().default(100),
  /** Lines per second per shard above which an account is considered hot (a shard row serializes its postings). */
  LEDGER_SHARD_UP_LINES_PER_SEC: z.coerce.number().positive().default(150),
  /** Largest routing width the scaler will give an account (1..256). */
  LEDGER_SHARD_MAX_WIDTH: z.coerce.number().int().positive().max(256).default(64),
  /** Minimum time between two scalings of the same account (milliseconds). */
  LEDGER_SHARD_COOLDOWN_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * The durable job queue of `core-back`. It drains the background jobs (the
   * statement reconciliation and the dispute / adjustment execution).
   */
  WORKER_BACKGROUND_JOBS_ENABLED: booleanFromEnvironment.default(true),
  /**
   * How often the background job queue is drained.
   */
  WORKER_BACKGROUND_JOBS_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  /**
   * How many background jobs are claimed in one drain.
   */
  WORKER_BACKGROUND_JOBS_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(10),
  /**
   * The lease of a claimed background job. A job that is still `RUNNING`
   * when its lease expired belonged to a crashed node and is re-queued.
   */
  WORKER_BACKGROUND_JOBS_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
  /**
   * The age of the oldest queued job above which the health probe reports a
   * degraded queue. The default is five minutes.
   */
  WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * The endpoint of the SMS / email aggregator of the deployment.
   *
   * The variable is optional: without it the platform keeps working in
   * development through the log transport, which reports `SENT` instead of
   * `DELIVERED` because no provider confirmed the delivery.
   */
  NOTIFICATION_WEBHOOK_URL: z.url().optional(),
  /**
   * The strict timeout of a single delivery attempt against the aggregator.
   */
  NOTIFICATION_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(5000),
  /**
   * The standalone Fake Payment Rails emulator (design
   * `fake_payment_rails_service_architecture.md`).
   *
   * `ALLOW_FAKE_RAILS_HOSTS` relaxes the SSRF private-address guard ONLY for
   * the exact hosts in `FAKE_RAILS_ALLOWED_HOSTS` that are also declared in the
   * gateway version's `allowed_hosts`. Every other private, loopback and
   * metadata address stays blocked.
   */
  FAKE_RAILS_ENABLED: booleanFromEnvironment.default(false),
  FAKE_RAILS_ALLOW_IN_PRODUCTION: booleanFromEnvironment.default(false),
  IS_TEST_SERVER: booleanFromEnvironment.default(false),
  FAKE_RAILS_PUBLIC_BASE_URL: z.url().optional(),
  ALLOW_FAKE_RAILS_HOSTS: booleanFromEnvironment.default(false),
  /**
   * Explicit opt-out of the outbound host allowlist. By default a gateway
   * environment with an EMPTY `allowed_hosts` fails closed (SSRF). Set this
   * only for local/test stacks; never in production.
   */
  ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST: booleanFromEnvironment.default(false),
  FAKE_RAILS_ALLOWED_HOSTS: z.string().default(""),
  FAKE_RAILS_SEEDER_TOKEN: z.string().min(16).optional(),
  FAKE_RAILS_ALLOWED_CIDRS: z.string().default(""),
});

export type CoreEnv = z.infer<typeof envSchema>;

const environmentKeys = new Set(Object.keys(envSchema.shape));

const readEnvironment = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => environmentKeys.has(key) && value !== undefined,
    ),
  );

const isTestEnvironment = (): boolean => process.env.NODE_ENV === "test";

let cached: CoreEnv | undefined;
let warnedAboutTestEnvironment = false;

const sameDatabaseEndpoint = (left: string, right: string): boolean => {
  try {
    const a = new URL(left);
    const b = new URL(right);
    const port = (url: URL): string => url.port || "5432";
    return a.hostname === b.hostname && port(a) === port(b) && a.pathname === b.pathname;
  } catch {
    return false;
  }
};

/**
 * Cross-field checks that a strict object cannot express.
 *
 * With PgBouncer enabled the ordinary `DATABASE_URL` is transaction-pooled, so
 * a session advisory lock cannot survive on it. Deploy generates a distinct
 * session alias; accepting the pooled URL here would silently defeat every
 * singleton worker, so the process refuses to boot instead.
 */
export const crossFieldIssues = (value: CoreEnv): string[] => {
  const issues: string[] = [];
  if (!value.WORKER_ENABLED || !value.PGBOUNCER_ENABLED) {
    return issues;
  }
  if (!value.LEADER_ELECTION_DATABASE_URL) {
    issues.push(
      "LEADER_ELECTION_DATABASE_URL is required when WORKER_ENABLED and PGBOUNCER_ENABLED are true " +
        "(point it at the PgBouncer session alias, never the transaction-pooled DATABASE_URL)",
    );
    return issues;
  }
  if (sameDatabaseEndpoint(value.LEADER_ELECTION_DATABASE_URL, value.DATABASE_URL)) {
    issues.push(
      "LEADER_ELECTION_DATABASE_URL must not be the transaction-pooled DATABASE_URL " +
        "(use the session-pooled alias or a direct PostgreSQL URL)",
    );
  }
  return issues;
};

const parseEnvironment = (): { ok: true; data: CoreEnv } | { ok: false; issues: string[] } => {
  const result = envSchema.safeParse(readEnvironment());
  if (result.success) {
    const issues = crossFieldIssues(result.data);
    if (issues.length > 0) {
      return { ok: false, issues };
    }
    return { ok: true, data: result.data };
  }
  return {
    ok: false,
    issues: [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "environment"))],
  };
};

const resolveEnvironment = (): CoreEnv => {
  if (!isTestEnvironment() && cached) {
    return cached;
  }
  const parsed = parseEnvironment();
  if (parsed.ok) {
    cached = parsed.data;
    return parsed.data;
  }
  if (!isTestEnvironment()) {
    process.stderr.write(`Invalid environment configuration: ${parsed.issues.join(", ")}\n`);
    process.exit(1);
  }
  if (!warnedAboutTestEnvironment) {
    warnedAboutTestEnvironment = true;
    process.stderr.write(`Test environment is missing configuration: ${parsed.issues.join(", ")}\n`);
  }
  return {
    PORT: 4000,
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/payment_gateway_monolith_test",
    LEADER_ELECTION_DATABASE_URL: undefined,
    PGBOUNCER_ENABLED: false,
    DATABASE_REPLICA_URLS: "",
    AUDIT_DATABASE_URL: undefined,
    LOG_DATABASE_URL: undefined,
    REDIS_URL: undefined,
    REDIS_NODES: "",
    READ_REPLICA_MAX_LAG_MS: 2000,
    STORAGE_QUERY_TIMEOUT_MS: 5000,
    STORAGE_LOG_BUFFER_MAX: 5000,
    STORAGE_LOG_FLUSH_INTERVAL_MS: 250,
    STORAGE_SHARD_COUNT: 16,
    STORAGE_OUTBOX_RETENTION_MS: 3_600_000,
    STORAGE_AUDIT_OUTBOX_RETENTION_MS: 3_600_000,
    BACKUP_DAEMON_URL: undefined,
    BACKUP_DAEMON_CA_CERT_PATH: undefined,
    BACKUP_DAEMON_CLIENT_CERT_PATH: undefined,
    BACKUP_DAEMON_CLIENT_KEY_PATH: undefined,
    BACKUP_DAEMON_TIMEOUT_MS: 15000,
    MTLS_CA_CERT_PATH: "./certs/internal-ca.crt",
    MTLS_SERVER_CERT_PATH: "./certs/core-back.crt",
    MTLS_SERVER_KEY_PATH: "./certs/core-back.key",
    KMS_MASTER_KEY: "test-only-master-key-value",
    TRUST_PROXY: false,
    LOG_LEVEL: "error",
    WORKER_ENABLED: true,
    WORKER_POLL_INTERVAL_MS: 5000,
    WORKER_BATCH_SIZE: 50,
    WORKER_CONCURRENCY: 4,
    WORKER_MAX_ATTEMPTS: 3,
    WORKER_REQUEST_TIMEOUT_MS: 15000,
    WORKER_RESCREEN_INTERVAL_MS: 86_400_000,
    WORKER_KYB_EXPIRY_INTERVAL_MS: 21_600_000,
    WORKER_KYB_EXPIRY_BATCH_SIZE: 200,
    WORKER_RETENTION_ENABLED: false,
    WORKER_RETENTION_INTERVAL_MS: 3_600_000,
    WORKER_RETENTION_BATCH_SIZE: 500,
    RETENTION_DRY_RUN: false,
    WORKER_LEDGER_CHECKPOINT_ENABLED: true,
    WORKER_LEDGER_CHECKPOINT_INTERVAL_MS: 30_000,
    WORKER_LEDGER_CHECKPOINT_BATCH_SIZE: 50,
    LEDGER_CHECKPOINT_MIN_LINES: 5000,
    LEDGER_CHECKPOINT_MAX_AGE_MS: 900_000,
    WORKER_LEDGER_SHARD_SCALER_ENABLED: true,
    WORKER_LEDGER_SHARD_SCALER_INTERVAL_MS: 30_000,
    LEDGER_SHARD_SCALER_DRY_RUN: false,
    LEDGER_SHARD_AUTO_REPAIR_ENABLED: true,
    LEDGER_SHARD_AUTO_REPAIR_MIN_FAILURES: 3,
    LEDGER_SHARD_AUTO_REPAIR_MAX_ABS_DRIFT: 100,
    LEDGER_SHARD_UP_LINES_PER_SEC: 150,
    LEDGER_SHARD_MAX_WIDTH: 64,
    LEDGER_SHARD_COOLDOWN_MS: 600_000,
    WORKER_BACKGROUND_JOBS_ENABLED: true,
    WORKER_BACKGROUND_JOBS_INTERVAL_MS: 2000,
    WORKER_BACKGROUND_JOBS_BATCH_SIZE: 10,
    WORKER_BACKGROUND_JOBS_LEASE_SECONDS: 300,
    WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS: 300_000,
    NOTIFICATION_WEBHOOK_URL: undefined,
    NOTIFICATION_WEBHOOK_TIMEOUT_MS: 5000,
    FAKE_RAILS_ENABLED: false,
    FAKE_RAILS_ALLOW_IN_PRODUCTION: false,
    IS_TEST_SERVER: false,
    FAKE_RAILS_PUBLIC_BASE_URL: undefined,
    ALLOW_FAKE_RAILS_HOSTS: false,
    ALLOW_EMPTY_OUTBOUND_HOST_ALLOWLIST: false,
    FAKE_RAILS_ALLOWED_HOSTS: "",
    FAKE_RAILS_SEEDER_TOKEN: undefined,
    FAKE_RAILS_ALLOWED_CIDRS: "",
  };
};

export const env: CoreEnv = new Proxy({} as CoreEnv, {
  get(_target, property) {
    if (typeof property === "symbol") {
      return undefined;
    }
    return resolveEnvironment()[property as keyof CoreEnv];
  },
  has(_target, property) {
    if (typeof property === "symbol") {
      return false;
    }
    return property in resolveEnvironment();
  },
  ownKeys() {
    return Reflect.ownKeys(resolveEnvironment());
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(resolveEnvironment(), property);
  },
});

export const reloadEnv = (): CoreEnv => {
  cached = undefined;
  return resolveEnvironment();
};

const redactedKeys = new Set([
  "DATABASE_URL",
  "LEADER_ELECTION_DATABASE_URL",
  "KMS_MASTER_KEY",
  "MTLS_SERVER_KEY_PATH",
]);

export const envSummary = (): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(resolveEnvironment()).map(([key, value]) => [
      key,
      redactedKeys.has(key) ? "[redacted]" : value,
    ]),
  );
