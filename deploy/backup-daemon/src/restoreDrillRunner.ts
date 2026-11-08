import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as nodeFs } from "node:fs";
import { join } from "node:path";
import type { BackupEngine, RecoverResult } from "./backupEngine";
import { buildPsqlCommand } from "./backupEngine";
import type { CommandResult, CommandRunner } from "./commandRunner";
import { auditEndpoint, collectSecretValues, isAuditDedicatedCluster, redactText, type BackupDaemonConfig } from "./config";

export interface DrillCheckResult {
  ok: boolean;
  detail: string;
}

export interface DrillReport {
  id: string;
  status: "PASSED" | "FAILED";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  targetTime: string;
  replayedLsn: string;
  doubleEntryDrift: string;
  balanceMismatches: number;
  auditBrokenLinks: number;
  journalLineCount: number;
  checks: {
    doubleEntry: DrillCheckResult;
    balanceParity: DrillCheckResult;
    auditChain: DrillCheckResult;
  };
  errorMessage?: string;
  reportSignature?: string;
}

export interface DrillFileSystem {
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface RestoreDrillDependencies {
  config: BackupDaemonConfig;
  engine: BackupEngine;
  runner: CommandRunner;
  fileSystem?: DrillFileSystem;
  clock?: () => Date;
  idFactory?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export interface DrillRunOptions {
  id?: string;
  requestedBy?: string;
  /** Recover to this moment instead of "now - 5 minutes". Must not be in the future. */
  targetTime?: Date;
  /** Disaster-recovery rehearsal: replay ALL available WAL instead of stopping at a time. Excludes `targetTime`. */
  latest?: boolean;
}

export const DOUBLE_ENTRY_QUERY =
  "SELECT COALESCE(SUM(CASE WHEN direction='DEBIT' THEN amount ELSE -amount END), 0)::text FROM journal_lines;";

/**
 * Per-shard ledger proof on the RESTORED database, counting the shards that fail it (0 = healthy). For every shard:
 *   * its balance equals the sum of ALL its journal lines (pre-genesis lines are shard 0, sequence 0),
 *   * its checkpoint balance equals the sum of the lines up to the checkpoint sequence, and
 *   * the number of sequenced lines above the shard's `baseline_seq` (0 unless an approved re-baseline repaired a damaged
 *     sequence) equals `line_seq - baseline_seq` (gapless, no duplicates, nothing lost).
 * This replaces the old account-level comparison against `last_checkpoint_id`, which compared a line UUID with a text
 * marker and no longer exists: the boundary of a checkpoint is the shard's own gapless sequence.
 */
export const BALANCE_PARITY_QUERY =
  "SELECT COUNT(*)::text FROM gl_account_shards s " +
  "LEFT JOIN gl_shard_checkpoints c ON c.gl_account_id = s.gl_account_id AND c.shard_id = s.shard_id " +
  "CROSS JOIN LATERAL (" +
  "SELECT COALESCE(SUM(x.signed), 0) AS total, " +
  "COALESCE(SUM(x.signed) FILTER (WHERE x.shard_seq <= COALESCE(c.checkpoint_seq, 0)), 0) AS upto_checkpoint, " +
  "COUNT(*) FILTER (WHERE x.shard_seq > COALESCE(c.baseline_seq, 0)) AS sequenced " +
  "FROM (SELECT CASE WHEN l.direction = 'DEBIT' THEN l.amount ELSE -l.amount END AS signed, l.shard_seq " +
  "FROM journal_lines l WHERE l.gl_account_id = s.gl_account_id AND l.shard_id = s.shard_id) x) j " +
  "WHERE s.current_balance <> j.total " +
  "OR COALESCE(c.checkpoint_balance, 0) <> j.upto_checkpoint " +
  "OR j.sequenced <> s.line_seq - COALESCE(c.baseline_seq, 0);";

export const JOURNAL_LINE_COUNT_QUERY = "SELECT COUNT(*)::text FROM journal_lines;";

export const REPLAYED_LSN_QUERY =
  "SELECT COALESCE(pg_last_wal_replay_lsn(), pg_current_wal_lsn())::text;";

/**
 * The audit trigger hashes `before_json::text` / `after_json::text` (JSONB text
 * form: `{"a": 1}` with spaces, keys ordered by length). Re-serializing parsed
 * JSON can never reproduce that, so the query returns the database's own text
 * and the timestamp formatted exactly as the trigger formats it.
 */
export const AUDIT_CHAIN_QUERY =
  "SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.\"seqNo\"::bigint), '[]'::json)::text " +
  "FROM (SELECT seq_no::text AS \"seqNo\", id::text AS \"id\", " +
  "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS \"createdAt\", " +
  "actor_id::text AS \"actorId\", action, entity_type AS \"entityType\", entity_id AS \"entityId\", " +
  "before_json AS \"beforeJson\", after_json AS \"afterJson\", " +
  "before_json::text AS \"beforeJsonText\", after_json::text AS \"afterJsonText\", " +
  "prev_hash AS \"prevHash\", row_hash AS \"rowHash\" FROM audit_records ORDER BY seq_no ASC) t;";

export const GENESIS_HASH = "0".repeat(64);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deterministic JSON with sorted object keys; mirrors core-back's audit adapter. */
export const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
};

export interface AuditChainRow {
  seqNo: string | number;
  id: string;
  createdAt: string | Date;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  /** `before_json::text` / `after_json::text` exactly as PostgreSQL renders them (what the trigger hashed). */
  beforeJsonText?: string;
  afterJsonText?: string;
  prevHash: string;
  rowHash: string;
}

export interface AuditVerification {
  valid: boolean;
  brokenLinks: number;
  verifiedCount: number;
  firstBrokenSeqNo: string | null;
  detail: string;
}

export const buildAuditCanonicalPayload = (prevHash: string, row: AuditChainRow): string =>
  [
    prevHash,
    row.id,
    (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    stableJson(row.beforeJson),
    stableJson(row.afterJson),
  ].join("|");

export const computeAuditRowHash = (prevHash: string, row: AuditChainRow): string =>
  createHash("sha256").update(buildAuditCanonicalPayload(prevHash, row), "utf8").digest("hex");

/** The trigger's canonical form: the database's own JSONB text, not a re-serialization. */
export const buildTriggerCanonicalPayload = (prevHash: string, row: AuditChainRow & { beforeJsonText: string; afterJsonText: string }): string =>
  [
    prevHash,
    row.id,
    typeof row.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.createdAt)
      ? row.createdAt
      : (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    row.beforeJsonText,
    row.afterJsonText,
  ].join("|");

/** A row is intact when EITHER canonical form reproduces its stored hash. */
export const auditRowHashMatches = (prevHash: string, row: AuditChainRow): boolean => {
  if (row.beforeJsonText !== undefined && row.afterJsonText !== undefined) {
    const triggerHash = createHash("sha256")
      .update(buildTriggerCanonicalPayload(prevHash, row as AuditChainRow & { beforeJsonText: string; afterJsonText: string }), "utf8")
      .digest("hex");
    if (row.rowHash === triggerHash) return true;
  }
  return row.rowHash === computeAuditRowHash(prevHash, row);
};

export const verifyAuditChain = (rows: AuditChainRow[]): AuditVerification => {
  let previousHash = GENESIS_HASH;
  let brokenLinks = 0;
  let firstBrokenSeqNo: string | null = null;
  let expectedSeq = 1;
  for (const row of rows) {
    const linkBroken = row.prevHash !== previousHash;
    const hashBroken = !auditRowHashMatches(previousHash, row);
    // seq_no is gap-free by construction, so a missing number means a deleted row.
    const seqNumber = Number(row.seqNo);
    const gap = Number.isFinite(seqNumber) && seqNumber !== expectedSeq;
    expectedSeq = Number.isFinite(seqNumber) ? seqNumber + 1 : expectedSeq + 1;
    if (linkBroken || hashBroken || gap) {
      brokenLinks += 1;
      if (firstBrokenSeqNo === null) firstBrokenSeqNo = String(row.seqNo);
    }
    previousHash = row.rowHash;
  }
  return {
    valid: brokenLinks === 0,
    brokenLinks,
    verifiedCount: rows.length,
    firstBrokenSeqNo,
    detail:
      brokenLinks === 0
        ? `verified ${rows.length} audit rows`
        : `${brokenLinks} broken audit link(s), first at seq_no ${firstBrokenSeqNo}`,
  };
};

export const parseAuditRows = (stdout: string): AuditChainRow[] => {
  const parsed: unknown = JSON.parse(stdout.trim() || "[]");
  if (!Array.isArray(parsed)) throw new Error("audit chain query did not return an array");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`audit row ${index} is not an object`);
    return {
      seqNo: String(entry.seqNo ?? entry.seq_no ?? index + 1),
      id: String(entry.id ?? ""),
      createdAt: String(entry.createdAt ?? entry.created_at ?? ""),
      actorId: String(entry.actorId ?? entry.actor_id ?? ""),
      action: String(entry.action ?? ""),
      entityType: String(entry.entityType ?? entry.entity_type ?? ""),
      entityId: String(entry.entityId ?? entry.entity_id ?? ""),
      beforeJson: entry.beforeJson ?? entry.before_json ?? {},
      afterJson: entry.afterJson ?? entry.after_json ?? {},
      ...(typeof entry.beforeJsonText === "string" ? { beforeJsonText: entry.beforeJsonText } : {}),
      ...(typeof entry.afterJsonText === "string" ? { afterJsonText: entry.afterJsonText } : {}),
      prevHash: String(entry.prevHash ?? entry.prev_hash ?? ""),
      rowHash: String(entry.rowHash ?? entry.row_hash ?? ""),
    };
  });
};

const hmacKey = (keyHex: string): Buffer => {
  const normalized = keyHex.trim();
  if (/^[0-9a-fA-F]+$/.test(normalized) && normalized.length % 2 === 0) {
    return Buffer.from(normalized, "hex");
  }
  return Buffer.from(normalized, "utf8");
};

const signingPayload = (report: DrillReport): Record<string, unknown> => ({
  id: report.id,
  status: report.status,
  startedAt: report.startedAt,
  completedAt: report.completedAt,
  durationMs: report.durationMs,
  targetTime: report.targetTime,
  replayedLsn: report.replayedLsn,
  doubleEntryDrift: report.doubleEntryDrift,
  balanceMismatches: report.balanceMismatches,
  auditBrokenLinks: report.auditBrokenLinks,
  journalLineCount: report.journalLineCount,
  checks: report.checks,
  errorMessage: report.errorMessage ?? null,
});

export const signDrillReport = (report: DrillReport, keyHex: string): string =>
  createHmac("sha256", hmacKey(keyHex)).update(stableJson(signingPayload(report)), "utf8").digest("hex");

export const verifyDrillReportSignature = (report: DrillReport, keyHex: string): boolean => {
  if (!report.reportSignature) return false;
  const expected = signDrillReport(report, keyHex);
  const actualBuffer = Buffer.from(report.reportSignature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

export const nodeDrillFileSystem: DrillFileSystem = {
  rm: (path, options) => nodeFs.rm(path, options),
  mkdir: async (path, options) => {
    await nodeFs.mkdir(path, options);
  },
  writeFile: (path, data) => nodeFs.writeFile(path, data, "utf8"),
  readFile: (path) => nodeFs.readFile(path, "utf8"),
  exists: async (path) => {
    try {
      await nodeFs.access(path);
      return true;
    } catch {
      return false;
    }
  },
};

const numericZero = (value: string): boolean => {
  const normalized = value.trim().replace(/,/g, "");
  if (!normalized) return false;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed === 0;
};

const numericInteger = (value: string): number => {
  const parsed = Number(value.trim().replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
};

const safeError = (error: unknown, config: BackupDaemonConfig): string => {
  const text = error instanceof Error ? error.message : String(error);
  return redactText(text, collectSecretValues(config));
};

const defaultChecks = (): DrillReport["checks"] => ({
  doubleEntry: { ok: false, detail: "not executed" },
  balanceParity: { ok: false, detail: "not executed" },
  auditChain: { ok: false, detail: "not executed" },
});

/**
 * Settings forced onto EVERY scratch cluster. The restored `postgresql.auto.conf`
 * still carries the production `archive_command`; without this a promoted
 * scratch cluster would push its own WAL into the real archive and corrupt
 * point-in-time recovery for production.
 */
export const SCRATCH_SAFETY_CONF =
  "archive_mode = off\n" +
  "archive_command = ''\n" +
  "primary_conninfo = ''\n" +
  "primary_slot_name = ''\n" +
  "synchronous_standby_names = ''\n" +
  "summarize_wal = off\n" +
  "ssl = off\n" +
  "hot_standby = on\n";

/** pg_controldata labels -> postgresql.conf names. Hot standby refuses to start below the primary's values. */
const CONTROL_DATA_SETTINGS: Array<[string, string]> = [
  ["max_connections setting", "max_connections"],
  ["max_worker_processes setting", "max_worker_processes"],
  ["max_wal_senders setting", "max_wal_senders"],
  ["max_prepared_xacts setting", "max_prepared_transactions"],
  ["max_locks_per_xact setting", "max_locks_per_transaction"],
];

export const parseControlData = (stdout: string): string => {
  const lines: string[] = [];
  for (const [label, name] of CONTROL_DATA_SETTINGS) {
    const match = new RegExp(`^${label}:\\s*(\\d+)\\s*$`, "m").exec(stdout);
    if (match?.[1]) lines.push(`${name} = ${match[1]}`);
  }
  if (/^track_commit_timestamp setting:\s*on\s*$/m.test(stdout)) lines.push("track_commit_timestamp = on");
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
};

export class RestoreDrillRunner {
  private readonly fileSystem: DrillFileSystem;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RestoreDrillDependencies) {
    this.fileSystem = deps.fileSystem ?? nodeDrillFileSystem;
    this.clock = deps.clock ?? (() => new Date());
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async run(options: DrillRunOptions = {}): Promise<DrillReport> {
    const config = this.deps.config;
    const startedAtDate = this.clock();
    const startedAt = startedAtDate.toISOString();
    const latest = options.latest === true;
    // For "latest" there is no target; the report carries the moment the drill started.
    const targetTime = latest ? startedAtDate : (options.targetTime ?? new Date(startedAtDate.getTime() - 5 * 60 * 1000));
    const id = options.id ?? this.idFactory();
    const checks = defaultChecks();
    let replayedLsn = "";
    let doubleEntryDrift = "";
    let balanceMismatches = 0;
    let auditBrokenLinks = 0;
    let journalLineCount = 0;
    let errorMessage: string | undefined;

    // A shared audit database lives inside the core cluster, so one scratch cluster serves every check.
    const dedicatedAudit = isAuditDedicatedCluster(config);
    const coreScratch = config.BACKUP_SCRATCH_DIR;
    const auditScratch = config.BACKUP_SCRATCH_AUDIT_DIR;
    const corePort = config.BACKUP_SCRATCH_PORT;
    const auditPort = config.BACKUP_SCRATCH_AUDIT_PORT;
    const scratchDirectories = dedicatedAudit ? [coreScratch, auditScratch] : [coreScratch];
    const pgCtl = join(config.PG_BIN_DIR, "pg_ctl");

    const stopScratch = async (scratch: string): Promise<void> => {
      try {
        await this.deps.runner.run(pgCtl, ["-D", scratch, "-m", "fast", "-w", "stop"], {
          timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS,
        });
      } catch {
        // A previous scratch instance may not exist.
      }
    };

    const psql = async (
      query: string,
      database: string,
      target: "postgres_core" | "audit_db",
    ): Promise<CommandResult> => {
      const command = buildPsqlCommand(
        config,
        query,
        database,
        {
          id: "scratch",
          host: "127.0.0.1",
          port: target === "audit_db" && dedicatedAudit ? auditPort : corePort,
        },
        // Audit data is only granted to the audit role (and a dedicated audit cluster does not even have the core
        // application role): always read it as PG_AUDIT_USER (which falls back to the primary role when unset).
        target === "audit_db" ? auditEndpoint(config).user : config.PG_PRIMARY_USER,
      );
      try {
        return await this.deps.runner.run(command.command, command.args, {
          env: { ...(command.env ?? {}), PGSSLMODE: "disable" },
          timeoutMs: command.timeoutMs,
        });
      } catch (error) {
        return { code: 124, stdout: "", stderr: safeError(error, config) };
      }
    };

    const logTail = async (scratch: string): Promise<string> => {
      try {
        const text = await this.fileSystem.readFile(join(scratch, "postgresql.log"));
        return redactText(text.trim().split(/\r?\n/).slice(-6).join(" | "), collectSecretValues(config)).slice(-600);
      } catch {
        return "";
      }
    };

    const ensureCluster = async (
      scratch: string,
      recovered: RecoverResult,
      label: string,
    ): Promise<void> => {
      if (await this.fileSystem.exists(join(scratch, "PG_VERSION"))) return;
      const initializedEmptyDir =
        recovered.initializedEmptyDir === true ||
        recovered.emptyDirInitialized === true ||
        recovered.initializedEmptyDataDir === true;
      if (!initializedEmptyDir) {
        throw new Error(
          `${label} restore did not produce a PostgreSQL data directory (PG_VERSION missing); ` +
            "refusing to initdb over a failed restore",
        );
      }
      const initdb = await this.deps.runner.run(
        join(config.PG_BIN_DIR, "initdb"),
        [
          "-D",
          scratch,
          "-U",
          config.PG_PRIMARY_USER,
          "--auth=trust",
          "--no-locale",
          "-E",
          "UTF8",
        ],
        { timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS },
      );
      if (initdb.code !== 0) {
        throw new Error(`${label} initdb failed: ${(initdb.stderr || initdb.stdout).trim().slice(0, 500)}`);
      }
    };

    /**
     * A physical backup holds PGDATA only. Debian-style clusters keep
     * postgresql.conf / pg_hba.conf in /etc, so the restored directory may have
     * no configuration at all. Build a minimal one, sized from pg_controldata so
     * hot standby can start.
     */
    const ensureScratchConfig = async (scratch: string): Promise<void> => {
      if (!(await this.fileSystem.exists(join(scratch, "postgresql.conf")))) {
        const control = await this.deps.runner
          .run(join(config.PG_BIN_DIR, "pg_controldata"), [scratch], { timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS })
          .catch(() => ({ code: 1, stdout: "", stderr: "" }));
        const sized = control.code === 0 ? parseControlData(control.stdout) : "";
        await this.fileSystem.writeFile(
          join(scratch, "postgresql.conf"),
          `# generated by pg-backup-daemon for a scratch restore\n${sized}fsync = off\nfull_page_writes = off\n`,
        );
      }
      if (!(await this.fileSystem.exists(join(scratch, "pg_hba.conf")))) {
        await this.fileSystem.writeFile(
          join(scratch, "pg_hba.conf"),
          "local all all trust\nhost all all 127.0.0.1/32 trust\n",
        );
      }
      if (!(await this.fileSystem.exists(join(scratch, "pg_ident.conf")))) {
        await this.fileSystem.writeFile(join(scratch, "pg_ident.conf"), "");
      }
    };

    const writeRecoveryFiles = async (
      scratch: string,
      recovered: RecoverResult,
    ): Promise<void> => {
      await ensureScratchConfig(scratch);
      const autoConfPath = join(scratch, "postgresql.auto.conf");
      const existing = await this.fileSystem.readFile(autoConfPath).catch(() => "");
      const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n" : "";
      await this.fileSystem.writeFile(
        autoConfPath,
        `${existing}${separator}${recovered.recoveryConf ?? ""}${SCRATCH_SAFETY_CONF}`,
      );
      if (recovered.recoveryConf) {
        const recoverySignal = join(scratch, "recovery.signal");
        if (!(await this.fileSystem.exists(recoverySignal))) {
          await this.fileSystem.writeFile(recoverySignal, "");
        }
      }
    };

    const startCluster = async (scratch: string, port: number, label: string): Promise<void> => {
      const start = await this.deps.runner.run(
        pgCtl,
        [
          "-D",
          scratch,
          "-l",
          join(scratch, "postgresql.log"),
          "-o",
          `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=${scratch}`,
          "-w",
          "start",
        ],
        { timeoutMs: config.BACKUP_COMMAND_TIMEOUT_MS },
      );
      if (start.code !== 0) {
        const tail = await logTail(scratch);
        throw new Error(
          `${label} pg_ctl start failed: ${(start.stderr || start.stdout).trim().slice(0, 500)}${tail ? ` [${tail}]` : ""}`,
        );
      }
    };

    /**
     * `pg_ctl -w start` returns as soon as the server accepts read-only
     * connections, which can be BEFORE WAL replay reaches the target and the
     * cluster promotes. Checks must only run on the final, promoted state.
     */
    const waitForRecoveryPromotion = async (scratch: string, target: "postgres_core" | "audit_db", label: string): Promise<void> => {
      const timeoutMs = config.BACKUP_RECOVERY_TIMEOUT_MS;
      const intervalMs = 250;
      let waited = 0;
      let failures = 0;
      while (waited <= timeoutMs) {
        const result = await psql("SELECT pg_is_in_recovery();", "postgres", target);
        if (result.code === 0 && /^f/i.test(result.stdout.trim())) return;
        failures = result.code === 0 ? 0 : failures + 1;
        if (failures >= 40) {
          const tail = await logTail(scratch);
          throw new Error(`${label} scratch cluster stopped answering during recovery${tail ? ` [${tail}]` : ""}`);
        }
        await this.sleep(intervalMs);
        waited += intervalMs;
      }
      const tail = await logTail(scratch);
      throw new Error(`${label} recovery did not finish within ${Math.round(timeoutMs / 1000)}s (target ${targetTime.toISOString()})${tail ? ` [${tail}]` : ""}`);
    };

    try {
      await Promise.all(scratchDirectories.map((scratch) => stopScratch(scratch)));
      for (const scratch of scratchDirectories) {
        await this.fileSystem.rm(scratch, { recursive: true, force: true });
        await this.fileSystem.mkdir(scratch, { recursive: true });
      }

      if (!this.deps.engine.recover) {
        throw new Error("backup engine does not implement recover()");
      }
      const coreRecovered = await this.deps.engine.recover({
        target: "postgres_core",
        targetTime,
        targetDir: coreScratch,
        port: corePort,
        ...(latest ? { latest: true } : {}),
      });
      const auditRecovered = dedicatedAudit
        ? await this.deps.engine.recover({
            target: "audit_db",
            targetTime,
            targetDir: auditScratch,
            port: auditPort,
            ...(latest ? { latest: true } : {}),
          })
        : undefined;
      replayedLsn = coreRecovered.replayedLsn ?? "";

      await ensureCluster(coreScratch, coreRecovered, "core");
      if (auditRecovered) await ensureCluster(auditScratch, auditRecovered, "audit");
      await writeRecoveryFiles(coreScratch, coreRecovered);
      if (auditRecovered) await writeRecoveryFiles(auditScratch, auditRecovered);

      await startCluster(coreScratch, corePort, "core");
      if (auditRecovered) await startCluster(auditScratch, auditPort, "audit");
      if (coreRecovered.recoveryConf) await waitForRecoveryPromotion(coreScratch, "postgres_core", "core");
      if (auditRecovered?.recoveryConf) await waitForRecoveryPromotion(auditScratch, "audit_db", "audit");

      const doubleEntry = await psql(DOUBLE_ENTRY_QUERY, config.PG_PRIMARY_DB_NAME, "postgres_core");
      doubleEntryDrift = doubleEntry.code === 0 ? doubleEntry.stdout.trim() : "";
      checks.doubleEntry = {
        ok: doubleEntry.code === 0 && numericZero(doubleEntry.stdout),
        detail:
          doubleEntry.code === 0
            ? `SUM(DEBIT) - SUM(CREDIT) = ${doubleEntry.stdout.trim() || "0"}`
            : `double-entry query failed: ${(doubleEntry.stderr || doubleEntry.stdout).trim().slice(0, 300)}`,
      };

      const countResult = await psql(JOURNAL_LINE_COUNT_QUERY, config.PG_PRIMARY_DB_NAME, "postgres_core");
      if (countResult.code === 0) {
        const parsedCount = numericInteger(countResult.stdout);
        journalLineCount = Number.isNaN(parsedCount) ? 0 : parsedCount;
      }

      const parity = await psql(BALANCE_PARITY_QUERY, config.PG_PRIMARY_DB_NAME, "postgres_core");
      const mismatchCount = parity.code === 0 ? numericInteger(parity.stdout) : Number.NaN;
      balanceMismatches = Number.isNaN(mismatchCount) ? 0 : mismatchCount;
      checks.balanceParity = {
        ok: parity.code === 0 && mismatchCount === 0,
        detail:
          parity.code === 0
            ? `${Number.isNaN(mismatchCount) ? "unparseable" : mismatchCount} sharded-balance mismatch(es)`
            : `balance parity query failed: ${(parity.stderr || parity.stdout).trim().slice(0, 300)}`,
      };

      // Shared cluster: the audit database normally came back inside the physical restore; if it did not,
      // restore the newest logical dump into the same scratch cluster.
      let auditNote = "";
      if (!dedicatedAudit) {
        const present = await psql(
          `SELECT 1 FROM pg_database WHERE datname = '${config.PG_AUDIT_DB_NAME.replace(/'/g, "''")}';`,
          "postgres",
          "postgres_core",
        );
        if (present.code === 0 && present.stdout.trim() !== "1" && this.deps.engine.restoreLogical) {
          const restored = await this.deps.engine.restoreLogical({
            database: config.PG_AUDIT_DB_NAME,
            host: "127.0.0.1",
            port: corePort,
            user: config.PG_PRIMARY_USER,
          });
          auditNote = ` (${restored.detail})`;
        }
      }

      const auditResult = await psql(AUDIT_CHAIN_QUERY, config.PG_AUDIT_DB_NAME, "audit_db");
      if (auditResult.code !== 0) {
        checks.auditChain = {
          ok: false,
          detail: `audit chain query failed: ${(auditResult.stderr || auditResult.stdout).trim().slice(0, 300)}${auditNote}`,
        };
      } else {
        try {
          const verification = verifyAuditChain(parseAuditRows(auditResult.stdout));
          auditBrokenLinks = verification.brokenLinks;
          checks.auditChain = { ok: verification.valid, detail: `${verification.detail}${auditNote}` };
        } catch (error) {
          checks.auditChain = { ok: false, detail: `audit chain parse failed: ${safeError(error, config)}` };
        }
      }

      if (!replayedLsn) {
        const lsnResult = await psql(REPLAYED_LSN_QUERY, config.PG_PRIMARY_DB_NAME, "postgres_core");
        if (lsnResult.code === 0) replayedLsn = lsnResult.stdout.trim();
      }
    } catch (error) {
      errorMessage = safeError(error, config);
    } finally {
      for (const scratch of scratchDirectories) {
        await stopScratch(scratch);
      }
      for (const scratch of scratchDirectories) {
        try {
          await this.fileSystem.rm(scratch, { recursive: true, force: true });
        } catch (error) {
          errorMessage ??= `scratch cleanup failed: ${safeError(error, config)}`;
        }
      }
    }

    const completedAtDate = this.clock();
    const checksPassed =
      checks.doubleEntry.ok && checks.balanceParity.ok && checks.auditChain.ok;
    const status: DrillReport["status"] = errorMessage === undefined && checksPassed ? "PASSED" : "FAILED";
    const report: DrillReport = {
      id,
      status,
      startedAt,
      completedAt: completedAtDate.toISOString(),
      durationMs: Math.max(0, completedAtDate.getTime() - startedAtDate.getTime()),
      targetTime: targetTime.toISOString(),
      replayedLsn,
      doubleEntryDrift,
      balanceMismatches,
      auditBrokenLinks,
      journalLineCount,
      checks,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    };
    return { ...report, reportSignature: signDrillReport(report, config.BACKUP_ENCRYPTION_KEY_HEX) };
  }
}
