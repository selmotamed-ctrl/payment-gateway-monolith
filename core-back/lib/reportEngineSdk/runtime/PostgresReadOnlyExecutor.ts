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
  /**
   * Honest label for where report queries are served (A19): "replica" only
   * when the connection string really points at a read replica; otherwise
   * "primary-readonly-tx" (a READ ONLY transaction on the primary).
   */
  servedBy?: "replica" | "primary-readonly-tx" | (string & {});
  /** Range-partitioned parent tables whose children are counted in EXPLAIN. */
  partitionedParents?: readonly string[];
  /** Tables on which a sequential scan is reported as hasSeqScanOnLargeTable. */
  largeTables?: readonly string[];
}

export const DEFAULT_LARGE_TABLES = [
  "journal_lines",
  "payment_attempts",
  "journal_entries",
  "audit_log",
  "outbox_events",
] as const;
export const DEFAULT_PARTITIONED_PARENTS = ["journal_lines"] as const;

/** `journal_lines_2026_01`, `journal_lines_default`, `journal_lines_p3` → parent `journal_lines`. */
export function partitionParentOf(relName: string, parents: readonly string[]): string | null {
  for (const parent of parents) {
    if (relName.startsWith(`${parent}_`) && /_(\d{4}_\d{2}|\d{6}|default|p\d+|\d{4}q\d)$/.test(relName)) {
      return parent;
    }
  }
  return null;
}

/** Pure EXPLAIN (FORMAT JSON) summariser; exported for unit tests. */
export function summarizeExplainPlan(
  rawPlan: unknown,
  options: { partitionedParents?: readonly string[]; largeTables?: readonly string[] } = {},
): ExplainPlanSummary {
  const parents = options.partitionedParents ?? DEFAULT_PARTITIONED_PARENTS;
  const largeTables = new Set(options.largeTables ?? DEFAULT_LARGE_TABLES);
  const explainRoot = (Array.isArray(rawPlan)
    ? ((rawPlan[0] as { Plan?: unknown } | undefined)?.Plan ?? {})
    : ((rawPlan as { Plan?: unknown } | undefined)?.Plan ?? {})) as Record<string, unknown>;
  const totalCost = Number(explainRoot["Total Cost"] ?? 0);
  const planRows = Number(explainRoot["Plan Rows"] ?? 0);
  const seqScanTables: string[] = [];
  const seqScans: NonNullable<ExplainPlanSummary["seqScans"]> = [];
  const partitions = new Set<string>();

  const walkPlan = (node: Record<string, unknown> | undefined): void => {
    if (!node) return;
    const nodeType = String(node["Node Type"] ?? "");
    const relName = String(node["Relation Name"] ?? "");
    const parent = relName ? partitionParentOf(relName, parents) : null;
    if (parent) partitions.add(relName);
    if ((nodeType === "Seq Scan" || nodeType === "Parallel Seq Scan") && relName) {
      const largeTable = largeTables.has(relName) || (parent !== null && largeTables.has(parent));
      seqScanTables.push(relName);
      seqScans.push({
        table: relName,
        parentTable: parent,
        totalCost: Number(node["Total Cost"] ?? 0),
        planRows: Number(node["Plan Rows"] ?? 0),
        largeTable,
      });
    }
    for (const key of ["Plans", "Subplans"]) {
      const plans = node[key];
      if (Array.isArray(plans)) {
        for (const child of plans) walkPlan(child as Record<string, unknown>);
      }
    }
  };
  walkPlan(explainRoot);

  const hasSeqScanOnLargeTable = seqScans.some(
    (scan) => largeTables.has(scan.table) || (scan.parentTable !== null && largeTables.has(scan.parentTable)),
  );
  return {
    totalCost,
    planRows,
    hasSeqScanOnLargeTable,
    seqScanTables,
    seqScans,
    partitionsScanned: partitions.size,
    rawPlanJson: explainRoot,
  };
}

const FORBIDDEN_SQL_TOKENS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|CALL|DO|EXECUTE|PREPARE|LOCK|VACUUM|ANALYZE|SET\s+ROLE|SET\s+SESSION|pg_sleep|pg_read_file|pg_ls_dir|lo_import|lo_export|dblink)\b/i;

export class PostgresReadOnlyReportExecutor implements ReadOnlyDatabasePort {
  private readonly pool: Pool;
  private readonly workMemMb: number;
  private readonly servedBy: string;
  private readonly planOptions: { partitionedParents?: readonly string[]; largeTables?: readonly string[] };

  constructor(options: PostgresReadOnlyExecutorOptions) {
    this.workMemMb = options.workMemMb ?? 32;
    this.servedBy = options.servedBy ?? "primary-readonly-tx";
    this.planOptions = { partitionedParents: options.partitionedParents, largeTables: options.largeTables };
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
    let releaseError: Error | undefined;
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
        servedBy: this.servedBy,
      };
    } catch (error) {
      // A connection whose ROLLBACK fails is destroyed instead of being
      // returned to the pool in an unknown transaction state.
      await client.query("ROLLBACK").catch((rollbackError: Error) => {
        releaseError = rollbackError;
      });
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  public async explainReadOnlyQuery(params: {
    sql: string;
    values: unknown[];
    timeoutMs: number;
  }): Promise<ExplainPlanSummary> {
    this.assertPureSelectSql(params.sql);
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout = '${Math.min(params.timeoutMs, 5_000)}ms'`);
      const res = await client.query(`EXPLAIN (FORMAT JSON) ${params.sql}`, params.values);
      await client.query("ROLLBACK");
      return summarizeExplainPlan(res.rows[0]?.["QUERY PLAN"], this.planOptions);
    } catch (error) {
      await client.query("ROLLBACK").catch((rollbackError: Error) => {
        releaseError = rollbackError;
      });
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
