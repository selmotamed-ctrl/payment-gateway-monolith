import { Pool } from "pg";
import type {
  ExplainPlanSummary,
  ReadOnlyDatabasePort,
  ReadOnlyQueryResult,
} from "../types/hostConfig";

export interface PostgresReadOnlyExecutorOptions {
  connectionString: string;
  maxPoolConnections?: number;
  defaultStatementTimeoutMs?: number;
  workMemMb?: number;
}

const FORBIDDEN_SQL_TOKENS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|LOCK|VACUUM|ANALYZE|SET\s+ROLE|SET\s+SESSION|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i;

export class PostgresReadOnlyReportExecutor implements ReadOnlyDatabasePort {
  private readonly pool: Pool;
  private readonly workMemMb: number;

  constructor(options: PostgresReadOnlyExecutorOptions) {
    this.workMemMb = options.workMemMb ?? 32;
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxPoolConnections ?? 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "report_engine_readonly_line",
    });
  }

  private assertPureSelectSql(sql: string): void {
    const trimmed = sql.trim();
    if (!/^SELECT\b/i.test(trimmed)) {
      throw new Error(
        "REPORT_READONLY_VIOLATION: Only SELECT statements may execute on the Report Engine DB line.",
      );
    }
    if (trimmed.includes(";")) {
      throw new Error("REPORT_READONLY_VIOLATION: Multi-statement SQL strings are prohibited.");
    }
    if (FORBIDDEN_SQL_TOKENS.test(trimmed)) {
      throw new Error(
        "REPORT_READONLY_VIOLATION: SQL contains forbidden mutation or system-function tokens.",
      );
    }
  }

  public async executeReadOnlyQuery<T = Record<string, unknown>>(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
    maxRows: number;
    queryLabel: string;
  }): Promise<ReadOnlyQueryResult<T>> {
    this.assertPureSelectSql(params.sql);
    const boundedTimeoutMs = Math.min(Math.max(params.timeoutMs, 500), 30_000);
    const boundedMaxRows = Math.min(Math.max(params.maxRows, 1), 10_000);
    const wrappedSql = `SELECT * FROM (${params.sql}) AS _report_q LIMIT ${boundedMaxRows}`;

    const startedAt = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${boundedTimeoutMs}ms'`);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
      await client.query(`SET LOCAL work_mem = '${this.workMemMb}MB'`);
      await client.query("SET LOCAL timezone = 'UTC'");

      const res = await client.query(wrappedSql, params.values);
      await client.query("COMMIT");

      return {
        rows: res.rows as T[],
        rowCount: res.rowCount ?? res.rows.length,
        durationMs: Math.round(performance.now() - startedAt),
        servedBy: "readonly-pool",
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async explainReadOnlyQuery(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
  }): Promise<ExplainPlanSummary> {
    this.assertPureSelectSql(params.sql);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${Math.min(params.timeoutMs, 5_000)}ms'`);
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${params.sql}`, params.values);
      await client.query("ROLLBACK");

      const rawPlan = res.rows[0]?.["QUERY PLAN"];
      const explainRoot = Array.isArray(rawPlan)
        ? (rawPlan[0]?.Plan ?? {})
        : ((rawPlan as Record<string, unknown> | undefined)?.Plan ?? {});
      const totalCost = Number(explainRoot["Total Cost"] ?? 0);
      const planRows = Number(explainRoot["Plan Rows"] ?? 0);
      const seqScanTables: string[] = [];
      let partitionsScanned = 0;

      const walkPlan = (node: Record<string, unknown> | undefined): void => {
        if (!node) return;
        const nodeType = String(node["Node Type"] ?? "");
        const relName = String(node["Relation Name"] ?? "");
        if (nodeType === "Seq Scan" && relName) {
          seqScanTables.push(relName);
        }
        if (relName.startsWith("journal_lines_p")) {
          partitionsScanned += 1;
        }
        const plans = node["Plans"];
        if (Array.isArray(plans)) {
          for (const child of plans) {
            walkPlan(child as Record<string, unknown>);
          }
        }
      };
      walkPlan(explainRoot);

      const largeTables = new Set([
        "journal_lines",
        "payment_attempts",
        "journal_entries",
        "audit_log",
        "outbox_events",
      ]);
      const hasSeqScanOnLargeTable = seqScanTables.some(
        (tbl) => largeTables.has(tbl) || tbl.startsWith("journal_lines_p"),
      );

      return {
        totalCost,
        planRows,
        hasSeqScanOnLargeTable,
        seqScanTables,
        partitionsScanned,
        rawPlanJson: explainRoot,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
