import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PrismaLike } from "../db/ports";
import type { MonitorCheckResult, MonitorFinding, MonitorPriority, PlatformMonitorCheck } from "./PlatformMonitorWorker";

/**
 * The built-in platform checks of AUTO-03. Each one is a small factory that
 * returns a `PlatformMonitorCheck`; the worker evaluates whatever list it is
 * given. All SQL is raw, bounded (LIMIT / index-backed ORDER BY) and read-only.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatAge = (ms: number): string => {
  if (ms < 120_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 2 * 60 * 60 * 1000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 2 * DAY_MS) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / DAY_MS).toFixed(1)} days`;
};

const queryRows = async <T>(db: PrismaLike, sql: string, ...values: unknown[]): Promise<T[]> =>
  ((await db.$queryRawUnsafe(sql, ...values)) ?? []) as T[];

/** Worker with no success for `multiplier` x its interval (default 3x). */
export const workerStalenessCheck = (options: {
  multiplier?: number;
  /** Worker names that are never checked. */
  ignore?: string[];
  priority?: MonitorPriority;
} = {}): PlatformMonitorCheck => {
  const multiplier = options.multiplier ?? 3;
  const ignore = new Set(options.ignore ?? []);
  return {
    id: "worker_stale",
    run: async ({ now, registry }) => {
      const findings: MonitorFinding[] = [];
      for (const record of registry.records()) {
        if (ignore.has(record.name) || !record.running || record.intervalMs <= 0) continue;
        // A singleton led by another node does not tick here; the in-process registry cannot judge it.
        if (record.singleton && record.leader === false) continue;
        const reference = record.lastSuccessAt ?? record.startedAt ?? record.registeredAt;
        const age = now.getTime() - reference;
        const limit = record.intervalMs * multiplier;
        if (age > limit) {
          findings.push({
            key: record.name,
            title: "Worker has stopped succeeding",
            detail:
              `${record.name} has had no successful tick for ${formatAge(age)} (interval ${formatAge(record.intervalMs)}, ` +
              `limit ${multiplier}x)` +
              (record.lastError ? `; last error: ${record.lastError}` : "") +
              `; consecutive failures ${record.consecutiveFailures}.`,
            priority: options.priority ?? "P1",
          });
        }
      }
      return findings;
    },
  };
};

/**
 * Per-shard checkpoint staleness: a shard with lines above its checkpoint
 * whose checkpoint is older than `maxAgeMs * graceFactor`. The checkpointer
 * normally advances such a shard within `maxAgeMs` plus one interval, so the
 * grace factor (default 2) keeps routine lag from tripping. Shards whose proof
 * failed (status <> OK) already have their own ledger case and are excluded.
 */
export const checkpointStalenessCheck = (options: {
  maxAgeMs: number;
  graceFactor?: number;
  limit?: number;
  priority?: MonitorPriority;
}): PlatformMonitorCheck => {
  const thresholdMs = options.maxAgeMs * (options.graceFactor ?? 2);
  const limit = options.limit ?? 100;
  return {
    id: "checkpoint_stale",
    run: async ({ now, db }): Promise<MonitorCheckResult> => {
      const rows = await queryRows<{ id: string; shard_id: number; pending: string; reference_at: unknown }>(
        db,
        `SELECT s.gl_account_id::text AS id, s.shard_id,
                (s.line_seq - COALESCE(c.checkpoint_seq, 0))::text AS pending,
                COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) AS reference_at
         FROM gl_account_shards s
         LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id
         WHERE s.line_seq > COALESCE(c.checkpoint_seq, 0)
           AND COALESCE(c.status, 'OK') = 'OK'
           AND COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) < $1::timestamptz
         ORDER BY COALESCE(c.checkpoint_at, c.verified_at, s.updated_at) ASC
         LIMIT $2::int`,
        new Date(now.getTime() - thresholdMs),
        limit,
      );
      const findings = rows.map((row): MonitorFinding => {
        const reference = toDate(row.reference_at);
        const age = reference ? now.getTime() - reference.getTime() : thresholdMs;
        return {
          key: `${row.id}:${Number(row.shard_id)}`,
          title: "Ledger checkpoint is stale",
          detail:
            `Shard ${Number(row.shard_id)} of GL account ${row.id} has ${row.pending} lines above a checkpoint that is ` +
            `${formatAge(age)} old (limit ${formatAge(thresholdMs)}).`,
          priority: options.priority ?? "P2",
        };
      });
      return { findings, complete: rows.length < limit };
    },
  };
};

/** Oldest pending row of a queue table older than `maxAgeMs`. */
const oldestPendingCheck = (spec: {
  id: string;
  title: string;
  label: string;
  sql: string;
  maxAgeMs: number;
  priority: MonitorPriority;
}): PlatformMonitorCheck => ({
  id: spec.id,
  run: async ({ now, db }) => {
    const rows = await queryRows<{ oldest_at: unknown }>(db, spec.sql);
    const oldest = toDate(rows[0]?.oldest_at);
    if (!oldest) return [];
    const age = now.getTime() - oldest.getTime();
    if (age <= spec.maxAgeMs) return [];
    return [{
      title: spec.title,
      detail: `The oldest pending ${spec.label} is ${formatAge(age)} old (limit ${formatAge(spec.maxAgeMs)}).`,
      priority: spec.priority,
    }];
  },
});

/**
 * Transactional outbox (`outbox_events`) oldest unprocessed event.
 * Index-backed by the partial `outbox_events_unprocessed_idx` (id WHERE processed_at IS NULL).
 */
export const outboxAgeCheck = (options: { maxAgeMs: number; priority?: MonitorPriority }): PlatformMonitorCheck =>
  oldestPendingCheck({
    id: "outbox_age",
    title: "Outbox relay is behind",
    label: "outbox event",
    sql: `SELECT created_at AS oldest_at FROM outbox_events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 1`,
    maxAgeMs: options.maxAgeMs,
    priority: options.priority ?? "P1",
  });

/**
 * Audit outbox (`audit_outbox`) oldest unshipped row. Only meaningful when the
 * dedicated audit database shipper runs. Index-backed by `audit_outbox_unshipped_idx`.
 */
export const auditOutboxAgeCheck = (options: { maxAgeMs: number; priority?: MonitorPriority }): PlatformMonitorCheck =>
  oldestPendingCheck({
    id: "audit_outbox_age",
    title: "Audit shipper is behind",
    label: "audit outbox row",
    sql: `SELECT created_at AS oldest_at FROM audit_outbox WHERE shipped_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1`,
    maxAgeMs: options.maxAgeMs,
    priority: options.priority ?? "P1",
  });

/**
 * Background job queue: the oldest QUEUED job that is due (`available_at <= now`).
 * Age is measured from `available_at`, so a job deliberately delayed by a retry
 * backoff is not counted until it is due. Index-backed by (state, available_at).
 */
export const backgroundJobQueueAgeCheck = (options: { maxAgeMs: number; priority?: MonitorPriority }): PlatformMonitorCheck => ({
  id: "background_job_age",
  run: async ({ now, db }) => {
    const rows = await queryRows<{ oldest_at: unknown }>(
      db,
      `SELECT available_at AS oldest_at FROM background_jobs
       WHERE state = 'QUEUED' AND available_at <= $1::timestamptz
       ORDER BY available_at ASC LIMIT 1`,
      now,
    );
    const oldest = toDate(rows[0]?.oldest_at);
    if (!oldest) return [];
    const age = now.getTime() - oldest.getTime();
    if (age <= options.maxAgeMs) return [];
    return [{
      title: "Background job queue is not draining",
      detail: `The oldest due background job has waited ${formatAge(age)} (limit ${formatAge(options.maxAgeMs)}).`,
      priority: options.priority ?? "P1",
    }];
  },
});

/**
 * AUTO-06: KYB documents that sit in PENDING for longer than `maxAgeMs`. Reviewers cannot open a PENDING document, so a
 * dead or unreachable scanner shows up here (the scan worker itself fails closed and keeps retrying).
 */
export const kybScanBacklogCheck = (options: { maxAgeMs: number; priority?: MonitorPriority }): PlatformMonitorCheck => ({
  id: "kyb_scan_backlog",
  run: async ({ now, db }) => {
    const cutoff = new Date(now.getTime() - options.maxAgeMs);
    const rows = await queryRows<{ n: unknown; oldest_at: unknown }>(
      db,
      `SELECT count(*)::int AS n, min(created_at) AS oldest_at FROM kyb_documents
       WHERE av_status = 'PENDING' AND status = 'UPLOADED' AND created_at < $1`,
      cutoff,
    );
    const count = Number(rows[0]?.n ?? 0);
    if (count === 0) return [];
    const oldest = toDate(rows[0]?.oldest_at);
    return [{
      title: "KYB documents are waiting for a malware scan",
      detail:
        `${count} uploaded KYB document(s) have been PENDING for more than ${formatAge(options.maxAgeMs)}`
        + `${oldest ? ` (oldest ${formatAge(now.getTime() - oldest.getTime())})` : ""}. Reviewers cannot open them until a scan succeeds: check the scanner (clamd) and the KybScanWorker.`,
      priority: options.priority ?? "P2",
    }];
  },
});

/**
 * Rows in `journal_lines_default` (the catch-all partition): a missing monthly
 * partition. Counts at most `cap` rows so the probe stays cheap. A database
 * without the partition (not partitioned) reports nothing.
 */
export const journalDefaultPartitionCheck = (options: { cap?: number; priority?: MonitorPriority } = {}): PlatformMonitorCheck => {
  const cap = options.cap ?? 1000;
  return {
    id: "journal_default_rows",
    run: async ({ db }) => {
      let rows: Array<{ n: unknown }>;
      try {
        rows = await queryRows<{ n: unknown }>(
          db,
          `SELECT count(*)::int AS n FROM (SELECT 1 FROM journal_lines_default LIMIT $1::int) AS capped`,
          cap,
        );
      } catch (error) {
        const code = (error as { code?: unknown; meta?: { code?: unknown } })?.code;
        const metaCode = (error as { meta?: { code?: unknown } })?.meta?.code;
        if (code === "42P01" || metaCode === "42P01" || /journal_lines_default.*does not exist/i.test(String((error as Error)?.message))) {
          return [];
        }
        throw error;
      }
      const count = Number(rows[0]?.n ?? 0);
      if (!(count > 0)) return [];
      return [{
        title: "Journal lines in the default partition",
        detail:
          `${count >= cap ? `At least ${cap}` : count} journal line(s) landed in journal_lines_default: a monthly partition ` +
          `is missing and creating it later will fail until the rows are moved.`,
        priority: options.priority ?? "P1",
      }];
    },
  };
};

export interface CertificateFile {
  /** Short stable label used in the case key, e.g. `mtls_server`. */
  label: string;
  path: string;
}

/** Reads the `validTo` of the first certificate of a PEM file. */
export const readCertificateValidTo = (path: string): Date => {
  const pem = readFileSync(path);
  const certificate = new X509Certificate(pem);
  const validTo = new Date(certificate.validTo);
  if (Number.isNaN(validTo.getTime())) {
    throw new Error("certificate has no parsable validTo");
  }
  return validTo;
};

/**
 * Certificate expiry within `warnWithinMs` (default 30 days) for every
 * configured PEM file (mTLS server/CA/client, PostgreSQL). An unreadable file
 * is a finding too (P2), keyed separately from the expiry finding.
 */
export const certificateExpiryCheck = (options: {
  files: CertificateFile[];
  warnWithinMs?: number;
  readValidTo?: (path: string) => Date | Promise<Date>;
  priority?: MonitorPriority;
}): PlatformMonitorCheck => {
  const warnWithinMs = options.warnWithinMs ?? 30 * DAY_MS;
  const read = options.readValidTo ?? readCertificateValidTo;
  return {
    id: "cert_expiry",
    run: async ({ now }) => {
      const findings: MonitorFinding[] = [];
      for (const file of options.files) {
        let validTo: Date;
        try {
          validTo = await read(file.path);
        } catch (error) {
          findings.push({
            key: `${file.label}:unreadable`,
            title: "Certificate cannot be read",
            detail: `The ${file.label} certificate at ${file.path} cannot be read: ${(error as Error)?.message ?? "unknown error"}.`,
            priority: "P2",
          });
          continue;
        }
        const remaining = validTo.getTime() - now.getTime();
        if (remaining <= warnWithinMs) {
          findings.push({
            key: file.label,
            title: remaining <= 0 ? "Certificate expired" : "Certificate expires soon",
            detail:
              remaining <= 0
                ? `The ${file.label} certificate (${file.path}) expired at ${validTo.toISOString()}.`
                : `The ${file.label} certificate (${file.path}) expires at ${validTo.toISOString()}, in ${formatAge(remaining)}.`,
            priority: options.priority ?? "P1",
          });
        }
      }
      return findings;
    },
  };
};

/**
 * Redis reachability through an injected probe (for example a `PING` on the
 * invalidation-bus client). The probe fails by throwing, returning `false`, or
 * not answering within `timeoutMs`.
 */
export const redisReachabilityCheck = (options: {
  probe: () => Promise<unknown>;
  timeoutMs?: number;
  priority?: MonitorPriority;
}): PlatformMonitorCheck => {
  const timeoutMs = options.timeoutMs ?? 2_000;
  return {
    id: "redis_unreachable",
    run: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          options.probe(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
          }),
        ]);
        if (result === false) throw new Error("probe reported unreachable");
        return [];
      } catch (error) {
        return [{
          title: "Redis is unreachable",
          detail: `The Redis probe failed: ${(error as Error)?.message ?? "unknown error"}.`,
          priority: options.priority ?? "P2",
        }];
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
};

export interface StandardPlatformChecksConfig {
  /** Worker staleness multiplier (default 3). */
  workerStaleMultiplier?: number;
  workerStaleIgnore?: string[];
  /** `LEDGER_CHECKPOINT_MAX_AGE_MS`; omit to skip the checkpoint check (checkpointer disabled). */
  checkpointMaxAgeMs?: number;
  checkpointGraceFactor?: number;
  /** Omit to skip. */
  outboxMaxAgeMs?: number;
  /** Omit to skip (no dedicated audit database shipper). */
  auditOutboxMaxAgeMs?: number;
  /** Omit to skip. */
  backgroundJobMaxAgeMs?: number;
  /** Omit to skip (no scanner configured). */
  kybScanBacklogMaxAgeMs?: number;
  /** Default true. */
  journalDefaultPartition?: boolean;
  /** PEM files to watch; empty or omitted skips the check. */
  certificateFiles?: CertificateFile[];
  certificateWarnWithinMs?: number;
  /** Omit to skip the Redis check (no Redis configured). */
  redisProbe?: () => Promise<unknown>;
  redisTimeoutMs?: number;
}

/** Builds the AUTO-03 phase-1 check list from configuration (no env reads). */
export const createStandardPlatformChecks = (config: StandardPlatformChecksConfig): PlatformMonitorCheck[] => {
  const checks: PlatformMonitorCheck[] = [
    workerStalenessCheck({ multiplier: config.workerStaleMultiplier, ignore: config.workerStaleIgnore }),
  ];
  if (config.checkpointMaxAgeMs !== undefined) {
    checks.push(checkpointStalenessCheck({ maxAgeMs: config.checkpointMaxAgeMs, graceFactor: config.checkpointGraceFactor }));
  }
  if (config.outboxMaxAgeMs !== undefined) checks.push(outboxAgeCheck({ maxAgeMs: config.outboxMaxAgeMs }));
  if (config.auditOutboxMaxAgeMs !== undefined) checks.push(auditOutboxAgeCheck({ maxAgeMs: config.auditOutboxMaxAgeMs }));
  if (config.backgroundJobMaxAgeMs !== undefined) {
    checks.push(backgroundJobQueueAgeCheck({ maxAgeMs: config.backgroundJobMaxAgeMs }));
  }
  if (config.kybScanBacklogMaxAgeMs !== undefined) checks.push(kybScanBacklogCheck({ maxAgeMs: config.kybScanBacklogMaxAgeMs }));
  if (config.journalDefaultPartition !== false) checks.push(journalDefaultPartitionCheck());
  if (config.certificateFiles && config.certificateFiles.length > 0) {
    checks.push(certificateExpiryCheck({ files: config.certificateFiles, warnWithinMs: config.certificateWarnWithinMs }));
  }
  if (config.redisProbe) checks.push(redisReachabilityCheck({ probe: config.redisProbe, timeoutMs: config.redisTimeoutMs }));
  return checks;
};
