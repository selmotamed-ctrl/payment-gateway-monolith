import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type {
  AuditEnvelope,
  AuditQueryParams,
  AuditRecordRow,
  AuditStorePort,
  HttpAccessLogRecord,
  LogSinkPort,
  StepLogRecord,
} from "./ports";
import { uuidv7 } from "./uuid";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stableJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

export interface AuditHashInput {
  id: string;
  createdAt: Date;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
}

export const computeAuditRowHash = (prevHash: string, row: AuditHashInput): string => {
  const canonical = [
    prevHash,
    row.id,
    row.createdAt.toISOString(),
    row.actorId,
    row.action,
    row.entityType,
    row.entityId,
    stableJson(row.beforeJson),
    stableJson(row.afterJson),
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
};

interface AuditDbRow {
  seq_no: string | number;
  id: string;
  created_at: Date;
  actor_id: string;
  actor_email: string | null;
  role: string;
  action: string;
  entity_type: string;
  entity_id: string;
  merchant_id: string | null;
  approval_request_id: string | null;
  request_id: string | null;
  client_ip: string | null;
  user_agent: string | null;
  before_json: unknown;
  after_json: unknown;
  prev_hash: string;
  row_hash: string;
}

const auditRowToRecord = (row: AuditDbRow): AuditRecordRow => ({
  seqNo: Number(row.seq_no),
  id: row.id,
  createdAt: new Date(row.created_at),
  actorId: row.actor_id,
  actorEmail: row.actor_email,
  role: row.role,
  action: row.action,
  entityType: row.entity_type,
  entityId: row.entity_id,
  merchantId: row.merchant_id,
  approvalRequestId: row.approval_request_id,
  requestId: row.request_id,
  clientIp: row.client_ip,
  userAgent: row.user_agent,
  beforeJson: isRecord(row.before_json) ? row.before_json : {},
  afterJson: isRecord(row.after_json) ? row.after_json : {},
  prevHash: row.prev_hash,
  rowHash: row.row_hash,
});

export class DedicatedAuditDatabaseDriver implements AuditStorePort {
  constructor(
    private readonly pool: Pool,
    private readonly tableName = "audit_records",
  ) {}

  public async appendBatch(entries: AuditEnvelope[]): Promise<AuditRecordRow[]> {
    if (entries.length === 0) {
      return [];
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `${this.tableName}:hash-chain`,
      ]);
      const last = await client.query<{ row_hash: string }>(
        `SELECT row_hash FROM ${this.tableName} ORDER BY seq_no DESC LIMIT 1`,
      );
      let prevHash = last.rows[0]?.row_hash ?? "0".repeat(64);
      const inserted: AuditRecordRow[] = [];

      for (const entry of entries) {
        const id = uuidv7();
        const createdAt = new Date();
        const rowHash = computeAuditRowHash(prevHash, {
          id,
          createdAt,
          actorId: entry.actorId,
          action: entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          beforeJson: entry.beforeJson,
          afterJson: entry.afterJson,
        });
        const result = await client.query<{ seq_no: string | number }>(
          `INSERT INTO ${this.tableName} (
             id, created_at, actor_id, actor_email, role, action,
             entity_type, entity_id, merchant_id, approval_request_id,
             request_id, client_ip, user_agent, before_json, after_json,
             prev_hash, row_hash
           ) VALUES (
             $1::uuid, $2::timestamptz, $3::uuid, $4, $5, $6,
             $7, $8, $9::uuid, $10::uuid,
             $11, $12, $13, $14::jsonb, $15::jsonb,
             $16, $17
           ) RETURNING seq_no`,
          [
            id,
            createdAt,
            entry.actorId,
            entry.actorEmail ?? null,
            entry.role,
            entry.action,
            entry.entityType,
            entry.entityId,
            entry.merchantId ?? null,
            entry.approvalRequestId ?? null,
            entry.requestId ?? null,
            entry.clientIp ?? null,
            entry.userAgent ?? null,
            JSON.stringify(entry.beforeJson),
            JSON.stringify(entry.afterJson),
            prevHash,
            rowHash,
          ],
        );
        const record: AuditRecordRow = {
          ...entry,
          id,
          createdAt,
          prevHash,
          rowHash,
          seqNo: Number(result.rows[0]?.seq_no ?? 0),
        };
        inserted.push(record);
        prevHash = rowHash;
      }

      await client.query("COMMIT");
      return inserted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private buildFilters(params: AuditQueryParams): { clauses: string[]; values: unknown[] } {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const push = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (params.entityType) {
      clauses.push(`entity_type = ${push(params.entityType)}`);
    }
    if (params.entityId) {
      clauses.push(`entity_id = ${push(params.entityId)}`);
    }
    if (params.actorId) {
      clauses.push(`actor_id = ${push(params.actorId)}::uuid`);
    }
    if (params.role) {
      clauses.push(`role = ${push(params.role)}`);
    }
    if (params.action) {
      clauses.push(`action = ${push(params.action)}`);
    }
    if (params.createdFrom) {
      clauses.push(`created_at >= ${push(params.createdFrom)}::timestamptz`);
    }
    if (params.createdTo) {
      clauses.push(`created_at <= ${push(params.createdTo)}::timestamptz`);
    }
    if (params.searchPrefix) {
      const pattern = `${params.searchPrefix.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const placeholder = push(pattern);
      clauses.push(
        `(action ILIKE ${placeholder} OR entity_type ILIKE ${placeholder} OR entity_id ILIKE ${placeholder} OR actor_email ILIKE ${placeholder})`,
      );
    }
    if (params.cursorCreatedAt && params.cursorId) {
      const createdAt = push(params.cursorCreatedAt);
      const id = push(params.cursorId);
      clauses.push(`(created_at, id) < (${createdAt}::timestamptz, ${id}::uuid)`);
    }
    return { clauses, values };
  }

  public async countAuditLogs(params: AuditQueryParams): Promise<number> {
    const { clauses, values } = this.buildFilters(params);
    const result = await this.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.tableName}${
        clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
      }`,
      values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  public async queryAuditLogs(params: AuditQueryParams): Promise<{
    items: AuditRecordRow[];
    nextCursor: string | null;
  }> {
    const { clauses, values } = this.buildFilters(params);
    const limit = Math.max(1, Math.min(params.limit, 5_000));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    values.push(limit + 1);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;
    const sql = `
      SELECT * FROM ${this.tableName}
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
    `;
    const result = await this.pool.query<AuditDbRow>(sql, values);
    const rows = result.rows.slice(0, limit).map(auditRowToRecord);
    const last = rows[rows.length - 1];
    return {
      items: rows,
      nextCursor:
        result.rows.length > limit && last
          ? `${last.createdAt.toISOString()}|${last.id}`
          : null,
    };
  }

  public async getAuditLogById(id: string): Promise<AuditRecordRow | null> {
    const result = await this.pool.query<AuditDbRow>(
      `SELECT * FROM ${this.tableName} WHERE id = $1::uuid LIMIT 1`,
      [id],
    );
    return result.rows[0] ? auditRowToRecord(result.rows[0]) : null;
  }

  public async verifyHashChainIntegrity(limit?: number): Promise<{
    verifiedCount: number;
    valid: boolean;
    firstBrokenId?: string;
  }> {
    const result = await this.pool.query<AuditDbRow>(
      `SELECT * FROM ${this.tableName} ORDER BY seq_no ASC${
        limit && limit > 0 ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : ""
      }`,
    );
    let previous = "0".repeat(64);
    for (const row of result.rows) {
      const computed = computeAuditRowHash(previous, {
        id: row.id,
        createdAt: new Date(row.created_at),
        actorId: row.actor_id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        beforeJson: row.before_json,
        afterJson: row.after_json,
      });
      if (row.prev_hash !== previous || row.row_hash !== computed) {
        return {
          verifiedCount: result.rows.indexOf(row),
          valid: false,
          firstBrokenId: row.id,
        };
      }
      previous = row.row_hash;
    }
    return { verifiedCount: result.rows.length, valid: true };
  }
}

export class DedicatedPostgresLogSink implements LogSinkPort {
  private stepLogBuffer: Required<StepLogRecord>[] = [];
  private accessLogBuffer: Required<HttpAccessLogRecord>[] = [];
  private readonly rememberedStepLogs = new Map<string, StepLogRecord[]>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private isFlushing = false;

  constructor(
    private readonly logDbPool: Pool | null,
    private readonly maxBufferSize = 5_000,
    private readonly flushIntervalMs = 250,
  ) {
    if (this.logDbPool) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, this.flushIntervalMs);
      this.flushTimer.unref?.();
    }
  }

  public writeStepLog(record: StepLogRecord): void {
    const normalized: Required<StepLogRecord> = {
      id: record.id ?? uuidv7(),
      attemptId: record.attemptId,
      gatewayVersionId: record.gatewayVersionId,
      phase: record.phase,
      stepId: record.stepId ?? null,
      stepOrder: record.stepOrder,
      redactedRequestJson: record.redactedRequestJson,
      redactedResponseText: record.redactedResponseText,
      httpStatus: record.httpStatus ?? null,
      durationMs: record.durationMs ?? null,
      outcome: record.outcome,
      createdAt: record.createdAt ?? new Date(),
    };
    if (this.stepLogBuffer.length >= this.maxBufferSize) {
      this.stepLogBuffer.shift();
    }
    this.stepLogBuffer.push(normalized);
    const remembered = this.rememberedStepLogs.get(normalized.attemptId) ?? [];
    remembered.push(normalized);
    if (remembered.length > 500) {
      remembered.shift();
    }
    this.rememberedStepLogs.set(normalized.attemptId, remembered);

    if (this.stepLogBuffer.length >= 250 && !this.isFlushing) {
      void this.flush();
    }
  }

  public writeAccessLog(record: HttpAccessLogRecord): void {
    if (this.accessLogBuffer.length >= this.maxBufferSize) {
      return;
    }
    this.accessLogBuffer.push({
      ...record,
      actorId: record.actorId ?? null,
      clientIp: record.clientIp ?? null,
      createdAt: record.createdAt ?? new Date(),
    });
  }

  public async flush(): Promise<void> {
    if (this.isFlushing) {
      return;
    }
    if (this.stepLogBuffer.length === 0 && this.accessLogBuffer.length === 0) {
      return;
    }
    if (!this.logDbPool) {
      this.stepLogBuffer.splice(0, this.stepLogBuffer.length);
      this.accessLogBuffer.splice(0, this.accessLogBuffer.length);
      return;
    }

    this.isFlushing = true;
    const stepBatch = this.stepLogBuffer.splice(0, 500);
    const accessBatch = this.accessLogBuffer.splice(0, 500);

    try {
      if (stepBatch.length > 0) {
        const values: unknown[] = [];
        const placeholders = stepBatch.map((row, index) => {
          const base = index * 12;
          values.push(
            row.id,
            row.attemptId,
            row.gatewayVersionId,
            row.phase,
            row.stepId,
            row.stepOrder,
            JSON.stringify(row.redactedRequestJson),
            row.redactedResponseText,
            row.httpStatus,
            row.durationMs,
            row.outcome,
            row.createdAt,
          );
          return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}::uuid, $${base + 6}, $${base + 7}::jsonb, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}::timestamptz)`;
        });
        await this.logDbPool.query(
          `INSERT INTO attempt_step_logs (
             id, attempt_id, gateway_version_id, phase, step_id, step_order,
             redacted_request_json, redacted_response_text, http_status,
             duration_ms, outcome, created_at
           ) VALUES ${placeholders.join(", ")}
           ON CONFLICT (id, created_at) DO NOTHING`,
          values,
        );
      }

      if (accessBatch.length > 0) {
        const values: unknown[] = [];
        const placeholders = accessBatch.map((row, index) => {
          const base = index * 11;
          values.push(
            row.requestId,
            row.channel,
            row.method,
            row.routePattern,
            row.statusCode,
            row.durationMs,
            row.dbQueries,
            row.dbDurationMs,
            row.actorId,
            row.clientIp,
            row.createdAt,
          );
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::uuid, $${base + 10}, $${base + 11}::timestamptz)`;
        });
        await this.logDbPool.query(
          `INSERT INTO http_access_logs (
             request_id, channel, method, route_pattern, status_code,
             duration_ms, db_queries, db_duration_ms, actor_id, client_ip,
             created_at
           ) VALUES ${placeholders.join(", ")}`,
          values,
        );
      }
    } catch {
      if (this.stepLogBuffer.length + stepBatch.length <= this.maxBufferSize) {
        this.stepLogBuffer.unshift(...stepBatch);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  public async queryStepLogsForAttempt(attemptId: string): Promise<StepLogRecord[]> {
    if (!this.logDbPool) {
      return this.rememberedStepLogs.get(attemptId) ?? [];
    }
    try {
      const result = await this.logDbPool.query(
        `SELECT id, attempt_id AS "attemptId", gateway_version_id AS "gatewayVersionId",
                phase, step_id AS "stepId", step_order AS "stepOrder",
                redacted_request_json AS "redactedRequestJson",
                redacted_response_text AS "redactedResponseText",
                http_status AS "httpStatus", duration_ms AS "durationMs",
                outcome, created_at AS "createdAt"
         FROM attempt_step_logs
         WHERE attempt_id = $1::uuid
         ORDER BY step_order ASC, created_at ASC`,
        [attemptId],
      );
      return result.rows as StepLogRecord[];
    } catch {
      return this.rememberedStepLogs.get(attemptId) ?? [];
    }
  }

  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
