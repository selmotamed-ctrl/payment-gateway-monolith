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
  /**
   * Honest label for the report-engine read-only pool. Set to `replica` only
   * when REPORT_READONLY_DATABASE_URL really points at a physical replica.
   */
  REPORT_READONLY_SERVED_BY: z.enum(["replica", "primary-readonly-tx"]).default("primary-readonly-tx"),
  /** Optional dedicated read-only pool for the merchant reporting line (E05). */
  REPORT_MERCHANT_READONLY_DATABASE_URL: optionalPostgresUrl("REPORT_MERCHANT_READONLY_DATABASE_URL"),
  MERCHANT_REPORT_EXECUTE_PER_HOUR: z.coerce.number().int().positive().default(60),
  MERCHANT_REPORT_VERIFY_PER_HOUR: z.coerce.number().int().positive().default(30),
  MERCHANT_REPORT_DAILY_DB_TIME_MS: z.coerce.number().int().positive().default(600_000),
  MERCHANT_REPORT_MAX_CODES: z.coerce.number().int().positive().default(50),
  MERCHANT_REPORT_MAX_VERSIONS_PER_CODE: z.coerce.number().int().positive().default(20),
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
   * The KYB scan worker (AUTO-06): scans PENDING documents with the engine `KYB_SCANNER_MODE` selects (`clamd`,
   * `eicar` for development, anything else = no scanner, documents stay PENDING) and re-scans CLEAN ones.
   */
  WORKER_KYB_SCAN_ENABLED: booleanFromEnvironment.default(true),
  WORKER_KYB_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_KYB_SCAN_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(20),
  /** AUTO-07: statement schedule alerts. */
  WORKER_STATEMENT_SCHEDULE_ENABLED: booleanFromEnvironment.default(true),
  WORKER_STATEMENT_SCHEDULE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  STATEMENT_SCHEDULE_GRACE_MINUTES: z.coerce.number().int().min(0).max(10_080).default(120),
  STATEMENT_SCHEDULE_LOOKBACK_SLOTS: z.coerce.number().int().min(1).max(60).default(7),
  /** AUTO-12: slot counter consistency audit (report only unless repair is on). */
  WORKER_CONSISTENCY_AUDIT_ENABLED: booleanFromEnvironment.default(true),
  WORKER_CONSISTENCY_AUDIT_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  CONSISTENCY_AUDIT_REPAIR: booleanFromEnvironment.default(false),
  /** AUTO-34: outbound merchant webhooks (delivery worker, egress and failure policy). */
  WORKER_MERCHANT_WEBHOOK_ENABLED: booleanFromEnvironment.default(true),
  WORKER_MERCHANT_WEBHOOK_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_MERCHANT_WEBHOOK_BATCH_SIZE: z.coerce.number().int().positive().max(1000).default(50),
  MERCHANT_WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
  MERCHANT_WEBHOOK_CONCURRENCY: z.coerce.number().int().positive().max(100).default(8),
  /** Allows http:// and private destinations (development and Fake Rails labs only). */
  MERCHANT_WEBHOOK_ALLOW_INSECURE: booleanFromEnvironment.default(false),
  /** An endpoint that fails continuously this long is disabled and the merchant told. */
  MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS: z.coerce.number().int().min(1).max(60).default(5),
  /** How long the previous signing secret keeps working after a rotation. */
  MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** AUTO-16: drafts the scheduled regulatory returns (draft only; a person files). */
  WORKER_REGULATORY_REPORT_ENABLED: booleanFromEnvironment.default(true),
  WORKER_REGULATORY_REPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  /** Closed periods considered per scheduled return per tick (catch-up depth). */
  REGULATORY_REPORT_MAX_PERIODS: z.coerce.number().int().min(1).max(24).default(2),
  /** Lines one large-transaction batch carries before it is marked truncated. */
  REGULATORY_REPORT_MAX_BATCH_LINES: z.coerce.number().int().positive().max(100_000).default(5000),
  /** Business days before a report's due date at which the filers are reminded. */
  REGULATORY_REPORT_REMINDER_BUSINESS_DAYS: z.coerce.number().int().min(0).max(30).default(3),
  /** AUTO-27: daily verification of the live audit hash chain with a signed anchor (dedicated audit database only). */
  WORKER_AUDIT_ANCHOR_ENABLED: booleanFromEnvironment.default(true),
  WORKER_AUDIT_ANCHOR_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  AUDIT_ANCHOR_SEGMENT_ROWS: z.coerce.number().int().positive().max(100_000).default(5000),
  AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK: z.coerce.number().int().positive().max(1000).default(40),
  AUDIT_ANCHOR_KEY_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).default("audit-anchor-v1"),
  /** AUTO-27: a PASSED full backup must exist within this window / a restore drill within the second. */
  PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS: z.coerce.number().int().positive().default(36 * 60 * 60 * 1000),
  PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS: z.coerce.number().int().positive().default(8 * 24 * 60 * 60 * 1000),
  KYB_SCANNER_MODE: z.string().optional(),
  /** `clamd` endpoint: a Unix socket path (`/run/clamav/clamd.ctl`) or `host:port`. */
  KYB_CLAMD_ADDRESS: z.string().optional(),
  KYB_CLAMD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** CLEAN documents are re-scanned after this many days (0 = never). */
  KYB_RESCAN_DAYS: z.coerce.number().int().min(0).default(30),
  /** Failed attempts after which a P2 case is opened (retries continue with backoff). */
  KYB_SCAN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  /** A PENDING document older than this raises the `kyb_scan_backlog` monitor finding. */
  PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS: z.coerce.number().int().positive().default(2 * 60 * 60 * 1000),
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
   * The platform monitor (AUTO-03) evaluates the health of the platform every minute on the cluster leader (worker
   * staleness, checkpoint, outbox, audit outbox and job queue age, the default journal partition, certificate expiry,
   * Redis, stale UNKNOWN attempts, refunds without a follow-up) and opens ONE keyed operator case per condition.
   */
  WORKER_PLATFORM_MONITOR_ENABLED: booleanFromEnvironment.default(true),
  WORKER_PLATFORM_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** A worker with no successful tick for this many intervals is reported. */
  PLATFORM_MONITOR_WORKER_STALE_MULTIPLIER: z.coerce.number().positive().default(3),
  /** Oldest unprocessed `outbox_events` row tolerated before the relay is reported as behind (milliseconds). */
  PLATFORM_MONITOR_OUTBOX_MAX_AGE_MS: z.coerce.number().int().positive().default(300_000),
  /** Oldest unshipped `audit_outbox` row tolerated before the audit shipper is reported as behind (milliseconds). */
  PLATFORM_MONITOR_AUDIT_OUTBOX_MAX_AGE_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * PEM files whose expiry is watched, as `label=path` pairs separated by commas. Empty: the mTLS server, CA and
   * backup-client certificate paths that are configured are watched.
   */
  PLATFORM_MONITOR_CERT_FILES: z.string().default(""),
  /** A certificate that expires within this many days is reported (P1). */
  PLATFORM_MONITOR_CERT_WARN_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Failed deliveries after which a transactional-outbox event is parked (AUTO-02). A parked event stops blocking the
   * relay, keeps its last error, and opens one operator case per topic.
   */
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  /**
   * Journal partition maintenance (AUTO-01): keeps the next N monthly `journal_lines` partitions in existence by calling
   * the same database function the deploy cron calls, and raises a most-urgent case while rows sit in the default
   * partition.
   */
  WORKER_JOURNAL_PARTITION_ENABLED: booleanFromEnvironment.default(true),
  WORKER_JOURNAL_PARTITION_INTERVAL_MS: z.coerce.number().int().positive().default(6 * 60 * 60 * 1000),
  /** Months (counting the current one) that must exist ahead of the clock. */
  LEDGER_PARTITION_MONTHS_AHEAD: z.coerce.number().int().min(1).max(60).default(6),
  /**
   * Expiry housekeeping (AUTO-05, AUTO-11): closes approval requests that nobody decided, revokes expired staff
   * invitations, expires payment links, deletes old MFA challenges and session revocations, and removes the sealed
   * MFA code / invitation token from finished notifications.
   */
  WORKER_EXPIRY_HOUSEKEEPING_ENABLED: booleanFromEnvironment.default(true),
  WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  WORKER_EXPIRY_HOUSEKEEPING_BATCH_SIZE: z.coerce.number().int().positive().max(5000).default(200),
  /** Hours an MFA challenge is kept after it was consumed or expired. */
  MFA_CHALLENGE_RETENTION_HOURS: z.coerce.number().positive().default(24),
  /** Minutes a finished notification keeps its sealed MFA code / invitation token. */
  NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES: z.coerce.number().positive().default(60),
  /**
   * SLA and deadline escalation (AUTO-04) and unratified emergency actions (AUTO-22): reminders, escalation cases and
   * deadline outcomes for operator cases, AML cases, join requests, disputes, cash-outs and emergency approvals.
   */
  WORKER_DEADLINE_ENABLED: booleanFromEnvironment.default(true),
  WORKER_DEADLINE_INTERVAL_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
  WORKER_DEADLINE_BATCH_SIZE: z.coerce.number().int().positive().max(2000).default(100),
  /** Reminder lead of operator and AML cases (minutes) and of join requests (hours). */
  DEADLINE_CASE_REMINDER_LEAD_MINUTES: z.coerce.number().int().positive().default(60),
  DEADLINE_JOIN_REMINDER_LEAD_HOURS: z.coerce.number().int().positive().default(24),
  /** Only deadlines of the last N hours are acted on: a first run never floods staff with years of old items. */
  DEADLINE_CATCHUP_HOURS: z.coerce.number().int().positive().default(72),
  /** SLA of the cases the deadline rules open (hours). */
  DEADLINE_CASE_SLA_HOURS: z.coerce.number().positive().default(24),
  /** Dispute evidence reminders (hours before the deadline, comma separated) and the provider ruling SLA (days). */
  DISPUTE_REMINDER_HOURS: z.string().default("72,24"),
  DISPUTE_RULING_SLA_DAYS: z.coerce.number().positive().default(30),
  /** Days a merchant has to answer a dispute when the rail declares no window of its own (`capabilities.dispute_evidence_days`). */
  DISPUTE_EVIDENCE_WINDOW_DAYS: z.coerce.number().positive().default(14),
  /** Cash-out operator window in Libyan business hours (decision D2) and the reminder fraction. */
  CASHOUT_SLA_BUSINESS_HOURS: z.coerce.number().positive().default(24),
  CASHOUT_SLA_REMINDER_RATIO: z.coerce.number().gt(0).lt(1).default(0.75),
  /** Emergency ratification (decision D7): grace after the deadline, escalation period, reminders (hours before). */
  EMERGENCY_RATIFICATION_GRACE_HOURS: z.coerce.number().positive().default(48),
  EMERGENCY_ESCALATE_EVERY_HOURS: z.coerce.number().positive().default(4),
  EMERGENCY_REMINDER_HOURS: z.string().default("4,1"),
  /**
   * Token and credential expiry (AUTO-08) and scheduled credential re-verification (AUTO-26): notices 30, 7 and 1 days
   * before an API token or a gateway credential set expires, a P1 case close to the expiry, and taking an expired set
   * out of use. Re-verification calls the gateway, so it starts as a dry run.
   */
  WORKER_EXPIRY_NOTICE_ENABLED: booleanFromEnvironment.default(true),
  WORKER_EXPIRY_NOTICE_INTERVAL_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
  TOKEN_EXPIRY_NOTICE_DAYS: z.string().default("30,7,1"),
  CREDENTIAL_EXPIRY_NOTICE_DAYS: z.string().default("30,7,1"),
  CREDENTIAL_EXPIRY_CASE_DAYS: z.coerce.number().int().positive().default(7),
  /** Re-verify VERIFIED credential sets not verified for this many hours (0 turns it off). */
  CREDENTIAL_REVERIFY_AFTER_HOURS: z.coerce.number().min(0).default(24),
  CREDENTIAL_REVERIFY_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(5),
  CREDENTIAL_REVERIFY_DRY_RUN: booleanFromEnvironment.default(true),
  /**
   * Merchant-direct commission netting (AUTO-21, decision D8): a singleton job after the Tripoli day close nets the
   * commission receivable against the merchant wallet (partial, carried forward, never below zero). It is state
   * changing, so it starts as a DRY RUN that only audits what it would net (COMMISSION_NETTING_PROPOSED).
   */
  WORKER_COMMISSION_NETTING_ENABLED: booleanFromEnvironment.default(true),
  WORKER_COMMISSION_NETTING_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  COMMISSION_NETTING_DRY_RUN: booleanFromEnvironment.default(true),
  /** Daily run time as `M H * * *` in Africa/Tripoli. */
  COMMISSION_NETTING_CRON: z.string().trim().min(1).default("30 0 * * *"),
  /** Receivable older than this many days opens a finance case. */
  COMMISSION_RECEIVABLE_AGING_DAYS: z.coerce.number().int().positive().default(30),
  /** Net the receivable at cash-out time, before a cash-out is paid (decision D8). */
  COMMISSION_NETTING_AT_CASHOUT: booleanFromEnvironment.default(true),
  /**
   * Refund inquiry (AUTO-20): a refund stuck in EXECUTING is asked about again with backoff. In dry run a definitive
   * answer is audited and handed to an operator case instead of booking or rejecting the refund.
   */
  REFUND_INQUIRY_DRY_RUN: booleanFromEnvironment.default(true),
  /** How long the gateway is asked about a refund before an operator takes over (seconds). */
  REFUND_INQUIRY_WINDOW_SECONDS: z.coerce.number().int().positive().default(86_400),
  /** SLA of the operator case opened for an UNKNOWN attempt whose polling window elapsed (AUTO-19), in hours. */
  UNKNOWN_ATTEMPT_CASE_SLA_HOURS: z.coerce.number().positive().default(24),
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
    REPORT_READONLY_SERVED_BY: "primary-readonly-tx",
    REPORT_MERCHANT_READONLY_DATABASE_URL: undefined,
    MERCHANT_REPORT_EXECUTE_PER_HOUR: 60,
    MERCHANT_REPORT_VERIFY_PER_HOUR: 30,
    MERCHANT_REPORT_DAILY_DB_TIME_MS: 600_000,
    MERCHANT_REPORT_MAX_CODES: 50,
    MERCHANT_REPORT_MAX_VERSIONS_PER_CODE: 20,
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
    WORKER_KYB_SCAN_ENABLED: true,
    WORKER_KYB_SCAN_INTERVAL_MS: 60_000,
    WORKER_KYB_SCAN_BATCH_SIZE: 20,
    WORKER_STATEMENT_SCHEDULE_ENABLED: true,
    WORKER_STATEMENT_SCHEDULE_INTERVAL_MS: 300_000,
    STATEMENT_SCHEDULE_GRACE_MINUTES: 120,
    STATEMENT_SCHEDULE_LOOKBACK_SLOTS: 7,
    WORKER_CONSISTENCY_AUDIT_ENABLED: true,
    WORKER_CONSISTENCY_AUDIT_INTERVAL_MS: 3_600_000,
    CONSISTENCY_AUDIT_REPAIR: false,
    WORKER_MERCHANT_WEBHOOK_ENABLED: true,
    WORKER_MERCHANT_WEBHOOK_INTERVAL_MS: 2000,
    WORKER_MERCHANT_WEBHOOK_BATCH_SIZE: 50,
    MERCHANT_WEBHOOK_TIMEOUT_MS: 10_000,
    MERCHANT_WEBHOOK_CONCURRENCY: 8,
    MERCHANT_WEBHOOK_ALLOW_INSECURE: false,
    MERCHANT_WEBHOOK_DISABLE_AFTER_DAYS: 5,
    MERCHANT_WEBHOOK_ROTATION_OVERLAP_HOURS: 24,
    WORKER_REGULATORY_REPORT_ENABLED: true,
    WORKER_REGULATORY_REPORT_INTERVAL_MS: 3_600_000,
    REGULATORY_REPORT_MAX_PERIODS: 2,
    REGULATORY_REPORT_MAX_BATCH_LINES: 5000,
    REGULATORY_REPORT_REMINDER_BUSINESS_DAYS: 3,
    WORKER_AUDIT_ANCHOR_ENABLED: true,
    WORKER_AUDIT_ANCHOR_INTERVAL_MS: 86_400_000,
    AUDIT_ANCHOR_SEGMENT_ROWS: 5000,
    AUDIT_ANCHOR_MAX_SEGMENTS_PER_TICK: 40,
    AUDIT_ANCHOR_KEY_ID: "audit-anchor-v1",
    PLATFORM_MONITOR_BACKUP_MAX_FULL_AGE_MS: 129_600_000,
    PLATFORM_MONITOR_BACKUP_DRILL_MAX_AGE_MS: 691_200_000,
    KYB_SCANNER_MODE: undefined,
    KYB_CLAMD_ADDRESS: undefined,
    KYB_CLAMD_TIMEOUT_MS: 30_000,
    KYB_RESCAN_DAYS: 30,
    KYB_SCAN_MAX_ATTEMPTS: 8,
    PLATFORM_MONITOR_KYB_SCAN_MAX_AGE_MS: 7_200_000,
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
    WORKER_PLATFORM_MONITOR_ENABLED: true,
    WORKER_PLATFORM_MONITOR_INTERVAL_MS: 60_000,
    PLATFORM_MONITOR_WORKER_STALE_MULTIPLIER: 3,
    PLATFORM_MONITOR_OUTBOX_MAX_AGE_MS: 300_000,
    PLATFORM_MONITOR_AUDIT_OUTBOX_MAX_AGE_MS: 300_000,
    PLATFORM_MONITOR_CERT_FILES: "",
    PLATFORM_MONITOR_CERT_WARN_DAYS: 30,
    OUTBOX_MAX_ATTEMPTS: 10,
    WORKER_JOURNAL_PARTITION_ENABLED: true,
    WORKER_JOURNAL_PARTITION_INTERVAL_MS: 21_600_000,
    LEDGER_PARTITION_MONTHS_AHEAD: 6,
    WORKER_EXPIRY_HOUSEKEEPING_ENABLED: true,
    WORKER_EXPIRY_HOUSEKEEPING_INTERVAL_MS: 900_000,
    WORKER_EXPIRY_HOUSEKEEPING_BATCH_SIZE: 200,
    MFA_CHALLENGE_RETENTION_HOURS: 24,
    NOTIFICATION_SECRET_SCRUB_AFTER_MINUTES: 60,
    WORKER_DEADLINE_ENABLED: true,
    WORKER_DEADLINE_INTERVAL_MS: 300_000,
    WORKER_DEADLINE_BATCH_SIZE: 100,
    DEADLINE_CASE_REMINDER_LEAD_MINUTES: 60,
    DEADLINE_JOIN_REMINDER_LEAD_HOURS: 24,
    DEADLINE_CATCHUP_HOURS: 72,
    DEADLINE_CASE_SLA_HOURS: 24,
    DISPUTE_REMINDER_HOURS: "72,24",
    DISPUTE_RULING_SLA_DAYS: 30,
    DISPUTE_EVIDENCE_WINDOW_DAYS: 14,
    CASHOUT_SLA_BUSINESS_HOURS: 24,
    CASHOUT_SLA_REMINDER_RATIO: 0.75,
    EMERGENCY_RATIFICATION_GRACE_HOURS: 48,
    EMERGENCY_ESCALATE_EVERY_HOURS: 4,
    EMERGENCY_REMINDER_HOURS: "4,1",
    WORKER_EXPIRY_NOTICE_ENABLED: true,
    WORKER_EXPIRY_NOTICE_INTERVAL_MS: 3_600_000,
    TOKEN_EXPIRY_NOTICE_DAYS: "30,7,1",
    CREDENTIAL_EXPIRY_NOTICE_DAYS: "30,7,1",
    CREDENTIAL_EXPIRY_CASE_DAYS: 7,
    CREDENTIAL_REVERIFY_AFTER_HOURS: 24,
    CREDENTIAL_REVERIFY_BATCH_SIZE: 5,
    CREDENTIAL_REVERIFY_DRY_RUN: true,
    WORKER_COMMISSION_NETTING_ENABLED: true,
    WORKER_COMMISSION_NETTING_INTERVAL_MS: 60_000,
    COMMISSION_NETTING_DRY_RUN: true,
    COMMISSION_NETTING_CRON: "30 0 * * *",
    COMMISSION_RECEIVABLE_AGING_DAYS: 30,
    COMMISSION_NETTING_AT_CASHOUT: true,
    REFUND_INQUIRY_DRY_RUN: true,
    REFUND_INQUIRY_WINDOW_SECONDS: 86_400,
    UNKNOWN_ATTEMPT_CASE_SLA_HOURS: 24,
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
