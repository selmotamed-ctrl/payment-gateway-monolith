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

const mysqlUrl = z
  .string()
  .min(1, "DATABASE_URL is required")
  .refine(
    (value) => /^mysql:\/\//i.test(value),
    "DATABASE_URL must be a MySQL/MariaDB URL (mysql://user:password@host:port/database)",
  );

const filePath = (label: string) =>
  z
    .string()
    .min(1, `${label} is required`)
    .refine((value) => value.trim().length > 0, `${label} must not be blank`);

export const envSchema = z.strictObject({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().min(1).default("127.0.0.1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: mysqlUrl,
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
  /** Development-only embedded fake rail provider. */
  FAKE_RAILS_ENABLED: booleanFromEnvironment.default(false),
  FAKE_RAILS_BIND_HOST: z.string().min(1).max(64).default("127.0.0.1"),
  FAKE_RAILS_PORT: z.coerce.number().int().min(1).max(65535).default(4300),
  FAKE_RAILS_BASE_URL: z.string().min(1).max(500).default("http://127.0.0.1:4300"),
  FAKE_RAILS_ALLOWED_HOSTS: z.string().max(500).default("127.0.0.1"),
  FAKE_RAILS_ALLOW_PRIVATE_NETWORK: booleanFromEnvironment.default(false),
  FAKE_RAILS_ALLOW_HTTP: booleanFromEnvironment.default(false),
  FAKE_RAILS_API_KEY: z.string().max(256).optional(),
  FAKE_RAILS_HMAC_SECRET: z.string().max(256).optional(),
  FAKE_RAILS_SCENARIO_PROFILE: z.enum(["happy", "mixed", "chaos"]).default("mixed"),
  FAKE_RAILS_PUBLIC_BASE_URL: z.string().max(500).optional(),
  FAKE_RAILS_ALLOW_PRODUCTION: booleanFromEnvironment.default(false),
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

const parseEnvironment = (): { ok: true; data: CoreEnv } | { ok: false; issues: string[] } => {
  const result = envSchema.safeParse(readEnvironment());
  if (result.success) {
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
    DATABASE_URL: "mysql://admin:admin@127.0.0.1:3306/payment_gateway_monolith",
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
    WORKER_RETENTION_ENABLED: false,
    WORKER_RETENTION_INTERVAL_MS: 3_600_000,
    WORKER_RETENTION_BATCH_SIZE: 500,
    RETENTION_DRY_RUN: false,
    WORKER_BACKGROUND_JOBS_ENABLED: true,
    WORKER_BACKGROUND_JOBS_INTERVAL_MS: 2000,
    WORKER_BACKGROUND_JOBS_BATCH_SIZE: 10,
    WORKER_BACKGROUND_JOBS_LEASE_SECONDS: 300,
    WORKER_BACKGROUND_JOBS_MAX_QUEUE_AGE_MS: 300_000,
    NOTIFICATION_WEBHOOK_URL: undefined,
    NOTIFICATION_WEBHOOK_TIMEOUT_MS: 5000,
    FAKE_RAILS_ENABLED: false,
    FAKE_RAILS_BIND_HOST: "127.0.0.1",
    FAKE_RAILS_PORT: 4300,
    FAKE_RAILS_BASE_URL: "http://127.0.0.1:4300",
    FAKE_RAILS_ALLOWED_HOSTS: "127.0.0.1",
    FAKE_RAILS_ALLOW_PRIVATE_NETWORK: false,
    FAKE_RAILS_ALLOW_HTTP: false,
    FAKE_RAILS_API_KEY: undefined,
    FAKE_RAILS_HMAC_SECRET: undefined,
    FAKE_RAILS_SCENARIO_PROFILE: "mixed",
    FAKE_RAILS_PUBLIC_BASE_URL: undefined,
    FAKE_RAILS_ALLOW_PRODUCTION: false,
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
